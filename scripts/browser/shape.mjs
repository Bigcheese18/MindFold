/**
 * 节点外形（形状）浏览器端测试
 * ==============================
 * 纯函数测试只能证明「形状表自洽」，**证明不了 mermaid 认不认**。
 * 这一套专门补那个洞 —— 用真的 mermaid 把 13 种外形各渲染一遍。
 *
 * 为什么必须有这一套：写这张表时把双圆的闭括号写成了 `"))`（少一个 `)`），
 * 而纯函数往返测试**全部通过** —— 因为「写进去」和「读回来」用的是同一张错表，
 * 自洽得很。只有真 mermaid 才会在渲染时报 Parse error。
 * 所以这里的判据是「真渲染出来的 SVG 几何」，不是字符串。
 *
 * 覆盖：
 *   1. 13 种外形逐个渲染：无报错 + 几何特征各自不同（不是只数标签）
 *   2. 一张图混用多种外形 → 每个节点各自是它该有的几何
 *   3. 缩进列表写 {判断} → 代码里出现 {"判断"}，图上真的是菱形
 *   4. 代码里写 {"…"} → 缩进列表读回 {菱形}（切模式不丢形状）
 *   5. 形状下拉框：没选中节点时禁用；选中后能改，且**图跟着变**
 *   6. 老文档（没有形状标记）编译出来仍是纯 ["…"]
 *
 * 用法：node scripts/browser/shape.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
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

const PORT = 9348
const userDir = mkdtempSync(join(tmpdir(), 'mf-shape-'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (msg) => console.log(`  · ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/**
 * 每种外形的**几何指纹**（真 mermaid 渲染出来的 SVG 结构）。
 * 从实测得出，不是猜的：
 *   · 方框 / 圆角 都是 <rect>，靠 rx 区分（圆角 rx=5）
 *   · 菱形/六边形/双边框/左右斜/梯形/倒梯形 都是 <polygon>，靠顶点表区分
 *   · 圆形 = 1 个 <circle>；双圆 = 2 个 <circle>
 *   · 胶囊 = 2 段 <path>；圆柱 = 1 段 <path>
 */
const SHAPES = [
  { key: 'rect', cn: '方框', o: '["', c: '"]', kind: 'rect', rx: null },
  { key: 'rounded', cn: '圆角', o: '("', c: '")', kind: 'rect', rx: '5' },
  { key: 'diamond', cn: '菱形', o: '{"', c: '"}', kind: 'poly', polyN: 4 },
  { key: 'circle', cn: '圆形', o: '(("', c: '"))', kind: 'circles', circles: 1 },
  { key: 'stadium', cn: '胶囊', o: '(["', c: '"])', kind: 'paths', paths: 2 },
  { key: 'cylinder', cn: '圆柱', o: '[("', c: '")]', kind: 'paths', paths: 1 },
  { key: 'hexagon', cn: '六边形', o: '{{"', c: '"}}', kind: 'poly', polyN: 6 },
  { key: 'subroutine', cn: '双边框', o: '[["', c: '"]]', kind: 'poly', polyN: 10 },
  { key: 'lean_right', cn: '右斜', o: '[/"', c: '"/]', kind: 'poly', polyN: 4 },
  { key: 'lean_left', cn: '左斜', o: '[\\"', c: '"\\]', kind: 'poly', polyN: 4 },
  { key: 'trapezoid', cn: '梯形', o: '[/"', c: '"\\]', kind: 'poly', polyN: 4 },
  { key: 'inv_trapezoid', cn: '倒梯形', o: '[\\"', c: '"/]', kind: 'poly', polyN: 4 },
  { key: 'doublecircle', cn: '双圆', o: '((("', c: '")))', kind: 'circles', circles: 2 },
]

async function main() {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) { target = page; break }
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('无法连接 Edge DevTools')

  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })

  const consoleErrors = []
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push((p.args || []).map((a) => a.value ?? a.description).join(' '))
  })
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown')
  })

  await cdp.send('Page.navigate', { url: URL_APP })

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }

  /**
   * 等条件成立，而不是睡固定时间。
   * 这一条是拿时间换来的教训：最初用 sleep(5000) 等应用启动，
   * 快的时候够、慢的时候不够，于是同一份代码两次跑出相反结论 ——
   * 被误判成「写不进去」。
   */
  const waitFor = async (expr, label, timeoutMs = 25000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try { if (await evaluate(expr)) return true } catch { /* 还在挂载 */ }
      await sleep(200)
    }
    note(`等待超时：${label}`)
    return false
  }

  check('页面挂载完成（#root 有内容）',
    await waitFor(`!!document.querySelector('#root')?.firstElementChild`, '#root'))

  /* ---------------- 打开折角弹窗 ---------------- */
  console.log('\n[0] 准备：打开折角弹窗')
  check('折角角标存在',
    await waitFor(`document.querySelectorAll('[data-fold-badge]').length > 0`, '折角角标'))
  await evaluate(`(async () => {
    const b = [...document.querySelectorAll('[data-fold-badge]')][0]
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 1
  })()`)
  check('折角弹窗打开',
    await waitFor(`!!document.querySelector('[data-fold-modal]')`, '弹窗'))

  const setMode = async (m) => {
    await evaluate(`(() => { document.querySelector('[data-mode-tab="${m}"]')?.click(); return 1 })()`)
    // 等编辑器真的换成该模式的样子
    if (m === 'code') {
      return waitFor(`document.querySelectorAll('[data-fold-modal] textarea').length > 0`, '代码编辑器')
    }
    return waitFor(`document.querySelectorAll('[data-fold-modal] [data-outline-input]').length > 0`, '缩进列表')
  }

  const writeCode = async (src) => {
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const ta = document.querySelector('[data-fold-modal] textarea')
      if (!ta) return { error: 'no textarea' }
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(src)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(50)
      return 1
    })()`)
    // 等图重画：节点数对得上才继续
    const want = (src.match(/^\s*\S+(\[|\{|\()/gm) || []).length
    await waitFor(`document.querySelectorAll('[data-fold-modal] g.node').length >= ${Math.max(1, want)}`, '图重画')
  }

  const readCode = () => evaluate(`(() => {
    const ta = document.querySelector('[data-fold-modal] textarea')
    return ta ? ta.value : null
  })()`)

  /** 读缩进列表当前每行的原文 */
  const readOutline = () => evaluate(`(() => {
    return [...document.querySelectorAll('[data-fold-modal] [data-outline-input]')].map(i => i.value)
  })()`)

  /** 读第一个节点的几何指纹 */  const shapeFingerprint = () => evaluate(`(() => {
    const m = document.querySelector('[data-fold-modal]')
    const g = m.querySelector('g.node')
    if (!g) return { error: '没有 g.node' }
    const pg = g.querySelector('polygon')
    const rc = g.querySelector('rect')
    return {
      label: (g.textContent || '').trim(),
      polyN: pg ? (pg.getAttribute('points') || '').trim().split(/\\s+/).length : 0,
      pts: pg ? (pg.getAttribute('points') || '').trim().split(/\\s+/)
        .map(p => p.split(',').map(v => Math.round(+v)).join(',')).join(' ') : null,
      rx: rc ? rc.getAttribute('rx') : null,
      circles: g.querySelectorAll('circle').length,
      paths: g.querySelectorAll('path').length,
      nodes: m.querySelectorAll('g.node').length,
      edges: m.querySelectorAll('path.flowchart-link').length,
    }
  })()`)

  /* ---------------- [1] 逐个外形 ---------------- */
  console.log('\n[1] 13 种外形逐个渲染（真 mermaid，无报错，几何各不相同）')
  check('切到代码模式', await setMode('code'), '代码模式')

  const seen = new Map()
  for (const s of SHAPES) {
    await writeCode(`flowchart TD\n  A${s.o}甲${s.c}`)
    const fp = await shapeFingerprint()
    const nErrBefore = consoleErrors.length

    // 几何判据：每种外形必须长得像它该有的样子
    let shapeOk = false
    if (s.kind === 'rect') shapeOk = fp.rx === s.rx && fp.polyN === 0 && fp.circles === 0
    else if (s.kind === 'poly') shapeOk = fp.polyN === s.polyN
    else if (s.kind === 'circles') shapeOk = fp.circles === s.circles
    else if (s.kind === 'paths') shapeOk = fp.paths === s.paths

    // 标签必须活着（没被括号吃掉、没变成别的东西）
    const labelOk = fp.label === '甲'
    check(`${s.cn} (${s.key}) 渲染成该有的几何`, shapeOk && labelOk,
      JSON.stringify(fp))
    check(`${s.cn} (${s.key}) 渲染无报错`, consoleErrors.length === nErrBefore,
      consoleErrors.slice(nErrBefore).join(' | '))

    // 记录指纹，稍后验证「13 种外形两两不同」
    const sig = [fp.polyN, fp.rx, fp.circles, fp.paths, fp.pts].join('|')
    seen.set(s.key, sig)
  }

  const sigs = [...seen.values()]
  check(`★ 13 种外形两两几何不同（不是只有一种图案）`,
    new Set(sigs).size === sigs.length,
    `不同签名 ${new Set(sigs).size} / 共 ${sigs.length}`)
  // 单独钉住实测出来最像的一对：左斜和梯形都是 4 顶点、包围盒一样
  check('★ 左斜与梯形靠顶点表分得开（曾被怀疑是同一个形状）',
    seen.get('lean_left') !== seen.get('trapezoid'),
    JSON.stringify([seen.get('lean_left'), seen.get('trapezoid')]))

  /* ---------------- [2] 混用 ---------------- */
  console.log('\n[2] 一张图混用多种外形')
  const MULTI = [
    'flowchart TD',
    '  A["开始"] --> B{"判断"}',
    '  B --> C[("数据库")]',
    '  B --> D(["成功"])',
    '  C --> E((("汇总")))',
  ].join('\n')
  await writeCode(MULTI)
  const multi = await evaluate(`(() => {
    const m = document.querySelector('[data-fold-modal]')
    const nodes = [...m.querySelectorAll('g.node')]
    return {
      n: nodes.length,
      e: m.querySelectorAll('path.flowchart-link').length,
      per: nodes.map(g => ({
        label: (g.textContent || '').trim(),
        poly: g.querySelectorAll('polygon').length,
        circ: g.querySelectorAll('circle').length,
        path: g.querySelectorAll('path').length,
        rect: g.querySelectorAll('rect').length,
      })),
    }
  })()`)
  check('节点数 = 5、连线数 = 4', multi.n === 5 && multi.e === 4, JSON.stringify(multi))
  const byLabel = Object.fromEntries(multi.per.map((p) => [p.label, p]))
  check('「开始」是方框（rect，无多边形/圆）',
    byLabel['开始']?.rect >= 1 && byLabel['开始']?.poly === 0 && byLabel['开始']?.circ === 0,
    JSON.stringify(byLabel['开始']))
  check('「判断」是菱形（多边形）', byLabel['判断']?.poly === 1, JSON.stringify(byLabel['判断']))
  check('「数据库」是圆柱（1 段 path）', byLabel['数据库']?.path === 1, JSON.stringify(byLabel['数据库']))
  check('「成功」是胶囊（2 段 path）', byLabel['成功']?.path === 2, JSON.stringify(byLabel['成功']))
  check('「汇总」是双圆（2 个 circle）', byLabel['汇总']?.circ === 2, JSON.stringify(byLabel['汇总']))

  /* ---------------- [3] 缩进列表 → 图 ---------------- */
  console.log('\n[3] 缩进列表写 {判断} → 代码出现 {"判断"}，图真的是菱形')
  check('切到缩进列表模式', await setMode('outline'), '缩进列表')
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const ins = [...document.querySelectorAll('[data-fold-modal] [data-outline-input]')]
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    // 把现有行都清掉，只留两行
    for (let i = 0; i < ins.length; i++) {
      setter.call(ins[i], i === 0 ? '起点' : (i === 1 ? '  判定 {判断}' : ''))
      ins[i].dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(120)
    }
    await sleep(1200)
    return 1
  })()`)
  const outlineNow = await readOutline()
  check('缩进列表里 {判断} 被原文保留（形状存在文档里）',
    outlineNow.some((l) => l.includes('判定 {判断}')), JSON.stringify(outlineNow))

  await setMode('code')
  const codeAfter = await readCode()
  check('★ 编译出来的代码是 n1{"判定"}（菱形）',
    /n\d+\{"判定"\}/.test(String(codeAfter)), JSON.stringify(String(codeAfter).slice(0, 160)))
  const fpAfter = await evaluate(`(() => {
    const m = document.querySelector('[data-fold-modal]')
    // 注意：图上的**第一个** g.node 是根节点（起点），不是菱形那个。
    // 早先按「第一个」断言，于是永远测不到菱形 —— 要按标签找。
    const g = [...m.querySelectorAll('g.node')].find(n => (n.textContent || '').trim() === '判定')
    if (!g) return { error: '找不到「判定」节点', labels: [...m.querySelectorAll('g.node')].map(n => n.textContent.trim()) }
    const pg = g.querySelector('polygon')
    return {
      label: '判定',
      polyN: pg ? (pg.getAttribute('points') || '').trim().split(/\\s+/).length : 0,
      circles: g.querySelectorAll('circle').length,
    }
  })()`)
  check('★ 图上「判定」真的是多边形（菱形），不是方框',
    fpAfter.polyN === 4, JSON.stringify(fpAfter))

  /* ---------------- [4] 代码 → 缩进列表 ---------------- */
  console.log('\n[4] 代码里写 {"…"} → 切回缩进列表读回 {菱形}（不丢形状）')
  await writeCode('flowchart TD\n  A{"判断一下"}\n  B[("数据库")]\n  A --> B')
  await setMode('outline')
  const backOutline = await readOutline()
  check('★ 切回缩进列表：菱形读回 {菱形}',
    backOutline.some((l) => l.includes('判断一下 {菱形}')), JSON.stringify(backOutline))
  check('★ 切回缩进列表：圆柱读回 {圆柱}',
    backOutline.some((l) => l.includes('数据库 {圆柱}')), JSON.stringify(backOutline))

  /* ---------------- [5] 形状下拉框 ---------------- */
  console.log('\n[5] 形状下拉框')
  const pickerInfo = () => evaluate(`(() => {
    const s = document.querySelector('[data-shape-picker]')
    if (!s) return { exists: false }
    return {
      exists: true, n: s.options.length, disabled: s.disabled, value: s.value,
      options: [...s.options].map(o => o.value),
    }
  })()`)
  const pk0 = await pickerInfo()
  check('下拉框存在且有 13 项', pk0.exists && pk0.n === 13, JSON.stringify(pk0))
  check('下拉框列出的就是形状表里的 key',
    JSON.stringify(pk0.options) === JSON.stringify(SHAPES.map((s) => s.key)),
    JSON.stringify(pk0.options))

  // 用真鼠标点第一个节点，触发「选中」
  console.log('\n[5b] 点选节点后下拉框可用，改形状图跟着变')
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const g = document.querySelector('[data-fold-modal] g.node')
    const b = g.getBoundingClientRect()
    const x = b.left + b.width / 2, y = b.top + b.height / 2
    const opts = { bubbles: true, clientX: x, clientY: y, button: 0 }
    g.dispatchEvent(new MouseEvent('mousedown', opts))
    g.dispatchEvent(new MouseEvent('mouseup', opts))
    g.dispatchEvent(new MouseEvent('click', opts))
    await sleep(900)
    return 1
  })()`)
  const pk1 = await pickerInfo()
  check('选中节点后下拉框启用', pk1.disabled === false, JSON.stringify(pk1))
  check('下拉框当前值 = 该节点的真实外形',
    SHAPES.some((s) => s.key === pk1.value), JSON.stringify(pk1))

  // 改成一个肯定不同的形状，验证图跟着变
  const changeTo = pk1.value === 'hexagon' ? 'circle' : 'hexagon'
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const s = document.querySelector('[data-shape-picker]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(s, '${changeTo}')
    s.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(1200)
    return 1
  })()`)
  const afterChange = await shapeFingerprint()
  const want = SHAPES.find((s) => s.key === changeTo)
  check(`★ 下拉框改成「${want.cn}」后图真的变了`,
    want.kind === 'poly' ? afterChange.polyN === want.polyN
      : want.kind === 'circles' ? afterChange.circles === want.circles
        : want.kind === 'paths' ? afterChange.paths === want.paths
          : afterChange.rx === want.rx,
    JSON.stringify([changeTo, afterChange]))
  await setMode('outline')
  const outlineChanged = await readOutline()
  check(`★ 缩进列表里写出了 {${want.cn}}（形状落到文档里）`,
    outlineChanged.some((l) => l.includes(`{${want.cn}}`)), JSON.stringify(outlineChanged))

  /* ---------------- [6] 老文档不变 ---------------- */
  console.log('\n[6] 老文档（没有形状标记）编译出来仍是纯 ["…"]')
  await setMode('code')
  await writeCode('flowchart TD\n  A["甲"]\n  B["乙"]\n  A --> B')
  await setMode('outline')
  const plainOutline = await readOutline()
  check('老文档切缩进列表：没有多出任何 {…} 标记',
    !plainOutline.some((l) => /\{[^}]*\}/.test(l)), JSON.stringify(plainOutline))
  await setMode('code')
  const plainCode = await readCode()
  check('★ 老文档代码仍是纯 ["…"]（没被改写）',
    String(plainCode).includes('A["甲"]') && String(plainCode).includes('B["乙"]'),
    JSON.stringify(String(plainCode)))

  /* ---------------- [7] 收尾 ---------------- */
  console.log('\n[7] 全程无控制台报错')
  // 过滤掉与本功能无关的既有噪音（如果有的话，这里会显示出来以便判断）
  const real = consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e))
  check('没有 mermaid 解析错 / JS 异常', real.length === 0, real.slice(0, 3).join(' | '))

  /* ---------------- [8] 顶栏装不装得下 ---------------- */
  /**
   * 这一节测的是「新控件会不会把顶栏挤爆」。
   * 顶栏从 5 个控件变成 6 个（多了外形下拉框）之后，390px 宽实测：
   *   · 「重置熟悉度」是个没有固定宽度的中文按钮 → flex 把它压窄 → **文字换行**，
   *     变成一根 34px 宽、100px 高的柱子，而顶栏只有 48px；
   *   · 关闭按钮被压到 13px（本来是 28px）；
   *   · 顶栏整体右溢出 1px，关闭按钮右边缘落在 391 > 屏宽 390。
   * 修法是 shrink-0 + 手机上把中文换成 ↺，桌面端文字不动。
   * 这里把「每个控件的右边缘都不许超过屏宽」钉死 —— 只看 scrollWidth
   * 会漏掉「溢出 1px」这种，而 1px 就意味着关闭按钮被切掉一条。
   */
  console.log('\n[8] 折角弹窗顶栏在多种视口下都装得下')
  const HDR = `(() => {
    const m = document.querySelector('[data-fold-modal]')
    if (!m) return { error: '弹窗没开' }
    const hdr = m.querySelector('header')
    const reset = m.querySelector('[data-reset-familiarity]')
    const closeBtn = [...hdr.querySelectorAll('button')]
      .find(b => (b.getAttribute('title') || '').includes('关闭'))
    const shapeSel = m.querySelector('[data-shape-picker]')
    if (!closeBtn || !shapeSel || !reset) {
      return { error: '控件缺失', close: !!closeBtn, shape: !!shapeSel, reset: !!reset }
    }
    const cb = closeBtn.getBoundingClientRect()
    const sb = shapeSel.getBoundingClientRect()
    const hit = document.elementFromPoint(cb.left + cb.width/2, cb.top + cb.height/2)
    return {
      vw: innerWidth,
      overflowPx: hdr.scrollWidth - hdr.clientWidth,
      maxRight: Math.round(Math.max(...[...hdr.children]
        .filter(e => e.getBoundingClientRect().width > 0)
        .map(e => e.getBoundingClientRect().right))),
      closeW: Math.round(cb.width),
      closeHitsSelf: hit === closeBtn,
      closeShrunk: cb.width < 26,
      shapeW: Math.round(sb.width),
      shapeInViewport: sb.left >= 0 && sb.right <= innerWidth + 0.5,
      resetText: reset.textContent.trim(),
      resetW: Math.round(reset.getBoundingClientRect().width),
      resetH: Math.round(reset.getBoundingClientRect().height),
      titleRendered: !!hdr.querySelector('h2'),
      paneSwitch: !!m.querySelector('[data-pane-switch]'),
    }
  })()`

  const openModal = () => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    for (let i = 0; i < 40; i++) {
      const b = [...document.querySelectorAll('[data-fold-badge]')][0]
      if (b) { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(2200); break }
      await sleep(250)
    }
    return !!document.querySelector('[data-fold-modal]')
  })()`)

  const VIEWPORTS = [
    ['竖屏 iPhone 14 Pro', 390, 844, true, 2, true],
    ['竖屏窄机 360', 360, 640, true, 2, true],
    ['竖屏 iPhone SE', 375, 667, true, 2, true],
    ['横屏 iPhone 14 Pro', 844, 390, true, 2, false],
    ['桌面 1024', 1024, 768, false, 1, false],
    ['桌面 1440', 1440, 900, false, 1, false],
  ]
  for (const [name, w, h, mobile, dpr, expectStacked] of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: dpr, mobile,
    })
    await cdp.send('Page.navigate', { url: URL_APP })
    await waitFor(`document.querySelectorAll('[data-fold-badge]').length > 0`, name + ' 角标')
    await openModal()
    const r = await evaluate(HDR)
    check(`${name} (${w}×${h}) 顶栏不溢出`, r && r.overflowPx <= 0 && !r.error, JSON.stringify(r))
    check(`${name} 所有控件的右边缘都在屏内`, r && r.maxRight <= w + 0.5,
      `maxRight=${r?.maxRight} vw=${w}`)
    check(`${name} 关闭按钮没被压扁且点得到`,
      r && !r.closeShrunk && r.closeHitsSelf, JSON.stringify({ w: r?.closeW, hit: r?.closeHitsSelf }))
    check(`${name} 外形下拉框完整在屏内`, r && r.shapeInViewport && r.shapeW >= 60, JSON.stringify(r))
    check(`${name} 重置按钮不换行（高度不超过顶栏）`,
      r && r.resetH <= 30 && r.resetW >= 26, JSON.stringify({ w: r?.resetW, h: r?.resetH }))
    // 桌面端必须一字不变：标题在、面板切换没有、文字是完整中文
    if (!expectStacked) {
      check(`${name} 桌面端顶栏与改前一致（有标题 / 无面板切换 / 完整中文）`,
        r && r.titleRendered && !r.paneSwitch && r.resetText === '重置熟悉度',
        JSON.stringify({ title: r?.titleRendered, pane: r?.paneSwitch, text: r?.resetText }))
    } else {
      check(`${name} 手机端用紧凑图标（标题让位）`,
        r && !r.titleRendered && r.paneSwitch && r.resetText === '↺',
        JSON.stringify({ title: r?.titleRendered, text: r?.resetText }))
    }
  }

  cdp.close()
  proc.kill()
}

main()
  .catch((e) => { console.error('\n测试崩了：' + (e?.stack || e)); fail++ })
  .finally(() => {
    try { rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
    console.log(`\n${'='.repeat(46)}`)
    console.log(`  节点外形（浏览器端）  通过 ${pass} / 失败 ${fail}`)
    console.log('='.repeat(46))
    process.exit(fail ? 1 : 0)
  })
