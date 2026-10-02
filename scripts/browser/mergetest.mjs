/**
 * 「指向同一结果（合并节点）」端到端测试
 * ======================================
 * 纯代码模式下，右键节点 A → 指向同一结果 → 点节点 B
 *   → 代码里生成 n9["新结果节点"] 和 A --> n9、B --> n9
 *   → 自动弹出改字框（默认全选）→ 提交 → 代码里标签被替换
 *
 * 需要 dev server 已启动：npm run dev
 * 用法：node scripts/mergetest.mjs [url]
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

const PORT = 9337
const userDir = mkdtempSync(join(tmpdir(), 'mf-merge-'))

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

  /** 写入代码（React 受控 textarea 必须用原生 setter + input 事件） */
  const writeCode = async (src) => evaluate(`(async () => {
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

  /** 取某个 mermaid id 对应节点的屏幕坐标 */
  const nodePoint = (id) => evaluate(`(() => {
    const s = document.querySelector('[data-fold-modal]')
    for (const g of s.querySelectorAll('g.node')) {
      const m = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      if (m && m[1] === ${JSON.stringify(id)}) {
        const r = g.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      }
    }
    return null
  })()`)

  /** 在节点上派发右键，打开菜单 */
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
    // mermaid 把点击目标放在内部的 rect/label 上，往最里层派发更接近真实
    const inner = target.querySelector('rect, .label, foreignObject') || target
    inner.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 2,
    }))
    await sleep(400)
    const menu = document.querySelector('[data-node-menu]')
    return { ok: !!menu, items: menu ? [...menu.querySelectorAll('[data-menu-item]')].map(b => b.dataset.menuItem) : [] }
  })()`)

  /** 点菜单里的某一项 */
  const clickMenuItem = (action) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const btn = document.querySelector('[data-node-menu] [data-menu-item="${action}"]')
    if (!btn) return { error: '菜单里没有 ' + ${JSON.stringify(action)} }
    btn.click()
    await sleep(500)
    return { ok: true }
  })()`)

  /** 点图上某个节点（模拟「选择目标」） */
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
    await sleep(1200)
    return { ok: true }
  })()`)

  /** 点画布空白处 */
  const clickBlank = () => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const vp = document.querySelector('[data-graph-viewport]')
    if (!vp) return { error: '找不到画布容器' }
    const r = vp.getBoundingClientRect()
    // 左下角通常是空白
    vp.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: r.left + 6, clientY: r.bottom - 6, button: 0,
    }))
    await sleep(500)
    return { ok: true }
  })()`)

  const MERGE_SRC = [
    'flowchart TD',
    '  n0["开始"]',
    '  n1["服务端"]',
    '  n2["客户端"]',
    '  n0 --> n1',
    '  n0 --> n2',
  ].join('\n')

  await writeCode(MERGE_SRC)

  /* ================================================================== */
  console.log('\n[1] 右键菜单出现「指向同一结果」，且在「新增同级节点」上方')
  /* ================================================================== */

  const menu = await rightClickNode('n1')
  note(`菜单项：${JSON.stringify(menu.items)}`)
  check('右键节点弹出菜单', menu.ok === true, JSON.stringify(menu))
  check('菜单里有「指向同一结果」', menu.items?.includes('merge'), JSON.stringify(menu.items))
  check('「指向」在「指向同一结果」正上方（两者都在「新增同级节点」上方）',
    menu.items?.indexOf('direct') === 0 && menu.items?.indexOf('merge') === 1 &&
    menu.items?.indexOf('sibling') === 2,
    JSON.stringify(menu.items))

  /* ================================================================== */
  console.log('\n[2] 点击后进入十字准星待选状态')
  /* ================================================================== */

  await clickMenuItem('merge')
  const selecting = await evaluate(`(() => {
    const vp = document.querySelector('[data-graph-viewport]')
    const hint = document.querySelector('[data-link-hint]')
    return {
      cursor: vp ? getComputedStyle(vp).cursor : null,
      hint: hint ? hint.textContent.trim() : null,
      menuGone: !document.querySelector('[data-node-menu]'),
    }
  })()`)
  note(`cursor=${selecting.cursor}`)
  note(`提示：${selecting.hint}`)
  check('画布容器变成十字准星', selecting.cursor === 'crosshair', String(selecting.cursor))
  check('菜单已关闭', selecting.menuGone === true)
  check('顶栏给出了待选提示', !!selecting.hint && selecting.hint.includes('n1'), String(selecting.hint))

  /* ================================================================== */
  console.log('\n[3] 点空白处取消')
  /* ================================================================== */

  await clickBlank()
  const cancelled = await evaluate(`(() => {
    const vp = document.querySelector('[data-graph-viewport]')
    return { cursor: getComputedStyle(vp).cursor, hint: !!document.querySelector('[data-link-hint]') }
  })()`)
  check('点空白后退出待选状态', cancelled.cursor !== 'crosshair' && !cancelled.hint,
    JSON.stringify(cancelled))
  const codeAfterCancel = await readCode()
  check('取消后代码一个字没改', codeAfterCancel === MERGE_SRC, '代码被改了')

  /* ================================================================== */
  console.log('\n[4] 执行合并：n1 + n2 → 新节点')
  /* ================================================================== */

  const before = await graphStats()
  note(`合并前：${before.nodes} 节点 / ${before.edges} 连线`)

  await rightClickNode('n1')
  await clickMenuItem('merge')
  await clickNode('n2')

  const afterCode = await readCode()
  const after = await graphStats()
  note(`合并后：${after.nodes} 节点 / ${after.edges} 连线`)
  console.log('    生成的代码：')
  console.log(afterCode.split('\n').map((l) => '      ' + l).join('\n'))

  check('节点数 +1', after.nodes === before.nodes + 1, `${before.nodes} → ${after.nodes}`)
  check('连线数 +2', after.edges === before.edges + 2, `${before.edges} → ${after.edges}`)
  check('代码里新增了 n3 节点定义', /n3\s*\[\s*"新结果节点"\s*\]/.test(afterCode), afterCode)
  check('代码里有 n1 --> n3', /n1\s*-->\s*n3/.test(afterCode), afterCode)
  check('代码里有 n2 --> n3', /n2\s*-->\s*n3/.test(afterCode), afterCode)
  check('原有代码没有丢', /n0\s*-->\s*n1/.test(afterCode) && /n0\s*-->\s*n2/.test(afterCode), afterCode)
  check('退出待选状态', (await evaluate(`getComputedStyle(document.querySelector('[data-graph-viewport]')).cursor`)) !== 'crosshair')

  /* ================================================================== */
  console.log('\n[5] 自动弹出改字框（默认全选）')
  /* ================================================================== */

  const editor = await evaluate(`(() => {
    const box = document.querySelector('[data-label-editor]')
    if (!box) return { open: false }
    const inp = box.querySelector('[data-label-input]')
    const r = box.getBoundingClientRect()
    return {
      open: true,
      kind: box.dataset.editorKind,
      value: inp ? inp.value : null,
      selected: inp ? (inp.selectionStart === 0 && inp.selectionEnd === inp.value.length) : false,
      focused: document.activeElement === inp,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    }
  })()`)
  note(`改字框：${JSON.stringify(editor)}`)
  check('合并后自动弹出改字框', editor.open === true, JSON.stringify(editor))
  check('改字框是「合并」模式（居中覆盖）', editor.kind === 'merge', String(editor.kind))
  check('默认文字是「新结果节点」', editor.value === '新结果节点', String(editor.value))
  check('默认全选', editor.selected === true, JSON.stringify(editor))
  check('输入框已获得焦点', editor.focused === true)

  // 改字框应该盖在新节点附近
  const n3pt = await nodePoint('n3')
  if (n3pt && editor.open) {
    const cx = editor.rect.x + editor.rect.w / 2
    const cy = editor.rect.y + editor.rect.h / 2
    check('改字框覆盖在新节点上（中心距离 < 40px）',
      Math.abs(cx - n3pt.x) < 40 && Math.abs(cy - n3pt.y) < 40,
      `editor=(${cx},${cy}) node=(${n3pt.x},${n3pt.y})`)
  } else {
    check('能定位新节点', false, JSON.stringify(n3pt))
  }

  /* ================================================================== */
  console.log('\n[6] 提交改字 → 代码同步替换')
  /* ================================================================== */

  const committed = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const inp = document.querySelector('[data-label-input]')
    if (!inp) return { error: '改字框不见了' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, '断开连接')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    // 失焦提交（headless 下键盘事件不路由到 input，用 blur 走提交路径）
    inp.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    await sleep(1500)
    return {
      editorGone: !document.querySelector('[data-label-editor]'),
      code: document.querySelector('[data-fold-modal] [data-code-input]').value,
    }
  })()`)
  check('提交后改字框消失', committed.editorGone === true, JSON.stringify(committed))
  check('代码里标签被替换成「断开连接」',
    /n3\s*\[\s*"断开连接"\s*\]/.test(committed.code || ''), String(committed.code))
  check('旧标签「新结果节点」已消失',
    !(committed.code || '').includes('新结果节点'), String(committed.code))
  check('边一条没少',
    (committed.code || '').split('\n').filter((l) => l.includes('-->')).length === 4,
    String(committed.code))

  const finalStats = await graphStats()
  // n0 开始 / n1 服务端 / n2 客户端 / n3 断开连接
  check('图重新渲染出 4 个节点', finalStats.nodes === 4, String(finalStats.nodes))
  check('图重新渲染出 4 条连线', finalStats.edges === 4, String(finalStats.edges))

  /* ================================================================== */
  console.log('\n[6b] 中文输入法：组字中的回车绝不能提交')
  /* ================================================================== */

  /*
   * 这是 PRD 特别强调的一条。组字（拼音选词）阶段按回车是「选词」，
   * 如果被当成提交，用户打一半的拼音就直接写进节点名了。
   * 判据有两条，必须都成立：composingRef 和 e.nativeEvent.isComposing。
   */
  await rightClickNode('n1')
  await clickMenuItem('merge')
  await clickNode('n2')

  const ime = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const inp = document.querySelector('[data-label-input]')
    if (!inp) return { error: '改字框没弹出' }

    const setVal = (v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, v)
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    }

    // 1) 开始组字，输入拼音
    inp.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    setVal('duankai')
    await sleep(200)

    // 2) 组字中按回车 —— 必须被忽略
    inp.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, isComposing: true,
    }))
    await sleep(500)
    const stillOpen = !!document.querySelector('[data-label-editor]')
    const codeMid = document.querySelector('[data-fold-modal] [data-code-input]').value

    // 3) 选词结束
    inp.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    setVal('断开连接')
    await sleep(200)

    // 4) 再按回车 —— 这次应该提交
    inp.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, isComposing: false,
    }))
    await sleep(1200)

    const codeEnd = document.querySelector('[data-fold-modal] [data-code-input]').value
    return {
      stillOpen,
      midHasPinyin: /duankai/.test(codeMid),
      editorGone: !document.querySelector('[data-label-editor]'),
      endHasLabel: /"断开连接"/.test(codeEnd),
      endHasDefault: /新结果节点/.test(codeEnd),
    }
  })()`)
  note(`组字中：${JSON.stringify(ime)}`)
  check('组字中按回车不提交（改字框仍开着）', ime.stillOpen === true, JSON.stringify(ime))
  check('组字中按回车没有把拼音写进代码', ime.midHasPinyin === false, JSON.stringify(ime))
  check('组字结束后按回车能正常提交', ime.editorGone === true, JSON.stringify(ime))
  check('提交后代码里是新标签', ime.endHasLabel === true, JSON.stringify(ime))
  check('默认标签已被替换', ime.endHasDefault === false, JSON.stringify(ime))

  /* ================================================================== */
  console.log('\n[7] 焦点回到图表容器')
  /* ================================================================== */

  const focusInfo = await evaluate(`(() => {
    const vp = document.querySelector('[data-graph-viewport]')
    return { tabIndex: vp ? vp.tabIndex : null, active: document.activeElement === vp }
  })()`)
  check('画布容器 tabIndex=0', focusInfo.tabIndex === 0, String(focusInfo.tabIndex))
  check('重绘后焦点回到画布容器', focusInfo.active === true, JSON.stringify(focusInfo))

  /* ================================================================== */
  console.log('\n[8] 连续合并：不产生重复 / 孤立节点')
  /* ================================================================== */

  await rightClickNode('n1')
  await clickMenuItem('merge')
  await clickNode('n2')
  // 第二次合并会再弹改字框：按 Esc 应该只取消改字，**不能关掉整个弹窗**
  const second = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const box = document.querySelector('[data-label-editor]')
    const hadEditor = !!box
    if (box) {
      const inp = box.querySelector('[data-label-input]')
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(500)
    }
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    return {
      hadEditor,
      editorGone: !document.querySelector('[data-label-editor]'),
      modalStillOpen: !!document.querySelector('[data-fold-modal]'),
      code: ta ? ta.value : null,
    }
  })()`)
  check('第二次合并也弹出了改字框', second.hadEditor === true, JSON.stringify(second))
  check('Esc 取消了改字框', second.editorGone === true, JSON.stringify(second))
  check('Esc 没有关掉整个弹窗（回归：捕获阶段优先级）',
    second.modalStillOpen === true, JSON.stringify(second))

  const ids = [...(second.code || '').matchAll(/(?:^|\n)\s*([A-Za-z0-9_\u4e00-\u9fa5][\w\-\u4e00-\u9fa5]*)\s*\["/g)].map((m) => m[1])
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i)
  note(`节点 id：${JSON.stringify(ids)}`)
  check('第二次合并产生了新的唯一 id', ids.includes('n4'), JSON.stringify(ids))
  check('没有重复的节点定义', dupIds.length === 0, JSON.stringify(dupIds))

  // 每个非根节点都必须有入边（没有孤立节点）
  const orphan = await evaluate(`(() => {
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    const code = ta.value
    const defs = [...code.matchAll(/(?:^|\\n)\\s*([A-Za-z0-9_\\u4e00-\\u9fa5][\\w\\-\\u4e00-\\u9fa5]*)\\s*\\["/g)].map(m => m[1])
    const targets = new Set([...code.matchAll(/--\\>\\s*([A-Za-z0-9_\\u4e00-\\u9fa5][\\w\\-\\u4e00-\\u9fa5]*)/g)].map(m => m[1]))
    return { defs, roots: defs.filter(d => !targets.has(d)) }
  })()`)
  note(`根节点：${JSON.stringify(orphan.roots)}`)
  check('只有 n0 是根（没有孤立节点）',
    orphan.roots.length === 1 && orphan.roots[0] === 'n0', JSON.stringify(orphan))

  /* ================================================================== */
  console.log('\n[9] 缩进模式下同样有「指向同一结果」（且真的能用）')
  /* ================================================================== */

  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('[data-mode-tab="outline"]').click()
    await sleep(800)
    return true
  })()`)
  const outlineMenu = await rightClickNode('n1')
  note(`缩进模式菜单项：${JSON.stringify(outlineMenu.items)}`)
  /*
   * 【为什么从「没有」改成「必须有」】
   * 早先按 mode 关掉了连线两项，理由是「缩进列表表达不了多对一」。
   * 但 mergeToNewNode 改的一直是 Mermaid 代码，缩进模式下节点 id 恒为
   * `n<行号>`，一样是合法 id —— 那个理由不成立，纯粹逼用户先切代码模式。
   * 现在钉的是「两个模式的菜单项集合一致」，以及**在缩进模式下真的能生成汇聚**。
   */
  check('★ 缩进模式菜单里有「指向同一结果」',
    outlineMenu.items?.includes('merge'), JSON.stringify(outlineMenu.items))
  check('缩进模式原来的三件套还在',
    outlineMenu.items?.includes('sibling') && outlineMenu.items?.includes('child') &&
    outlineMenu.items?.includes('delete'), JSON.stringify(outlineMenu.items))

  /* ---- 缩进模式下真的走一遍汇聚 ---- */
  const outlineMerge = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const rows = () => [...document.querySelectorAll('[data-fold-modal] [data-outline-row]')]
    const gs = [...document.querySelectorAll('[data-fold-modal] g.node')]
    const before = rows().length
    const inner = gs[0].querySelector('rect, .label, foreignObject') || gs[0]
    const r0 = gs[0].getBoundingClientRect()
    inner.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2, button: 2,
    }))
    await sleep(350)
    const btn = document.querySelector('[data-node-menu] [data-menu-item="merge"]')
    if (!btn) return { error: '菜单里没有「指向同一结果」' }
    btn.click()
    await sleep(350)
    const last = gs[gs.length - 1]
    const r1 = last.getBoundingClientRect()
    last.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: r1.left + r1.width / 2, clientY: r1.top + r1.height / 2,
    }))
    await sleep(1500)
    return {
      before, after: rows().length,
      outline: rows().map((row) => row.querySelector('input').value),
      labelBox: !!document.querySelector('[data-label-input]'),
    }
  })()`)
  note(`缩进模式汇聚：${JSON.stringify(outlineMerge)}`)
  check('★ 缩进模式下汇聚真的新增了一行（节点数 +1）',
    outlineMerge.after === outlineMerge.before + 1, JSON.stringify(outlineMerge))
  check('★ 新结果节点带着两条 (-> …) 引用',
    (outlineMerge.outline || []).some((s) => (s.match(/->/g) || []).length >= 2), JSON.stringify(outlineMerge))
  check('★ 汇聚后自动弹出改字框（和代码模式同一套收尾）',
    outlineMerge.labelBox === true, JSON.stringify(outlineMerge))
  // 收掉改字框（用 window 上的 Escape，和其它小节同一套写法）
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(500)

  /* ================================================================== */
  console.log('\n[9b] 回归：键盘事件必须能到达弹窗里的输入框')
  /* ================================================================== */

  /*
   * 这里踩过两个坑，都必须钉住：
   *   1. FoldModal 的 window 捕获阶段监听器调了 e.stopPropagation()，
   *      掐断整条事件路径 —— input 上的原生监听器都收不到（nativeSaw=0）。
   *   2. insertAfter 漏了 changed:true，apply() 的守卫把它吞了。
   * 两个叠在一起的表现是「按 Enter 没反应」，当时被误判成 headless 限制。
   */
  const keyboard = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const rows = () => [...document.querySelectorAll('[data-fold-modal] [data-outline-row]')]
    const before = rows().length
    const inp = rows()[0].querySelector('input')
    if (!inp) return { error: '找不到缩进列表输入框' }
    inp.focus()

    // 探针：原生监听器到底收不收得到键盘事件
    let nativeSaw = 0
    const spy = () => { nativeSaw++ }
    inp.addEventListener('keydown', spy)
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await sleep(700)
    inp.removeEventListener('keydown', spy)

    return { before, after: rows().length, nativeSaw }
  })()`)
  note(`Enter 前后行数：${keyboard.before} → ${keyboard.after}，原生监听器收到 ${keyboard.nativeSaw} 次`)
  check('键盘事件能到达弹窗内的 input（没被捕获监听器掐断）',
    keyboard.nativeSaw === 1, JSON.stringify(keyboard))
  check('缩进列表里按 Enter 真的插入了新行',
    keyboard.after === keyboard.before + 1, JSON.stringify(keyboard))

  // Esc 优先级：改字框 > 右键菜单 > 关弹窗
  const escOrder = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const s = document.querySelector('[data-fold-modal]')
    let target = null
    for (const g of s.querySelectorAll('g.node')) {
      const m = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      if (m && m[1] === 'n1') { target = g; break }
    }
    const r = target.getBoundingClientRect()
    const inner = target.querySelector('rect, .label, foreignObject') || target
    inner.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, button: 2,
    }))
    await sleep(400)
    const menuOpen = !!document.querySelector('[data-node-menu]')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(400)
    return {
      menuOpen,
      menuGone: !document.querySelector('[data-node-menu]'),
      modalStillOpen: !!document.querySelector('[data-fold-modal]'),
    }
  })()`)
  check('右键菜单打开时按 Esc 只关菜单', escOrder.menuOpen && escOrder.menuGone, JSON.stringify(escOrder))
  check('关菜单的 Esc 不会顺手关掉弹窗', escOrder.modalStillOpen === true, JSON.stringify(escOrder))

  /* ---------------- 收尾 ---------------- */
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

