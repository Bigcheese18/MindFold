/**
 * 手机端折角弹窗（流程图编辑器）专项
 * ==================================
 * 这一套只测**用户这一轮点名的六件事**，每一条都配一条桌面端的反向断言 ——
 * 「桌面端的布局和逻辑一个字都不许变」是整个项目的硬约束。
 *
 * 用户原话（本轮）：
 *   1. 「字溢出了」
 *   2. 「预览和编辑的按钮竟然是竖着的」
 *   3. 「底部指向和指向同一结果删了」
 *   4. 「放大镜和放小删了 完全用不上」
 *   5. 「撤销和回到中点放在下面」
 *   6. （能力不能丢）手机端还得能建连线
 *
 * ── 为什么原来的测试全绿，用户却看到溢出 ──
 * shape.mjs [8] 和 collapse.mjs [6] 都断言过「顶栏不溢出 / 关不掉按钮点得到」，
 * 但它们**都在刚打开弹窗、停在预览面板时量的**。而多出来的那个分段控件
 * （缩进列表 / Mermaid 代码）只在**编辑面板**才渲染，所以：
 *   · 预览面板：顶栏宽 390 装 6 个控件，刚好不溢出 → 断言全绿
 *   · 编辑面板：多一个 155px 的分段控件 → 顶栏 scrollWidth 479 > 390，
 *     「缩进列表 / Mermaid 代码」各自折成 3 行、撑到 84px 高（顶栏只有 48px），
 *     ↺ 被顶到 x=412、✕ 被顶到 x=451 —— 两个都在屏幕外，**手机上关不掉弹窗**
 * 教训：只在一个状态下量「装不装得下」，等于没量。本套件对**两个面板各量一遍**。
 *
 * 用法：node scripts/browser/mobilefold.mjs [url]
 *   默认 http://127.0.0.1:5173/；测构建产物时先
 *   `npx vite build --outDir dist-mf && node scripts/serve-dist.mjs dist-mf 9381`
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

// 本项目浏览器套件占 9333~9375，这里往后取一段不冲突的
const PORT = 9381
const userDir = mkdtempSync(join(tmpdir(), 'mf-mobilefold-'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (msg) => console.log(`  · ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 一张四节点的小图：够长按、够选中，且 fit 之后节点不会小到点不中。
 */
const GRAPH = 'flowchart TD\n  n0["甲"]\n  n0 --> n1\n  n1["乙"]\n  n1 --> n2\n  n2["丙"]\n  n2 --> n3\n  n3["丁"]'

/* ==================================================================== */
/* 量测脚本                                                              */
/* ==================================================================== */

/**
 * 顶栏体检：溢出量、每个子元素的矩形、重叠、关闭按钮能不能被真实指针点中，
 * 以及两个分段控件的「有没有换行 / 有没有被压窄」。
 */
const HDR = `(() => {
  const m = document.querySelector('[data-fold-modal]')
  if (!m) return { error: '弹窗没开' }
  const hdr = m.querySelector('header')
  if (!hdr) return { error: '顶栏缺失' }
  const hb = hdr.getBoundingClientRect()
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return {
      l: Math.round(r.left), r: Math.round(r.right),
      w: Math.round(r.width), h: Math.round(r.height),
      sw: el.scrollWidth, cw: el.clientWidth,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
    }
  }
  const kids = [...hdr.children].filter((e) => e.getBoundingClientRect().width > 0)
  const rects = kids.map((e) => ({ tag: e.tagName.toLowerCase(), label: (e.textContent || '').trim().slice(0, 8), ...rect(e) }))
  const sorted = [...rects].sort((a, b) => a.l - b.l)
  const overlaps = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i].r > sorted[i + 1].l + 0.5) overlaps.push(sorted[i].label + '|' + sorted[i + 1].label)
  }
  const closeBtn = [...hdr.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('关闭'))
  const cr = closeBtn ? rect(closeBtn) : null
  const paneSwitch = m.querySelector('[data-pane-switch]')
  const resetFam = m.querySelector('[data-reset-familiarity]')
  const rr = resetFam ? rect(resetFam) : null
  const paneTabEls = [...hdr.querySelectorAll('[data-pane-tab]')]
  const modeTabEls = [...hdr.querySelectorAll('[data-mode-tab]')]
  const tabInfo = (el, keyAttr) => {
    const cs = getComputedStyle(el)
    const b = rect(el)
    return {
      key: el.dataset[keyAttr],
      text: el.textContent,
      w: b.w, h: b.h,
      // 文字被挤到换行 = 按钮变成竖排柱子；scrollHeight 是判据
      wrapped: el.scrollWidth > el.clientWidth + 1,
      whiteSpace: cs.whiteSpace,
    }
  }
  return {
    vw: innerWidth, vh: innerHeight,
    hdr: { l: Math.round(hb.left), r: Math.round(hb.right), w: Math.round(hb.width), h: Math.round(hb.height) },
    overflowPx: hdr.scrollWidth - hdr.clientWidth,
    maxRight: rects.length ? Math.max(...rects.map((x) => x.r)) : null,
    minLeft: rects.length ? Math.min(...rects.map((x) => x.l)) : null,
    overlaps,
    rects,
    paneTabs: paneTabEls.map((el) => tabInfo(el, 'paneTab')),
    modeTabsInHeader: modeTabEls.map((el) => tabInfo(el, 'modeTab')),
    paneSwitchShrink: paneSwitch ? getComputedStyle(paneSwitch).flexShrink : null,
    paneSwitchExists: !!paneSwitch,
    closeW: cr ? cr.w : 0,
    closeH: cr ? cr.h : 0,
    closeInViewport: cr ? (cr.r <= innerWidth + 0.5 && cr.l >= -0.5) : false,
    closeHit: cr ? document.elementFromPoint(cr.cx, cr.cy) === closeBtn : false,
    resetText: resetFam ? resetFam.textContent.trim() : null,
    resetH: rr ? rr.h : 0,
    titleRendered: !!hdr.querySelector('h2'),
    modeTabCount: m.querySelectorAll('[data-mode-tab]').length,
    editHasModeTabs: !!m.querySelector('[data-pane-section="edit"] [data-mode-tab]'),
    toolbarHistory: m.querySelectorAll('[data-toolbar-history]').length,
    touchHint: (document.querySelector('[data-touch-hint]') || {}).textContent || null,
  }
})()`

/** 底部操作条 + 被删掉的那些控件 */
  /*
   * 底部操作条 + 被删掉的那些控件。
   *
   * 【注入脚本里绝对不能出现反引号】
   * 整段是模板字符串，一个反引号就会把它提前收尾，后面的内容变成模块级
   * JS 直接抛 ReferenceError（本项目 README 坑 114 记过同一次事故）。
   * 所以下面所有「引号强调」一律用「」，不用反引号。
   */
const BAR = `(() => {
  const m = document.querySelector('[data-fold-modal]')
  if (!m) return { error: '弹窗没开' }
  const bar = m.querySelector('[data-mobile-bottom-bar]')
  const rb = bar ? bar.getBoundingClientRect() : null
  const box = bar ? bar.firstElementChild : null
  const btns = bar ? [...bar.querySelectorAll('button')] : []
  return {
    vw: innerWidth, vh: innerHeight,
    exists: !!bar,
    oldMobileBar: !!m.querySelector('[data-mobile-bar]'),
    desktopZoomPanel: !!m.querySelector('[data-zoom-panel]'),
    zoomIn: !!m.querySelector('[data-zoom-btn="zoom-in"]'),
    zoomOut: !!m.querySelector('[data-zoom-btn="zoom-out"]'),
    zoomFit: !!m.querySelector('[data-zoom-btn="zoom-fit"]'),
    zoomFitTitle: (m.querySelector('[data-mobile-bottom-bar] [data-zoom-btn="zoom-fit"]') || {}).title || null,
    resetViewLink: !!m.querySelector('[data-reset-view]'),
    bottomUndo: m.querySelectorAll('[data-undo-button="bottom"]').length,
    bottomRedo: m.querySelectorAll('[data-undo-button="bottom"][data-undo-kind="redo"]').length,
    toolbarUndo: m.querySelectorAll('[data-undo-button="toolbar"]').length,
    floatingUndo: m.querySelectorAll('[data-undo-button="floating"]').length,
    toolCount: btns.length,
    tools: btns.map((b) => b.dataset.zoomBtn || b.dataset.undoKind || '?'),
    sizes: btns.map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }),
    hits: btns.map((b) => {
      const r = b.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      /*
       * 判据是「点在这一点的元素是不是这颗按钮**或它的后代**」。
       * 按钮里画的是内联 <svg> 图标，elementFromPoint 命中的正是那个 svg
       * （图标是按钮的后代，事件照样冒泡到按钮）—— 只判「恒等于按钮本身」
       * 会把好好的按钮报成点不到。
       */
      return !!hit && (hit === b || b.contains(hit))
    }),
    allInsideViewport: rb ? (rb.left >= -0.5 && rb.right <= innerWidth + 0.5 && rb.top >= -0.5 && rb.bottom <= innerHeight + 0.5) : false,
    right: rb ? Math.round(rb.right) : null,
    bottom: rb ? Math.round(rb.bottom) : null,
    rowDirection: box ? getComputedStyle(box).flexDirection : null,
    pageScrollW: document.documentElement.scrollWidth,
    pageClientW: document.documentElement.clientWidth,
  }
})()`

/** 面板内每一行工具条：有没有横向溢出 */
const ROWS = `(() => {
  const m = document.querySelector('[data-fold-modal]')
  if (!m) return { error: '弹窗没开' }
  return {
    vw: innerWidth,
    rows: [...m.querySelectorAll('[data-pane-section] > div')].map((d, i) => ({
      i,
      txt: (d.textContent || '').trim().slice(0, 26),
      w: Math.round(d.getBoundingClientRect().width),
      h: Math.round(d.getBoundingClientRect().height),
      over: d.scrollWidth - d.clientWidth,
    })),
    menu: !!document.querySelector('[data-node-menu]'),
  }
})()`

/** 节点菜单里的项（长按 / 右键 共用同一个组件） */
const MENU = `(() => {
  const n = document.querySelector('[data-node-menu]')
  if (!n) return { open: false }
  const r = n.getBoundingClientRect()
  return {
    open: true,
    items: [...n.querySelectorAll('[data-menu-item]')].map((b) => b.dataset.menuItem),
    insideViewport: r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5,
    rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
  }
})()`

/** 桌面端必须一字不变的清单 */
const DESKTOP = `(() => {
  const m = document.querySelector('[data-fold-modal]')
  if (!m) return { error: '弹窗没开' }
  const hdr = m.querySelector('header')
  const zp = m.querySelector('[data-zoom-panel]')
  return {
    vw: innerWidth,
    title: !!hdr.querySelector('h2'),
    paneSwitch: !!m.querySelector('[data-pane-switch]'),
    modeTabsInHeader: m.querySelectorAll('header [data-mode-tab]').length,
    zoomPanel: !!zp,
    zoomTools: zp ? [...zp.querySelectorAll('[data-zoom-btn]')].map((b) => b.dataset.zoomBtn) : [],
    zoomSizes: zp ? [...zp.querySelectorAll('[data-zoom-btn]')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }) : [],
    floatingUndo: m.querySelectorAll('[data-undo-button="floating"]').length,
    toolbarUndo: m.querySelectorAll('[data-undo-button="toolbar"]').length,
    resetView: !!m.querySelector('[data-reset-view]'),
    collapseBtn: !!m.querySelector('[data-edit-collapse]'),
    splitter: !!m.querySelector('[data-splitter]'),
    mobileBottomBar: !!m.querySelector('[data-mobile-bottom-bar]'),
    touchHint: !!m.querySelector('[data-touch-hint]'),
    headerOverflow: hdr.scrollWidth - hdr.clientWidth,
    resetText: (m.querySelector('[data-reset-familiarity]') || {}).textContent || null,
    previewHint: [...m.querySelectorAll('[data-pane-section="preview"] > div')].map((d) => (d.textContent || '').trim())[0] || null,
  }
})()`

/* ==================================================================== */
/* 主流程                                                                */
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
  const waitFor = async (expr, label, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      if (await evaluate(`!!(${expr})`)) return true
      await sleep(250)
    }
    note(`等待超时：${label}`)
    return false
  }
  const setViewport = (w, h, mobile = false, dpr = 1) =>
    cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile })

  /** 打开折角弹窗：每次重新导航，保证布局是从零算出来的 */
  const openModal = async () => {
    if (!await waitFor(`document.querySelectorAll('[data-fold-badge]').length > 0`, '折角角标')) return false
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('[data-fold-badge]')][0]
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 1
    })()`)
    const ok = await waitFor(`!!document.querySelector('[data-fold-modal]')`, '弹窗')
    await sleep(900)   // 展开动画 .mf-unfold 200ms + 布局稳定
    return ok
  }

  /** 写进一张确定的图 */
  const seed = async () => {
    /*
     * ★ 手机端「缩进列表 / Mermaid 代码」不在顶栏里（挪进了编辑面板），
     *   所以必须先切到「编辑」面板才点得到这个标签 —— 这也正是本轮
     *   修掉的那个 bug 的另一面：预览面板里本来就没有它。
     */
    await toPane('edit')
    await sleep(700)
    await evaluate(`(() => { document.querySelector('[data-mode-tab="code"]')?.click(); return 1 })()`)
    const ok = await waitFor(`document.querySelectorAll('[data-fold-modal] textarea').length > 0`, '代码编辑器')
    if (!ok) return false
    await evaluate(`(() => {
      const ta = document.querySelector('[data-fold-modal] textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(GRAPH)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return 1
    })()`)
    /*
     * ★ 必须切回「预览」再等节点。
     * 手机端一次只渲染一个面板：停在「编辑」时预览整块不在 DOM 里，
     * g.node 一个都查不到 —— 在这里等会一直等到超时（第一版就是这么写的）。
     */
    await toPane('preview')
    await sleep(700)
    const okNodes = await waitFor(`document.querySelectorAll('[data-fold-modal] g.node').length >= 4`, '4 个节点')
    await sleep(900)
    return okNodes
  }
  const toPane = (p) => evaluate(`(() => { document.querySelector('[data-pane-tab="${p}"]')?.click(); return 1 })()`)

  /**
   * CDP 真触摸长按。
   * 【为什么不用 JS 造 PointerEvent】
   * 那样只测到「我写的那个 handler」，测不到「浏览器真的会为长按生成
   * pointerdown(pointerType=touch)」——而这正是这段代码成立的前提。
   * 所以走 Input.dispatchTouchEvent，和真手指同一条链路。
   */
  const longPressAt = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
    await sleep(700)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(500)
  }
  const firstNodeCenter = () => evaluate(`(() => {
    const g = document.querySelector('[data-fold-modal] g.node')
    if (!g) return null
    const r = g.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
  })()`)

  /* ================================================================== */
  console.log('====================================================')
  console.log('  手机端折角弹窗（流程图编辑器）')
  console.log('====================================================')

  /* ---------------- [1] 手机端 · 预览面板 ---------------- */
  console.log('\n[1] 390×844 手机端 · 预览面板（默认）')
  await setViewport(390, 844, true, 2)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
  await cdp.send('Page.navigate', { url: URL_APP })
  await sleep(4500)
  check('折角弹窗打开', await openModal())
  check('图渲染完成（4 个节点）', await seed())

  {
    const hd = await evaluate(HDR)
    note(`顶栏 ${hd.hdr.w}×${hd.hdr.h} 溢出=${hd.overflowPx}px maxRight=${hd.maxRight} vw=${hd.vw}`)
    note(`顶栏控件：${JSON.stringify(hd.rects.map((r) => `${r.label || r.tag}:${r.w}×${r.h}`))}`)
    check('★ 顶栏不横向溢出（预览面板）', hd.overflowPx <= 0, `overflow=${hd.overflowPx}`)
    check('★ 顶栏每个控件的右边缘都在屏内', hd.maxRight <= hd.vw + 0.5, `maxRight=${hd.maxRight} vw=${hd.vw}`)
    check('★ 顶栏控件互不重叠', hd.overlaps.length === 0, JSON.stringify(hd.overlaps))
    check('★ ✕ 没被顶出屏幕', hd.closeInViewport, JSON.stringify({ w: hd.closeW, in: hd.closeInViewport }))
    check('★ ✕ 真实指针点得到', hd.closeHit && hd.closeW >= 26, JSON.stringify({ w: hd.closeW, hit: hd.closeHit }))
    check('★ 「预览 / 编辑」文字不换行（不是竖排柱子）',
      hd.paneTabs.length === 2 && hd.paneTabs.every((t) => !t.wrapped && t.whiteSpace === 'nowrap')
      && hd.paneTabs.every((t) => t.h <= 30),
      JSON.stringify(hd.paneTabs))
    check('分段控件自己不收缩（flex-shrink: 0）', hd.paneSwitchShrink === '0', String(hd.paneSwitchShrink))
    check('预览面板里没有「缩进列表 / Mermaid 代码」标签（减少噪音，旧行为保持）',
      hd.modeTabCount === 0, String(hd.modeTabCount))
    check('「重置熟悉度」还是紧凑图标', hd.resetText === '↺' && hd.resetH <= 30, JSON.stringify({ t: hd.resetText, h: hd.resetH }))
    check('★ 预览面板的提示是触屏文案（没有「右键」）',
      /长按/.test(hd.touchHint || '') && !/右键/.test(hd.touchHint || ''), JSON.stringify(hd.touchHint))
  }

  {
    const rw = await evaluate(ROWS)
    note(`面板工具行：${JSON.stringify(rw.rows.map((r) => `#${r.i}(${r.txt}) over=${r.over}`))}`)
    check('★ 面板内每一行都没有横向溢出',
      rw.rows.length > 0 && rw.rows.every((r) => r.over <= 0),
      JSON.stringify(rw.rows))
  }

  {
    const bar = await evaluate(BAR)
    note(`底部条：${JSON.stringify(bar.tools)} 尺寸=${JSON.stringify(bar.sizes)} 方向=${bar.rowDirection}`)
    check('★ 底部操作条存在', bar.exists, JSON.stringify(bar))
    check('★ 旧的「指向 / 指向同一结果」操作栏已删除', bar.oldMobileBar === false)
    check('★ 放大 / 缩小按钮已删除（手机上完全用不上）',
      bar.zoomIn === false && bar.zoomOut === false, JSON.stringify({ in: bar.zoomIn, out: bar.zoomOut }))
    check('★ 底部有「回到中点」（适应屏幕）', bar.zoomFit === true && /回到中点/.test(bar.zoomFitTitle || ''),
      JSON.stringify({ fit: bar.zoomFit, title: bar.zoomFitTitle }))
    check('★ 底部有撤销 + 重做，都挂在弹窗层级（bottom 档位）',
      bar.bottomUndo === 2 && bar.bottomRedo === 1, JSON.stringify({ n: bar.bottomUndo, redo: bar.bottomRedo }))
    check('★ 手机端编辑工具栏里不再有撤销 / 重做（挪到下面了）', bar.toolbarUndo === 0, String(bar.toolbarUndo))
    check('★ 「重置视图」链接在手机端已移除（动作挪到底部）', bar.resetViewLink === false)
    check('★ 手机端没有桌面那套右下角悬浮面板（含放大/缩小三连）', bar.desktopZoomPanel === false)
    check('★ 底部条是一横排（不是 152px 高的竖列）', bar.rowDirection === 'row', String(bar.rowDirection))
    check('★ 底部每个按钮热区都是 44×44', bar.sizes.length > 0 && bar.sizes.every(([w, h]) => w === 44 && h === 44),
      JSON.stringify(bar.sizes))
    check('★ 底部每个按钮真实指针都点得到', bar.hits.every(Boolean), JSON.stringify(bar.hits))
    check('★ 底部条整条在视口内', bar.allInsideViewport, JSON.stringify({ r: bar.right, b: bar.bottom, vw: bar.vw, vh: bar.vh }))
    check('页面没有横向滚动', bar.pageScrollW <= bar.pageClientW, `${bar.pageScrollW} > ${bar.pageClientW}`)
  }

  /* ---------------- [2] 手机端 · 编辑面板（就是原来溢出的那个状态） ---------------- */
  console.log('\n[2] 390×844 手机端 · 切到「编辑」面板（原来溢出的状态）')
  await toPane('edit')
  await sleep(1200)
  {
    const hd = await evaluate(HDR)
    note(`顶栏溢出=${hd.overflowPx}px maxRight=${hd.maxRight} ✕宽=${hd.closeW} ✕可点=${hd.closeHit}`)
    check('★ 编辑面板下顶栏也不溢出（本轮修的核心 bug）', hd.overflowPx <= 0, `overflow=${hd.overflowPx}`)
    check('★ 编辑面板下所有控件右边缘仍在屏内', hd.maxRight <= hd.vw + 0.5, `maxRight=${hd.maxRight} vw=${hd.vw}`)
    check('★ 编辑面板下 ✕ 仍在屏内且点得到', hd.closeInViewport && hd.closeHit, JSON.stringify({ w: hd.closeW, hit: hd.closeHit }))
    check('★ 编辑面板下 ↺ 也在屏内', hd.rects.some((r) => r.label === '↺' && r.r <= hd.vw + 0.5), JSON.stringify(hd.rects))
    check('★ 编辑面板下控件不重叠', hd.overlaps.length === 0, JSON.stringify(hd.overlaps))
    check('★ 「缩进列表 / Mermaid 代码」挪进了编辑面板（不在顶栏）',
      hd.modeTabCount === 2 && hd.editHasModeTabs === true && hd.modeTabsInHeader.length === 0,
      JSON.stringify({ total: hd.modeTabCount, inEdit: hd.editHasModeTabs, inHeader: hd.modeTabsInHeader.length }))
    check('★ 两个模式标签文字不换行',
      (await evaluate(`(() => [...document.querySelectorAll('[data-mode-tab]')].every((b) => {
        const cs = getComputedStyle(b)
        return cs.whiteSpace === 'nowrap' && b.getBoundingClientRect().height <= 30
      }))()`)) === true)
  }
  {
    const rw = await evaluate(ROWS)
    note(`编辑面板工具行：${JSON.stringify(rw.rows.map((r) => `#${r.i}(${r.txt}) over=${r.over} w=${r.w}`))}`)
    check('★ 编辑面板每一行都没有横向溢出（「字溢出了」）',
      rw.rows.length > 0 && rw.rows.every((r) => r.over <= 0), JSON.stringify(rw.rows))
  }
  {
    const bar = await evaluate(BAR)
    note(`编辑面板底部条：${JSON.stringify(bar.tools)}`)
    check('★ 编辑面板里底部操作条仍在（撤销必须一直够得到）', bar.exists && bar.bottomUndo === 2, JSON.stringify(bar.tools))
    check('编辑面板里没有「回到中点」（没有图可居中）', bar.zoomFit === false, JSON.stringify(bar.tools))
    check('编辑面板里也没有放大 / 缩小', bar.zoomIn === false && bar.zoomOut === false)
    check('编辑面板里底部按钮热区仍 44×44', bar.sizes.every(([w, h]) => w === 44 && h === 44), JSON.stringify(bar.sizes))
    check('编辑面板里底部按钮仍点得到', bar.hits.every(Boolean), JSON.stringify(bar.hits))
  }

  /* ---------------- [3] 长按 = 右键（能力不能丢） ---------------- */
  console.log('\n[3] 手机端长按节点 = 桌面右键（删掉底栏后唯一的建连线入口）')
  await toPane('preview')
  await sleep(1200)
  {
    const c = await firstNodeCenter()
    note(`长按第一个节点 @(${c.x},${c.y}) 尺寸 ${c.w}×${c.h}`)
    check('前置：找得到可长按的节点', !!c && c.w > 4 && c.h > 4, JSON.stringify(c))
    await longPressAt(c.x, c.y)
    const menu = await evaluate(MENU)
    note(`长按后菜单：${JSON.stringify(menu.items)} inside=${menu.insideViewport}`)
    check('★ 长按节点弹出节点菜单', menu.open === true, JSON.stringify(menu))
    check('★ 菜单里有「指向」「指向同一结果」（能力没丢）',
      menu.items.includes('direct') && menu.items.includes('merge'), JSON.stringify(menu.items))
    check('★ 菜单里有「移动位置」', menu.items.includes('move'), JSON.stringify(menu.items))
    check('菜单完整在视口内', menu.insideViewport === true, JSON.stringify(menu))
  }

  /*
   * ★ 回归守卫：菜单不能被「手指抬起时浏览器补发的那记 mousedown」关掉。
   *
   * 实测事故：touchend 之后 Chrome 会补发 mousedown/mouseup/click（真机上也一样），
   * 那记 mousedown 的 target 是被长按的节点、当然不在菜单里，于是
   * NodeContextMenu 的「点外面就关」把刚弹出的菜单立刻关掉 ——
   * 用户看到的是「长按一下，菜单闪一下就没了」。
   * 这里直接补一记同样的 mousedown，判菜单还在。
   */
  {
    const survived = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const g = document.querySelector('[data-fold-modal] g.node')
      if (!g) return { error: '没有节点' }
      const r = g.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const tgt = document.elementFromPoint(x, y) || g
      tgt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }))
      tgt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }))
      tgt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }))
      await sleep(350)
      return { still: !!document.querySelector('[data-node-menu]') }
    })()`)
    check('★ 兼容鼠标事件（手指抬起时补发的那套）不会把菜单关掉', survived.still === true, JSON.stringify(survived))
  }

  // 从长按菜单进入「指向」→ 十字准星 + 提示语
  {
    const entered = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      document.querySelector('[data-node-menu] [data-menu-item="direct"]')?.click()
      await sleep(500)
      const hint = document.querySelector('[data-link-hint]')
      const vp = document.querySelector('[data-graph-viewport]')
      return { mode: hint ? hint.dataset.linkMode : null, cursor: getComputedStyle(vp).cursor, menuGone: !document.querySelector('[data-node-menu]') }
    })()`)
    check('★ 从长按菜单能进入「指向」连线模式', entered.mode === 'direct', JSON.stringify(entered))
    check('连线模式下画布变十字准星', entered.cursor === 'crosshair', String(entered.cursor))
    check('选完菜单项后菜单关闭', entered.menuGone === true)
  }
  // 点空白取消
  {
    const cancelled = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const vp = document.querySelector('[data-graph-viewport]')
      const r = vp.getBoundingClientRect()
      vp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 6, clientY: r.bottom - 6 }))
      await sleep(400)
      return { mode: document.querySelector('[data-link-hint]')?.dataset.linkMode ?? null }
    })()`)
    check('★ 点空白取消连线模式', cancelled.mode === null, JSON.stringify(cancelled))
  }
  // 鼠标长按不许弹菜单（桌面有右键，长按是触屏专用）
  {
    const mouse = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const g = document.querySelector('[data-fold-modal] g.node')
      const r = g.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const target = document.elementFromPoint(x, y) || g
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX: x, clientY: y, buttons: 1 }))
      await sleep(700)
      const open = !!document.querySelector('[data-node-menu]')
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX: x, clientY: y }))
      return { open }
    })()`)
    check('★ 鼠标长按不会弹菜单（只认触屏，避免和左键拖拽打架）', mouse.open === false, JSON.stringify(mouse))
  }

  /* ---------------- [4] 更窄的屏幕也要装得下 ---------------- */
  for (const [name, w, h] of [['360×640', 360, 640], ['375×667', 375, 667], ['412×915', 412, 915]]) {
    console.log(`\n[4] ${name} 顶栏装得下吗`)
    await setViewport(w, h, true, 2)
    await cdp.send('Page.navigate', { url: URL_APP })
    await sleep(4200)
    await openModal()
    for (const pane of ['preview', 'edit']) {
      await toPane(pane)
      await sleep(900)
      const hd = await evaluate(HDR)
      const bar = await evaluate(BAR)
      note(`${name} ${pane}: overflow=${hd.overflowPx} maxRight=${hd.maxRight}/${hd.vw} ✕hit=${hd.closeHit}`)
      check(`${name} ${pane}：顶栏不溢出`, hd.overflowPx <= 0, `overflow=${hd.overflowPx}`)
      check(`${name} ${pane}：所有控件右边缘在屏内`, hd.maxRight <= hd.vw + 0.5, `maxRight=${hd.maxRight} vw=${hd.vw}`)
      check(`${name} ${pane}：✕ 在屏内且点得到`, hd.closeInViewport && hd.closeHit, JSON.stringify({ w: hd.closeW, hit: hd.closeHit }))
      check(`${name} ${pane}：分段控件文字不换行`,
        hd.paneTabs.every((t) => !t.wrapped && t.h <= 30), JSON.stringify(hd.paneTabs))
      check(`${name} ${pane}：底部操作条在视口内`, bar.allInsideViewport, JSON.stringify({ r: bar.right, b: bar.bottom }))
    }
  }

  /* ---------------- [5] 桌面端零变化 ---------------- */
  console.log('\n[5] 1440×900 桌面端：这一轮改的东西一个都不许出现')
  await setViewport(1440, 900, false, 1)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await cdp.send('Page.navigate', { url: URL_APP })
  await sleep(4500)
  await openModal()
  {
    const d = await evaluate(DESKTOP)
    note(`桌面：zoomTools=${JSON.stringify(d.zoomTools)} 撤销 floating=${d.floatingUndo} toolbar=${d.toolbarUndo}`)
    check('桌面端顶栏仍有标题', d.title === true)
    check('桌面端没有手机端的面板切换', d.paneSwitch === false)
    check('★ 桌面端「缩进列表 / Mermaid 代码」仍在顶栏里', d.modeTabsInHeader === 2, String(d.modeTabsInHeader))
    check('★ 桌面端右下角三连仍在：放大 / 缩小 / 适应屏幕',
      d.zoomPanel === true && d.zoomTools.join() === 'zoom-in,zoom-out,zoom-fit', JSON.stringify(d.zoomTools))
    check('桌面端三颗缩放按钮仍是 44×44', d.zoomSizes.every(([w, h]) => w === 44 && h === 44), JSON.stringify(d.zoomSizes))
    check('★ 桌面端撤销按钮位置没变（工具栏 2 颗 + 悬浮 1 颗）',
      d.toolbarUndo === 2 && d.floatingUndo === 1, JSON.stringify({ t: d.toolbarUndo, f: d.floatingUndo }))
    check('★ 桌面端「重置视图」链接还在', d.resetView === true)
    check('桌面端「收起编辑区」按钮还在', d.collapseBtn === true)
    check('桌面端分割线还在', d.splitter === true)
    check('★ 桌面端没有手机端底部操作条', d.mobileBottomBar === false)
    check('★ 桌面端没有触屏长按文案', d.touchHint === false)
    check('桌面端预览提示仍是「右键改结构」', /右键/.test(d.previewHint || ''), JSON.stringify(d.previewHint))
    check('桌面端「重置熟悉度」仍是完整中文', d.resetText === '重置熟悉度', String(d.resetText))
    check('桌面端顶栏不溢出', d.headerOverflow <= 0, String(d.headerOverflow))
  }

  /* ---------------- [6] 无 console 报错 ---------------- */
  console.log('\n[6] 全程无 JS 异常')
  {
    const real = consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e))
    check('没有控制台报错', real.length === 0, JSON.stringify(real.slice(0, 3)))
  }

  console.log('\n====================================================')
  console.log(`  手机端折角弹窗 mobilefold  通过 ${pass} / 失败 ${fail}`)
  console.log('====================================================')

  cdp.close()
  proc.kill()
  try { rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
  if (fail) process.exit(1)
}

main().catch((e) => { console.error('\n测试崩了：' + (e?.stack || e)); fail++ })
  .finally(() => {
    try { rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
    if (fail) process.exit(1)
  })
