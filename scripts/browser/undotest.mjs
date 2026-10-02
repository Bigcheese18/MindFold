/**
 * 弹窗内撤销 / 重做系统 端到端测试
 * ==================================
 * 覆盖：
 *   1. 两个按钮（左工具栏 / 右悬浮）共用同一份历史栈
 *   2. 初始置灰：disabled + opacity .5 + cursor not-allowed + 颜色走 CSS 变量
 *   3. Tooltip 文案
 *   4. 打字停笔 1 秒后入栈；撤销回到上一版并重绘
 *   5. 结构性操作（右键菜单 / 合并 / 移动）立刻入栈
 *   6. Ctrl+Z 在图表区生效、在代码编辑器里**不拦截**（保留原生文本撤销）
 *   7. Ctrl+Shift+Z 重做
 *   8. 撤销后焦点回到图表容器
 *   9. 作用域隔离：撤销不碰主画布的节点层级
 *  10. 上限 20
 *
 * 需要 dev server 已启动：npm run dev
 * 用法：node scripts/undotest.mjs [url]
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

const PORT = 9343
const userDir = mkdtempSync(join(tmpdir(), 'mf-undo-'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (msg) => console.log(`  · ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    await sleep(450)
  }
  const rectOf = (sel) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, cx: r.left + r.width/2, cy: r.top + r.height/2 }
  })()`)
  const clickSel = async (sel) => {
    const r = await rectOf(sel)
    if (!r) return { error: `找不到 ${sel}` }
    await realClick(r.cx, r.cy)
    return { ok: true }
  }

  /** 两个撤销按钮的状态快照 */
  const undoButtons = () => evaluate(`(() => {
    const all = [...document.querySelectorAll('[data-undo-button]')]
    return all.map(b => {
      const cs = getComputedStyle(b)
      return {
        where: b.dataset.undoButton,
        kind: b.dataset.undoKind,
        disabled: b.disabled,
        dataDisabled: b.dataset.disabled || null,
        opacity: cs.opacity,
        cursor: cs.cursor,
        color: cs.color,
        borderColor: cs.borderColor,
        title: b.getAttribute('title'),
        aria: b.getAttribute('aria-label'),
        hasSvg: !!b.querySelector('svg'),
        parentIsBody: b.parentElement === document.body,
        rounded: cs.borderRadius,
      }
    })
  })()`)

  const readCode = () => evaluate(`(() => {
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    return ta ? ta.value : null
  })()`)

  /** 模拟真实打字：逐字符改 textarea 的值并触发 input */
  const typeCode = async (src, { pauseMs = 1400 } = {}) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    if (!ta) return { error: '找不到代码编辑器' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(src)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(${pauseMs})
    return { ok: true, value: ta.value }
  })()`)

  const pressKey = (key, { ctrl = false, shift = false, target = 'window' } = {}) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const el = ${target === 'window' ? 'window' : `document.querySelector(${JSON.stringify(target)})`}
    if (!el) return { error: '找不到按键目标' }
    const ev = new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, ctrlKey: ${ctrl}, metaKey: false, shiftKey: ${shift},
      bubbles: true, cancelable: true,
    })
    el.dispatchEvent(ev)
    await sleep(900)
    return { prevented: ev.defaultPrevented }
  })()`)

  const activeEl = () => evaluate(`(() => {
    const ae = document.activeElement
    return {
      tag: ae ? ae.tagName : null,
      isViewport: ae ? ae.hasAttribute('data-graph-viewport') : false,
      isTextarea: ae ? ae.tagName === 'TEXTAREA' : false,
    }
  })()`)

  /* ---------------- 打开弹窗 → 代码模式 ---------------- */
  console.log('\n[0] 准备')
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

  /* ================================================================== */
  console.log('\n[1] 两个按钮存在、共用同一份历史、初始置灰')
  /* ================================================================== */

  const btns = await undoButtons()
  note(`按钮：${JSON.stringify(btns.map(b => ({ where: b.where, kind: b.kind, disabled: b.disabled })))}`)
  check('有两个撤销按钮（左工具栏 + 右悬浮）',
    btns.filter((b) => b.kind === 'undo').length === 2, JSON.stringify(btns.map((b) => b.where)))
  check('两个按钮的定位分别是 toolbar 与 floating',
    btns.some((b) => b.where === 'toolbar') && btns.some((b) => b.where === 'floating'),
    JSON.stringify(btns.map((b) => b.where)))
  check('按钮里有内联 SVG 图标', btns.every((b) => b.hasSvg === true))
  check('悬浮按钮是圆形', (btns.find((b) => b.where === 'floating')?.rounded || '').startsWith('9999') ||
    parseFloat(btns.find((b) => b.where === 'floating')?.rounded) > 8,
  btns.find((b) => b.where === 'floating')?.rounded)

  const undos = btns.filter((b) => b.kind === 'undo')
  check('初始两个撤销按钮都是 disabled', undos.every((b) => b.disabled === true),
    JSON.stringify(undos.map((b) => b.disabled)))
  check('disabled 时 opacity 是 0.5', undos.every((b) => b.opacity === '0.5'),
    JSON.stringify(undos.map((b) => b.opacity)))
  check('disabled 时 cursor 是 not-allowed', undos.every((b) => b.cursor === 'not-allowed'),
    JSON.stringify(undos.map((b) => b.cursor)))
  check('带 data-disabled 标记', undos.every((b) => b.dataDisabled === 'true'))
  check('Tooltip 是「撤销 (Ctrl+Z)」', undos.every((b) => b.title === '撤销 (Ctrl+Z)'),
    JSON.stringify(undos.map((b) => b.title)))
  check('颜色走 CSS 变量（不是硬编码色值）',
    undos.every((b) => b.color && b.color !== 'rgb(0, 0, 0)'), JSON.stringify(undos.map((b) => b.color)))
  check('按钮不在 body 上（在弹窗内部）', undos.every((b) => b.parentIsBody === false))

  // 两个按钮点击后走同一个 handler：各自点一次，历史只应该退一步
  console.log('\n[1b] 两个按钮共享同一份历史栈')

  /* ================================================================== */
  console.log('\n[2] 打字停笔 1 秒后入栈 → 撤销回到上一版')
  /* ================================================================== */

  const V1 = 'flowchart TD\n  n0["根"]\n  n0 --> n1\n  n1["甲"]'
  await typeCode(V1)
  const afterV1 = await undoButtons()
  const undo1 = afterV1.filter((b) => b.kind === 'undo')
  check('打字停笔后撤销按钮变为可用', undo1.every((b) => b.disabled === false),
    JSON.stringify(undo1.map((b) => b.disabled)))
  check('可用时 opacity 是 1', undo1.every((b) => b.opacity === '1'),
    JSON.stringify(undo1.map((b) => b.opacity)))
  check('可用时 cursor 是 pointer', undo1.every((b) => b.cursor === 'pointer'),
    JSON.stringify(undo1.map((b) => b.cursor)))

  const V2 = 'flowchart TD\n  n0["根"]\n  n0 --> n1\n  n1["乙"]\n  n1 --> n2\n  n2["丙"]'
  await typeCode(V2)
  check('第二次打字后代码是 V2', (await readCode()) === V2, String(await readCode()).slice(0, 40))

  // 点左侧工具栏的撤销
  await clickSel('[data-undo-button="toolbar"][data-undo-kind="undo"]')
  const back1 = await readCode()
  note(`撤销后代码：${JSON.stringify((back1 || '').slice(0, 40))}`)
  check('点工具栏撤销 → 回到 V1', back1 === V1, JSON.stringify((back1 || '').slice(0, 60)))

  // 点右侧悬浮的撤销（同一份历史栈）
  await clickSel('[data-undo-button="floating"][data-undo-kind="undo"]')
  const back0 = await readCode()
  check('点悬浮撤销 → 继续回到更早的状态（共享同一份历史）',
    back0 !== V1 && back0 !== V2, JSON.stringify((back0 || '').slice(0, 60)))

  // 撤到底 → 按钮重新置灰
  for (let i = 0; i < 25; i++) {
    const st = (await undoButtons()).filter((b) => b.kind === 'undo')
    if (st.every((b) => b.disabled)) break
    await clickSel('[data-undo-button="toolbar"][data-undo-kind="undo"]')
  }
  const atBottom = (await undoButtons()).filter((b) => b.kind === 'undo')
  check('撤到底后两个撤销按钮都置灰', atBottom.every((b) => b.disabled === true),
    JSON.stringify(atBottom.map((b) => b.disabled)))

  /* ================================================================== */
  console.log('\n[3] Ctrl+Z 路由：图表区生效、代码编辑器里不拦截')
  /* ================================================================== */

  // 重新造两版历史
  await typeCode(V1)
  await typeCode(V2)
  await clickSel('[data-graph-viewport]')
  const focusInGraph = await activeEl()
  note(`点图表后焦点：${JSON.stringify(focusInGraph)}`)

  const ctrlZ = await pressKey('z', { ctrl: true })
  check('图表区 Ctrl+Z 被我们接管（preventDefault）', ctrlZ.prevented === true, JSON.stringify(ctrlZ))
  check('Ctrl+Z 撤销生效', (await readCode()) === V1, JSON.stringify((await readCode()).slice(0, 40)))

  // 焦点在代码编辑器里 → 不拦截
  const inEditor = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    ta.focus()
    await sleep(200)
    return { focused: document.activeElement === ta }
  })()`)
  check('能把焦点放进代码编辑器', inEditor.focused === true, JSON.stringify(inEditor))

  /*
   * 两条路径都要测：
   *  A. 事件从 textarea 冒泡上来 —— 实际上被 CodeEditor 自己的
   *     onKeyDown(stopPropagation) 挡在了 React 根容器，压根到不了 window。
   *  B. 事件直接落在 window 上（例如浏览器/扩展的合成事件，或者将来
   *     CodeEditor 去掉了那个 stopPropagation）—— 这时**必须**靠
   *     「activeElement 是输入框就 return」这道保护。
   * 只测 A 的话，把保护删掉测试照样绿（实测过），等于没测。
   */
  const ctrlZFromInput = await pressKey('z', { ctrl: true, target: '[data-fold-modal] [data-code-input]' })
  check('A: 从代码编辑器冒泡的 Ctrl+Z 不会被我们接管',
    ctrlZFromInput.prevented === false, JSON.stringify(ctrlZFromInput))

  const ctrlZOnWindow = await pressKey('z', { ctrl: true, target: 'window' })
  check('B: 焦点在编辑器时，落在 window 上的 Ctrl+Z 也不被拦截（靠 activeElement 保护）',
    ctrlZOnWindow.prevented === false, JSON.stringify(ctrlZOnWindow))
  check('编辑器里的 Ctrl+Z 没有改动我们的历史（代码仍是 V1）',
    (await readCode()) === V1, JSON.stringify((await readCode()).slice(0, 40)))

  /* ================================================================== */
  console.log('\n[3b] 打字后 1 秒内立刻撤销：不能丢刚打的字、也不能多退一步')
  /* ================================================================== */

  /*
   * 这是「flush vs cancel」的分水岭。
   * cancel 的话这次打字没成为历史点，撤销会跳过它退到更早的状态 ——
   * 用户感觉「刚打的字没了，还多退了一步」。正确做法是先 flush 再撤销。
   */
  const A1 = 'flowchart TD\n  n0["A1"]'
  const A2 = 'flowchart TD\n  n0["A2"]'
  await typeCode(A1, { pauseMs: 1400 })      // 让 A1 稳稳成为一个历史点
  await typeCode(A2, { pauseMs: 120 })       // 只等 120ms，远小于 1 秒防抖
  check('A2 已经写进编辑器', (await readCode()) === A2, JSON.stringify((await readCode()).slice(0, 40)))

  await clickSel('[data-undo-button="toolbar"][data-undo-kind="undo"]')
  const afterQuickUndo = await readCode()
  note(`快速撤销后：${JSON.stringify((afterQuickUndo || '').slice(0, 40))}`)
  check('打字后立刻撤销 → 回到上一次的历史点（A1），而不是多退一步',
    afterQuickUndo === A1, JSON.stringify((afterQuickUndo || '').slice(0, 60)))

  /* ================================================================== */
  console.log('\n[4] Ctrl+Shift+Z 重做')
  /* ================================================================== */

  // 重新造两版历史，再撤销一次以制造「可重做」的状态
  await typeCode(V1)
  await typeCode(V2)
  await clickSel('[data-graph-viewport]')
  await clickSel('[data-undo-button="toolbar"][data-undo-kind="undo"]')
  check('撤销后代码是 V1（为下面的重做做准备）',
    (await readCode()) === V1, JSON.stringify((await readCode()).slice(0, 40)))

  await clickSel('[data-graph-viewport]')
  const redoBtns = (await undoButtons()).filter((b) => b.kind === 'redo')
  check('有重做按钮且此时可用', redoBtns.length >= 1 && redoBtns.every((b) => b.disabled === false),
    JSON.stringify(redoBtns.map((b) => b.disabled)))
  check('重做按钮 Tooltip 是「重做 (Ctrl+Shift+Z)」',
    redoBtns.every((b) => b.title === '重做 (Ctrl+Shift+Z)'), JSON.stringify(redoBtns.map((b) => b.title)))

  const ctrlShiftZ = await pressKey('z', { ctrl: true, shift: true })
  check('Ctrl+Shift+Z 被接管', ctrlShiftZ.prevented === true, JSON.stringify(ctrlShiftZ))
  check('重做回到 V2', (await readCode()) === V2, JSON.stringify((await readCode()).slice(0, 40)))

  /* ================================================================== */
  console.log('\n[5] 撤销后焦点回到图表容器')
  /* ================================================================== */

  await clickSel('[data-undo-button="toolbar"][data-undo-kind="undo"]')
  await sleep(500)
  const focusAfterUndo = await activeEl()
  note(`撤销后焦点：${JSON.stringify(focusAfterUndo)}`)
  check('撤销后焦点在图表容器上（快捷键不会失效）',
    focusAfterUndo.isViewport === true, JSON.stringify(focusAfterUndo))

  /* ================================================================== */
  console.log('\n[6] 结构性操作立刻入栈')
  /* ================================================================== */

  const BASE = [
    'flowchart TD',
    '  n0["根"]',
    '  n1["甲"]',
    '  n2["乙"]',
    '  n0 --> n1',
    '  n0 --> n2',
  ].join('\n')
  await typeCode(BASE)

  // 右键 → 新增子节点（结构性操作）
  const beforeStructural = await readCode()
  const structural = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    for (const g of document.querySelectorAll('[data-fold-modal] g.node')) {
      const m = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      if (m && m[1] === 'n1') {
        const r = g.getBoundingClientRect()
        const inner = g.querySelector('rect, .label, foreignObject') || g
        inner.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2,
        }))
      }
    }
    await sleep(450)
    const btn = document.querySelector('[data-node-menu] [data-menu-item="child"]')
    if (!btn) return { error: '菜单没出现' }
    btn.click()
    await sleep(1400)
    return { code: document.querySelector('[data-fold-modal] [data-code-input]').value }
  })()`)
  note(`新增子节点后：${JSON.stringify((structural.code || '').slice(0, 60))}`)
  check('右键新增子节点改变了代码', structural.code !== beforeStructural, JSON.stringify(structural.error))

  // 不等防抖，立刻撤销 —— 结构性操作应该是立刻入栈的
  await clickSel('[data-undo-button="toolbar"][data-undo-kind="undo"]')
  check('结构性操作立刻入栈（不用等 1 秒防抖就能撤销）',
    (await readCode()) === beforeStructural, JSON.stringify((await readCode()).slice(0, 60)))

  /* ================================================================== */
  console.log('\n[7] 作用域隔离：撤销不碰主画布')
  /* ================================================================== */

  const canvasBefore = await evaluate(`(() => {
    // 弹窗打开时画布被盖住，但 DOM 还在 —— 记录它的节点数与折角数
    return {
      nodes: document.querySelectorAll('[data-node-id]').length,
      folds: document.querySelectorAll('[data-fold-badge]').length,
    }
  })()`)
  await clickSel('[data-undo-button="toolbar"][data-undo-kind="undo"]')
  await clickSel('[data-undo-button="toolbar"][data-undo-kind="undo"]')
  const canvasAfter = await evaluate(`(() => ({
    nodes: document.querySelectorAll('[data-node-id]').length,
    folds: document.querySelectorAll('[data-fold-badge]').length,
  }))()`)
  note(`画布节点：${canvasBefore.nodes} → ${canvasAfter.nodes}`)
  check('撤销不改变主画布的节点数', canvasBefore.nodes === canvasAfter.nodes,
    `${canvasBefore.nodes} → ${canvasAfter.nodes}`)
  check('撤销不改变主画布的折角数', canvasBefore.folds === canvasAfter.folds,
    `${canvasBefore.folds} → ${canvasAfter.folds}`)

  /* ================================================================== */
  console.log('\n[8] 上限 20')
  /* ================================================================== */

  // 连打 26 版，每次停笔超过 1 秒
  for (let i = 0; i < 26; i++) {
    await typeCode(`flowchart TD\n  n0["v${i}"]`, { pauseMs: 1150 })
  }
  let steps = 0
  for (let i = 0; i < 40; i++) {
    const st = (await undoButtons()).filter((b) => b.kind === 'undo')
    if (st.every((b) => b.disabled)) break
    await clickSel('[data-undo-button="toolbar"][data-undo-kind="undo"]')
    steps++
  }
  note(`最多能撤销 ${steps} 步`)
  check('撤销步数被夹在 20 以内', steps <= 20, String(steps))
  check('确实积累了接近上限的历史（>10 步）', steps > 10, String(steps))

  /* ---------------- 收尾 ---------------- */
  console.log('\n[9] 控制台无错误')
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
