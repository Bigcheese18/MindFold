/**
 * 折角弹窗「收起编辑区」浏览器端测试
 * ==================================
 * 测的是桌面端新加的那颗双态按钮：点一下收起左侧编辑区、预览独占全宽，
 * 再点一下回到左右双栏。这东西**只能在真浏览器里验**，纯函数测试证明不了：
 *   · 「右栏真的变宽了」是 flex 布局算出来的，不是某个函数返回值；
 *   · 「图没跑飞/没被裁」要看 TransformWrapper 在容器换宽之后的实际几何；
 *   · 「顶栏没被挤爆」是 flex 挤压的结果（README 坑 109：给满行 flex 塞一个
 *     没有宽度的中文按钮，它会被压窄然后中文换行，变成一根戳出顶栏的柱子）。
 *
 * 覆盖：
 *   1. 双栏基线：左栏在、分割线在、右栏 ≈ 半宽，图完整可见
 *   2. 收起：左栏与分割线**从 DOM 消失**，右栏独占全宽（记下实测像素），
 *      图重新适应后所有节点仍在视口内、缩放不为 0
 *   3. 收起后节点仍可点选（点一下 → 外形下拉框启用），证明图不是「看着在、
 *      点不到」的假象
 *   4. 展开：左栏回来、右栏宽度回到基线 ±2px，图仍完整可见
 *   5. 顶栏在 6 种桌面宽度下都不溢出、不重叠：新按钮不被压窄、不换行，
 *      「重置熟悉度」和 ✕ 仍然可见可点。并且**同时量一份「把新按钮摘掉」的
 *      对照数据**，用差值证明「溢出不是这颗按钮带来的」——
 *      README 坑 109 的教训是只看单侧数字分不清是谁挤的。
 *   6. 手机视口（390×844 / 360×640）：data-edit-collapse **不存在**，
 *      「预览 / 编辑」分段控件照旧工作（手机端必须零变化）
 *
 * 用法：node scripts/browser/collapse.mjs [url]
 *   默认 http://127.0.0.1:5173/；测构建产物时先
 *   `npx vite build --outDir dist-collapse && node scripts/serve-dist.mjs dist-collapse 5311`
 *   再 `node scripts/browser/collapse.mjs http://127.0.0.1:5311/`
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

// 端口不和其他套件撞：本项目浏览器套件占的是 9333~9375 这一段
const PORT = 9361
const userDir = mkdtempSync(join(tmpdir(), 'mf-collapse-'))

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
 * 一张确定的、**横向受限**的五节点图（LR 一排）。
 *
 * 【为什么必须是「横向受限」的图】
 * fitView(contain) 取的是「宽高两个方向里更紧的那个」：
 *   · 竖着排的图（TD）高度先顶住，容器变宽时缩放**不会变**（高度才是瓶颈），
 *     于是「收起后预览真的放大了」这件事根本量不出来 —— 不是没生效，是没差别；
 *   · LR 一排的图横向顶住，容器从 718 变 1440，contain 缩放必然跟着变大，
 *     再展开又必然回到原值。这样才能把「收起/展开各重新适应了一次」
 *     钉成数字（实测 131% → 263% → 131%）。
 */
const GRAPH = 'flowchart LR\n  A["甲"]\n  B["乙"]\n  C["丙"]\n  D["丁"]\n  E["戊"]\n  A --> B\n  B --> C\n  C --> D\n  D --> E'
const NODE_N = 5

/**
 * 一次快照，把这一节要判的东西全量出来。
 *
 * 【为什么节点位置要换算进「预览视口」的坐标系】
 * 判据是「图没被裁」，被裁的参照系必须是 data-graph-viewport（真正装图、
 * 决定 fit 的那个盒子），不能用窗口 —— 窗口比视口大，用窗口判会漏掉
 * 「节点钻到左编辑区底下」这种被遮住的情况。
 */
const SNAP = `(() => {
  const m = document.querySelector('[data-fold-modal]')
  if (!m) return { error: '弹窗没开' }
  const body = m.querySelector('[data-modal-body]')
  const edit = m.querySelector('[data-pane-section="edit"]')
  const prev = m.querySelector('[data-pane-section="preview"]')
  const split = m.querySelector('[data-splitter]')
  const vp = m.querySelector('[data-graph-viewport]')
  const collapse = m.querySelector('[data-edit-collapse]')
  const zoomEl = m.querySelector('[data-zoom-label]')
  if (!body) return { error: '主体缺失' }
  // 手机端「只渲染一个面板」：切到编辑时预览整块不在 DOM，这里必须容忍 ——
  // 直接把缺面板当成 0 宽，而不是让整个快照失效（否则会误判成弹窗没开）
  const bb = body.getBoundingClientRect()
  const pb = prev ? prev.getBoundingClientRect() : null
  const vb = vp ? vp.getBoundingClientRect() : null
  const nodes = vp ? [...m.querySelectorAll('g.node')].map((g) => {
    const r = g.getBoundingClientRect()
    return {
      label: (g.textContent || '').trim(),
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
    }
  }) : []
  // 容差 2px：fit 之后内容理论上完全在视口内，但库的边界夹取保留两位小数，
  // 这里不把亚像素差异当失败
  const outside = vb ? nodes.filter((n) => n.x < vb.left - 2 || n.y < vb.top - 2
    || n.x + n.w > vb.right + 2 || n.y + n.h > vb.bottom + 2) : []
  return {
    bodyW: Math.round(bb.width), bodyH: Math.round(bb.height),
    editExists: !!edit, editW: edit ? Math.round(edit.getBoundingClientRect().width) : 0,
    previewExists: !!prev,
    splitterExists: !!split,
    previewW: pb ? Math.round(pb.width) : 0, previewLeft: pb ? Math.round(pb.left) : 0, previewRight: pb ? Math.round(pb.right) : 0,
    viewportW: vb ? Math.round(vb.width) : 0, viewportH: vb ? Math.round(vb.height) : 0,
    collapsed: collapse ? collapse.getAttribute('aria-pressed') === 'true' : null,
    collapseText: collapse ? collapse.textContent.trim() : null,
    collapseW: collapse ? Math.round(collapse.getBoundingClientRect().width) : 0,
    collapseH: collapse ? Math.round(collapse.getBoundingClientRect().height) : 0,
    zoom: zoomEl ? zoomEl.textContent.trim() : null,
    zoomPct: zoomEl ? parseInt(zoomEl.textContent, 10) : 0,
    nodeCount: nodes.length,
    nodes: nodes.map((n) => n.label + '@' + n.x + ',' + n.y + ' ' + n.w + 'x' + n.h),
    nodesRect: nodes.map((n) => [n.x, n.y, n.w, n.h]),
    nodesOutside: outside.map((n) => n.label),
    nodesInside: nodes.length > 0 && outside.length === 0,
    pickerDisabled: (() => { const s = m.querySelector('[data-shape-picker]'); return s ? s.disabled : null })(),
  }
})()`

/**
 * 顶栏体检。
 *
 * 【为什么要把每个子元素的 rect 全量出来】
 * 「顶栏没溢出」有两种坏法：一种是整体往右戳出屏幕（scrollWidth 能看出来），
 * 另一种是某个控件被 flex 压窄后中文换行，自己变成一根高柱子（scrollWidth
 * 看不出来）。所以这里既量 maxRight，也量每个控件的 w/h，还量有没有两个
 * 子元素互相重叠。
 *
 * 【为什么要 .remove() 掉新按钮再量一遍】
 * 见文件头：只看「加完之后有没有溢出」分不清是新按钮挤的还是本来就挤。
 * 摘掉之后的差值才是这颗按钮的真实代价。
 */
const HDR = `(() => {
  const m = document.querySelector('[data-fold-modal]')
  if (!m) return { error: '弹窗没开' }
  const hdr = m.querySelector('header')
  if (!hdr) return { error: '顶栏缺失' }
  const hb = hdr.getBoundingClientRect()
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 } }
  const kids = [...hdr.children].filter((e) => e.getBoundingClientRect().width > 0)
  const rects = kids.map((e) => ({ tag: e.tagName.toLowerCase(), label: (e.textContent || '').trim().slice(0, 10), ...rect(e) }))
  const sorted = [...rects].sort((a, b) => a.l - b.l)
  const overlaps = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i].r > sorted[i + 1].l + 0.5) overlaps.push(sorted[i].label + '|' + sorted[i + 1].label)
  }
  const collapse = m.querySelector('[data-edit-collapse]')
  const reset = m.querySelector('[data-reset-familiarity]')
  const closeBtn = [...hdr.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('关闭'))
  const cr = collapse ? rect(collapse) : null
  const rr = reset ? rect(reset) : null
  const xr = closeBtn ? rect(closeBtn) : null
  const hits = (el, r) => !!el && document.elementFromPoint(r.cx, r.cy) === el
  return {
    vw: innerWidth,
    hdrLeft: Math.round(hb.left), hdrRight: Math.round(hb.right),
    overflowPx: hdr.scrollWidth - hdr.clientWidth,
    maxRight: rects.length ? Math.round(Math.max(...rects.map((r) => r.r))) : null,
    overlaps,
    maxRightChild: rects.length ? rects.reduce((a, b) => (a.r > b.r ? a : b)).label : null,
    resetText: reset ? reset.textContent.trim() : null,
    resetW: rr ? Math.round(rr.w) : 0, resetH: rr ? Math.round(rr.h) : 0, resetHit: hits(reset, rr),
    closeW: xr ? Math.round(xr.w) : 0, closeH: xr ? Math.round(xr.h) : 0, closeHit: hits(closeBtn, xr),
    collapseExists: !!collapse,
    collapseText: collapse ? collapse.textContent.trim() : null,
    collapseW: cr ? Math.round(cr.w) : 0, collapseH: cr ? Math.round(cr.h) : 0,
    collapseHit: cr ? hits(collapse, cr) : false,
    collapseInHdr: cr ? (cr.r <= hb.right + 0.5 && cr.l >= hb.left - 0.5) : false,
    paneSwitch: !!m.querySelector('[data-pane-switch]'),
    modeTab: !!m.querySelector('[data-mode-tab="outline"]'),
  }
})()`

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

  /** 等条件成立，而不是睡固定时间（同 shape.mjs：固定 sleep 会时快时慢地误判） */
  const waitFor = async (expr, label, timeoutMs = 25000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try { if (await evaluate(expr)) return true } catch { /* 还在挂载 */ }
      await sleep(200)
    }
    note(`等待超时：${label}`)
    return false
  }

  const setViewport = (width, height, mobile = false, dpr = 1) =>
    cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile })

  /** 打开折角弹窗（每个视口都重新导航，保证布局是从零算出来的） */
  const openModal = async () => {
    const badge = await waitFor(`document.querySelectorAll('[data-fold-badge]').length > 0`, '折角角标')
    if (!badge) return false
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('[data-fold-badge]')][0]
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 1
    })()`)
    const ok = await waitFor(`!!document.querySelector('[data-fold-modal]')`, '弹窗')
    await sleep(600)   // 展开动画 .mf-unfold 200ms + 布局稳定
    return ok
  }

  /** 写进一张确定的三节点图，并等 fitView 停稳 */
  const seedGraph = async () => {
    await evaluate(`(() => { document.querySelector('[data-mode-tab="code"]')?.click(); return 1 })()`)
    const okTa = await waitFor(`document.querySelectorAll('[data-fold-modal] textarea').length > 0`, '代码编辑器')
    if (!okTa) return false
    await evaluate(`(async () => {
      const ta = document.querySelector('[data-fold-modal] textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(GRAPH)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return 1
    })()`)
    const okN = await waitFor(`document.querySelectorAll('[data-fold-modal] g.node').length >= ${NODE_N}`, `${NODE_N} 个节点`)
    // fitViewSoon 是 180ms 防抖 + 200ms 缓动，等它彻底停稳再量几何
    await sleep(900)
    return okN
  }

  const snapshot = () => evaluate(SNAP)
  const header = () => evaluate(HDR)
  const clickCollapse = () => evaluate(`(() => { document.querySelector('[data-edit-collapse]')?.click(); return 1 })()`)

  /**
   * 先主动「适应屏幕」一次，再拿它当基准。
   *
   * 【为什么不能直接用弹窗首帧的那个视图当基准】
   * 实测过：首帧 fit 发生在 mermaid 标签/字体还没完全定型的时候，内容盒量出来
   * 偏大一点，于是算出的 contain 缩放是 120%；等图稳定后再 fit 是 125%。
   * 两者都是「合法的 fit」，但拿 120% 当基准去比展开后的 125% 只会得出
   * 「展开没恢复」的假结论。基准必须是**同一时刻、同一套内容尺寸**下算出来的，
   * 所以这里显式点一次「重置视图」（data-reset-view），等 200ms 缓动走完。
   */
  const resetView = async () => {
    await evaluate(`(() => { document.querySelector('[data-reset-view]')?.click(); return 1 })()`)
    await sleep(500)
  }

  /* ---------------- [0] 打开弹窗 + 铺一张确定的图 ---------------- */
  console.log('[0] 准备：1440×900 打开折角弹窗，写一张横向排列的五节点图')
  await setViewport(1440, 900)
  await cdp.send('Page.navigate', { url: URL_APP })
  check('页面挂载完成', await waitFor(`!!document.querySelector('#root')?.firstElementChild`, '#root'))
  check('折角弹窗打开', await openModal())
  check(`写入 ${NODE_N} 节点图并渲染完成`, await seedGraph())

  /* ---------------- [1] 双栏基线 ---------------- */
  console.log('\n[1] 基线：左右双栏')
  await resetView()
  const base = await snapshot()
  const w1 = base.previewW
  const z1 = base.zoomPct
  const nodeW1 = base.nodesRect[0]?.[2] ?? 0
  note(`主体宽 ${base.bodyW} / 左栏 ${base.editW} / 分割线 4 / 右栏 ${w1}（左栏右栏应各占一半减分割线）`)
  check('左栏存在', base.editExists)
  check('分割线存在', base.splitterExists)
  check('按钮初始文案是「收起编辑」', base.collapseText === '收起编辑', String(base.collapseText))
  check('初始 aria-pressed=false', base.collapsed === false, String(base.collapsed))
  check('右栏 ≈ (主体宽 - 分割线) / 2（±2px）',
    Math.abs(w1 - (base.bodyW - 4) / 2) <= 2,
    `右栏 ${w1} vs 期望 ${(base.bodyW - 4) / 2}`)
  check(`基线：${NODE_N} 个节点都在预览视口内`, base.nodesInside, `跑到视口外：${base.nodesOutside.join(',')} | ${base.nodes.join(' ')}`)
  note(`基线节点位置 ${base.nodes.join(' / ')}，缩放 ${base.zoom}，节点屏幕宽 ${nodeW1}px`)

  /* ---------------- [2] 收起 ---------------- */
  console.log('\n[2] 点「收起编辑」：左栏与分割线消失，预览独占全宽')
  await clickCollapse()
  await sleep(500)
  const col = await snapshot()
  const nodeW2 = col.nodesRect[0]?.[2] ?? 0
  note(`收起后右栏 ${col.previewW}（收起前 ${w1}，变宽 ${col.previewW - w1}）；缩放 ${base.zoom} → ${col.zoom}；节点屏幕宽 ${nodeW1} → ${nodeW2}px`)
  note(`收起后节点位置 ${col.nodes.join(' / ')}`)
  check('左栏已从 DOM 移除', !col.editExists, JSON.stringify({ editExists: col.editExists, editW: col.editW }))
  check('分割线已从 DOM 移除', !col.splitterExists)
  check('按钮文案变成「展开编辑」', col.collapseText === '展开编辑', String(col.collapseText))
  check('aria-pressed=true', col.collapsed === true, String(col.collapsed))
  check('右栏独占全宽（≥ 主体宽 - 2px）', col.previewW >= col.bodyW - 2,
    `右栏 ${col.previewW} / 主体 ${col.bodyW}`)
  check('右栏明显变大（比基线至少宽 300px）', col.previewW - w1 >= 300, `Δ=${col.previewW - w1}`)
  check('★ 收起后预览重新适应：缩放变大（不是只多了一块空白）',
    col.zoomPct > z1 + 10, `基线 ${base.zoom} → 收起后 ${col.zoom}`)
  check('★ 收起后节点在屏幕上真的变大（按比例）',
    nodeW2 > nodeW1 + 10, `${nodeW1}px → ${nodeW2}px`)
  check(`★ 收起后 ${NODE_N} 个节点仍全在预览视口内（图没跑飞/没被裁）`,
    col.nodesInside, `跑到视口外：${col.nodesOutside.join(',')} | ${col.nodes.join(' ')}`)
  check('收起后缩放不是 0（图没被压成一条线）', col.zoomPct > 0, String(col.zoom))
  // 双态按钮的两种文案都得量：只量「收起编辑」不能说明换文案后不会被压窄
  check('★ 收起态「展开编辑」同样没被压窄/没换行（宽度 ≈「收起编辑」）',
    col.collapseW >= base.collapseW - 1 && col.collapseH <= 30,
    `收起编辑 ${base.collapseW}×${base.collapseH} → 展开编辑 ${col.collapseW}×${col.collapseH}`)

  /* ---------------- [3] 收起后节点仍可点选 ---------------- */
  console.log('\n[3] 收起后节点仍可点选（证明图在可点的位置，不是「看着在点不到」）')
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const g = document.querySelector('[data-fold-modal] g.node')
    if (!g) return 0
    const b = g.getBoundingClientRect()
    const o = { bubbles: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, button: 0 }
    g.dispatchEvent(new MouseEvent('mousedown', o))
    g.dispatchEvent(new MouseEvent('mouseup', o))
    g.dispatchEvent(new MouseEvent('click', o))
    await sleep(700)
    return 1
  })()`)
  const picked = await snapshot()
  check('★ 点选节点后外形下拉框启用（选中真的生效了）',
    picked.pickerDisabled === false, `pickerDisabled=${picked.pickerDisabled}`)

  /* ---------------- [4] 展开 ---------------- */
  console.log('\n[4] 点「展开编辑」：回到双栏，宽度回到基线')
  await clickCollapse()
  await sleep(500)
  const exp = await snapshot()
  note(`展开后右栏 ${exp.previewW}（基线 ${w1}，差 ${exp.previewW - w1}）；缩放 ${col.zoom} → ${exp.zoom}（基线 ${base.zoom}）`)
  note(`展开后节点位置 ${exp.nodes.join(' / ')}`)
  check('左栏回来了', exp.editExists)
  check('分割线回来了', exp.splitterExists)
  check('按钮文案变回「收起编辑」', exp.collapseText === '收起编辑', String(exp.collapseText))
  check('aria-pressed=false', exp.collapsed === false, String(exp.collapsed))
  check('★ 右栏宽度回到基线 ±2px', Math.abs(exp.previewW - w1) <= 2, `展开 ${exp.previewW} vs 基线 ${w1}`)
  check('★ 展开后预览重新适应：缩放回到基线（±2 个百分点，否则图会被裁/跑偏）',
    Math.abs(exp.zoomPct - z1) <= 2, `基线 ${base.zoom} / 收起 ${col.zoom} / 展开 ${exp.zoom}`)
  const driftPx = exp.nodesRect.length === base.nodesRect.length
    ? exp.nodesRect.map((r, i) => Math.max(...r.map((v, j) => Math.abs(v - base.nodesRect[i][j]))))
    : [999]
  check('★ 展开后每个节点的屏幕几何都回到基线（±2px）',
    driftPx.every((d) => d <= 2), `最大漂移 ${Math.max(...driftPx)}px`)
  check('★ 展开态「收起编辑」宽度也回到基线（±1px，没有因为换文案而跳宽）',
    Math.abs(exp.collapseW - base.collapseW) <= 1,
    `基线 ${base.collapseW} → 展开态 ${exp.collapseW}`)
  check(`★ 展开后 ${NODE_N} 个节点仍全在预览视口内`,
    exp.nodesInside, `跑到视口外：${exp.nodesOutside.join(',')} | ${exp.nodes.join(' ')}`)

  /* ---------------- [5] 顶栏不溢出（多种桌面宽度） ---------------- */
  console.log('\n[5] 顶栏体检：6 种桌面宽度，含「摘掉新按钮」的对照')
  /*
   * 768 是本项目 stacked 的断点（w < 768 才算窄屏），所以 769 是最挤的桌面宽度，
   * 必须测；周围再铺几个常用宽度，看趋势是不是单调的。
   */
  const DESKTOP = [
    ['1440×900', 1440, 900],
    ['1280×800', 1280, 800],
    ['1024×768', 1024, 768],
    ['900×700', 900, 700],
    ['800×700', 800, 700],
    ['769×700（贴着断点）', 769, 700],
  ]
  for (const [name, w, h] of DESKTOP) {
    await setViewport(w, h)
    await cdp.send('Page.navigate', { url: URL_APP })
    await openModal()
    const hd = await header()
    if (hd.error) { check(`${name} 顶栏可测`, false, JSON.stringify(hd)); continue }

    note(`${name} 栏宽 ${hd.hdrLeft}~${hd.hdrRight}，子元素最右 ${hd.maxRight}，溢出 ${hd.overflowPx}px，重叠 ${hd.overlaps.length}` +
      `，收起按钮 ${hd.collapseW}×${hd.collapseH}px「${hd.collapseText}」`)
    check(`${name} 顶栏内容不溢出（scrollWidth ≤ clientWidth）`, hd.overflowPx <= 0, `溢出 ${hd.overflowPx}px`)
    check(`${name} 所有子元素右边缘 ≤ 顶栏右边缘`, hd.maxRight <= hd.hdrRight + 0.5,
      `maxRight=${hd.maxRight} 顶栏右边=${hd.hdrRight}`)
    check(`${name} 子元素之间没有重叠`, hd.overlaps.length === 0, hd.overlaps.join(','))
    check(`${name} 收起按钮在顶栏里且没被压窄/没换行`,
      hd.collapseExists && hd.collapseW >= 60 && hd.collapseH <= 30 && hd.collapseInHdr,
      JSON.stringify({ w: hd.collapseW, h: hd.collapseH, text: hd.collapseText, inHdr: hd.collapseInHdr }))
    check(`${name} 收起按钮点得到`, hd.collapseHit)
    check(`${name} 「重置熟悉度」没被压窄且点得到`,
      hd.resetText === '重置熟悉度' && hd.resetW >= 60 && hd.resetH <= 30 && hd.resetHit,
      JSON.stringify({ text: hd.resetText, w: hd.resetW, h: hd.resetH, hit: hd.resetHit }))
    check(`${name} ✕ 没被压扁且点得到`,
      hd.closeW >= 26 && hd.closeH <= 30 && hd.closeHit,
      JSON.stringify({ w: hd.closeW, h: hd.closeH, hit: hd.closeHit }))

    // 对照：把新按钮摘掉再量一遍 —— 差值就是这颗按钮真实的「挤占成本」
    await evaluate(`(() => {
      const c = document.querySelector('[data-edit-collapse]')
      if (c) c.remove()
      return 1
    })()`)
    const hdNo = await header()
    note(`${name} 对照（摘掉收起按钮）：溢出 ${hdNo.overflowPx}px，最右 ${hdNo.maxRight}，重叠 ${hdNo.overlaps.length}` +
      ` → 新按钮带来的增量：溢出 ${hd.overflowPx - hdNo.overflowPx}px、最右 ${hd.maxRight - hdNo.maxRight}px`)
    check(`${name} 摘掉按钮后同样不溢出（说明溢出与否不是它单独造成的）`,
      hdNo.overflowPx <= 0 && hdNo.maxRight <= hdNo.hdrRight + 0.5, JSON.stringify(hdNo))
    check(`${name} 加按钮后溢出量 ≤ 摘掉时 + 0px（没有凭空多出溢出）`,
      hd.overflowPx <= hdNo.overflowPx, `加 ${hd.overflowPx} vs 减 ${hdNo.overflowPx}`)
  }

  /* ---------------- [6] 手机端必须零变化 ---------------- */
  console.log('\n[6] 手机视口：没有收起按钮，「预览 / 编辑」照旧')
  for (const [name, w, h] of [['390×844', 390, 844], ['360×640', 360, 640]]) {
    await setViewport(w, h, true, 2)
    await cdp.send('Page.navigate', { url: URL_APP })
    await openModal()
    const hd = await header()
    const sm = await snapshot()
    check(`${name} 手机端没有 data-edit-collapse`, hd.collapseExists === false,
      JSON.stringify({ exists: hd.collapseExists }))
    check(`${name} 「预览 / 编辑」分段控件还在`, hd.paneSwitch === true)
    check(`${name} 顶栏不溢出（手机端行为零变化）`,
      hd.overflowPx <= 0 && hd.maxRight <= hd.hdrRight + 0.5 && hd.overlaps.length === 0,
      JSON.stringify({ overflow: hd.overflowPx, maxRight: hd.maxRight, hdrRight: hd.hdrRight, overlaps: hd.overlaps }))
    check(`${name} 「重置熟悉度」仍是紧凑图标且不换行`, hd.resetText === '↺' && hd.resetH <= 30,
      JSON.stringify({ text: hd.resetText, h: hd.resetH }))
    check(`${name} ✕ 没被压扁且点得到`, hd.closeW >= 26 && hd.closeHit, JSON.stringify({ w: hd.closeW, hit: hd.closeHit }))
    check(`${name} 手机端只渲染一个面板（默认预览，编辑面板不在 DOM）`,
      !sm.editExists,
      JSON.stringify({ edit: sm.editExists, previewW: sm.previewW, bodyW: sm.bodyW }))
    check(`${name} 默认预览面板独占全宽`, sm.previewW >= sm.bodyW - 2,
      JSON.stringify({ previewW: sm.previewW, bodyW: sm.bodyW }))

    // 切到「编辑」→ 编辑面板出现、预览消失；再切回「预览」→ 反过来
    await evaluate(`(() => { document.querySelector('[data-pane-tab="edit"]')?.click(); return 1 })()`)
    await sleep(400)
    const onEdit = await snapshot()
    check(`${name} 切到「编辑」：编辑面板在、预览不在`,
      onEdit.editExists && onEdit.editW >= onEdit.bodyW - 2,
      JSON.stringify({ edit: onEdit.editExists, editW: onEdit.editW, bodyW: onEdit.bodyW }))
    await evaluate(`(() => { document.querySelector('[data-pane-tab="preview"]')?.click(); return 1 })()`)
    await sleep(400)
    const onPrev = await snapshot()
    check(`${name} 切回「预览」：预览面板在、编辑不在`,
      !onPrev.editExists && onPrev.previewW >= onPrev.bodyW - 2,
      JSON.stringify({ edit: onPrev.editExists, previewW: onPrev.previewW, bodyW: onPrev.bodyW }))
  }

  /* ---------------- [7] 无控制台报错 ---------------- */
  console.log('\n[7] 全程无 JS 异常 / mermaid 解析错')
  const real = consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e))
  check('没有控制台报错', real.length === 0, real.slice(0, 3).join(' | '))

  cdp.close()
  proc.kill()
}

main()
  .catch((e) => { console.error('\n测试崩了：' + (e?.stack || e)); fail++ })
  .finally(() => {
    try { rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
    console.log(`\n${'='.repeat(46)}`)
    console.log(`  折角弹窗「收起编辑区」（浏览器端）  通过 ${pass} / 失败 ${fail}`)
    console.log('='.repeat(46))
    process.exit(fail ? 1 : 0)
  })
