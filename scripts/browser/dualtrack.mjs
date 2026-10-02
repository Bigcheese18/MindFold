/**
 * 双轨制 / 多对一 浏览器端测试
 * =============================
 * 验证纯函数测不到的那一半：真实 mermaid 渲染出来的 SVG、
 * 真实的模式切换、真实的悬停联动。
 *
 * 覆盖：
 *   1. 缩进列表里写 (-> 目标) → 右侧图真的出现汇聚（数 SVG 里的连线）
 *   2. 代码模式手写 A-->C、B-->C → 切回缩进列表不丢边 → 再切回代码边还在
 *   3. 悬停左侧某一行 → 右侧该节点的**入边和出边**同时加粗变色
 *   4. dagre 布局：多对一时汇聚点排在下层（rank 分开），而不是挤在一起
 *   5. 引用写错目标名 → 出现明确提示，不静默
 *
 * 需要 dev server 已启动：npm run dev
 * 用法：node scripts/dualtrack.mjs [url]
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

const PORT = 9335
const userDir = mkdtempSync(join(tmpdir(), 'mf-dual-'))

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
  console.log('\n[0] 准备：打开折角弹窗')
  const opened = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const hit = [...document.querySelectorAll('[data-fold-badge]')][0]
    if (!hit) return { error: '找不到折角角标' }
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(2500)
    const modal = document.querySelector('[data-fold-modal]')
    return { ok: !!modal }
  })()`)
  check('折角弹窗打开', opened.ok === true, JSON.stringify(opened))

  /** 切到指定模式 */
  const setMode = async (m) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const tab = document.querySelector('[data-mode-tab="${m}"]')
    if (!tab) return { error: '找不到模式切换按钮' }
    tab.click()
    await sleep(400)
    return { ok: true }
  })()`)

  /**
   * 往代码编辑器里写内容。
   * CodeEditor 的 textarea 有 React 受控 value，必须用原生 setter + input 事件，
   * 直接改 .value 不会触发 React 的 onChange。
   */
  const writeCode = async (src) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const ta = document.querySelector('[data-code-editor] textarea')
      || document.querySelector('[data-fold-modal] textarea')
    if (!ta) return { error: '找不到代码编辑器 textarea' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(src)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(1400)
    return { ok: true, len: ta.value.length }
  })()`)

  /** 读当前图上的连线数 / 节点数 */
  const graphStats = () => evaluate(`(() => {
    const host = document.querySelector('[data-fold-modal] .mf-unfold') || document.querySelector('[data-fold-modal]')
    const scope = document.querySelector('[data-fold-modal]')
    return {
      nodes: scope.querySelectorAll('g.node').length,
      edges: scope.querySelectorAll('path.flowchart-link').length,
    }
  })()`)

  /** 读代码编辑器内容 */
  const readCode = () => evaluate(`(() => {
    const ta = document.querySelector('[data-fold-modal] textarea')
    return ta ? ta.value : null
  })()`)

  /** 读缩进列表内容（每行的 input value） */
  const readOutline = () => evaluate(`(() => {
    return [...document.querySelectorAll('[data-fold-modal] [data-outline-input]')]
      .map(el => el.value)
  })()`)

  /* ================================================================== */
  console.log('\n[1] 代码模式：手写多对一 A-->C / B-->C')
  /* ================================================================== */

  await setMode('code')
  const MP = [
    'flowchart TD',
    '  A["开始"]',
    '  B["服务端"]',
    '  C["客户端"]',
    '  D["断开连接"]',
    '  A --> B',
    '  A --> C',
    '  B --> D',
    '  C --> D',
  ].join('\n')
  const w1 = await writeCode(MP)
  check('代码写入成功', w1.ok === true, JSON.stringify(w1))

  const g1 = await graphStats()
  note(`图：${g1.nodes} 个节点 / ${g1.edges} 条连线`)
  check('4 个节点都渲染出来了', g1.nodes === 4, String(g1.nodes))
  // A→B、A→C、B→D、C→D 共 4 条
  check('4 条边都渲染出来了（含两条汇聚边）', g1.edges === 4, String(g1.edges))

  /* ---- dagre 分层：汇聚点应该在下层 ---- */
  const layout = await evaluate(`(() => {
    const scope = document.querySelector('[data-fold-modal]')
    const out = {}
    for (const g of scope.querySelectorAll('g.node')) {
      const id = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      const t = g.getAttribute('transform') || ''
      const m = t.match(/translate\\(([-\\d.]+)\\s*,\\s*([-\\d.]+)\\)/)
      if (id && m) out[id[1]] = { x: Math.round(+m[1]), y: Math.round(+m[2]) }
    }
    return out
  })()`)
  note(`节点坐标：${JSON.stringify(layout)}`)
  if (layout.A && layout.D && layout.B) {
    check('dagre 分层：汇聚点 D 在源点 A 的下方（不同 rank）',
      layout.D.y > layout.A.y, `A.y=${layout.A.y} D.y=${layout.D.y}`)
    check('dagre 分层：中间节点 B 在 A 与 D 之间',
      layout.B.y > layout.A.y && layout.B.y < layout.D.y,
      `A=${layout.A.y} B=${layout.B.y} D=${layout.D.y}`)
    check('dagre 交叉最小化：B 与 C 排在同一层（y 相同）',
      Math.abs(layout.B.y - layout.C.y) <= 1, `B.y=${layout.B.y} C.y=${layout.C.y}`)
    check('dagre 交叉最小化：B 在 C 左侧（不交叉）',
      layout.B.x < layout.C.x, `B.x=${layout.B.x} C.x=${layout.C.x}`)
  } else {
    check('能读到节点坐标', false, JSON.stringify(layout))
  }

  /* ================================================================== */
  console.log('\n[2] 切回缩进列表：边不能丢')
  /* ================================================================== */

  await setMode('outline')
  const ol = await readOutline()
  note(`缩进列表：${JSON.stringify(ol)}`)
  check('缩进列表反推出了内容', Array.isArray(ol) && ol.length === 4, JSON.stringify(ol))
  check('多对一被写成 (-> 断开连接) 引用',
    ol.some((l) => l.includes('(-> 断开连接)')), JSON.stringify(ol))
  check('目标节点只占一行（没被压平成两个）',
    ol.filter((l) => l.trim() === '断开连接').length === 1, JSON.stringify(ol))
  check('节点文字里没有残留 -> 标记',
    !ol.some((l) => l.includes('-->')), JSON.stringify(ol))

  /* ---- 再切回代码模式：边还在吗 ---- */
  await setMode('code')
  const codeBack = await readCode()
  const edgeLines = (codeBack || '').split('\n').filter((l) => l.includes('-->')).length
  note(`切回代码模式后 ${edgeLines} 条边`)
  check('切回代码模式后 4 条边全在', edgeLines === 4, `得到 ${edgeLines}\n${codeBack}`)

  /* ================================================================== */
  console.log('\n[3] 缩进列表写引用 → 图上汇聚')
  /* ================================================================== */

  await setMode('outline')
  // 直接改第一行的 input 来写内容
  const setOutline = async (lines) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const inputs = [...document.querySelectorAll('[data-fold-modal] [data-outline-input]')]
    return { count: inputs.length }
  })()`)
  await setOutline()

  // 用代码模式写入"缩进列表编译出来的等价内容"，再切回缩进列表验证引用生效
  await setMode('code')
  const REF_CODE = [
    'flowchart TD',
    '  n0["TCP 三次握手"]',
    '  n1["服务端未收到 ACK"]',
    '  n2["客户端主动关闭"]',
    '  n3["断开连接"]',
    '  n0 --> n1',
    '  n0 --> n2',
    '  n0 --> n3',
    '  n1 --> n3',
    '  n2 --> n3',
  ].join('\n')
  await writeCode(REF_CODE)
  await setMode('outline')
  const ol2 = await readOutline()
  note(`缩进列表：${JSON.stringify(ol2)}`)
  check('两条汇聚边都变成引用',
    ol2.filter((l) => l.includes('(-> 断开连接)')).length === 2, JSON.stringify(ol2))

  // 切回代码，确认引用被编译回边
  await setMode('code')
  const code2 = await readCode()
  const edges2 = (code2 || '').split('\n').filter((l) => l.includes('-->')).length
  check('引用被重新编译成边（6 条：3 树边 + 2 汇聚 + 1 根边）', edges2 === 5, `得到 ${edges2}\n${code2}`)
  const g2 = await graphStats()
  check('右侧图仍然渲染出 5 条连线', g2.edges === 5, String(g2.edges))

  /* ================================================================== */
  console.log('\n[4] 悬停联动：入边 + 出边一起高亮')
  /* ================================================================== */

  await setMode('outline')
  await sleep(600)

  // 悬停「服务端未收到 ACK」这一行：它有 1 条入边（来自根）+ 1 条出边（到断开连接）
  const hover = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const rows = [...document.querySelectorAll('[data-fold-modal] [data-outline-row]')]
    const target = rows.find(r => {
      const inp = r.querySelector('input')
      return inp && inp.value.includes('服务端未收到 ACK')
    })
    if (!target) return { error: '找不到目标行', rows: rows.map(r => r.querySelector('input')?.value) }
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await sleep(600)
    const scope = document.querySelector('[data-fold-modal]')
    const hl = [...scope.querySelectorAll('path.flowchart-link.mf-edge-hl')]
    const styles = hl.map(p => {
      const cs = getComputedStyle(p)
      return { w: cs.strokeWidth, color: cs.stroke, id: p.getAttribute('id') }
    })
    return {
      highlighted: hl.length,
      styles,
      hoveredNodes: scope.querySelectorAll('g.node.mf-node-hover').length,
    }
  })()`)
  note(`高亮连线：${JSON.stringify(hover.styles)}`)
  check('悬停左侧行 → 右侧对应节点高亮', hover.hoveredNodes === 1, JSON.stringify(hover))
  check('入边和出边同时高亮（共 2 条）', hover.highlighted === 2, JSON.stringify(hover))
  check('高亮的线确实变粗了',
    (hover.styles || []).every((s) => parseFloat(s.w) >= 2), JSON.stringify(hover.styles))
  check('高亮的线变了颜色',
    (hover.styles || []).every((s) => s.color && s.color !== 'rgb(51, 51, 51)'), JSON.stringify(hover.styles))

  // 移开 → 高亮消失。
  // React 的 onMouseLeave 实际是靠 mouseout + relatedTarget 判定的，
  // 直接派发 mouseleave 不会触发，必须用 mouseout。
  const unhover = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const rows = [...document.querySelectorAll('[data-fold-modal] [data-outline-row]')]
    const target = rows.find(r => {
      const inp = r.querySelector('input')
      return inp && inp.value.includes('服务端未收到 ACK')
    })
    if (!target) return { error: '找不到目标行' }
    target.dispatchEvent(new MouseEvent('mouseout', {
      bubbles: true, cancelable: true, relatedTarget: document.body,
    }))
    await sleep(500)
    const scope = document.querySelector('[data-fold-modal]')
    return { hl: scope.querySelectorAll('path.flowchart-link.mf-edge-hl').length }
  })()`)
  check('移开鼠标后高亮消失', unhover.hl === 0, JSON.stringify(unhover))

  /* ================================================================== */
  console.log('\n[5] 引用写错目标名 → 明确提示')
  /* ================================================================== */

  await setMode('code')
  await writeCode([
    'flowchart TD',
    '  A["甲"]',
    '  B["乙"]',
    '  A --> B',
  ].join('\n'))
  await setMode('outline')

  // 把第 2 行改成引用一个不存在的目标
  const badRef = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const rows = [...document.querySelectorAll('[data-fold-modal] [data-outline-row]')]
    const inp = rows[1] && rows[1].querySelector('input')
    if (!inp) return { error: '找不到第二行' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, '乙 (-> 不存在的节点)')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(900)
    return {
      banner: !!document.querySelector('[data-ref-unresolved]'),
      text: document.querySelector('[data-ref-unresolved]')?.textContent || '',
    }
  })()`)
  check('引用不存在的目标 → 出现提示条', badRef.banner === true, JSON.stringify(badRef))
  check('提示里点名了找不到的目标',
    (badRef.text || '').includes('不存在的节点'), badRef.text)

  /* ================================================================== */
  console.log('\n[6] 建议代码模式')
  /* ================================================================== */

  await setMode('code')
  await writeCode([
    'flowchart TD',
    '  A["A"]', '  B["B"]', '  C["C"]', '  D["D"]', '  E["E"]',
    '  A --> B', '  A --> C', '  A --> D', '  A --> E',
    '  B --> E', '  C --> E', '  D --> E',
  ].join('\n'))
  await setMode('outline')
  const suggest = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    await sleep(400)
    return {
      banner: !!document.querySelector('[data-suggest-code]'),
      text: document.querySelector('[data-suggest-code]')?.textContent || '',
    }
  })()`)
  check('高度交叉 → 出现「去代码模式」建议', suggest.banner === true, JSON.stringify(suggest))
  note(`建议文案：${(suggest.text || '').replace(/\s+/g, ' ').slice(0, 80)}`)

  /* ================================================================== */
  console.log('\n[7] 环（回边）也能往返')
  /* ================================================================== */

  await setMode('code')
  await writeCode([
    'flowchart TD',
    '  A["重传"]',
    '  B["等待 ACK"]',
    '  A --> B',
    '  B --> A',
  ].join('\n'))
  await setMode('outline')
  const cycOl = await readOutline()
  note(`缩进列表：${JSON.stringify(cycOl)}`)
  check('环被写成回边引用', cycOl.some((l) => l.includes('(-> 重传)')), JSON.stringify(cycOl))
  await setMode('code')
  const cycCode = await readCode()
  const cycEdges = (cycCode || '').split('\n').filter((l) => l.includes('-->')).length
  check('环往返后两条边都在', cycEdges === 2, `得到 ${cycEdges}\n${cycCode}`)

  /* ================================================================== */
  console.log('\n[8] 直接在缩进列表里敲 (-> 目标)')
  /* ================================================================== */

  /*
   * 先用代码模式造出 3 行，再在缩进列表里**手动敲**引用。
   * 不用 Enter 造行：headless Chromium 不会把键盘事件路由到 <input>
   * （这个坑之前拖拽测试就踩过），所以这里绕开按键，直接改 input 的值。
   * 要验证的是「在缩进列表里写引用 → 图上真的多一条汇聚边」这条路径。
   */
  await setMode('code')
  await writeCode([
    'flowchart TD',
    '  A["开始"]',
    '  B["断开连接"]',
    '  C["客户端主动关闭"]',
    '  A --> B',
    '  A --> C',
  ].join('\n'))
  await setMode('outline')

  const typed = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const rows = () => [...document.querySelectorAll('[data-fold-modal] [data-outline-row] input')]
    if (rows().length < 3) return { error: '行数不足', n: rows().length }

    // 给第 3 行（客户端主动关闭）敲上指向「断开连接」的引用
    setVal(rows()[2], '客户端主动关闭 (-> 断开连接)')
    await sleep(1500)

    const scope = document.querySelector('[data-fold-modal]')
    return {
      rows: rows().map(el => el.value),
      edges: scope.querySelectorAll('path.flowchart-link').length,
      nodes: scope.querySelectorAll('g.node').length,
    }
  })()`)
  note(`缩进列表：${JSON.stringify(typed.rows)}`)
  note(`图：${typed.nodes} 节点 / ${typed.edges} 连线`)

  if (typed.error) {
    check('缩进列表有 3 行可供编辑', false, JSON.stringify(typed))
  } else {
    check('引用行被保留在缩进列表里',
      typed.rows.some((r) => r.includes('(-> 断开连接)')), JSON.stringify(typed.rows))
    // 开始→断开连接、开始→客户端主动关闭、客户端主动关闭→断开连接 = 3 条
    check('敲出来的引用真的生成了连线', typed.edges === 3, `得到 ${typed.edges}`)
    check('引用目标没有变成重复节点', typed.nodes === 3, String(typed.nodes))
  }

  /* ================================================================== */
  console.log('\n[9] 代码模式改方向不丢边')
  /* ================================================================== */

  await setMode('code')
  const MP2 = [
    'flowchart TD',
    '  A["开始"]', '  B["服务端"]', '  C["客户端"]', '  D["断开连接"]',
    '  A --> B', '  A --> C', '  B --> D', '  C --> D',
  ].join('\n')
  await writeCode(MP2)
  const dirSwitched = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const sel = document.querySelector('[data-fold-modal] select')
    if (!sel) return { error: '找不到方向选择器' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(sel, 'LR')
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(1400)
    const ta = document.querySelector('[data-fold-modal] textarea')
    const scope = document.querySelector('[data-fold-modal]')
    return {
      head: (ta.value.split('\\n')[0] || '').trim(),
      edges: ta.value.split('\\n').filter(l => l.includes('-->')).length,
      svgEdges: scope.querySelectorAll('path.flowchart-link').length,
    }
  })()`)
  note(`切到 LR 后：${JSON.stringify(dirSwitched)}`)
  check('代码头部方向被改成 LR', dirSwitched.head === 'flowchart LR', JSON.stringify(dirSwitched))
  check('改方向后 4 条边一条不少', dirSwitched.edges === 4, JSON.stringify(dirSwitched))
  check('改方向后图仍然渲染 4 条连线', dirSwitched.svgEdges === 4, JSON.stringify(dirSwitched))

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
