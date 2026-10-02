/**
 * 多格式导入导出专项（真产物里跑）
 * ==================================
 * 用户原话：「加一个导入的格式 html 不止 markdown 可以扩展多一点 导入也是」。
 *
 * 这一套要证明的不是「代码里有这个函数」，而是**端到端真的能用**：
 *   1. 每一种外部格式的文件都能导入，导进来之后树**对不对**
 *      （层级、文字、折角、mermaid 一个都不能歪）；
 *   2. 每一种导出格式的文件，都能**再导入回来**，且和导出前是同一棵树
 *      （这条最关键：只验「点了有文件落下来」，等于没验它是不是一份能用的文件）；
 *   3. 坏文件给的是人话提示而不是崩 / 静默无事发生；
 *   4. 导出面板在桌面和手机两端都点得到、装得下（包括横屏矮视口）。
 *
 * 【为什么导出走「拦 URL.createObjectURL」而不是真的下载到磁盘】
 * 拦 Blob 就等于拿到了**将要落盘的那份字节**，而且能当场喂回导入 —— 往返验证
 * 一次跑完；真下载到磁盘再读回来只是多一步 I/O，验的东西完全一样。
 * （离线 HTML 那条也一样：读回来的字节直接交给解析器。）
 *
 * 用法：node scripts/browser/formats.mjs [url]
 *   默认 http://127.0.0.1:5173/；测构建产物：
 *   npx vite build && node scripts/serve-dist.mjs dist 9382  → 再本脚本传 URL
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import MiniWS from './_ws.mjs'

const URL_APP = process.argv[2] || 'http://127.0.0.1:5173/'
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

if (!EDGE) {
  console.error('找不到 Edge / Chrome')
  process.exit(2)
}

// 本项目浏览器套件占 9333~9381，这里往后取一段不冲突的
const PORT = 9382
const userDir = mkdtempSync(join(tmpdir(), 'mf-formats-'))
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
const LANDSCAPE = { width: 667, height: 375, deviceScaleFactor: 2, mobile: true }

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (msg) => console.log(`  · ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ==================================================================== */
/* 夹具                                                                  */
/* ==================================================================== */

/** 种子文档：三章、两种折角、汇聚连线、粗体斜体都在 —— 每种导出都拿它当原点 */
const seedRoot = {
  id: 'n_root', text: '往返测试', collapsed: false, bold: false, italic: false, fold: null,
  children: [
    {
      id: 'n_a', text: '第一章', collapsed: false, bold: true, italic: false, fold: null,
      children: [
        {
          id: 'n_a1', text: '要点一', collapsed: false, bold: false, italic: false,
          fold: { corner: true, openCount: 5, mermaid: 'flowchart TD\n  P["起点"] --> Q["终点"]', outline: '', updatedAt: 1700000000000 },
          children: [{ id: 'n_a1x', text: '细节甲', collapsed: false, bold: false, italic: false, fold: null, children: [] }],
        },
        { id: 'n_a2', text: '要点二', collapsed: false, bold: false, italic: true, fold: null, children: [] },
      ],
    },
    {
      id: 'n_b', text: '第二章 & 特殊<字符>', collapsed: false, bold: false, italic: false, fold: null,
      children: [{ id: 'n_b1', text: '子项', collapsed: false, bold: false, italic: false, fold: null, children: [] }],
    },
    { id: 'n_c', text: '终点', collapsed: false, bold: false, italic: false, fold: null, children: [] },
  ],
}
const seedDoc = {
  id: 'doc_seed', name: '往返测试', path: '往返测试', root: seedRoot,
  relations: [{ from: 'n_a1', to: 'n_c' }],
  view: { x: 80, y: 60, zoom: 1 }, updatedAt: 1700000000000,
}

/**
 * 外部格式的样本 —— 都按**别的软件真正导出的样子**写，不是我们自己的导出：
 *   · 幕布 / XMind 那类 OPML：属性顺序不同、顶层多个 outline、还有 _note 备注；
 *   · Freeplane 的 .mm：TEXT 大写、有 icon、有 richcontent；
 *   · Word「另存为网页」那类 HTML：h1/h2 + ul/li 嵌套 + 一段 p。
 */
const FIXTURES = {
  'note.md': '# 网络笔记\n\n- 传输层 [F]\n  - TCP\n  - UDP\n\n  ```mermaid\n  flowchart TD\n    A --> B\n  ```\n\n- 应用层\n',
  'outline.txt': '复习计划\n  第一章 绪论\n    1.1 概念\n  第二章 方法\n    2.1 步骤 [F]\n第三章 结论\n',
  'mubu.opml': `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>幕布大纲</title></head>
  <body>
    <outline text="计算机基础">
      <outline text="操作系统" _note="重点章节"/>
      <outline text="网络" mf-fold="1" _note="flowchart TD&#10;  S --> T"/>
    </outline>
  </body>
</opml>
`,
  'freeplane.mm': `<map version="1.0.1">
  <node TEXT="我的脑图">
    <node TEXT="分支一" POSITION="right">
      <node TEXT="叶子 A"/>
      <node TEXT="叶子 B"/>
    </node>
    <node TEXT="带图的分支" POSITION="right">
      <richcontent TYPE="NOTE"><html><head></head><body><p>graph LR</p><p>A --&gt; B</p></body></html></richcontent>
    </node>
  </node>
</map>
`,
  'word.html': `<!doctype html><html><head><title>课程大纲</title></head><body>
<h1>第一章 导论</h1>
<ul><li>第一节 概念<ul><li>定义</li><li>性质</li></ul></li><li>第二节 方法</li></ul>
<h2>第二章 深入</h2>
<p>本章要点：A &amp; B</p>
</body></html>
`,
  'junk.bin': '这既不是 JSON 也不是任何已知格式，只是一句中文。',
  'empty.txt': '   \n\n  ',
  'print.html': '<!doctype html><html><body><div class="mf-print-pages"><section class="page" data-page="1"></section></div></body></html>',
}

/* ==================================================================== */
/* 页面侧工具（注入一次）                                                 */
/* ==================================================================== */

/** 抓「将要落盘的那份字节」：拦 createObjectURL 拿 Blob，拦 a.click() 拿文件名 */
const CAP = `(() => {
  if (window.__mfCap) return true
  const cap = {
    blob: null, name: null, type: null, _inst: false, _errs: [],
    install() {
      if (this._inst) return true
      this._inst = true
      const orig = URL.createObjectURL
      URL.createObjectURL = (b) => { this.blob = b; this.type = b.type; return orig.call(URL, b) }
      const origClick = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) { window.__mfCap.name = this.download; return }
        return origClick.apply(this, arguments)
      }
      return true
    },
    reset() { this.blob = null; this.name = null; this.type = null; return true },
    async read() { return this.blob ? await this.blob.text() : null },
  }
  window.__mfCap = cap
  return cap.install()
})()`

/**
 * 在页面里构造 File 并塞进隐藏的 import input，触发真实 onChange。
 * 【为什么要绕这一圈而不是直接调 doImportFile】界面上的入口就是那个 input
 * （onChange → doImportFile），这样测的是**用户点导入之后真的走完整条路**。
 * File 用页面里的构造函数造：FileReader 读它、我们的解析器读它，
 * 除了「没真落盘」以外和用户选文件没差别。
 */
const IMPORT_FN = `(() => {
  if (window.__mfImportFixture) return true
  window.__mfImportFixture = (name, text) => {
    const inp = document.querySelector('#mf-import-file')
    if (!inp) return 'no-input'
    const dt = new DataTransfer()
    dt.items.add(new File([text], name, { type: 'text/plain' }))
    inp.files = dt.files
    inp.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  }
  return true
})()`

/** 把当前活动文档投影成可比较的形状：节点（层级/文字/折角/图/样式）+ 连线 */
const PROJ = `(() => {
  const active = JSON.parse(localStorage.getItem('mf:active') || 'null')
  const raw = localStorage.getItem('mf:doc:' + active)
  if (!raw) return { error: '没有活动文档' }
  const d = JSON.parse(raw)
  const nodes = []
  const walk = (n, depth, parent) => {
    if (parent) nodes.push({
      depth,
      text: n.text,
      fold: !!n.fold,
      mermaid: (n.fold && n.fold.mermaid) || '',
      openCount: (n.fold && n.fold.openCount) || 0,
      bold: !!n.bold,
      italic: !!n.italic,
    })
    for (const c of n.children || []) walk(c, depth + 1, n)
  }
  walk(d.root, 0, null)
  return { name: d.name, nodes, relations: (d.relations || []).length }
})()`

/** 顶层文档名列表（用来确认导入真的建出了新文档） */
const TABS = `(() => {
  const ids = JSON.parse(localStorage.getItem('mf:tabs') || '[]')
  return ids.map((id) => {
    try { return JSON.parse(localStorage.getItem('mf:doc:' + id) || '{}').name || '?' } catch (e) { return '?' }
  })
})()`

const TOAST = `(() => { const t = document.querySelector('[data-app-toast]'); return t ? t.textContent.trim() : null })()`

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const coreOf = (nodes) => nodes.map((n) => [n.depth, n.text, n.fold, norm(n.mermaid)])
const fullOf = (nodes) => nodes.map((n) => [n.depth, n.text, n.fold, norm(n.mermaid), n.openCount, n.bold, n.italic])
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ==================================================================== */
/* CDP 胶水（和其他套件一致）                                             */
/* ==================================================================== */

async function connect(url) {
  const ws = new MiniWS(url)
  let id = 0
  const pending = new Map()
  const handlers = new Map()
  ws.onmessage = (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method && handlers.has(msg.method)) handlers.get(msg.method)(msg.params)
  }
  await ws.opened
  return {
    send(method, params = {}) {
      const mid = ++id
      ws.send(JSON.stringify({ id: mid, method, params }))
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }))
    },
    on(ev, fn) { handlers.set(ev, fn) },
    close() { ws.close() },
  }
}

async function main() {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) { target = page; break }
    } catch { /* 还没起来 */ }
  }
  if (!target) throw new Error('无法连接 Edge DevTools')

  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const consoleErrors = []
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push((p.args || []).map((a) => a.value ?? a.description).join(' '))
  })
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown')
  })

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }
  const waitFor = async (expr, label, tries = 48) => {
    for (let i = 0; i < tries; i++) {
      if (await evaluate(`!!(${expr})`)) return true
      await sleep(250)
    }
    note(`等待超时：${label}`)
    return false
  }
  const setViewport = (v) => cdp.send('Emulation.setDeviceMetricsOverride', {
    width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor, mobile: v.mobile,
  })
  const goto = async () => {
    await cdp.send('Page.navigate', { url: URL_APP })
    await sleep(1200)
  }
  const rectOf = async (sel) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             right: Math.round(r.right), bottom: Math.round(r.bottom) }
  })()`)
  const clickSel = (sel) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    el.click()
    return true
  })()`)
  const importFixture = async (name, text) => {
    await evaluate(`window.__mfFixtureName = ${JSON.stringify(name)}; window.__mfFixtureText = ${JSON.stringify(text)}; true`)
    return evaluate(`window.__mfImportFixture(window.__mfFixtureName, window.__mfFixtureText)`)
  }
  /** 导出某个格式并把它将要落盘的字节读回来 */
  const exportAndRead = async (key) => {
    await evaluate('window.__mfCap.reset()')
    await clickSel(`[data-export-format="${key}"]`)
    const ok = await waitFor('window.__mfCap.blob', `导出 ${key} 的内容`, 60)
    if (!ok) return { error: '没捕获到导出内容' }
    const out = await evaluate(`(async () => ({ text: await window.__mfCap.read(), name: window.__mfCap.name, type: window.__mfCap.type }))()`)
    return out
  }

  try {
    /* ================================================================ */
    console.log('\n[0] 准备：写入种子文档并重新加载')

    await setViewport(DESKTOP)
    await goto()
    await waitFor(`document.querySelector('[data-tool="export-pdf"]')`, '应用挂载')
    const seeded = await evaluate(`(() => {
      localStorage.clear()
      localStorage.setItem('mf:tabs', JSON.stringify(['doc_seed']))
      localStorage.setItem('mf:active', JSON.stringify('doc_seed'))
      localStorage.setItem('mf:doc:doc_seed', ${JSON.stringify(JSON.stringify(seedDoc))})
      localStorage.setItem('mf:hist:doc_seed', JSON.stringify([]))
      localStorage.setItem('mf:theme', JSON.stringify('white'))
      return true
    })()`)
    check('种子文档写进 localStorage', seeded === true)
    await goto()
    const ready = await waitFor(`document.querySelectorAll('[data-node-id]').length >= 6`, '画布渲染出种子树')
    check('重新加载后画布上是种子文档', ready)
    await evaluate(CAP)
    await evaluate(IMPORT_FN)

    const base = await evaluate(PROJ)
    check('种子文档投影可用（7 个节点 + 1 条连线）',
      base.nodes && base.nodes.length === 7 && base.relations === 1, JSON.stringify(base).slice(0, 200))
    const baseCore = coreOf(base.nodes)
    const baseFull = fullOf(base.nodes)

    /* ================================================================ */
    console.log('\n[1] 导入：六种外部格式')

    const cases = [
      ['note.md', FIXTURES['note.md'], { name: 'note', nodes: 5, folds: 1, hasMermaid: true, mustHave: ['网络笔记', '传输层', 'TCP', 'UDP', '应用层'] }],
      ['outline.txt', FIXTURES['outline.txt'], { name: 'outline', nodes: 6, folds: 1, mustHave: ['复习计划', '1.1 概念', '2.1 步骤'] }],
      ['mubu.opml', FIXTURES['mubu.opml'], { name: '计算机基础', nodes: 2, folds: 1, hasMermaid: true, mustHave: ['操作系统', '网络'] }],
      ['freeplane.mm', FIXTURES['freeplane.mm'], { name: '我的脑图', nodes: 4, folds: 1, hasMermaid: true, mustHave: ['分支一', '叶子 A', '带图的分支'] }],
      ['word.html', FIXTURES['word.html'], { name: '课程大纲', nodes: 7, mustHave: ['第一章 导论', '第一节 概念', '定义', '第二章 深入', '本章要点：A & B'] }],
    ]

    for (const [file, text, want] of cases) {
      const r = await importFixture(file, text)
      check(`导入 ${file}：触发了文件输入`, r === 'ok', String(r))
      await sleep(900)
      const proj = await evaluate(PROJ)
      if (proj.error) { check(`导入 ${file}：建出了文档`, false, proj.error); continue }
      const texts = proj.nodes.map((n) => n.text)
      check(`★ 导入 ${file}：文档名 = 「${want.name}」`, proj.name === want.name, String(proj.name))
      check(`★ 导入 ${file}：节点数 = ${want.nodes}`, proj.nodes.length === want.nodes,
        `${proj.nodes.length} → ${JSON.stringify(texts)}`)
      check(`导入 ${file}：关键文字都在`, (want.mustHave || []).every((t) => texts.includes(t)),
        JSON.stringify(texts))
      if (want.folds) {
        check(`导入 ${file}：折角 ${want.folds} 个`,
          proj.nodes.filter((n) => n.fold).length === want.folds,
          JSON.stringify(proj.nodes.map((n) => [n.text, n.fold, n.mermaid.slice(0, 12)])))
      }
      if (want.hasMermaid) {
        check(`导入 ${file}：折角里的 mermaid 源码读回来了`,
          proj.nodes.some((n) => /-->/.test(n.mermaid)), JSON.stringify(proj.nodes.map((n) => n.mermaid)))
      }
      const toast = await evaluate(TOAST)
      note(`提示条：${toast}`)
      check(`导入 ${file}：提示条说明了「按什么格式导入」`, /导入/.test(toast || ''), String(toast))
    }

    /* ---- 缩进大纲的层级要真的对（不是「都平铺成一层」也算导入成功） ---- */
    const outlineProj = await (async () => {
      await importFixture('outline.txt', FIXTURES['outline.txt'])
      await sleep(900)
      return evaluate(PROJ)
    })()
    check('★ 缩进大纲：按缩进还原层级（没缩进的「第三章」是顶层，缩进的「1.1」是两级）',
      same(outlineProj.nodes.map((n) => [n.depth, n.text]),
        [[1, '复习计划'], [2, '第一章 绪论'], [3, '1.1 概念'], [2, '第二章 方法'], [3, '2.1 步骤'], [1, '第三章 结论']]),
      JSON.stringify(outlineProj.nodes.map((n) => [n.depth, n.text])))

    const opmlProj = await (async () => {
      await importFixture('mubu.opml', FIXTURES['mubu.opml'])
      await sleep(900)
      return evaluate(PROJ)
    })()
    check('★ OPML：普通 _note（「重点章节」）没有变成折角',
      (opmlProj.nodes.find((n) => n.text === '操作系统') || {}).fold === false,
      JSON.stringify(opmlProj.nodes))
    check('★ OPML：带 mermaid 备注的节点是折角且源码正确',
      (opmlProj.nodes.find((n) => n.text === '网络') || {}).mermaid.includes('S --> T'),
      JSON.stringify(opmlProj.nodes.find((n) => n.text === '网络')))

    /* ---- 坏文件：人话提示，不是静默失败 ---- */
    console.log('\n[2] 坏文件与不支持的文件')
    for (const [file, text, want] of [
      ['junk.bin', FIXTURES['junk.bin'], /认不出|没有节点|格式/],
      ['empty.txt', FIXTURES['empty.txt'], /认不出|没有节点|格式/],
      ['print.html', FIXTURES['print.html'], /打印预览页/],
    ]) {
      const beforeTabs = (await evaluate(TABS)).length
      await importFixture(file, text)
      await sleep(700)
      const toast = await evaluate(TOAST)
      const afterTabs = (await evaluate(TABS)).length
      check(`★ ${file}：给出人话提示而不是没反应`, want.test(toast || ''), String(toast))
      check(`${file}：不会建出一个空文档`, afterTabs === beforeTabs, `${beforeTabs} → ${afterTabs}`)
    }

    /* ================================================================ */
    console.log('\n[3] 导出 → 再导入：每种格式都要往返')

    /*
     * 每次往返都从**同一个种子文档**出发。
     * 不复用「上一次导入出来的文档」：那样一轮一轮滚下去，测的其实是
     * 「导入产物还能不能导出」，而用户关心的是「我这份文档导出再导入还在不在」。
     */
    const activateSeed = async () => {
      await evaluate(`(() => {
        const tabs = JSON.parse(localStorage.getItem('mf:tabs') || '[]')
        if (!tabs.includes('doc_seed')) tabs.unshift('doc_seed')
        localStorage.setItem('mf:tabs', JSON.stringify(tabs))
        localStorage.setItem('mf:active', JSON.stringify('doc_seed'))
        return true
      })()`)
      await goto()
      await waitFor(`document.querySelectorAll('[data-node-id]').length >= 6`, '种子文档重新加载')
      await evaluate(CAP)
      await evaluate(IMPORT_FN)
    }

    await activateSeed()

    const openExportPanel = async () => {
      await clickSel('[data-export-open="desktop"]')
      await sleep(400)
      return (await rectOf('[data-export-sheet]')) != null
    }

    check('桌面端右下角有「导出…」入口', (await rectOf('[data-export-open="desktop"]')) != null)
    check('★ 点「导出…」打开格式面板', await openExportPanel())
    const rows = await evaluate(`[...document.querySelectorAll('[data-export-format]')].map((b) => [b.dataset.exportFormat, b.getBoundingClientRect().height])`)
    check('★ 面板里六个格式都在，且都点得到（≥44px）',
      rows.length === 6 && rows.every((r) => r[1] >= 44), JSON.stringify(rows))
    note(`格式行：${JSON.stringify(rows)}`)

    /*
     * 逐个格式：导出 → 读回字节 → 当作文件再导入 → 和导出前的树比对。
     *
     * 【md / opml / mm 只比「核心投影」】
     * 这三种格式的规范里没有「复习次数」「粗斜体」「汇聚连线」的位置，硬塞进
     * 自定义字段会让文件变成只有 MindFold 认识的东西 —— 这是有意的取舍。
     * 核心投影 = 层级 + 文字 + 折角 + 流程图源码，一样不能少。
     * 【json / 离线 HTML 比「完整投影」】
     * 它们是自家的无损出口，连 openCount 和 relations 都必须一模一样。
     */
    const roundTrips = [
      { key: 'md', exts: /\.md$/, full: false },
      { key: 'opml', exts: /\.opml$/, full: false },
      { key: 'mm', exts: /\.mm$/, full: false },
      { key: 'json', exts: /\.json$/, full: true },
      { key: 'html', exts: /\.html$/, full: true },
    ]

    for (const rt of roundTrips) {
      await activateSeed()
      if (!(await rectOf('[data-export-sheet]'))) await openExportPanel()
      const out = await exportAndRead(rt.key)
      if (out.error) { check(`导出 ${rt.key}`, false, out.error); continue }
      check(`★ 导出 ${rt.key}：落下来的是同名文件（${out.name}）`, rt.exts.test(out.name || ''), String(out.name))
      check(`导出 ${rt.key}：内容非空`, (out.text || '').length > 20, String((out.text || '').length))
      note(`${rt.key}：${out.name} · ${(out.text || '').length} 字节 · ${out.type}`)

      const before = await evaluate(PROJ)
      const r = await importFixture(out.name, out.text)
      check(`导出 ${rt.key} → 再导入：触发了文件输入`, r === 'ok', String(r))
      await sleep(1100)
      const after = await evaluate(PROJ)

      if (rt.full) {
        check(`★★ ${rt.key} 往返：结构与样式**完全一致**（含折角次数）`,
          same(fullOf(after.nodes), fullOf(before.nodes)),
          `before=${JSON.stringify(fullOf(before.nodes))}\nafter=${JSON.stringify(fullOf(after.nodes))}`)
        check(`★★ ${rt.key} 往返：汇聚连线也带回来了`,
          after.relations === before.relations && after.relations === 1,
          `${before.relations} → ${after.relations}`)
      } else {
        check(`★★ ${rt.key} 往返：层级 / 文字 / 折角 / 流程图源码一致`,
          same(coreOf(after.nodes), coreOf(before.nodes)),
          `before=${JSON.stringify(coreOf(before.nodes))}\nafter=${JSON.stringify(coreOf(after.nodes))}`)
      }
      check(`${rt.key} 往返：文档名保留`, after.name === before.name, `${before.name} → ${after.name}`)
      check(`${rt.key} 往返：节点数没变`, after.nodes.length === before.nodes.length,
        `${before.nodes.length} → ${after.nodes.length}`)
    }

    /* ---- PDF 那条不进往返（它是一张要打印的纸，不是数据），但要确认入口会开视图 ---- */
    if (!(await rectOf('[data-export-sheet]'))) await openExportPanel()
    await evaluate(`(() => {
      window.__mfOpened = []
      window.__mfOrigOpen = window.open
      window.open = function () { window.__mfOpened.push(arguments[0] || 'blank'); return null }
      return true
    })()`)
    await clickSel('[data-export-format="pdf"]')
    await sleep(1800)
    const pdfToast = await evaluate(TOAST)
    check('★ PDF 行：会开打印视图（这里 window.open 被拦，走下载兜底并说明文件名）',
      /\.html|打印/.test(pdfToast || ''), String(pdfToast))
    await evaluate(`window.open = window.__mfOrigOpen`)
    note(`PDF 提示：${pdfToast}`)

    /* ================================================================ */
    console.log('\n[4] 桌面端不许被改动')
    const desk = await evaluate(`(() => ({
      html: !!document.querySelector('[data-tool="export-html"]'),
      pdf: !!document.querySelector('[data-tool="export-pdf"]'),
      md: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '导出 MD'),
      backup: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '备份'),
      importLink: !!document.querySelector('[data-import-trigger="desktop"]'),
      tabsMobileSheet: !!document.querySelector('[data-mobile-tabs-sheet]'),
      bottomToolbar: document.querySelectorAll('[data-bottom-toolbar] button').length,
      moreSheet: !!document.querySelector('[data-more-sheet]'),
    }))()`)
    check('桌面端原来那几颗导出按钮一个不少（⇩ / ⎙ / 导出 MD / 备份）',
      desk.html && desk.pdf && desk.md && desk.backup, JSON.stringify(desk))
    check('桌面端没有手机端的标签面板 / 更多面板', desk.tabsMobileSheet === false && desk.moreSheet === false, JSON.stringify(desk))
    check('桌面端底栏按钮数还是 11 颗', desk.bottomToolbar === 11, String(desk.bottomToolbar))

    /* ================================================================ */
    console.log('\n[5] 手机端：导出面板装得下、点得到')
    await setViewport(PHONE)
    await sleep(700)
    await evaluate(CAP)
    await clickSel('[data-tool="more"]')
    await sleep(450)
    check('手机端「更多」里有导出入口', (await rectOf('[data-more-item="导出"]')) != null)
    await clickSel('[data-more-item="导出"]')
    await sleep(500)
    const mSheet = await rectOf('[data-export-sheet]')
    check('★ 手机端导出面板是从底部展开的（贴着工具栏上方）', mSheet != null, JSON.stringify(mSheet))
    if (mSheet) {
      check('★ 面板完全落在视口内',
        mSheet.x >= -1 && mSheet.right <= PHONE.width + 1 && mSheet.y >= -1 && mSheet.bottom <= PHONE.height + 1,
        JSON.stringify(mSheet))
      const mRows = await evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-export-format]')]
        const vh = document.documentElement.clientHeight
        return rows.map((b) => {
          const r = b.getBoundingClientRect()
          return { key: b.dataset.exportFormat, h: Math.round(r.height), inside: r.top >= -1 && r.bottom <= vh + 1 }
        })
      })()`)
      check('★ 手机端六个格式都在、每个 ≥44px、全都在视口里',
        mRows.length === 6 && mRows.every((r) => r.h >= 44 && r.inside), JSON.stringify(mRows))
      check('★ 手机端面板不横向溢出',
        (await evaluate(`(() => { const s = document.querySelector('[data-export-sheet]'); return s.scrollWidth <= s.clientWidth + 1 })()`)) === true)
      check('面板有「关闭」按钮（44px 宽的热区）',
        ((await rectOf('[data-export-close]')) || {}).w >= 44, JSON.stringify(await rectOf('[data-export-close]')))
    }
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(400)
    check('★ Esc 关掉导出面板', (await rectOf('[data-export-sheet]')) === null)

    /*
     * 横屏矮视口：667×375 时「六个格式 + 标题」是 368px 高，而底部起点在 y=68 ——
     * 不夹高度就会顶出屏幕上边（「更多」面板上一轮就是这么翻车的）。
     */
    await setViewport(LANDSCAPE)
    await sleep(600)
    await clickSel('[data-tool="more"]')
    await sleep(450)
    await clickSel('[data-more-item="导出"]')
    await sleep(500)
    const land = await evaluate(`(() => {
      const s = document.querySelector('[data-export-sheet]')
      if (!s) return null
      const r = s.getBoundingClientRect()
      const rows = [...s.querySelectorAll('[data-export-format]')]
      const scroller = s.querySelector('div[class*="overflow-auto"]') || s
      scroller.scrollTop = 0
      const first = rows.length ? rows[0].getBoundingClientRect() : null
      scroller.scrollTop = scroller.scrollHeight
      const last = rows.length ? rows[rows.length - 1].getBoundingClientRect() : null
      const vh = document.documentElement.clientHeight
      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom), vh,
        firstInside: !!first && first.top >= -1 && first.bottom <= vh + 1,
        lastInside: !!last && last.top >= -1 && last.bottom <= vh + 1,
        overflowY: getComputedStyle(scroller).overflowY,
      }
    })()`)
    check('★ 横屏下导出面板不顶出屏幕上边', land != null && land.top >= -1, JSON.stringify(land))
    if (land) {
      check('★ 横屏下首条可见', land.firstInside === true, JSON.stringify(land))
      check('★ 横屏下末条可达（能滚到）', land.lastInside === true || /auto|scroll/.test(land.overflowY), JSON.stringify(land))
    }
    await setViewport(DESKTOP)
    await sleep(400)

    /* ================================================================ */
    console.log('\n[6] 页面没有控制台报错')
    const realErrors = consoleErrors.filter((e) => !/favicon|404|Failed to load resource/i.test(e))
    check('没有未捕获的运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

    console.log(`\n${'='.repeat(46)}`)
    console.log(`  通过 ${pass} / 失败 ${fail}`)
    console.log('='.repeat(46))
  } finally {
    try { cdp.close() } catch { /* ignore */ }
    try { proc.kill() } catch { /* ignore */ }
  }

  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('套件异常：', e)
  process.exit(2)
})
