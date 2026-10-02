/**
 * 「指向」（单对单连线）端到端测试
 * ================================
 * 弹窗右侧流程图右键菜单里的「指向」：右键 A → 点「指向」→ 点 B → 代码里多一条 A --> B。
 *
 * 和 mergetest（指向同一结果）是**姊妹套件**：两者共用同一套连线模式状态机，
 * 所以这里除了测自己的逻辑，还要测「两个功能互不干扰」。
 *
 * 覆盖需求逐条：
 *   一·1  右键菜单里「指向」在「指向同一结果」上方
 *   一·2  点击后进入连线模式：十字准星 + 提示条
 *   一·3  点空白取消 / 点自己提示「不能指向自身」
 *   一·4  插入 A --> B，触发重绘，退出连线模式
 *   二·1  去重：已有 A --> B（含 A-->B 紧凑写法）→ 提示「该连线已存在」
 *   二·2  插入到已有的连线区
 *   二·3  id 一律裸写（加引号 mermaid 会报错 —— 见 codeOps 注释）
 *   三·4  两种模式执行不同代码生成，完成后 linkingMode 归位
 *   四·1  节点 A 保持选中高亮；完成后焦点回到画布容器
 *   四·2  Esc 也能取消
 *   四·3  窄屏底部操作栏里有「指向」和「指向同一结果」
 *   四·4  可撤销（压入弹窗撤销栈）
 *
 * 需要 dev server 已启动：npm run dev
 * 用法：node scripts/directlink.mjs [url]
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

const PORT = 9355
const userDir = mkdtempSync(join(tmpdir(), 'mf-direct-'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (msg) => console.log(`  · ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 起点代码：A → B 已有，用来测「去重」；C 是孤立节点，用来测「加新边」 */
const SRC = [
  'flowchart TD',
  '  A["开始"]',
  '  B["中间"]',
  '  C["结束"]',
  '  A --> B',
].join('\n')

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
    await sleep(1500)
    return { ok: true }
  })()`)

  const readCode = () => evaluate(`(() => {
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    return ta ? ta.value : null
  })()`)

  const graphStats = () => evaluate(`(() => {
    const s = document.querySelector('[data-fold-modal]')
    return {
      nodes: s.querySelectorAll('g.node').length,
      edges: s.querySelectorAll('path.flowchart-link').length,
    }
  })()`)

  const rightClickNode = (id) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const s = document.querySelector('[data-fold-modal]')
    let target = null
    for (const g of s.querySelectorAll('g.node')) {
      const m = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      if (m && m[1] === ${JSON.stringify(id)}) { target = g; break }
    }
    if (!target) return { error: '找不到节点 ' + ${JSON.stringify(id)} }
    const r = target.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    const inner = target.querySelector('rect, .label, foreignObject') || target
    inner.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 2,
    }))
    await sleep(400)
    const menu = document.querySelector('[data-node-menu]')
    return {
      ok: !!menu,
      items: menu ? [...menu.querySelectorAll('[data-menu-item]')].map(b => b.dataset.menuItem) : [],
    }
  })()`)

  const clickMenuItem = (action) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const btn = document.querySelector('[data-node-menu] [data-menu-item="${action}"]')
    if (!btn) return { error: '菜单里没有 ' + ${JSON.stringify(action)} }
    btn.click()
    await sleep(500)
    return { ok: true }
  })()`)

  const clickNode = (id) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const s = document.querySelector('[data-fold-modal]')
    let target = null
    for (const g of s.querySelectorAll('g.node')) {
      const m = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      if (m && m[1] === ${JSON.stringify(id)}) { target = g; break }
    }
    if (!target) return { error: '找不到节点 ' + ${JSON.stringify(id)} }
    const r = target.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    const inner = target.querySelector('rect, .label, foreignObject') || target
    inner.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0,
    }))
    await sleep(1100)
    return { ok: true }
  })()`)

  const clickBlank = () => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const vp = document.querySelector('[data-graph-viewport]')
    if (!vp) return { error: '找不到画布容器' }
    const r = vp.getBoundingClientRect()
    vp.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: r.left + 6, clientY: r.bottom - 6, button: 0,
    }))
    await sleep(500)
    return { ok: true }
  })()`)

  /** 当前连线模式状态（从提示条 + 准星读出来） */
  const linkState = () => evaluate(`(() => {
    const vp = document.querySelector('[data-graph-viewport]')
    const hint = document.querySelector('[data-link-hint]')
    const sel = document.querySelector('[data-fold-modal] .mf-node-sel')
    return {
      cursor: vp ? getComputedStyle(vp).cursor : null,
      mode: hint ? hint.dataset.linkMode : null,
      hint: hint ? hint.textContent.trim() : null,
      selectedId: sel ? ((sel.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/) || [])[1] : null,
    }
  })()`)

  const readToast = () => evaluate(`(() => {
    const t = document.querySelector('[data-toast]')
    return t ? t.textContent.trim() : null
  })()`)

  const pressEsc = () => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(400)
    return { ok: true }
  })()`)

  const focusInfo = () => evaluate(`(() => {
    const vp = document.querySelector('[data-graph-viewport]')
    return { active: document.activeElement === vp, tag: document.activeElement?.tagName || null }
  })()`)

  /* ================================================================== */
  console.log('\n[1] 菜单：指向 在 指向同一结果 上方')
  /* ================================================================== */

  await writeCode(SRC)
  const menu = await rightClickNode('B')
  note(`菜单项：${JSON.stringify(menu.items)}`)
  check('右键节点弹出菜单', menu.ok === true, JSON.stringify(menu))
  check('★ 菜单里有「指向」', menu.items?.includes('direct'), JSON.stringify(menu.items))
  check('★ 菜单里有「指向同一结果」', menu.items?.includes('merge'), JSON.stringify(menu.items))
  check('★ 「指向」就在「指向同一结果」正上方',
    menu.items?.indexOf('direct') === 0 && menu.items?.indexOf('merge') === 1,
    JSON.stringify(menu.items))
  check('两个都在「新增同级节点」上方',
    menu.items?.indexOf('sibling') === 2, JSON.stringify(menu.items))

  /* ================================================================== */
  console.log('\n[2] 进入连线模式')
  /* ================================================================== */

  await clickMenuItem('direct')
  const sel = await linkState()
  note(`cursor=${sel.cursor} mode=${sel.mode}`)
  note(`提示：${sel.hint}`)
  check('★ 画布容器变成十字准星', sel.cursor === 'crosshair', String(sel.cursor))
  check('★ 提示条存在且 mode=direct', sel.mode === 'direct', String(sel.mode))
  check('★ 提示文案说明「点击要指向的目标节点」',
    !!sel.hint && sel.hint.includes('点击要指向的目标节点'), String(sel.hint))
  check('提示里带上了源节点 id（用户知道从谁出发）',
    !!sel.hint && sel.hint.includes('B'), String(sel.hint))
  check('★ 节点 A（B）保持选中高亮', sel.selectedId === 'B', String(sel.selectedId))
  check('菜单已关闭', (await evaluate(`!document.querySelector('[data-node-menu]')`)) === true)

  /* ================================================================== */
  console.log('\n[3] Esc 取消')
  /* ================================================================== */

  await pressEsc()
  const afterEsc = await linkState()
  check('★ Esc 退出连线模式', afterEsc.mode === null && afterEsc.cursor !== 'crosshair',
    JSON.stringify(afterEsc))
  check('Esc 取消后代码一个字没改', (await readCode()) === SRC)

  /* ================================================================== */
  console.log('\n[4] 点空白取消')
  /* ================================================================== */

  await rightClickNode('B')
  await clickMenuItem('direct')
  check('前置：又进入连线模式', (await linkState()).mode === 'direct')
  await clickBlank()
  const afterBlank = await linkState()
  check('★ 点空白退出连线模式', afterBlank.mode === null, JSON.stringify(afterBlank))
  check('点空白后代码一个字没改', (await readCode()) === SRC)

  /* ================================================================== */
  console.log('\n[5] 点自己 → 提示「不能指向自身」')
  /* ================================================================== */

  await rightClickNode('B')
  await clickMenuItem('direct')
  await clickNode('B')
  const selfToast = await readToast()
  note(`toast=${JSON.stringify(selfToast)}`)
  check('★ 点自己弹出「不能指向自身」', selfToast === '不能指向自身', String(selfToast))
  check('★ 点自己后仍停留在连线模式（可以改点别人）',
    (await linkState()).mode === 'direct', JSON.stringify(await linkState()))
  check('点自己后代码没改', (await readCode()) === SRC)

  /* ================================================================== */
  console.log('\n[6] 完成连线：B --> C')
  /* ================================================================== */

  const before = await graphStats()
  note(`连线前：${before.nodes} 节点 / ${before.edges} 连线`)

  await clickNode('C')
  const afterCode = await readCode()
  const after = await graphStats()
  note(`连线后：${after.nodes} 节点 / ${after.edges} 连线`)
  console.log('    生成的代码：')
  console.log(afterCode.split('\n').map((l) => '      ' + l).join('\n'))

  check('★ 代码里出现了 B --> C', /B\s*-->\s*C/.test(afterCode), afterCode)
  check('★ 节点数**没有变**（指向不新建节点，这是和合并的本质区别）',
    after.nodes === before.nodes, `${before.nodes} → ${after.nodes}`)
  check('★ 连线数 +1', after.edges === before.edges + 1, `${before.edges} → ${after.edges}`)
  check('原有边 A --> B 没丢', /A\s*-->\s*B/.test(afterCode), afterCode)
  check('原有节点定义没丢',
    /A\s*\[\s*"开始"\s*\]/.test(afterCode) && /C\s*\[\s*"结束"\s*\]/.test(afterCode), afterCode)
  check('★ 没有生成「新结果节点」这种多余节点',
    !afterCode.includes('新结果节点'), afterCode)

  const afterLink = await linkState()
  check('★ 退出连线模式（提示条消失、准星恢复）',
    afterLink.mode === null && afterLink.cursor !== 'crosshair', JSON.stringify(afterLink))

  /* ---- 插入位置：在已有连线区 ---- */
  check('★ 新边插在原有边之后（进入已有的连线区，不是无脑追加到文件末尾）', (() => {
    const lines = afterCode.split('\n')
    const iOld = lines.findIndex((l) => /A\s*-->\s*B/.test(l))
    const iNew = lines.findIndex((l) => /B\s*-->\s*C/.test(l))
    return iOld >= 0 && iNew > iOld
  })(), afterCode)

  /* ================================================================== */
  console.log('\n[7] 完成后焦点回到画布容器（四·1）')
  /* ================================================================== */

  const fi = await focusInfo()
  note(`activeElement=${fi.tag}`)
  check('★ 焦点回到右侧画布容器', fi.active === true, JSON.stringify(fi))

  /*
   * ★ 更严的一档：焦点原本在**代码编辑器**里时，连线完成后也必须回到画布。
   *
   * 这一条不是凑数 —— 弹窗里另有一个「svg 变化就把焦点还给画布」的 effect，
   * 但它有一条 `if (typing) return` 的闸门（否则用户每敲一个字都会被抢走焦点，
   * 根本没法打字）。所以「光标还在编辑器里」这个场景下，那个 effect 是**不会**执行的，
   * 全靠连线逻辑自己显式聚焦。不测这一档，那行 focusGraph() 就是可以随便删掉的死代码。
   */
  await writeCode(SRC)
  const typingFocus = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    ta.focus()
    await sleep(200)
    return { inEditor: document.activeElement === ta }
  })()`)
  check('前置：焦点确实在代码编辑器里', typingFocus.inEditor === true, JSON.stringify(typingFocus))

  await rightClickNode('B')
  await clickMenuItem('direct')
  await clickNode('C')
  const fi2 = await focusInfo()
  note(`连线后 activeElement=${fi2.tag}`)
  check('★ 焦点原本在编辑器里时，连线完成后仍然回到画布容器',
    fi2.active === true, JSON.stringify(fi2))
  check('这条连线也真的加上了', /B\s*-->\s*C/.test(await readCode()), await readCode())

  /* ================================================================== */
  console.log('\n[8] 撤销：压入了弹窗撤销栈（四·4）')
  /* ================================================================== */

  const undoRes = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const b = document.querySelector('[data-fold-modal] [data-undo-button="toolbar"][data-undo-kind="undo"]')
    if (!b) return { error: '找不到撤销按钮' }
    const wasEnabled = !b.disabled
    b.click()
    await sleep(1000)
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    return { wasEnabled, code: ta ? ta.value : null }
  })()`)
  check('★ 连线后撤销按钮可用（说明压入了历史栈）', undoRes.wasEnabled === true, JSON.stringify(undoRes))
  check('★ 撤销把 B --> C 退掉了', !/B\s*-->\s*C/.test(undoRes.code || ''), String(undoRes.code))
  check('撤销后回到原始代码', undoRes.code === SRC, String(undoRes.code))

  // 重做装回来，方便后面测去重
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const b = document.querySelector('[data-fold-modal] [data-undo-button="toolbar"][data-undo-kind="redo"]')
    if (b) b.click()
    await sleep(1000)
    return true
  })()`)
  check('重做后 B --> C 回来了', /B\s*-->\s*C/.test(await readCode()), await readCode())

  /* ================================================================== */
  console.log('\n[9] 去重：已存在的连线不再插入（二·1）')
  /* ================================================================== */

  const codeBeforeDup = await readCode()
  await rightClickNode('A')
  await clickMenuItem('direct')
  await clickNode('B')   // A --> B 已经存在
  const dupToast = await readToast()
  note(`toast=${JSON.stringify(dupToast)}`)
  check('★ 提示「该连线已存在」', dupToast === '该连线已存在', String(dupToast))
  check('★ 没有重复插入（代码一字未改）', (await readCode()) === codeBeforeDup, await readCode())
  check('★ 重复尝试后也退出了连线模式',
    (await linkState()).mode === null, JSON.stringify(await linkState()))

  // 紧凑写法 A-->B 也要认出来
  const compact = 'flowchart TD\n  A["x"]\n  B["y"]\n  A-->B'
  await writeCode(compact)
  await rightClickNode('A')
  await clickMenuItem('direct')
  await clickNode('B')
  const dupToast2 = await readToast()
  check('★ 紧凑写法 A-->B 也被判为已存在', dupToast2 === '该连线已存在', String(dupToast2))
  check('紧凑写法下代码没被改', (await readCode()) === compact, await readCode())

  /* ================================================================== */
  console.log('\n[10] id 含连字符：裸写，不加引号（二·3 的实测修正）')
  /* ================================================================== */

  const HYPHEN = 'flowchart TD\n  A["x"]\n  node-1["y"]\n  A --> node-1'
  await writeCode(HYPHEN)
  await rightClickNode('node-1')
  await clickMenuItem('direct')
  await clickNode('A')
  const hyCode = await readCode()
  console.log('    生成的代码：')
  console.log(hyCode.split('\n').map((l) => '      ' + l).join('\n'))
  check('★ 连字符 id 能正常连线', /node-1\s*-->\s*A/.test(hyCode), hyCode)
  check('★ 生成的是裸 id，没有加引号（加引号 mermaid 会 Parse error）',
    !hyCode.includes('"node-1"') && !/-->\s*"/.test(hyCode), hyCode)
  check('★ 加了这条边之后图仍然渲染成功（没有掉进语法错误）',
    (await graphStats()).edges >= 2, JSON.stringify(await graphStats()))

  /* ================================================================== */
  console.log('\n[11] 两个功能互不干扰（三·4）')
  /* ================================================================== */

  await writeCode(SRC)
  // 先做一次「指向」
  await rightClickNode('B')
  await clickMenuItem('direct')
  await clickNode('C')
  const afterDirect = await readCode()
  check('前置：指向成功', /B\s*-->\s*C/.test(afterDirect), afterDirect)

  // 紧接着做一次「指向同一结果」—— 必须仍然正常工作
  await rightClickNode('A')
  await clickMenuItem('merge')
  const mergeSel = await linkState()
  check('★ 紧接着进入 merge 模式（模式没被上一次 direct 串味）',
    mergeSel.mode === 'merge', String(mergeSel.mode))
  check('★ merge 模式的提示文案和 direct 不同',
    !!mergeSel.hint && mergeSel.hint.includes('指向同一个新结果节点'), String(mergeSel.hint))

  const beforeMerge = await graphStats()
  await clickNode('B')
  const afterMergeCode = await readCode()
  const afterMerge = await graphStats()
  check('★ 合并仍然新建了节点（节点数 +1）',
    afterMerge.nodes === beforeMerge.nodes + 1, `${beforeMerge.nodes} → ${afterMerge.nodes}`)
  check('★ 合并生成了「新结果节点」', afterMergeCode.includes('新结果节点'), afterMergeCode)
  check('★ 上一次 direct 加的 B --> C 还在（两者互不覆盖）',
    /B\s*-->\s*C/.test(afterMergeCode), afterMergeCode)

  // 收掉合并后自动弹出的改字框，避免影响后续
  await pressEsc()
  await sleep(400)

  /* ================================================================== */
  console.log('\n[12] 缩进模式下也有这两个入口（两个模式共用同一套完整菜单）')
  /* ================================================================== */

  const outlineMenu = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const tab = document.querySelector('[data-mode-tab="outline"]')
    if (tab) tab.click()
    await sleep(700)
    const s = document.querySelector('[data-fold-modal]')
    const g = s.querySelector('g.node')
    if (!g) return { error: '缩进模式下没有图节点' }
    const r = g.getBoundingClientRect()
    const inner = g.querySelector('rect, .label, foreignObject') || g
    inner.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2,
    }))
    await sleep(400)
    const menu = document.querySelector('[data-node-menu]')
    return {
      items: menu ? [...menu.querySelectorAll('[data-menu-item]')].map(b => b.dataset.menuItem) : [],
      selected: (document.querySelector('[data-node-menu]') && s.querySelector('g.node.mf-node-sel')) ? true : false,
    }
  })()`)
  note(`缩进模式菜单项：${JSON.stringify(outlineMenu.items)}`)
  /*
   * 【为什么从「没有」改成「必须有」】
   * 早先按 mode 把连线两项关掉了，理由是「缩进列表表达不了多对一」。
   * 但那个理由不成立：这两项改的一直是 **Mermaid 代码**，而缩进列表编译出来
   * 的就是 Mermaid 代码、缩进模式下节点 id 恒为 `n<行号>`，一样是合法 id。
   * 结果是用户必须先切到代码模式才能用到它们 —— 纯属人为限制。
   * 这里钉的就是「两个模式的菜单项集合必须一致」。
   */
  check('★ 缩进模式菜单里有「指向」',
    outlineMenu.items?.includes('direct'), JSON.stringify(outlineMenu.items))
  check('★ 缩进模式菜单里有「指向同一结果」',
    outlineMenu.items?.includes('merge'), JSON.stringify(outlineMenu.items))
  check('★ 缩进模式菜单里有「移动位置」',
    outlineMenu.items?.includes('move'), JSON.stringify(outlineMenu.items))
  check('缩进模式原来的三件套还在',
    outlineMenu.items?.includes('sibling') && outlineMenu.items?.includes('child') &&
    outlineMenu.items?.includes('delete'), JSON.stringify(outlineMenu.items))

  /* ---- 缩进模式下真的能用：走一遍「指向」并验证结果落到缩进列表上 ---- */
  const outlineLink = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const rows = () => [...document.querySelectorAll('[data-fold-modal] [data-outline-row]')]
    // 记录菜单打开的节点是哪一行，指向最后一行
    const gs = [...document.querySelectorAll('[data-fold-modal] g.node')]
    const inner = gs[0].querySelector('rect, .label, foreignObject') || gs[0]
    const r0 = gs[0].getBoundingClientRect()
    inner.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2, button: 2,
    }))
    await sleep(350)
    const btn = document.querySelector('[data-node-menu] [data-menu-item="direct"]')
    if (!btn) return { error: '菜单里没有「指向」' }
    btn.click()
    await sleep(350)
    // 点最后一个图节点作为目标
    const last = gs[gs.length - 1]
    const r1 = last.getBoundingClientRect()
    last.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: r1.left + r1.width / 2, clientY: r1.top + r1.height / 2,
    }))
    await sleep(1200)
    return {
      rows: rows().length,
      outline: rows().map((row) => row.querySelector('input').value),
    }
  })()`)
  note(`缩进模式走完「指向」后：${JSON.stringify(outlineLink)}`)
  check('★ 缩进模式下「指向」真的生效（缩进列表里出现了引用）',
    (outlineLink.outline || []).some((s) => s.includes('->')), JSON.stringify(outlineLink))
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    // 撤销掉刚才的连线，后面的用例要干净的状态
    const btns = [...document.querySelectorAll('[data-undo-button]')]
    const t = btns.find(b => b.dataset.undoKind !== 'redo' && !b.disabled)
    if (t) t.click()
    await sleep(800)
    return true
  })()`)

  /* ================================================================== */
  console.log('\n[13] 窄屏底部操作栏（四·3）')
  /* ================================================================== */

  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const tab = document.querySelector('[data-mode-tab="code"]')
    if (tab) tab.click()
    await sleep(600)
    return true
  })()`)
  await writeCode(SRC)

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  })
  /*
   * 后面要用 Input.dispatchTouchEvent 做真实长按。
   * 不打开触摸模拟的话，Chromium 不会为合成的 touch 事件生成
   * pointerdown(pointerType='touch')，长按这条路径就测不到了。
   */
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
  await sleep(1200)

  /*
   * ★ 本轮改动：手机端底部那条「指向 / 指向同一结果」操作栏被用户删掉了
   *   （原话「底部指向和指向同一结果删了 …… 完全用不上」）。
   *   那条栏曾经是触屏唯一的建连线入口，所以删它的同时补上了
   *   **长按节点 = 桌面右键**（和主画布用的是同一组判据：500ms / 10px）。
   *   这一节改成走真实触摸长按 → 节点菜单 → 「指向」这条路径 ——
   *   比原来点底栏更接近用户真正的操作方式。
   */
  const bar = await evaluate(`(() => {
    const m = document.querySelector('[data-fold-modal]')
    const old = m.querySelector('[data-mobile-bar]')
    const bottom = m.querySelector('[data-mobile-bottom-bar]')
    return { oldBar: !!old, bottomBar: !!bottom }
  })()`)
  check('★ 手机端底部「指向 / 指向同一结果」操作栏已删除', bar.oldBar === false, JSON.stringify(bar))
  check('手机端底部换成了撤销 / 重做 / 回到中点 那条操作条', bar.bottomBar === true, JSON.stringify(bar))

  /** 真实触摸长按某个 mermaid 节点（CDP 派发，走和真手指同一条链路） */
  const longPressNode = async (pick = 'first') => {
    /*
     * 装一个 pointerdown 记录器。
     * 它把「长按没反应」拆成两种完全不同的故障：
     *   · 事件根本没到达节点（tgt/inNode 不对）→ 手势层问题
     *   · 事件到了、handler 没开菜单 → 逻辑层问题
     * 少了这一层，两种故障在测试里长得一模一样（都只是「菜单为 null」）。
     */
    await evaluate(`(() => {
      window.__lpRec = []
      if (!window.__lpHook) {
        window.__lpHook = true
        for (const t of ['pointerdown', 'touchend', 'mousedown']) {
          document.addEventListener(t, (e) => {
            const tp = e.touches && e.touches[0]
            window.__lpRec.push({ ev: t, type: e.pointerType || '', inNode: !!e.target?.closest?.('g.node'),
              x: Math.round(tp ? tp.clientX : e.clientX), y: Math.round(tp ? tp.clientY : e.clientY), t: Math.round(performance.now()) })
          }, true)
        }
      }
      return 1
    })()`)
    const c = await evaluate(`(() => {
      const gs = [...document.querySelectorAll('[data-fold-modal] g.node')]
      ${pick === 'last' ? 'const g = gs[gs.length - 1]' : 'const g = gs[0]'}
      if (!g) return null
      const r = g.getBoundingClientRect()
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
      const hit = document.elementFromPoint(x, y)
      return { x, y, hitInNode: !!hit?.closest?.('g.node') }
    })()`)
    if (!c) return null
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y, id: 1 }] })
    await sleep(700)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(450)
    const rec = await evaluate('window.__lpRec')
    return { ...c, rec }
  }

  /*
   * 前置：确保不在连线待选状态。
   *
   * 实测踩过：上一节（缩进模式那条链路）走完之后 linkingMode 还挂着，
   * 而长按的 handler 和右键**共用**同一段逻辑 —— 里面第一条就是
   * 「连线待选中的话先取消、不开菜单」。于是长按表现为「什么都不发生」，
   * 看起来像长按坏了，其实是状态没清干净。这里显式清一次并断言清干净了。
   */
  const lpLinkMode = async () => evaluate(`document.querySelector('[data-link-hint]')?.dataset.linkMode ?? null`)
  const preLink = await lpLinkMode()
  if (preLink) {
    note(`前置：上一节遗留了连线状态 ${preLink}，先按 Esc 取消`)
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(500)
  }
  check('前置：不在连线待选状态（长按走的是「先取消连线」那条分支）',
    (await lpLinkMode()) === null, String(await lpLinkMode()))

  // 长按 → 菜单里有「指向 / 指向同一结果」
  const node = await longPressNode('first')
  check('前置：找到一个可长按的节点', !!node, JSON.stringify(node))
  note(`长按目标(${node && node.x},${node && node.y}) 命中节点=${node && node.hitInNode} 收到 pointerdown=${JSON.stringify(node && node.rec)}`)
  check('前置：触摸事件真的落到了图节点上（且 pointerType=touch）',
    !!(node && node.rec?.some((r) => r.inNode && r.type === 'touch')), JSON.stringify(node && node.rec))
  const lpMenu = await evaluate(`(() => {
    const n = document.querySelector('[data-node-menu]')
    if (!n) return null
    const r = n.getBoundingClientRect()
    return {
      items: [...n.querySelectorAll('[data-menu-item]')].map(b => b.dataset.menuItem),
      inside: r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5,
      sizes: [...n.querySelectorAll('[data-menu-item]')].map(b => Math.round(b.getBoundingClientRect().height)),
    }
  })()`)
  check('★ 手机端长按节点弹出节点菜单', lpMenu != null, JSON.stringify(lpMenu))
  /*
   * ★ 回归守卫：菜单必须能在「浏览器补发的兼容鼠标事件」之后活下来。
   * 实测过的真实事故：touchend 之后 Chrome 会补发 mousedown/mouseup/click，
   * 那记 mousedown 的 target 是被长按的那个节点、当然不在菜单里，
   * 于是菜单刚弹出就被「点外面就关」关掉 —— 用户看到的是闪一下就没了。
   * 修法见 NodeContextMenu 的 OPEN_GRACE_MS。
   */
  check('★ 长按确实触发了浏览器补发的兼容 mousedown（事故现场）',
    !!(node && node.rec?.some((r) => r.ev === 'mousedown')), JSON.stringify(node && node.rec))
  if (lpMenu) {
    note(`长按菜单项：${JSON.stringify(lpMenu.items)}`)
    check('★ 菜单里有「指向」和「指向同一结果」（底栏删了，能力没丢）',
      lpMenu.items.includes('direct') && lpMenu.items.includes('merge'), JSON.stringify(lpMenu.items))
    check('菜单项触摸热区足够高（≥36px）',
      lpMenu.sizes.length > 0 && lpMenu.sizes.every(h => h >= 36), JSON.stringify(lpMenu.sizes))
    check('菜单完整在视口内', lpMenu.inside === true)
  }

  // 从长按菜单点「指向」→ 进入连线模式
  const withSel = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const btn = document.querySelector('[data-node-menu] [data-menu-item="direct"]')
    if (!btn) return { error: '菜单里没有「指向」' }
    btn.click()
    await sleep(500)
    const hint = document.querySelector('[data-link-hint]')
    const vp = document.querySelector('[data-graph-viewport]')
    return {
      mode: hint ? hint.dataset.linkMode : null,
      cursor: getComputedStyle(vp).cursor,
      menuGone: !document.querySelector('[data-node-menu]'),
    }
  })()`)
  check('★ 从长按菜单点「指向」→ 进入连线模式', withSel.mode === 'direct', JSON.stringify(withSel))
  check('连线模式下画布是十字准星', withSel.cursor === 'crosshair', String(withSel.cursor))
  check('选完菜单项菜单关闭', withSel.menuGone === true)

  /* ================================================================== */
  console.log('\n[14] 无 console 报错')
  /* ================================================================== */

  {
    const real = consoleErrors.filter((e) => !/favicon|ERR_/.test(e))
    check('整个过程没有 console 报错', real.length === 0, JSON.stringify(real.slice(0, 4)))
  }

  console.log('\n====================================================')
  console.log(`  指向 directlink  通过 ${pass} / 失败 ${fail}`)
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
