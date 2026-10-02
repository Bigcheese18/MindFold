/**
 * 纯代码模式 · 双向高亮联动 端到端测试
 * ======================================
 * 覆盖需求逐条：
 *   1. 代码行号映射：每次代码变化后自动刷新，行号与左侧行号栏一致
 *   2. 图 → 代码（悬停）：150ms 防抖、浅蓝 rgba(59,130,246,.1)、移开即消失
 *   3. 图 → 代码（单击）：scrollIntoView(smooth, center) + 持久 rgba(59,130,246,.2)
 *   4. 点其他节点替换、点空白取消
 *   5. 代码 → 图：200ms 防抖、节点描边 #3b82f6 / 2px / drop-shadow
 *   6. 光标在连线行上时**两端都高亮**
 *   7. isSyncing 锁与防死循环：高亮绝不改动代码、绝不触发重绘
 *   8. ★ 图重绘后必须重新贴回高亮 class
 *   9. ★ 语法报错时上半部分的映射仍然可用
 *
 * 需要 dev server 已启动：npm run dev
 * 用法：node scripts/linktest.mjs [url]
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

const PORT = 9345
const userDir = mkdtempSync(join(tmpdir(), 'mf-link-'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (msg) => console.log(`  · ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 60 行代码：30 个声明行 + 29 条连线（第 32 行起）。
   行数够多，左侧编辑器才会真的出现滚动条，scrollIntoView 才有意义。

   声明**倒序**书写（n29 在第 2 行 … n0 在第 31 行），这样「点击图上可见的
   根节点 n0」对应的代码行在第 31 行 —— 又远又能点到。
   （正序写的话，行号靠后的节点在 TD 长链上位于图的下方、已经滚出视口，
   根本点不到，测的就不是滚动而是「点了个看不见的东西」。） */
const CODE_LINES = ['flowchart TD']
for (let i = 29; i >= 0; i--) CODE_LINES.push(`  n${i}["节点${i}"]`)
for (let i = 0; i < 29; i++) CODE_LINES.push(`  n${i} --> n${i + 1}`)
const CODE = CODE_LINES.join('\n')
const LINE_OF = (i) => 2 + (29 - i)    // n<i> 的声明行号
const EDGE_LINE_OF = (i) => 32 + i     // n<i> --> n<i+1> 所在行号
const LINE_H = 22
const PAD_Y = 12

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

  const mouseMove = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  const realClick = async (x, y) => {
    await mouseMove(x, y)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  /* ---------------- 读取工具 ---------------- */
  const nodeRect = (id) => evaluate(`(() => {
    for (const g of document.querySelectorAll('[data-fold-modal] g.node')) {
      const m = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      if (m && m[1] === ${JSON.stringify(id)}) {
        const r = g.getBoundingClientRect()
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height }
      }
    }
    return null
  })()`)

  /** 当前有高亮状态的所有代码行 */
  const bandStates = () => evaluate(`(() => {
    const out = {}
    for (const el of document.querySelectorAll('[data-code-line]')) {
      const st = el.dataset.lineState
      if (st) out[el.dataset.codeLine] = { state: st, bg: getComputedStyle(el).backgroundColor }
    }
    return out
  })()`)

  const gutterStates = () => evaluate(`(() => {
    const out = {}
    for (const el of document.querySelectorAll('[data-gutter-line]')) {
      const st = el.dataset.lineState
      if (st) out[el.dataset.gutterLine] = { state: st, bg: getComputedStyle(el).backgroundColor, shadow: getComputedStyle(el).boxShadow }
    }
    return out
  })()`)

  /** 某个 SVG 节点的 class 与描边计算样式 */
  const nodeStyle = (id) => evaluate(`(() => {
    for (const g of document.querySelectorAll('[data-fold-modal] g.node')) {
      const m = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      if (m && m[1] === ${JSON.stringify(id)}) {
        const shape = g.querySelector('rect, polygon, circle, ellipse, path')
        const cs = shape ? getComputedStyle(shape) : null
        return {
          cls: g.getAttribute('class') || '',
          stroke: cs ? cs.stroke : null,
          strokeWidth: cs ? cs.strokeWidth : null,
          filter: cs ? cs.filter : null,
        }
      }
    }
    return null
  })()`)

  const allNodeClasses = () => evaluate(`(() => {
    const out = {}
    for (const g of document.querySelectorAll('[data-fold-modal] g.node')) {
      const m = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      if (m) out[m[1]] = g.getAttribute('class') || ''
    }
    return out
  })()`)

  const codeValue = () => evaluate(`(() => {
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    return ta ? ta.value : null
  })()`)

  /**
   * SVG 结构指纹。
   *
   * **必须把 class 属性剥掉再算**：高亮本来就是往 SVG 上增删 class，
   * 那是设计内的改动。我们真正要证明的是「几何 / 节点集合没有被重绘」。
   * 不剥 class 的话这个断言恒假 —— 一开始我就是这么写错的。
   */
  const svgFingerprint = () => evaluate(`(() => {
    const host = document.querySelector('[data-fold-modal] [data-graph-viewport] > div')
    if (!host) return null
    const s = host.innerHTML.replace(/ class="[^"]*"/g, '')
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
    return { len: s.length, hash: h }
  })()`)

  const scrollInfo = () => evaluate(`(() => {
    const ed = document.querySelector('[data-fold-modal] [data-code-editor]')
    return { scrollTop: ed ? ed.scrollTop : null, clientHeight: ed ? ed.clientHeight : null, scrollHeight: ed ? ed.scrollHeight : null }
  })()`)

  const viewportRect = () => evaluate(`(() => {
    const r = document.querySelector('[data-fold-modal] [data-graph-viewport]').getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })()`)

  const setCode = (src) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    if (!ta) return { error: '找不到代码编辑器' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(src)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(1600)
    return { ok: true, len: ta.value.length }
  })()`)

  /**
   * 把光标放到第 lineNo 行。
   *
   * 【为什么必须用真实鼠标事件，不能用 dispatchEvent(new Event('select'))】
   * React 的 onSelect **不监听原生 `select` 事件** —— SelectEventPlugin 的
   * 依赖列表是 selectionchange / keydown / keyup / mouseup 那一组。
   * 手工 dispatch 一个 `select` 事件对 React 来说等于什么都没发生
   * （实测：光标明明在第 7 行，React 那边还停在旧行上，反向联动一直不更新）。
   * 所以这里改成：先把目标行滚进视野，再在 textarea 的**那一行上真点一下**。
   * 真实点击既会原生地移动光标，又会触发 React 的 onClick，
   * 走的是和用户完全一样的路径。
   */
  const caretTo = async (lineNo) => {
    const prep = await evaluate(`(() => {
      const ed = document.querySelector('[data-fold-modal] [data-code-editor]')
      const ta = document.querySelector('[data-fold-modal] [data-code-input]')
      const band = document.querySelector('[data-code-line="${lineNo}"]')
      if (!ed || !ta || !band) return { error: 'missing editor/band' }
      // 先让这一行进入视野，否则点击坐标会落在编辑器外面
      const top = ${PAD_Y} + (${lineNo} - 1) * ${LINE_H}
      const max = Math.max(0, ed.scrollHeight - ed.clientHeight)
      ed.scrollTop = Math.max(0, Math.min(top - ed.clientHeight / 2, max))
      return { ok: true }
    })()`)
    if (prep.error) return prep
    await sleep(120)
    const pos = await evaluate(`(() => {
      const ta = document.querySelector('[data-fold-modal] [data-code-input]')
      const band = document.querySelector('[data-code-line="${lineNo}"]')
      const tr = ta.getBoundingClientRect()
      const br = band.getBoundingClientRect()
      return {
        x: tr.left + 24,
        y: br.top + br.height / 2,
        taTop: tr.top,
        taBottom: tr.bottom,
        inside: br.top + br.height / 2 > tr.top && br.top + br.height / 2 < tr.bottom,
      }
    })()`)
    if (!pos.inside) return { error: `第 ${lineNo} 行滚进视野后仍不在编辑器内`, ...pos }
    await realClick(pos.x, pos.y)
    await sleep(60)
    return { ok: true, line: lineNo, ...pos }
  }

  /* ================================================================== */
  console.log('\n[0] 准备：打开弹窗 → 代码模式 → 写入 60 行代码')
  /* ================================================================== */
  const opened = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const hit = [...document.querySelectorAll('[data-fold-badge]')][0]
    if (!hit) return { error: '找不到折角角标' }
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(2500)
    document.querySelector('[data-mode-tab="code"]').click()
    await sleep(600)
    return { ok: !!document.querySelector('[data-fold-modal]') }
  })()`)
  check('弹窗打开并切到代码模式', opened.ok === true, JSON.stringify(opened))

  const wrote = await setCode(CODE)
  check('60 行代码写入成功', wrote.ok === true && (await codeValue()) === CODE, JSON.stringify(wrote))
  check('图渲染出 30 个节点',
    Object.keys(await allNodeClasses()).length === 30,
    JSON.stringify(Object.keys(await allNodeClasses()).length))

  /* ================================================================== */
  console.log('\n[1] 代码行号映射：行号与行号栏一致')
  /* ================================================================== */

  const bandCount = await evaluate(`document.querySelectorAll('[data-code-line]').length`)
  const gutterCount = await evaluate(`document.querySelectorAll('[data-gutter-line]').length`)
  check('高亮带数量 == 代码行数', bandCount === CODE_LINES.length, `${bandCount} vs ${CODE_LINES.length}`)
  check('行号栏数量 == 代码行数', gutterCount === CODE_LINES.length, `${gutterCount} vs ${CODE_LINES.length}`)

  // 高亮带的纵向位置必须和 textarea 的 py-3 + leading-22 严格对齐
  const geom = await evaluate(`(() => {
    const ed = document.querySelector('[data-fold-modal] [data-code-editor]')
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    const b1 = document.querySelector('[data-code-line="1"]')
    const b5 = document.querySelector('[data-code-line="5"]')
    const edTop = ed.getBoundingClientRect().top
    return {
      taLeading: getComputedStyle(ta).lineHeight,
      taPadTop: getComputedStyle(ta).paddingTop,
      taWrap: ta.getAttribute('wrap'),
      b1Top: b1.getBoundingClientRect().top - edTop + ed.scrollTop,
      b5Top: b5.getBoundingClientRect().top - edTop + ed.scrollTop,
      b1H: b1.getBoundingClientRect().height,
    }
  })()`)
  note(`几何：${JSON.stringify(geom)}`)
  check('行高是 22px（与 leading 一致）', geom.taLeading === '22px', geom.taLeading)
  check('textarea 关掉了软换行（wrap=off）', geom.taWrap === 'off', String(geom.taWrap))
  check('第 1 行带子顶部 = padding(12px)', Math.abs(geom.b1Top - 12) < 1.5, String(geom.b1Top))
  check('相邻两行间距 = 22px', Math.abs((geom.b5Top - geom.b1Top) - 88) < 1.5, String(geom.b5Top - geom.b1Top))
  check('带子高度 = 22px', Math.abs(geom.b1H - 22) < 1.5, String(geom.b1H))

  const initialScroll = await scrollInfo()
  check('初始没有任何行高亮', Object.keys(await bandStates()).length === 0,
    JSON.stringify(await bandStates()))
  note(`代码编辑器：clientHeight=${initialScroll.clientHeight} scrollHeight=${initialScroll.scrollHeight}`)
  check('代码编辑器确实可滚动（否则滚动测试没有意义）',
    initialScroll.scrollHeight > initialScroll.clientHeight + 100,
    JSON.stringify(initialScroll))

  /* ================================================================== */
  console.log('\n[1b] ★ 超长行不能软换行（否则逻辑行 ≠ 视觉行，高亮带会整体漂移）')
  /* ================================================================== */

  /*
   * 上面那批代码每行都很短，即使去掉 wrap="off" 也不会换行，
   * 几何断言照样全绿 —— 那条测试是**假绿**的。
   * 这里塞一行 400 字符的长标签：一旦软换行，textarea 的内容高度会
   * 比「行数 × 22」多出好几百像素，高亮带就会和文字错位。
   */
  const LONG = ['flowchart TD']
  for (let i = 0; i < 30; i++) {
    LONG.push(i === 3 ? `  n${i}["${'x'.repeat(400)}"]` : `  n${i}["节点${i}"]`)
  }
  for (let i = 0; i < 29; i++) LONG.push(`  n${i} --> n${i + 1}`)
  const LONG_SRC = LONG.join('\n')
  await setCode(LONG_SRC)
  await sleep(400)

  const longGeom = await evaluate(`(() => {
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    const n = ta.value.split('\\n').length
    return {
      lines: n,
      scrollHeight: ta.scrollHeight,
      expected: ${PAD_Y} * 2 + n * ${LINE_H},
      hasHScroll: ta.scrollWidth > ta.clientWidth,
    }
  })()`)
  note(`长行几何：${JSON.stringify(longGeom)}`)
  check('超长行确实撑出了横向滚动（说明它真的很长）', longGeom.hasHScroll === true,
    JSON.stringify(longGeom))
  check('★ 内容高度 ≈ 行数 × 22（没有软换行）',
    Math.abs(longGeom.scrollHeight - longGeom.expected) <= 24,
    `${longGeom.scrollHeight} vs ${longGeom.expected}`)

  await setCode(CODE)
  await sleep(400)
  check('恢复标准代码', (await codeValue()) === CODE)

  /* ================================================================== */
  console.log('\n[2] 图 → 代码：悬停联动（150ms 防抖）')
  /* ================================================================== */

  const n5 = await nodeRect('n5')
  check('找到图上的节点 n5', n5 != null, JSON.stringify(n5))
  await mouseMove(n5.cx, n5.cy)

  // 防抖窗口内：绝不能有高亮（这就是「快速划过不闪烁」的保证）
  await sleep(60)
  const duringDebounce = await bandStates()
  check('悬停后 60ms（防抖窗口内）左侧还没有高亮', Object.keys(duringDebounce).length === 0,
    JSON.stringify(duringDebounce))

  await sleep(320)
  const hovered = await bandStates()
  note(`悬停 n5（第 ${LINE_OF(5)} 行）→ ${JSON.stringify(hovered)}`)
  check(`防抖结束后第 ${LINE_OF(5)} 行被高亮`, hovered[String(LINE_OF(5))] != null, JSON.stringify(hovered))
  check('高亮状态标记为 hover', hovered[String(LINE_OF(5))]?.state === 'hover', JSON.stringify(hovered))
  check('浅蓝背景 rgba(59, 130, 246, 0.1)',
    hovered[String(LINE_OF(5))]?.bg === 'rgba(59, 130, 246, 0.1)',
    String(hovered[String(LINE_OF(5))]?.bg))
  check('同时只有一行高亮（不是一片）', Object.keys(hovered).length === 1, JSON.stringify(hovered))

  const hoveredGutter = await gutterStates()
  check('行号栏同步高亮', hoveredGutter[String(LINE_OF(5))] != null, JSON.stringify(hoveredGutter))

  // 悬停绝不能滚动（否则打字时会被拽走）
  check('悬停不会滚动代码编辑器', (await scrollInfo()).scrollTop === initialScroll.scrollTop,
    `${(await scrollInfo()).scrollTop} vs ${initialScroll.scrollTop}`)

  /* ================================================================== */
  console.log('\n[3] 防抖：快速划过一排节点时不能疯狂闪烁')
  /* ================================================================== */

  // 先把上一节留下的高亮清干净，否则下面测到的是「旧高亮还没被替换」
  await mouseMove(10, 10)
  await sleep(150)
  check('清扫基线：此时没有任何高亮', Object.keys(await bandStates()).length === 0,
    JSON.stringify(await bandStates()))

  /*
   * 30ms 一步划过 6 个节点，最后停在 n3。
   * 防抖 150ms > 单步 30ms，所以整个过程中计时器一直被重置，
   * 左侧不应该出现任何一次高亮 —— 这正是「不疯狂闪烁」的含义。
   */
  for (const i of [1, 2, 3, 4, 6, 7]) {
    const r = await nodeRect(`n${i}`)
    if (r) await mouseMove(r.cx, r.cy)
    await sleep(30)
  }
  const n3 = await nodeRect('n3')
  await mouseMove(n3.cx, n3.cy)
  await sleep(40)
  const midSweep = await bandStates()
  check('快速划过过程中（防抖未到）左侧始终没有高亮', Object.keys(midSweep).length === 0,
    JSON.stringify(midSweep))
  await sleep(320)
  const settled = await bandStates()
  check('停下后只高亮最后悬停的那一行',
    Object.keys(settled).length === 1 && settled[String(LINE_OF(3))] != null, JSON.stringify(settled))

  /* ================================================================== */
  console.log('\n[4] 鼠标移开 → 高亮消失')
  /* ================================================================== */

  await mouseMove(10, 10)     // 移到顶栏，触发 viewport 的 mouseleave
  await sleep(120)
  const afterLeave = await bandStates()
  check('鼠标移开后高亮立刻消失', Object.keys(afterLeave).length === 0, JSON.stringify(afterLeave))
  const afterLeaveNodes = await allNodeClasses()
  check('节点自身的悬停 class 也一起清掉',
    Object.values(afterLeaveNodes).every((c) => !c.includes('mf-node-hover')),
    JSON.stringify(afterLeaveNodes))

  /* ================================================================== */
  console.log('\n[5] 图 → 代码：单击联动（持久高亮 + scrollIntoView 居中）')
  /* ================================================================== */

  // 点图上可见的根节点 n0 —— 它的声明写在**第 31 行**（倒数第二个声明）
  const n0Rect = await nodeRect('n0')
  const vpForCheck = await viewportRect()
  check('找到图上的节点 n0', n0Rect != null)
  check('n0 在可视区内（否则点不到，测的就不是滚动）',
    n0Rect.cy > vpForCheck.top && n0Rect.cy < vpForCheck.top + vpForCheck.height,
    `${n0Rect.cy} vs ${vpForCheck.top}..${vpForCheck.top + vpForCheck.height}`)

  await realClick(n0Rect.cx, n0Rect.cy)
  await sleep(1000)                       // 等平滑滚动结束

  const clicked = await bandStates()
  note(`单击 n0（第 ${LINE_OF(0)} 行）→ ${JSON.stringify(clicked)}`)
  check('单击后第 31 行高亮', clicked[String(LINE_OF(0))] != null, JSON.stringify(clicked))
  check('高亮状态标记为 sel（与 hover 区分）',
    clicked[String(LINE_OF(0))]?.state === 'sel', JSON.stringify(clicked))
  check('持久选中背景 rgba(59, 130, 246, 0.2)',
    clicked[String(LINE_OF(0))]?.bg === 'rgba(59, 130, 246, 0.2)',
    String(clicked[String(LINE_OF(0))]?.bg))

  const afterScroll = await scrollInfo()
  note(`滚动：${initialScroll.scrollTop} → ${afterScroll.scrollTop}`)
  check('代码编辑器发生了滚动（scrollIntoView 生效）',
    afterScroll.scrollTop > initialScroll.scrollTop + 50,
    `${initialScroll.scrollTop} → ${afterScroll.scrollTop}`)

  const centered = await evaluate(`(() => {
    const ed = document.querySelector('[data-fold-modal] [data-code-editor]')
    const band = document.querySelector('[data-code-line="${LINE_OF(0)}"]')
    const er = ed.getBoundingClientRect()
    const br = band.getBoundingClientRect()
    return {
      bandCenter: br.top + br.height / 2 - er.top,
      viewCenter: er.height / 2,
    }
  })()`)
  note(`居中检查：${JSON.stringify(centered)}`)
  check('目标行被滚到视野中间（block: center）',
    Math.abs(centered.bandCenter - centered.viewCenter) < 40,
    JSON.stringify(centered))

  const selGutter = await gutterStates()
  check('行号栏出现选中竖条', (selGutter[String(LINE_OF(0))]?.shadow || '').includes('rgb(59, 130, 246)'),
    JSON.stringify(selGutter[String(LINE_OF(0))]))

  /* ================================================================== */
  console.log('\n[6] 点其他节点替换、点空白取消')
  /* ================================================================== */

  const n1 = await nodeRect('n1')
  await realClick(n1.cx, n1.cy)
  await sleep(900)
  const clicked2 = await bandStates()
  check('点 n1 后旧高亮（第 31 行）被取消', clicked2[String(LINE_OF(0))] == null, JSON.stringify(clicked2))
  check('点 n1 后新高亮在它自己的行上', clicked2[String(LINE_OF(1))]?.state === 'sel', JSON.stringify(clicked2))
  check('任何时刻只有一行处于选中态',
    Object.values(clicked2).filter((v) => v.state === 'sel').length === 1, JSON.stringify(clicked2))

  // 点画布空白处
  const vp = await viewportRect()
  const blank = { x: vp.left + 6, y: vp.top + 6 }
  const blankIsNode = await evaluate(`(() => {
    const el = document.elementFromPoint(${blank.x}, ${blank.y})
    return !!(el && el.closest && el.closest('g.node'))
  })()`)
  check('选中的空白点确实不在任何节点上', blankIsNode === false)
  await realClick(blank.x, blank.y)
  await sleep(400)
  const afterBlank = await bandStates()
  check('点空白处后所有代码行高亮取消', Object.keys(afterBlank).length === 0, JSON.stringify(afterBlank))

  /* ================================================================== */
  console.log('\n[7] 代码 → 图：光标联动（200ms 防抖）')
  /* ================================================================== */

  await caretTo(LINE_OF(5))               // 光标落在 n5["节点5"] 这一行
  await sleep(80)
  const midCaret = await allNodeClasses()
  check('光标移动后 80ms（防抖窗口内）图上还没有描边',
    Object.values(midCaret).every((c) => !c.includes('mf-node-code-hl')), JSON.stringify(midCaret))

  await sleep(320)
  const caretStyle = await nodeStyle('n5')
  note(`光标在第 ${LINE_OF(5)} 行 → n5 样式：${JSON.stringify(caretStyle)}`)
  check('防抖结束后 n5 被加上 mf-node-code-hl', caretStyle.cls.includes('mf-node-code-hl'),
    caretStyle.cls)
  check('描边色 #3b82f6', caretStyle.stroke === 'rgb(59, 130, 246)', String(caretStyle.stroke))
  check('描边宽度 2px', caretStyle.strokeWidth === '2px', String(caretStyle.strokeWidth))
  check('带 drop-shadow 光晕', (caretStyle.filter || '').includes('drop-shadow'), String(caretStyle.filter))

  const caretAll = await allNodeClasses()
  const hlIds = Object.entries(caretAll).filter(([, c]) => c.includes('mf-node-code-hl')).map(([k]) => k)
  check('只有 n5 被高亮（不牵连别的节点）', hlIds.length === 1 && hlIds[0] === 'n5', JSON.stringify(hlIds))

  /* ================================================================== */
  console.log('\n[7b] 键盘移动光标同样触发反向联动（onKeyUp 路径）')
  /* ================================================================== */

  const pressArrow = async (key) => {
    const vk = key === 'ArrowDown' ? 40 : 38
    const p = { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p })
    await sleep(60)
    return evaluate(`(() => {
      const ta = document.querySelector('[data-fold-modal] [data-code-input]')
      return ta.value.slice(0, ta.selectionStart).split('\\n').length
    })()`)
  }

  const movedLine = await pressArrow('ArrowDown')
  check(`ArrowDown 把光标从第 ${LINE_OF(5)} 行移到下一行`,
    movedLine === LINE_OF(5) + 1, String(movedLine))
  await sleep(320)
  const afterKey = Object.entries(await allNodeClasses())
    .filter(([, c]) => c.includes('mf-node-code-hl')).map(([k]) => k)
  // 倒序声明下，n5 的下一行正好是 n4 的声明行
  check('键盘移到 n4 那一行后，高亮跟着换成 n4',
    JSON.stringify(afterKey) === JSON.stringify(['n4']), JSON.stringify(afterKey))

  await pressArrow('ArrowUp')
  await sleep(320)
  const afterUp = Object.entries(await allNodeClasses())
    .filter(([, c]) => c.includes('mf-node-code-hl')).map(([k]) => k)
  check('ArrowUp 移回去后高亮回到 n5',
    JSON.stringify(afterUp) === JSON.stringify(['n5']), JSON.stringify(afterUp))

  /* ================================================================== */
  console.log('\n[8] 光标在连线行上 → 两端都高亮')
  /* ================================================================== */

  await caretTo(EDGE_LINE_OF(10))          // n10 --> n11
  await sleep(320)
  const edgeHl = Object.entries(await allNodeClasses())
    .filter(([, c]) => c.includes('mf-node-code-hl')).map(([k]) => k).sort()
  check('光标停在 n10 --> n11 这一行时两端都高亮',
    JSON.stringify(edgeHl) === JSON.stringify(['n10', 'n11']), JSON.stringify(edgeHl))

  await caretTo(1)                          // 光标移到表头行
  await sleep(320)
  const headHl = Object.entries(await allNodeClasses())
    .filter(([, c]) => c.includes('mf-node-code-hl')).map(([k]) => k)
  check('光标移到表头行后高亮全部取消', headHl.length === 0, JSON.stringify(headHl))

  /* ================================================================== */
  console.log('\n[9] ★ 防死循环：高亮绝不改动代码、绝不触发重绘')
  /* ================================================================== */

  await caretTo(LINE_OF(5))
  await sleep(320)
  const fpBefore = await svgFingerprint()
  const codeBefore = await codeValue()

  // 反复悬停 + 单击 + 移开
  for (const id of ['n0', 'n3', 'n7', 'n2']) {
    const r = await nodeRect(id)
    if (r) await mouseMove(r.cx, r.cy)
    await sleep(200)
  }
  await mouseMove(10, 10)
  await sleep(200)
  const r0 = await nodeRect('n0')
  await realClick(r0.cx, r0.cy)
  await sleep(700)

  const fpAfter = await svgFingerprint()
  const codeAfter = await codeValue()
  check('联动过程中代码一个字符都没变', codeAfter === codeBefore,
    `${codeBefore?.length} → ${codeAfter?.length}`)
  check('联动过程中 SVG 结构没有重绘（去掉 class 后指纹一致）',
    fpBefore && fpAfter && fpBefore.hash === fpAfter.hash && fpBefore.len === fpAfter.len,
    `${JSON.stringify(fpBefore)} → ${JSON.stringify(fpAfter)}`)

  // 反向再验一次：如果高亮真的能触发重绘，SVG 里就会多出一批新元素
  const nodeCountStable = await evaluate(`document.querySelectorAll('[data-fold-modal] g.node').length`)
  check('节点数量没有膨胀（没有「重绘 → 再高亮 → 再重绘」的循环）',
    nodeCountStable === 30, String(nodeCountStable))

  /* ================================================================== */
  console.log('\n[10] ★ 图重绘后必须重新贴回高亮 class')
  /* ================================================================== */

  await caretTo(LINE_OF(5))
  await sleep(320)
  const beforeRedraw = await nodeStyle('n5')
  check('重绘前 n5 已高亮', beforeRedraw.cls.includes('mf-node-code-hl'), beforeRedraw.cls)
  const fpBeforeRedraw = await svgFingerprint()

  // 在末尾追加一个节点 → 触发 mermaid 重绘（整棵 SVG 被换掉）
  await setCode(`${CODE}\n  n0 --> n30\n  n30["新节点"]`)
  await sleep(400)

  const fpAfterRedraw = await svgFingerprint()
  check('确实发生了重绘（SVG 指纹变了）',
    fpBeforeRedraw.hash !== fpAfterRedraw.hash, JSON.stringify({ fpBeforeRedraw, fpAfterRedraw }))

  const afterRedraw = await nodeStyle('n5')
  note(`重绘后 n5 的 class：${afterRedraw.cls}`)
  check('★ 重绘后 n5 的高亮被重新贴上（mermaid 换掉 DOM 也不丢）',
    afterRedraw.cls.includes('mf-node-code-hl'), afterRedraw.cls)
  check('重绘后描边样式仍然是 #3b82f6 / 2px',
    afterRedraw.stroke === 'rgb(59, 130, 246)' && afterRedraw.strokeWidth === '2px',
    `${afterRedraw.stroke} / ${afterRedraw.strokeWidth}`)

  /* ================================================================== */
  console.log('\n[11] ★ 语法报错时上半部分的映射仍然可用')
  /* ================================================================== */

  const BROKEN = [
    'flowchart TD',            // 1
    '  n0["根"]',               // 2
    '  n1["甲"]',               // 3
    '  n2["未闭合',              // 4  ← 坏行
    '  n0 --> n1',             // 5
    '  n1 --> n3',             // 6
    '  n3["丙"]',               // 7
  ].join('\n')
  await setCode(BROKEN)
  await sleep(600)

  const errShown = await evaluate(`(() => {
    const modal = document.querySelector('[data-fold-modal]')
    return { text: modal ? modal.innerText.includes('未闭合') || modal.innerText.includes('语法') || modal.innerText.includes('Parse') || modal.innerText.includes('Error') : false }
  })()`)
  note(`报错提示：${JSON.stringify(errShown)}`)
  check('语法错误时右侧仍保留上一版正确的图（有节点）',
    Object.keys(await allNodeClasses()).length > 0, String(Object.keys(await allNodeClasses()).length))

  // 坏代码下，悬停图上仍然存在的 n1 → 必须能定位到新代码的第 3 行
  const n1b = await nodeRect('n1')
  check('坏代码下图上仍有 n1', n1b != null)
  if (n1b) {
    await mouseMove(n1b.cx, n1b.cy)
    await sleep(350)
    const brokenHover = await bandStates()
    note(`坏代码下悬停 n1 → ${JSON.stringify(brokenHover)}`)
    check('★ 语法报错时联动没有失效（第 3 行被高亮）', brokenHover['3'] != null,
      JSON.stringify(brokenHover))
    check('高亮落在正确的行上（n1 在坏行的**上面**，仍然准确）',
      brokenHover['3']?.state === 'hover', JSON.stringify(brokenHover))
  }

  // 光标停在坏行上不能崩
  await caretTo(4)
  await sleep(320)
  const afterBadCaret = await evaluate(`!!document.querySelector('[data-fold-modal]')`)
  check('光标停在坏行上不崩溃（弹窗还在）', afterBadCaret === true)

  // 光标停在坏行**之后**的合法行 → 依然能联动
  await caretTo(7)
  await sleep(320)
  const n3Hl = await allNodeClasses()
  check('坏行之后的合法行（n3 声明）仍能反向联动',
    (n3Hl.n3 || '').includes('mf-node-code-hl'), JSON.stringify(n3Hl.n3))

  /* ================================================================== */
  console.log('\n[12] 切换模式时联动状态不残留')
  /* ================================================================== */

  await setCode(CODE)
  await caretTo(LINE_OF(5))
  await sleep(320)
  check('切模式前 n5 是描边状态',
    (await nodeStyle('n5')).cls.includes('mf-node-code-hl'))
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('[data-mode-tab="outline"]').click()
    await sleep(400)
    document.querySelector('[data-mode-tab="code"]').click()
    await sleep(400)
  })()`)
  const afterMode = await allNodeClasses()
  check('切回代码模式后没有残留的描边',
    Object.values(afterMode).every((c) => !c.includes('mf-node-code-hl')), JSON.stringify(afterMode))

  /* ================================================================== */
  console.log('\n[13] ★ 加高亮带没有把原来的浮层盖住（层级回归）')
  /* ================================================================== */
  /*
   * 为了让高亮带压在文字下面，代码内容那一层加了 z-index。
   * 这是个很容易连带踩到的坑：同一层里**后面**的绝对定位兄弟
   * （错误行覆盖条、右下角「?」气泡）会一起被压到下面 ——
   * 而「?」按钮被拉伸到整块高度的 textarea 盖住之后，点击永远落在
   * textarea 上，按钮就成了摆设。这类问题用 getComputedStyle 看不出来，
   * 必须真的点一下。
   */
  const layers = await evaluate(`(() => {
    const row = document.querySelector('[data-fold-modal] [data-code-editor] > div:nth-child(2)')
    const tip = document.querySelector('[data-tip-bubble]')
    return {
      rowZ: row ? getComputedStyle(row).zIndex : null,
      tipZ: tip ? getComputedStyle(tip).zIndex : null,
    }
  })()`)
  note(`层级：${JSON.stringify(layers)}`)
  check('代码内容层有 z-index（高亮带才能在它下面）',
    Number(layers.rowZ) >= 1, String(layers.rowZ))
  check('「?」气泡的 z-index 高于代码内容层',
    Number(layers.tipZ) > Number(layers.rowZ), JSON.stringify(layers))

  // 真的点一下「?」——如果被 textarea 盖住，这里必然失败
  const tipRect = await evaluate(`(() => {
    const b = document.querySelector('[data-tip-toggle]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  })()`)
  check('找到「?」按钮', tipRect != null)
  await realClick(tipRect.cx, tipRect.cy)
  await sleep(250)
  const tipText = await evaluate(`(() => {
    const el = [...document.querySelectorAll('[data-fold-modal] div')].find(d => d.innerText && d.innerText.startsWith('Mermaid 语法速查'))
    return el ? el.innerText.slice(0, 12) : null
  })()`)
  check('★ 点「?」能弹出语法速查（没有被 textarea 盖住）', tipText != null, String(tipText))
  await realClick(tipRect.cx, tipRect.cy)
  await sleep(200)

  // 错误行覆盖条必须仍然压在文字上面
  await setCode('flowchart TD\n  n0["未闭合\n  n1["好的"]')
  await sleep(600)
  const errLayer = await evaluate(`(() => {
    const ov = document.querySelector('[data-fold-modal] .mf-line-error')
    const row = document.querySelector('[data-fold-modal] [data-code-editor] > div:nth-child(2)')
    if (!ov) return null
    return {
      ovZ: getComputedStyle(ov).zIndex,
      rowZ: getComputedStyle(row).zIndex,
      bg: getComputedStyle(ov).backgroundColor,
      pointerEvents: getComputedStyle(ov).pointerEvents,
    }
  })()`)
  note(`错误覆盖条：${JSON.stringify(errLayer)}`)
  check('出错时错误行覆盖条存在', errLayer != null)
  check('★ 覆盖条层级高于代码内容层（红底不被压在文字下面）',
    Number(errLayer?.ovZ) > Number(errLayer?.rowZ), JSON.stringify(errLayer))
  check('覆盖条仍是 pointer-events:none（不挡点击）',
    errLayer?.pointerEvents === 'none', String(errLayer?.pointerEvents))

  /* ================================================================== */
  console.log('\n[14] 控制台无错误')
  check('页面无未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  cdp.close()
  proc.kill()
  try { rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`\n${'='.repeat(46)}`)
  console.log(`  通过 ${pass} / 失败 ${fail}`)
  console.log('='.repeat(46))
  await sleep(300)
  process.exit(fail ? 1 : 0)
}

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

main().catch((e) => {
  console.error('测试失败：', e.message)
  process.exit(2)
})
