/**
 * PDF 打印排版自检（导图本体 + 各节点的流程图）
 * 用法：node src/lib/printLayout.test.mjs
 *
 * 【这个文件在测什么】
 * 需求（用户原话）：「只导出思维导图和他里面的流程图就行，其他乱七八糟的东西不要」。
 * 于是排版要同时满足三件事：
 *   1. 印出来的是**画布上那张导图本身**（节点位置、树边、汇聚连线都和屏幕上一致）；
 *   2. 每个折角的流程图放在**它所属节点那条分支的正下方**，且不压任何连线/节点；
 *   3. 没有页眉、页码、序号、「已打开 N 次」、占位文字、折角角标。
 *
 * 全是纯函数断言 —— 不启动浏览器、不渲染 mermaid，所以每条都是确定的数值关系。
 */
import { layoutTree, NODE_H, GAP_Y, PAD } from './layout.js'
import {
  printLayout, buildPrintHtml, paginate, printPages, printScale, maxCoveredRun,
  chartSize, viewBoxOf, normalizeSvg,
  PAGE, CHART_W, CHART_RATIO, CHART_GAP, CHART_MAX_W, CHART_MAX_H,
  MIN_ZOOM, MAX_ZOOM, WHEEL_STEP, TRACKPAD_WHEEL_STEP, ZOOM_BTN_FACTOR,
  PRINT_SCALE1_STYLE, worldTransformStyles, countPages,
} from './printLayout.js'
import { makeNode } from './model.js'
import vm from 'node:vm'

let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (msg) => console.log(`  · ${msg}`)

const svgOf = (w, h, inner = '<rect width="10" height="10"/>') =>
  `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * 「这条分支上最后一个盒子」在哪里 —— 这是图的落点基准。
 *
 * 关键：**后代自己的流程图也算盒子**。它贴在它自己那条分支的末尾、还会往
 * 下一个兄弟的间距里探出去一点；漏掉它，父节点的图就会算高 22px 而压住下一个兄弟。
 * 返回 { before, after }：before = 不含本节点自己那张图的底部，after = 含。
 */
function subtreeBottom(L) {
  const kids = new Map()
  for (const e of L.edges) {
    if (!kids.has(e.from)) kids.set(e.from, [])
    kids.get(e.from).push(e.to)
  }
  const chartById = new Map(L.charts.map((c) => [c.id, c]))
  const before = new Map()
  const after = new Map()
  const go = (id) => {
    if (before.has(id)) return after.get(id)
    const n = L.byId.get(id)
    let bottom = n ? n.y + n.h : 0
    for (const c of kids.get(id) || []) bottom = Math.max(bottom, go(c))
    before.set(id, bottom)
    const ch = chartById.get(id)
    const out = ch ? Math.max(bottom, ch.y + ch.h) : bottom
    after.set(id, out)
    return out
  }
  for (const n of L.nodes) go(n.id)
  return { before, after }
}

const countOf = (s, re) => (s.match(re) || []).length

/* ================================================================== */
console.log('\n[1] 量 SVG 的宽高比')

{
  const vb = viewBoxOf(svgOf(400, 300))
  check('从 viewBox 读出宽高', vb.w === 400 && vb.h === 300, JSON.stringify(vb))

  const comma = viewBoxOf('<svg viewBox="0,0, 200 100 "></svg>')
  check('viewBox 里的逗号和多余空格也能读', comma.w === 200 && comma.h === 100, JSON.stringify(comma))

  const attrOnly = viewBoxOf('<svg width="300" height="150"></svg>')
  check('没有 viewBox 时退到 width/height 属性', attrOnly.w === 300 && attrOnly.h === 150,
    JSON.stringify(attrOnly))

  const pct = viewBoxOf('<svg width="100%" height="100%"></svg>')
  check('width="100%" 这种百分比不算数（否则高度会算成 0）', pct.w === 0 && pct.h === 0)

  const nothing = viewBoxOf('<svg><g/></svg>')
  const fallback = chartSize('<svg><g/></svg>')
  check('完全量不出来时才用兜底盒子（320 × 0.62）',
    nothing.w === 0 && fallback.w === CHART_W && Math.abs(fallback.h - CHART_W * CHART_RATIO) < 1e-9,
    `${fallback.w}×${fallback.h}`)

  const box = chartSize(svgOf(400, 300))
  check('图按**原生尺寸**画：400×300 就是 400×300（不再被塞进 320 宽）',
    box.w === 400 && box.h === 300, `${box.w}×${box.h}`)
  check('比一页小的图**不放大**（放大只会让图里的字比导图大好几倍）',
    chartSize(svgOf(120, 80)).w === 120 && chartSize(svgOf(120, 80)).h === 80)
  check('比一页宽的图缩到一页宽、长宽比不变',
    Math.abs(chartSize(svgOf(4000, 500)).w - CHART_MAX_W) < 1e-9
    && Math.abs(chartSize(svgOf(4000, 500)).w / chartSize(svgOf(4000, 500)).h - 8) < 1e-9,
    `${chartSize(svgOf(4000, 500)).w.toFixed(1)}×${chartSize(svgOf(4000, 500)).h.toFixed(1)}`)
  check('比一页高的图缩到一页高、长宽比不变',
    Math.abs(chartSize(svgOf(200, 4000)).h - CHART_MAX_H) < 1e-9
    && Math.abs(chartSize(svgOf(200, 4000)).w / chartSize(svgOf(200, 4000)).h - 0.05) < 1e-9,
    `${chartSize(svgOf(200, 4000)).w.toFixed(1)}×${chartSize(svgOf(200, 4000)).h.toFixed(1)}`)
}

/* ================================================================== */
/*
 * 这一节是补上来的回归：用户报「保存的 PDF 里线条和文字好多都没有了」。
 *
 * 病根不在 PDF，在 chartSize：盒子宽度被写死成 320，等于把图硬塞进 320px，
 * 缩放比例 = 320 / viewBox 宽。横着排开的流程图 viewBox 很宽（8 个节点就 1120），
 * 于是图里的内容被缩到 0.29 倍：14px 的字 → 3.9pt，1px 的线 → 0.21pt。
 * 0.21pt 的线在 PDF 里根本画不出来 —— 屏幕上靠抗锯齿还看得见，纸上直接消失。
 *
 * 所以这里断言的不是「盒子有宽度」这种存在性，而是**比例关系**：
 * 盒子相对 viewBox 的缩放，不能比「一页宽」这个物理上限差多少。
 * 旧实现下 1120 宽的那一行会得到 0.286，直接失败。
 */
console.log('\n[1b] 流程图不能比导图小一个数量级（用户报的「线条文字都没了」）')

{
  // mermaid 真实量出来的 viewBox（宽 × 高），不是编的
  const cases = [
    ['窄 TD（3 节点链）', 128, 256],
    ['宽 LR（8 节点一排）', 1120, 64],
    ['宽 LR（16 节点一排）', 2231.875, 64],
    ['高 TD（12 层）', 114.765625, 1120],
    ['2D（4×4）', 558.75, 352],
  ]
  for (const [name, w, h] of cases) {
    const sz = chartSize(svgOf(w, h))
    const k = sz.w / w
    // 一页宽是物理上限：能到多少就到多少，但绝不能比它更小
    const best = Math.min(1, CHART_MAX_W / w, CHART_MAX_H / h)
    check(`${name}：缩放 ${k.toFixed(3)} 已达物理上限（不再被 320 卡住）`,
      Math.abs(k - best) < 1e-9, `k=${k.toFixed(3)} 上限=${best.toFixed(3)}`)
    check(`${name}：盒子长宽比 = viewBox 长宽比（比例不一致会让 meet 再缩一次）`,
      Math.abs(sz.w / sz.h - w / h) < 1e-9)
  }

  // 最要命的那一条：横排流程图的字在纸上还剩多少
  const pt = (w, h) => 14 * (chartSize(svgOf(w, h)).w / w) * 0.75
  note(`8 节点横排的字：${pt(1120, 64).toFixed(1)}pt（旧实现 3.9pt）`
    + ` · 16 节点横排：${pt(2231.875, 64).toFixed(1)}pt（旧实现 1.9pt）`
    + ` · 2D 4×4：${pt(558.75, 352).toFixed(1)}pt（旧实现 7.7pt）`)
  check('横排 8 个节点的流程图，字在纸上还有 9pt 以上（旧实现 3.9pt，等于没印）',
    pt(1120, 64) >= 9, `${pt(1120, 64).toFixed(1)}pt`)
  check('横排 16 个节点时被一页宽卡住，但仍然远好于旧实现',
    pt(2231.875, 64) >= 4.5, `${pt(2231.875, 64).toFixed(1)}pt`)
  check('线宽也跟着回来（1px 的线在纸上至少 0.3pt）',
    1 * (chartSize(svgOf(1120, 64)).w / 1120) * 0.75 >= 0.3,
    `${(1 * (chartSize(svgOf(1120, 64)).w / 1120) * 0.75).toFixed(2)}pt`)
}

/* ================================================================== */
console.log('\n[2] 规整 mermaid 的 SVG')

{
  const raw = svgOf(400, 300)
  const out = normalizeSvg(raw)
  const rootTag = out.slice(out.indexOf('<svg'), out.indexOf('>', out.indexOf('<svg')) + 1)
  check('根标签上的 width 被去掉', !/\swidth\s*=/.test(rootTag), rootTag)
  check('根标签上的 style 被去掉（mermaid 会写 max-width，内联样式会卡住缩放）',
    !/style\s*=/.test(rootTag), rootTag)
  check('viewBox 必须留着（缩放的依据）', /viewBox="0 0 400 300"/.test(rootTag))
  check('xmlns 等其他属性不动', /xmlns=/.test(rootTag))
  check('图内部的元素一个字节都没改（<rect width="10"> 还在）',
    out.includes('<rect width="10" height="10"/>'), out)
  check('没有 <svg 时原样返回', normalizeSvg('nothing here') === 'nothing here')
}

/* ================================================================== */
console.log('\n[3] 图放在「所属节点那条分支的正下方」')

{
  //  root
  //    ├ a(折角)
  //    ├ b
  //    └ c(折角) → d
  const root = makeNode('根')
  const a = makeNode('甲')
  const b = makeNode('乙')
  const c = makeNode('丙')
  const d = makeNode('丁')
  root.children = [a, b, c]
  c.children = [d]

  const charts = [
    { id: a.id, svg: svgOf(400, 300) },
    { id: c.id, svg: svgOf(300, 200) },
  ]
  const L = printLayout(root, { charts })
  const A = L.byId.get(a.id)
  const C = L.byId.get(c.id)
  const D = L.byId.get(d.id)
  const ca = L.charts.find((x) => x.id === a.id)
  const cc = L.charts.find((x) => x.id === c.id)

  check('两张折角各得一张图', L.charts.length === 2, `${L.charts.length}`)
  check('图的左边缘与节点对齐（和整张图的列对齐方式一致）',
    ca.x === A.x && cc.x === C.x, `${ca.x}/${A.x} ${cc.x}/${C.x}`)
  check('叶子的图紧跟在它自己下方', ca.y === A.y + A.h + CHART_GAP,
    `${ca.y} vs ${A.y + A.h + CHART_GAP}`)
  check('有子树的节点：图在**整条分支**的下方，而不是插在子节点中间',
    cc.y === D.y + D.h + CHART_GAP, `${cc.y} vs ${D.y + D.h + CHART_GAP}`)
  check('图的高度就是原生高度（4:3 → 300，3:2 → 200；不再被抬/压到 90~400）',
    ca.h === 300 && cc.h === 200, `${ca.h}/${cc.h}`)
  const boxes = L.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))
  check('没有任何一张图压在任何节点上',
    !L.charts.some((ch) => boxes.some((bx) => overlap(ch, bx))))
  check('两张图之间也不重叠', !overlap(ca, cc))

  // 引线：从节点底边中点竖直向下，落在图的顶边上
  const { html } = buildPrintHtml({ name: 'x', layout: L })
  const leader = new RegExp(
    `<line class="mf-print-leader" x1="${A.x + A.w / 2}" y1="${A.y + A.h}" x2="${A.x + A.w / 2}" y2="${ca.y}"`)
  check('引线是从节点底边中点竖直下来的一条线', leader.test(html), html.match(/mf-print-leader[^/]*/)?.[0])
  check('每个折角一条引线（每页里「引线数 = 图数」）',
    countOf(html, /class="mf-print-leader"/g) === countOf(html, /class="mf-print-chart"/g)
    && countOf(html, /class="mf-print-chart"/g) >= 2,
    `${countOf(html, /class="mf-print-leader"/g)} 条引线 / ${countOf(html, /class="mf-print-chart"/g)} 张图`)
  check('引线的横坐标落在图的横向范围内（线头落在图上，不会悬空）',
    A.x + A.w / 2 >= ca.x && A.x + A.w / 2 <= ca.x + ca.w)
}

/* ================================================================== */
console.log('\n[4] 流程图只加垂直空间，绝不挪动整张图的横向布局')

{
  const root = makeNode('根')
  const kids = ['甲', '乙', '丙'].map((t) => makeNode(t))
  root.children = kids
  kids[2].children = [makeNode('丁')]

  const plain = layoutTree(root, {})
  const noChart = printLayout(root, { charts: [] })
  check('没有折角时，排版与画布布局**逐位相同**',
    noChart.nodes.every((n) => {
      const p = plain.byId.get(n.id)
      return p && p.x === n.x && p.y === n.y && p.w === n.w
    }))
  check('没有折角时画布布局也不受影响（bandExtra 默认 0）',
    plain.nodes.every((n) => n.y === noChart.byId.get(n.id).y))

  const withChart = printLayout(root, { charts: [{ id: kids[0].id, svg: svgOf(400, 300) }] })
  check('加图之后每个节点的 x 一个都没变（图只吃垂直空间）',
    withChart.nodes.every((n) => n.x === plain.byId.get(n.id).x),
    withChart.nodes.map((n) => `${n.node.text}:${n.x}/${plain.byId.get(n.id).x}`).join(' '))

  const extra = 300 + CHART_GAP
  const yOf = (L, id) => L.byId.get(id).y
  check('折角节点自己的 y 不动（图的空间加在子树末尾，不是加在节点身上）',
    yOf(withChart, kids[0].id) === yOf(plain, kids[0].id))
  check('它下面的兄弟整体下移「图高 + 空隙」',
    Math.abs(yOf(withChart, kids[1].id) - yOf(plain, kids[1].id) - extra) < 0.001,
    `${yOf(withChart, kids[1].id) - yOf(plain, kids[1].id)} vs ${extra}`)
  check('父节点仍然是「垂直居中于自己的子树」（下移一半，不是整段）',
    Math.abs(yOf(withChart, root.id) - yOf(plain, root.id) - extra / 2) < 0.001,
    `${yOf(withChart, root.id) - yOf(plain, root.id)} vs ${extra / 2}`)
}

/* ================================================================== */
console.log('\n[5] 折叠起来的折角不印图（屏幕上没显示的就不印）')

{
  const root = makeNode('根')
  const p = makeNode('父')
  const kid = makeNode('子')
  root.children = [p]
  p.children = [kid]

  const open = printLayout(root, { charts: [{ id: kid.id, svg: svgOf(400, 300) }] })
  check('展开时图在', open.charts.length === 1)

  p.collapsed = true
  const folded = printLayout(root, { charts: [{ id: kid.id, svg: svgOf(400, 300) }] })
  check('折叠后布局里没有这个节点，图也跟着消失', folded.charts.length === 0)
  check('也不会留下一个空框', !folded.boxes.some((b) => b.h > NODE_H + 1 && b.w > 200))
  check('折叠后画布高度回到原样', folded.height === layoutTree(root, {}).height)
}

/* ================================================================== */
console.log('\n[6] 汇聚连线：和画布同一套判据')

{
  const root = makeNode('根')
  const a = makeNode('甲')
  const b = makeNode('乙')
  const c = makeNode('丙')
  root.children = [a, b, c]
  const relations = [
    { from: a.id, to: c.id },
    { from: b.id, to: c.id },
    { from: a.id, to: a.id },        // 自环：丢掉
    { from: 'ghost', to: c.id },     // 悬空：丢掉
  ]
  const L = printLayout(root, { relations, charts: [] })
  check('只留下画得出来的两条汇聚边', L.relationEdges.length === 2, `${L.relationEdges.length}`)
  check('自环被丢掉', !L.relationEdges.some((r) => r.from === r.to))
  check('悬空端点被丢掉', !L.relationEdges.some((r) => r.from === 'ghost'))
  check('汇聚结果节点的树边被标记为隐藏（否则会多出一条凭空来的线）',
    L.hiddenTreeTo.has(c.id) && L.hiddenTreeTo.size === 1)

  const { html } = buildPrintHtml({ name: 'x', layout: L })
  check('打印视图里确实没有指向汇聚结果的树边',
    !html.includes(`data-edge="${a.id}&gt;${c.id}"`) && !html.includes(`data-edge="${b.id}&gt;${c.id}"`),
    '仍能找到指向 C 的树边')
  check('普通树边照旧印（根→甲、根→乙）',
    html.includes(`data-edge="${root.id}&gt;${a.id}"`) && html.includes(`data-edge="${root.id}&gt;${b.id}"`))
  check('两条汇聚边都印了，且带箭头', countOf(html, /data-rel=/g) === 2 && countOf(html, /marker-end=/g) === 2)
  check('树边不带箭头（与画布一致）', countOf(html, /mf-print-edge" data-edge/g) === countOf(html, /class="mf-print-edge" data-edge/g))
}

/* ================================================================== */
console.log('\n[7] 带流程图的汇聚节点不搬进通道（否则预留的那块空间就白留了）')

{
  //  root → 甲、乙、丙，甲→丙、乙→丙（丙是汇聚结果，且没有子节点 = 可搬）
  const root = makeNode('根')
  const a = makeNode('甲')
  const b = makeNode('乙')
  const c = makeNode('丙')
  root.children = [a, b, c]
  const relations = [{ from: a.id, to: c.id }, { from: b.id, to: c.id }]

  const plain = layoutTree(root, {})
  const canvas = layoutTree(root, { relations })
  const locked = layoutTree(root, { relations, lockIds: new Set([c.id]) })

  check('画布行为：不锁时丙被搬进通道、并垂直居中到甲、乙中间',
    Math.abs((canvas.byId.get(c.id).y + canvas.byId.get(c.id).h / 2)
      - (canvas.byId.get(a.id).y + canvas.byId.get(b.id).y) / 2 - NODE_H / 2) < 0.001,
    `cy=${canvas.byId.get(c.id).y + NODE_H / 2}`)
  check('锁住之后丙留在树的原位（x、y 都与无汇聚时一致）',
    locked.byId.get(c.id).x === plain.byId.get(c.id).x
    && locked.byId.get(c.id).y === plain.byId.get(c.id).y)
  check('不传 lockIds 时这个开关完全不存在（画布代码路径一个字没变）',
    canvas.byId.get(c.id).x !== plain.byId.get(c.id).x)

  const L = printLayout(root, { relations, charts: [{ id: c.id, svg: svgOf(400, 300) }] })
  const C = L.byId.get(c.id)
  const chart = L.charts[0]
  check('图稳稳贴在丙下面，不需要兜底', chart.y === C.y + C.h + CHART_GAP,
    `${chart.y} vs ${C.y + C.h + CHART_GAP}`)
  check('图不与任何节点重叠',
    !L.nodes.some((n) => overlap(chart, n)))
}

/* ================================================================== */
console.log('\n[8] 分页：不许把节点/图从中间劈开')

{
  const boxes = [
    { x: 0, y: 0, w: 100, h: 34 },
    { x: 0, y: 200, w: 100, h: 34 },
    { x: 0, y: 400, w: 300, h: 240 },
    { x: 0, y: 700, w: 100, h: 34 },
  ]
  const pages = paginate(boxes, 500, 800)
  check('切成多页', pages.length >= 2, `${pages.length} 页`)
  check('第一页从 0 开始', pages[0].top === 0)
  check('页与页首尾相接、不重不漏',
    pages.every((p, i) => i === 0 || Math.abs(p.top - (pages[i - 1].top + pages[i - 1].height)) < 0.001))
  check('最后一页正好收在总高度上',
    Math.abs(pages[pages.length - 1].top + pages[pages.length - 1].height - 800) < 0.001)
  check('每页都不超过一页高度', pages.every((p) => p.height <= 500 + 0.001),
    pages.map((p) => p.height).join(','))
  check('没有任何盒子横跨切点',
    pages.slice(1).every((p) => !boxes.some((b) => p.top > b.y + 0.5 && p.top < b.y + b.h - 0.5)),
    pages.map((p) => p.top).join(','))

  const tall = [{ x: 0, y: 0, w: 10, h: 900 }, { x: 0, y: 900, w: 10, h: 10 }]
  const forced = paginate(tall, 400, 910)
  check('单个盒子比一页还高时被迫从中间切，但不会死循环 / 丢内容',
    forced.length >= 3 && Math.abs(forced[forced.length - 1].top + forced[forced.length - 1].height - 910) < 0.001,
    `${forced.length} 页`)

  check('退化输入（页高为 0）也返回一页而不是空数组',
    paginate(boxes, 0, 800).length === 1)
}

/* ================================================================== */
console.log('\n[9] 打印视图里只有导图和流程图')

{
  const root = makeNode('根 <b>&"引号"')
  const a = makeNode('甲')
  const b = makeNode('乙')
  root.children = [a, b]
  const L = printLayout(root, { charts: [{ id: a.id, svg: svgOf(400, 300) }] })
  const built = buildPrintHtml({ name: '我的<导图>', layout: L })
  const { html } = built

  check('A4 横向（导图是横向生长的）', /@page\{size:A4 landscape;margin:10mm\}/.test(html))
  check('强制纯白背景', /background:#fff/.test(html))
  check('页数 = 生成时报告的页数', countOf(html, /<section class="page"/g) === built.pageCount,
    `${countOf(html, /<section class="page"/g)} vs ${built.pageCount}`)
  check('每个节点都印出来了（所有页合起来 = 全部节点）', (() => {
    const seen = new Set((html.match(/data-node-id="[^"]+"/g) || []).map((s) => s.slice(14, -1)))
    return L.nodes.every((n) => seen.has(n.id)) && seen.size === L.nodes.length
  })(), `${countOf(html, /data-node-id=/g)} 个`)
  check('每张图都印出来了', countOf(html, /class="mf-print-chart"/g) >= 1
    && html.includes(`data-chart-for="${a.id}"`))
  check('图内联在页面里（不是外链）', html.includes('<rect width="10" height="10"/>'))

  console.log('  ── 不该出现的东西 ──')
  check('没有页眉标题', !/class="ph"/.test(html))
  check('没有「折角知识点列表」这种副标题', !html.includes('折角知识点'))
  check('没有序号 01/02', !/class="idx"/.test(html) && !/>0\d</.test(html))
  check('没有「已打开 N 次」', !html.includes('已打开') && !/class="cnt"/.test(html))
  check('没有「无流程图」占位', !html.includes('无流程图'))
  check('没有折角角标（圆点/数字圈）', !html.includes('data-fold-badge') && !/class="badge/.test(html))
  check('没有旧版的列表行', !/class="row"/.test(html) && !/class="right"/.test(html))
  check('没有页码/页脚', !/page-number|页码/.test(html))

  console.log('  ── 安全性 / 独立性 ──')
  check('节点文字被转义（<b> 不会变成真标签）',
    html.includes('&lt;b&gt;&amp;&quot;引号&quot;') && !html.includes('<b>&'))
  check('文档名被转义进 <title>', html.includes('<title>我的&lt;导图&gt;</title>'))
  check('没有任何外部引用（断网也能打印）',
    !/<script[^>]+src=/i.test(html) && !/<link[^>]+stylesheet/i.test(html) && !/@import/.test(html))

  /*
   * 触发打印的方式：默认**不能**自动弹对话框。
   * 浏览器里没有「直接生成 PDF 文件」的接口，唯一的出口是打印对话框里的
   * 「另存为 PDF」。如果一打开预览页就自动唤起它，对话框会盖住页面、抢走焦点，
   * 用户看不到自己印的是什么就被要求确认。所以默认挂一个按钮由用户点。
   */
  console.log('  ── 谁来触发打印 ──')
  const auto = buildPrintHtml({ name: 'x', layout: L, autoPrint: true }).html
  check('默认不自动弹打印对话框（不抢焦点、不盖住刚打开的预览）',
    !/window\.onload/.test(html) && !/setTimeout\([^)]*print/.test(html))
  check('预览页上有一颗手动打印按钮（导出这条路是通的，不是死胡同）',
    /<button type="button" class="mf-print-fab"[^>]*onclick="window\.print\(\)"/.test(html))
  /*
   * 用户原话：「保存或打印搞一个按钮就行了，放在右上角，字去掉，保持干净」。
   * 所以按钮里**只许有图标**：把 <svg> 整段抠掉之后，剩下的必须一个可见字符都没有。
   */
  const fabHtml = (/<button[^>]*class="mf-print-fab"[^>]*>([\s\S]*?)<\/button>/.exec(html) || [])[1] || ''
  check('按钮里只有图标、没有任何可见文字（「字去掉，保持干净」）',
    /<svg/.test(fabHtml) && fabHtml.replace(/<svg[\s\S]*?<\/svg>/g, '').trim() === '',
    JSON.stringify(fabHtml.slice(0, 70)))
  check('旧的顶部工具栏已经拆掉（提示文字、页数统计都不在页面上）',
    !/mf-print-bar/.test(html) && !html.includes('另存为 PDF'))
  check('按钮带 title / aria-label：字看不见，但悬停和读屏还能知道它是干什么的',
    /title="打印 \/ 保存为 PDF"/.test(html) && /aria-label="打印 \/ 保存为 PDF"/.test(html))
  /*
   * 右上角的位置必须带上安全区：刘海屏 / 挖孔屏上写死 12px 会落到状态栏底下，
   * 按钮被切掉一半。桌面浏览器里 env() 取不到值、回退 0px —— 还是 12px，
   * 所以这条断言同时锁住「手机不被刘海切」和「桌面位置没变」。
   */
  check('按钮钉在右上角（并避开刘海安全区）',
    /\.mf-print-fab\{position:fixed;top:calc\(12px \+ env\(safe-area-inset-top,0px\)\);right:calc\(12px \+ env\(safe-area-inset-right,0px\)\)/.test(html))
  check('按钮只在屏幕上出现，打印时隐藏（纸上每页多一颗按钮就是每页一块脏东西）',
    /@media print\{[\s\S]*?\.mf-print-fab\{display:none!important\}/.test(html))
  /*
   * 触摸设备热区 44×44（WCAG 建议值）。这一颗是整页唯一的操作入口，
   * 点不中就什么都干不了；36px 对拇指偏小。用 pointer:coarse 而不是宽度断点 ——
   * 手机横屏也有 852px 宽，但点它的依然是手指。
   */
  check('触摸设备上热区放大到 44×44（这颗按钮是整页唯一的入口）',
    /@media \(pointer:coarse\)\{\.mf-print-fab\{width:44px;height:44px\}\}/.test(html))
  check('按钮不参与排版：全篇没有任何 body 让位内边距（压住第一页的耦合消失了）',
    !/padding-top/.test(html), (html.match(/padding-top[^;}]*/) || ['(无)'])[0])
  /*
   * viewport：手机浏览器/手机端打开这一页时的两条兜底 ——
   * 有 width=device-width 才不会被当成 980px 的桌面页压成一小块；
   * 且**不能**带 user-scalable=no（页宽 1047px，禁掉缩放就没法核对版面了）。
   */
  check('带 viewport meta（手机按设备宽度渲染，不被压成 980px 的小图）',
    /<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">/.test(html))
  check('viewport 不禁用缩放（277mm 宽的版心在手机上必须能双指放大核对）',
    !/user-scalable=no/.test(html) && !/maximum-scale/.test(html))
  check('autoPrint=true 时才注入自动打印（一键直出这条路仍然可用）',
    /window\.onload=function\(\)\{setTimeout\(function\(\)\{window\.print\(\)\},400\)\}/.test(auto))
  check('autoPrint=true 时不挂按钮（没人会去点）', !/class="mf-print-fab"/.test(auto))
}

/* ================================================================== */
console.log('\n[10] 真实布局分页 + 缩放')

{
  const root = makeNode('根')
  const all = [root]
  for (let i = 0; i < 40; i++) {
    const p = all[i % all.length]
    const n = makeNode('节点' + i)
    p.children.push(n)
    all.push(n)
  }
  const charts = all.filter((_, i) => i % 5 === 0).map((n) => ({ id: n.id, svg: svgOf(400, 300) }))
  const L = printLayout(root, { charts })
  const { scale, pageWorldH, pages } = printPages(L)

  note(`图 ${Math.round(L.width)}×${Math.round(L.height)}px，缩放 ${scale.toFixed(3)}，${pages.length} 页`)
  check('不放大（小图不会被硬撑到版心宽度，白白多出几页空白）', scale <= 1 + 1e-9)
  check('缩放后宽度塞得进版心', L.width * scale <= PAGE.contentW + 0.5,
    `${(L.width * scale).toFixed(1)} vs ${PAGE.contentW.toFixed(1)}`)
  check('每页的世界高度 = 版心高 / 缩放', Math.abs(pageWorldH - PAGE.contentH / scale) < 1e-6)
  check('没有任何盒子横跨切点',
    pages.slice(1).every((p) => !L.boxes.some((b) => p.top > b.y + 0.5 && p.top < b.y + b.h - 0.5)))
  check('所有盒子都落在某一页里', L.boxes.every((b) => pages.some((p) => b.y >= p.top - 0.5 && b.y + b.h <= p.top + p.height + 0.5)))
  check('每页不超过一页世界高度', pages.every((p) => p.height <= pageWorldH + 0.001))
  check('版心像素与 mm 定义一致（打印时 1in = 96px，不能错）',
    Math.abs(PAGE.contentW - (PAGE.wMm - 2 * PAGE.marginMm) * 96 / 25.4) < 1e-9)
  check('printScale 的下限兜住超宽的图（不会缩到 0）', printScale({ width: 1e6 }) >= 0.1)
}

/* ================================================================== */
console.log('\n[11] 随机图模糊测试（性质而不是个例）')

{
  const rng = (seed) => {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  }
  const ratios = [[400, 300], [600, 200], [200, 600], [1000, 120], [300, 900], [400, 300]]

  let cases = 0
  let chartTotal = 0
  let pushed = 0
  const bad = { overlapNode: [], overlapChart: [], pos: [], x: [], page: [], nan: [] }

  for (let seed = 1; seed <= 120; seed++) {
    const rnd = rng(seed * 2654435761)
    const root = makeNode('r')
    const all = [root]
    const want = 4 + Math.floor(rnd() * 16)
    let guard = 0
    while (all.length < want && guard++ < 500) {
      const p = all[Math.floor(rnd() * all.length)]
      if (p.children.length >= 4) continue
      const n = makeNode('n' + all.length)
      p.children.push(n)
      all.push(n)
    }

    // 随机给一部分节点挂折角（有的故意给空 SVG：渲染失败不该占位置）
    const charts = []
    for (const n of all) {
      if (rnd() > 0.35) continue
      if (rnd() < 0.12) charts.push({ id: n.id, svg: '' })
      else {
        const [w, h] = ratios[Math.floor(rnd() * ratios.length)]
        charts.push({ id: n.id, svg: svgOf(w, h) })
      }
    }

    const rels = []
    for (let i = 0; i < Math.floor(rnd() * 10); i++) {
      const a = all[Math.floor(rnd() * all.length)]
      const b = all[Math.floor(rnd() * all.length)]
      rels.push(rnd() < 0.1 ? { from: a.id, to: a.id } : { from: a.id, to: b.id })
    }
    // 保证真的出现汇聚
    if (rnd() < 0.7) {
      const sink = all[Math.floor(rnd() * all.length)]
      const k = 2 + Math.floor(rnd() * 3)
      for (let i = 0; i < k; i++) {
        const src = all[Math.floor(rnd() * all.length)]
        if (src.id !== sink.id) rels.push({ from: src.id, to: sink.id })
      }
    }

    const L = printLayout(root, { relations: rels, charts })
    const tag = `seed=${seed}(${all.length}节点/${L.charts.length}图/${rels.length}关系)`
    cases++
    chartTotal += L.charts.length

    const { before } = subtreeBottom(L)
    const nodeBoxes = L.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))
    for (const c of L.charts) {
      if (![c.x, c.y, c.w, c.h].every(Number.isFinite)) { bad.nan.push(tag); continue }
      if (nodeBoxes.some((b) => overlap(c, b))) bad.overlapNode.push(tag)
      if (L.charts.filter((o) => o !== c).some((o) => overlap(c, o))) bad.overlapChart.push(tag)
      /*
       * 图的横向位置：**和节点左边缘严格对齐，一动不动**。
       *
       * 这一条是刻意锁死的。中途试过「把过宽的图往左挪回来，免得它把导图撑宽」，
       * 结果撞上了一个不显然的事实：父节点是垂直居中于自己子树跨度摆的，
       * 纵向上可能正好落在某个子节点的区间里 —— 图往左挪进父节点那一列就会撞上它，
       * 兜底的 pushDown 于是把图往下顶，再连锁顶走后面的图。实测 29% 的图被下移、
       * 中位 304px。所以宁可让导图等比缩小，也不许图乱跑。
       * （图当然可以把导图撑宽 —— 那是它按原生尺寸画的代价，见下面的下移率守门员。）
       */
      const node = L.byId.get(c.id)
      if (Math.abs(c.x - node.x) > 1e-9) bad.pos.push(tag + ` 图的 x=${c.x} 与节点 x=${node.x} 不一致`)
      if (c.x < 0) bad.pos.push(tag + ' 图跑到画布左边了')
    }
    for (const c of L.charts) {
      const want = before.get(c.id) + CHART_GAP
      if (c.y <= want + 0.001) {
        // 没被兜底下移：位置必须**精确**等于规则算出来的那个值
        if (!rels.length && Math.abs(c.y - want) > 0.001) bad.pos.push(tag + ` y=${c.y} 期望=${want}`)
        continue
      }

      /*
       * 被兜底下移了。这只有在「自然位置真的会撞上东西」时才是合法的 ——
       * 否则就说明预留空间算错了（曾经真的错在这里：漏算后代流程图探出的
       * 那 22px，导致 23% 的图被顶开，而且连锁往下传）。
       */
      pushed++
      const others = [
        ...nodeBoxes,
        ...L.charts.filter((o) => o !== c).map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h })),
      ]
      if (!others.some((b) => overlap({ x: c.x, y: want, w: c.w, h: c.h }, b))) {
        bad.pos.push(tag + ` 自然位置本来是空的，却被下移 ${(c.y - want).toFixed(1)}px`)
      }
      if (!rels.length) bad.pos.push(tag + ' 没有汇聚却被下移')
    }

    /*
     * 横向布局不变这条，只能在**没有汇聚**时断言。
     * 有汇聚时 x 会动，而且这是对的：同一通道上两组汇聚点如果 y 撞了，
     * 后一组会被让到右边的子通道（x = 前一组右边缘 + GAP_X）—— 于是
     * 「图的垂直空间把 y 顶开」会间接改变这个碰撞判定，x 跟着变。
     * 那是汇聚布局的既有行为（画布上也一样），不是图造成的偏移。
     */
    if (!rels.length) {
      const plain = layoutTree(root, {})
      if (L.nodes.some((n) => n.x !== plain.byId.get(n.id).x)) bad.x.push(tag)
    }

    const { pages, pageWorldH } = printPages(L)
    const canSlice = maxCoveredRun(L.boxes) > pageWorldH + 0.001
    if (!canSlice && pages.slice(1).some((p) => L.boxes.some((b) => p.top > b.y + 0.5 && p.top < b.y + b.h - 0.5))) {
      bad.page.push(tag)
    }
    if (pages.slice(1).some((p) => p.top <= 0 || p.height <= 0)) bad.page.push(tag + ' 空页')
  }

  note(`${cases} 张随机图，共 ${chartTotal} 张流程图；其中 ${pushed} 张因为汇聚重排让位`
    + `（${(pushed / chartTotal * 100).toFixed(1)}%）`)
  check('覆盖到了足够多的折角（否则体检是空跑）', chartTotal >= 120, `${chartTotal}`)
  check('所有坐标都是有限数（没有 NaN 漏出去）', bad.nan.length === 0, bad.nan.slice(0, 3).join(' '))
  check('没有任何流程图压在任何节点上', bad.overlapNode.length === 0, bad.overlapNode.slice(0, 3).join(' '))
  check('没有任何两张流程图互相压住', bad.overlapChart.length === 0, bad.overlapChart.slice(0, 3).join(' '))
  check('图始终紧跟在所属分支的正下方（左边缘对齐；没有汇聚时位置必须精确）',
    bad.pos.length === 0, bad.pos.slice(0, 3).join(' '))
  check('兜底下移只在「自然位置真的会撞」时发生（不掩盖预留算错）',
    !bad.pos.some((s) => s.includes('本来是空的')), bad.pos.filter((s) => s.includes('本来是空的')).slice(0, 2).join(' '))
  /*
   * 兜底下移的**比例**也是一条不变量，不能只看「每次下移都有理由」。
   *
   * 这一条是给一种很诱人的改动当守门员的：把过宽的流程图往左挪回一页之内，
   * 好让导图保住原来的缩放。试过，代价是 29% 的图被连锁顶开（中位 304px）——
   * 因为父节点垂直居中于子树跨度，纵向上会落在子节点的区间里，图一挪过去就撞父节点。
   * 「每次下移都有理由」照样全绿，只有比例能看出来出事了。
   */
  check('兜底下移率保持很低（≤15%）：横向挪图会把它顶到 29%，这条专治那种改动',
    pushed / chartTotal <= 0.15, `${pushed}/${chartTotal} = ${(pushed / chartTotal * 100).toFixed(1)}%`)
  check('加图绝不改变任何节点的 x（横向布局与画布逐位一致）',
    bad.x.length === 0, bad.x.slice(0, 3).join(' '))
  check('随机图下也没有盒子被页边界劈开', bad.page.length === 0, bad.page.slice(0, 3).join(' '))
}

/* ================================================================== */
/*
 * 预览页的滚轮缩放（用户原话：「打印之后会出现一个预览界面，滚轮键还是不能
 * 放大和缩小，它是上下滚轮」）。
 *
 * 这一节要同时锁住两件互相拉扯的事：
 *   · 滚轮真的能缩放（还要以光标为锚点、有上下限）；
 *   · **打印版面一个字都不能变** —— 缩放只活在屏幕上，@media print 里必须中和。
 */
console.log('\n[12] 预览页滚轮缩放：只作用在屏幕上，默认外观逐字节不变')

{
  const root = makeNode('根')
  const a = makeNode('甲')
  const b = makeNode('乙')
  root.children = [a, b]
  const L = printLayout(root, { charts: [{ id: a.id, svg: svgOf(400, 300) }] })
  const built = buildPrintHtml({ name: 'x', layout: L })
  const { html } = built

  console.log('  ── 默认状态 ──')
  /*
   * 默认（未缩放）这一页必须和改动前**一字节都不差**。所以容器上不写
   * `zoom:1`，而是干脆没有 style 属性 —— `style="zoom:1"` 在浏览器里是
   * 「多写了一句废话」，但对「默认外观逐像素一致」这条承诺来说，它是一处
   * 真实差异（也挡住了 zoom 一旦取到非法值让整条声明作废）。
   */
  check('默认容器上没有 style 属性（没写 zoom:1 这种「无害」的废话）',
    /<div class="mf-print-pages" id="mf-pages">/.test(html))
  check('默认这一页里除了 @media print 的复位规则，没有任何生效的内联 zoom',
    (html.match(/style="zoom:/g) || []).length === 0)
  check('百分比默认显示 100%', /id="mf-pct">100%</.test(html))

  console.log('  ── 缩放的上下限（夹紧） ──')
  check('PRINT_SCALE1_STYLE(1) 返回空串（默认不加任何样式）', PRINT_SCALE1_STYLE(1) === '')
  check('PRINT_SCALE1_STYLE(0.5) 写出 zoom:0.500',
    PRINT_SCALE1_STYLE(0.5) === ' style="zoom:0.500"', PRINT_SCALE1_STYLE(0.5))
  check('缩到 0.01 被下限夹住（小于 MIN_ZOOM 的请求一律按 MIN_ZOOM 处理）',
    PRINT_SCALE1_STYLE(0.01) === ` style="zoom:${MIN_ZOOM.toFixed(3)}"`, PRINT_SCALE1_STYLE(0.01))
  check('放到 99 被上限夹住', PRINT_SCALE1_STYLE(99) === ` style="zoom:${MAX_ZOOM.toFixed(3)}"`,
    PRINT_SCALE1_STYLE(99))
  check('NaN / Infinity 不写出任何 zoom（宁可不动，也不能让整条声明作废）',
    PRINT_SCALE1_STYLE(NaN) === '' && PRINT_SCALE1_STYLE(Infinity) === '')
  check('上下限本身是合理的有限数', MIN_ZOOM > 0 && MIN_ZOOM < 1 && MAX_ZOOM > 1 && MAX_ZOOM < 20,
    `${MIN_ZOOM}~${MAX_ZOOM}`)

  console.log('  ── 滚轮缩放系数（实测数字） ──')
  /*
   * 滚轮是**乘性**的 `factor = exp(-deltaY × step)`。这里断言的是「手感」这条
   * 性质，而不是某个魔法常量：一格鼠标滚轮 deltaY≈100 必须放大十几个百分点，
   * 而触控板捏合一帧 deltaY≈4 必须明显更细 —— 后者事件密（60 次/秒），
   * 只有每事件变化率更小才叫「精细」。
   */
  const factor = (deltaY, step) => Math.exp(-deltaY * step)
  const mouseUp = factor(-100, WHEEL_STEP)
  const mouseDown = factor(100, WHEEL_STEP)
  const padUp = factor(-4, TRACKPAD_WHEEL_STEP)
  note(`鼠标一格（deltaY=100）：向上 ×${mouseUp.toFixed(3)}（+${((mouseUp - 1) * 100).toFixed(1)}%）`
    + `，向下 ×${mouseDown.toFixed(3)}（${((mouseDown - 1) * 100).toFixed(1)}%）`
    + ` · 触控板一帧（deltaY=4）：×${padUp.toFixed(3)}（+${((padUp - 1) * 100).toFixed(1)}%）`)
  check('鼠标滚轮向上 = 放大（factor > 1）', mouseUp > 1.1 && mouseUp < 1.25, mouseUp.toFixed(3))
  check('鼠标滚轮向下 = 缩小（factor < 1）', mouseDown < 0.9 && mouseDown > 0.8, mouseDown.toFixed(3))
  check('向上再向下回到原位（乘性缩放的对称性，不会累积漂移）',
    Math.abs(mouseUp * mouseDown - 1) < 1e-12)
  check('触控板每事件的变化率严格小于鼠标（这才是「更细的步长」）',
    Math.abs(padUp - 1) < Math.abs(mouseUp - 1),
    `${((padUp - 1) * 100).toFixed(1)}% < ${((mouseUp - 1) * 100).toFixed(1)}%`)
  check('触控板步长常量比鼠标那档大（deltaY 量级差一个数量级，方向是对的）',
    TRACKPAD_WHEEL_STEP > WHEEL_STEP, `${TRACKPAD_WHEEL_STEP} > ${WHEEL_STEP}`)
  check('按钮倍率是乘性的、点一下就能看出来', ZOOM_BTN_FACTOR > 1.1 && ZOOM_BTN_FACTOR < 2,
    `${ZOOM_BTN_FACTOR}`)

  console.log('  ── 缩放只给屏幕：@media print 必须复位 ──')
  check('PRINT_CSS 里有 @media print 的缩放复位规则（内联 zoom 打死普通规则，'
    + '所以这条必须带 !important）',
    /@media print\{[^]*?\.mf-print-pages\{zoom:1!important/.test(html),
    (html.match(/@media print\{[^]*?\}\}/) || ['(无)'])[0].slice(0, 200))
  check('缩放控制条只在屏幕上，打印时隐藏（纸上多一条控制条就是每页一块脏东西）',
    /\.mf-print-zoom\{display:none!important\}/.test(html))
  check('撑高占位也不参与打印（它只是给滚动条用的）',
    /\.mf-print-spacer\{display:none!important\}/.test(html))
  check('@media print 里同时也把宽度收回去（fit-content 是屏幕上的排版技巧）',
    /\.mf-print-pages\{zoom:1!important;width:auto!important\}/.test(html))

  console.log('  ── 控制条不与右上角的打印按钮打架 ──')
  check('缩放控制条放左下角（打印按钮在右上角，两侧分开放 = 结构上不可能重叠）',
    /\.mf-print-zoom\{position:fixed;left:calc\(12px \+ env\(safe-area-inset-left,0px\)\);bottom:calc\(12px \+ env\(safe-area-inset-bottom,0px\)\)/.test(html))
  check('控制条也带安全区（刘海屏 / 手势条上不会被切掉）',
    /env\(safe-area-inset-left,0px\)/.test(html) && /env\(safe-area-inset-bottom,0px\)/.test(html))
  check('滚轮被缩放占用后，页面上写清了另一条平移入口（不写没人猜得到）',
    html.includes('滚轮缩放') && html.includes('拖拽平移'))
  check('手指设备上提示语隐藏（手机上按不出「滚轮」）',
    /@media \(pointer:coarse\)\{\.mf-print-hint\{display:none\}/.test(html))
  check('触摸设备上拖拽不被浏览器手势抢走（touch-action:none 只给粗指针设备）',
    /@media \(pointer:coarse\)\{\.mf-print-pages\{touch-action:none\}\}/.test(html),
    (html.match(/@media \(pointer:coarse\)\{[^]*?\}\}/g) || ['(无)']).join(' '))
  check('没有写 user-scalable=no（手机上仍然可以双指缩放整页）',
    !/user-scalable=no/.test(html) && !/maximum-scale/.test(html))

  console.log('  ── 分页/版面没有被缩放改动破坏 ──')
  const r4 = (v) => Math.round(v * 1e4) / 1e4
  const styles = worldTransformStyles(html)
  check('每页都有一个 .world transform', styles.length === built.pageCount && styles.length >= 1,
    `${styles.length} vs ${built.pageCount}`)
  check('页数 = 生成时报告的数（缩放容器没有多算出一页）',
    countPages(html) === built.pageCount, `${countPages(html)} vs ${built.pageCount}`)
  /*
   * 最要命的一条：.world 里的 scale 是**分页算出来的**，缩放功能绝不许碰它。
   * 这里直接拿 printPages 的 scale 去比对每一页的内联 transform。
   */
  const { scale } = printPages(L)
  check('每页的 transform 里都带着分页 scale 的原值（缩放只加在容器上）',
    styles.every((s) => s.includes(`scale(${r4(scale)})`)),
    styles.map((s) => (s.match(/scale\([^)]*\)/) || [''])[0]).join(' '))
  check('缩放容器只包一层，页本身仍然是 <section class="page">（分页结构没变）',
    /<div class="mf-print-pages" id="mf-pages">\s*<section class="page" data-page="1">/.test(html))

  console.log('  ── autoPrint 那条路完全不注入脚本（一次性页面，没人会去点） ──')
  const auto = buildPrintHtml({ name: 'x', layout: L, autoPrint: true }).html
  check('autoPrint=true 时不挂缩放控制条', !/class="mf-print-zoom"/.test(auto))
  check('autoPrint=true 时不注入缩放脚本（只留那一段自动打印）',
    (auto.match(/<script>/g) || []).length === 1, `${(auto.match(/<script>/g) || []).length} 段`)
  check('autoPrint=true 时页数一样', countPages(auto) === built.pageCount)
}

/* ================================================================== */
/*
 * 坑 106：「自我一致 ≠ 语法正确」。上面那些断言全是**字符串层面的**，
 * 写入端和读取端一起错也能全绿。所以这一节把生成出来的那段 <script> 真跑一遍：
 *   · 先用 node:vm 编译它 —— 语法错立刻炸（这正是坑 106 里 mermaid 那次抓到的东西）；
 *   · 再用一套最小 DOM 桩把它跑起来，真的派发 wheel / pointer 事件，量它算出来的
 *     zoom 值和滚动位置。断言的是**行为**，不是字符串。
 */
console.log('\n[13] 生成的缩放脚本真跑一遍：语法 + 行为（坑 106）')

{
  const root = makeNode('根')
  const a = makeNode('甲')
  root.children = [a]
  const L = printLayout(root, { charts: [{ id: a.id, svg: svgOf(400, 300) }] })
  const html = buildPrintHtml({ name: 'x', layout: L }).html
  const script = (/<script>([\s\S]*?)<\/script>/.exec(html) || [])[1] || ''
  check('抠出了那段缩放脚本', script.length > 500, `${script.length} 字符`)
  check('script 里没有裸的 </script>（否则 HTML 会提前闭合，整段脚本变成文本）',
    !/<\/script>/.test(script))
  let syntaxOk = true
  try { new vm.Script(script) } catch (e) { syntaxOk = false; note('语法错：' + e.message) }
  check('这段脚本是**合法 JS**（不是靠字符串自洽骗过自己的）', syntaxOk)

  /** 一套刚好够这段脚本用的 DOM 桩：不引入 jsdom，行为全部可观测 */
  const dom = () => {
    const H = {}
    const created = []
    const mk = (id) => ({
      id, style: {}, textContent: '', className: '', parentNode: null,
      setAttribute() {}, setPointerCapture() {},
      /*
       * 模拟真实浏览器：CSS zoom 会把元素的盒子一起缩掉，所以
       * getBoundingClientRect 拿到的是**缩放后**的尺寸（真 Edge 里实测
       * zoom:1.162 时 1046.9px 的纸量出来是 1216.5px）。
       * 桩里给一份固定的「未缩放内容尺寸」，按当前 zoom 折算。
       */
      getBoundingClientRect() {
        const z = this.style.zoom === '' ? 1 : Number(this.style.zoom)
        return { width: 1046.93 * z, height: 2154 * z, top: 0, left: 0 }
      },
      addEventListener(t, f) { (this.h = this.h || {})[t] = f; H['el:' + id + ':' + t] = f },
      appendChild(c) { c.parentNode = this },
      removeChild(c) { c.parentNode = null },
      closest() { return null },
    })
    const pages = mk('mf-pages')
    const pct = mk('mf-pct')
    const body = mk('body')
    const win = mk('window')
    const scrolledTo = []
    Object.assign(win, {
      scrollX: 0, scrollY: 0, innerWidth: 1000, innerHeight: 800,
      scrollTo(x, y) { scrolledTo.push([x, y]); win.scrollX = x; win.scrollY = y },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener(t, f) { (this.h = this.h || {})[t] = f; H['win:' + t] = f },
    })
    const document = {
      getElementById: (id) => ({ 'mf-pages': pages, 'mf-pct': pct, 'mf-zin': mk('mf-zin'),
        'mf-zout': mk('mf-zout') }[id] || null),
      createElement: () => { const el = mk('spacer'); created.push(el); return el },
      body,
      documentElement: { scrollWidth: 2000, scrollHeight: 5000 },
      addEventListener(t, f) { H['doc:' + t] = f },
    }
    return { pages, pct, body, win, document, H, created, scrolledTo }
  }
  /** 最小的 wheel 事件：defaultPrevented 要真的跟着 preventDefault 变 */
  const ev = (o) => Object.assign({
    deltaY: 0, deltaMode: 0, ctrlKey: false, clientX: 0, clientY: 0, pointerId: 1,
    button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true },
  }, o)

  const boot = () => {
    const d = dom()
    vm.runInNewContext(script, { window: d.win, document: d.document, Math, String, Number })
    return d
  }
  const wheel = (d, o) => { const e = ev(o); d.H['el:mf-pages:wheel'](e); return e }
  // 回到 1 倍时脚本会把内联 zoom 清掉（空串）—— 空串就是「未缩放」，不是 0
  const zoomOf = (d) => (d.pages.style.zoom === '' ? 1 : Number(d.pages.style.zoom))

  {
    const d = boot()
    check('跑起来之后默认值是 100%、没有任何 zoom', d.pages.style.zoom === '' && d.pct.textContent === '100%',
      `zoom=${JSON.stringify(d.pages.style.zoom)} pct=${d.pct.textContent}`)
    const e = wheel(d, { deltaY: -100, clientX: 500, clientY: 400 })
    check('滚轮向上真的放大了（实测 ×1.1618）', Math.abs(zoomOf(d) - 1.161834) < 0.001,
      `${zoomOf(d)}`)
    check('百分比显示跟着更新', d.pct.textContent === '116%', d.pct.textContent)
    check('缩放时 preventDefault（不拦的话浏览器会同时滚动页面，两个动作打架）', e.defaultPrevented)
    wheel(d, { deltaY: 100, clientX: 500, clientY: 400 })
    check('再向下滚一格回到 1（乘性缩放可逆）', Math.abs(zoomOf(d) - 1) < 1e-9, `${zoomOf(d)}`)
  }

  {
    const d = boot()
    for (let i = 0; i < 80; i++) wheel(d, { deltaY: -100, clientX: 500, clientY: 400 })
    check(`一直放大被夹在上限 ${MAX_ZOOM}（不会滚到失控）`, zoomOf(d) === MAX_ZOOM, `${zoomOf(d)}`)
    for (let i = 0; i < 200; i++) wheel(d, { deltaY: 100, clientX: 500, clientY: 400 })
    check(`一直缩小被夹在下限 ${MIN_ZOOM}`, zoomOf(d) === MIN_ZOOM, `${zoomOf(d)}`)
  }

  {
    const d = boot()
    wheel(d, { deltaY: -4, ctrlKey: true, clientX: 500, clientY: 400 })
    check('触控板捏合（ctrlKey=true 的 wheel）走更细的步长：×1.0408',
      Math.abs(zoomOf(d) - 1.040811) < 0.001, `${zoomOf(d)}`)
    const d2 = boot()
    wheel(d2, { deltaY: -4, clientX: 500, clientY: 400 })
    check('同样 deltaY 但不带 ctrlKey（鼠标那档）：×1.0060，比捏合还细',
      Math.abs(zoomOf(d2) - 1.006012) < 0.001 && zoomOf(d2) < zoomOf(d),
      `${zoomOf(d2)} vs ${zoomOf(d)}`)
  }

  {
    const d = boot()
    // deltaMode=1（Firefox 的「行」）拿到的 deltaY=3；归一成 3×16=48px 之后是**缩小** 7%
    wheel(d, { deltaY: 3, deltaMode: 1, clientX: 500, clientY: 400 })
    check('Firefox 的「行」模式被归一（deltaMode=1 → ×16，正好等于鼠标半格）',
      Math.abs(zoomOf(d) - 0.930531) < 0.001, `${zoomOf(d)}`)
    const d2 = boot()
    const e = wheel(d2, { deltaY: 0, clientX: 500, clientY: 400 })
    check('横向滚轮（deltaY=0）完全不缩放、也不拦默认行为',
      d2.pages.style.zoom === '' && !e.defaultPrevented)
  }

  {
    /* 以光标为锚点：缩放前后，光标下面那个点不许动 */
    const d = boot()
    d.win.scrollX = 10
    d.win.scrollY = 2000
    const cx = 500
    const cy = 400
    const v0 = d.win.scrollX
    const w0 = d.win.scrollY
    d.scrolledTo.length = 0
    // 向上滚 = 放大。放大才会「需要往下滚一点」，滚动量落在合法区间里；
    // 缩小（光标在左半边时）需要的滚动量是负数，浏览器夹到 0，锚点本来就做不到。
    wheel(d, { deltaY: -100, clientX: cx, clientY: cy })
    const k = zoomOf(d)
    const [v1, w1] = d.scrolledTo[d.scrolledTo.length - 1] || [null, null]
    /*
     * 断言的是锚点的**定义**，不是实现里那个公式（否则公式写反也能自洽通过，
     * 见坑 106）：光标底下的内容点，其「内容坐标」缩放前后必须相同 ——
     *   内容坐标 = (滚动量 + 光标位置) / 缩放倍数
     * 这一条与公式长什么样无关，所以能真的抓住符号错误。
     */
    const c0 = { x: (v0 + cx) / 1, y: (w0 + cy) / 1 }
    const c1 = { x: (v1 + cx) / k, y: (w1 + cy) / k }
    note(`锚点实测（缩到 ${k.toFixed(3)}）：光标 (${cx},${cy})，滚动 (${v0},${w0}) → (${v1},${w1})；`
      + `光标下的内容坐标 (${c0.x.toFixed(1)}, ${c0.y.toFixed(1)}) → (${c1.x.toFixed(1)}, ${c1.y.toFixed(1)})`)
    check('缩放前后「光标底下的内容坐标」不变（容差 1px 的取整）',
      Math.abs(c1.x - c0.x) <= 1 && Math.abs(c1.y - c0.y) <= 1, `${c1.x},${c1.y} vs ${c0.x},${c0.y}`)
    check('滚动位置确实变了（不然「锚点不动」是白送的）',
      Math.abs(v1 - v0) > 20 || Math.abs(w1 - w0) > 20, `${v1},${w1} vs ${v0},${w0}`)
    check('滚动量按 (v0+cx)·k-cx 走，而不是按 k 缩滚动起点（符号反了会往右下漂）',
      Math.abs(v1 - ((v0 + cx) * k - cx)) <= 1, `${v1} vs ${((v0 + cx) * k - cx).toFixed(2)}`)
  }

  {
    /*
     * 缩小之后必须把可滚动区域撑回去，否则后面几页滚不到。
     *
     * 这里踩过两个坑，都由这条断言盯着：
     *   1) 把差额写成 1-1/z（z<1 时为负）—— 只在不需要补的那一侧生效；
     *   2) 数学对了但**单位写成了百分比** —— body 高度是 auto，CSS 把百分比高度
     *      当 auto 处理，占位实际高度 0。node 的 DOM 桩没有布局引擎，抓不到；
     *      真 Edge 里实测滚动高只有 900px（视口高），三页里两页滚不到。
     */
    const d = boot()
    for (let i = 0; i < 4; i++) wheel(d, { deltaY: 100, clientX: 500, clientY: 400 })
    const zExact = Math.pow(Math.exp(-100 * WHEEL_STEP), 4)
    const sp = d.created.filter((el) => el.className === 'mf-print-spacer').pop()
    const px = sp ? parseFloat(sp.style.height) : NaN
    const H = 2154                              // 桩里给的未缩放内容高
    const zApplied = Number(d.pages.style.zoom)
    note(`缩小到 ${zExact.toFixed(4)}（style.zoom=${d.pages.style.zoom}，界面显示 ${d.pct.textContent}）时，`
      + `占位高 ${sp ? sp.style.height : '(没有占位)'}；桩量到内容高 ${d.pages.getBoundingClientRect().height}px，`
      + `need=1/z-1=${(1 / zApplied - 1).toFixed(4)}`)
    check('缩小后生成了撑高占位（没有它，后面几页滚不到）', !!sp && sp.parentNode === d.body)
    check('占位高度是 **px**，不是百分比（body 高 auto，百分比会被当成 auto = 0）',
      !!sp && /px$/.test(sp.style.height) && !/%/.test(sp.style.height), sp && sp.style.height)
    /*
     * 断言的是占位的**用途**：缩放后的内容高 + 补高 = 未缩放的内容高，
     * 也就是「滚到底的能力恢复到未缩放时的量」。公式写反或单位写错都不成立。
     * 容差 1.5px：脚本按「写进 CSS 的那个 3 位小数缩放值」算，且向上取整。
     */
    const hApplied = d.pages.getBoundingClientRect().height
    check('补高把滚动范围还原成未缩放的量（z·H + 补高 ≈ H）',
      Math.abs(hApplied + px - H) <= 1.5, `${(hApplied + px).toFixed(1)} vs ${H}`)
    check('补高 = 内容高 × (1/z-1)，上限只多 1px（ceil）',
      Math.abs(px - hApplied * (1 / zApplied - 1)) <= 1,
      `${px} vs ${(hApplied * (1 / zApplied - 1)).toFixed(1)}`)
  }

  {
    /* 打印前中和、打印后还原：内联 zoom 打死 @media 规则，只能靠脚本这一步 */
    const d = boot()
    wheel(d, { deltaY: -100, clientX: 500, clientY: 400 })
    const before = zoomOf(d)
    d.H['win:beforeprint']()
    check('打印前脚本把屏幕缩放中和掉（纸上必须是未缩放的原版面）',
      d.pages.style.zoom === '', JSON.stringify(d.pages.style.zoom))
    d.H['win:afterprint']()
    check('打印后恢复用户原来的缩放', Math.abs(zoomOf(d) - before) < 1e-9, `${zoomOf(d)} vs ${before}`)
  }

  {
    /* 拖拽平移：滚轮被缩放占用之后，翻页入口必须是通的 */
    const d = boot()
    d.win.scrollX = 300
    d.win.scrollY = 900
    d.scrolledTo.length = 0
    d.H['doc:pointerdown'](ev({ pointerId: 7, clientX: 400, clientY: 500 }))
    d.H['win:pointermove'](ev({ pointerId: 7, clientX: 340, clientY: 420 }))
    const [x, y] = d.scrolledTo[d.scrolledTo.length - 1] || [null, null]
    note(`拖拽实测：按下 (400,500) 拖到 (340,420)，滚动 (300,900) → (${x},${y})`)
    check('手指/鼠标往左上拖 → 内容跟着走（滚动 +60/+80），偏移像素与指针位移等量',
      x === 360 && y === 980, `${x},${y}`)
    check('拖拽不会顺手把缩放也改了（两套手势互不干扰）', zoomOf(d) === 1,
      `${JSON.stringify(d.pages.style.zoom)}`)
    d.H['win:pointerup'](ev({ pointerId: 7 }))
    d.scrolledTo.length = 0
    d.H['win:pointermove'](ev({ pointerId: 7, clientX: 100, clientY: 100 }))
    check('松手之后再移动不再滚动（手势必须能被结束）', d.scrolledTo.length === 0)
  }

  {
    /* 点在按钮/控制条上不能启动平移，否则点「+」会连页面一起拖走 */
    const d = boot()
    const btn = { closest: (sel) => (sel.includes('.mf-print-zoom') ? btn : null) }
    d.H['doc:pointerdown'](ev({ pointerId: 9, clientX: 20, clientY: 700, target: btn }))
    d.scrolledTo.length = 0
    d.H['win:pointermove'](ev({ pointerId: 9, clientX: 200, clientY: 100 }))
    check('按下点在缩放控制条上时不启动平移（按钮的点击不会被拖拽吃掉）',
      d.scrolledTo.length === 0)
  }
}

/* ================================================================== */
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
