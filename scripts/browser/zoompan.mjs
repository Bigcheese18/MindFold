/**
 * 折角弹窗右侧预览区：缩放 / 平移 端到端测试
 * ============================================
 * 这一套只测「库接进来了、并且按要求配置」——
 * 真正的缩放数学由 react-zoom-pan-pinch 负责，我们不该重复测它，
 * 但**我们对它的配置**（什么时候允许缩放、什么时候允许平移）必须逐条验证，
 * 因为那些正是会踩坑的地方。
 *
 * 覆盖需求逐条：
 *   一·1/2/3  TransformWrapper / TransformComponent 包裹，0.2~3 倍，初始 1 倍，居中
 *   一·4      Mermaid 渲染完成后自动 fitView（图确实被缩放并居中，不是停在 1 倍）
 *   二·1      普通滚轮**直接**缩放（不需要 Ctrl），且以光标为锚点；
 *             触控板捏合（伪装成 ctrlKey 的 wheel）用更细的步长
 *   二·2      左键拖空白 = 平移；左键拖节点**不平移**（否则点节点会被当成拖画布）
 *   三·1      双指捏合能缩放（触摸事件没有被拦截）
 *   三·2      右下角半透明悬浮面板：3 颗 44×44 按钮、active:scale-95、不穿透
 *   四·1      双击节点弹改字框，**不缩放**（doubleClick 必须 disabled）
 *   四·2      节点上右键正常弹 ContextMenu
 *   四·3      visualViewport 尺寸变化（虚拟键盘）后重新适应，图不会跑出视口
 *   四·4      顶部「重置视图」与右下角「适应屏幕」联动（同一个动作）
 *
 * 需要 dev server 已启动：npm run dev
 * 用法：node scripts/zoompan.mjs [url]
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

const PORT = 9369
const userDir = mkdtempSync(join(tmpdir(), 'mf-zoompan-'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (msg) => console.log(`  · ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 一张「很高」的图：装不下，才能验证 fitView 真的缩放了，以及滚轮平移有意义 */
const TALL = ['flowchart TD']
for (let i = 0; i < 12; i++) TALL.push(`  n${i}["节点 ${i}"]`)
for (let i = 0; i < 11; i++) TALL.push(`  n${i} --> n${i + 1}`)
const TALL_SRC = TALL.join('\n')

/* 一张小图：用来验证 fit 会把小图放大到贴合 */
const SMALL_SRC = 'flowchart TD\n  A["开始"]\n  B["结束"]\n  A --> B'

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
  await sleep(5000)

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }

  /* ---------------- 打开弹窗，进入代码模式 ---------------- */
  console.log('\n[0] 准备')
  const opened = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const hit = [...document.querySelectorAll('[data-fold-badge]')][0]
    if (!hit) return { error: '找不到折角角标' }
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(2500)
    const tab = document.querySelector('[data-mode-tab="code"]')
    if (!tab) return { error: '找不到代码模式标签' }
    tab.click()
    await sleep(600)
    return { ok: true }
  })()`)
  check('弹窗打开并切到代码模式', opened.ok === true, JSON.stringify(opened))

  const writeCode = (src) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    if (!ta) return { error: '找不到代码编辑器' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(src)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(1800)
    return { ok: true }
  })()`)

  /**
   * 读出当前变换（库把它写成 content 层的 matrix）。
   * matrix(a, b, c, d, e, f) → scale = a, x = e, y = f
   */
  const transform = () => evaluate(`(() => {
    const c = document.querySelector('[data-graph-viewport] .react-transform-component')
    if (!c) return null
    const m = new DOMMatrixReadOnly(getComputedStyle(c).transform)
    return { scale: m.a, x: m.e, y: m.f }
  })()`)

  const viewportRect = () => evaluate(`(() => {
    const el = document.querySelector('[data-graph-viewport]')
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
             cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  })()`)

  /** 真实滚轮：modifiers 1=Alt 2=Ctrl 4=Meta 8=Shift */
  const wheel = async (x, y, deltaY, modifiers = 0) => {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers,
    })
    await sleep(260)
  }

  const drag = async (fromX, fromY, toX, toY, steps = 8, button = 'left') => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button, clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', button, buttons: button === 'left' ? 1 : 2,
        x: fromX + (toX - fromX) * (i / steps),
        y: fromY + (toY - fromY) * (i / steps),
      })
      await sleep(22)
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button, clickCount: 1 })
    await sleep(320)
  }

  const realClick = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(280)
  }

  /** 某个 mermaid 节点的屏幕中心 */
  const nodePoint = (id) => evaluate(`(() => {
    const s = document.querySelector('[data-fold-modal]')
    for (const g of s.querySelectorAll('g.node')) {
      const m = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      if (m && m[1] === ${JSON.stringify(id)}) {
        const r = g.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
      }
    }
    return null
  })()`)

  /**
   * 「适应屏幕」。
   *
   * 【为什么不能只点 [data-reset-view]】
   * 那是顶栏预览条上的文字链接，**手机端已经没有它了** ——
   * 本轮按用户要求把「回到中点」挪到了底部操作条
   * （`[data-mobile-bottom-bar] [data-zoom-btn="zoom-fit"]`）。
   * 两处按钮调的是同一个 fitView，所以这里按「哪个在就点哪个」，
   * 桌面 / 手机走同一个动作，不必按宽度分支。
   */
  const resetFit = async () => {
    const which = await evaluate(`(() => {
      const a = document.querySelector('[data-reset-view]')
      if (a) { a.click(); return 'top' }
      const b = document.querySelector('[data-mobile-bottom-bar] [data-zoom-btn="zoom-fit"]')
      if (b) { b.click(); return 'bottom' }
      return 'none'
    })()`)
    if (which === 'none') throw new Error('找不到「适应屏幕」按钮（顶栏重置视图 / 底部回到中点都没有）')
    await sleep(500)
  }

  /* ================================================================== */
  console.log('\n[1] 库的包裹结构与基础配置（一·1/2/3）')
  /* ================================================================== */

  await writeCode(TALL_SRC)
  const dom = await evaluate(`(() => {
    const vp = document.querySelector('[data-graph-viewport]')
    return {
      wrapper: !!vp.querySelector('.react-transform-wrapper'),
      content: !!vp.querySelector('.react-transform-component'),
      canvas: !!vp.querySelector('[data-graph-canvas]'),
      svgInsideCanvas: !!vp.querySelector('[data-graph-canvas] svg'),
      svgInsideContent: !!vp.querySelector('.react-transform-component svg'),
      canvasHasInlineTransform: (() => {
        const c = vp.querySelector('[data-graph-canvas]')
        return c ? /translate|scale/.test(c.style.transform || '') : null
      })(),
      label: vp.parentElement.querySelector('[data-zoom-label]')?.textContent ?? null,
    }
  })()`)
  note(`结构：${JSON.stringify(dom)}`)
  check('★ 用 TransformWrapper 包裹了预览区', dom.wrapper === true)
  check('★ 用 TransformComponent 包裹了内容', dom.content === true)
  check('★ Mermaid 的 SVG 在 TransformComponent 内部渲染', dom.svgInsideContent === true)
  check('★ 老实现的手写 transform 已移除（内容层没有 inline transform）',
    dom.canvasHasInlineTransform === false, String(dom.canvasHasInlineTransform))

  // 配置：从库实例读 setup
  const cfg = await evaluate(`(() => {
    const inst = document.querySelector('[data-graph-viewport] .react-transform-wrapper')
    return null
  })()`)
  // 库把配置放在闭包里，读不到就直接验证**行为**：
  //   minScale=0.2 / maxScale=3 靠狂滚验证边界
  await resetFit()
  const fitState = await transform()
  note(`fit 后：scale=${fitState.scale.toFixed(3)}`)
  check('★ fitView 生效（图没有停在 1 倍，而是被缩放以装进视口）',
    Math.abs(fitState.scale - 1) > 0.02, String(fitState.scale))
  check('fit 后缩放落在 0.2 ~ 3 之间',
    fitState.scale >= 0.2 && fitState.scale <= 3, String(fitState.scale))

  // 狂滚到上限
  const vr = await viewportRect()
  for (let i = 0; i < 40; i++) await wheel(vr.cx, vr.cy, -120, 2)
  /*
   * 必须等「回弹」结束再断言。
   *
   * 库的滚轮缩放刻意允许**冲过**上下限（padding = zoomAnimation.size = 0.4），
   * 松手后再用 200ms 动画弹回真正的边界 —— 这是「拉过头会弹回来」的手感，
   * 不是 bug。实测时序：3.4 →(200ms) 3.153 →(400ms) 3.000 →(之后恒为 3.000)。
   * 在动画中途断言就会读到 3.06 这种中间值，把正确行为报成失败。
   */
  await sleep(800)
  const maxed = await transform()
  note(`狂滚放大并回弹后：scale=${maxed.scale.toFixed(3)}`)
  check('★ 放大有上限（maxScale = 3）', maxed.scale <= 3.001, String(maxed.scale))
  check('★ 回弹后正好停在上限 3.0', Math.abs(maxed.scale - 3) < 0.01, String(maxed.scale))
  check('确实放大了（说明 Ctrl+滚轮在缩放）', maxed.scale > fitState.scale, `${fitState.scale} → ${maxed.scale}`)

  for (let i = 0; i < 70; i++) await wheel(vr.cx, vr.cy, 120, 2)
  await sleep(800)
  const minned = await transform()
  note(`狂滚缩小并回弹后：scale=${minned.scale.toFixed(3)}`)
  check('★ 缩小有下限（minScale = 0.2）', minned.scale >= 0.199, String(minned.scale))
  check('★ 回弹后正好停在下限 0.2', Math.abs(minned.scale - 0.2) < 0.01, String(minned.scale))

  /* ================================================================== */
  console.log('\n[2] 普通滚轮直接缩放（无需 Ctrl）+ 触控板精细步长')
  /* ================================================================== */

  /*
   * 【已从「普通滚轮不缩放」改为「普通滚轮直接缩放」】
   * 老行为要求按住 Ctrl 才缩放，不按就是上下平移 —— 结果最常见的动作
   * 「鼠标放在图上直接滚一下想放大」毫无反应，只能去点右下角按钮。
   * 现在滚轮默认缩放，平移交给拖拽。
   */
  await resetFit()
  const beforePlain = await transform()
  await wheel(vr.cx, vr.cy, -240, 0)
  await sleep(600)
  const afterPlain = await transform()
  note(`普通滚轮（向上）：scale ${beforePlain.scale.toFixed(4)} → ${afterPlain.scale.toFixed(4)}`)
  check('★ 普通滚轮向上 → 放大（不需要按 Ctrl）',
    afterPlain.scale > beforePlain.scale,
    `${beforePlain.scale} → ${afterPlain.scale}`)

  // 向下滚 = 缩小
  const beforeDown = await transform()
  await wheel(vr.cx, vr.cy, 240, 0)
  await sleep(600)
  const afterDown = await transform()
  note(`普通滚轮（向下）：scale ${beforeDown.scale.toFixed(4)} → ${afterDown.scale.toFixed(4)}`)
  check('★ 普通滚轮向下 → 缩小',
    afterDown.scale < beforeDown.scale,
    `${beforeDown.scale} → ${afterDown.scale}`)

  /*
   * 触控板捏合：浏览器把它伪装成 ctrlKey=true 的 wheel 事件。
   *
   * 【为什么不能拿同一个 deltaY 去比两个通道】
   * 两种设备的 deltaY 量级完全不同：
   *   · 鼠标滚轮一格 deltaY ≈ 100，事件稀疏（离散的「格」）
   *   · 触控板捏合一帧 deltaY ≈ 1~10，事件极密（60/秒）
   * 缩放是 exp(-deltaY × step)，所以「谁更精细」必须**按各自真实幅度**
   * 比每事件的变化率，拿 -240 去比会得出「触控板缩放更猛」的错误结论
   * （第一版就是这么误报的）。
   */
  const zoomPerEvent = (deltaY, mods) => wheel(vr.cx, vr.cy, deltaY, mods)

  await resetFit()
  const tb = await transform()
  await zoomPerEvent(-4, 2)            // 触控板一帧
  await sleep(600)
  const ta = await transform()
  const trackpadPerEvent = Math.abs(ta.scale / tb.scale - 1)

  await resetFit()
  const mb = await transform()
  await zoomPerEvent(-100, 0)          // 鼠标一格
  await sleep(600)
  const ma = await transform()
  const mousePerEvent = Math.abs(ma.scale / mb.scale - 1)

  note(`每事件变化率：触控板 ${(trackpadPerEvent * 100).toFixed(1)}% / 鼠标 ${(mousePerEvent * 100).toFixed(1)}%`)
  check('★ 触控板捏合的**每事件**步长比鼠标滚轮更精细',
    trackpadPerEvent > 0 && trackpadPerEvent < mousePerEvent,
    `触控板=${(trackpadPerEvent * 100).toFixed(1)}% 鼠标=${(mousePerEvent * 100).toFixed(1)}%`)
  check('★ 触控板捏合确实生效（不是「更精细」到等于没动）',
    trackpadPerEvent > 0.005,
    `${(trackpadPerEvent * 100).toFixed(2)}%`)

  /*
   * ★ 灵敏度必须和主画布**完全一致**（用户反馈「弹窗里滚轮太钝」）。
   *
   * 两边用的是同一个常数 `WHEEL_STEP = 0.0015`、同一个公式
   * `factor = exp(-deltaY × step)`，所以一格鼠标滚轮（deltaY ≈ 100）
   * 理论上就是 +16.2%，**上下限对称**。
   *
   * 【那为什么之前实测明显更钝】
   * 库的 `zoomToPoint(scale, x, y, animationTime = 300)` 默认带 300ms 缓动。
   * 滚轮一格一个事件、几十毫秒后下一格又来，每格都在上一段动画没走完时
   * 另起一段 —— 实际落点只有目标的一小截。修法是显式传 `animationTime = 0`
   * （库内部走 `animate()` 的 `animationTime === 0` 分支，同步 setState）。
   *
   * 这条断言就是那个修复的看门狗：**单事件涨幅**必须落在理论值附近。
   * 容差取 ±2.5 个百分点，覆盖库内部 `roundNumber(scale, 2)` 的两位小数取整。
   */
  const WHEEL_STEP = 0.0015     // 与 previewConfig.WHEEL_STEP / Canvas.onWheel 同一个常数
  const NOTCH = 100             // 鼠标滚轮一格在 Chromium 下的 deltaY
  const theory = (Math.exp(NOTCH * WHEEL_STEP) - 1) * 100
  note(`理论单格涨幅 ${theory.toFixed(1)}%（exp(100 × 0.0015)），实测 ${(mousePerEvent * 100).toFixed(1)}%`)
  check('★ 单格滚轮涨幅 ≈ 主画布的理论值 16.2%（不再被 300ms 动画吃掉）',
    Math.abs(mousePerEvent * 100 - theory) <= 2.5,
    `实测 ${(mousePerEvent * 100).toFixed(1)}% vs 理论 ${theory.toFixed(1)}%`)

  /* ================================================================== */
  console.log('\n[3] Ctrl + 滚轮缩放，且以光标为锚点（二·1）')
  /* ================================================================== */

  await resetFit()
  // 缩到**中间区间**再测锚点：贴在上限时缩放被夹住，位置变化来自回弹动画，
  // 测出来的「锚点漂移」是假阳性（第一版就是这么误报的）
  /*
   * 用循环「一格一格推到中段」而不是写死滚几下 ——
   * 每格的增量取决于 deltaY（smooth 模式下是 step × |deltaY|），
   * 写死次数会把测试绑死在某个具体步长上，改一下手感就红。
   */
  for (let i = 0; i < 20; i++) {
    if ((await transform()).scale >= 1.0) break
    await wheel(vr.cx, vr.cy, -120, 2)
    await sleep(320)
  }
  await sleep(500)
  const b4 = await transform()
  check('前置：处于中间缩放区间（便于验证锚点）',
    b4.scale > 0.9 && b4.scale < 2.9, String(b4.scale))

  // 锚点验证：光标下的**内容坐标**在缩放前后应当基本不动
  const px = vr.left + vr.width * 0.25
  const py = vr.top + vr.height * 0.3
  const contentAt = (t, cx, cy) => ({ x: (cx - vr.left - t.x) / t.scale, y: (cy - vr.top - t.y) / t.scale })
  const anchorBefore = contentAt(b4, px, py)

  await wheel(px, py, -120, 2)
  await sleep(600)
  const af = await transform()
  const anchorAfter = contentAt(af, px, py)
  note(`缩放 ${b4.scale.toFixed(3)} → ${af.scale.toFixed(3)}`)
  note(`锚点内容坐标 (${anchorBefore.x.toFixed(1)}, ${anchorBefore.y.toFixed(1)}) → `
    + `(${anchorAfter.x.toFixed(1)}, ${anchorAfter.y.toFixed(1)})`)
  check('Ctrl + 滚轮确实放大了', af.scale > b4.scale, `${b4.scale} → ${af.scale}`)
  check('★ 缩放以**光标位置**为锚点（光标下的内容几乎不动）',
    Math.abs(anchorAfter.x - anchorBefore.x) < 8 && Math.abs(anchorAfter.y - anchorBefore.y) < 8,
    `Δ=(${(anchorAfter.x - anchorBefore.x).toFixed(1)}, ${(anchorAfter.y - anchorBefore.y).toFixed(1)})`)

  /* ================================================================== */
  console.log('\n[3b] 滚轮作用域隔离：左侧代码编辑器不受影响（极其重要）')
  /* ================================================================== */

  /*
   * 滚轮缩放只能绑在右侧图容器上。左侧代码编辑器是它的**兄弟节点**，
   * 鼠标在左边滚动必须是正常的文本上下滚动，绝不能缩放右边的图。
   *
   * 这一条如果失守，用户就没法在左侧翻看长代码了 —— 是本需求里
   * 最容易被「顺手挂到 document 上」而破坏的约束，所以单独钉死。
   */
  {
    // 先让左编辑器有可滚动的空间
    /*
     * 滚动容器是外层 [data-code-editor]（overflow-auto 的 div），
     * 真正接收滚轮的是它；textarea 自身不滚动。所以这里量 div 的 scrollTop。
     */
    const ed = await evaluate(`(() => {
      const el = document.querySelector('[data-code-editor]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        scrollH: el.scrollHeight, clientH: el.clientHeight,
        scrollTop: el.scrollTop,
        cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      }
    })()`)
    check('能找到左侧代码编辑器', ed != null, JSON.stringify(ed))

    if (ed) {
      const beforeScale = (await transform()).scale
      const readScroll = () => evaluate(
        `(() => { const el = document.querySelector('[data-code-editor]'); return el ? el.scrollTop : -1 })()`)
      const beforeScroll = await readScroll()

      // 在左侧编辑器上滚动
      await wheel(ed.cx, ed.cy, -240, 0)
      await sleep(400)

      const afterScale = (await transform()).scale
      const afterScroll = await readScroll()

      note(`左编辑器滚轮：图 scale ${beforeScale.toFixed(4)} → ${afterScale.toFixed(4)}；`
        + `编辑器 scrollTop ${beforeScroll} → ${afterScroll}`)
      check('★ 在左侧编辑器上滚轮**完全不改变图的缩放**',
        Math.abs(afterScale - beforeScale) < 1e-6,
        `${beforeScale} → ${afterScale}`)
      check('★ 左侧编辑器的滚动没有被拦截（scrollTop 能变，或本就无滚动空间）',
        afterScroll !== beforeScroll || ed.scrollH <= ed.clientH,
        `scrollTop ${beforeScroll} → ${afterScroll}（scrollH=${ed.scrollH} clientH=${ed.clientH}）`)
    }
  }

  /* ================================================================== */
  console.log('\n[4] 左键拖拽：空白平移 / 节点不平移（二·2）')
  /* ================================================================== */

  // 放大到超过视口，平移才有空间（fit 之后内容是装得下的，拖不动）
  await resetFit()
  for (let i = 0; i < 10; i++) await wheel(vr.cx, vr.cy, -120, 2)
  await sleep(800)   // 等回弹结束，否则拖动期间缩放还在变，会被误判成「平移改了缩放」
  const zoomed = await transform()
  note(`放大到 ${zoomed.scale.toFixed(3)} 后再测平移`)

  // 4a. 空白处拖拽
  const blankX = vr.left + 24
  const blankY = vr.bottom - 24
  const beforePan = await transform()
  await drag(blankX, blankY, blankX + 70, blankY - 50)
  const afterPan = await transform()
  note(`拖空白：x ${beforePan.x.toFixed(1)} → ${afterPan.x.toFixed(1)}，y ${beforePan.y.toFixed(1)} → ${afterPan.y.toFixed(1)}`)
  check('★ 左键拖空白会平移画布',
    Math.abs(afterPan.x - beforePan.x) > 8 || Math.abs(afterPan.y - beforePan.y) > 8,
    `Δ=(${(afterPan.x - beforePan.x).toFixed(1)}, ${(afterPan.y - beforePan.y).toFixed(1)})`)
  check('平移不改变缩放', Math.abs(afterPan.scale - beforePan.scale) < 1e-6)

  // 4b. 节点上拖拽 → 不能平移
  const np = await nodePoint('n6')
  check('能定位到一个节点用于拖拽测试', np != null, JSON.stringify(np))
  if (np) {
    /*
     * 起手前先让上一段（滚轮 + 拖空白）彻底静下来。
     *
     * react-zoom-pan-pinch 自己带一个 ResizeObserver：尺寸/边界一变就把
     * 位置**挪回边界内**（只挪位置、不改缩放）。它是异步的，所以偶尔会在
     * 我们读 beforeNodeDrag 之后才落地，表现为「拖节点时画布动了 2px」的
     * 假失败（实测 1/5 次，Δ=(0.0, -2.0)）。
     *
     * 容差取 4px：真正的「panning.excluded 失效」会让画布跟着拖拽走
     * 80px 左右，4px 与它差 20 倍，仍然抓得住。
     */
    await sleep(300)
    const beforeNodeDrag = await transform()
    await drag(np.x, np.y, np.x + 80, np.y - 60)
    const afterNodeDrag = await transform()
    note(`拖节点：x ${beforeNodeDrag.x.toFixed(1)} → ${afterNodeDrag.x.toFixed(1)}，`
      + `y ${beforeNodeDrag.y.toFixed(1)} → ${afterNodeDrag.y.toFixed(1)}`)
    check('★ 左键拖**节点**不会平移画布（panning.excluded 生效）',
      Math.abs(afterNodeDrag.x - beforeNodeDrag.x) < 4 && Math.abs(afterNodeDrag.y - beforeNodeDrag.y) < 4,
      `Δ=(${(afterNodeDrag.x - beforeNodeDrag.x).toFixed(1)}, ${(afterNodeDrag.y - beforeNodeDrag.y).toFixed(1)})`)
  }

  /*
   * 4c. 右键拖拽 → 也不平移（右键留给右键菜单）。
   *
   * 【为什么单测这一条】
   * `allowRightClickPan: false` 并不能靠「右键菜单还能不能弹出来」验证 ——
   * 在 mousedown 上 preventDefault **不会**抑制 contextmenu（要拦它得在
   * contextmenu 事件本身上 preventDefault）。所以把这一项改回 true，
   * 菜单照样能弹、测试照样绿。它真正决定的是「右键拖拽会不会拖动画布」，
   * 那才是可观测的差异，必须单独断言。
   */
  {
    const beforeRightDrag = await transform()
    await drag(blankX, blankY, blankX + 80, blankY - 60, 8, 'right')
    const afterRightDrag = await transform()
    note(`右键拖空白：x ${beforeRightDrag.x.toFixed(1)} → ${afterRightDrag.x.toFixed(1)}，`
      + `y ${beforeRightDrag.y.toFixed(1)} → ${afterRightDrag.y.toFixed(1)}`)
    check('★ 右键拖拽不会平移画布（allowRightClickPan: false）',
      Math.abs(afterRightDrag.x - beforeRightDrag.x) < 4 && Math.abs(afterRightDrag.y - beforeRightDrag.y) < 4,
      `Δ=(${(afterRightDrag.x - beforeRightDrag.x).toFixed(1)}, ${(afterRightDrag.y - beforeRightDrag.y).toFixed(1)})`)
  }

  /* ================================================================== */
  console.log('\n[5] 右下角悬浮面板（三·2）')
  /* ================================================================== */

  const panel = await evaluate(`(() => {
    const p = document.querySelector('[data-zoom-panel]')
    if (!p) return null
    const btns = [...p.querySelectorAll('[data-zoom-btn]')]
    const pr = p.getBoundingClientRect()
    const box = p.querySelector('div')
    const cs = box ? getComputedStyle(box) : null
    return {
      tools: btns.map(b => b.dataset.zoomBtn),
      titles: btns.map(b => b.getAttribute('title')),
      sizes: btns.map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }),
      svgPaths: btns.map(b => b.querySelectorAll('svg path, svg circle, svg line').length),
      activeClass: btns.every(b => b.className.includes('active:scale-95')),
      bg: cs ? cs.backgroundColor : null,
      blur: cs ? (cs.backdropFilter || cs.webkitBackdropFilter) : null,
      bgAlpha: (() => {
        /*
         * 半透明有两种序列化：老式 rgba(r, g, b, a) 和新的 color(srgb r g b / a)。
         * 只认前一种会漏判 —— color-mix() 在 Chromium 里序列化成后者。
         *
         * 这里刻意**不用正则**：整段是模板字符串，里面的反斜杠转义
         * （\s \d 之类）会被当成未知转义把反斜杠吃掉，到浏览器里就变成语法错误
         * （本项目的 README 踩坑里记过同一类问题）。用字符串切分最稳。
         */
        const c = cs ? cs.backgroundColor : ''
        if (!c) return 1
        const slash = c.indexOf('/')
        if (slash >= 0) return parseFloat(c.slice(slash + 1))
        const parts = c.split(',')
        return parts.length === 4 ? parseFloat(parts[3]) : 1
      })(),
      right: Math.round(pr.right), bottom: Math.round(pr.bottom),
      vw: window.innerWidth, vh: window.innerHeight,
      vpRect: (() => { const r = document.querySelector('[data-graph-viewport]').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } })(),
    }
  })()`)
  check('★ 存在右下角悬浮面板', panel != null, JSON.stringify(panel))
  if (panel) {
    note(`面板按钮：${JSON.stringify(panel.tools)} 尺寸=${JSON.stringify(panel.sizes)}`)
    check('★ 三颗按钮：放大 / 缩小 / 适应屏幕',
      panel.tools.join() === 'zoom-in,zoom-out,zoom-fit', JSON.stringify(panel.tools))
    check('★ 每颗按钮热区都是 44×44',
      panel.sizes.every(([w, h]) => w === 44 && h === 44), JSON.stringify(panel.sizes))
    check('★ 三颗都有 Lucide SVG 图标', panel.svgPaths.every((n) => n > 0), JSON.stringify(panel.svgPaths))
    check('★ 按下有 active:scale-95 反馈', panel.activeClass === true)
    check('★ 半透明背景 + 背景模糊',
      panel.bgAlpha < 1 && /blur/.test(panel.blur || ''),
      `bg=${panel.bg} alpha=${panel.bgAlpha} blur=${panel.blur}`)
    check('★ 面板贴在右下角',
      panel.right > panel.vw - 80 && panel.bottom > panel.vh - 90,
      `right=${panel.right}/${panel.vw} bottom=${panel.bottom}/${panel.vh}`)
    check('面板在画布容器范围内（不是飘在别处）',
      panel.right <= panel.vpRect.r + 1 && panel.bottom <= panel.vpRect.b + 1,
      JSON.stringify(panel.vpRect))
    check('有可读的 title', panel.titles.join() === '放大,缩小,适应屏幕', JSON.stringify(panel.titles))
  }

  /* ---- 按钮真的生效 ---- */
  /* 先从 fit 状态开始：贴在上限时点「放大」会被夹住，反而看不出效果 */
  await resetFit()
  const zoomInRect = await evaluate(`(() => {
    const b = document.querySelector('[data-zoom-btn="zoom-in"]').getBoundingClientRect()
    return { x: b.left + b.width/2, y: b.top + b.height/2 }
  })()`)
  const beforeBtn = await transform()
  await realClick(zoomInRect.x, zoomInRect.y)
  await sleep(450)
  const afterBtn = await transform()
  note(`点「放大」：scale ${beforeBtn.scale.toFixed(3)} → ${afterBtn.scale.toFixed(3)}`)
  check('★ 点「放大」按钮真的放大（zoomIn(0.2)）',
    afterBtn.scale > beforeBtn.scale, `${beforeBtn.scale} → ${afterBtn.scale}`)
  check('放大幅度约 0.2',
    Math.abs((afterBtn.scale - beforeBtn.scale) - 0.2) < 0.05,
    `Δ=${(afterBtn.scale - beforeBtn.scale).toFixed(3)}`)

  const zoomOutRect = await evaluate(`(() => {
    const b = document.querySelector('[data-zoom-btn="zoom-out"]').getBoundingClientRect()
    return { x: b.left + b.width/2, y: b.top + b.height/2 }
  })()`)
  const beforeOut = await transform()
  await realClick(zoomOutRect.x, zoomOutRect.y)
  await sleep(450)
  const afterOut = await transform()
  check('★ 点「缩小」按钮真的缩小（zoomOut(0.2)）',
    afterOut.scale < beforeOut.scale, `${beforeOut.scale} → ${afterOut.scale}`)

  /* ---- 不穿透：在面板上拖拽不应该平移画布 ---- */
  const panelBox = await evaluate(`(() => {
    const r = document.querySelector('[data-zoom-panel] > div').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + 4 }
  })()`)
  const beforePanelDrag = await transform()
  await drag(panelBox.x, panelBox.y, panelBox.x - 90, panelBox.y - 60)
  const afterPanelDrag = await transform()
  check('★ 在面板上拖拽不会平移底层画布（不穿透）',
    Math.abs(afterPanelDrag.x - beforePanelDrag.x) < 2 && Math.abs(afterPanelDrag.y - beforePanelDrag.y) < 2,
    `Δ=(${(afterPanelDrag.x - beforePanelDrag.x).toFixed(1)}, ${(afterPanelDrag.y - beforePanelDrag.y).toFixed(1)})`)

  /* ================================================================== */
  console.log('\n[6] 双击节点改字，而不是缩放（四·1）')
  /* ================================================================== */

  await resetFit()
  const dblTarget = await nodePoint('n3')
  check('能定位到一个节点用于双击测试', dblTarget != null)
  if (dblTarget) {
    const beforeDbl = await transform()
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dblTarget.x, y: dblTarget.y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dblTarget.x, y: dblTarget.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dblTarget.x, y: dblTarget.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dblTarget.x, y: dblTarget.y, button: 'left', clickCount: 2 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dblTarget.x, y: dblTarget.y, button: 'left', clickCount: 2 })
    await sleep(500)

    const afterDbl = await transform()
    const editor = await evaluate(`(() => {
      const el = document.querySelector('[data-label-editor]')
      return el ? { kind: el.dataset.editorKind, hasInput: !!el.querySelector('[data-label-input]') } : null
    })()`)
    note(`双击后：编辑器=${JSON.stringify(editor)} scale ${beforeDbl.scale.toFixed(4)} → ${afterDbl.scale.toFixed(4)}`)
    check('★ 双击节点弹出了改字框', editor != null && editor.hasInput === true, JSON.stringify(editor))
    check('★ 双击**没有**触发缩放（doubleClick disabled）',
      Math.abs(afterDbl.scale - beforeDbl.scale) < 1e-6,
      `${beforeDbl.scale} → ${afterDbl.scale}`)

    // 收掉改字框
    await evaluate(`(async () => {
      const i = document.querySelector('[data-label-input]')
      if (i) i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise(r => setTimeout(r, 300))
      return true
    })()`)
    check('改字框已收起', (await evaluate(`!document.querySelector('[data-label-editor]')`)) === true)
  }

  /* ================================================================== */
  console.log('\n[7] 节点右键正常弹菜单（四·2）')
  /* ================================================================== */

  const rcTarget = await nodePoint('n2')
  check('能定位到一个节点用于右键测试', rcTarget != null, JSON.stringify(rcTarget))
  if (rcTarget) {
    /*
     * 必须用**真实鼠标事件**，不能 dispatchEvent(new MouseEvent('contextmenu'))。
     *
     * 合成事件直接投给节点，绕过了「mousedown 落在哪儿」这条路径 ——
     * 而右键冲突恰恰出在那里：库的 panning 如果 allowRightClickPan 没关，
     * 会在 mousedown 阶段就把事件吃掉，真实的 contextmenu 根本不会产生。
     * 用合成事件测，把 allowRightClickPan 改回 true 也照样绿（实测如此）。
     */
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rcTarget.x, y: rcTarget.y })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: rcTarget.x, y: rcTarget.y, button: 'right', clickCount: 1,
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: rcTarget.x, y: rcTarget.y, button: 'right', clickCount: 1,
    })
    await sleep(500)
    const menu = await evaluate(`(() => {
      const m = document.querySelector('[data-node-menu]')
      return m ? [...m.querySelectorAll('[data-menu-item]')].map(b => b.dataset.menuItem) : null
    })()`)
    note(`右键菜单项：${JSON.stringify(menu)}`)
    check('★ 真实右键仍然弹出 ContextMenu（没被平移逻辑吞掉）',
      Array.isArray(menu) && menu.length > 0, JSON.stringify(menu))
    check('菜单里有「指向」和「指向同一结果」',
      menu?.includes('direct') && menu?.includes('merge'), JSON.stringify(menu))
    await evaluate(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await sleep(250)
  }

  /* ================================================================== */
  console.log('\n[8] 顶部「重置视图」与右下角「适应屏幕」联动（四·4）')
  /* ================================================================== */

  await resetFit()
  const fitA = await transform()
  for (let i = 0; i < 6; i++) await wheel(vr.cx, vr.cy, -120, 2)
  const zoomedA = await transform()
  check('前置：已经缩放离开 fit 状态', Math.abs(zoomedA.scale - fitA.scale) > 0.05)

  // 顶部按钮
  check('桌面端顶栏有「重置视图」链接（这一节在 1440 宽下跑）',
    (await evaluate(`!!document.querySelector('[data-reset-view]')`)) === true)
  await evaluate(`document.querySelector('[data-reset-view]').click()`)
  await sleep(500)
  const afterTop = await transform()
  check('★ 顶部「重置视图」回到 fit 缩放',
    Math.abs(afterTop.scale - fitA.scale) < 0.02, `${afterTop.scale} vs ${fitA.scale}`)

  // 右下角按钮
  for (let i = 0; i < 6; i++) await wheel(vr.cx, vr.cy, -120, 2)
  const zoomedB = await transform()
  check('前置：又缩放离开了', Math.abs(zoomedB.scale - fitA.scale) > 0.05)
  const fitBtnRect = await evaluate(`(() => {
    const b = document.querySelector('[data-zoom-btn="zoom-fit"]').getBoundingClientRect()
    return { x: b.left + b.width/2, y: b.top + b.height/2 }
  })()`)
  await realClick(fitBtnRect.x, fitBtnRect.y)
  await sleep(500)
  const afterBottom = await transform()
  check('★ 右下角「适应屏幕」也回到同一个 fit 状态（两者联动）',
    Math.abs(afterBottom.scale - afterTop.scale) < 0.02 &&
    Math.abs(afterBottom.x - afterTop.x) < 2 && Math.abs(afterBottom.y - afterTop.y) < 2,
    `${JSON.stringify(afterBottom)} vs ${JSON.stringify(afterTop)}`)

  /* ================================================================== */
  console.log('\n[8b] 编辑时绝对冻结视图（核心修复）+ Ctrl+0 居中')
  /* ================================================================== */

  /*
   * 【为什么这条最重要】
   * 老实现是「svg 一变就 fitView」，于是每改一个字、每加一个节点，
   * 整个图都会重新缩放居中一次 —— 用户正在看的位置被强行拉走。
   * 现在只有三种情况允许自动 fit：首次打开 / 点适应屏幕 / Ctrl+0。
   *
   * 【拖分割线曾经也在允许列表里，现在不是了】
   * 第一版把「容器尺寸变化」也当成 fit 的时机，结果拖一下左右分割线，
   * 用户刚摆好的视角就被重新缩放居中冲掉（用户原话：
   * 「移动中间分割线也一样会改变我的流程图」）。现在容器尺寸变化
   * **完全不动视图**：库内部只会把越界的位置挪回边界，从不改缩放。
   * 同一类问题还有「切代码/缩进标签」—— 那个是 ResizeObserver 的依赖里
   * 多了 `mode`，一并删掉了，见下面 [8b-2]。
   *
   * 这里用「改 Mermaid 代码 → 等重绘 → 比对 transform」来验证：
   * 重绘前后 translate 与 zoom 必须**原样不变**。
   */
  {
    await resetFit()
    // 先缩放 + 平移到一个人为的、明显不是 fit 的状态
    for (let i = 0; i < 4; i++) await wheel(vr.cx, vr.cy, -100, 0)
    await drag(vr.cx, vr.cy, vr.cx - 90, vr.cy - 60)
    await sleep(600)
    const frozen0 = await transform()
    check('前置：处于一个明显偏离 fit 的视图',
      Math.abs(frozen0.scale - 1) > 0.02 || Math.abs(frozen0.x) > 5,
      JSON.stringify(frozen0))

    // 改代码触发重绘：往流程图里加一个节点（实质性改变）
    /*
     * 必须精确定位到 textarea 本身（[data-code-input]）。
     * 外层 [data-code-editor] 是一个 div（滚动容器），
     * 对它调 HTMLTextAreaElement 的 value setter 会抛
     * 「Illegal invocation」—— 第一版就是这么写错的。
     */
    const edited = await evaluate(`(() => {
      const ta = document.querySelector('[data-code-input]')
      if (!ta) return null
      const before = ta.value
      const next = before + '\\n  n_freeze_probe["冻结探针"]'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, next)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return { before, next }
    })()`)
    check('能找到左侧代码编辑器并写入新节点', edited != null)

    if (edited) {
      await sleep(1400)   // 等防抖渲染 + 任何可能的自动 fit
      const frozen1 = await transform()
      note(`编辑重绘：${JSON.stringify(frozen0)} → ${JSON.stringify(frozen1)}`)

      check('★ 改代码触发重绘后，缩放**没有被自动改变**',
        Math.abs(frozen1.scale - frozen0.scale) < 0.01,
        `${frozen0.scale} → ${frozen1.scale}`)
      check('★ 改代码触发重绘后，平移**没有被自动改变**（画面像什么都没发生）',
        Math.abs(frozen1.x - frozen0.x) < 2 && Math.abs(frozen1.y - frozen0.y) < 2,
        `Δ=(${(frozen1.x - frozen0.x).toFixed(1)}, ${(frozen1.y - frozen0.y).toFixed(1)})`)

      // 新节点超出视口也不许自动拉过去：视图保持不变本身就是证据
      check('★ 新节点即使超出视口也不会自动把视角拉过去',
        Math.abs(frozen1.scale - frozen0.scale) < 0.01 &&
        Math.abs(frozen1.x - frozen0.x) < 2,
        `${JSON.stringify(frozen1)}`)
    }

    // Ctrl+0 → 一键居中（应当回到 fit）
    const fitRef = await evaluate(`(() => {
      const b = document.querySelector('[data-zoom-btn="zoom-fit"]')
      return !!b
    })()`)
    check('右下角「适应屏幕」按钮仍在', fitRef === true)

    await evaluate(`document.querySelector('[data-zoom-btn="zoom-fit"]').click()`)
    await sleep(500)
    const fitState = await transform()

    // 再弄乱，然后用 Ctrl+0 回来
    for (let i = 0; i < 4; i++) await wheel(vr.cx, vr.cy, -100, 0)
    await sleep(400)
    const messy = await transform()
    check('前置：Ctrl+0 之前视图是乱的',
      Math.abs(messy.scale - fitState.scale) > 0.02, `${messy.scale} vs ${fitState.scale}`)

    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key: '0', ctrlKey: true, bubbles: true, cancelable: true,
    }))`)
    await sleep(600)
    const afterCtrl0 = await transform()
    note(`Ctrl+0：${JSON.stringify(messy)} → ${JSON.stringify(afterCtrl0)}`)
    check('★ Ctrl+0 一键居中生效（回到 fit 状态）',
      Math.abs(afterCtrl0.scale - fitState.scale) < 0.02,
      `${afterCtrl0.scale} vs ${fitState.scale}`)
  }

  /* ================================================================== */
  console.log('\n[8b-2] 切代码/缩进标签、拖分割线都不得改变预览视图')
  /* ================================================================== */

  /*
   * 用户原话：「在代码和缩进间切换他还是会改变我的流程图」+
   * 「包括移动中间分割线也一样会」。两条都要钉住。
   *
   * 根因各不相同，但都是「不该 fit 的地方调了 fitView」：
   *   · 切标签 → ResizeObserver 那个 effect 的依赖里写了 `mode`，
   *     mode 一变 effect 重跑、结尾无条件 fitViewSoon()；
   *   · 拖分割线 → observer 回调里直接 fitViewSoon()。
   * 现在两处都不再 fit：切标签不再重跑那个 effect，尺寸变化什么都不做。
   */
  {
    await resetFit()
    // 造一个明显不是 fit 的视图，后面全程比对它
    for (let i = 0; i < 3; i++) await wheel(vr.cx, vr.cy, -100, 0)
    await drag(vr.cx, vr.cy, vr.cx - 70, vr.cy - 50)
    await sleep(500)
    const base = await transform()
    note(`基准视图 ${JSON.stringify(base)}`)

    // 切到缩进模式再切回来
    await evaluate(`document.querySelector('[data-mode-tab="outline"]').click()`)
    await sleep(900)
    const toOutline = await transform()
    await evaluate(`document.querySelector('[data-mode-tab="code"]').click()`)
    await sleep(900)
    const backToCode = await transform()
    note(`切标签：缩进 ${JSON.stringify(toOutline)} → 代码 ${JSON.stringify(backToCode)}`)
    check('★ 切到缩进模式后 scale 不变',
      Math.abs(toOutline.scale - base.scale) < 0.01, `${base.scale} → ${toOutline.scale}`)
    check('★ 切回代码模式后 scale 不变',
      Math.abs(backToCode.scale - base.scale) < 0.01, `${base.scale} → ${backToCode.scale}`)
    check('★ 切标签全程平移也不变（画面像什么都没发生）',
      Math.abs(toOutline.x - base.x) < 2 && Math.abs(backToCode.y - base.y) < 2,
      `Δ=(${(backToCode.x - base.x).toFixed(1)}, ${(backToCode.y - base.y).toFixed(1)})`)

    // 拖分割线（左栏变窄 → 右侧容器变宽）
    const splitter = await evaluate(`(() => {
      const el = document.querySelector('[data-splitter]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + 180, leftW: document.querySelector('[data-pane-section="edit"]').getBoundingClientRect().width }
    })()`)
    check('能找到中间分割线', splitter != null)
    if (splitter) {
      await drag(splitter.x, splitter.y, splitter.x - 130, splitter.y)
      await sleep(900)
      const afterSplit = await transform()
      const leftW = await evaluate(`document.querySelector('[data-pane-section="edit"]').getBoundingClientRect().width`)
      note(`拖分割线：左栏 ${Math.round(splitter.leftW)} → ${Math.round(leftW)}，视图 ${JSON.stringify(afterSplit)}`)
      check('★ 分割线确实被拖动了（左栏变窄）',
        leftW < splitter.leftW - 60, `${splitter.leftW} → ${leftW}`)
      check('★ 拖分割线后 scale 不变（不再重新适应屏幕）',
        Math.abs(afterSplit.scale - base.scale) < 0.01, `${base.scale} → ${afterSplit.scale}`)
      check('★ 拖分割线后平移也不变',
        Math.abs(afterSplit.x - base.x) < 2 && Math.abs(afterSplit.y - base.y) < 2,
        `Δ=(${(afterSplit.x - base.x).toFixed(1)}, ${(afterSplit.y - base.y).toFixed(1)})`)
      // 拖回去，后面的用例不受影响
      await drag(splitter.x - 130, splitter.y, splitter.x, splitter.y)
      await sleep(600)
    }
  }

  /* ================================================================== */
  console.log('\n[8c] 双击改完字，点旁边（图里的空白）= 确认')
  /* ================================================================== */

  /*
   * 用户要求：「无论在主界面还是在流程图里面，双击编辑东西后点旁边也可以进行确认」。
   *
   * 【主画布本来就工作，弹窗这边是坏的】
   * 弹窗的改字框原来只靠 `onBlur` 提交，而右侧预览用的是
   * react-zoom-pan-pinch —— 它的 `onPanningStart` 对 mousedown 调了
   * `preventDefault()`（防止拖画布顺带选中文字），焦点因此**不会**离开输入框，
   * blur 永远不触发。实测：双击改完字点一下图里的空白，输入框还在那儿、
   * 字也没生效（boxGone=false, focused=INPUT）。
   * 修法是改成在 document 捕获阶段按**指针位置**判断，绕开焦点这条路。
   */
  {
    await resetFit()
    await sleep(300)
    const node = await evaluate(`(() => {
      const g = document.querySelector('[data-graph-viewport] g.node')
      if (!g) return null
      const r = g.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: (g.id || '').match(/flowchart-(.+?)-\\d+$/)?.[1] || null }
    })()`)
    check('找得到一个图节点', node != null)

    if (node) {
      // 双击进改字框
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: node.x, y: node.y })
      for (const n of [1, 2]) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: node.x, y: node.y, button: 'left', clickCount: n })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: node.x, y: node.y, button: 'left', clickCount: n })
      }
      await sleep(500)
      const boxOpen = await evaluate(`!!document.querySelector('[data-label-input]')`)
      check('前置：双击弹出改字框', boxOpen === true)

      if (boxOpen) {
        const MARK = '点旁边确认'
        await evaluate(`(() => {
          const el = document.querySelector('[data-label-input]')
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(el, ${JSON.stringify(MARK)})
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
        await sleep(200)

        // 找一个「真的在图容器里、且不压任何节点和浮层」的空点
        const blank = await evaluate(`(() => {
          const r = document.querySelector('[data-graph-viewport]').getBoundingClientRect()
          const bad = [...document.querySelectorAll('[data-graph-viewport] g.node')].map(n => n.getBoundingClientRect())
          for (const p of document.querySelectorAll('[data-zoom-panel],[data-mobile-bottom-bar]')) {
            const b = p.getBoundingClientRect()
            bad.push({ left: b.left - 6, top: b.top - 6, right: b.right + 6, bottom: b.bottom + 6 })
          }
          for (let y = r.top + 20; y < r.bottom - 20; y += 12)
            for (let x = r.left + 20; x < r.right - 20; x += 12)
              if (!bad.some(b => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)) return { x, y }
          return null
        })()`)
        check('找得到图里的一块空白（不压节点也不压右下角面板）', blank != null, JSON.stringify(blank))

        if (blank) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: blank.x, y: blank.y })
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: blank.x, y: blank.y, button: 'left', clickCount: 1 })
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: blank.x, y: blank.y, button: 'left', clickCount: 1 })
          await sleep(900)
          const after = await evaluate(`(() => {
            const mark = ${JSON.stringify(MARK)}
            /*
             * 左侧这时可能显示缩进列表（[data-outline-input]）或 Mermaid 代码
             * （[data-code-input]）—— 本套件在 [0] 切到了代码模式，[8b-2] 又切回来，
             * 所以两种都要能读。断言的是「改的字写回了左侧那份文本」，
             * 不该依赖当前是哪个编辑器。
             */
            const outline = [...document.querySelectorAll('[data-outline-input]')]
            const code = document.querySelector('[data-code-input]')
            return {
              boxGone: !document.querySelector('[data-label-input]'),
              inGraph: document.querySelector('[data-graph-canvas]').innerText.includes(mark),
              editor: outline.length ? 'outline' : (code ? 'code' : null),
              inLeft: outline.length ? outline.some(i => i.value.includes(mark))
                : (code ? code.value.includes(mark) : false),
              focused: document.activeElement ? document.activeElement.tagName : null,
            }
          })()`)
          note(`点空白后：${JSON.stringify(after)}`)
          check('★ 点旁边后改字框自动关闭', after.boxGone === true, JSON.stringify(after))
          check('★ 点旁边 = 确认（新文字进了右侧图）', after.inGraph === true, JSON.stringify(after))
          check('★ 点旁边 = 确认（新文字也写回了左侧编辑器）',
            after.inLeft === true, JSON.stringify(after))
        }
      }
    }
  }

  /* ================================================================== */
  console.log('\n[9] 虚拟键盘 / 视口尺寸变化后重新适应（四·3）')
  /* ================================================================== */

  await resetFit()
  // 放大并拖到一边，制造「图在视野外」的状态
  for (let i = 0; i < 6; i++) await wheel(vr.cx, vr.cy, -120, 2)
  await drag(vr.cx, vr.cy, vr.cx - 160, vr.cy - 120)
  const messy = await transform()

  // 模拟键盘弹起：布局视口不变，只有 visualViewport 变
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 620, deviceScaleFactor: 1, mobile: false,
  })
  await evaluate(`window.dispatchEvent(new Event('resize'))`)
  await sleep(700)
  const afterResize = await transform()
  note(`视口变化后：scale ${messy.scale.toFixed(3)} → ${afterResize.scale.toFixed(3)}，`
    + `y ${messy.y.toFixed(1)} → ${afterResize.y.toFixed(1)}`)
  check('★ 视口尺寸变化后重新适应（变换确实被重算）',
    Math.abs(afterResize.scale - messy.scale) > 0.02 || Math.abs(afterResize.y - messy.y) > 5,
    `${JSON.stringify(messy)} → ${JSON.stringify(afterResize)}`)

  // 图必须仍然完整落在视口内
  const contained = await evaluate(`(() => {
    const vp = document.querySelector('[data-graph-viewport]')
    const canvas = document.querySelector('[data-graph-canvas]')
    if (!vp || !canvas) return null
    const a = vp.getBoundingClientRect(), b = canvas.getBoundingClientRect()
    return {
      insideX: b.left >= a.left - 2 && b.right <= a.right + 2,
      insideY: b.top >= a.top - 2 && b.bottom <= a.bottom + 2,
      canvas: { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) },
      vp: { l: Math.round(a.left), r: Math.round(a.right), t: Math.round(a.top), b: Math.round(a.bottom) },
    }
  })()`)
  note(`容器/内容：${JSON.stringify(contained)}`)
  check('★ 重新适应后整张图落在视口内（没跑到屏幕外）',
    contained && contained.insideX && contained.insideY, JSON.stringify(contained))

  // 恢复尺寸
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await evaluate(`window.dispatchEvent(new Event('resize'))`)
  await sleep(800)

  /*
   * 9b. **只有 visualViewport 变**的场景（虚拟键盘真正的样子）。
   *
   * 【为什么必须单独测这一档】
   * 上面 9a 改的是「模拟器视口尺寸」，那会连带改变元素的 CSS 尺寸，
   * 于是窗口级的 resize 就会触发重新适应。
   * 真机上虚拟键盘弹起时，**布局视口（innerHeight）往往不变**，
   * 变的只是 visualViewport 的高度和 offsetTop，元素尺寸一动不动。
   * 所以这里刻意：元素尺寸完全不改，只往 visualViewport 上派发 resize，
   * 此时唯一能救场的就只有那个监听器。
   *
   * 【注意：容器尺寸变化本身已经**不再**触发 fit】
   * 容器上的 ResizeObserver 现在只负责「换容器后重新挂 observer +
   * 把上次的视图贴回去」，尺寸真变了也什么都不做 —— 那正是
   * 「拖分割线不许改我的视角」要求的。所以这里能重新适应的唯一来源
   * 就是 visualViewport 监听器，删掉它这条就会红。
   */
  {
    await resetFit()
    const fitScaleNow = (await transform()).scale
    for (let i = 0; i < 8; i++) await wheel(vr.cx, vr.cy, -120, 2)
    await sleep(800)
    const beforeVv = await transform()
    check('前置：已放大离开 fit 状态（元素尺寸不变）',
      Math.abs(beforeVv.scale - fitScaleNow) > 0.05,
      `${beforeVv.scale} vs fit ${fitScaleNow}`)

    // 只派发 visualViewport 的 resize，DOM 尺寸一个像素都没动
    const fired = await evaluate(`(() => {
      const vv = window.visualViewport
      if (!vv) return false
      vv.dispatchEvent(new Event('resize'))
      return true
    })()`)
    check('浏览器支持 visualViewport', fired === true)
    await sleep(900)
    const afterVv = await transform()
    note(`仅 visualViewport 变化后：scale ${beforeVv.scale.toFixed(3)} → ${afterVv.scale.toFixed(3)}`)
    check('★ 只有 visualViewport 变化时也会重新适应（虚拟键盘场景）',
      Math.abs(afterVv.scale - fitScaleNow) < 0.03,
      `${afterVv.scale} vs fit ${fitScaleNow}`)
  }

  /* ================================================================== */
  console.log('\n[10] 双指捏合（三·1）')
  /* ================================================================== */

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 412, height: 915, deviceScaleFactor: 2, mobile: true,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
  await sleep(900)
  await resetFit()
  await sleep(400)

  const beforePinch = await transform()
  const cx = 206
  const cy = 600
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: cx - 40, y: cy }, { x: cx + 40, y: cy }],
  })
  for (let i = 1; i <= 6; i++) {
    const d = 40 + i * 18
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: cx - d, y: cy }, { x: cx + d, y: cy }],
    })
    await sleep(45)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(500)
  const afterPinch = await transform()
  note(`捏合：scale ${beforePinch.scale.toFixed(3)} → ${afterPinch.scale.toFixed(3)}`)
  check('★ 双指捏合能缩放（触摸事件没被拦截）',
    afterPinch.scale > beforePinch.scale + 0.02,
    `${beforePinch.scale} → ${afterPinch.scale}`)

  /*
   * 手机端浮动控件：本轮按用户要求「放大镜和放小删了 完全用不上」，
   * 手机端不再渲染桌面那套三连（放大/缩小/适应屏幕），只留一条横排的
   * data-mobile-bottom-bar：撤销 / 重做 / 回到中点。
   * 所以这里改判新那条 —— 判据不变（热区 44×44），数量从 3 变 1。
   */
  const mobilePanel = await evaluate(`(() => {
    const p = document.querySelector('[data-mobile-bottom-bar]')
    if (!p) return null
    const zoom = [...p.querySelectorAll('[data-zoom-btn]')]
    const undos = [...p.querySelectorAll('[data-undo-button]')]
    return {
      n: zoom.length,
      sizes: zoom.map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }),
      undoSizes: undos.map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }),
      tools: zoom.map(b => b.dataset.zoomBtn),
      dir: getComputedStyle(p.firstElementChild).flexDirection,
      desktopPanel: !!document.querySelector('[data-zoom-panel]'),
    }
  })()`)
  check('★ 手机端浮动控件换成了底部操作条（撤销 / 重做 / 回到中点）',
    mobilePanel && mobilePanel.n === 1 && mobilePanel.tools.join() === 'zoom-fit' && mobilePanel.dir === 'row',
    JSON.stringify(mobilePanel))
  check('★ 手机端底部按钮热区都是 44×44',
    mobilePanel && mobilePanel.sizes.every(([w, h]) => w === 44 && h === 44)
    && mobilePanel.undoSizes.length === 2 && mobilePanel.undoSizes.every(([w, h]) => w === 44 && h === 44),
    JSON.stringify(mobilePanel))
  check('★ 手机端不再渲染桌面那套右下角三连（放大/缩小已删）',
    mobilePanel && mobilePanel.desktopPanel === false, JSON.stringify(mobilePanel))

  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await sleep(500)

  /* ================================================================== */
  console.log('\n[11] 小图也会被放大贴合（fit 不是「只缩不放」）')
  /* ================================================================== */

  await writeCode(SMALL_SRC)
  await resetFit()
  const small = await transform()
  note(`小图 fit 后 scale=${small.scale.toFixed(3)}`)
  check('★ 小图 fit 后缩放 > 1（真的放大到贴合视口）',
    small.scale > 1.02, String(small.scale))
  check('小图也没有超过 maxScale', small.scale <= 3.001, String(small.scale))

  /* ================================================================== */
  console.log('\n[12] 无 console 报错')
  /* ================================================================== */

  {
    const real = consoleErrors.filter((e) => !/favicon|ERR_/.test(e))
    check('整个过程没有 console 报错（含 React 开发期警告）',
      real.length === 0, JSON.stringify(real.slice(0, 4)))
  }

  console.log('\n====================================================')
  console.log(`  缩放平移 zoompan  通过 ${pass} / 失败 ${fail}`)
  console.log('====================================================')

  cdp.close()
  try { proc.kill() } catch { /* ignore */ }
  if (fail) process.exit(1)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new MiniWS(url)
    let id = 0
    const pending = new Map()
    const handlers = new Map()
    ws.onmessage = (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message))
        else res(msg.result)
      } else if (msg.method && handlers.has(msg.method)) {
        for (const h of handlers.get(msg.method)) h(msg.params)
      }
    }
    ws.opened.then(() => {
      resolve({
        send(method, params) {
          const mid = ++id
          return new Promise((res, rej) => {
            pending.set(mid, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id: mid, method, params }))
          })
        },
        on(method, fn) {
          if (!handlers.has(method)) handlers.set(method, [])
          handlers.get(method).push(fn)
        },
        close: () => ws.close(),
      })
    }).catch(reject)
  })
}

main().catch((e) => {
  console.error('测试失败：', e)
  process.exit(2)
})
