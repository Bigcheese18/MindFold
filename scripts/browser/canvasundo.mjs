/**
 * 主画布 撤销 / 重做 端到端测试
 * ==============================
 * 覆盖需求逐条：
 *   1. 左下角工具栏里有两个独立图标按钮，位置在「缩放」右侧、「时钟」左侧
 *   2. 带 Tooltip；无历史时置灰（disabled + 降透明度 + not-allowed）
 *   3. 拖拽换位 / 修改文字 / 打·取消折角 / 删除节点 都记录快照，且可撤销、可重做
 *   4. Ctrl+Z / Ctrl+Shift+Z 在画布上生效，在输入框里不拦截
 *   5. ★ 作用域严格隔离：
 *        · 弹窗里的 Mermaid 编辑不占画布的历史格
 *        · 画布撤销**不能**冲掉弹窗里写的流程图（数据层隔离）
 *        · 弹窗自己的撤销不消费画布的历史栈
 *
 * 需要 dev server 已启动：npm run dev
 * 用法：node scripts/canvasundo.mjs [url]
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

const PORT = 9346
const userDir = mkdtempSync(join(tmpdir(), 'mf-canvasundo-'))

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
    await sleep(250)
  }
  const clickSel = async (sel) => {
    const r = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 }
    })()`)
    if (!r) return false
    await realClick(r.cx, r.cy)
    return true
  }

  /* ---------------- 读状态 ---------------- */

  /** 工具栏按钮信息（按 DOM 顺序） */
  const toolbar = () => evaluate(`(() => {
    const bar = document.querySelector('[data-bottom-toolbar]')
    if (!bar) return null
    const btns = [...bar.querySelectorAll('[data-tool]')]
    return {
      order: btns.map(b => b.dataset.tool),
      history: btns.filter(b => b.dataset.tool === 'undo' || b.dataset.tool === 'redo').map(b => {
        const cs = getComputedStyle(b)
        return {
          tool: b.dataset.tool,
          disabled: b.disabled,
          dataDisabled: b.dataset.disabled || null,
          title: b.getAttribute('title'),
          aria: b.getAttribute('aria-label'),
          opacity: cs.opacity,
          cursor: cs.cursor,
          color: cs.color,
          borderColor: cs.borderColor,
          paths: b.querySelectorAll('svg path').length,
          w: b.getBoundingClientRect().width,
          h: b.getBoundingClientRect().height,
        }
      }),
    }
  })()`)

  /** 从 localStorage 读当前文档的树（最精确的结构来源） */
  const docTree = () => evaluate(`(() => {
    let id = null
    try { id = JSON.parse(localStorage.getItem('mf:active')) } catch { id = localStorage.getItem('mf:active') }
    if (!id) id = (JSON.parse(localStorage.getItem('mf:tabs') || '[]')[0])
    const raw = localStorage.getItem('mf:doc:' + id)
    if (!raw) return null
    const d = JSON.parse(raw)
    const out = []
    const walk = (n, depth, parent) => {
      out.push({
        id: n.id, text: n.text, depth, parent,
        fold: n.fold ? { corner: !!n.fold.corner, mermaid: n.fold.mermaid || '', openCount: n.fold.openCount || 0 } : null,
      })
      n.children.forEach(c => walk(c, depth + 1, n.id))
    }
    walk(d.root, 0, null)
    return out
  })()`)

  /** 等防抖落盘（persist 是 900ms）后再读树 */
  const settle = async () => { await sleep(1250); return docTree() }

  const nodeRect = (id) => evaluate(`(() => {
    const el = document.querySelector('[data-node-id="' + ${JSON.stringify(id)} + '"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  })()`)

  /** 真实鼠标拖拽：从 fromId 拖到 toId 的指定区域 */
  const dragNode = async (fromId, toId, mode = 'child') => {
    const a = await nodeRect(fromId)
    const b = await nodeRect(toId)
    if (!a || !b) return { error: `找不到节点 ${!a ? fromId : toId}` }
    const ty = mode === 'child' ? b.cy : (mode === 'before' ? b.top + b.height * 0.15 : b.top + b.height * 0.85)

    await mouseMove(a.cx, a.cy)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.cx, y: a.cy, button: 'left', clickCount: 1 })
    // 分步移动：先越过 6px 的防误触阈值，再走向目标
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: a.cx + (b.cx - a.cx) * (i / steps),
        y: a.cy + (ty - a.cy) * (i / steps),
        button: 'left', buttons: 1,
      })
      await sleep(55)
    }
    await sleep(220)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.cx, y: ty, button: 'left', buttons: 1 })
    await sleep(220)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.cx, y: ty, button: 'left', clickCount: 1 })
    await sleep(500)
    return { ok: true }
  }

  /** 在节点上右键 → 点某个菜单项 */
  const contextAction = async (id, action) => {
    const r = await nodeRect(id)
    if (!r) return { error: `找不到节点 ${id}` }
    await mouseMove(r.cx, r.cy)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: r.cx, y: r.cy, button: 'right', clickCount: 1,
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: r.cx, y: r.cy, button: 'right', clickCount: 1,
    })
    await sleep(350)
    const ok = await clickSel(`[data-canvas-menu] [data-menu-item="${action}"]`)
    await sleep(400)
    return { ok }
  }

  const pressKey = (key, { ctrl = false, shift = false, target = 'window' } = {}) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const el = ${target === 'window' ? 'window' : `document.querySelector(${JSON.stringify(target)})`}
    if (!el) return { error: '找不到按键目标' }
    const ev = new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, ctrlKey: ${ctrl}, metaKey: false, shiftKey: ${shift},
      bubbles: true, cancelable: true,
    })
    el.dispatchEvent(ev)
    await sleep(700)
    return { prevented: ev.defaultPrevented }
  })()`)

  const activeEl = () => evaluate(`(() => {
    const ae = document.activeElement
    return { tag: ae ? ae.tagName : null, id: ae ? (ae.dataset ? Object.values(ae.dataset)[0] : null) : null }
  })()`)

  /* ================================================================== */
  console.log('\n[1] 工具栏：两个按钮的位置与外观')
  /* ================================================================== */

  const bar = await toolbar()
  check('找到左下角工具栏', bar != null)
  note(`工具栏顺序：${JSON.stringify(bar.order)}`)

  const iZoomOut = bar.order.indexOf('zoom-out')
  const iUndo = bar.order.indexOf('undo')
  const iRedo = bar.order.indexOf('redo')
  const iHistory = bar.order.indexOf('history')
  check('工具栏里有撤销按钮', iUndo >= 0)
  check('工具栏里有重做按钮', iRedo >= 0)
  check('★ 撤销按钮在「缩小」右侧', iUndo > iZoomOut, `zoom-out@${iZoomOut} undo@${iUndo}`)
  check('★ 撤销按钮在「历史版本（时钟）」左侧', iUndo < iHistory, `undo@${iUndo} history@${iHistory}`)
  check('重做紧跟在撤销右边', iRedo === iUndo + 1, `undo@${iUndo} redo@${iRedo}`)

  const undoBtn = bar.history.find((b) => b.tool === 'undo')
  const redoBtn = bar.history.find((b) => b.tool === 'redo')
  check('两个按钮是独立的两颗（不是一颗切换）', !!undoBtn && !!redoBtn)
  check('按钮里是 SVG 图标（不是文字字符）',
    undoBtn.paths === 2 && redoBtn.paths === 2, `${undoBtn.paths}/${redoBtn.paths}`)
  /*
   * 尺寸 34×34（原来是 28×28）。
   * 需求「底下的工具放大一点」：28px 在 1080p / 2K 屏上偏小，
   * 图标和文字挤在一起。这里断言的是「和工具栏其他按钮一致」这个不变量 ——
   * 具体数值只是它的实现，改尺寸时两边一起改，不允许只有撤销/重做被落下。
   */
  check('按钮尺寸和工具栏其他按钮一致（34×34）',
    Math.round(undoBtn.w) === 34 && Math.round(undoBtn.h) === 34, `${undoBtn.w}×${undoBtn.h}`)
  check('Tooltip：撤销 (Ctrl+Z)', undoBtn.title === '撤销 (Ctrl+Z)', String(undoBtn.title))
  check('Tooltip：重做 (Ctrl+Shift+Z)', redoBtn.title === '重做 (Ctrl+Shift+Z)', String(redoBtn.title))
  check('带 aria-label（无障碍）', undoBtn.aria === undoBtn.title && redoBtn.aria === redoBtn.title)
  check('颜色走 CSS 变量（三种主题自动适配）',
    undoBtn.color && undoBtn.color !== 'rgb(0, 0, 0)' && undoBtn.borderColor !== 'rgba(0, 0, 0, 0)',
    JSON.stringify({ c: undoBtn.color, b: undoBtn.borderColor }))

  check('初始两个按钮都置灰（disabled）',
    undoBtn.disabled === true && redoBtn.disabled === true,
    JSON.stringify([undoBtn.disabled, redoBtn.disabled]))
  check('置灰时带 data-disabled 标记',
    undoBtn.dataDisabled === 'true' && redoBtn.dataDisabled === 'true')
  check('置灰时降透明度', parseFloat(undoBtn.opacity) < 1, undoBtn.opacity)
  check('置灰时 cursor 是 not-allowed', undoBtn.cursor === 'not-allowed', undoBtn.cursor)

  /* ================================================================== */
  console.log('\n[2] 准备：读初始树结构')
  /* ================================================================== */

  let tree = await settle()
  check('读到当前文档的树', Array.isArray(tree) && tree.length > 3, JSON.stringify(tree?.length))
  note(`树结构（${tree.length} 个节点）：`)
  for (const n of tree.slice(0, 24)) {
    console.log(`      ${'  '.repeat(n.depth)}${n.text.slice(0, 24)}${n.fold ? ' [折角]' : ''}`)
  }
  if (tree.length > 24) console.log(`      …还有 ${tree.length - 24} 个`)

  /*
   * 找一对「同父、且都没有子节点」的兄弟来拖拽。
   * 不写死「根的第一、第二个子节点」—— 示例文档的层级形状会随
   * sample.js 的改动而变，写死下标等于把测试绑在夹具上。
   */
  const byParent = new Map()
  for (const n of tree) {
    if (!byParent.has(n.parent)) byParent.set(n.parent, [])
    byParent.get(n.parent).push(n)
  }
  let pair = null
  for (const [pid, sibs] of byParent) {
    if (pid == null) continue
    const leaves = sibs.filter((s) => !tree.some((n) => n.parent === s.id))
    if (leaves.length >= 2) { pair = leaves; break }
  }
  check('找到一对同父的叶子兄弟（用于拖拽）', pair != null,
    JSON.stringify([...byParent.values()].map((v) => v.map((x) => x.text))))
  const dragSrc = pair[0]
  const dragDst = pair[1]
  note(`拖拽对象：「${dragSrc.text}」 → 「${dragDst.text}」（共同父节点 ${dragSrc.parent}）`)
  const parentOf = (t, id) => t.find((n) => n.id === id)?.parent
  const originalParent = dragSrc.parent

  /* ================================================================== */
  console.log('\n[3] 拖拽换位 → 可撤销 → 可重做')
  /* ================================================================== */

  const dragRes = await dragNode(dragSrc.id, dragDst.id, 'child')
  check('拖拽动作执行成功', dragRes.ok === true, JSON.stringify(dragRes))
  tree = await settle()
  check('★ 拖拽后层级真的变了（成为目标的子节点）',
    parentOf(tree, dragSrc.id) === dragDst.id,
    `parent=${parentOf(tree, dragSrc.id)} 期望=${dragDst.id}`)

  const afterDrag = await toolbar()
  const u1 = afterDrag.history.find((b) => b.tool === 'undo')
  check('拖拽后撤销按钮变为可用', u1.disabled === false, JSON.stringify(u1.disabled))
  check('可用时透明度恢复', parseFloat(u1.opacity) === 1, u1.opacity)
  check('可用时 cursor 是 pointer', u1.cursor === 'pointer', u1.cursor)

  await clickSel('[data-tool="undo"]')
  tree = await settle()
  check('★ 撤销拖拽：层级回到原样', parentOf(tree, dragSrc.id) === originalParent,
    `parent=${parentOf(tree, dragSrc.id)} 期望=${originalParent}`)

  await clickSel('[data-tool="redo"]')
  tree = await settle()
  check('★ 重做拖拽：又变回子节点', parentOf(tree, dragSrc.id) === dragDst.id,
    `parent=${parentOf(tree, dragSrc.id)}`)

  // 收尾：撤销回去，后面的用例从干净状态开始
  await clickSel('[data-tool="undo"]')
  tree = await settle()
  check('再次撤销回到干净状态', parentOf(tree, dragSrc.id) === originalParent)

  /* ================================================================== */
  console.log('\n[4] 修改文字 → 可撤销')
  /* ================================================================== */

  const before4 = tree.find((n) => n.id === dragSrc.id).text
  const NEW_TEXT = '改过的文字XYZ'
  // 双击节点进入行内编辑 → 输入 → 回车
  const r4 = await nodeRect(dragSrc.id)
  await mouseMove(r4.cx, r4.cy)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r4.cx, y: r4.cy, button: 'left', clickCount: 2 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r4.cx, y: r4.cy, button: 'left', clickCount: 2 })
  await sleep(400)
  const edited = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const inp = document.querySelector('[data-node-id="${dragSrc.id}"] input, [data-node-id="${dragSrc.id}"] textarea')
    if (!inp) return { error: '没进入编辑态' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, ${JSON.stringify(NEW_TEXT)})
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(120)
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await sleep(500)
    return { ok: true }
  })()`)
  check('双击进入编辑态并提交成功', edited.ok === true, JSON.stringify(edited))
  tree = await settle()
  check('文字真的改了', tree.find((n) => n.id === dragSrc.id).text === NEW_TEXT,
    tree.find((n) => n.id === dragSrc.id).text)

  await clickSel('[data-tool="undo"]')
  tree = await settle()
  check('★ 撤销改字：文字回到原来的内容',
    tree.find((n) => n.id === dragSrc.id).text === before4,
    `${tree.find((n) => n.id === dragSrc.id).text} 期望 ${before4}`)

  /* ================================================================== */
  console.log('\n[5] 右键打上折角 → 可撤销')
  /* ================================================================== */

  tree = await settle()
  check('前置：目标节点当前没有折角', !tree.find((n) => n.id === dragSrc.id).fold)
  await contextAction(dragSrc.id, 'add-fold')
  tree = await settle()
  check('★ 右键打上折角生效', !!tree.find((n) => n.id === dragSrc.id).fold,
    JSON.stringify(tree.find((n) => n.id === dragSrc.id)))

  await clickSel('[data-tool="undo"]')
  tree = await settle()
  check('★ 撤销打上折角：折角消失', !tree.find((n) => n.id === dragSrc.id).fold,
    JSON.stringify(tree.find((n) => n.id === dragSrc.id).fold))

  await clickSel('[data-tool="redo"]')
  tree = await settle()
  check('重做：折角又回来了', !!tree.find((n) => n.id === dragSrc.id).fold)

  /* ================================================================== */
  console.log('\n[6] ★ 作用域隔离 A：弹窗里的编辑不占画布的历史格')
  /* ================================================================== */

  // 先数一下当前能撤销多少步
  const countUndoSteps = async () => {
    let n = 0
    for (let i = 0; i < 40; i++) {
      const b = (await toolbar()).history.find((x) => x.tool === 'undo')
      if (b.disabled) break
      await clickSel('[data-tool="undo"]')
      n++
    }
    return n
  }

  // 记录「弹窗编辑之前」能撤销的步数
  const stepsBeforeModal = await countUndoSteps()
  note(`弹窗编辑前可撤销 ${stepsBeforeModal} 步`)

  // 把画布栈恢复回来（全部重做）
  for (let i = 0; i < 40; i++) {
    const b = (await toolbar()).history.find((x) => x.tool === 'redo')
    if (b.disabled) break
    await clickSel('[data-tool="redo"]')
  }
  tree = await settle()
  check('全部重做后折角仍在（回到最新状态）', !!tree.find((n) => n.id === dragSrc.id).fold,
    JSON.stringify(tree.find((n) => n.id === dragSrc.id).fold))

  // 打开弹窗，写一段 Mermaid 代码，关闭
  const MODAL_CODE = 'flowchart TD\n  m0["弹窗里写的"]\n  m0 --> m1\n  m1["第二"]'
  /** 打开某个折角弹窗 → 切代码模式 → 写入 code → 关闭 */
  const writeFoldCode = (nodeId, code) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const badge = document.querySelector('[data-node-id="${nodeId}"] [data-fold-badge]')
    if (!badge) return { error: '找不到折角角标' }
    badge.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(2200)
    if (!document.querySelector('[data-fold-modal]')) return { error: '弹窗没打开' }
    document.querySelector('[data-mode-tab="code"]').click()
    await sleep(600)
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(code)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(1600)
    // 关闭弹窗（点右上角 ✕ 会走 flushPending）
    const closeBtn = [...document.querySelectorAll('[data-fold-modal] button')].find(b => b.getAttribute('title') === '关闭 (Esc)')
    if (closeBtn) closeBtn.click()
    else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(900)
    return { ok: !document.querySelector('[data-fold-modal]') }
  })()`)

  const modalRes = await writeFoldCode(dragSrc.id, MODAL_CODE)
  check('弹窗打开 → 写代码 → 关闭', modalRes.ok === true, JSON.stringify(modalRes))

  tree = await settle()
  const foldAfterModal = tree.find((n) => n.id === dragSrc.id).fold
  check('★ 弹窗写的代码已经存进折角', foldAfterModal?.mermaid === MODAL_CODE,
    JSON.stringify(foldAfterModal?.mermaid))

  const stepsAfterModal = await countUndoSteps()
  note(`弹窗编辑后可撤销 ${stepsAfterModal} 步（弹窗前 ${stepsBeforeModal} 步）`)
  check('★ 弹窗编辑**没有**在画布历史里多出一格',
    stepsAfterModal === stepsBeforeModal, `${stepsBeforeModal} → ${stepsAfterModal}`)

  /* ================================================================== */
  console.log('\n[7] ★ 作用域隔离 B：画布撤销不能冲掉弹窗写的流程图')
  /* ================================================================== */
  /*
   * 这里必须**按事故发生的真实顺序**来演，否则测不出东西：
   *
   *   ① 先打上折角（此时折角内容为空）
   *   ② 拖拽一下  ← 快照在这一刻入栈，快照里的折角是**空的**
   *   ③ 打开弹窗写流程图
   *   ④ 关闭弹窗，按画布撤销
   *
   * 撤销会把 ② 的快照写回去。若不合并折角内容，流程图就被退回「空」，
   * 用户刚写的东西凭空消失 —— 这正是 mergeFoldContent 要防的事故。
   *
   * 【曾经写错过的版本】顺序反了：先写流程图、再拖拽、再撤销。
   * 那样快照里本来就带着流程图，去掉 mergeFoldContent 测试照样全绿（实测）。
   * 一个不按真实时序走的测试，等于没测。
   */
  // 先把画布栈全重做回最新
  for (let i = 0; i < 40; i++) {
    const b = (await toolbar()).history.find((x) => x.tool === 'redo')
    if (b.disabled) break
    await clickSel('[data-tool="redo"]')
  }
  tree = await settle()

  // ① 打上折角（内容为空）
  /*
   * 【必须挑一个**还没有折角**的节点】
   * 这里原来直接取 pair[2]，而示例文档里 HTTP 与 HTTPS 的区别本来就带 [F]。
   * 后果是连锁的、而且完全静默：
   *   · 菜单上那一项是「取消折角」，不是「打上折角」→ clickSel 找不到 → 返回 false
   *   · 菜单**没被关掉**，正好盖在节点上
   *   · 紧接着的 dragNode 在节点中心按下鼠标，落在菜单上 → 拖拽根本没开始
   *   · 而下面那句 `fold.mermaid === ''` 仍然为真（有 [F] 但没代码块时 mermaid 就是空串）
   * 于是「拖拽后层级变了」失败，但看起来像是拖拽功能的 bug。
   * 现在显式挑无折角的节点，并把前置条件断言出来 —— 空测比失败更危险。
   */
  const third = pair.slice(2).find((p) => !p.fold) || pair[2]
  check('找到第三个叶子兄弟用于本轮测试（且它还没有折角）',
    third != null && !third.fold,
    JSON.stringify(pair.map((p) => `${p.text}${p.fold ? '[折角]' : ''}`)))
  const thirdParent = third.parent

  // ① 打上折角（内容为空）
  const foldRes7 = await contextAction(third.id, 'add-fold')
  // 断言菜单项真的点到了：点不到就说明菜单还开着，后面的拖拽必然被挡住
  check('① 菜单项「打上折角」确实点到了', foldRes7.ok === true, JSON.stringify(foldRes7))
  check('① 点完之后菜单已关闭（不会挡住后续拖拽）',
    (await evaluate(`!document.querySelector('[data-canvas-menu]')`)) === true)
  tree = await settle()
  check('① 打上折角，内容为空', tree.find((n) => n.id === third.id).fold?.mermaid === '',
    JSON.stringify(tree.find((n) => n.id === third.id).fold))

  // ② 拖拽 —— 快照在此时入栈（折角还是空的）
  const dragRes2 = await dragNode(third.id, dragDst.id, 'child')
  check('② 拖拽成功', dragRes2.ok === true, JSON.stringify(dragRes2))
  tree = await settle()
  check('② 拖拽后层级变了', parentOf(tree, third.id) === dragDst.id,
    `实际父=${tree.find((n) => n.id === parentOf(tree, third.id))?.text}(${parentOf(tree, third.id)}) ` +
    `期望=${dragDst.text}(${dragDst.id}) 被拖=${third.text}(${third.id})`)

  // ③ 打开弹窗写流程图
  const CODE7 = 'flowchart TD\n  p0["事故现场"]\n  p0 --> p1\n  p1["必须活下来"]'
  const res7 = await writeFoldCode(third.id, CODE7)
  check('③ 弹窗里写好了流程图', res7.ok === true, JSON.stringify(res7))
  tree = await settle()
  check('③ 流程图已存进折角', tree.find((n) => n.id === third.id).fold?.mermaid === CODE7,
    JSON.stringify(tree.find((n) => n.id === third.id).fold?.mermaid))

  // ④ 画布撤销
  await clickSel('[data-tool="undo"]')
  tree = await settle()
  const thirdAfterUndo = tree.find((n) => n.id === third.id)
  check('④ 撤销拖拽：层级回到原样', parentOf(tree, third.id) === thirdParent,
    `parent=${parentOf(tree, third.id)} 期望=${thirdParent}`)
  check('★★ 撤销拖拽后，折角里的流程图**原封不动**（没被画布历史冲掉）',
    thirdAfterUndo.fold?.mermaid === CODE7,
    JSON.stringify(thirdAfterUndo.fold?.mermaid))
  check('★★ 折角的实心/空心标记也没被改错（corner 与内容一致）',
    thirdAfterUndo.fold?.corner === true, JSON.stringify(thirdAfterUndo.fold))

  /* ================================================================== */
  console.log('\n[7b] 反向对照：撤销「取消折角」必须把内容还回来')
  /* ================================================================== */

  await contextAction(third.id, 'remove-fold')
  // 取消折角有确认弹窗
  const confirmed = await clickSel('[data-confirm-ok]')
  check('取消折角弹出确认框', confirmed === true)
  tree = await settle()
  check('折角已被取消', !tree.find((n) => n.id === third.id).fold)

  await clickSel('[data-tool="undo"]')
  tree = await settle()
  const restored = tree.find((n) => n.id === third.id).fold
  check('★ 撤销「取消折角」：折角回来了', !!restored, JSON.stringify(restored))
  check('★ 而且带着原来的流程图（快照里存着删之前那一版）',
    restored?.mermaid === CODE7, JSON.stringify(restored?.mermaid))
  check('★ 回来的是实心折角（corner 和内容一致）', restored?.corner === true,
    JSON.stringify(restored))

  /* ================================================================== */
  console.log('\n[8] ★ 作用域隔离 C：弹窗自己的撤销不消费画布的历史栈')
  /* ================================================================== */

  /*
   * 先做一次**可预期**的画布操作（拖拽），这样后面点画布撤销时，
   * 我们确切知道该退掉什么 —— 否则「撤销后状态变了没」是没法断言的
   * （栈里上一条可能是好几步之前的操作，退出来的是别的效果）。
   */
  await dragNode(dragSrc.id, dragDst.id, 'child')
  tree = await settle()
  check('前置：拖拽后 dragSrc 成为 dragDst 的子节点',
    parentOf(tree, dragSrc.id) === dragDst.id, `parent=${parentOf(tree, dragSrc.id)}`)

  const beforeModalUndo = (await toolbar()).history.map((b) => b.disabled)
  check('前置：此时画布撤销可用', beforeModalUndo[0] === false, JSON.stringify(beforeModalUndo))

  const modalUndoRes = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const badge = document.querySelector('[data-node-id="${dragSrc.id}"] [data-fold-badge]')
    badge.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(2200)
    if (!document.querySelector('[data-fold-modal]')) return { error: '弹窗没打开' }
    document.querySelector('[data-mode-tab="code"]').click()
    await sleep(600)
    // 在弹窗里改一笔，制造弹窗自己的历史
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(MODAL_CODE)} + '\\n  m1 --> m2\\n  m2["第三"]')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(1600)
    const undoBtn = document.querySelector('[data-fold-modal] [data-undo-button="toolbar"][data-undo-kind="undo"]')
    const modalUndoEnabled = undoBtn && !undoBtn.disabled
    // 点弹窗自己的撤销
    if (undoBtn) undoBtn.click()
    await sleep(800)
    const code = document.querySelector('[data-fold-modal] [data-code-input]').value
    const closeBtn = [...document.querySelectorAll('[data-fold-modal] button')].find(b => b.getAttribute('title') === '关闭 (Esc)')
    if (closeBtn) closeBtn.click()
    await sleep(900)
    return { modalUndoEnabled, codeAfterModalUndo: code }
  })()`)
  note(`弹窗内撤销后代码：${JSON.stringify((modalUndoRes.codeAfterModalUndo || '').slice(0, 40))}`)
  check('弹窗里自己的撤销是可用的', modalUndoRes.modalUndoEnabled === true, JSON.stringify(modalUndoRes))
  check('弹窗内撤销生效（代码退回到上一版）',
    modalUndoRes.codeAfterModalUndo === MODAL_CODE, JSON.stringify(modalUndoRes.codeAfterModalUndo))

  const afterModalUndo = (await toolbar()).history.map((b) => b.disabled)
  check('★ 弹窗内的撤销没有动过画布的按钮状态',
    JSON.stringify(afterModalUndo) === JSON.stringify(beforeModalUndo),
    `${JSON.stringify(beforeModalUndo)} → ${JSON.stringify(afterModalUndo)}`)

  // ★ 关键：画布撤销依然能把「刚才那次拖拽」退掉 —— 说明栈没被弹窗消费
  await clickSel('[data-tool="undo"]')
  tree = await settle()
  check('★★ 弹窗折腾完之后，画布撤销依然生效（退掉了刚才那次拖拽）',
    parentOf(tree, dragSrc.id) === originalParent,
    `parent=${parentOf(tree, dragSrc.id)} 期望=${originalParent}`)
  check('★ 退掉拖拽的同时，折角内容还是弹窗写的那份',
    tree.find((n) => n.id === dragSrc.id).fold?.mermaid === MODAL_CODE,
    JSON.stringify(tree.find((n) => n.id === dragSrc.id).fold?.mermaid))

  /* ================================================================== */
  console.log('\n[9] 键盘：Ctrl+Z / Ctrl+Shift+Z 在画布上生效')
  /* ================================================================== */

  await clickSel('[data-tool="undo"]')   // 制造一个可重做状态
  tree = await settle()
  const redoNow = (await toolbar()).history.find((b) => b.tool === 'redo')
  check('前置：此时可以重做', redoNow.disabled === false, JSON.stringify(redoNow.disabled))

  // 焦点放在画布空白处（不是输入框）
  await realClick(720, 450)
  const ctrlZ = await pressKey('z', { ctrl: true })
  check('画布上 Ctrl+Z 被接管（preventDefault）', ctrlZ.prevented === true, JSON.stringify(ctrlZ))

  const ctrlShiftZ = await pressKey('z', { ctrl: true, shift: true })
  check('画布上 Ctrl+Shift+Z 被接管', ctrlShiftZ.prevented === true, JSON.stringify(ctrlShiftZ))

  /* ---- 输入框里不拦截 ---- */
  const inField = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const inp = document.querySelector('[data-node-id="${dragSrc.id}"] [data-text]')
    return { hasText: !!inp }
  })()`)
  check('节点文本容器存在（用于确认焦点场景）', inField.hasText === true)

  // 造一个真实输入框：双击进编辑态
  const r9 = await nodeRect(dragSrc.id)
  await mouseMove(r9.cx, r9.cy)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r9.cx, y: r9.cy, button: 'left', clickCount: 2 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r9.cx, y: r9.cy, button: 'left', clickCount: 2 })
  await sleep(400)
  const focusIn = await activeEl()
  note(`编辑态焦点：${JSON.stringify(focusIn)}`)
  const ctrlZInField = await pressKey('z', { ctrl: true })
  check('★ 焦点在节点编辑框里时 Ctrl+Z 不被画布接管',
    ctrlZInField.prevented === false, JSON.stringify(ctrlZInField))
  await pressKey('Escape')

  /* ================================================================== */
  console.log('\n[10] 控制台无错误')
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
