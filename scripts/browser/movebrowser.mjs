/**
 * 「代码顺序换位（Move Node）」+ 右键菜单子菜单 端到端测试
 * ========================================================
 * 【为什么这个文件用真实鼠标事件】
 * 上一版测试用 `el.click()` 派发点击，而 `click()` **不会触发 mousedown**。
 * 而菜单的关闭逻辑挂在 document 的 mousedown 上 ——
 * 于是「点一下子菜单，菜单先被关掉、click 落空」这个致命 bug
 * 被测试完全绕过了，一直是绿的。
 *
 * 现在关键交互一律走 CDP 的 Input.dispatchMouseEvent
 * （mousePressed → mouseReleased，和真人操作同一条事件路径）。
 *
 * 需要 dev server 已启动：npm run dev
 * 用法：node scripts/movebrowser.mjs [url]
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

const PORT = 9339
const userDir = mkdtempSync(join(tmpdir(), 'mf-move-'))

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

  /* ---------------- 真实鼠标事件 ---------------- */
  const mouseMove = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  const mouseDown = (x, y, button = 'left') => cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, clickCount: 1,
  })
  const mouseUp = (x, y, button = 'left') => cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, clickCount: 1,
  })
  /** 真人式点击：先移动过去，再按下、抬起 */
  const realClick = async (x, y) => {
    await mouseMove(x, y)
    await mouseDown(x, y)
    await mouseUp(x, y)
    await sleep(450)
  }

  /** 元素几何信息 */
  const rectOf = (sel) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      width: r.width, height: r.height,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
    }
  })()`)

  /** 对某个元素做真实点击 */
  const clickSel = async (sel) => {
    const r = await rectOf(sel)
    if (!r) return { error: `找不到 ${sel}` }
    await realClick(r.cx, r.cy)
    return { ok: true, rect: r }
  }

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

  const nodeX = (id) => evaluate(`(() => {
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

  /** 右键节点打开菜单（contextmenu 仍用合成事件，headless 下更稳） */
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
    const inner = target.querySelector('rect, .label, foreignObject') || target
    inner.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2,
    }))
    await sleep(450)
    const menu = document.querySelector('[data-node-menu]')
    return {
      ok: !!menu,
      items: menu ? [...menu.querySelectorAll('[data-menu-item]')].map(b => b.dataset.menuItem) : [],
    }
  })()`)

  const menuInfo = () => evaluate(`(() => {
    const menu = document.querySelector('[data-node-menu]')
    const sub = document.querySelector('[data-move-submenu]')
    return {
      menuOpen: !!menu,
      subOpen: !!sub,
      subItems: sub ? [...sub.querySelectorAll('[data-move-item]')].map(b => ({
        action: b.dataset.moveItem,
        disabled: b.disabled,
        dataDisabled: b.dataset.disabled || null,
      })) : [],
      // 主菜单是否挂在 body 上（Portal）
      menuParentIsBody: menu ? menu.parentElement === document.body : null,
      subParentIsBody: sub ? sub.parentElement === document.body : null,
      menuZ: menu ? getComputedStyle(menu).zIndex : null,
      subZ: sub ? getComputedStyle(sub).zIndex : null,
    }
  })()`)

  const clickNode = (id) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const s = document.querySelector('[data-fold-modal]')
    let target = null
    for (const g of s.querySelectorAll('g.node')) {
      const m = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      if (m && m[1] === ${JSON.stringify(id)}) { target = g; break }
    }
    if (!target) return { error: '找不到节点' }
    const r = target.getBoundingClientRect()
    const inner = target.querySelector('rect, .label, foreignObject') || target
    inner.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
    }))
    await sleep(600)
    return { ok: true }
  })()`)

  const selectedId = () => evaluate(`(() => {
    const s = document.querySelector('[data-fold-modal]')
    const el = s.querySelector('g.node.mf-node-sel')
    if (!el) return null
    const m = (el.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
    return m ? m[1] : null
  })()`)

  const pressAltArrow = (key) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('[data-graph-viewport]').focus()
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, altKey: true, bubbles: true, cancelable: true,
    }))
    await sleep(1500)
    return {
      code: document.querySelector('[data-fold-modal] [data-code-input]').value,
      toast: document.querySelector('[data-toast]')?.textContent || null,
    }
  })()`)

  const childOrder = (code, parent) => {
    const out = []
    for (const line of String(code).split('\n')) {
      const m = line.match(/^\s*([\w\u4e00-\u9fa5-]+)\s*-->\s*([\w\u4e00-\u9fa5-]+)\s*$/)
      if (m && m[1] === parent && !out.includes(m[2])) out.push(m[2])
    }
    return out
  }
  const edgeSet = (code) => new Set(String(code).split('\n')
    .map((l) => l.match(/^\s*([\w\u4e00-\u9fa5-]+)\s*-->\s*([\w\u4e00-\u9fa5-]+)\s*$/))
    .filter(Boolean).map((m) => `${m[1]}->${m[2]}`))
  const sameEdges = (a, b) => {
    const A = edgeSet(a), B = edgeSet(b)
    return A.size === B.size && [...A].every((x) => B.has(x))
  }

  const BASE = [
    'flowchart TD',
    '  n0["根"]',
    '  n1["甲"]',
    '  n2["乙"]',
    '  n3["丙"]',
    '  n0 --> n1',
    '  n0 --> n2',
    '  n0 --> n3',
  ].join('\n')
  await writeCode(BASE)

  /* ================================================================== */
  console.log('\n[1] 菜单结构：Portal + 点击展开子菜单')
  /* ================================================================== */

  const menu = await rightClickNode('n2')
  note(`主菜单：${JSON.stringify(menu.items)}`)
  check('主菜单出现「移动位置」', menu.items?.includes('move'), JSON.stringify(menu.items))

  const before = await menuInfo()
  check('子菜单默认是收起的', before.subOpen === false, JSON.stringify(before))
  check('菜单用 Portal 挂在 document.body 上',
    before.menuParentIsBody === true, String(before.menuParentIsBody))
  check('菜单 z-index 是 9999', before.menuZ === '9999', String(before.menuZ))

  // 真实点击「移动位置」
  await clickSel('[data-node-menu] [data-menu-item="move"]')
  const after = await menuInfo()
  note(`子菜单：${JSON.stringify(after.subItems)}`)
  check('点击后子菜单展开', after.subOpen === true, JSON.stringify(after))
  check('子菜单也用 Portal 挂在 body 上',
    after.subParentIsBody === true, String(after.subParentIsBody))
  check('子菜单 z-index 也是 9999', after.subZ === '9999', String(after.subZ))

  /* ================================================================== */
  console.log('\n[2] 鼠标从「移动位置」移到子菜单：绝不能关闭')
  /* ================================================================== */

  const itemRect = await rectOf('[data-node-menu] [data-menu-item="move"]')
  const subRect = await rectOf('[data-move-submenu]')
  const menuRect = await rectOf('[data-node-menu]')
  /*
   * 真正的「重叠」是两者水平区间的交集宽度 ——
   * 子菜单贴右边时交集在菜单右缘，翻到左边时交集在菜单左缘，
   * 用 menu.right - sub.left 去量会在翻转时得出荒谬的数字。
   */
  const overlap = Math.max(0, Math.min(menuRect.right, subRect.right) - Math.max(menuRect.left, subRect.left))
  const flipped = subRect.right <= menuRect.right
  note(`主菜单 [${menuRect.left.toFixed(0)}, ${menuRect.right.toFixed(0)}] `
    + `子菜单 [${subRect.left.toFixed(0)}, ${subRect.right.toFixed(0)}] `
    + `${flipped ? '(向左翻转)' : '(贴右侧)'} 重叠=${overlap.toFixed(1)}px`)

  check('子菜单与父菜单物理重叠（没有缝隙，约 2px）',
    overlap >= 1.5 && overlap <= 4,
    `重叠 ${overlap.toFixed(1)}px`)
  /*
   * 子菜单的定位规则有**两条**，不是一条：
   *   1. 正常情况：顶部与「移动位置」这一项对齐（不是和整个菜单顶部对齐）
   *   2. 贴底放不下时：夹到视口内，保证整个子菜单可见
   * 早先这里只断言第 1 条，于是「右键点得比较靠下」时会被判失败 ——
   * 而那时候子菜单其实是被**正确地**夹起来了（底部离视口下沿 8px）。
   * 只认一条规则的断言会把正确行为报成 bug。
   */
  const vh = await evaluate('window.innerHeight')
  const wouldOverflow = itemRect.top + subRect.height > vh - 8
  check('子菜单顶部与「移动位置」项对齐（贴底放不下时改为夹进视口）',
    wouldOverflow
      ? subRect.bottom <= vh - 7
      : Math.abs(subRect.top - itemRect.top) < 2,
    `item.top=${itemRect.top} sub.top=${subRect.top} sub.bottom=${subRect.bottom} `
    + `sub.h=${subRect.height} vh=${vh} 需夹取=${wouldOverflow}`)

  // 模拟鼠标从父项滑到子菜单：经过若干中间点
  const steps = 8
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    await mouseMove(
      itemRect.cx + (subRect.cx - itemRect.cx) * t,
      itemRect.cy + (subRect.cy - itemRect.cy) * t,
    )
    await sleep(60)
  }
  await sleep(300)
  const afterMove = await menuInfo()
  check('鼠标划过父项与子菜单之间，子菜单仍然开着',
    afterMove.subOpen === true && afterMove.menuOpen === true, JSON.stringify(afterMove))

  // 在子菜单上悬停/移动也不能关
  await mouseMove(subRect.cx, subRect.cy)
  await sleep(300)
  const afterHover = await menuInfo()
  check('鼠标停在子菜单上，菜单不会消失',
    afterHover.subOpen === true && afterHover.menuOpen === true, JSON.stringify(afterHover))

  /* ================================================================== */
  console.log('\n[3] 真实点击子菜单项：动作生效且菜单才关闭')
  /* ================================================================== */

  const beforeX = { n1: await nodeX('n1'), n2: await nodeX('n2') }
  check('移动前 n1 在 n2 左边', beforeX.n1.x < beforeX.n2.x, JSON.stringify(beforeX))

  // 真实鼠标点击「左移一位」
  const upBtn = await rectOf('[data-move-submenu] [data-move-item="up"]')
  await realClick(upBtn.cx, upBtn.cy)
  await sleep(1200)

  const codeAfter = await readCode()
  const closed = await menuInfo()
  note(`移动后代码顺序：${childOrder(codeAfter, 'n0').join()}`)
  check('点击子菜单项后菜单才关闭',
    closed.menuOpen === false && closed.subOpen === false, JSON.stringify(closed))
  check('★「左移一位」真的生效（代码顺序变成 n2,n1,n3）',
    childOrder(codeAfter, 'n0').join() === 'n2,n1,n3', childOrder(codeAfter, 'n0').join())
  check('★ 同级换位不改变边集合（父子关系一个字没动）', sameEdges(BASE, codeAfter))

  const afterX = { n1: await nodeX('n1'), n2: await nodeX('n2') }
  note(`移动后 x：n1=${afterX.n1.x} n2=${afterX.n2.x}`)
  check('★ 图上左右位置真的颠倒（「左移」确实是往左走）', afterX.n2.x < afterX.n1.x, JSON.stringify(afterX))

  /* ================================================================== */
  console.log('\n[4] 边界项置灰不可点')
  /* ================================================================== */

  // n2 现在是第一个 → 「左移一位」应置灰
  await rightClickNode('n2')
  await clickSel('[data-node-menu] [data-menu-item="move"]')
  const atTop = await menuInfo()
  const upState = atTop.subItems.find((x) => x.action === 'up')
  const downState = atTop.subItems.find((x) => x.action === 'down')
  note(`n2（同级第一位）子菜单状态：${JSON.stringify(atTop.subItems)}`)
  check('同级最左边的节点「左移一位」置灰', upState?.disabled === true, JSON.stringify(upState))
  check('同级最左边的节点「右移一位」可用', downState?.disabled === false, JSON.stringify(downState))
  check('disabled 项带 data-disabled 标记（便于测试与无障碍）',
    upState?.dataDisabled === 'true', JSON.stringify(upState))

  // 点 disabled 项不应改变代码
  const codeBeforeDisabledClick = await readCode()
  const upRect = await rectOf('[data-move-submenu] [data-move-item="up"]')
  await realClick(upRect.cx, upRect.cy)
  await sleep(800)
  const codeAfterDisabledClick = await readCode()
  check('点击置灰项不改变代码',
    codeAfterDisabledClick === codeBeforeDisabledClick, '代码被改了')
  check('点击置灰项后菜单仍在（因为动作没发生）',
    (await menuInfo()).menuOpen === true, JSON.stringify(await menuInfo()))

  /* ================================================================== */
  console.log('\n[5] 点击菜单外部才关闭')
  /* ================================================================== */

  // 点画布空白
  const vpRect = await rectOf('[data-graph-viewport]')
  await realClick(vpRect.left + 8, vpRect.bottom - 8)
  await sleep(400)
  const afterOutside = await menuInfo()
  check('点击画布空白处关闭整个菜单',
    afterOutside.menuOpen === false && afterOutside.subOpen === false, JSON.stringify(afterOutside))

  // 点其他节点（必须挑一个没被菜单盖住的，否则点到的其实是菜单）
  await rightClickNode('n2')
  await clickSel('[data-node-menu] [data-menu-item="move"]')
  check('重新打开后子菜单在', (await menuInfo()).subOpen === true)

  const mRect = await rectOf('[data-node-menu]')
  const sRect = await rectOf('[data-move-submenu]')
  const free = await evaluate(`(() => {
    const M = ${JSON.stringify({ l: mRect.left, r: mRect.right, t: mRect.top, b: mRect.bottom })}
    const S = ${JSON.stringify({ l: sRect.left, r: sRect.right, t: sRect.top, b: sRect.bottom })}
    const hit = (R, x, y) => x >= R.l && x <= R.r && y >= R.t && y <= R.b
    for (const g of document.querySelectorAll('[data-fold-modal] g.node')) {
      const m = (g.getAttribute('id') || '').match(/flowchart-(.+?)-\\d+$/)
      if (!m) continue
      const r = g.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      if (!hit(M, x, y) && !hit(S, x, y)) return { id: m[1], x, y }
    }
    return null
  })()`)
  note(`挑一个没被菜单盖住的节点：${JSON.stringify(free)}`)
  if (free) {
    await realClick(free.x, free.y)
    const afterNodeClick = await menuInfo()
    check('点击其他节点也关闭整个菜单',
      afterNodeClick.menuOpen === false, JSON.stringify(afterNodeClick))
  } else {
    check('能找到未被菜单遮挡的节点', false, '所有节点都被菜单盖住了')
  }

  /* ================================================================== */
  console.log('\n[6] 快捷键：←/→ 同级换位，↑/↓ 改变层级')
  /* ================================================================== */
  /*
   * 语义和菜单文案必须完全一致：
   *   Alt + ←/→  → 同级换位（只换代码顺序，不改父子关系）
   *   Alt + ↑/↓  → 改变层级（真改拓扑）
   * 所以 Alt+↑ 不再等同于 Alt+←，它们做的是两件不同的事。
   */

  await clickNode('n2')
  check('点击后 n2 被选中', (await selectedId()) === 'n2', String(await selectedId()))

  // n2 现在在第一位 → 同级换位已经到边界
  await pressAltArrow('ArrowLeft')
  const boundaryToast = await evaluate(`document.querySelector('[data-toast]')?.textContent || null`)
  note(`越界提示：${boundaryToast}`)
  check('同级第一位按 Alt+← 弹边界提示', !!boundaryToast, String(boundaryToast))
  check('越界提示文案不指方向（TD/LR 都不会说错）',
    !!boundaryToast && !/左|右|上|下/.test(boundaryToast), String(boundaryToast))
  check('越界时高亮没有丢', (await selectedId()) === 'n2', String(await selectedId()))

  const rightRes = await pressAltArrow('ArrowRight')
  check('★ Alt+→ 同级右移生效（n2 排到 n1 后面）',
    childOrder(rightRes.code, 'n0').join() === 'n1,n2,n3', childOrder(rightRes.code, 'n0').join())
  check('同级换位后高亮仍然停在 n2', (await selectedId()) === 'n2', String(await selectedId()))

  const leftRes = await pressAltArrow('ArrowLeft')
  check('★ Alt+← 同级左移生效（n2 排回 n1 前面）',
    childOrder(leftRes.code, 'n0').join() === 'n2,n1,n3', childOrder(leftRes.code, 'n0').join())

  /*
   * ★ 关键回归：Alt+↑ 必须做「改层级」，而不是像以前那样退化成同级换位。
   * 用 n2（n0 的子节点）按 Alt+↑：提升一级会把它挂到祖父下 ——
   * 但 n0 就是根，所以这里应该被**拒绝**（会拆成两块图），
   * 而绝不是把 n2 和 n1 换个位置。
   *
   * 【这个断言必须让 n2 停在同级**中间**】
   * 第一版写成「n2 在第一位时按 Alt+↑」—— 那样两种语义都得到「代码不动」：
   *   正确语义：提升被拒（父节点是根）
   *   错误语义：同级换位越界
   * 于是把映射改回旧版，测试照样全绿（实测）。必须先把 n2 挪回中间，
   * 让「换位有空间」和「提升被拒」的结果**必然不同**，这条才有判别力。
   */
  await pressAltArrow('ArrowRight')     // n2 挪回中间
  const beforeUp = await readCode()
  check('前置：n2 位于同级中间（换位是有空间的）',
    childOrder(beforeUp, 'n0').join() === 'n1,n2,n3', childOrder(beforeUp, 'n0').join())

  const upRes = await pressAltArrow('ArrowUp')
  const upToast = await evaluate(`document.querySelector('[data-toast]')?.textContent || null`)
  note(`Alt+↑ 结果：code 变了=${upRes.code !== beforeUp}  toast=${upToast}`)
  check('★ Alt+↑ 是「改变层级」而不是同级换位：父节点是根时被拒绝、代码不动',
    upRes.code === beforeUp, '代码被改了 —— 说明 Alt+↑ 退化成了同级换位')
  check('拒绝时有明确提示', !!upToast, String(upToast))

  // 在代码输入框里按 Alt+↑ 不该动节点（文本框里那是「按词移动光标」）
  const inField = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    ta.focus()
    const before = ta.value
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true,
    }))
    await sleep(900)
    return { unchanged: ta.value === before }
  })()`)
  check('在代码输入框里 Alt+↑ 不移动节点', inField.unchanged === true, JSON.stringify(inField))

  /* ================================================================== */
  console.log('\n[7] 跨层级提升 / 下沉 + 环检测')
  /* ================================================================== */

  const DEEP = [
    'flowchart TD',
    '  n0["根"]',
    '  n1["中间"]',
    '  n2["叶子"]',
    '  n0 --> n1',
    '  n1 --> n2',
  ].join('\n')
  await writeCode(DEEP)

  await rightClickNode('n2')
  await clickSel('[data-node-menu] [data-menu-item="move"]')
  await clickSel('[data-move-submenu] [data-move-item="promote"]')
  const proCode = await readCode()
  note(`提升后：\n${proCode.split('\n').map((l) => '      ' + l).join('\n')}`)
  check('提升后 n2 直接挂在 n0 下',
    edgeSet(proCode).has('n0->n2') && !edgeSet(proCode).has('n1->n2'),
    [...edgeSet(proCode)].join(' '))
  check('提升后没有孤立节点',
    edgeSet(proCode).has('n0->n1') && edgeSet(proCode).has('n0->n2'))

  await writeCode(DEEP)
  await rightClickNode('n1')
  await clickSel('[data-node-menu] [data-menu-item="move"]')
  await clickSel('[data-move-submenu] [data-move-item="demote"]')
  const demCode = await readCode()
  check('下沉后 n2 改挂到 n0 下', edgeSet(demCode).has('n0->n2'), [...edgeSet(demCode)].join(' '))
  check('下沉后 n1 仍在 n0 下（没变孤儿）', edgeSet(demCode).has('n0->n1'))
  check('下沉后 n1 与 n2 同级', childOrder(demCode, 'n0').sort().join() === 'n1,n2',
    childOrder(demCode, 'n0').join())

  const RING = [
    'flowchart TD',
    '  n0["甲"]',
    '  n1["乙"]',
    '  n2["丙"]',
    '  n0 --> n1',
    '  n1 --> n2',
    '  n2 --> n0',
  ].join('\n')
  await writeCode(RING)
  await rightClickNode('n1')
  await clickSel('[data-node-menu] [data-menu-item="move"]')
  await clickSel('[data-move-submenu] [data-move-item="promote"]')
  await sleep(600)
  const ringToast = await evaluate(`document.querySelector('[data-toast]')?.textContent || null`)
  note(`提示：${ringToast}`)
  check('会形成环的提升被拒绝并提示', !!ringToast && /环/.test(ringToast), String(ringToast))
  check('被拒绝时代码一字未改', (await readCode()) === RING)

  /* ================================================================== */
  console.log('\n[8] 自动补全声明 + 缩进模式下也能移动（两个模式共用同一套菜单）')
  /* ================================================================== */

  const NO_DECL = 'flowchart TD\n  n0["根"]\n  n0 --> n1\n  n0 --> n2'
  await writeCode(NO_DECL)
  await rightClickNode('n2')
  await clickSel('[data-node-menu] [data-menu-item="move"]')
  await clickSel('[data-move-submenu] [data-move-item="up"]')
  const autoCode = await readCode()
  check('自动补全了缺失的声明行',
    /n1\s*\[\s*"n1"\s*\]/.test(autoCode) && /n2\s*\[\s*"n2"\s*\]/.test(autoCode), autoCode)
  check('补全后顺序正确', childOrder(autoCode, 'n0').join() === 'n2,n1',
    childOrder(autoCode, 'n0').join())
  check('补全不改变拓扑', sameEdges(NO_DECL, autoCode))

  /*
   * 【为什么从「没有」改成「必须有」】
   * 「移动位置」改的是 Mermaid 代码里的书写顺序，缩进列表只是同一份图的
   * 另一种写法 —— 在缩进模式下一样成立（applyCode 会把结果反推回缩进列表）。
   * 早先按 mode 关掉它，缩进模式下菜单里根本没有这一项，用户以为功能不存在。
   *
   * 「自动补全声明」这个场景在缩进模式下尤其要对：缩进列表编译出来的代码
   * 只声明根节点，子节点靠边隐式产生，正好是最需要补全声明的那种输入。
   */
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('[data-mode-tab="outline"]').click()
    await sleep(800)
    return true
  })()`)
  // 先切回缩进模式前的干净状态，重新写入无声明代码（切模式不会重编译）
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('[data-mode-tab="code"]').click()
    await sleep(400)
    return true
  })()`)
  await writeCode(NO_DECL)
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('[data-mode-tab="outline"]').click()
    await sleep(800)
    return true
  })()`)

  const outlineMenu = await rightClickNode('n2')
  check('★ 缩进模式菜单里有「移动位置」',
    outlineMenu.items?.includes('move'), JSON.stringify(outlineMenu.items))

  /* ---- 在缩进模式下真的执行一次「上移一位」，并验证缩进列表跟着变 ---- */
  const outlineRows = () => evaluate(
    `[...document.querySelectorAll('[data-fold-modal] [data-outline-row] input')].map(i => i.value)`)
  const rowsBefore = await outlineRows()
  await clickSel('[data-node-menu] [data-menu-item="move"]')
  await clickSel('[data-move-submenu] [data-move-item="up"]')
  await sleep(900)
  const rowsAfter = await outlineRows()
  note(`缩进模式移动：${JSON.stringify(rowsBefore)} → ${JSON.stringify(rowsAfter)}`)
  check('★ 缩进模式里「上移一位」真的改了缩进列表的顺序',
    rowsBefore.length === rowsAfter.length && rowsBefore.join('|') !== rowsAfter.join('|'),
    JSON.stringify({ rowsBefore, rowsAfter }))
  check('★ 移动后缩进层级没有被破坏（每行缩进都是偶数空格）',
    rowsAfter.every((l) => (l.match(/^ */)[0].length) % 2 === 0), JSON.stringify(rowsAfter))

  // 收尾：回到代码模式，后面的用例继续按代码断言
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('[data-mode-tab="code"]').click()
    await sleep(700)
    return true
  })()`)

  /* ================================================================== */
  console.log('\n[8] 子菜单极简排版：短文案 + 图标 + 间距 + 光标旁快捷键气泡')
  /* ================================================================== */
  /*
   * 用户反馈：原来「上移（左移）一位」这种长文案 + 底部两行常驻快捷键说明，
   * 让 200px 宽的子菜单显得极其臃肿。
   * 现在：文案按**物理方向**命名、每项配同方向图标、用间隙拉开、
   * 快捷键改成悬停气泡，底部只留一行极小字号说明。
   *
   * 这一节要测四个气泡，所以需要一个**四个动作都可用**的节点：
   *   · 同级换位可用 → 同级里它既不是第一个也不是最后一个
   *   · 上移一级可用 → 有祖父（父节点不能是根）
   *   · 下移一级可用 → 有子节点
   * BASE（n0 直接挂三个孩子）不满足：那种节点的 promote/demote 本来就该置灰。
   * （另外：disabled 的按钮在 Chromium 里根本不派发鼠标事件，
   *  对置灰项做悬停测试会静默测不到东西。）
   */
  const ALL4 = [
    'flowchart TD',
    '  n0["根"]',
    '  n1["中间层"]',
    '  n2["甲"]',
    '  n3["乙"]',
    '  n4["丙"]',
    '  n5["孙子"]',
    '  n0 --> n1',
    '  n1 --> n2',
    '  n1 --> n3',
    '  n1 --> n4',
    '  n3 --> n5',
  ].join('\n')
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('[data-mode-tab="code"]').click()
    await sleep(600)
    return true
  })()`)
  await writeCode(ALL4)
  await sleep(900)
  await rightClickNode('n3')
  await clickSel('[data-node-menu] [data-menu-item="move"]')
  await sleep(300)

  const subUi = await evaluate(`(() => {
    const sub = document.querySelector('[data-move-submenu]')
    if (!sub) return { error: '子菜单没打开' }
    const items = [...sub.querySelectorAll('[data-move-item]')]
    const rects = items.map(b => b.getBoundingClientRect())
    const subRect = sub.getBoundingClientRect()
    return {
      labels: items.map(b => b.querySelector('span:last-child')?.textContent?.trim() ?? b.textContent.trim()),
      actions: items.map(b => b.dataset.moveItem),
      shortcuts: items.map(b => b.dataset.shortcut || null),
      iconCounts: items.map(b => b.querySelectorAll('svg path').length),
      // 用 path 的 d 判断到底是哪个箭头（同一个 size 下四个图标的 d 不同）
      iconPaths: items.map(b => [...b.querySelectorAll('svg path')].map(p => p.getAttribute('d')).join('|')),
      disabled: items.map(b => b.disabled),
      text: sub.innerText,
      hint: sub.querySelector('[data-move-hint]')?.textContent?.trim() || null,
      subHeight: subRect.height,
      itemHeights: rects.map(r => r.height),
      // 相邻两项之间的「空白间隙」= 下一项的 top - 上一项的 bottom
      gaps: rects.slice(1).map((r, i) => Math.round(r.top - rects[i].bottom)),
      hasShortcutText: sub.innerText.includes('Alt'),
    }
  })()`)
  note(`子菜单：${JSON.stringify({ labels: subUi.labels, disabled: subUi.disabled, hint: subUi.hint, h: subUi.subHeight })}`)

  check('中间节点四个动作都可用（气泡测试的前提）',
    subUi.disabled?.every((d) => d === false), JSON.stringify(subUi.disabled))
  check('★ 四项文案按「物理方向」命名（TD：左右换位 / 上下改层级）',
    JSON.stringify(subUi.labels) === JSON.stringify(['左移一位', '右移一位', '上移一级', '下移一级']),
    JSON.stringify(subUi.labels))
  check('★ 每项配的图标是「同方向」箭头（←/→ 换位，↑/↓ 改层级）',
    JSON.stringify(subUi.iconPaths) === JSON.stringify([
      // arrow-left
      'm12 19-7-7 7-7|M19 12H5',
      // arrow-right
      'M5 12h14|m12 5 7 7-7 7',
      // arrow-up
      'M12 19V5|m5 12 7-7 7 7',
      // arrow-down
      'M12 5v14|m19 12-7 7-7-7',
    ]), JSON.stringify(subUi.iconPaths))
  check('★ 底部保留一行极小字号说明（讲清两类操作的区别）',
    subUi.hint === '左右移动只换顺序，上下移动会改变层级', String(subUi.hint))
  check('★ 快捷键说明不再常驻在菜单里（只在悬停气泡里出现）',
    subUi.hasShortcutText === false, JSON.stringify(subUi.text))
  check('★ 每一项都配了图标（各 2 条 path）',
    subUi.iconCounts.every((n) => n === 2), JSON.stringify(subUi.iconCounts))
  check('★ 选项之间真的拉开了间距（不是靠内边距硬撑）',
    subUi.gaps.every((g) => g >= 3), JSON.stringify(subUi.gaps))
  check('★ 四个动作都有快捷键（换位 ←/→，改层级 ↑/↓）',
    JSON.stringify(subUi.shortcuts) === JSON.stringify(['Alt + ←', 'Alt + →', 'Alt + ↑', 'Alt + ↓']),
    JSON.stringify(subUi.shortcuts))
  check('加了说明行后菜单仍然紧凑（< 210px；臃肿的旧版是 230+）', subUi.subHeight < 210, String(subUi.subHeight))

  /* ---- 悬停「左移一位」弹出快捷键气泡 ---- */
  const upItem = await rectOf('[data-move-submenu] [data-move-item="up"]')
  await mouseMove(upItem.cx, upItem.cy)
  await sleep(250)
  const tipUp = await evaluate(`(() => {
    const t = document.querySelector('[data-move-tip]')
    if (!t) return null
    const r = t.getBoundingClientRect()
    const cs = getComputedStyle(t)
    return {
      text: t.textContent.trim(),
      left: r.left, top: r.top, w: r.width, h: r.height,
      pe: cs.pointerEvents,
      z: cs.zIndex,
      parentIsBody: t.parentElement === document.body,
    }
  })()`)
  check('★ 悬停「左移一位」弹出快捷键气泡', tipUp != null, '没有出现 [data-move-tip]')
  check('气泡内容是该操作的快捷键', tipUp?.text === 'Alt + ←', String(tipUp?.text))
  check('★ 气泡出现在光标旁边（右下方向，距离很近）',
    tipUp && tipUp.left > upItem.cx - 4 && tipUp.left < upItem.cx + 40
    && tipUp.top > upItem.cy - 4 && tipUp.top < upItem.cy + 40,
    JSON.stringify({ tip: [tipUp?.left, tipUp?.top], cursor: [upItem.cx, upItem.cy] }))
  check('气泡很小（不抢视线）', tipUp && tipUp.h < 26 && tipUp.w < 120,
    JSON.stringify({ w: tipUp?.w, h: tipUp?.h }))
  check('★ 气泡 pointer-events:none（否则会把 mouseleave 抢走造成闪烁）',
    tipUp?.pe === 'none', String(tipUp?.pe))
  check('气泡层级高于菜单（不会被菜单盖住）',
    Number(tipUp?.z) > 9999, String(tipUp?.z))
  check('气泡挂在 body 上（Portal，不受 transform 祖先影响）', tipUp?.parentIsBody === true)

  /* ---- 气泡跟着光标走 ---- */
  await mouseMove(upItem.cx + 30, upItem.cy + 6)
  await sleep(150)
  const tipMoved = await evaluate(`(() => {
    const t = document.querySelector('[data-move-tip]')
    if (!t) return null
    const r = t.getBoundingClientRect()
    return { left: r.left, top: r.top }
  })()`)
  check('★ 气泡跟着光标移动',
    tipMoved && Math.abs(tipMoved.left - tipUp.left) > 10,
    JSON.stringify({ before: tipUp?.left, after: tipMoved?.left }))

  /* ---- 移到「上移一级」：换一个气泡内容（它有 Alt + ↑） ---- */
  const promoItem = await rectOf('[data-move-submenu] [data-move-item="promote"]')
  await mouseMove(promoItem.cx, promoItem.cy)
  await sleep(250)
  const tipPromo = await evaluate(`(() => {
    const t = document.querySelector('[data-move-tip]')
    return t ? t.textContent.trim() : null
  })()`)
  check('★ 悬停「上移一级」弹出它自己的快捷键（Alt + ↑）', tipPromo === 'Alt + ↑', String(tipPromo))

  /* ---- ★ 触屏设备（hover: none）不该弹快捷键气泡 ---- */
  /*
   * 手机上根本没有键盘，快捷键提示是纯噪音；而且触屏没有 hover，
   * 点一下会合成出 mouseenter 却没有 mouseleave，气泡会黏在屏幕上不走。
   * 所以气泡按 `(hover: hover)` 媒体特性开关。
   *
   * 【为什么用 stub 而不是发触摸事件】
   * 只发 touchStart 是**测不到东西的**：Chromium 要等一次完整的 tap
   * （touchstart + touchend）之后才合成 mouseenter，
   * 所以「没弹气泡」在开关坏掉时也照样成立 —— 那条断言是假绿的（实测过）。
   * 而 `Emulation.setEmulatedMedia` 也帮不上忙：Chromium 不支持覆写
   * `hover` 这个媒体特性（实测传进去 matches 仍然是 true）。
   *
   * 所以直接替换 `window.matchMedia` 来模拟触屏。这样做之所以有效，
   * 是因为组件是在**悬停那一刻**才去读 matchMedia 的（不是挂载时读一次）——
   * 换成挂载时缓存，这个 stub 就失效了，测试会立刻报错。
   *
   * 真机上报的确实是 hover:none —— 这一条由 mobile.mjs 在真实触摸模拟下断言。
   */
  await evaluate(`(() => {
    window.__mfOrigMM = window.matchMedia
    window.matchMedia = (q) => (q === '(hover: hover)'
      ? { matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } }
      : window.__mfOrigMM(q))
    return window.matchMedia('(hover: hover)').matches
  })()`)
  const stubbed = await evaluate(`window.matchMedia('(hover: hover)').matches`)
  check('已把 matchMedia 切成「无 hover」（模拟触屏）', stubbed === false, String(stubbed))

  // 先移开再移回，确保重新触发一次 mouseenter
  await mouseMove(10, 10)
  await sleep(150)
  const downItem2 = await rectOf('[data-move-submenu] [data-move-item="down"]')
  await mouseMove(downItem2.cx, downItem2.cy)
  await sleep(300)
  const tipOnTouchLike = await evaluate(`!!document.querySelector('[data-move-tip]')`)
  check('★ hover:none 时悬停不弹快捷键气泡（手机没有键盘）',
    tipOnTouchLike === false, String(tipOnTouchLike))

  // 恢复成有鼠标的设备 → 气泡应该回来
  await evaluate(`(() => { window.matchMedia = window.__mfOrigMM; return true })()`)
  const restored = await evaluate(`window.matchMedia('(hover: hover)').matches`)
  check('matchMedia 已还原', restored === true, String(restored))
  await mouseMove(10, 10)
  await sleep(150)
  const upItem2 = await rectOf('[data-move-submenu] [data-move-item="up"]')
  await mouseMove(upItem2.cx, upItem2.cy)
  await sleep(300)
  const tipBack = await evaluate(`(() => {
    const t = document.querySelector('[data-move-tip]')
    return t ? t.textContent.trim() : null
  })()`)
  check('★ 恢复有 hover 后气泡回来了', tipBack === 'Alt + ←', String(tipBack))

  /* ---- 悬停「右移一位」弹出它自己的快捷键 ---- */
  const downItem = await rectOf('[data-move-submenu] [data-move-item="down"]')
  await mouseMove(downItem.cx, downItem.cy)
  await sleep(250)
  const tipDown = await evaluate(`(() => {
    const t = document.querySelector('[data-move-tip]')
    return t ? t.textContent.trim() : null
  })()`)
  check('悬停「右移一位」弹出右移的快捷键', tipDown === 'Alt + →', String(tipDown))

  /* ---- 悬停「下移一级」弹出它自己的快捷键 ---- */
  const demoteItem = await rectOf('[data-move-submenu] [data-move-item="demote"]')
  await mouseMove(demoteItem.cx, demoteItem.cy)
  await sleep(250)
  const tipDemote = await evaluate(`(() => {
    const t = document.querySelector('[data-move-tip]')
    return t ? t.textContent.trim() : null
  })()`)
  check('悬停「下移一级」弹出下移的快捷键', tipDemote === 'Alt + ↓', String(tipDemote))

  /* ---- 鼠标移出子菜单：气泡消失 ---- */
  await mouseMove(10, 10)
  await sleep(300)
  const tipGone = await evaluate(`!!document.querySelector('[data-move-tip]')`)
  check('鼠标移开后气泡消失', tipGone === false, String(tipGone))

  /* ================================================================== */
  console.log('\n[8b] ★ 防呆置灰矩阵：置灰的项必须真的做不了')
  /* ================================================================== */

  const openMove = async (id) => {
    /*
     * 先把可能还开着的菜单关掉。
     * `moveOpen` 是 NodeContextMenu 的内部 state，换一个节点右键**不会**重置它 ——
     * 如果上一节把子菜单留着开着，这里再点一次「移动位置」会把它**收起来**，
     * 于是拿到 null，看起来像「菜单打不开」。
     */
    await evaluate(`(() => { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)
    await sleep(250)
    await rightClickNode(id)
    await clickSel('[data-node-menu] [data-menu-item="move"]')
    await sleep(250)
    return evaluate(`(() => {
      const sub = document.querySelector('[data-move-submenu]')
      if (!sub) return null
      const out = {}
      for (const b of sub.querySelectorAll('[data-move-item]')) out[b.dataset.moveItem] = b.disabled
      return out
    })()`)
  }

  // 根节点：没有父 → 上移一级置灰；没有祖父也一样
  const rootState = await openMove('n0')
  note(`根节点 n0：${JSON.stringify(rootState)}`)
  check('★ 根节点「上移一级」置灰', rootState?.promote === true, JSON.stringify(rootState))
  check('根节点「下移一级」也置灰（没有父节点无法下沉）',
    rootState?.demote === true, JSON.stringify(rootState))

  // 深层节点：n2 的父是 n1、祖父是 n0 → 可提升；n2 没有子 → 不可下沉
  // （复用上面 [7] 里那份 DEEP 代码，形状正好合适）
  await writeCode(DEEP)
  await sleep(900)
  const deepState = await openMove('n2')
  note(`深层叶子 n2：${JSON.stringify(deepState)}`)
  check('★ 有祖父的节点「上移一级」可用', deepState?.promote === false, JSON.stringify(deepState))
  check('★ 没有子节点的「下移一级」置灰', deepState?.demote === true, JSON.stringify(deepState))
  check('只有一个兄弟时「左移/右移」都置灰',
    deepState?.up === true && deepState?.down === true, JSON.stringify(deepState))

  // 父节点是根 → 提升会拆成两块图，必须也置灰（比「是根节点」更严一档）
  const midState = await openMove('n1')
  note(`父节点是根的 n1：${JSON.stringify(midState)}`)
  check('★ 父节点是根时「上移一级」也置灰（提升会让图断成两块）',
    midState?.promote === true, JSON.stringify(midState))

  /* ================================================================== */
  console.log('\n[8c] ★ LR 布局：同层是上下排开的，文案/图标/快捷键必须跟着换')
  /* ================================================================== */
  /*
   * 这是「绝不误导用户」的延伸：dagre 在 LR 下把同层节点**垂直**排开，
   * 于是「换代码顺序」在屏幕上变成上下移动、而「改层级」变成左右移动。
   * 如果文案写死成左右，LR 用户看到的每一个字都是错的。
   */
  const LR_BASE = [
    'flowchart LR',
    '  n0["根"]',
    '  n1["甲"]',
    '  n2["乙"]',
    '  n3["丙"]',
    '  n0 --> n1',
    '  n0 --> n2',
    '  n0 --> n3',
  ].join('\n')
  await writeCode(LR_BASE)
  await sleep(900)

  const lrState = await openMove('n2')
  const lrUi = await evaluate(`(() => {
    const sub = document.querySelector('[data-move-submenu]')
    if (!sub) return null
    const items = [...sub.querySelectorAll('[data-move-item]')]
    return {
      labels: items.map(b => b.querySelector('span:last-child')?.textContent?.trim() ?? ''),
      shortcuts: items.map(b => b.dataset.shortcut || null),
      iconPaths: items.map(b => [...b.querySelectorAll('svg path')].map(p => p.getAttribute('d')).join('|')),
      hint: sub.querySelector('[data-move-hint]')?.textContent?.trim() || null,
    }
  })()`)
  note(`LR 子菜单：${JSON.stringify({ labels: lrUi?.labels, shortcuts: lrUi?.shortcuts })}`)
  check('★ LR 下换位文案变成「上移/下移一位」',
    JSON.stringify(lrUi?.labels) === JSON.stringify(['上移一位', '下移一位', '左移一级', '右移一级']),
    JSON.stringify(lrUi?.labels))
  check('★ LR 下换位图标变成 ↑/↓（和实际屏幕方向一致）',
    JSON.stringify(lrUi?.iconPaths) === JSON.stringify([
      'M12 19V5|m5 12 7-7 7 7',      // arrow-up
      'M12 5v14|m19 12-7 7-7-7',     // arrow-down
      'm12 19-7-7 7-7|M19 12H5',     // arrow-left
      'M5 12h14|m12 5 7 7-7 7',      // arrow-right
    ]), JSON.stringify(lrUi?.iconPaths))
  check('★ LR 下快捷键也跟着换（↑/↓ 换位，←/→ 改层级）',
    JSON.stringify(lrUi?.shortcuts) === JSON.stringify(['Alt + ↑', 'Alt + ↓', 'Alt + ←', 'Alt + →']),
    JSON.stringify(lrUi?.shortcuts))
  check('★ LR 下底部说明也跟着换，不会指错方向',
    lrUi?.hint === '上下移动只换顺序，左右移动会改变层级', String(lrUi?.hint))

  // 真实按键也要跟着换：LR 下 ↑/↓ 是同级换位、←/→ 是改层级
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    // 关掉菜单，避免干扰按键
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await sleep(300)
  })()`)
  await clickNode('n2')
  const lrUp = await pressAltArrow('ArrowUp')
  const lrOrder = childOrder(lrUp.code, 'n0').join()
  note(`LR 下 Alt+↑ 之后的同层顺序：${lrOrder}`)
  check('★ LR 下 Alt+↑ 做的是同级换位（顺序变了、边集合一个字没动）',
    lrOrder === 'n2,n1,n3' && sameEdges(LR_BASE, lrUp.code), lrOrder)

  /*
   * 同样要先把 n2 挪回中间：否则它在第一位时，
   * 「改层级被拒」和「同级换位越界」都是「代码不动」，这条断言没有判别力。
   * LR 下往回挪用的是 Alt+↓（同级换位）。
   */
  const lrDown = await pressAltArrow('ArrowDown')
  const lrBackOrder = childOrder(lrDown.code, 'n0').join()
  check('★ LR 下 Alt+↓ 也是同级换位（把 n2 挪回中间）',
    lrBackOrder === 'n1,n2,n3', lrBackOrder)

  const lrLeft = await pressAltArrow('ArrowLeft')
  const lrLeftToast = await evaluate(`document.querySelector('[data-toast]')?.textContent || null`)
  note(`LR 下 Alt+←：toast=${lrLeftToast}  code 变了=${lrLeft.code !== lrDown.code}`)
  check('★ LR 下 Alt+← 做的是改层级（父节点是根 → 被拒绝并提示、代码不动）',
    !!lrLeftToast && lrLeft.code === lrDown.code, `toast=${lrLeftToast}`)

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
