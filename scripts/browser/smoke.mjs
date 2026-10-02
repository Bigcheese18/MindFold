/**
 * 浏览器端交互冒烟测试
 * ====================
 * 用 Edge headless + 远程调试协议驱动真实页面，验证 PRD 的核心闭环：
 *   1. 首屏渲染出带折角的导图
 *   2. 折角元素真实存在，且点击热区为 30x30
 *   3. 点击折角 → 全屏弹窗打开，缩进列表 → Mermaid 实时渲染出 SVG
 *   4. 故意写错语法 → 右侧保留上一版正确的图（绝不消失）
 *   5. 关闭弹窗后，打开次数 +1（折角颜色分级的数据基础）
 *
 * 不做单元测试的替代，只补齐「真实 DOM + 真实 mermaid 渲染」这一段。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, createReadStream, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, resolve as resolvePath } from 'node:path'
import { createServer } from 'node:http'
import MiniWS from './_ws.mjs'

// 默认自己起一个静态服务器托管 dist/，不依赖 dev server
// （dev server 的 watcher 会被 Node 的临时文件干扰）。
const EXTERNAL_URL = process.argv[2] || null
const DIST = resolvePath(process.cwd(), 'dist')
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

if (!EDGE) {
  console.error('找不到 Edge / Chrome，无法执行浏览器冒烟测试')
  process.exit(2)
}

const PORT = 9333
const userDir = mkdtempSync(join(tmpdir(), 'mf-cdp-'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
/** 只打印上下文、不计分的观察行（和 zoompan / relatebrowser 等套件同一约定） */
const note = (msg) => console.log(`  · ${msg}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 起静态服务器（除非显式传入外部 URL）
  let staticServer = null
  let URL_APP = EXTERNAL_URL
  if (!URL_APP) {
    if (!existsSync(join(DIST, 'index.html'))) {
      console.error('dist/index.html 不存在，请先执行 npm run build')
      process.exit(2)
    }
    staticServer = await serveStatic(DIST)
    URL_APP = `http://127.0.0.1:${staticServer.port}/`
    console.log(`静态服务器：${URL_APP}`)
  }

  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })

  // 等 DevTools 端口就绪
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
  // 显式指定视口：headless 复用 about:blank 目标时 --window-size 不生效，
  // 默认只有 500x450，会让「节点是否真的可见」这类断言失去意义。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })

  // 收集页面 console 错误 —— 渲染异常必须被抓出来
  const consoleErrors = []
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push((p.args || []).map((a) => a.value ?? a.description).join(' '))
  })
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown')
  })

  await cdp.send('Page.navigate', { url: URL_APP })
  await sleep(5000) // 等 React 挂载 + 首次布局

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }

  console.log('\n[1] 首屏渲染')
  const nodeCount = await evaluate(`document.querySelectorAll('[data-node-id]').length`)
  check('画布渲染出节点', nodeCount > 10, `得到 ${nodeCount}`)

  const edgeCount = await evaluate(`document.querySelectorAll('svg path.mf-edge').length`)
  check('连接线已绘制', edgeCount > 10, `得到 ${edgeCount}`)

  // 节点必须真的落在视口里 —— 只统计 DOM 数量会漏掉「布局跑到屏幕外」这类问题
  const visibility = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-node-id]')]
    const inView = nodes.filter(n => {
      const r = n.getBoundingClientRect()
      return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
    })
    const t = inView[0] && inView[0].querySelector('[data-text]')
    return {
      inView: inView.length, total: nodes.length,
      sample: t ? t.textContent.trim().slice(0, 16) : null,
      vw: innerWidth, vh: innerHeight,
    }
  })()`)
  check('视口尺寸已生效（1440x900）', visibility.vw === 1440 && visibility.vh === 900,
    `${visibility.vw}x${visibility.vh}`)
  check('有节点真正显示在视口内', visibility.inView >= 5,
    `${visibility.inView}/${visibility.total} 可见，例如「${visibility.sample}」`)

  // 布局方向 + 自动居中：这两条是用户明确报过的问题，必须有回归测试守着
  const geom = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-node-id]')]
    const rects = nodes.map(n => n.getBoundingClientRect())
    const minX = Math.min(...rects.map(r => r.left))
    const maxX = Math.max(...rects.map(r => r.right))
    const minY = Math.min(...rects.map(r => r.top))
    const maxY = Math.max(...rects.map(r => r.bottom))

    // 用 data-node-id 找到根节点（深度最小的那个在最左）
    const byX = [...nodes].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
    const rootEl = byX[0]
    const rr = rootEl.getBoundingClientRect()

    // 父节点应垂直居中于子节点跨度：用「同一父节点的子节点」无法直接从 DOM 得知，
    // 这里退一步检查根节点是否落在整张图的垂直中线上（横向树的关键特征）
    const contentCx = (minX + maxX) / 2
    const contentCy = (minY + maxY) / 2

    return {
      vw: innerWidth, vh: innerHeight,
      contentW: Math.round(maxX - minX), contentH: Math.round(maxY - minY),
      contentCx: Math.round(contentCx), contentCy: Math.round(contentCy),
      rootLeft: Math.round(rr.left), rootCy: Math.round(rr.top + rr.height / 2),
      // 连线是否贝塞尔
      curved: [...document.querySelectorAll('path.mf-edge')].every(p => (p.getAttribute('d') || '').includes('C')),
      edgeCount: document.querySelectorAll('path.mf-edge').length,
    }
  })()`)

  check('整体布局是横向的（内容宽 > 高）', geom.contentW > geom.contentH,
    `内容 ${geom.contentW} × ${geom.contentH}`)
  check('内容水平居中（±2% 视口宽）',
    Math.abs(geom.contentCx - geom.vw / 2) < geom.vw * 0.02,
    `内容中心 x=${geom.contentCx}，视口中心=${geom.vw / 2}`)
  check('内容垂直居中（±2% 视口高）',
    Math.abs(geom.contentCy - geom.vh / 2) < geom.vh * 0.02,
    `内容中心 y=${geom.contentCy}，视口中心=${geom.vh / 2}`)
  check('内容完整落在视口内（未被裁切）', (() => {
    // 允许 1px 误差
    return true
  })() && geom.contentW <= geom.vw && geom.contentH <= geom.vh,
    `内容 ${geom.contentW}×${geom.contentH}，视口 ${geom.vw}×${geom.vh}`)
  check('根节点在最左侧', geom.rootLeft <= geom.contentCx - geom.contentW * 0.2,
    `根 left=${geom.rootLeft}`)
  check('根节点大致在垂直中线', Math.abs(geom.rootCy - geom.vh / 2) < geom.vh * 0.15,
    `根 cy=${geom.rootCy}，中线=${geom.vh / 2}`)
  check('连接线全部是贝塞尔曲线', geom.curved === true && geom.edgeCount > 0,
    `${geom.edgeCount} 条边`)

  /* ================================================================== */
  console.log('\n[1b] UI 图标：不许有 Emoji，全走内联 SVG + 工具栏尺寸')
  /* ================================================================== */

  /*
   * 用户要求：「俩个栏里面的固定图形不要 emoji，难看死了，要 svg」。
   * Emoji 全部换掉：顶部标签栏的图钉、左侧大纲栏的图钉、底栏的回收站，
   * 以及弹窗里那两个 ⚠。
   *
   * 【判据为什么用 `\p{Extended_Pictographic}` 而不是「某个 svg 类名」】
   * 换个图标实现（换 path、换 size）不该让测试变红；真正的不变量是
   * 「界面上画的是矢量图形，不是系统 Emoji 字体接管过去的彩色位图」。
   * `Extended_Pictographic` 正是 Unicode 给 Emoji 划的那个属性集合，
   * 它把 📌 📍 🗑 ⚠ 都算进去，而 ✕ ▸ ▾ ◇ ⊙ ↺ 这些**排印符号**不算 ——
   * 后者在各平台字形稳定、也不会被 Emoji 字体接管，不是这次要治的问题。
   */
  const iconAudit = await evaluate(`(() => {
    const EMOJI = /\\p{Extended_Pictographic}/u
    const pick = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const svg = el.querySelector('svg')
      return {
        text: (el.textContent || '').trim(),
        hasSvg: !!svg,
        shapes: svg ? svg.querySelectorAll('path, line, circle, rect').length : 0,
        // 属性而不是 computed style：computed 会把 currentColor 解析成继承到的具体颜色
        strokeAttr: svg ? svg.getAttribute('stroke') : null,
      }
    }
    return {
      pinTabs: pick('[data-pin-tabs]'),
      pinTree: pick('[data-pin-tree]'),
      trash: pick('[data-tool="trash"]'),
      emojiInText: EMOJI.test(document.body.innerText || ''),
    }
  })()`)
  note(`图标审查：${JSON.stringify(iconAudit)}`)
  check('顶部标签栏的图钉是 SVG', iconAudit.pinTabs?.hasSvg === true, JSON.stringify(iconAudit.pinTabs))
  check('左侧大纲栏的图钉是 SVG', iconAudit.pinTree?.hasSvg === true, JSON.stringify(iconAudit.pinTree))
  check('底栏回收站是 SVG', iconAudit.trash?.hasSvg === true, JSON.stringify(iconAudit.trash))
  check('★ 三处按钮里都没有 Emoji 文字（textContent 为空）',
    !iconAudit.pinTabs?.text && !iconAudit.pinTree?.text && !iconAudit.trash?.text,
    JSON.stringify([iconAudit.pinTabs?.text, iconAudit.pinTree?.text, iconAudit.trash?.text]))
  check('图标跟随主题变色（走 stroke="currentColor"）',
    iconAudit.pinTabs?.strokeAttr === 'currentColor' && iconAudit.trash?.strokeAttr === 'currentColor',
    JSON.stringify([iconAudit.pinTabs?.strokeAttr, iconAudit.trash?.strokeAttr]))
  check('★ 首屏界面上不存在任何 Emoji 码点', iconAudit.emojiInText === false)

  /*
   * 工具栏尺寸 34×34（原来是 28×28）。
   * 需求「思维导图下面的工具有点太小了，放大一点」。
   * 这里断言「每一颗都一样大」+「比 28 明显大」，
   * 精确数值由 canvasundo.mjs 断言，避免两处各写一遍。
   */
  const barSize = await evaluate(`(() => {
    const bar = document.querySelector('[data-bottom-toolbar]')
    if (!bar) return null
    const btns = [...bar.querySelectorAll('button')].filter(b => !b.closest('[data-more-sheet]'))
    const sizes = btns.map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] })
    return { count: btns.length, sizes, uniq: [...new Set(sizes.map(s => s.join('x')))] }
  })()`)
  note(`底栏按钮：${JSON.stringify(barSize)}`)
  check('★ 底栏按钮放大到 34×34', barSize?.uniq?.length === 1 && barSize.uniq[0] === '34x34',
    JSON.stringify(barSize))
  check('★ 比原来的 28px 明显大（≥ 32）',
    (barSize?.sizes?.[0]?.[0] ?? 0) >= 32, JSON.stringify(barSize?.sizes?.[0]))
  /*
   * 【从 12 改成 11：底栏那颗「汇聚/指向同一结果」已按需求删除】
   * 原话「无论是电脑端还是手机端 底部的指向同一结果去掉 太多余了」。
   * 同一功能在右键菜单里就有（data-menu-item="point-merge"），
   * 底栏那颗是重复入口。所以这里断言 11 颗，并显式说明少的是哪一颗。
   */
  check('底栏按钮数量 = 11 颗（居中/放大/缩小/撤销/重做/雷达/卡片/历史/回收站/导出HTML/导出PDF）',
    barSize?.count === 11, String(barSize?.count))
  check('底栏里不再有「指向同一结果」（它只留在右键菜单里）',
    (await evaluate(`!document.querySelector('[data-bottom-toolbar] [data-tool="merge"]')`)) === true)

  console.log('\n[2] 折角角标')
  const foldHits = await evaluate(`document.querySelectorAll('[data-fold-badge]').length`)
  check('角标存在', foldHits > 0, `得到 ${foldHits}`)

  const hitBox = await evaluate(`(() => {
    const el = document.querySelector('[data-fold-badge]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
  check('角标点击热区 = 24x24', hitBox && hitBox.w === 24 && hitBox.h === 24,
    hitBox ? `${hitBox.w}x${hitBox.h}` : 'null')

  const visual = await evaluate(`(() => {
    const el = document.querySelector('[data-fold-badge] > span')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), radius: getComputedStyle(el).borderTopLeftRadius }
  })()`)
  check('角标视觉很小 (<20px) 且是正圆',
    visual && visual.w < 20 && /9999/.test(visual.radius),
    visual ? `${visual.w}x${visual.h} ${visual.radius}` : 'null')

  const hollowCount = await evaluate(`document.querySelectorAll('[data-fold-kind="ring"]').length`)
  check('存在空心圆圈角标（只有 [F] 无代码）', hollowCount > 0, `得到 ${hollowCount}`)

  console.log('\n[3] 点击折角 → 全屏弹窗 + 实时渲染')
  // 点一个带流程图的折角（第一个实心折角）
  const opened = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-node-id]')]
    // 找到带「数字角标」的节点（= 有流程图且打开过）
    for (const n of nodes) {
      const badge = n.querySelector('[data-fold-kind="num"], [data-fold-kind="dot"]')
      if (badge) {
        badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return true
      }
    }
    return false
  })()`)
  check('找到并点击了折角角标', opened === true)

  await sleep(2500) // 等弹窗动画 + mermaid 渲染

  const modalOpen = await evaluate(`!!document.querySelector('.mf-unfold')`)
  check('全屏弹窗已打开', modalOpen === true)

  const hasEditor = await evaluate(`document.querySelectorAll('[data-outline-input]').length`)
  check('缩进列表编辑器存在（块状行编辑器，不是 textarea）', hasEditor > 0, `${hasEditor} 行`)

  const svgRendered = await evaluate(`(() => {
    const m = document.querySelector('.mf-unfold')
    if (!m) return 0
    // 预览区里的 mermaid SVG（排除图标）
    return [...m.querySelectorAll('svg')].filter(s => s.querySelector('.node, .flowchart')).length
  })()`)
  check('右侧渲染出 mermaid 流程图', svgRendered > 0, `得到 ${svgRendered}`)

  console.log('\n[4] 语法报错时保留上一版正确的图')
  const beforeErr = await evaluate(`(() => {
    const m = document.querySelector('.mf-unfold')
    const svgs = [...m.querySelectorAll('svg')].filter(s => s.querySelector('.node, .flowchart'))
    return svgs.length ? svgs[0].outerHTML.length : 0
  })()`)

  // 切到代码模式，写入一段错误语法
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.mf-unfold button')]
    const code = btns.find(b => b.textContent.includes('Mermaid 代码'))
    if (code) code.click()
    return !!code
  })()`)
  await sleep(600)

  await evaluate(`(() => {
    const ta = document.querySelector('.mf-unfold textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, 'flowchart TD\\n  A["未闭合 --> B')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(2000)

  const afterErr = await evaluate(`(() => {
    const m = document.querySelector('.mf-unfold')
    const svgs = [...m.querySelectorAll('svg')].filter(s => s.querySelector('.node, .flowchart'))
    return svgs.length ? svgs[0].outerHTML.length : 0
  })()`)
  check('语法出错后，右侧仍保留上一版正确的图', afterErr > 0 && afterErr === beforeErr,
    `before=${beforeErr} after=${afterErr}`)

  const errShown = await evaluate(`(() => {
    const m = document.querySelector('.mf-unfold')
    return m ? m.innerText.includes('提示') || m.innerText.includes('语法') : false
  })()`)
  check('给出了语法错误提示', errShown === true)

  /*
   * 错误提示条里原来那个 ⚠ 是**唯一还留在弹窗里的 Emoji**
   * （U+26A0 属于 Extended_Pictographic，在 Windows 上会被系统 Emoji 字体
   * 接管成彩色感叹号三角）。现在换成了描边 SVG，颜色继承那一行的红/橙。
   * 这里在「错误条真的显示出来」的状态下复查一次，首屏那条断言覆盖不到它。
   */
  const errIcon = await evaluate(`(() => {
    const EMOJI = /\\p{Extended_Pictographic}/u
    const m = document.querySelector('.mf-unfold')
    const banner = [...m.querySelectorAll('div')].find(d => d.innerText.startsWith('第') || /代码未被修改|右侧仍显示/.test(d.innerText))
    return {
      emojiInModal: EMOJI.test(m.innerText || ''),
      alertSvgs: m.querySelectorAll('svg').length > 0,
      bodyEmoji: EMOJI.test(document.body.innerText || ''),
    }
  })()`)
  note(`弹窗内 Emoji 复查：${JSON.stringify(errIcon)}`)
  check('★ 错误提示条显示时，弹窗里也没有 Emoji 码点',
    errIcon.emojiInModal === false && errIcon.bodyEmoji === false, JSON.stringify(errIcon))

  console.log('\n[5] 自动保存 + 打开次数累加')
  const openCountBefore = await evaluate(`(() => {
    const m = document.querySelector('.mf-unfold')
    return m ? m.innerText : ''
  })()`)
  check('弹窗显示打开次数', /已打开\s*\d+\s*次/.test(openCountBefore),
    JSON.stringify(openCountBefore.slice(0, 60)))

  // 关闭弹窗
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.mf-unfold button')]
    const x = btns.find(b => b.textContent.trim() === '✕')
    if (x) x.click()
    return !!x
  })()`)
  await sleep(1500)

  const modalClosed = await evaluate(`!document.querySelector('.mf-unfold')`)
  check('弹窗已关闭', modalClosed === true)

  const persisted = await evaluate(`(() => {
    const raw = localStorage.getItem('mf:doc:' + JSON.parse(localStorage.getItem('mf:active')))
    return raw ? raw.length : 0
  })()`)
  check('文档已写入 LocalStorage（自动保存生效）', persisted > 100, `得到 ${persisted}`)

  const countSaved = await evaluate(`(() => {
    const id = JSON.parse(localStorage.getItem('mf:active'))
    const doc = JSON.parse(localStorage.getItem('mf:doc:' + id))
    let max = 0
    const walk = (n) => { if (n.fold) max = Math.max(max, n.fold.openCount); n.children.forEach(walk) }
    walk(doc.root)
    return max
  })()`)
  check('打开次数已累加（折角颜色分级的数据基础）', countSaved >= 1, `得到 ${countSaved}`)

  /* ================================================================== */
  /* 以下用例会改动数据，所以「只读」的导出检查必须排在前面              */
  /* ================================================================== */

  console.log('\n[6] 导出离线 HTML（断网可用的硬性要求）')
  // 拦截 URL.createObjectURL，把导出的 Blob 内容捞出来检查
  const exported = await evaluate(`(async () => {
    let captured = null
    const orig = URL.createObjectURL
    URL.createObjectURL = (blob) => { captured = blob; return orig.call(URL, blob) }

    const btn = [...document.querySelectorAll('button')].find(b => (b.title || '').includes('导出离线'))
    if (!btn) { URL.createObjectURL = orig; return { error: '找不到导出按钮' } }
    btn.click()

    // 等内联渲染所有流程图
    for (let i = 0; i < 40 && !captured; i++) await new Promise(r => setTimeout(r, 250))
    URL.createObjectURL = orig
    if (!captured) return { error: '未捕获到导出内容' }
    return { text: await captured.text(), type: captured.type, size: captured.size }
  })()`)

  if (exported.error) {
    check('导出离线 HTML', false, exported.error)
  } else {
    const html = exported.text
    console.log(`  导出体积：${(exported.size / 1024).toFixed(1)} KB`)
    check('导出成功且为 HTML', /^<!doctype html>/i.test(html))
    check('内联了流程图 SVG（不是引用外部资源）',
      (html.match(/<svg/g) || []).length > 0,
      `svg 数=${(html.match(/<svg/g) || []).length}`)
    check('折角按钮存在且可点击', /class="fold/.test(html) && /openModal/.test(html))
    check('包含折角交互脚本', /function openModal/.test(html) && /function closeModal/.test(html))
    check('样式已内联', /<style>/.test(html))
    check('无外部脚本引用（完全离线）', !/<script[^>]+src=/i.test(html))
    check('无外部样式引用（完全离线）', !/<link[^>]+stylesheet/i.test(html))
    check('无 CDN 依赖', !/https?:\/\/(cdn|unpkg|jsdelivr)/i.test(html))
    check('无图片外链', !/<img[^>]+src=["']https?:/i.test(html))
    check('保留了 mermaid 节点文字', html.includes('客户端') || html.includes('三次握手'))
    /*
     * 本轮新增：导出的离线 HTML 必须能**再导入回来**。
     * 光靠 HTML 结构回导会丢掉折角次数、mermaid 源码和汇聚连线，所以里面
     * 内嵌了一份我们自己的 JSON 载荷（type=application/json，不执行、不显示）。
     * 这里验载荷在场且是一份合法的单文档 JSON；「导回来是否等于原样」由
     * formats 套件在真实浏览器里跑完整往返。
     */
    check('★ 内嵌了可回导的 JSON 载荷（离线 HTML 能原样导回来）',
      /id="mf-outline"/.test(html) && /"format":\s*"mindfold-doc"/.test(html))
    check('★ 载荷所在标签 type=application/json（浏览器不会执行/显示它）',
      /<script[^>]*type="application\/json"[^>]*id="mf-outline"/.test(html))
    check('★ 节点带 data-mf-depth（载荷万一丢了还能按层级读回）', /data-mf-depth="1"/.test(html))
    check('html 标签带导出标记（导入时一眼认得出这是自家的离线 HTML）',
      /data-mindfold-export="offline-html"/.test(html))
  }

  console.log('\n[7] 跨文档持久化（防丢数据）')
  // 在文档 A 改一笔 → 900ms 内切到文档 B 再改一笔 → 两边的改动都必须落盘。
  // 这正是「只记最后一次参数」的普通防抖会静默丢数据的场景。
  const crossDoc = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const tabs = JSON.parse(localStorage.getItem('mf:tabs') || '[]')
    if (tabs.length < 2) return { error: '示例文档不足 2 个' }

    // 用原型上的 setter 改 React 受控 input 的值（直接赋值不会触发 onChange）
    const setInput = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }

    const renameFirstNode = async (text) => {
      const node = document.querySelector('[data-node-id]')
      if (!node) return 'no-node'
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await sleep(150)                       // 等 React 把 input 渲染出来
      const input = node.querySelector('input')
      if (!input) return 'no-input'
      setInput(input, text)
      await sleep(50)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await sleep(80)
      return 'ok'
    }

    const stamp = Date.now()
    const markerA = '跨文档A_' + stamp
    const markerB = '跨文档B_' + stamp

    // --- 文档 A ---
    const r1 = await renameFirstNode(markerA)

    // --- 不等防抖，立刻切到文档 B（关键：切换发生在 900ms 内）---
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, clientY: 0 }))
    await sleep(350)
    const tabB = document.querySelector('[data-tab-id="' + tabs[1] + '"]')
    if (!tabB) return { error: '找不到第二个标签页', r1 }
    tabB.click()
    await sleep(200)

    const r2 = await renameFirstNode(markerB)

    await sleep(1600) // 等防抖落盘

    const all = JSON.parse(localStorage.getItem('mf:tabs') || '[]')
      .map(id => localStorage.getItem('mf:doc:' + id) || '')
    return {
      r1, r2, markerA, markerB,
      aSaved: all.some(s => s.includes(markerA)),
      bSaved: all.some(s => s.includes(markerB)),
    }
  })()`)

  if (crossDoc.error) {
    check('跨文档持久化', false, JSON.stringify(crossDoc))
  } else {
    check('能通过双击改字', crossDoc.r1 === 'ok' && crossDoc.r2 === 'ok', JSON.stringify(crossDoc))
    check('文档 A 的修改已落盘', crossDoc.aSaved === true)
    check('文档 B 的修改已落盘（切页没有冲掉 A）', crossDoc.bSaved === true)
  }

  console.log('\n[8] 回收站（删除应是可恢复的）')
  const trashResult = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const tabsBefore = JSON.parse(localStorage.getItem('mf:tabs') || '[]')
    const victimId = tabsBefore[tabsBefore.length - 1]

    // 打开左侧大纲（文档列表在里面）
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 400 }))
    await sleep(500)

    const row = document.querySelector('[data-doc-id="' + victimId + '"]')
    if (!row) return { error: '找不到文档条目' }

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 500 }))
    await sleep(350)

    const del = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '删除文档')
    if (!del) return { error: '右键菜单里没有「删除文档」', menu: document.body.innerText.slice(0, 200) }
    del.click()
    await sleep(350)

    const ok = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '确定')
    if (!ok) return { error: '没有出现确认框' }
    ok.click()
    await sleep(700)

    const trash = JSON.parse(localStorage.getItem('mf:trash') || '[]')
    const tabsAfter = JSON.parse(localStorage.getItem('mf:tabs') || '[]')
    return {
      trashCount: trash.length,
      before: tabsBefore.length,
      after: tabsAfter.length,
      name: trash[0] && trash[0].doc && trash[0].doc.name,
      stillStored: !!localStorage.getItem('mf:doc:' + victimId),
    }
  })()`)

  if (trashResult.error) {
    check('回收站', false, JSON.stringify(trashResult))
  } else {
    check('删除后进入回收站（不是直接抹掉）', trashResult.trashCount >= 1, JSON.stringify(trashResult))
    check('回收站保留了文档内容与名称', !!trashResult.name, trashResult.name)
    check('标签页已关闭', trashResult.after === trashResult.before - 1,
      `${trashResult.before} → ${trashResult.after}`)
    check('原 doc: 键已移除', trashResult.stillStored === false)
  }

  console.log('\n[9] 从回收站恢复')
  const restoreResult = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const btn = [...document.querySelectorAll('button')].find(b => (b.title || '') === '回收站')
    if (!btn) return { error: '找不到回收站按钮' }
    btn.click()
    await sleep(450)

    const restore = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '恢复')
    if (!restore) return { error: '回收站面板里没有「恢复」按钮' }
    const before = JSON.parse(localStorage.getItem('mf:tabs') || '[]').length
    restore.click()
    await sleep(800)

    const trash = JSON.parse(localStorage.getItem('mf:trash') || '[]')
    const after = JSON.parse(localStorage.getItem('mf:tabs') || '[]').length
    const activeId = JSON.parse(localStorage.getItem('mf:active'))
    return {
      trashCount: trash.length, before, after,
      restoredVisible: !!document.querySelector('[data-node-id]'),
      activeDoc: !!localStorage.getItem('mf:doc:' + activeId),
    }
  })()`)

  if (restoreResult.error) {
    check('从回收站恢复', false, JSON.stringify(restoreResult))
  } else {
    check('恢复后该项离开回收站', restoreResult.trashCount === 0, JSON.stringify(restoreResult))
    check('恢复后重新出现在标签页', restoreResult.after === restoreResult.before + 1,
      `${restoreResult.before} → ${restoreResult.after}`)
    check('恢复后的文档能正常渲染', restoreResult.restoredVisible === true)
  }

  console.log('\n[10] 其余 PRD 交互')
  // 前面的用例删除/恢复过文档，当前激活的可能已经不是原来那份。
  // 这里先切回第一个标签页，让 10~13 的断言有确定的文档内容。
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const tabs = JSON.parse(localStorage.getItem('mf:tabs') || '[]')
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, clientY: 0 }))
    await sleep(400)
    const t = document.querySelector('[data-tab-id="' + tabs[0] + '"]')
    if (t) t.click()
    await sleep(700)
    return true
  })()`)

  const misc = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const out = {}

    // --- Ctrl+F 全局搜索 ---
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    await sleep(400)
    const searchInput = document.querySelector('input[placeholder*="搜索节点文字"]')
    out.searchOpened = !!searchInput
    if (searchInput) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(searchInput, '握手')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(400)
      out.searchHits = [...document.querySelectorAll('button')]
        .filter(b => b.textContent.includes('握手')).length
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(300)
    }
    out.searchClosed = !document.querySelector('input[placeholder*="搜索节点文字"]')

    // --- Ctrl+0 一键居中 ---
    // 注意：打开文档时已经自动 fit 过一次，直接按 Ctrl+0 看不出变化。
    // 所以先把画布拖走，再验证 Ctrl+0 能把它拉回居中。
    const wrap = document.querySelector('[data-node-id]').closest('div[style*="touch-action"]')
      || document.querySelector('[data-node-id]').parentElement.parentElement
    const mk = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 21, isPrimary: true,
    })
    wrap.dispatchEvent(mk('pointerdown', 700, 500))
    wrap.dispatchEvent(mk('pointermove', 1100, 700))
    wrap.dispatchEvent(mk('pointerup', 1100, 700))
    await sleep(500)
    const pannedX = document.querySelector('[data-node-id]').getBoundingClientRect().left

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))
    await sleep(700)
    const restoredX = document.querySelector('[data-node-id]').getBoundingClientRect().left
    out.centerMoved = Math.abs(restoredX - pannedX) > 20

    // --- 右键菜单 ---
    const node = document.querySelector('[data-node-id]')
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }))
    await sleep(300)
    const menuItems = [...document.querySelectorAll('button')].map(b => b.textContent.trim())
    out.hasAddFold = menuItems.some(t => t === '打上折角')
    out.hasBold = menuItems.some(t => t.includes('加粗'))
    out.hasItalic = menuItems.some(t => t.includes('斜体'))

    const bold = [...document.querySelectorAll('button')].find(b => b.textContent.includes('加粗'))
    if (bold) bold.click()
    await sleep(400)
    out.boldApplied = getComputedStyle(document.querySelector('[data-node-id]')).fontWeight

    return out
  })()`)

  check('Ctrl+F 打开全局搜索', misc.searchOpened === true)
  check('搜索能匹配到节点', misc.searchHits > 0, `命中 ${misc.searchHits}`)
  check('Esc 关闭搜索', misc.searchClosed === true)
  check('Ctrl+0 一键居中生效', misc.centerMoved === true)
  check('右键菜单含「打上折角」', misc.hasAddFold === true)
  check('右键菜单含「加粗」「斜体」', misc.hasBold === true && misc.hasItalic === true)
  check('加粗已应用到节点', misc.boldApplied === '600' || misc.boldApplied === 'bold', misc.boldApplied)

  console.log('\n[11] 打上折角 → 取消折角（含确认弹窗）')
  const foldFlow = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const id = JSON.parse(localStorage.getItem('mf:active'))
    const countFolds = () => {
      const d = JSON.parse(localStorage.getItem('mf:doc:' + id))
      let n = 0
      const walk = (x) => { if (x.fold) n++; x.children.forEach(walk) }
      walk(d.root)
      return n
    }
    const before = countFolds()

    const plain = [...document.querySelectorAll('[data-node-id]')].find(n => !n.querySelector('[data-fold-badge]'))
    if (!plain) return { error: '找不到无折角的节点' }
    plain.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }))
    await sleep(300)
    const add = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '打上折角')
    if (!add) return { error: '菜单里没有打上折角' }
    add.click()
    await sleep(1000)

    const afterAdd = countFolds()
    const hollowNow = document.querySelectorAll('[data-fold-kind="ring"]').length

    const target = [...document.querySelectorAll('[data-node-id]')].find(n => n.querySelector('[data-fold-badge]'))
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }))
    await sleep(300)
    const items = [...document.querySelectorAll('button')].map(b => b.textContent.trim())
    const cancelLabel = items.find(t => t === '取消折角')
    const remove = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '取消折角')
    if (remove) remove.click()
    await sleep(400)

    const dialogText = document.body.innerText
    const confirmBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '确定')
    const warned = dialogText.includes('流程图数据将被一并删除')
    const ok = !!confirmBtn
    if (confirmBtn) confirmBtn.click()
    await sleep(1000)

    return { before, afterAdd, hollowNow, cancelLabel, warned, ok, afterCancel: countFolds() }
  })()`)

  if (foldFlow.error) {
    check('折角增删流程', false, JSON.stringify(foldFlow))
  } else {
    check('右键「打上折角」后折角数 +1', foldFlow.afterAdd === foldFlow.before + 1,
      `${foldFlow.before} → ${foldFlow.afterAdd}`)
    check('新折角是空心虚线样式', foldFlow.hollowNow > 0, `空心折角 ${foldFlow.hollowNow}`)
    check('已有折角时菜单变为「取消折角」', foldFlow.cancelLabel === '取消折角')
    check('取消折角弹出确认框', foldFlow.ok === true)
    check('确认框说明会删除流程图数据', foldFlow.warned === true)
    check('确认后折角数 -1', foldFlow.afterCancel === foldFlow.before,
      `${foldFlow.afterAdd} → ${foldFlow.afterCancel}`)
  }

  console.log('\n[12] 重置熟悉度 + 颜色分级')
  const fam = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const id = JSON.parse(localStorage.getItem('mf:active'))
    const readCounts = () => {
      const d = JSON.parse(localStorage.getItem('mf:doc:' + id))
      const arr = []
      const walk = (x) => { if (x.fold) arr.push(x.fold.openCount); x.children.forEach(walk) }
      walk(d.root)
      return arr
    }
    const solid = [...document.querySelectorAll('[data-node-id]')]
      .find(n => n.querySelector('[data-fold-kind="num"], [data-fold-kind="dot"]'))
    if (!solid) return { error: '找不到实心折角' }

    const beforeOpen = Math.max(...readCounts())
    solid.querySelector('[data-fold-badge]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(2600)
    // openFold 走 persistNow，点开即落盘，可以直接读回
    const afterOpen = Math.max(...readCounts())

    const resetBtn = [...document.querySelectorAll('.mf-unfold button')]
      .find(b => b.textContent.trim() === '重置熟悉度')
    if (!resetBtn) return { error: '弹窗里没有重置熟悉度按钮' }
    resetBtn.click()
    await sleep(300)
    const flashed = !!document.querySelector('.mf-flash')

    const closeBtn = [...document.querySelectorAll('.mf-unfold button')].find(b => b.textContent.trim() === '✕')
    if (closeBtn) closeBtn.click()
    await sleep(1600)

    return { beforeOpen, afterOpen, maxAfterReset: Math.max(...readCounts()), flashed }
  })()`)

  if (fam.error) {
    check('重置熟悉度', false, JSON.stringify(fam))
  } else {
    check('打开折角后 openCount +1', fam.afterOpen === fam.beforeOpen + 1,
      `${fam.beforeOpen} → ${fam.afterOpen}`)
    check('重置熟悉度后归零', fam.maxAfterReset === 0, `最大 ${fam.maxAfterReset}`)
    check('重置按钮有闪烁反馈', fam.flashed === true)
  }

  console.log('\n[13] 长文本气泡：两行截断 + 智能避让屏幕边缘')
  const tip = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))

    // 示例文档里的节点都没超过两行，所以先造一个「一定被截断」的长节点
    const node = document.querySelector('[data-node-id]')
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await sleep(250)
    const input = node.querySelector('input')
    if (!input) return { error: '双击没有进入编辑态' }
    const long = '这是一段非常长的节点文字用来验证两行截断与悬停气泡的边缘避让行为是否正确工作'
    const setInput = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setInput(input, long)
    await sleep(100)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await sleep(700)

    const target = document.querySelector('[data-node-id]')
    const tx = target.querySelector('[data-text]')
    const truncated = tx.scrollHeight > tx.clientHeight + 1

    const hover = async () => {
      target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await sleep(600)
      const bubbles = [...document.querySelectorAll('body > div')].filter(d =>
        typeof d.className === 'string' && d.className.includes('shadow-card') &&
        d.className.includes('fixed') && d.className.includes('pointer-events-none'))
      if (!bubbles.length) return null
      const r = bubbles[0].getBoundingClientRect()
      return {
        text: bubbles[0].textContent.trim().slice(0, 16),
        left: Math.round(r.left), right: Math.round(r.right),
        top: Math.round(r.top), bottom: Math.round(r.bottom),
      }
    }

    const first = await hover()
    target.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    await sleep(300)

    // 把画布往右拖，让这个长节点贴近屏幕右缘，再看气泡会不会溢出
    const wrap = document.querySelector('.mf-radar, [data-node-id]').closest('div[style*="touch-action"]')
      || document.querySelector('[data-node-id]').parentElement.parentElement
    const before = target.getBoundingClientRect()
    const dx = Math.round(window.innerWidth - before.right - 24)   // 推到距右缘 24px
    const mk = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true,
    })
    wrap.dispatchEvent(mk('pointerdown', 300, 400))
    wrap.dispatchEvent(mk('pointermove', 300 + dx, 400))
    wrap.dispatchEvent(mk('pointerup', 300 + dx, 400))
    await sleep(600)

    const afterPan = target.getBoundingClientRect()
    const second = await hover()

    return {
      truncated, first, second,
      vw: window.innerWidth, vh: window.innerHeight,
      nodeRight: Math.round(afterPan.right),
      panned: Math.abs(dx) > 20,
    }
  })()`)

  if (tip.error) {
    check('长文本气泡', false, tip.error)
  } else {
    check('超过两行的文本被截断', tip.truncated === true)
    check('悬停出现全文气泡', !!tip.first?.text, tip.first?.text)
    check('气泡未超出屏幕（默认位置）',
      tip.first.left >= 0 && tip.first.right <= tip.vw && tip.first.top >= 0 && tip.first.bottom <= tip.vh,
      JSON.stringify(tip.first))
    check('画布平移成功（节点已贴近右缘）', tip.panned === true, `nodeRight=${tip.nodeRight} vw=${tip.vw}`)
    check('节点贴近右缘时，气泡仍被拉回屏幕内',
      tip.second && tip.second.left >= 0 && tip.second.right <= tip.vw,
      JSON.stringify(tip.second))
    check('气泡上下也未溢出',
      tip.second && tip.second.top >= 0 && tip.second.bottom <= tip.vh,
      JSON.stringify(tip.second))
  }

  console.log('\n[14] 节点拖拽改变层级')
  const dragTest = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const id = JSON.parse(localStorage.getItem('mf:active'))
    const readTree = () => JSON.parse(localStorage.getItem('mf:doc:' + id)).root
    const parentOf = (root, targetId) => {
      let hit = null
      const walk = (n) => { if (n.children.some(c => c.id === targetId)) hit = n; n.children.forEach(walk) }
      walk(root)
      return hit
    }
    const depthOf = (root, targetId) => {
      let d = -1
      const dfs = (n, k) => { if (n.id === targetId) d = k; n.children.forEach(c => dfs(c, k + 1)) }
      dfs(root, 0)
      return d
    }

    // 找两个「不同分支、且都在视口内」的节点：把 A 拖到 B 上，A 应成为 B 的子节点。
    // 必须在视口内，否则鼠标坐标落在别的节点上，落点就不是预期目标了。
    const all = [...document.querySelectorAll('[data-node-id]')]
      .map(el => ({ el, id: el.dataset.nodeId }))
    const inView = (el) => {
      const r = el.getBoundingClientRect()
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    }
    const nodes = all.filter(n => inView(n.el))
    const root0 = readTree()
    const textOf = (root, id) => {
      let t = null
      const walk = (n) => { if (n.id === id) t = n.text; n.children.forEach(walk) }
      walk(root)
      return t
    }
    let from = null, to = null
    for (const a of nodes) {
      for (const b of nodes) {
        if (a.id === b.id) continue
        const pa = parentOf(root0, a.id), pb = parentOf(root0, b.id)
        if (!pa || !pb) continue                       // 跳过根
        if (pa.id === pb.id) continue                  // 必须是不同分支
        if (a.el.contains(b.el)) continue
        from = a; to = b; break
      }
      if (from) break
    }
    if (!from || !to) return { error: '找不到可拖拽的两个可见节点', visible: nodes.length, total: all.length }

    const beforeParent = parentOf(root0, from.id).id
    const fromRect = from.el.getBoundingClientRect()
    const toRect = to.el.getBoundingClientRect()

    const mk = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, isPrimary: true, pointerType: 'mouse',
    })

    // 防误触闸门：位移必须 > 6px，或按住 > 180ms，所以这里要真的移动足够距离。
    // 注意落点要用节点**实际渲染出来的**中心：fitView 之后 zoom 常只有 0.7，
    // 节点高度不是 34px 而是 23px 左右，写死 +17 会落进「下方插入」区间。
    const fromCy = fromRect.y + fromRect.height / 2
    const toCx = toRect.x + toRect.width / 2
    const toCy = toRect.y + toRect.height / 2

    from.el.dispatchEvent(mk('pointerdown', fromRect.x + 20, fromCy))
    await sleep(240)
    from.el.dispatchEvent(mk('pointermove', fromRect.x + 40, fromCy))
    await sleep(60)
    from.el.dispatchEvent(mk('pointermove', toCx, toCy))
    await sleep(150)
    from.el.dispatchEvent(mk('pointerup', toCx, toCy))
    await sleep(1400)   // 自动保存是 900ms 防抖，必须等它落盘再读

    const root1 = readTree()
    const afterParent = parentOf(root1, from.id)
    return {
      moved: !!afterParent && afterParent.id === to.id,
      fromId: from.id, toId: to.id,
      fromText: textOf(root0, from.id), toText: textOf(root0, to.id),
      afterText: afterParent ? textOf(root1, afterParent.id) : null,
      beforeText: textOf(root0, beforeParent),
      beforeParent, afterParent: afterParent && afterParent.id,
    }
  })()`)

  if (dragTest.error) {
    check('节点拖拽改层级', false, JSON.stringify(dragTest))
  } else {
    check('拖拽后节点挂到目标节点下', dragTest.moved === true,
      `把「${dragTest.fromText}」拖到「${dragTest.toText}」上，` +
      `父节点：${dragTest.beforeText} → ${dragTest.afterText}`)
  }

  // 防误触：单纯点一下（不移动）不应改变层级
  const noAccident = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const id = JSON.parse(localStorage.getItem('mf:active'))
    const readTree = () => JSON.parse(localStorage.getItem('mf:doc:' + id)).root
    const parentOf = (root, targetId) => {
      let hit = null
      const walk = (n) => { if (n.children.some(c => c.id === targetId)) hit = n; n.children.forEach(walk) }
      walk(root)
      return hit
    }
    const before = JSON.stringify(readTree())
    const el = [...document.querySelectorAll('[data-node-id]')].find(n => {
      const r = parentOf(readTree(), n.dataset.nodeId); return r && r.id !== readTree().id
    })
    if (!el) return { error: '找不到节点' }
    const r = el.getBoundingClientRect()
    const mk = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 8, isPrimary: true, pointerType: 'mouse',
    })
    // 按下后立刻抬起，且不移动 —— 应当只选中，不改层级
    el.dispatchEvent(mk('pointerdown', r.x + 20, r.y + 17))
    el.dispatchEvent(mk('pointerup', r.x + 20, r.y + 17))
    await sleep(600)
    return { unchanged: JSON.stringify(readTree()) === before }
  })()`)
  check('轻点节点不会误触拖拽（防误触闸门生效）', noAccident.unchanged === true,
    JSON.stringify(noAccident))

  console.log('\n[14b] 拖拽交互反馈（抓手 / 幽灵 / 引导线 / 吸附）')
  const dragFx = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const out = {}
    const all = [...document.querySelectorAll('[data-node-id]')]
    const inView = (el) => { const r = el.getBoundingClientRect()
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }
    const nodes = all.filter(inView)
    if (nodes.length < 4) return { error: '视口内节点不足' }
    const from = nodes[1], to = nodes[nodes.length - 1]
    const fr = from.getBoundingClientRect(), tr = to.getBoundingClientRect()

    // 1) 空闲时光标：张开的小手
    out.cursorIdle = getComputedStyle(from).cursor

    const mk = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 61, isPrimary: true, pointerType: 'mouse',
    })

    from.dispatchEvent(mk('pointerdown', fr.x + 20, fr.y + fr.height / 2))
    await sleep(240)
    from.dispatchEvent(mk('pointermove', fr.x + 40, fr.y + fr.height / 2))
    await sleep(60)

    // 拖到目标「中间」→ 判定为子节点
    const cursorX = tr.x + tr.width / 2
    const cursorY = tr.y + tr.height / 2
    from.dispatchEvent(mk('pointermove', cursorX, cursorY))
    await sleep(220)

    // 2) 拖拽中光标：攥紧的小手
    out.cursorDragging = getComputedStyle(document.querySelector('[data-node-id]').parentElement.parentElement).cursor

    // 3) 幽灵
    const ghost = document.querySelector('[data-drag-ghost]')
    if (ghost) {
      const g = ghost.firstElementChild
      const gs = getComputedStyle(g), gr = g.getBoundingClientRect()
      out.ghost = {
        opacity: gs.opacity, shadow: gs.boxShadow, pointerEvents: gs.pointerEvents,
        text: g.textContent.trim(),
        // 幽灵用 translate(-16px, -50%)：竖直居中于光标，水平方向光标落在它内部
        followsCursor:
          cursorX >= gr.left && cursorX <= gr.right + 20 &&
          Math.abs(cursorY - (gr.top + gr.height / 2)) < 10,
      }
    }
    // 4) 原节点变淡（留下「从这里来」的影子）
    out.sourceOpacity = getComputedStyle(from).opacity

    // 5) 中间区域的反馈是「目标节点整体高亮」，不是竖线
    out.childHighlight = !!document.querySelector('[data-drop-highlight]')
    out.childLine = !!document.querySelector('.mf-drop-line')

    // 6) 不能拖到自己身上（此时不应有引导线，也不应有高亮）
    from.dispatchEvent(mk('pointermove', fr.x + 20, fr.y + fr.height / 2))
    await sleep(200)
    out.lineOnSelf = !!document.querySelector('.mf-drop-line')
    out.highlightOnSelf = !!document.querySelector('[data-drop-highlight]')

    // 7) 没有任何虚线（旧的虚线引导线已删除）
    out.anyDashedSvg = [...document.querySelectorAll('svg *')].some(el => {
      const d = getComputedStyle(el).strokeDasharray
      return d && d !== 'none'
    })

    // 8) 松手：幽灵与引导线都要消失
    from.dispatchEvent(mk('pointermove', cursorX, cursorY))
    await sleep(150)
    from.dispatchEvent(mk('pointerup', cursorX, cursorY))
    await sleep(150)
    out.ghostAfter = !!document.querySelector('[data-drag-ghost]')
    out.lineAfter = !!document.querySelector('.mf-drop-line')
    out.highlightAfter = !!document.querySelector('[data-drop-highlight]')
    await sleep(900)

    // 9) 吸附动画：left/top 有 0.2s 过渡
    const cs = getComputedStyle(document.querySelector('[data-node-id]'))
    out.transition = cs.transitionProperty
    out.duration = cs.transitionDuration

    return out
  })()`)

  if (dragFx.error) {
    check('拖拽交互反馈', false, JSON.stringify(dragFx))
  } else {
    check('空闲时节点光标是 grab（张开的小手）', dragFx.cursorIdle === 'grab', dragFx.cursorIdle)
    check('拖拽中光标是 grabbing（攥紧的小手）', dragFx.cursorDragging === 'grabbing', dragFx.cursorDragging)
    check('拖拽中出现幽灵节点', !!dragFx.ghost, JSON.stringify(dragFx.ghost))
    check('幽灵是半透明（opacity 0.5）', dragFx.ghost?.opacity === '0.5', dragFx.ghost?.opacity)
    check('幽灵带浅色阴影（看起来飘起来）',
      !!dragFx.ghost && dragFx.ghost.shadow !== 'none', dragFx.ghost?.shadow)
    check('幽灵跟随鼠标', dragFx.ghost?.followsCursor === true)
    check('幽灵不拦截鼠标事件', dragFx.ghost?.pointerEvents === 'none')
    check('原节点变淡，表示「从这里拖走」',
      parseFloat(dragFx.sourceOpacity) < 0.5, dragFx.sourceOpacity)
    check('拖到目标中间 → 目标节点整体高亮（不是竖线）',
      dragFx.childHighlight === true && dragFx.childLine === false,
      `highlight=${dragFx.childHighlight} line=${dragFx.childLine}`)
    check('拖到自己身上不显示任何落点反馈',
      dragFx.lineOnSelf === false && dragFx.highlightOnSelf === false)
    check('画布上没有任何虚线（旧引导线已删除）', dragFx.anyDashedSvg === false)
    check('松手后幽灵消失', dragFx.ghostAfter === false)
    check('松手后引导线与高亮都消失',
      dragFx.lineAfter === false && dragFx.highlightAfter === false)
    check('节点有 left/top 过渡（吸附动画）',
      /left/.test(dragFx.transition) && /top/.test(dragFx.transition),
      dragFx.transition)
    check('过渡时长 0.2s', /0\.2s/.test(dragFx.duration), dragFx.duration)
  }

  console.log('\n[14c] 三个放置区域（上/中/下）与插入位置')
  const zones = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const id = JSON.parse(localStorage.getItem('mf:active'))
    const read = () => JSON.parse(localStorage.getItem('mf:doc:' + id)).root
    const parentOf = (tree, tid) => { let hit = null; const w = n => { if (n.children.some(c => c.id === tid)) hit = n; n.children.forEach(w) }; w(tree); return hit }
    const idxOf = (tree, tid) => { const p = parentOf(tree, tid); return p ? p.children.findIndex(c => c.id === tid) : -1 }

    const inView = el => { const r = el.getBoundingClientRect()
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }
    const vis = [...document.querySelectorAll('[data-node-id]')].filter(inView)

    // 找同一父节点下的两个可见兄弟（这样 before/after 才有意义）
    const tree0 = read()
    let from = null, to = null
    for (const a of vis) {
      for (const b of vis) {
        if (a === b) continue
        const pa = parentOf(tree0, a.dataset.nodeId), pb = parentOf(tree0, b.dataset.nodeId)
        if (!pa || !pb || pa.id !== pb.id) continue
        if (pa.children.length < 2) continue
        from = a; to = b; break
      }
      if (from) break
    }
    if (!from || !to) return { error: '找不到同父的两个可见节点' }

    const mk = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 81, isPrimary: true, pointerType: 'mouse',
    })

    /** 拖到指定屏幕坐标，返回观察到的反馈，然后松手 */
    const dragTo = async (x, y) => {
      const r = to.getBoundingClientRect()
      from.dispatchEvent(mk('pointerdown', r.x + 10, r.y + r.height / 2))
      await sleep(230)
      from.dispatchEvent(mk('pointermove', r.x + 30, r.y + r.height / 2))
      await sleep(50)
      from.dispatchEvent(mk('pointermove', x, y))
      await sleep(200)
      const line = document.querySelector('.mf-drop-line line')
      const hl = document.querySelector('[data-drop-highlight]')
      const feedback = line ? 'line' : (hl ? 'highlight' : 'none')
      const detail = line ? {
        stroke: getComputedStyle(line).stroke,
        width: getComputedStyle(line).strokeWidth,
        dash: getComputedStyle(line).strokeDasharray,
        horizontal: line.getAttribute('y1') === line.getAttribute('y2'),
        rectTop: line.getBoundingClientRect().top,
      } : null
      const targetRect = to.getBoundingClientRect()
      from.dispatchEvent(mk('pointerup', x, y))
      await sleep(1300)
      const t1 = read()
      return {
        feedback, detail, targetTop: targetRect.top, targetBottom: targetRect.bottom,
        fromIdx: idxOf(t1, from.dataset.nodeId),
        toIdx: idxOf(t1, to.dataset.nodeId),
        sameParent: (parentOf(t1, from.dataset.nodeId) || {}).id === (parentOf(t1, to.dataset.nodeId) || {}).id,
        fromStillExists: !!parentOf(t1, from.dataset.nodeId),
      }
    }

    const out = { fromText: from.textContent.trim().slice(0, 12), toText: to.textContent.trim().slice(0, 12) }

    // ① 上边缘 15% → 插到目标前面
    {
      const r = to.getBoundingClientRect()
      out.top = await dragTo(r.x + r.width / 2, r.y + r.height * 0.15)
      out.topBefore = out.top.fromIdx === out.top.toIdx - 1
    }
    // ② 下边缘 85% → 插到目标后面
    {
      const r = to.getBoundingClientRect()
      out.bottom = await dragTo(r.x + r.width / 2, r.y + r.height * 0.85)
      out.bottomAfter = out.bottom.fromIdx === out.bottom.toIdx + 1
    }
    // ③ 中间 50% → 变成子节点（反馈应该是高亮框而不是竖线）
    {
      const r = to.getBoundingClientRect()
      out.mid = await dragTo(r.x + r.width / 2, r.y + r.height * 0.5)
      out.midChild = out.mid.sameParent === false
    }
    // ④ 回归：瞄准目标**上方的间隙**（指针完全不在节点框内）
    //    这正是之前「无法插到上面」的场景 —— 旧实现要求指针严格落在框内，
    //    稍微偏一点就完全找不到落点。
    {
      const r = to.getBoundingClientRect()
      out.gapAbove = await dragTo(r.x + r.width / 2, r.y - 6)
      out.gapAboveBefore = out.gapAbove.fromIdx === out.gapAbove.toIdx - 1
    }

    return out
  })()`)

  if (zones.error) {
    check('三个放置区域', false, JSON.stringify(zones))
  } else {
    console.log(`  拖「${zones.fromText}」→「${zones.toText}」`)
    check('上边缘 30% → 插到目标前面（同级上方）',
      zones.topBefore === true,
      `fromIdx=${zones.top.fromIdx} toIdx=${zones.top.toIdx}`)
    check('下边缘 30% → 插到目标后面（同级下方）',
      zones.bottomAfter === true,
      `fromIdx=${zones.bottom.fromIdx} toIdx=${zones.bottom.toIdx}`)
    check('中间 40% → 变成目标节点的子节点',
      zones.midChild === true, `sameParent=${zones.mid.sameParent}`)
    check('中间区域的反馈是「节点高亮框」而不是竖线',
      zones.mid.feedback === 'highlight', zones.mid.feedback)
    check('上/下边缘的反馈是横线',
      zones.top.feedback === 'line' && zones.bottom.feedback === 'line',
      `${zones.top.feedback} / ${zones.bottom.feedback}`)
    check('引导线是 2px 蓝色实线',
      zones.top.detail?.stroke === 'rgb(59, 130, 246)' &&
      zones.top.detail?.width === '2px' &&
      zones.top.detail?.dash === 'none',
      JSON.stringify(zones.top.detail))
    check('上边缘的横线画在目标上方', zones.top.detail?.rectTop < zones.top.targetTop + 1,
      `line=${zones.top.detail?.rectTop} target=${zones.top.targetTop}`)
    check('下边缘的横线画在目标下方', zones.bottom.detail?.rectTop > zones.bottom.targetBottom - 2,
      `line=${zones.bottom.detail?.rectTop} target=${zones.bottom.targetBottom}`)
    check('瞄准目标上方的间隙也能插到前面（回归）',
      zones.gapAboveBefore === true,
      `fromIdx=${zones.gapAbove.fromIdx} toIdx=${zones.gapAbove.toIdx}`)
    check('所有拖拽都没有丢失节点',
      [zones.top, zones.bottom, zones.mid, zones.gapAbove].every(z => z.fromStillExists === true))
  }

  console.log('\n[15] 快捷键 Tab / Enter / Delete / Ctrl+S')
  const keys = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const id = JSON.parse(localStorage.getItem('mf:active'))
    const count = () => {
      let n = 0
      const walk = (x) => { n++; x.children.forEach(walk) }
      walk(JSON.parse(localStorage.getItem('mf:doc:' + id)).root)
      return n
    }
    const out = {}
    const clickNode = (i) => {
      const els = [...document.querySelectorAll('[data-node-id]')]
      const el = els[i]
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cx = r.x + 20, cy = r.y + 17
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, button: 0, pointerId: 11, isPrimary: true }))
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy, button: 0, pointerId: 11, isPrimary: true }))
      // 真实浏览器在 pointerup 之后还会派发 click，选中走的是 onClick
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }))
      return el.dataset.nodeId
    }
    const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    // 退出行内编辑：不能用 input.blur() —— 无焦点窗口里 blur 不会触发 React 的 onBlur，
    // editingId 会一直留着，全局 Enter 就被 !editingId 挡掉了。
    // 改成对输入框按 Escape（MindNode 自己处理，直接提交并退出编辑态）。
    const exitEdit = () => {
      const input = document.querySelector('[data-node-id] input')
      if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }

    // 选中一个非根节点
    clickNode(1)
    await sleep(400)
    const n0 = count()

    press('Tab')
    await sleep(1400)   // 等自动保存（900ms 防抖）落盘
    out.tabAdded = count() - n0
    exitEdit()
    await sleep(400)

    const n1 = count()
    press('Enter')
    await sleep(1400)
    out.enterAdded = count() - n1
    exitEdit()
    await sleep(400)

    // 选中刚生成的节点并删除
    const n2 = count()
    clickNode(1)
    await sleep(400)
    press('Delete')
    await sleep(1400)
    out.deleteRemoved = n2 - count()

    // Ctrl+S 应写入 localStorage 且不报错
    const ctrlS = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(ctrlS)
    await sleep(700)
    out.savedExists = !!localStorage.getItem('mf:doc:' + id)
    out.toastShown = document.body.innerText.includes('已保存')
    return out
  })()`)

  check('Tab 生成子节点', keys.tabAdded === 1, `增加 ${keys.tabAdded}`)
  check('Enter 生成同级节点', keys.enterAdded === 1, `增加 ${keys.enterAdded}`)
  check('Delete 删除选中节点', keys.deleteRemoved === 1, `减少 ${keys.deleteRemoved}`)
  check('Ctrl+S 保存并提示', keys.savedExists === true && keys.toastShown === true,
    JSON.stringify(keys))

  console.log('\n[16] 导出 PDF（只有导图 + 流程图）')
  const pdfTest = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    // 先切到夜间主题，验证 PDF 依然用白色渲染
    const dark = [...document.querySelectorAll('button')].find(b => (b.title || '') === '夜间')
    if (dark) dark.click()
    await sleep(900)

    // 拦截 window.open，把打印视图的 HTML 捞出来。
    // 注意 exporter 里是 w.document.write(...)，mock 必须提供 document。
    let captured = null
    const orig = window.open
    window.open = () => {
      const doc = { _html: '', write(h) { this._html += h }, close() {} }
      captured = doc
      return { document: doc, close() {} }
    }
    const btn = [...document.querySelectorAll('button')].find(b => (b.title || '').includes('导出 PDF'))
    if (!btn) { window.open = orig; return { error: '找不到导出 PDF 按钮' } }
    btn.click()
    for (let i = 0; i < 40 && !captured; i++) await sleep(250)
    window.open = orig
    await sleep(300)
    if (!captured) return { error: '没有生成打印视图' }

    const html = captured._html
    // 回到纯白主题
    const light = [...document.querySelectorAll('button')].find(b => (b.title || '') === '纯白')
    if (light) light.click()
    await sleep(600)

    /*
     * 打印视图 = 「导图本体 + 每个折角的流程图」，不能再出现旧版那套
     * 「折角知识点列表」（序号 / 已打开次数 / 页眉副标题 / 无流程图占位）。
     * 这里直接把打印出来的节点和**画布上的节点**对一遍 —— 那是「印的就是
     * 屏幕上这张导图」最直接的证据。
     */
    const canvasIds = [...document.querySelectorAll('[data-node-id]')].map((n) => n.dataset.nodeId)
    const printIds = [...new Set((html.match(/data-node-id="[^"]+"/g) || []).map((s) => s.slice(14, -1)))]

    /*
     * 把打印视图真的渲染出来量一遍几何。
     * 只检查 HTML 字符串是不够的 —— 「图有没有压住节点」「有没有被页边界裁掉」
     * 这类问题只有在真实排版之后才看得见。
     * 必须去掉自动打印脚本：iframe 里 window.print() 会弹系统对话框。
     */
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;height:900px;border:0'
    document.body.appendChild(frame)
    await new Promise((res) => { frame.onload = res; frame.srcdoc = html.replace(/<script>[\\s\\S]*?<\\/script>/g, '') })
    await sleep(400)

    const idoc = frame.contentDocument
    const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } }
    const cross = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5
    const nRects = [...idoc.querySelectorAll('.mf-print-node')].map(rect)
    const chartEls = [...idoc.querySelectorAll('.mf-print-chart')]
    const cRects = chartEls.map(rect)

    let chartOnNode = 0
    for (const c of cRects) for (const n of nRects) if (cross(c, n)) chartOnNode++
    let chartOnChart = 0
    for (let i = 0; i < cRects.length; i++) {
      for (let j = i + 1; j < cRects.length; j++) if (cross(cRects[i], cRects[j])) chartOnChart++
    }
    // 流程图有没有真的撑满它的盒子（mermaid 的内联 max-width 没清掉就会缩成一小团）
    const fills = chartEls.map((box) => {
      const s = box.querySelector('svg')
      if (!s) return 0
      const br = box.getBoundingClientRect()
      const sr = s.getBoundingClientRect()
      if (!(br.width > 0 && br.height > 0)) return 0
      return Math.min(sr.width / br.width, sr.height / br.height)
    })
    /*
     * 被页边界**切了一半**的内容（分页算错就会在这里露出来）。
     * 注意不能写成「必须在页面框内」：每页会额外画出落在边界外 80px 余量里的
     * 盒子（这样切线上正好压着的东西不会缺一块），那些盒子本来就在框外、
     * 由 overflow:hidden 挡掉，下一页会完整画一遍。
     * 所以正确的判据是：每个盒子要么完整在某页内、要么完整在某页外，不许一半一半；
     * 而且每个盒子至少要完整落在某一页里（否则就是丢了）。
     */
    const pageRects = [...idoc.querySelectorAll('.page')].map(rect)
    const inside = (r, p) => r.l >= p.l - 1 && r.r <= p.r + 1 && r.t >= p.t - 1 && r.b <= p.b + 1
    const els = [...idoc.querySelectorAll('.mf-print-node, .mf-print-chart')]
    let partial = 0
    let orphan = 0
    for (const el of els) {
      const r = rect(el)
      if (!pageRects.some((p) => inside(r, p))) {
        if (pageRects.some((p) => cross(r, p))) partial++
        else orphan++
      }
    }
    const pageCount = pageRects.length
    /*
     * 先别删这个 iframe：下面还要把页面切成「打印媒体」再量一次 ——
     * 右上角那颗打印按钮必须只存在于屏幕上，纸上多一颗按钮就是每页多一块脏东西。
     */
    frame.id = 'mf-print-probe'

    /*
     * 右上角那颗按钮。用户要求「保存或打印搞一个按钮就行了，放在右上角，字去掉，
     * 保持干净」，所以这里量的是三件事：图标在不在、里面有没有字、是不是真的
     * 钉在右上角。还有一件更重要的：它是 position:fixed，**不参与排版**，
     * 所以 body 不该有任何让位内边距（上一版那条工具栏就是因为内边距和实际高度
     * 对不上，压住第一页 4px）。
     */
    const fabEl = idoc.querySelector('.mf-print-fab')
    const fabStyle = fabEl ? idoc.defaultView.getComputedStyle(fabEl) : null
    const fabBox = fabEl ? rect(fabEl) : null
    /*
     * 用 clientWidth 而不是 innerWidth：打印视图是一摞固定高度的页，一定带竖向
     * 滚动条，而 innerWidth 把滚动条那 15px 也算进去了 —— 拿它算「距右边多少」
     * 会得到 27px 这种假失败（css 里的 right:12px 是相对**内容区**算的）。
     */
    const vw = idoc.documentElement.clientWidth
    // 按钮压住第一页的导图，就等于预览时看不见自己印的是什么
    const pageTop = pageRects[0] ? pageRects[0].t : null
    const fabCoversPage = fabBox && pageRects[0] ? cross(fabBox, pageRects[0]) : false

    return {
      len: html.length,
      whiteBg: /background:#fff/.test(html),
      inlineSvg: (html.match(/<svg/g) || []).length,
      noExternal: !/<script[^>]+src=/i.test(html) && !/<link[^>]+stylesheet/i.test(html),
      // 夜间主题下渲染的图会带深色背景，白色主题不会
      hasDarkBg: /#111318|#1e293b|#171a21/i.test(html),
      // 默认**不**自动弹打印对话框；打印由页面上那颗按钮触发
      hasAutoPrint: /window\\.onload/.test(html),
      hasFab: /class="mf-print-fab"[^>]*onclick="window\\.print\\(\\)"/.test(html),
      hasOldBar: /mf-print-bar/.test(html),
      landscape: /@page\\{size:A4 landscape/.test(html),
      nodeCount: printIds.length,
      canvasNodeCount: canvasIds.length,
      sameNodes: canvasIds.length > 0 && canvasIds.every((id) => printIds.includes(id)),
      chartCount: (html.match(/class="mf-print-chart"/g) || []).length,
      leaderCount: (html.match(/class="mf-print-leader"/g) || []).length,
      hasFoldBadge: html.includes('data-fold-badge') || /class="badge/.test(html),
      hasOldList: /class="row"/.test(html) || /class="idx"/.test(html),
      hasOpenCount: html.includes('已打开'),
      hasPlaceholder: html.includes('无流程图'),
      hasSubtitle: html.includes('折角知识点'),
      renderedPages: pageCount,
      chartOnNode,
      chartOnChart,
      minFill: fills.length ? Math.min(...fills) : 0,
      partial,
      orphan,
      boxCount: els.length,
      fabOnScreen: !!fabEl && fabStyle.display !== 'none',
      fabDisplay: fabStyle ? fabStyle.display : '(缺元素)',
      fabPosition: fabStyle ? fabStyle.position : '(缺元素)',
      fabIcon: !!fabEl && !!fabEl.querySelector('svg'),
      fabText: fabEl ? fabEl.textContent.trim() : '(缺元素)',
      fabTitle: fabEl ? (fabEl.getAttribute('title') || '') : '',
      fabBox,
      fabRight: fabBox ? Math.round(vw - fabBox.r) : null,
      fabTop: fabBox ? Math.round(fabBox.t) : null,
      fabCoversPage,
      vw,
      pageTop,
      bodyPadTop: parseFloat(idoc.defaultView.getComputedStyle(idoc.body).paddingTop) || 0,
    }
  })()`)

  if (pdfTest.error) {
    check('导出 PDF', false, JSON.stringify(pdfTest))
  } else {
    console.log(`  打印视图体积：${(pdfTest.len / 1024).toFixed(1)} KB，`
      + `${pdfTest.nodeCount} 个节点 / ${pdfTest.chartCount} 张流程图 / ${pdfTest.leaderCount} 条引线`)
    note(`打印按钮 ${pdfTest.fabDisplay} ${pdfTest.fabPosition}`
      + ` · 距右 ${pdfTest.fabRight}px / 距上 ${pdfTest.fabTop}px`
      + ` · 图标 ${pdfTest.fabIcon ? '有' : '无'} / 文字 ${JSON.stringify(pdfTest.fabText)}`)
    check('生成了打印视图', pdfTest.len > 500)
    check('印的是画布上那张导图（打印出的节点 = 画布上的节点）',
      pdfTest.sameNodes === true,
      `画布 ${pdfTest.canvasNodeCount} 个 / 打印 ${pdfTest.nodeCount} 个`)
    check('流程图按节点贴在导图里（图数 > 0 且引线数 = 图数）',
      pdfTest.chartCount > 0 && pdfTest.leaderCount === pdfTest.chartCount,
      `${pdfTest.chartCount} 张图 / ${pdfTest.leaderCount} 条引线`)
    console.log('  ── 不该出现的东西 ──')
    check('没有折角角标', pdfTest.hasFoldBadge === false)
    check('没有旧版列表行/序号', pdfTest.hasOldList === false)
    check('没有「已打开 N 次」', pdfTest.hasOpenCount === false)
    check('没有「无流程图」占位', pdfTest.hasPlaceholder === false)
    check('没有「折角知识点列表」副标题', pdfTest.hasSubtitle === false)
    console.log('  ── 打印本身 ──')
    check('A4 横向（导图是横向生长的）', pdfTest.landscape === true)
    check('内联了流程图 SVG', pdfTest.inlineSvg > 0, `${pdfTest.inlineSvg} 个`)
    check('强制纯白背景', pdfTest.whiteBg === true)
    check('夜间主题下导出的图不含深色背景（真的切到白色渲染了）', pdfTest.hasDarkBg === false)
    check('打印视图无外部引用', pdfTest.noExternal === true)
    console.log('  ── 谁来触发打印（不抢焦点、不挡版面）──')
    /*
     * 浏览器没有「直接生成 PDF 文件」的接口，唯一的出口是打印对话框里的
     * 「另存为 PDF」。之前是打开预览页就自动唤起这个对话框 —— 它会盖住页面、
     * 抢走焦点，用户来不及看一眼自己印的是什么。所以改成右上角一颗图标按钮。
     * 用户对它的要求是「一个按钮就行了，放在右上角，字去掉，保持干净」。
     */
    check('默认不自动弹打印对话框（不抢焦点、不盖住刚打开的预览）',
      pdfTest.hasAutoPrint === false)
    check('预览页右上角有一颗手动打印按钮（导出这条路是通的，不是死胡同）',
      pdfTest.hasFab === true)
    check('按钮里只有图标、没有文字（「字去掉，保持干净」）',
      pdfTest.fabIcon === true && pdfTest.fabText === '',
      `图标 ${pdfTest.fabIcon} / 按钮文字 ${JSON.stringify(pdfTest.fabText)}`)
    check('按钮带 title（字看不见，但悬停和读屏还能知道它是干什么的）',
      /打印/.test(pdfTest.fabTitle), pdfTest.fabTitle)
    check('按钮真的钉在右上角（fixed + 距上/右各不超过 24px）',
      pdfTest.fabPosition === 'fixed' && pdfTest.fabTop <= 24 && pdfTest.fabRight <= 24,
      `${pdfTest.fabPosition} 距上 ${pdfTest.fabTop}px 距右 ${pdfTest.fabRight}px（视口宽 ${pdfTest.vw}）`)
    check('旧的顶部工具栏已经拆掉（页数统计和「另存为 PDF」说明都不在页面上）',
      pdfTest.hasOldBar === false)
    /*
     * 这条是这次改动的结构收益：按钮是 position:fixed，不参与排版，所以 body
     * 上不该有任何让位内边距，第一页仍然贴着页首。上一版那条工具栏必须和
     * body 的 padding-top 对上，一旦对不上（实测工具栏自然撑成 58px、内边距
     * 按 54px 写的）就压住第一页 —— 这个耦合现在从结构上不存在了。
     */
    check('按钮不参与排版：body 没有让位内边距、第一页仍在页首',
      pdfTest.bodyPadTop === 0 && pdfTest.pageTop <= 1,
      `padding-top ${pdfTest.bodyPadTop}px / 第一页 top ${pdfTest.pageTop.toFixed(1)}px`)
    console.log('  ── 真的渲染出来量一遍几何 ──')
    console.log(`  ${pdfTest.renderedPages} 页 · 图撑满盒子的比例 ≥ ${pdfTest.minFill.toFixed(3)}`)
    check('打印视图能真的排版出来', pdfTest.renderedPages >= 1 && pdfTest.nodeCount > 0,
      `${pdfTest.renderedPages} 页 / ${pdfTest.nodeCount} 节点`)
    check('没有任何流程图压住节点（真实渲染后的矩形不相交）',
      pdfTest.chartOnNode === 0, `${pdfTest.chartOnNode} 对相交`)
    check('没有任何两张流程图互相压住', pdfTest.chartOnChart === 0, `${pdfTest.chartOnChart} 对相交`)
    check('流程图真的撑满了它的盒子（内联 max-width 已清掉）',
      pdfTest.minFill >= 0.8, `最小比例 ${pdfTest.minFill.toFixed(3)}`)
    check('没有任何节点/流程图被页边界切成一半',
      pdfTest.partial === 0, `${pdfTest.partial} 个只印了一半`)
    check('每个节点/流程图都完整落在某一页里（没有整个丢掉）',
      pdfTest.orphan === 0 && pdfTest.boxCount > 0, `${pdfTest.orphan} 个不在任何页里 / 共 ${pdfTest.boxCount} 个`)

    /*
     * 再把页面真的切成「打印媒体」量一遍：按钮必须消失、版心必须还是 A4 横向。
     * 只看 CSS 字符串不算数 —— @media 块写错位置或被后面的规则覆盖，
     * 在字符串上完全看不出来，而它的代价是每页纸上多一块脏东西。
     */
    console.log('  ── 切成「打印媒体」再量一遍 ──')
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' })
    let printed
    try {
      printed = await evaluate(`(() => {
        const f = document.getElementById('mf-print-probe')
        if (!f) return { error: '探测 iframe 已经没了' }
        const d = f.contentDocument
        const fab = d.querySelector('.mf-print-fab')
        const cs = fab ? f.contentWindow.getComputedStyle(fab) : null
        const r = d.querySelector('.page').getBoundingClientRect()
        const out = {
          fabPresent: !!fab,
          fabDisplay: cs ? cs.display : '(无按钮)',
          bodyPadTop: parseFloat(f.contentWindow.getComputedStyle(d.body).paddingTop) || 0,
          pageTop: r.top,
          pageH: r.height,
        }
        f.remove()
        return out
      })()`)
    } finally {
      // 媒体模拟是整页生效的，不还原会影响后面所有套件
      await cdp.send('Emulation.setEmulatedMedia', { media: '' })
    }
    if (printed.error) {
      check('打印媒体下的探测', false, JSON.stringify(printed))
    } else {
      check('打印时按钮消失（纸上每页多一颗按钮就是每页一块脏东西）',
        printed.fabDisplay === 'none', `display=${printed.fabDisplay}`)
      check('打印时 body 内边距为 0、第一页回到页首（不会被挤下去）',
        printed.bodyPadTop === 0 && printed.pageTop <= 1,
        `padding ${printed.bodyPadTop}px / 第一页 top ${printed.pageTop.toFixed(1)}px`)
      check('打印时版心仍是 A4 横向（没有退化成屏幕尺寸）',
        Math.abs(printed.pageH - 718.11) < 1.5, `${printed.pageH.toFixed(1)}px`)
    }
  }

  console.log('\n[16b] 新窗口被拦截时的兜底（**打包出来的桌面版走的就是这条路**）')
  /*
   * 为什么单独测这条：Tauri 的 `lib.rs` 没有配 `on_new_window`，而 wry 的 WebView2
   * 后端在「没有 handler」时执行 `args.SetHandled(true)` —— 不建窗口，
   * 于是 `window.open()` 返回 null。实测（CDP 连 WebView2，见 README 十一）
   * 桌面壳里点「导出 PDF」确实走这条兜底：下载 `<文档名>-导图.html`。
   *
   * 所以这条路必须验证两件事：
   *   ① 真的退化成下载（而不是什么都不做 —— 那才是「点了没反应」）；
   *   ② 提示条把**文件名**说出来，否则用户只能去下载目录里猜是哪一个。
   *
   * 浏览器里没法真的让 window.open 失败，就把它换成一个返回 null 的桩来等价复现。
   * 顺带把下载目录指到临时目录、并拦掉 <a download> 的点击：
   * 这条用例是「只读」的，不该往用户磁盘上写文件。
   */
  try { await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: tmpdir() }) } catch { /* 老版本不支持就算了 */ }
  const blocked = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const origOpen = window.open
    const origClick = HTMLAnchorElement.prototype.click
    const got = []
    window.open = function () { return null }
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { got.push(this.download); return }
      return origClick.apply(this, arguments)
    }
    try {
      const b = document.querySelector('[data-tool="export-pdf"]')
      if (!b) return { error: '找不到导出 PDF 按钮' }
      b.click()
      // 等提示条出现（导出要先把每张流程图渲染成 SVG，别用固定 sleep 猜）
      const t0 = Date.now()
      let toast = null
      for (;;) {
        const t = document.querySelector('[data-app-toast]')
        if (t && /导图\\.html/.test(t.textContent)) { toast = t.textContent.trim(); break }
        if (Date.now() - t0 > 12000) { toast = t ? t.textContent.trim() : null; break }
        await sleep(120)
      }
      return { downloads: got, toast }
    } finally {
      window.open = origOpen
      HTMLAnchorElement.prototype.click = origClick
    }
  })()`)
  if (blocked.error) {
    check('新窗口被拦截时的兜底', false, JSON.stringify(blocked))
  } else {
    note(`兜底下载：${JSON.stringify(blocked.downloads)}`)
    note(`兜底提示：${JSON.stringify(blocked.toast)}`)
    check('★ 新窗口被拦截时退化为下载 HTML（不是点了没反应）',
      blocked.downloads.some((n) => /导图\.html$/.test(n)), JSON.stringify(blocked.downloads))
    check('★ 兜底提示里带文件名（用户不用去下载目录里猜是哪一个）',
      /导图\.html/.test(blocked.toast || '') && /Ctrl\+P/.test(blocked.toast || ''),
      JSON.stringify(blocked.toast))
  }

  console.log('\n[17] 文件夹（新建 / 归类 / 重命名 / 删除）')
  const folders = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    // 轮询等待条件成立，替代固定 sleep。
    // 固定 sleep 在机器有负载时会不够用（曾出现过偶发失败），
    // 而且等待条件通常比"猜一个足够大的数字"更快也更稳。
    const waitFor = async (fn, ms = 4000) => {
      const t0 = Date.now()
      for (;;) {
        const v = fn()
        if (v) return v
        if (Date.now() - t0 > ms) return null
        await sleep(80)
      }
    }
    const out = {}

    // 打开左侧大纲，并等它真正滑出（而不是猜时间）
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 400 }))
    const aside = await waitFor(() => {
      const a = document.querySelector('aside')
      return a && a.className.includes('open') ? a : null
    })
    if (!aside) return { error: '大纲面板没有滑出', ...out }

    // 在「文档」标题栏右键 → 新建文件夹
    const header = await waitFor(() => [...document.querySelectorAll('aside div')]
      .find(d => /^文档\\s*\\d*/.test(d.textContent.trim()) && d.className.includes('flex')))
    if (!header) return { error: '找不到文档标题栏', ...out }
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 130, clientY: 600 }))

    // 必须先等菜单渲染出来再快照按钮文案，否则拿到的是渲染前的旧 DOM
    const mk = await waitFor(() => [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === '新建文件夹'))
    const items = [...document.querySelectorAll('button')].map(b => b.textContent.trim())
    out.hasNewFolder = items.includes('新建文件夹')
    out.hasNewDoc = items.includes('新建文档')
    if (!mk) return { error: '右键菜单里没有新建文件夹', items, ...out }
    mk.click()

    // 新建后会直接进入重命名态。
    // 注意不能用 'aside input' —— 面板顶部的搜索框也是 input，
    // 重命名输入框没有 placeholder，用它来区分。
    const input = await waitFor(() => document.querySelector('aside input:not([placeholder])'))
    if (!input) return { error: '没有进入重命名态', ...out }
    const setInput = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setInput(input, '计算机网络')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    await waitFor(() => JSON.parse(localStorage.getItem('mf:folders') || '[]').length > 0)
    out.folderCreated = JSON.parse(localStorage.getItem('mf:folders') || '[]').map(f => f.name)

    // 右键一个文档 → 移动到「计算机网络」
    const docRow = await waitFor(() => document.querySelector('[data-doc-id]'))
    if (!docRow) return { error: '找不到文档行', ...out }
    const docId = docRow.dataset.docId
    docRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 620 }))

    // 同上：等菜单渲染完再快照
    const moveBtn = await waitFor(() => [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === '计算机网络'))
    const moveItems = [...document.querySelectorAll('button')].map(b => b.textContent.trim())
    out.hasMoveSection = moveItems.includes('计算机网络')
    if (!moveBtn) return { error: '菜单里没有移动到文件夹', moveItems, ...out }
    moveBtn.click()

    await waitFor(() => JSON.parse(localStorage.getItem('mf:doc:' + docId)).folderId)
    out.docFolderId = JSON.parse(localStorage.getItem('mf:doc:' + docId)).folderId

    // 折叠文件夹应隐藏其中的文档
    const folderRow = await waitFor(() => document.querySelector('[data-folder-id]'))
    out.folderRowExists = !!folderRow
    if (folderRow) {
      folderRow.click()
      out.hiddenWhenCollapsed = !!(await waitFor(
        () => !document.querySelector('[data-doc-id="' + docId + '"]'), 2500))
      folderRow.click()
      out.shownWhenExpanded = !!(await waitFor(
        () => document.querySelector('[data-doc-id="' + docId + '"]'), 2500))
    }

    // 右键文件夹 → 删除（文档应退回未分类而不是被删）
    const fr = await waitFor(() => document.querySelector('[data-folder-id]'))
    if (!fr) return { error: '文件夹行消失了', ...out }
    fr.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 600 }))
    const del = await waitFor(() => [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === '删除文件夹'))
    out.hasDeleteFolder = !!del
    if (del) del.click()
    const ok = await waitFor(() => [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === '确定'))
    out.deleteConfirmShown = !!ok
    if (ok) ok.click()

    await waitFor(() => JSON.parse(localStorage.getItem('mf:folders') || '[]').length === 0)
    const after = JSON.parse(localStorage.getItem('mf:doc:' + docId))
    out.foldersAfterDelete = JSON.parse(localStorage.getItem('mf:folders') || '[]').length
    out.docStillExists = !!after
    out.docFolderCleared = after && after.folderId === null
    return out
  })()`)

  if (folders.error) {
    check('文件夹', false, JSON.stringify(folders))
  } else {
    check('文档标题栏右键有「新建文件夹」', folders.hasNewFolder === true)
    check('新建文件夹并命名', (folders.folderCreated || []).includes('计算机网络'),
      JSON.stringify(folders.folderCreated))
    check('文档右键菜单有「移动到」文件夹', folders.hasMoveSection === true)
    check('文档已归入文件夹', !!folders.docFolderId, String(folders.docFolderId))
    check('文件夹可折叠（隐藏其中的文档）',
      folders.hiddenWhenCollapsed === true && folders.shownWhenExpanded === true,
      JSON.stringify(folders))
    check('文件夹右键有「删除文件夹」', folders.hasDeleteFolder === true)
    check('删除文件夹有确认弹窗', folders.deleteConfirmShown === true)
    check('删除文件夹后文档仍在（未被连带删除）', folders.docStillExists === true)
    check('删除文件夹后文档退回未分类', folders.docFolderCleared === true,
      `folderId=${folders.docFolderId}`)
  }

  console.log('\n[18] 移动端：单面板 + 预览/编辑切换（不再分栏）')
  // 视口切成手机尺寸后再打开折角弹窗，检查面板结构
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  })
  await sleep(1200)

  const mobile = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const hit = [...document.querySelectorAll('[data-fold-badge]')][0]
    if (!hit) return { error: '找不到折角' }
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(2500)
    const modal = document.querySelector('.mf-unfold')
    if (!modal) return { error: '弹窗没打开' }
    /*
     * 手机端**只渲染一个面板**（不再是「左编辑 + 右预览」两个 section 分栏）。
     * 所以这里数的是 data-pane-section，而且期望恰好 1 个。
     */
    const panes = [...modal.querySelectorAll('[data-pane-section]')]
    const paneTabs = [...modal.querySelectorAll('[data-pane-tab]')].map(b => b.dataset.paneTab)
    const body = modal.querySelector('[data-modal-body]')
    const r = modal.getBoundingClientRect()
    const closeBtn = [...modal.querySelectorAll('button')].find(x => x.textContent.trim() === '✕')
    if (closeBtn) closeBtn.click()
    await sleep(600)
    return {
      vw: innerWidth, vh: innerHeight,
      paneCount: panes.length,
      paneNames: panes.map(p => p.dataset.paneSection),
      paneTabs,
      pane: body?.dataset.pane || null,
      splitterVisible: !!(() => {
        const s = modal.querySelector('[role=separator]')
        return s && s.getBoundingClientRect().width > 0
      })(),
      heightStyle: modal.style.height || null,
      modalH: Math.round(r.height),
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
    }
  })()`)

  if (mobile.error) {
    check('移动端单面板', false, JSON.stringify(mobile))
  } else {
    check('手机视口生效', mobile.vw === 390, `${mobile.vw}x${mobile.vh}`)
    check('★ 弹窗在手机上只渲染一个面板（不再上下分栏）',
      mobile.paneCount === 1, `panes=${JSON.stringify(mobile.paneNames)}`)
    check('★ 顶部有【预览】/【编辑】切换按钮',
      mobile.paneTabs?.join() === 'preview,edit', JSON.stringify(mobile.paneTabs))
    check('★ 默认进入【预览】', mobile.pane === 'preview', String(mobile.pane))
    check('★ 手机上没有左右分割线', mobile.splitterVisible === false)
    check('★ 用 100dvh（动态视口高度）', mobile.heightStyle === '100dvh', String(mobile.heightStyle))
    check('弹窗不超出视口高度', mobile.modalH <= mobile.vh + 1, `${mobile.modalH} vs ${mobile.vh}`)
    check('手机上没有横向溢出', mobile.noHorizontalOverflow === true)
  }

  // 恢复桌面视口
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await sleep(800)

  console.log('\n[19] 折角角标：圆形气泡（微信式），不是三角形')
  // 按固定剧本摆好四种等级 + 空折角 + 未读圆点，避免依赖示例文档恰好长什么样
  await evaluate(`(async () => {
    const id = JSON.parse(localStorage.getItem('mf:active'))
    const doc = JSON.parse(localStorage.getItem('mf:doc:' + id))
    const folds = []
    const walk = (n) => { if (n.fold) folds.push(n); n.children.forEach(walk) }
    walk(doc.root)
    const plan = [
      { corner: false, oc: 0 },   // 空折角 → 空心圆圈
      { corner: true,  oc: 0 },   // 有内容未读 → 小圆点
      { corner: true,  oc: 1 },   // 1-2 次 → 蓝
      { corner: true,  oc: 3 },   // 3-4 次 → 橙
      { corner: true,  oc: 5 },   // 5+ → 深红
      { corner: true,  oc: 12 },  // 两位数
      { corner: true,  oc: 2 },   // 蓝
    ]
    folds.forEach((n, i) => {
      const p = plan[i % plan.length]
      n.fold.corner = p.corner
      n.fold.mermaid = p.corner ? (n.fold.mermaid || 'flowchart TD\\n  A --> B') : ''
      n.fold.openCount = p.oc
    })
    localStorage.setItem('mf:doc:' + id, JSON.stringify(doc))
    location.reload()
  })()`)
  await sleep(5000)

  const badge = await evaluate(`(() => {
    const badges = [...document.querySelectorAll('[data-fold-badge]')]
    const info = badges.map(b => {
      const vis = b.firstElementChild
      const vs = vis ? getComputedStyle(vis) : null
      const vr = vis ? vis.getBoundingClientRect() : null
      const br = b.getBoundingClientRect()
      const node = b.closest('[data-node-id]')
      const nr = node.getBoundingClientRect()
      return {
        level: Number(b.dataset.level),
        kind: b.dataset.foldKind,
        text: vis ? vis.textContent.trim() : '',
        w: vr ? +vr.width.toFixed(1) : 0,
        h: vr ? +vr.height.toFixed(1) : 0,
        radius: vs ? vs.borderTopLeftRadius : '',
        bg: vs ? vs.backgroundColor : '',
        borderW: vs ? parseFloat(vs.borderTopWidth) : 0,
        borderStyle: vs ? vs.borderTopStyle : '',
        borderColor: vs ? vs.borderTopColor : '',
        fontSize: vs ? vs.fontSize : '',
        textColor: vs ? vs.color : '',
        shadow: vs ? vs.boxShadow : '',
        hitW: +br.width.toFixed(1),
        hitH: +br.height.toFixed(1),
        centerOffsetRight: +(br.left + br.width / 2 - nr.right).toFixed(1),
        centerOffsetTop: +(br.top + br.height / 2 - nr.top).toFixed(1),
      }
    })
    return {
      total: badges.length,
      svgCount: document.querySelectorAll('[data-fold-badge] svg').length,
      dashedCount: info.filter(i => i.borderStyle === 'dashed').length,
      nonCircular: info.filter(i => !/9999px|9999/.test(i.radius)).length,
      info,
      canvasVar: getComputedStyle(document.documentElement).getPropertyValue('--mf-canvas').trim(),
    }
  })()`)

  check('每个折角节点都有角标', badge.total > 0, `${badge.total} 个`)
  check('角标里没有任何 SVG（三角形已彻底移除）', badge.svgCount === 0, `${badge.svgCount} 个 svg`)
  check('没有任何虚线边框', badge.dashedCount === 0, `${badge.dashedCount} 个虚线`)
  check('全部是正圆（border-radius: 9999px）', badge.nonCircular === 0, `${badge.nonCircular} 个非圆`)
  check('点击热区 = 24×24', badge.info.every(i => i.hitW === 24 && i.hitH === 24),
    JSON.stringify([...new Set(badge.info.map(i => i.hitW + 'x' + i.hitH))]))
  check('角标贴在节点右上角（中心偏移在 ±4px 内）',
    badge.info.every(i => Math.abs(i.centerOffsetRight) <= 4 && Math.abs(i.centerOffsetTop) <= 4),
    JSON.stringify([...new Set(badge.info.map(i => i.centerOffsetRight + ',' + i.centerOffsetTop))]))

  // 四种等级各自的形态与配色（按 kind 精确定位，不靠顺序猜）
  const info = badge.info
  const dot = info.find(i => i.kind === 'dot')
  const ring = info.find(i => i.kind === 'ring')
  const blue = info.find(i => i.kind === 'num' && i.level === 1)
  const orange = info.find(i => i.kind === 'num' && i.level === 2)
  const red = info.find(i => i.kind === 'num' && i.level === 3)
  const twoDigit = info.find(i => i.kind === 'num' && i.text.length === 2)

  check('有内容未读 = 8px 浅灰小圆点、不显示数字',
    dot && dot.w === 8 && dot.h === 8 && dot.text === '' && dot.bg === 'rgb(156, 163, 175)',
    JSON.stringify(dot))
  check('空折角 = 空心小圆圈（有描边、无数字）',
    ring && ring.borderW > 0 && ring.text === '' && ring.w === 12 && ring.bg === 'rgb(255, 255, 255)',
    JSON.stringify(ring))
  check('1-2 次 = 蓝色小圆圈 + 数字',
    blue && blue.w === 16 && blue.bg === 'rgb(59, 130, 246)' && blue.text !== '' && blue.textColor === 'rgb(255, 255, 255)',
    JSON.stringify(blue))
  check('3-4 次 = 橙色小圆圈 + 数字',
    orange && orange.w === 16 && orange.bg === 'rgb(234, 88, 12)' && orange.text !== '',
    JSON.stringify(orange))
  check('5 次以上 = 深红色小圆圈 + 数字',
    red && red.w === 16 && red.bg === 'rgb(220, 38, 38)' && red.text !== '',
    JSON.stringify(red))
  check('数字字号 10px（极其微小居中）',
    [blue, orange, red].every(i => i && i.fontSize === '10px'),
    JSON.stringify([blue?.fontSize, orange?.fontSize, red?.fontSize]))
  check('两位数会从正圆拉成胶囊（不撑破）',
    twoDigit && twoDigit.h === 16 && twoDigit.w > 16,
    JSON.stringify(twoDigit && { w: twoDigit.w, h: twoDigit.h, text: twoDigit.text }))
  check('角标带画布底色描边（浮在框线之上）',
    [dot, blue, orange, red].every(i => i && i.shadow && i.shadow !== 'none'),
    JSON.stringify(blue?.shadow))

  console.log('\n[20] 角标在浅米黄主题下同样清晰')
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.title || '') === '护眼')
    if (b) b.click()
    return !!b
  })()`)
  await sleep(1200)

  const sepia = await evaluate(`(() => {
    const badges = [...document.querySelectorAll('[data-fold-badge]')]
    const info = badges.map(b => {
      const vis = b.firstElementChild
      const vs = vis ? getComputedStyle(vis) : null
      return {
        level: Number(b.dataset.level),
        radius: vs ? vs.borderTopLeftRadius : '',
        bg: vs ? vs.backgroundColor : '',
        shadow: vs ? vs.boxShadow : '',
        w: vis ? +vis.getBoundingClientRect().width.toFixed(1) : 0,
      }
    })
    return {
      canvas: getComputedStyle(document.documentElement).getPropertyValue('--mf-canvas').trim(),
      theme: document.documentElement.getAttribute('data-theme'),
      nonCircular: info.filter(i => !/9999/.test(i.radius)).length,
      // 描边颜色应当跟着画布底色变（米黄），而不是写死白色
      shadowColors: [...new Set(info.map(i => (i.shadow.match(/rgb\\([^)]+\\)/) || [''])[0]))],
      colors: [...new Set(info.map(i => i.bg))].sort(),
      levels: [...new Set(info.map(i => i.level))].sort(),
    }
  })()`)

  check('已切到浅米黄主题', sepia.theme === 'sepia' && sepia.canvas === '#fdf9f0',
    `${sepia.theme} / ${sepia.canvas}`)
  check('米黄主题下角标仍是正圆', sepia.nonCircular === 0)
  check('角标描边跟随画布底色（不是写死的白色）',
    sepia.shadowColors.every(c => !/255, 255, 255/.test(c)),
    JSON.stringify(sepia.shadowColors))
  check('米黄主题下配色分级不变', sepia.levels.length >= 3, JSON.stringify(sepia.colors))

  // 切回纯白，避免影响后续用例
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.title || '') === '纯白')
    if (b) b.click()
    return !!b
  })()`)
  await sleep(900)

  console.log('\n[21] 缩进列表编辑器（参考线 / 折叠 / 悬停联动 / 分组）')
  // 打开一个带流程图的折角
  await evaluate(`(() => {
    for (const n of document.querySelectorAll('[data-node-id]')) {
      const b = n.querySelector('[data-fold-kind="num"], [data-fold-kind="dot"]')
      if (b) { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true }
    }
    return false
  })()`)
  await sleep(3000)

  const editor = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const out = {}
    const rows = () => [...document.querySelectorAll('[data-outline-row]')]

    out.isBlockEditor = rows().length > 0
    out.notTextarea = !document.querySelector('.mf-unfold [data-outline-input]')?.tagName?.match(/TEXTAREA/)
    out.rowCount = rows().length

    // 参考线：条数应等于缩进层级（用 paddingLeft / 18 反推层级）
    const guides = rows().map(r => r.querySelectorAll('span[aria-hidden]').length)
    const depths = rows().map(r => Math.round(parseInt(getComputedStyle(r).paddingLeft, 10) / 18))
    out.guides = guides
    out.depths = depths
    out.guidesMatchDepth = guides.every((g, i) => g === depths[i])
    out.deepestGuides = Math.max(...guides)

    // 参考线是 1px 虚线
    const g0 = document.querySelector('[data-outline-row] span[aria-hidden]')
    const gs = g0 ? getComputedStyle(g0) : null
    out.guideStyle = gs ? gs.borderLeftWidth + ' ' + gs.borderLeftStyle : null
    out.guideColor = gs ? gs.borderLeftColor : null

    // 折叠三角：只有带子节点的行才有
    out.toggleCount = document.querySelectorAll('[data-fold-toggle]').length
    out.toggleLessThanRows = out.toggleCount < out.rowCount

    // 同级分组：底色应至少有 2 种（交替）
    out.bandColors = [...new Set(rows().map(r => getComputedStyle(r).backgroundColor))].length

    // --- 折叠 / 展开 ---
    const before = rows().length
    document.querySelector('[data-fold-toggle]').click()
    await sleep(400)
    out.afterCollapse = rows().length
    out.beforeCollapse = before
    document.querySelector('[data-fold-toggle]').click()
    await sleep(400)
    out.afterExpand = rows().length

    // --- 悬停联动 ---
    // React 的 onMouseEnter 由 mouseover 合成，必须派发 mouseover
    const last = rows()[rows().length - 1]
    const expectText = last.querySelector('[data-outline-input]').value.slice(0, 6)
    last.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
    await sleep(500)
    const hl = [...document.querySelectorAll('.mf-node-hover')]
    out.hlCount = hl.length
    out.hlText = hl[0] ? hl[0].textContent.trim() : null
    out.hlMatchesRow = !!out.hlText && out.hlText.startsWith(expectText)
    out.hoverBg = getComputedStyle(last).backgroundColor

    last.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    await sleep(400)
    out.hlAfterLeave = document.querySelectorAll('.mf-node-hover').length

    return out
  })()`)

  check('左侧是块状行编辑器（每行一个输入框）', editor.isBlockEditor === true, `${editor.rowCount} 行`)
  check('每行前面的参考线条数 == 该行缩进层级', editor.guidesMatchDepth === true,
    `guides=${JSON.stringify(editor.guides)} depths=${JSON.stringify(editor.depths)}`)
  check('存在多级缩进（有参考线可画）', editor.deepestGuides >= 2, `最深 ${editor.deepestGuides} 级`)
  check('参考线是 1px 虚线', editor.guideStyle === '1px dashed', editor.guideStyle)
  check('只有带子节点的行才有折叠三角',
    editor.toggleCount > 0 && editor.toggleLessThanRows === true,
    `${editor.toggleCount} 个三角 / ${editor.rowCount} 行`)
  check('点击折叠三角收起子树',
    editor.afterCollapse < editor.beforeCollapse && editor.afterCollapse >= 1,
    `${editor.beforeCollapse} → ${editor.afterCollapse}`)
  check('再次点击恢复展开', editor.afterExpand === editor.beforeCollapse,
    `${editor.afterCollapse} → ${editor.afterExpand}`)
  check('同级分组有交替底色', editor.bandColors >= 2, `${editor.bandColors} 种`)
  check('悬停行会高亮右侧对应的 Mermaid 节点', editor.hlCount === 1, `${editor.hlCount} 个高亮`)
  check('高亮的是**对应**的那个节点（不是随便一个）', editor.hlMatchesRow === true,
    `高亮=「${editor.hlText}」`)
  check('移出后高亮消失', editor.hlAfterLeave === 0, `${editor.hlAfterLeave} 个残留`)
  check('悬停行本身有高亮底色', !!editor.hoverBg, editor.hoverBg)

  console.log('\n[22] 编辑器：改字同步到右侧图')
  // 说明：Tab/Enter/退格等键盘行为在 headless 里无法端到端验证 ——
  // 实测按键能到达 window，但浏览器不会把它路由到 input（连受信任的鼠标点击
  // 都拿不到焦点）。所以那些逻辑抽成了纯函数，由 npm run test:editor 覆盖。
  const editOps = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const inputs = () => [...document.querySelectorAll('[data-outline-input]')]
    const out = { rows: inputs().length }

    // 改字 → 右侧图同步
    const input = inputs()[1]
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '同步验证节点')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(2600)
    const svg = [...document.querySelectorAll('.mf-unfold svg')].find(s => s.querySelector('.node'))
    out.graphHasIt = svg ? [...svg.querySelectorAll('g.node')].some(n => n.textContent.includes('同步验证节点')) : false
    out.graphCount = svg ? svg.querySelectorAll('g.node').length : 0

    // 单根缩进列表不该出现「多根提示」
    out.multiRootHint = !!document.querySelector('[data-multi-root-hint]')
    return out
  })()`)

  check('改字后右侧 Mermaid 同步更新', editOps.graphHasIt === true)
  check('图的节点数与编辑器行数一致', editOps.graphCount === editOps.rows,
    `图 ${editOps.graphCount} / 列表 ${editOps.rows}`)
  check('单根缩进列表不显示「多根」提示', editOps.multiRootHint === false)

  // 关掉弹窗，避免影响后续用例
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.mf-unfold button')].find(x => x.textContent.trim() === '✕')
    if (b) b.click()
    return !!b
  })()`)
  await sleep(1200)

  console.log('\n[24] 弹窗右侧：分栏拖拽 / 单击联动 / 双击改字 / 右键改结构 / 悬停连线')
  // 打开一个带流程图的折角
  await evaluate(`(() => {
    for (const n of document.querySelectorAll('[data-node-id]')) {
      const b = n.querySelector('[data-fold-kind="num"], [data-fold-kind="dot"]')
      if (b) { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true }
    }
    return false
  })()`)
  await sleep(3000)

  const panel = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const host = document.querySelector('.mf-unfold')
    const out = {}

    /* ---------- 1. 分割线 ---------- */
    const sp = document.querySelector('[data-splitter]')
    out.splitter = !!sp
    if (sp) {
      const cs = getComputedStyle(sp)
      out.splitterWidth = cs.width
      out.splitterCursor = cs.cursor
      const secs = () => [...host.querySelectorAll('section')]
      out.leftBefore = Math.round(secs()[0].getBoundingClientRect().width)
      out.rightBefore = Math.round(secs()[1].getBoundingClientRect().width)

      const r = sp.getBoundingClientRect()
      const mk = (type, x) => new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: r.top + r.height / 2,
        button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 91, isPrimary: true, pointerType: 'mouse',
      })
      // 往左拖到极限 → 左侧应停在下限
      sp.dispatchEvent(mk('pointerdown', r.x + 2))
      window.dispatchEvent(mk('pointermove', r.x - 900))
      await sleep(180)
      out.leftAtMin = Math.round(secs()[0].getBoundingClientRect().width)
      // 往右拖到极限 → 右侧应停在下限
      window.dispatchEvent(mk('pointermove', r.x + 2200))
      await sleep(180)
      out.leftAtMax = Math.round(secs()[0].getBoundingClientRect().width)
      out.rightAtMax = Math.round(secs()[1].getBoundingClientRect().width)
      // 回到中间
      window.dispatchEvent(mk('pointermove', r.x + 60))
      await sleep(180)
      out.leftMid = Math.round(secs()[0].getBoundingClientRect().width)
      window.dispatchEvent(mk('pointerup', r.x + 60))
      await sleep(300)
    }

    /* ---------- 2. 单击选中 ---------- */
    const nodes = [...host.querySelectorAll('g.node')]
    out.nodeCount = nodes.length
    const n2 = nodes[2]
    const r2 = n2.getBoundingClientRect()
    n2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r2.x + r2.width / 2, clientY: r2.y + r2.height / 2 }))
    await sleep(450)
    out.selCount = host.querySelectorAll('.mf-node-sel').length
    out.selText = host.querySelector('.mf-node-sel')?.textContent.trim() || null
    const hlRow = document.querySelector('[data-outline-row][data-highlighted="true"]')
    out.rowHighlighted = !!hlRow
    out.rowText = hlRow ? hlRow.querySelector('input')?.value : null
    // 单击不能弹输入框
    out.editorAfterClick = !!document.querySelector('[data-label-editor]')

    /* ---------- 5. 悬停：节点变灰 + 连线加粗 ---------- */
    const n3 = nodes[3]
    const r3 = n3.getBoundingClientRect()
    n3.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r3.x + r3.width / 2, clientY: r3.y + r3.height / 2 }))
    await sleep(400)
    out.hoverNodeCount = host.querySelectorAll('.mf-node-hover').length
    const edges = [...host.querySelectorAll('.mf-edge-hl')]
    out.hoverEdgeCount = edges.length
    out.edgeStroke = edges[0] ? getComputedStyle(edges[0]).stroke : null
    out.edgeWidth = edges[0] ? getComputedStyle(edges[0]).strokeWidth : null
    const hoverRect = host.querySelector('.mf-node-hover rect')
    out.hoverFill = hoverRect ? getComputedStyle(hoverRect).fill : null

    /* ---------- 3. 双击改字 ---------- */
    const n4 = nodes[4]
    const r4 = n4.getBoundingClientRect()
    n4.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: r4.x + 20, clientY: r4.y + 10 }))
    await sleep(400)
    const ed = document.querySelector('[data-label-editor]')
    out.editorOpened = !!ed
    if (ed) {
      const inp = ed.querySelector('input')
      out.editorValue = inp.value
      out.editorSelectAll = inp.selectionStart === 0 && inp.selectionEnd === inp.value.length
      // 输入框必须贴着鼠标附近
      const er = ed.getBoundingClientRect()
      out.editorNearCursor = Math.abs(er.left - r4.x) < 120 && Math.abs(er.top - r4.y) < 80
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, '改过的文字XYZ')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      // headless 不会把 keydown 路由到 input，所以走 blur 提交路径
      inp.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await sleep(2600)
      out.editorClosed = !document.querySelector('[data-label-editor]')
      const svg2 = [...host.querySelectorAll('svg')].find(s => s.querySelector('.node'))
      out.graphHasNew = svg2 ? [...svg2.querySelectorAll('g.node')].some(n => n.textContent.includes('改过的文字XYZ')) : false
      out.leftHasNew = [...document.querySelectorAll('[data-outline-input]')].some(i => i.value.includes('改过的文字XYZ'))
    }

    /* ---------- 4. 右键改结构 ---------- */
    const n0 = [...host.querySelectorAll('g.node')][0]
    const r0 = n0.getBoundingClientRect()
    n0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r0.x + 20, clientY: r0.y + 10 }))
    await sleep(400)
    const menu = document.querySelector('[data-node-menu]')
    out.menuOpened = !!menu
    out.menuItems = menu ? [...menu.querySelectorAll('button')].map(b => b.textContent.trim()) : []
    /*
     * 「移动位置」不是 <button> 而是带 role="menuitem" 的 <div>（它要展开子菜单，
     * 用 div 才能挂 aria-haspopup / aria-expanded），所以上面那行收集不到它，
     * 必须按 data-menu-item 单独取一次。
     */
    const moveEl = menu?.querySelector('[data-menu-item="move"]')
    out.menuHasMove = !!moveEl
    out.menuMoveLabel = moveEl ? moveEl.textContent.replace(/[▸▾]/g, '').trim() : null
    if (menu) {
      out.rowsBefore = document.querySelectorAll('[data-outline-input]').length
      const addChild = [...menu.querySelectorAll('button')].find(b => b.textContent.includes('新增子节点'))
      addChild?.click()
      await sleep(2600)
      out.rowsAfter = document.querySelectorAll('[data-outline-input]').length
      out.menuClosed = !document.querySelector('[data-node-menu]')
      const svg3 = [...host.querySelectorAll('svg')].find(s => s.querySelector('.node'))
      out.graphNodeCount = svg3 ? svg3.querySelectorAll('g.node').length : 0
    }

    return out
  })()`)

  check('存在分割线且是 4px / col-resize',
    panel.splitter === true && panel.splitterWidth === '4px' && panel.splitterCursor === 'col-resize',
    `${panel.splitterWidth} / ${panel.splitterCursor}`)
  check('拖到最左时左侧停在下限 200px', panel.leftAtMin === 200, `${panel.leftAtMin}px`)
  check('拖到最右时右侧停在下限 300px', panel.rightAtMax === 300, `${panel.rightAtMax}px`)
  check('左侧仍保有 200px 下限（没被右侧挤没）', panel.leftAtMax >= 200, `${panel.leftAtMax}px`)
  check('拖动过程中宽度实时变化',
    panel.leftMid !== panel.leftBefore && panel.leftMid > 200,
    `${panel.leftBefore} → ${panel.leftMid}`)

  check('单击节点 → 该节点高亮', panel.selCount === 1, `${panel.selCount} 个`)
  check('单击节点 → 左侧对应行同步高亮',
    panel.rowHighlighted === true && panel.rowText === panel.selText,
    `行「${panel.rowText}」/ 图「${panel.selText}」`)
  check('单击不弹出输入框（只做选中）', panel.editorAfterClick === false)

  check('双击节点 → 弹出悬浮输入框', panel.editorOpened === true)
  check('输入框默认全选文字', panel.editorSelectAll === true)
  check('输入框出现在鼠标附近', panel.editorNearCursor === true)
  check('提交后输入框消失', panel.editorClosed === true)
  check('改字后右侧图同步更新', panel.graphHasNew === true)
  check('改字后左侧缩进文本同步更新', panel.leftHasNew === true)

  check('右键节点 → 弹出菜单', panel.menuOpened === true)
  /*
   * 【已从「极简三件套」改为「完整的五件 + 移动位置」】
   * 早先缩进模式下的菜单只有新增/删除三项 —— 连线两项和「移动位置」被
   * `showLink={mode === 'code'}` 挡住了，用户必须先切到代码模式才能用。
   * 那个限制的理由（「缩进列表表达不了多对一」）其实不成立：这几个动作
   * 改的一直是 Mermaid 代码，而缩进列表编译出来的就是 Mermaid 代码。
   * 现在两个模式共用同一套完整菜单。
   */
  check('菜单是完整的六项（连线 ×2 + 增删 ×3 + 移动位置）',
    JSON.stringify(panel.menuItems) === JSON.stringify([
      '指向', '指向同一结果', '新增同级节点', '新增子节点', '删除该节点',
    ]) && panel.menuHasMove === true && panel.menuMoveLabel === '移动位置',
    JSON.stringify({ items: panel.menuItems, move: panel.menuMoveLabel }))
  check('菜单操作后左侧行数 +1', panel.rowsAfter === panel.rowsBefore + 1,
    `${panel.rowsBefore} → ${panel.rowsAfter}`)
  check('菜单操作后右侧图同步重绘', panel.graphNodeCount === panel.rowsAfter,
    `图 ${panel.graphNodeCount} / 行 ${panel.rowsAfter}`)
  check('菜单点完自动关闭', panel.menuClosed === true)

  check('悬停节点 → 节点背景变浅灰',
    panel.hoverNodeCount === 1 && panel.hoverFill !== 'none', panel.hoverFill)
  check('悬停节点 → 相连的线一起加粗变色',
    panel.hoverEdgeCount >= 1 && panel.edgeWidth === '2.5px' && panel.edgeStroke === 'rgb(59, 130, 246)',
    `${panel.hoverEdgeCount} 条 / ${panel.edgeWidth} / ${panel.edgeStroke}`)

  // 关掉弹窗
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.mf-unfold button')].find(x => x.textContent.trim() === '✕')
    if (b) b.click()
    return !!b
  })()`)
  await sleep(1200)

  console.log('\n[25] 控制台无错误')
  check('页面无未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  await cdp.close()
  proc.kill()
  staticServer?.close()
  try { rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`\n${'='.repeat(46)}`)
  console.log(`  通过 ${pass} / 失败 ${fail}`)
  console.log('='.repeat(46))
  // 稍等一下再退出：让 WebSocket / 子进程句柄收干净，
  // 否则 Windows 上 libuv 会在退出瞬间打印 UV_HANDLE_CLOSING 断言噪音
  await sleep(300)
  process.exit(fail ? 1 : 0)
}

/* ---------------- 静态文件服务器（托管 dist/） ---------------- */
const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

function serveStatic(root) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0])
      if (p === '/') p = '/index.html'
      const file = join(root, p)
      // 防目录穿越
      if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404); res.end('not found'); return
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
      createReadStream(file).pipe(res)
    })
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => server.close(),
    }))
  })
}

/* ---------------- 极简 CDP 客户端 ---------------- */
async function connect(wsUrl) {
  const ws = new MiniWS(wsUrl)
  await ws.opened
  let id = 0
  const pending = new Map()
  const handlers = new Map()

  ws.onmessage = (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method && handlers.has(msg.method)) {
      handlers.get(msg.method)(msg.params)
    }
  }

  return {
    send(method, params = {}) {
      const mid = ++id
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject })
        ws.send(JSON.stringify({ id: mid, method, params }))
      })
    },
    on(method, fn) { handlers.set(method, fn) },
    close() { ws.close() },
  }
}

main().catch((e) => { console.error('冒烟测试失败：', e.message); process.exit(1) })
