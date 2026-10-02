/**
 * 「指向同一结果」主画布端到端测试
 * ==================================
 * 纯函数（relatestest.mjs）已经证明了算法对。这里只验证**接线**：
 * UI 入口在不在、模式状态对不对、画出来的连线是什么样、撤销能不能回退。
 *
 * 覆盖需求逐条：
 *   一·1  右键菜单里有【指向同一结果】，且在【指向】正下方
 *   一·2  点击后进入连线模式：十字准星 + 提示「请点击要汇聚的目标节点」
 *   一·3  点目标节点后生成新节点（默认「新结果节点」），挂在公共父节点下
 *   一·4  relations 两条记录真的落到了文档上
 *   一·5  折叠的公共父节点自动展开
 *   一·6  汇聚连线是**实线**，颜色 / 线宽 / 箭头与普通树边完全一致
 *   一·7  汇聚节点排在源节点右侧紧邻一列、垂直居中于两个源节点（倒三角）
 *   四·1  Ctrl+Z 能撤销掉（节点和连线一起消失）
 *   四·2  移动端底部操作栏有入口，且触发后出现提示条
 *   五·2  relations > 50 条时默认隐藏，悬停才显示相关线
 *
 * 需要 dev server 已启动：npm run dev
 * 用法：node scripts/relatebrowser.mjs [url]
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

const PORT = 9351
const userDir = mkdtempSync(join(tmpdir(), 'mf-relate-'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (msg) => console.log(`  · ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ */
/* 种一棵确定的树，避免依赖示例文档的结构                                  */
/* ------------------------------------------------------------------ */
/*
 *        r 根
 *         ├── a
 *         │    └── a1
 *         ├── b
 *         └── c
 *
 * 选 a、b 汇聚 → 公共父节点是根，新节点排在 c 之后。
 * 选 a、a1 汇聚 → 公共父节点是 a 自己（父子关系的边界）。
 */
const SEED_DOC = {
  id: 'doc_relate', name: '汇聚测试', path: '汇聚测试',
  root: {
    id: 'r', text: '根', children: [
      { id: 'a', text: '甲', children: [{ id: 'a1', text: '甲子', children: [] }] },
      { id: 'b', text: '乙', children: [] },
      { id: 'c', text: '丙', children: [] },
    ],
  },
  relations: [],
  view: { x: 60, y: 60, zoom: 1 },
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

  // 先把种子数据写进 localStorage，再进页面 —— 否则会被 bootstrap 的示例文档覆盖
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }

  // about:blank 下 localStorage 不可用，先到应用域再写种子
  await cdp.send('Page.navigate', { url: URL_APP })
  await sleep(1200)
  /*
   * 只写 doc:<id> 本体 + tabs + active。
   * 不能把整份备份 JSON（{app, docs:[...]}）当文档存进去 ——
   * 那样 root 是 undefined，listDocs 会把整条跳过，页面直接空白。
   */
  await evaluate(`(() => {
    const doc = ${JSON.stringify(SEED_DOC)}
    localStorage.clear()
    localStorage.setItem('mf:doc:doc_relate', JSON.stringify(doc))
    localStorage.setItem('mf:tabs', JSON.stringify(['doc_relate']))
    localStorage.setItem('mf:active', JSON.stringify('doc_relate'))
    return true
  })()`)
  await cdp.send('Page.reload')
  await sleep(4200)

  const mouseMove = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  const realClick = async (x, y, button = 'left') => {
    await mouseMove(x, y)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
    await sleep(260)
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

  /** 节点在屏幕上的矩形 */
  const nodeRect = (id) => evaluate(`(() => {
    const el = document.querySelector('[data-node-id="' + ${JSON.stringify(id)} + '"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2, width: r.width, height: r.height }
  })()`)

  /** 右键节点 → 点菜单项 */
  const contextAction = async (id, action) => {
    const r = await nodeRect(id)
    if (!r) return { error: `找不到节点 ${id}` }
    await mouseMove(r.cx, r.cy)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.cx, y: r.cy, button: 'right', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.cx, y: r.cy, button: 'right', clickCount: 1 })
    await sleep(360)
    const ok = await clickSel(`[data-canvas-menu] [data-menu-item="${action}"]`)
    await sleep(420)
    return { ok }
  }

  /** 等防抖落盘后读文档（persist 是 900ms） */
  const doc = async () => {
    await sleep(1250)
    return evaluate(`(() => {
      const raw = localStorage.getItem('mf:doc:doc_relate')
      return raw ? JSON.parse(raw) : null
    })()`)
  }
  /** 立刻读（不等落盘）：用 DOM 上渲染出来的节点 */
  const renderedIds = () => evaluate(`[...document.querySelectorAll('[data-node-id]')].map(e => e.dataset.nodeId)`)
  const renderedText = (id) => evaluate(`(() => {
    const el = document.querySelector('[data-node-id="' + ${JSON.stringify(id)} + '"]')
    return el ? (el.querySelector('[data-text]')?.textContent ?? null) : null
  })()`)
  /** 画布上所有汇聚连线的属性 */
  const relationPaths = () => evaluate(`[...document.querySelectorAll('[data-relation-edge]')].map(p => ({
    key: p.dataset.relationEdge,
    stroke: p.getAttribute('stroke'),
    dash: p.getAttribute('stroke-dasharray'),
    marker: p.getAttribute('marker-end'),
    width: p.getAttribute('stroke-width'),
    d: (p.getAttribute('d') || '').slice(0, 12),
  }))`)

  /**
   * 数「有多少条线真正指进某个节点」。
   *
   * 【为什么要用几何而不是数 DOM】
   * 树边是 `path.mf-edge`，汇聚边是 `path[data-relation-edge]`，
   * 两类都在同一个 <g> 里。要判断「某个节点有几条入边」，只能看每条路径的
   * **终点落在哪里**。
   *
   * 【为什么不是「终点落在目标左边就算」】
   * 那样会把「指向旁边那个 y 相近的兄弟节点」的边也算进来 ——
   * 第一版就是这么写的，结果数出 3 条（多了隔壁节点的一条树边）。
   * 正确判据是**最近邻**：把每条路径的终点和画布上每个节点的
   * 「连线接入点」（左边缘中点）比距离，只有最近的正好是目标节点才算它的入边。
   */
  const inboundCount = (nodeId) => evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-node-id]')].map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.dataset.nodeId, x: r.left, y: r.top + r.height / 2 }
    })
    const target = nodes.find((n) => n.id === ${JSON.stringify(nodeId)})
    if (!target) return null
    const svg = document.querySelector('[data-canvas-wrap] svg')
    const paths = [...svg.querySelectorAll('path[fill="none"]')]
    const hits = paths.filter((p) => {
      const end = p.getPointAtLength(p.getTotalLength())
      const m = p.getScreenCTM()
      if (!m) return false
      const sx = m.a * end.x + m.c * end.y + m.e
      const sy = m.b * end.x + m.d * end.y + m.f
      let best = null
      for (const n of nodes) {
        const d = Math.hypot(sx - n.x, sy - n.y)
        if (!best || d < best.d) best = { id: n.id, d }
      }
      return best && best.id === target.id
    })
    return {
      total: paths.length,
      inbound: hits.length,
      // 其中带 data-relation-edge 的（汇聚边）有几条
      relInbound: hits.filter((p) => p.hasAttribute('data-relation-edge')).length,
    }
  })()`)
  const linkHint = () => evaluate(`(() => {
    const el = document.querySelector('[data-link-hint]')
    return el ? { text: el.textContent, kind: el.dataset.linkKind, border: getComputedStyle(el).borderColor } : null
  })()`)
  const canvasCursor = () => evaluate(`(() => {
    const el = document.querySelector('[data-canvas-wrap]')
    return el ? getComputedStyle(el).cursor : null
  })()`)
  /** 画布根（挂着 pointer handler 的那层）的 cursor */
  const wrapCursor = canvasCursor

  /* ================================================================== */
  console.log('\n[1] 种子数据与初始状态')
  /* ================================================================== */

  const ids0 = await renderedIds()
  check('种子树渲染出 5 个节点', ids0.length === 5, ids0.join())
  check('初始没有任何汇聚连线', (await relationPaths()).length === 0)
  check('初始没有连线提示条', (await linkHint()) === null)
  check('初始画布 cursor 不是十字准星', (await wrapCursor()) !== 'crosshair', String(await wrapCursor()))

  /* ================================================================== */
  console.log('\n[2] 右键菜单：两个入口并列（一·1）')
  /* ================================================================== */

  {
    const r = await nodeRect('a')
    await mouseMove(r.cx, r.cy)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.cx, y: r.cy, button: 'right', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.cx, y: r.cy, button: 'right', clickCount: 1 })
    await sleep(360)

    const menu = await evaluate(`(() => {
      const m = document.querySelector('[data-canvas-menu]')
      if (!m) return null
      const items = [...m.querySelectorAll('[data-menu-item]')].map(b => ({
        action: b.dataset.menuItem,
        label: b.querySelector('span.flex-1')?.textContent ?? '',
        hasIcon: !!b.querySelector('[data-menu-icon]'),
        disabled: b.disabled,
      }))
      return { items, order: items.map(i => i.action) }
    })()`)
    check('右键节点弹出了菜单', menu != null)
    if (menu) {
      const iPoint = menu.order.indexOf('point-to')
      const iMerge = menu.order.indexOf('point-merge')
      check('★ 菜单里有【指向】', iPoint >= 0, menu.order.join())
      check('★ 菜单里有【指向同一结果】', iMerge >= 0, menu.order.join())
      check('★ 【指向同一结果】就在【指向】正下方',
        iMerge === iPoint + 1, `point-to@${iPoint} point-merge@${iMerge}`)
      const pt = menu.items[iPoint]
      const pm = menu.items[iMerge]
      check('两个入口文案精确', pt.label === '指向' && pm.label === '指向同一结果',
        `${pt.label} / ${pm.label}`)
      check('两个入口都有图标（同族，一眼可分）', pt.hasIcon && pm.hasIcon)
      check('两个入口都可用（节点不是根）', !pt.disabled && !pm.disabled)
      check('★ 汇聚入口用的是 git-merge 图标（两条线汇入一点）', await evaluate(`(() => {
        const b = document.querySelector('[data-canvas-menu] [data-menu-item="point-merge"] [data-menu-icon] svg')
        if (!b) return false
        // git-merge = 两个圆 + 一条弧
        return b.querySelectorAll('circle').length === 2
      })()`))
    }
    // 关掉菜单
    await evaluate(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await sleep(200)
  }

  /* ================================================================== */
  console.log('\n[3] 根节点上两个入口置灰（防呆）')
  /* ================================================================== */

  {
    const r = await nodeRect('r')
    await mouseMove(r.cx, r.cy)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.cx, y: r.cy, button: 'right', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.cx, y: r.cy, button: 'right', clickCount: 1 })
    await sleep(360)
    const st = await evaluate(`(() => {
      const q = (a) => { const b = document.querySelector('[data-canvas-menu] [data-menu-item="' + a + '"]'); return b ? b.disabled : null }
      return { point: q('point-to'), merge: q('point-merge') }
    })()`)
    check('★ 根节点上【指向】置灰', st.point === true, JSON.stringify(st))
    check('★ 根节点上【指向同一结果】置灰', st.merge === true, JSON.stringify(st))
    await evaluate(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await sleep(200)
  }

  /* ================================================================== */
  console.log('\n[4] 进入连线模式（一·2）')
  /* ================================================================== */

  {
    const r = await contextAction('a', 'point-merge')
    check('点击【指向同一结果】成功', r.ok === true, JSON.stringify(r))

    const hint = await linkHint()
    check('★ 出现提示条', hint != null)
    check('★ 提示文案是「请点击要汇聚的目标节点」',
      hint && hint.text.includes('请点击要汇聚的目标节点'), hint && hint.text)
    check('提示条 kind=merge', hint && hint.kind === 'merge', hint && hint.kind)
    /*
     * 提示条保持蓝色：它表达的是「正在连线」这个**模式**，
     * 和汇聚连线本身的颜色是两回事（连线已经统一成普通树边的灰）。
     */
    check('★ 提示条是蓝色边框（连线模式的标识色）',
      hint && /59,\s*130,\s*246/.test(hint.border), hint && hint.border)
    check('★ 画布鼠标变成十字准星', (await wrapCursor()) === 'crosshair', String(await wrapCursor()))

    // 源节点高亮，其他节点标记为可点
    const marks = await evaluate(`(() => {
      const all = [...document.querySelectorAll('[data-node-id]')]
      return {
        source: all.filter(e => e.dataset.linkSource === 'true').map(e => e.dataset.nodeId),
        candidates: all.filter(e => e.dataset.linkCandidate === 'true').map(e => e.dataset.nodeId),
        sourceBorder: (() => { const e = document.querySelector('[data-link-source="true"]'); return e ? getComputedStyle(e).borderColor : null })(),
      }
    })()`)
    check('★ 源节点被标记为起点', marks.source.join() === 'a', marks.source.join())
    check('★ 源节点是蓝色实线框', /59,\s*130,\s*246/.test(marks.sourceBorder || ''), marks.sourceBorder)
    check('★ 其他节点都标记为可点（含自己之外全部）',
      marks.candidates.sort().join() === 'a1,b,c,r', marks.candidates.join())
    check('源节点自身不算候选', !marks.candidates.includes('a'))
  }

  /* ================================================================== */
  console.log('\n[5] Esc / 点空白取消')
  /* ================================================================== */

  {
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(300)
    check('★ Esc 退出连线模式（提示条消失）', (await linkHint()) === null)
    check('Esc 后十字准星恢复', (await wrapCursor()) !== 'crosshair', String(await wrapCursor()))
    check('Esc 后没有生成任何节点', (await renderedIds()).length === 5)

    // 重新进入，点空白取消
    await contextAction('a', 'point-merge')
    check('前置：又进入连线模式', (await linkHint()) != null)
    // 点画布右下角的空白处
    await realClick(1380, 820)
    check('★ 点空白也退出连线模式', (await linkHint()) === null)
    check('点空白后没有生成节点', (await renderedIds()).length === 5)
  }

  /* ================================================================== */
  console.log('\n[6] 完成汇聚：节点 + 连线（一·3、一·4、一·6）')
  /* ================================================================== */

  let newId = null
  {
    await contextAction('a', 'point-merge')
    const b = await nodeRect('b')
    await realClick(b.cx, b.cy)
    await sleep(600)

    check('★ 连线模式已退出', (await linkHint()) === null)

    const after = await renderedIds()
    check('★ 多出了一个节点', after.length === 6, after.join())
    newId = after.find((x) => !['r', 'a', 'a1', 'b', 'c'].includes(x)) || null
    check('★ 新节点 id 能从 DOM 里认出来', !!newId, String(newId))

    const d = await doc()
    check('文档落盘成功', d != null)

    // 结构：新节点是根的最后一个子节点
    const rootKids = d.root.children.map((c) => c.id)
    check('★ 新节点挂在公共父节点（根）下', rootKids.includes(newId), rootKids.join())
    check('★ 新节点排在最后一个（不打乱原有顺序）',
      rootKids[rootKids.length - 1] === newId, rootKids.join())
    check('原有三个子节点顺序没变',
      rootKids.slice(0, 3).join() === 'a,b,c', rootKids.join())
    check('★ A、B 仍然挂在原来的父节点下（树没被破坏）',
      d.root.children.find((c) => c.id === 'a').children.some((c) => c.id === 'a1') &&
      d.root.children.some((c) => c.id === 'b'))
    check('★ 新节点没有把 A、B 收成子节点（它是叶子）',
      (d.root.children.find((c) => c.id === newId) || {}).children?.length === 0)

    // 默认文字
    check('★ 默认文字是「新结果节点」',
      d.root.children.find((c) => c.id === newId).text === '新结果节点',
      d.root.children.find((c) => c.id === newId).text)

    // relations 两条
    const rels = d.relations || []
    check('★ relations 里落了两条', rels.length === 2, JSON.stringify(rels))
    check('★ A → 新节点', rels.some((x) => x.from === 'a' && x.to === newId), JSON.stringify(rels))
    check('★ B → 新节点', rels.some((x) => x.from === 'b' && x.to === newId), JSON.stringify(rels))

    // 画出来的汇聚连线
    /*
     * 【已从「蓝色虚线」改为「与普通树边完全一致的实线」】
     * 原来断言的是 #3b82f6 + dasharray 5,5 + 专用蓝色箭头。
     * 虚线在视觉上表达「不确定 / 弱关系」，而多对一汇聚和普通父子边一样
     * 是**确定的**结构关系，用虚线反而让人以为它随时会消失。
     * 现在统一成实线：同样的 var(--mf-edge) 颜色、同样的 1.6 线宽、
     * 同样的 edgePath 贝塞尔曲线和 mf-arrow 箭头，不做任何特殊区分。
     */
    const paths = await relationPaths()
    check('★ 画布上画出 2 条汇聚连线', paths.length === 2, JSON.stringify(paths.map((p) => p.key)))
    check('★ 汇聚连线用普通树边的颜色（不再单独是蓝色）',
      paths.every((p) => p.stroke === 'var(--mf-edge)'), JSON.stringify(paths.map((p) => p.stroke)))
    check('★ 汇聚连线是实线（dasharray 为空，不再有虚线）',
      paths.every((p) => p.dash === null), JSON.stringify(paths.map((p) => p.dash)))
    check('★ 汇聚连线复用普通箭头 mf-arrow',
      paths.every((p) => p.marker === 'url(#mf-arrow)'), JSON.stringify(paths.map((p) => p.marker)))
    check('★ 汇聚连线线宽与树边一致（1.6）',
      paths.every((p) => p.width === '1.6'), JSON.stringify(paths.map((p) => p.width)))
    check('汇聚连线是真实的贝塞尔路径（不是空 d）', paths.every((p) => p.d.startsWith('M ')), JSON.stringify(paths.map((p) => p.d)))

    /*
     * ★ 入边总数必须是 2，不能是 3。
     *
     * 用户报的 bug：「指向同一节点会多出来一条线，貌似是更高层的」。
     * 那条多出来的线就是汇聚节点在**树里**的那条 P→C
     * （P = A、B 的公共父节点，这里是根；C = 新结果节点）——
     * convergeToNewNode 必须把 C 挂在某个父节点下，但那条父子边
     * 并不表达任何用户想要的关系，视觉上纯属多一根线。
     *
     * 现在 Canvas 会跳过「有 ≥2 条 relations 指向它」的节点的树边
     * （判据见 Canvas.convergenceTargets）。这里用**几何**验证：
     * 数所有终点落在新节点左边缘的路径 —— 树边和汇聚边都在同一层里，
     * 只数 DOM 是分不出来的，必须看每条路径实际画到哪里。
     */
    const inbound = await inboundCount(newId)
    note(`新节点入边：${JSON.stringify(inbound)}`)
    check('★ 汇聚节点只有 2 条入边（那条来自高层父节点的树边已被藏掉）',
      inbound && inbound.inbound === 2, JSON.stringify(inbound))
    check('★ 这 2 条入边都是汇聚边（不是树边冒充的）',
      inbound && inbound.relInbound === 2, JSON.stringify(inbound))
  }

  /* ================================================================== */
  console.log('\n[6b] 汇聚节点的真实排版：紧凑倒三角（一·7）')
  /* ================================================================== */

  {
    /*
     * 纯函数测试（layout.converge.test.mjs）已经在布局层证明了数学关系。
     * 这里验证**接线**：Canvas 真的把 relations 传给了 layoutTree ——
     * 漏传的话布局那一趟根本不会跑，节点会停在被追加的位置（底部/边缘），
     * 而所有纯函数测试照样全绿。
     *
     * 量的是屏幕上真实渲染出来的位置（getBoundingClientRect），
     * 不依赖任何内部状态。
     */
    const geo = await evaluate(`(() => {
      const d = JSON.parse(localStorage.getItem('mf:doc:doc_relate'))
      const rels = d.relations || []
      // 找一个「多对一」的汇聚点：同一个 to 至少两个 from
      const byTo = new Map()
      for (const r of rels) {
        if (!byTo.has(r.to)) byTo.set(r.to, [])
        byTo.get(r.to).push(r.from)
      }
      let target = null
      for (const [to, froms] of byTo) if (froms.length >= 2) { target = { to, froms }; break }
      if (!target) return { skip: true, rels }
      const box = (id) => {
        const el = document.querySelector('[data-node-id="' + id + '"]')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, left: r.left, right: r.right }
      }
      const t = box(target.to)
      const srcs = target.froms.map(box)
      return { target: t, srcs, skip: false }
    })()`)

    check('能找到一个多对一的汇聚点用于几何断言', geo && !geo.skip,
      JSON.stringify(geo && geo.rels))

    if (geo && !geo.skip && geo.target && geo.srcs.every(Boolean)) {
      const { target, srcs } = geo
      const cys = srcs.map((s) => s.cy)
      const lo = Math.min(...cys)
      const hi = Math.max(...cys)

      check('★ 汇聚节点垂直居中于两个源节点之间（不是被挤到上下两端）',
        target.cy >= lo - 2 && target.cy <= hi + 2,
        `汇聚cy=${target.cy.toFixed(1)} 源区间=[${lo.toFixed(1)}, ${hi.toFixed(1)}]`)

      check('★ 汇聚节点在源节点右侧（X 层级对齐）',
        srcs.every((s) => target.cx > s.cx),
        `汇聚cx=${target.cx.toFixed(1)} 源cx=${srcs.map((s) => s.cx.toFixed(1)).join(',')}`)

      /*
       * 防跨屏：汇聚点相对源节点的水平推进量应该是一个「层间距」量级
       * （约 GAP_X = 96px × zoom），而不是横跨半个画布。
       * 用缩放比例换算，避免因为 fitView 的 zoom 不同而误判。
       */
      const zoom = await evaluate(`(() => {
        const g = document.querySelector('[data-canvas-wrap] svg g[transform]')
        const m = (g && g.getAttribute('transform') || '').match(/scale\\(([\\d.]+)\\)/)
        return m ? parseFloat(m[1]) : 1
      })()`)
      // 画布可视宽度：用来断言「跨度远小于半张图」
      const diag = await evaluate(`(() => {
        const wrap = document.querySelector('[data-canvas-wrap]')
        return { wrapW: wrap ? Math.round(wrap.getBoundingClientRect().width) : 0 }
      })()`)
      /*
       * 防跨屏：量的是**连线真正跨越的水平距离** ——
       * 从源节点右边缘到汇聚节点左边缘。
       *
       * 注意不能用 target.cx：那是汇聚节点的**中心**，
       * 会白白多算半个节点宽度（实测多出 50px，让断言假失败）。
       * 连线是画到左边缘的，所以只有 left 才是连线的终点。
       *
       * 阈值取「一个层间距（GAP_X=96）× zoom」再放宽一点：
       * 汇聚节点落在源节点右侧**紧邻**的一列，跨度天然就是
       * 列内余量 + GAP_X，量级固定，不会随图变大而膨胀。
       */
      const advance = target.left - Math.max(...srcs.map((s) => s.right))
      const canvasW = diag.wrapW
      check('★ 汇聚连线不会横跨画布（水平跨度 ≈ 一个层间距）',
        advance < 96 * zoom + 80,
        `跨度=${advance.toFixed(1)}px zoom=${zoom} 阈值=${(96 * zoom + 80).toFixed(1)}`)
      check('★ 汇聚连线跨度远小于画布宽度（不是半张图的长线）',
        advance < canvasW * 0.25,
        `跨度=${advance.toFixed(1)}px 画布宽=${canvasW}px`)

      check('★ 两个源节点到汇聚点的垂直距离对称（倒三角）',
        Math.abs((target.cy - cys[0]) + (target.cy - cys[1])) < 6,
        `Δ=${(target.cy - cys[0]).toFixed(1)},${(target.cy - cys[1]).toFixed(1)}`)
    }

    /*
     * 汇聚节点绝不能压在任何别的节点上。
     *
     * 老实现把汇聚节点的 x 算成「源列右侧那一列」，而那一列上**本来就有树节点**
     * （这里 a 的子节点 a1 就在那一列），于是两个节点框直接叠在一起、连线从
     * 那一列中间横穿过去。量真实矩形是唯一能抓住它的办法 —— 纯函数测试里
     * 那条断言是同一条判据，这里验证它真的接到了画布上。
     */
    const boxes = await evaluate(`(() => {
      const list = [...document.querySelectorAll('[data-node-id]')].map((el) => {
        const r = el.getBoundingClientRect()
        return { id: el.dataset.nodeId, l: r.left, r: r.right, t: r.top, b: r.bottom }
      })
      const hits = []
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const p = list[i], q = list[j]
          const ox = Math.min(p.r, q.r) - Math.max(p.l, q.l)
          const oy = Math.min(p.b, q.b) - Math.max(p.t, q.t)
          if (ox > 0.5 && oy > 0.5) hits.push(p.id + '×' + q.id + '(' + ox.toFixed(1) + '×' + oy.toFixed(1) + ')')
        }
      }
      return { count: list.length, hits }
    })()`)
    check('★ 画布上没有任何两个节点框叠在一起（汇聚点有专属通道）',
      boxes && boxes.count >= 5 && boxes.hits.length === 0, JSON.stringify(boxes))
  }

  /* ================================================================== */
  console.log('\n[7] 即时改名：悬浮输入框（一·4 的 A 方案）')
  /* ================================================================== */

  {
    const box = await evaluate(`(() => {
      const el = document.querySelector('[data-floating-rename]')
      if (!el) return null
      const input = el.querySelector('[data-rename-input]')
      const r = el.getBoundingClientRect()
      const ir = input.getBoundingClientRect()
      return {
        hasInput: !!input,
        value: input.value,
        selected: input.selectionStart === 0 && input.selectionEnd === input.value.length,
        focused: document.activeElement === input,
        fontSize: getComputedStyle(input).fontSize,
        screenW: Math.round(r.width),
        left: Math.round(r.left), top: Math.round(r.top),
        inputLeft: Math.round(ir.left), inputTop: Math.round(ir.top),
        border: getComputedStyle(input).borderColor,
      }
    })()`)
    check('★ 生成后立刻弹出悬浮输入框', box != null)
    if (box) {
      check('★ 默认文字是「新结果节点」', box.value === '新结果节点', box.value)
      check('★ 默认全选（可以直接打字覆盖）', box.selected === true, JSON.stringify({ s: box.selected }))
      check('输入框已获得焦点', box.focused === true)
      check('★ 输入框不随画布缩放（字号恒为 14px）', box.fontSize === '14px', box.fontSize)
      check('输入框是蓝色边框（和汇聚同色系）',
        /59,\s*130,\s*246/.test(box.border), box.border)

      // 输入框应该落在新节点上方附近
      const nr = await nodeRect(newId)
      const dist = Math.abs((box.inputLeft + 80) - nr.cx)
      check('★ 输入框定位在新节点附近（不脱节）', dist < 120, `dist=${Math.round(dist)}`)
    }
  }

  /* ================================================================== */
  console.log('\n[8] 改名生效')
  /* ================================================================== */

  {
    await evaluate(`(() => {
      const input = document.querySelector('[data-rename-input]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '断开连接')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await evaluate(`(() => {
      const input = document.querySelector('[data-rename-input]')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return true
    })()`)
    await sleep(500)

    check('★ 回车后输入框关闭', (await evaluate(`!document.querySelector('[data-floating-rename]')`)) === true)
    check('★ 节点文字已同步更新', (await renderedText(newId)) === '断开连接', String(await renderedText(newId)))

    const d = await doc()
    check('★ 改名也落盘了',
      d.root.children.find((c) => c.id === newId).text === '断开连接',
      d.root.children.find((c) => c.id === newId).text)
  }

  /* ================================================================== */
  console.log('\n[9] 重复操作被拦（三·3）')
  /* ================================================================== */

  {
    await contextAction('a', 'point-merge')
    const b = await nodeRect('b')
    await realClick(b.cx, b.cy)
    await sleep(700)

    const toast = await evaluate(`(() => {
      const els = [...document.querySelectorAll('div')].filter(e => e.textContent === '已存在汇聚关系')
      return els.length ? els[0].textContent : null
    })()`)
    check('★ 提示「已存在汇聚关系」', toast === '已存在汇聚关系', String(toast))
    check('★ 没有再多生成节点', (await renderedIds()).length === 6, (await renderedIds()).join())
    check('★ relations 仍然只有两条', (await doc()).relations.length === 2)
    check('★ 也没有弹出改名框', (await evaluate(`!document.querySelector('[data-floating-rename]')`)) === true)
  }

  /* ================================================================== */
  console.log('\n[10] 撤销：节点和连线一起回退（四·1）')
  /* ================================================================== */

  {
    /*
     * 撤销是**两格**：生成汇聚节点一格，紧接着的改名一格。
     * 这是刻意的 —— 每一次真实变更都该能单独回退，
     * 改完名发现改错了不该被迫把整个节点也撤掉。
     * 所以这里分两步验证，而不是一步到位。
     */
    const undo = () => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))`)

    await undo()
    await sleep(700)
    check('★ 撤销第一格：只回退改名，节点还在', (await renderedIds()).length === 6, (await renderedIds()).join())
    check('★ 撤销第一格：文字回到「新结果节点」',
      (await renderedText(newId)) === '新结果节点', String(await renderedText(newId)))
    check('★ 撤销第一格：连线还在（这次撤销不该动它）', (await relationPaths()).length === 2)

    await undo()
    await sleep(700)
    const after = await renderedIds()
    check('★ 撤销第二格：汇聚节点消失', after.length === 5, after.join())
    check('★ 撤销第二格：连线也全部消失', (await relationPaths()).length === 0)

    const d = await doc()
    check('★ 落盘数据里节点也回去了', d.root.children.length === 3, String(d.root.children.length))
    check('★ 落盘数据里 relations 也清空了', (d.relations || []).length === 0, JSON.stringify(d.relations))

    // 重做要把两格都装回来
    const redo = () => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`)
    await redo()
    await sleep(700)
    check('★ 重做第一格：节点和连线都回来',
      (await renderedIds()).length === 6 && (await relationPaths()).length === 2,
      `${(await renderedIds()).length} 节点 / ${(await relationPaths()).length} 线`)
    await redo()
    await sleep(700)
    check('★ 重做第二格：改的名字也回来了',
      (await renderedText(newId)) === '断开连接', String(await renderedText(newId)))
  }

  /* ================================================================== */
  console.log('\n[11] 父子关系边界（三·2）')
  /* ================================================================== */

  {
    // a 和 a1 是父子 → 公共父节点应该是 a 自己
    await contextAction('a', 'point-merge')
    const a1 = await nodeRect('a1')
    await realClick(a1.cx, a1.cy)
    await sleep(600)

    const d = await doc()
    const aNode = d.root.children.find((c) => c.id === 'a')
    const fresh = aNode.children.find((c) => c.text === '新结果节点')
    check('★ 父子汇聚：新节点成为 A 的另一个子节点', !!fresh, JSON.stringify(aNode.children.map((c) => c.text)))
    check('★ 原子树没被破坏（a1 还在）', aNode.children.some((c) => c.id === 'a1'))
    check('★ 新增两条指向它的 relations',
      d.relations.filter((r) => r.to === fresh.id).length === 2,
      JSON.stringify(d.relations))

    // 关掉改名框，避免影响后面
    await evaluate(`(() => {
      const input = document.querySelector('[data-rename-input]')
      if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    })()`)
    await sleep(300)
  }

  /* ================================================================== */
  console.log('\n[12] 删除联动（三·4）')
  /* ================================================================== */

  {
    const before = await doc()
    const freshId = before.root.children.find((c) => c.id === 'a')
      .children.find((c) => c.text === '新结果节点').id

    // 删掉 b（A 或 B 之一）
    await contextAction('b', 'remove')
    await sleep(500)

    const d = await doc()
    check('★ 删掉 b 后，b 那条 relations 被清掉',
      !(d.relations || []).some((r) => r.from === 'b' || r.to === 'b'),
      JSON.stringify(d.relations))
    check('★ 指向 b 的其它 relations 也一起清掉（无悬空引用）',
      (d.relations || []).every((r) => r.from !== 'b' && r.to !== 'b'))
    check('★ 汇聚节点本身不跟着消失（它已是独立子树）',
      !!d.root.children.find((c) => c.id === 'a')?.children.find((c) => c.id === freshId),
      JSON.stringify(d.root.children.find((c) => c.id === 'a')?.children.map((c) => c.text)))
    /*
     * 连线 key 是 `from\u0000to`，两端都是**自动生成的 id**（如 n_muf2gsbm_2）。
     * 早先这里写成 `!p.key.includes('b')` —— 拿「被删节点的 id」去子串匹配整条 key，
     * 而 base36 时间戳里**随时可能蹦出一个字母 b**（实测真的撞上过），
     * 于是这条断言会毫无规律地随机失败。必须按分隔符切开做**精确比较**。
     */
    check('★ 画布上不再有指向 b 的连线',
      (await relationPaths()).every((p) => {
        const [f, t] = p.key.split('\u0000')
        return f !== 'b' && t !== 'b'
      }),
      JSON.stringify((await relationPaths()).map((p) => p.key)))
  }

  /* ================================================================== */
  console.log('\n[13] 悬停相关线 + 阈值（五·2）')
  /* ================================================================== */

  {
    // 阈值常量由纯函数测试保证是 50；这里验证「悬停节点时相关线被保留」。
    // 当前 relations 很少（<= 50），所以所有线都应该画出来。
    const all = await relationPaths()
    check('relations 少于 50 条时全部显示', all.length > 0, String(all.length))

    // 悬停到汇聚节点上：它作为 to 端，相关线应保持可见
    const nr = await nodeRect(await evaluate(`(() => {
      const d = JSON.parse(localStorage.getItem('mf:doc:doc_relate'))
      const walk = (n) => { if (n.text === '新结果节点') return n.id; for (const c of n.children) { const r = walk(c); if (r) return r } return null }
      return walk(d.root)
    })()`))
    if (nr) {
      await mouseMove(nr.cx, nr.cy)
      await sleep(300)
      check('★ 悬停汇聚节点时相关连线仍然可见', (await relationPaths()).length > 0)
    }
  }

  /* ================================================================== */
  console.log('\n[14] 移动端：长按节点菜单里的「指向同一结果」入口（四·2）')
  /* ================================================================== */

  /*
   * 【这一节为什么从「底栏按钮」改成「长按菜单」】
   *
   * 底栏那颗「指向同一结果」已经按需求删掉了
   * （原话：「无论是电脑端还是手机端 底部的指向同一结果去掉 太多余了」）——
   * 同一功能在右键/长按菜单里本来就有，底栏那颗是重复入口，
   * 而且手机底栏只有 390px，白占一颗常驻按钮。
   *
   * 所以这里改成验证**手机端真正剩下的那个入口**：长按节点 → 菜单 →
   * 「指向同一结果」。手机上没有右键，长按是 `Canvas.onLongPress` →
   * `App.openNodeMenuAt` → `ContextMenu`（`[data-canvas-menu]`）。
   *
   * 顺手加一条反向断言：底栏里**不应该**再有 merge —— 需求要的就是它消失，
   * 将来谁又加回去，这条会立刻红。
   */
  {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    })
    await sleep(1200)

    // 反向断言：底栏没有 merge 了，但其他工具都还在
    const bar = await evaluate(`(() => {
      const el = document.querySelector('[data-bottom-toolbar]')
      if (!el) return null
      return {
        tools: [...el.querySelectorAll('[data-tool]')].map(x => x.dataset.tool),
        hasMerge: !!el.querySelector('[data-tool="merge"]'),
      }
    })()`)
    check('★ 移动端底栏已无「指向同一结果」（需求：去掉多余的重复入口）',
      bar && bar.hasMerge === false, JSON.stringify(bar))
    check('底栏其余工具一个都没少',
      bar && ['center', 'zoom-in', 'zoom-out', 'undo', 'redo', 'radar', 'more'].every(t => bar.tools.includes(t)),
      JSON.stringify(bar && bar.tools))

    /*
     * 切到 390px 后视口变了但 view 没变，原来的节点可能跑到屏幕外。
     * 先 Ctrl+0 重新居中铺满，否则 realClick 点的是视口外的坐标。
     */
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await sleep(600)

    const pick = await evaluate(`(() => {
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      for (const el of document.querySelectorAll('[data-node-id]')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0) continue
        if (r.left > 4 && r.right < vw - 4 && r.top > 60 && r.bottom < vh - 60) {
          return { id: el.dataset.nodeId, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
        }
      }
      return null
    })()`)
    check('移动端能找到一个可见节点用于测试', pick != null, JSON.stringify(pick))

    if (pick) {
      /*
       * 长按 500ms 才弹菜单（LONG_PRESS_MS）。用真实指针事件按下、等住、再抬起，
       * 而不是合成一个 click —— 合成事件绕过长按定时器，测的就不是真路径了。
       */
      const longPress = async (x, y) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await sleep(750)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        await sleep(400)
      }

      await longPress(pick.cx, pick.cy)
      const menu = await evaluate(`(() => {
        const m = document.querySelector('[data-canvas-menu]')
        if (!m) return null
        const it = m.querySelector('[data-menu-item="point-merge"]')
        if (!it) return { missing: true, items: [...m.querySelectorAll('[data-menu-item]')].map(x => x.dataset.menuItem) }
        const r = it.getBoundingClientRect()
        const mr = m.getBoundingClientRect()
        return {
          exists: true, text: it.innerText.trim(), disabled: it.disabled,
          x: r.left + r.width / 2, y: r.top + r.height / 2,
          menuInViewport: mr.left >= -1 && mr.right <= document.documentElement.clientWidth + 1
            && mr.top >= -1 && mr.bottom <= document.documentElement.clientHeight + 1,
        }
      })()`)
      check('★ 长按节点弹出画布菜单', menu != null, JSON.stringify(menu))
      check('★ 菜单里有【指向同一结果】入口', menu && menu.exists === true, JSON.stringify(menu))
      if (menu && menu.exists) {
        check('菜单里这一项写着「指向同一结果」', /指向同一结果/.test(menu.text || ''), menu.text)
        check('菜单整体落在视口内（长按点靠边也不会被裁掉）', menu.menuInViewport === true)

        await realClick(menu.x, menu.y)
        const hint = await linkHint()
        check('★ 从这里触发后出现连线提示条', hint != null, JSON.stringify(hint))
        check('★ 提示文案是「请点击要汇聚的目标节点」',
          hint && hint.text.includes('请点击要汇聚的目标节点'), hint && hint.text)

        // 再点另一个可见节点完成汇聚
        /*
         * 【第二个节点必须选「还没和第一个汇聚过」的】
         *
         * 本用例跑到这里时，文档里已经有若干汇聚关系了（前面几节建的）。
         * 如果第二个节点和第一个**已经共享同一个结果节点**，
         * App 会正确地拒绝（提示「已存在汇聚关系」），节点数自然不会 +1 ——
         * 那是**功能正确**，却会让这条断言假失败。
         */
        const partners = await evaluate(`(() => {
          const from = ${JSON.stringify(pick.id)}
          const edges = [...document.querySelectorAll('[data-relation-edge]')]
            .map((p) => (p.dataset.relationEdge || '').split('\\u0000'))
          const targets = new Set(edges.filter((e) => e[0] === from).map((e) => e[1]))
          const bad = new Set([from])
          for (const e of edges) if (targets.has(e[1])) bad.add(e[0])
          return [...bad]
        })()`)

        const pick2 = await evaluate(`(() => {
          const vw = document.documentElement.clientWidth
          const vh = document.documentElement.clientHeight
          const bad = new Set(${JSON.stringify(partners)})
          for (const el of document.querySelectorAll('[data-node-id]')) {
            if (bad.has(el.dataset.nodeId)) continue
            const r = el.getBoundingClientRect()
            if (r.width === 0) continue
            if (r.left > 4 && r.right < vw - 4 && r.top > 60 && r.bottom < vh - 60) {
              return { id: el.dataset.nodeId, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
            }
          }
          return null
        })()`)
        check('★ 找得到一个「还没汇聚过」的第二个节点（否则本用例无效）',
          pick2 != null, `pick=${pick.id} 已汇聚伙伴=${JSON.stringify(partners)}`)
        if (pick2) {
          const n0 = (await renderedIds()).length
          await realClick(pick2.cx, pick2.cy)
          await sleep(700)
          check('★ 移动端点第二个节点完成汇聚（节点数 +1）',
            (await renderedIds()).length === n0 + 1,
            `${n0} → ${(await renderedIds()).length}（pick=${pick.id} pick2=${pick2.id}）`)
          check('★ 移动端汇聚后提示条消失', (await linkHint()) === null)
          // 收掉改名框，别影响后续
          await evaluate(`(() => {
            const i = document.querySelector('[data-rename-input]')
            if (i) i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
            return true
          })()`)
        }
      }
    }
  }

  /* ================================================================== */
  console.log('\n[15] 无 console 报错')
  /* ================================================================== */

  {
    const real = consoleErrors.filter((e) => !/favicon|ERR_/.test(e))
    check('整个过程没有 console 报错', real.length === 0, JSON.stringify(real.slice(0, 4)))
  }

  console.log('\n====================================================')
  console.log(`  汇聚关系 relatebrowser  通过 ${pass} / 失败 ${fail}`)
  console.log('====================================================')

  cdp.close()
  try { proc.kill() } catch { /* ignore */ }
  if (fail) process.exit(1)
}

/* ------------------------------------------------------------------ */
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


