/**
 * PDF 打印排版（导图本体 + 各节点的流程图）
 * ==========================================
 * 只做一件事：把画布上那张**横向树导图**原样排进 A4 横向页面，并把每个折角的
 * 流程图放在**它所属节点那条分支的正下方**，中间一条细引线连回去。
 *
 * 为什么图不能直接贴在节点右边
 * ----------------------------
 * 横向树里，节点右边那片区域正好是它连向子节点的**扇形连线**：图放那儿必然压线。
 * 把子节点整体推到图的右边也不行 —— 连向子节点的那条线还是要横穿过去。
 * 而节点**下方**那条竖直带是空的：子节点永远在更右边那一列，同列的下一个兄弟
 * 又在整条分支结束之后才开始。所以「分支正下方 + 引线」是唯一既不压线、
 * 又能让人一眼看出「这张图属于上面哪个节点」的摆法。
 *
 * 预留空间怎么来的
 * ----------------
 * 由 layoutTree 的 bandExtra 在**子树末尾**加一段高度，父节点因此仍然是
 * 「垂直居中于自己的子树」。这一步让画布布局完全不受影响（默认 0）。
 *
 * 流程图按多大画
 * --------------
 * 按 **mermaid 自己给的 viewBox 原生尺寸**画，最多占一页（见 chartSize）。
 * 这一条是硬要求，不是审美：盒子尺寸一旦和图的内容尺寸脱钩，图里的字和线
 * 就会被缩到纸上看不见 —— 详见 chartSize 的注释。
 *
 * 本文件全是纯函数：不碰 DOM、不碰 mermaid。渲染好的 SVG 字符串由调用方传进来，
 * 所以整套排版（分页、盒子、转义）都能用 node 直接跑测试。
 */

import { layoutTree, edgePath, PAD } from './layout.js'

/** 节点分支底部到流程图之间的空隙 */
export const CHART_GAP = 16
/** 量不出 viewBox 时的兜底盒子：宽度 + 宽高比（4:3 略扁） */
export const CHART_W = 320
export const CHART_RATIO = 0.62

const PX_PER_MM = 96 / 25.4

/**
 * A4 横向：导图是横向生长的，竖版会被压得太窄。
 * margin 10mm 由 @page 控制，这里只算「版心」的像素尺寸。
 */
export const PAGE = {
  wMm: 297,
  hMm: 210,
  marginMm: 10,
  contentW: (297 - 2 * 10) * PX_PER_MM, // ≈ 1046.9px
  contentH: (210 - 2 * 10) * PX_PER_MM, // ≈ 718.1px
}

/**
 * 一张流程图最多占多大：一页宽、一页高。
 * 再大就不是「排版」能解决的问题了，是纸的物理限制。
 */
export const CHART_MAX_W = PAGE.contentW
export const CHART_MAX_H = PAGE.contentH

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/* ------------------------------------------------------------------ */
/* SVG 尺寸与规整                                                       */
/* ------------------------------------------------------------------ */

/**
 * 从 SVG 字符串里量出宽高比。
 *
 * 必须量：流程图的盒子尺寸决定了要给这条分支预留多少垂直空间，而 mermaid
 * 输出的 SVG 只有 viewBox（宽度是 100%），高度是算出来的。viewBox 拿不到时
 * 退到 width/height 属性，再退到 CHART_RATIO —— 宁可尺寸估错一点，也不能崩。
 */
export function viewBoxOf(svg) {
  const s = String(svg || '')
  const m = /viewBox\s*=\s*["']([^"']+)["']/i.exec(s)
  if (m) {
    const p = m[1].trim().split(/[\s,]+/).map(Number)
    if (p.length === 4 && p.every((v) => Number.isFinite(v)) && p[2] > 0 && p[3] > 0) {
      return { w: p[2], h: p[3] }
    }
  }
  const w = numAttr(s, 'width')
  const h = numAttr(s, 'height')
  if (w > 0 && h > 0) return { w, h }
  return { w: 0, h: 0 }
}

/** 读根标签上的数值属性；`100%` / 缺失 / 非数字一律算 0 */
function numAttr(svg, name) {
  const re = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i')
  const m = re.exec(svg)
  if (!m) return 0
  const raw = m[1].trim()
  // 百分比不是长度：`width="100%"` 说明这个属性给不了绝对尺寸，只能当没有
  if (raw.includes('%')) return 0
  const v = parseFloat(raw)
  return Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * 流程图盒子的世界尺寸。
 *
 * 【一条规则：按原生尺寸画，最多占一页】
 * 「原生尺寸」就是 mermaid 给的 viewBox —— 也正是这张图在弹窗里 100% 显示时的大小。
 * 于是图里的字号和导图节点的字号处在同一个量级上；只有「一张图比一页还大」时
 * 才按比例缩小，而那是纸的物理限制，躲不掉。
 *
 * 【为什么不能像以前那样把盒子宽度写死成 320】
 * 写死盒子宽度 = 把图硬塞进 320px，缩放比例是 320 / viewBox 宽，跟图本身多大无关：
 *   · viewBox 宽 128   → 放大 2.5×，字变成 33pt（比导图自己的字大 3 倍）
 *   · viewBox 宽 1120  → **缩小 3.5×**：14px 的字 → 3.9pt，1px 的线 → 0.21pt
 *   · viewBox 宽 2232  → 缩小 7×：字 1.9pt，线 0.11pt
 * 后两种落到 PDF 上就是用户报的「线条和文字好多都没有了」—— 0.1pt 的线根本画不出来，
 * 2pt 的中文只是一团灰。而这一切在屏幕上看不出来：屏幕有抗锯齿，细线还在，
 * 预览页还能 Ctrl+滚轮放大。
 *
 * 【盒子长宽比必须严格等于 viewBox 的长宽比】
 * 打印样式里 svg 是 width/height:100%，比例一致时 preserveAspectRatio 的 meet
 * 缩放正好等于 k，图填满盒子、不留黑边。一旦比例不一致，meet 会按较小的那一维
 * **再缩一次** —— 以前用 CHART_MIN_H 把扁图的盒子抬到 90px 高，就是白白再丢一截。
 *
 * @param maxW 一张图最多多宽（默认一页宽）
 * @param maxH 一张图最多多高（默认一页高）
 */
export function chartSize(svg, maxW = CHART_MAX_W, maxH = CHART_MAX_H) {
  const vb = viewBoxOf(svg)
  if (!(vb.w > 0 && vb.h > 0)) return { w: CHART_W, h: CHART_W * CHART_RATIO }
  const k = Math.min(1, maxW / vb.w, maxH / vb.h)
  return { w: vb.w * k, h: vb.h * k }
}

/**
 * 去掉根 <svg> 上的 width/height/style，让打印样式能把图撑满盒子。
 * mermaid 会写 `style="max-width: 500px"`，内联样式优先级高于样式表，
 * 不清掉的话图会被卡在原始尺寸上、在盒子里缩成一小团。
 */
export function normalizeSvg(svg) {
  const s = String(svg || '')
  const i = s.indexOf('<svg')
  if (i < 0) return s
  const j = s.indexOf('>', i)
  if (j < 0) return s
  const tag = s
    .slice(i, j + 1)
    .replace(/\s(style|width|height)\s*=\s*"[^"]*"/gi, '')
    .replace(/\s(style|width|height)\s*=\s*'[^']*'/gi, '')
  return s.slice(0, i) + tag + s.slice(j + 1)
}

/* ------------------------------------------------------------------ */
/* 排版                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {Node} root
 * @param {object} opts
 * @param {Relation[]} opts.relations 「指向同一结果」的汇聚边
 * @param {Array<{id, svg}>} opts.charts 折角节点的流程图（渲染好的 SVG 字符串）
 * @param {number} opts.chartWidth  一张图最多多宽（默认一页宽）
 * @param {number} opts.chartHeight 一张图最多多高（默认一页高）
 * @returns {{nodes, edges, relationEdges, hiddenTreeTo, charts, boxes, byId, width, height}}
 *   boxes  = 所有盒子的世界坐标（节点 + 流程图），分页就靠它
 *   charts = [{ id, x, y, w, h, svg }]
 */
export function printLayout(root, {
  relations = [], charts = [], chartWidth = CHART_MAX_W, chartHeight = CHART_MAX_H,
} = {}) {
  const size = new Map()
  const svgOf = new Map()
  for (const c of charts) {
    if (!c || !c.id || !c.svg) continue // 渲染失败/空折角：不占位置，也不画空框
    size.set(c.id, chartSize(c.svg, chartWidth, chartHeight))
    svgOf.set(c.id, c.svg)
  }

  /*
   * 预留 = 图高 + 空隙。
   *
   * 【为什么不是「图高 + 空隙 - 兄弟间距」】
   * 一开始想省掉那 22px（GAP_Y），理由是「图正好占掉本来就有的那点兄弟间距」。
   * 错在这儿：图不是紧贴在子树**最后一个节点盒子**下面的，而是贴在这条分支
   * **最后一个盒子**下面 —— 而后代自己的流程图会往它自己那条分支的末尾再探出
   * 一个 GAP_Y（它也要占位置）。于是父节点的图比预留的位置低了 22px，
   * 正好压进下一个兄弟那一 band 里。实测 0 关系、纯随机树里就有 23% 的图被这个
   * 误差顶下去（最多顶开 1514px），而且会连锁把下面所有图一起顶走。
   * 现在预留给足 GAP_Y 的余量：最坏情况下正好用满，最好情况下多 22px 空白，
   * 两头都不会压到东西。
   */
  const extraOf = (id) => {
    const sz = size.get(id)
    return sz ? sz.h + CHART_GAP : 0
  }
  const extraFor = (node) => extraOf(node.id)

  /*
   * 带图的节点一律不搬进汇聚通道。
   * 它们的图要在**布局阶段**预留空间（bandExtra），而预留是钉在「这个节点
   * 所在的子树末尾」的；节点一被搬走，预留就白留、图也跟着掉进别的分支。
   */
  const lockIds = new Set(size.keys())

  const layout = layoutTree(root, { relations, bandExtra: extraFor, lockIds })
  const { nodes, edges, byId } = layout

  /* 子树底部：节点自己 + 全部渲染出来的后代（折叠的子树不在 nodes 里） */
  const kids = new Map()
  for (const e of edges) {
    if (!kids.has(e.from)) kids.set(e.from, [])
    kids.get(e.from).push(e.to)
  }

  /*
   * 图的落点 = 「这条分支上最后一个盒子」的下方。
   *
   * 【别只算节点盒子】后代自己的流程图也占位置，而且它正好压在它那条分支的
   * 末尾。漏掉它，父节点的图就会顶在后代那张图上（实测两张图重叠 90px、
   * 甚至 400px 整张压住）。所以 occ 取「节点盒子底部」和「后代占用底部」的
   * 较大值，其中「后代占用底部」本身已经含了后代那张图的高度。
   *
   * nodes 是**后序**（子节点一定排在父节点前面），所以一趟正向扫描就自底向上
   * 算完了，不需要递归，也不会因为深链爆栈。
   */
  const occ = new Map()
  const placed = []
  for (const n of nodes) {
    let bottom = n.y + n.h
    for (const c of kids.get(n.id) || []) {
      const o = occ.get(c)
      if (o !== undefined && o > bottom) bottom = o
    }
    const sz = size.get(n.id)
    if (!sz) { occ.set(n.id, bottom); continue }
    const x = chartX(n.x)
    const y = pushDown(bottom + CHART_GAP, x, sz.w, sz.h, nodes, placed)
    placed.push({ id: n.id, node: n, x, y, w: sz.w, h: sz.h, svg: svgOf.get(n.id) })
    occ.set(n.id, Math.max(bottom, y + sz.h))
  }

  /* 「指向同一结果」的边：和画布同一套判据（自环/悬空端点跳过） */
  const relationEdges = []
  for (const r of relations) {
    if (!r || r.from === r.to) continue
    const a = byId.get(r.from)
    const b = byId.get(r.to)
    if (!a || !b) continue
    relationEdges.push({ key: `${r.from}\u0000${r.to}`, from: r.from, to: r.to, a, b })
  }

  /*
   * 有 ≥2 条入边的节点，藏掉它的树边 —— 与画布渲染时同一条规则。
   * 不藏的话，汇聚结果节点会多出一条「凭空从更高一层来」的线。
   */
  const inCount = new Map()
  for (const r of relationEdges) inCount.set(r.b.id, (inCount.get(r.b.id) || 0) + 1)
  const hiddenTreeTo = new Set()
  for (const [id, cnt] of inCount) if (cnt >= 2) hiddenTreeTo.add(id)

  const boxes = [
    ...nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
    ...placed.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
  ]
  let maxX = 0
  let maxY = 0
  for (const b of boxes) {
    if (b.x + b.w > maxX) maxX = b.x + b.w
    if (b.y + b.h > maxY) maxY = b.y + b.h
  }

  return {
    nodes,
    edges,
    relationEdges,
    hiddenTreeTo,
    charts: placed,
    boxes,
    byId,
    width: maxX + PAD,
    height: maxY + PAD,
  }
}

/**
 * 流程图放在哪一列：**和它所属节点的左边缘对齐，不做任何横向挪动**。
 *
 * 【为什么不挪动】
 * 挪动的动机是好的：宽的流程图会往右探出去，把**整张导图**撑宽，而缩放是
 * 「版心宽 / 图宽」—— 图一宽，导图自己的字就跟着变小（实测一张 8 节点横排的
 * 流程图能把「4 层 ×3 分叉」的导图从缩放 1.00 压到 0.62，导图的字从 10.5pt
 * 掉到 6.5pt）。把图往左挪回一页之内，导图就能保住原来的缩放。
 *
 * 但实测**得不偿失**，所以这条路走不通：导图里父节点是「垂直居中于自己子树的
 * 跨度」摆的，纵向上它可能正好落在某个子节点的区间里（种子 14：父节点 n5 在
 * y=480..514，而子节点 n8 的流程图自然位置是 y=422..622）。图一旦被往左挪进
 * 父节点那一列，就撞上父节点 —— 兜底的 pushDown 只好把图往下顶，再连锁把后面
 * 的图一起顶走。实测 515 张流程图里 **29% 被下移、中位 304px、最远 1532px**
 * （不挪则是 0%）。图飘得离自己的节点越来越远，比「导图整体小一点」难看得多。
 *
 * 于是接受代价：图按原生尺寸画、把导图等比撑宽，导图跟着整体缩小。
 * 换来的是两件更重要的事 —— 图里字号和导图字号始终同一量级，
 * 以及布局完全不被图打乱（碰撞保证原样保留，见 pushDown 的兜底率）。
 */
function chartX(nodeX) {
  return nodeX
}

/**
 * 把图往下顺延到不压任何盒子为止。
 * 正常情况下不会触发：预留的空间是算好的。唯一会撞上的情形是「这个折角节点
 * 本身是个汇聚结果、被汇聚重排搬去了别的通道」—— 它自己的预留空间留在了
 * 原来的位置。这种时候宁可把图往下挪一格，也不能让图盖住节点。
 */
function pushDown(y, x, w, h, nodes, placed) {
  let cur = y
  for (let guard = 0; guard < 200; guard++) {
    let next = null
    for (const n of nodes) {
      if (!hits(cur, x, w, h, n.x, n.y, n.w, n.h)) continue
      const b = n.y + n.h + CHART_GAP
      if (next === null || b > next) next = b
    }
    for (const c of placed) {
      if (!hits(cur, x, w, h, c.x, c.y, c.w, c.h)) continue
      const b = c.y + c.h + CHART_GAP
      if (next === null || b > next) next = b
    }
    if (next === null) return cur
    cur = Math.max(next, cur + 1)
  }
  return cur
}

function hits(ay, ax, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah
}

/* ------------------------------------------------------------------ */
/* 分页                                                                */
/* ------------------------------------------------------------------ */

/**
 * 纵向「无缝隙区间」的最大长度：这一段里没有任何空隙，任何一条水平线都会
 * 从某个盒子中间穿过去。
 *
 * 分页要求「切点不能劈开盒子」，而切点只能落在盒子之间的空隙上。所以缩放
 * 不能只看宽度：如果某一段连续重叠的盒子比一整页还高，那一页里就**找不到**
 * 任何合法切点，只能硬切。把缩放一并压到「最长的连续段也塞得进一页」，
 * 切点就必然存在（见 paginate）。
 */
export function maxCoveredRun(boxes = []) {
  const iv = boxes.map((b) => [b.y, b.y + b.h]).sort((p, q) => p[0] - q[0])
  let max = 0
  let s = null
  let e = null
  for (const [a, b] of iv) {
    if (s === null) { s = a; e = b; continue }
    // 相接（a === e）不算重叠：那个点正好是一条干净的切线，要留着
    if (a < e) { if (b > e) e = b }
    else { if (e - s > max) max = e - s; s = a; e = b }
  }
  if (s !== null && e - s > max) max = e - s
  return max
}

/**
 * 整张图缩放多少才能塞进版心。
 *
 * 两个约束同时成立：
 *   · 宽度塞得进版心（超宽的图整体缩小，宁可小也不裁掉节点）；
 *   · 最长的连续重叠段塞得进一页高度（否则分页找不到合法切点，会劈开节点）。
 * 上限 1：不放大。小图放大到版心宽度并不会让版面好看多少，却会平白多出
 * 一两页空白 —— 需要更大字号的用户在打印对话框里自己调比例即可。
 */
export function printScale(layout, pageW = PAGE.contentW) {
  const byWidth = pageW / Math.max(1, layout.width)
  const byHeight = PAGE.contentH / Math.max(1, maxCoveredRun(layout.boxes))
  return clamp(Math.min(byWidth, byHeight), 0.1, 1)
}

export function printPages(layout) {
  const scale = printScale(layout)
  const pageWorldH = PAGE.contentH / scale
  return { scale, pageWorldH, pages: paginate(layout.boxes, pageWorldH, layout.height) }
}

/**
 * 把整张图切成若干页。
 *
 * 切点只能落在**盒子之间**（没有任何盒子横跨这条线），否则节点或流程图会被
 * 从中间劈开、上半页一张下半页一张。候选切点取所有盒子的上下边缘，
 * 在其中挑「不超过一页高度里最靠下的那个」——尽量把每页填满。
 * 只有单个盒子比一整页还高时才会被迫从中间切。
 */
export function paginate(boxes, pageH, totalHeight) {
  const total = Math.max(1, totalHeight)
  if (!(pageH > 1)) return [{ top: 0, height: total }]

  const pages = []
  let y0 = 0
  for (let guard = 0; guard < 400; guard++) {
    if (y0 >= total - 0.5) break
    const limit = y0 + pageH
    let cut
    if (limit >= total - 0.5) {
      cut = total
    } else {
      let best = null
      for (const b of boxes) {
        for (const c of [b.y, b.y + b.h]) {
          if (c <= y0 + 0.5 || c > limit) continue
          if (straddles(boxes, c)) continue
          if (best === null || c > best) best = c
        }
      }
      cut = best === null ? limit : best
    }
    pages.push({ top: y0, height: cut - y0 })
    y0 = cut
  }
  if (!pages.length) pages.push({ top: 0, height: total })
  return pages
}

/** 这条水平线有没有从某个盒子中间穿过去 */
function straddles(boxes, y) {
  for (const b of boxes) if (y > b.y + 0.5 && y < b.y + b.h - 0.5) return true
  return false
}

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

/**
 * 打印按钮上的图标：内联 SVG 打印机。
 * 和界面其它图标同一套做法（不用 emoji —— Emoji 会被系统字体接管、在纸上糊成一团）。
 */
const PRINT_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"'
  + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M6 9V3h12v6"/>'
  + '<path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/>'
  + '<rect x="6" y="14" width="12" height="7" rx="1"/></svg>'

/* ------------------------------------------------------------------ */
/* 预览页的滚轮缩放                                                     */
/* ------------------------------------------------------------------ */

/**
 * 屏幕缩放（预览页的滚轮/按钮缩放）的上下限。
 *
 * 【为什么下限是 0.35 而不是 0.1】
 * 这一页的最小号字是 10.5pt（节点文字 14px × 0.75）。缩到 0.2 时它只剩 2.1pt，
 * 屏幕上就是一团灰 —— 和 README 里那条「0.21pt 的线在 PDF 里画不出来」
 * 是同一个道理，只是换到了屏幕上。0.35 → 3.7pt，还能勉强认出字。
 * 而且版心宽 1046.9px，在 390px 宽的手机上 0.35 已经能整页看全。
 *
 * 【为什么上限是 5 而不是 3】
 * 上限存在的唯一目的是「别让用户滚到失控」：每格 ×1.16 的话，从 1.0 滚到
 * 上限只多花 11 格，手不会累。而屏幕缩放**不需要**为纸上的可读性负责
 * （那一项由分页 scale 保证），所以留得比 previewConfig 的 3 更宽一点，
 * 方便核对流程图里的细线。默认不缩放就是 1，两侧都够用。
 */
export const MIN_ZOOM = 0.35
export const MAX_ZOOM = 5

/**
 * 滚轮缩放的步长 —— 直接沿用折角弹窗预览区那套，三处共用一个来源。
 *
 * 【为什么不从 previewConfig.js import 进来】
 * 那个文件在 src/features/fold/ 下，是 React 功能层的模块；而本文件是一份
 * 自包含的纯字符串模板 —— 连 mermaid 都不碰，只依赖 layout.js。为了两个
 * 浮点数把它拽进功能层，等于让「生成打印页」这件事反向依赖「折角弹窗」，
 * 将来拆哪个都会连着疼。
 *
 * 【所以数去 src/lib/zoomSteps.js，而不是抄一份在下面】
 * 曾经这里抄了一份（注释写「取值严格一致」），结果是三个作用面各写一份、
 * 手感不一致，用户反馈「两个视图都是这样的，但思维导图不是这样的」。
 * 现在三处共用 src/lib/zoomSteps.js 这一份 —— 一致性从约定变成结构。
 * 那个文件里有完整的推导和实测数字（含「为什么是乘性步长」）。
 */
/*
 * 滚轮步长从 src/lib/zoomSteps.js 转出，**本文件不再自己写一份数字**。
 *
 * 【为什么可以直接 import，而不产生反向依赖】
 * zoomSteps.js 就在 src/lib/ 里，和本文件同级 —— 既不碰 features 层，
 * 也不会把 mermaid / React 拽进来。生成打印页依然是一份自包含的纯字符串模板。
 *
 * 保留 re-export 是为了让 `printLayout.test.mjs` 的既有 import 一字不改。
 */
/*
 * 必须**先 import 再 re-export**：`export { X } from '…'` 只做转发，
 * 不会把 X 绑进本模块的作用域，而下面的 PRINT_ZOOM_JS 模板里要用到这两个值。
 */
import { WHEEL_STEP, TRACKPAD_WHEEL_STEP } from './zoomSteps.js'
export { WHEEL_STEP, TRACKPAD_WHEEL_STEP }

/**
 * 缩放按钮每步的倍率。
 * 1.25 是「点四下翻一倍」（1.25⁴ = 2.44），按起来有明确的档位感；
 * 0.2 那种加法步长在放大状态下会显得没反应。
 */
export const ZOOM_BTN_FACTOR = 1.25

/**
 * 撑开可滚动区域用的「占位页」尺寸（mm）= 一页纸的物理尺寸。
 * 见 PRINT_ZOOM_JS 里 spacer 那段：不撑开的话缩小后滚不到后面几页。
 */
export const SPACER_W_MM = PAGE.wMm
export const SPACER_H_MM = PAGE.hMm

/**
 * 给 .mf-print-pages 生成 style 属性。
 *
 * 只有两件事：默认（scale===1）返回空串，让默认这一页与改动前逐字节一致；
 * 否则用 `zoom` —— 它是 Chrome 120+ / Safari / Edge 都支持的**布局级**缩放，
 * 缩放后元素占的盒子跟着变小：整页在屏幕上直接缩成小图，右侧留白变多、
 * 有地方可以横向拖一拖找位置。transform:scale 做不到这一点（它不改变布局
 * 占位，缩到最后会和相邻页叠在一起）。
 *
 * 【为什么 scale 用 toFixed(3)】
 * 字符串是这一页的全部接口，1.0000000000000002 这种浮点毛刺会让断言和
 * 「默认无缩放」的判定都变得脆弱；三位小数肉眼也看不出差别。
 */
export function PRINT_SCALE1_STYLE(zoom) {
  const z = Number(zoom)
  // 非有限数 / 1 → 不加任何样式：宁可不缩放，也不能让 NaN 混进 CSS 让整条声明作废
  if (!Number.isFinite(z) || Math.abs(z - 1) < 1e-9) return ''
  const v = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))
  return ` style="zoom:${v.toFixed(3)}"`
}

/**
 * 从已经生成的 HTML 里抽出每页 .world 的**内联 transform**，以及页数。
 *
 * 这是给「加了缩放但版面和分页一个字都没变」这条不变式用的**结构化提取**：
 * 用正则把真正的字段抠出来比对，而不是拿整篇 HTML 做 equals —— 整篇里必然
 * 多了缩放容器的 style、底部控制条和一段脚本，比整篇等于把新功能本身也算成回归。
 *
 * 【为什么是「先找 .world 开标签，再取到它自己的 `>`」而不是直接贪婪匹配】
 * 开标签后面紧跟的是整段每页内容（里面成千上万个 `>`），正则一口气吃到行尾
 * 会把 `<path ...>` 也算进 tag 里。这里的 while + lastIndex 语义是「从每个
 * `<div class="world"` 往后找到**紧邻的那个** `>`」，正好是标签边界；
 * 标签内部没有 `>`（属性值里也不会出现，转义过的 `&gt;` 不参与匹配）。
 */
export function worldTransformStyles(html) {
  const s = String(html || '')
  const out = []
  const re = /<div class="world"[^>]*style="([^"]*)"/g
  let m
  while ((m = re.exec(s))) out.push(m[1].replace(/^transform:/, ''))
  return out
}

/** 页数：只数正文里的分页 section，不会被别处的同名字面量骗到 */
export function countPages(html) {
  return ((String(html || '').match(/<section class="page" data-page=/g) || [])).length
}

/**
 * 预览页的缩放脚本 —— 一次性页面，所以是字符串 + 内联 script，没有 React。
 *
 * 【为什么普通滚轮是**缩放**而不是翻页】
 * 用户原话：「打印之后会出现一个预览界面，滚轮键还是不能放大和缩小，它是上下
 * 滚轮」。所以要的是滚轮直接缩放。代价是滚轮不再翻页，于是另外补一条平移入口：
 * 按住空白**拖拽**（pointer 事件，鼠标和手指同一套代码），以及需要时用滚动条。
 *
 * 【ctrlKey 的滚轮也缩放，是因为它本来就是同一个意思】
 * 触控板捏合被浏览器伪装成 `ctrlKey === true` 的 wheel；桌面浏览器的
 * Ctrl + 滚轮是「缩放」的通用手势（本文件旧注释里也是这么写的）。
 * 两者归一：看到 ctrlKey 就换更细的触控板步长。同时必须 preventDefault ——
 * 否则桌面浏览器把 Ctrl+滚轮当成「整页缩放」，整页（含左侧缩放条）一起变大，
 * 既和我们对 .mf-print-pages 的缩放打架，也和白纸版面打架。
 *
 * 【@media print 里为什么不需要给 zoom 写复位】
 * 唯一的样式出口是 .mf-print-pages 上的**内联** zoom，内联声明打死 @media 里的
 * 任何规则，所以纸上要复原只能靠脚本（beforeprint → 1，afterprint → 用户值）。
 * 但打印这件事不依赖脚本：@page{size:A4 landscape;margin:10mm} + .page 的
 * 物理宽高 + break-after 已经把每页钉死在纸上，脚本没跑起来（被 CSP 拦、
 * 老 WebView 不支持 zoom）时纸上的后果只是「内容按屏幕缩放画、被 .page 的
 * overflow:hidden 裁掉」—— 那是最难看的失败方式，所以脚本里 beforeprint 的
 * 复位要写在**第一行**，宁可早不能晚。真正的兜底是 PRINT_CSS 里那条
 * `@media print{.mf-print-pages{zoom:1!important}}`：内联样式在**没有**
 * !important 时斗不过它，用户手写的 style="" 也一样被压住。
 *
 * 【为什么拖拽不做惯性/边界】
 * 这一页最多几十页纸、内容全是静态的，惯性只会让人找不到刚才看的那页；
 * 不做边界则是因为负方向也能拖（页边距外是白的，拖出去不算迷路）。
 */
const PRINT_ZOOM_JS = `
(function(){
  'use strict';
  var MIN=${MIN_ZOOM},MAX=${MAX_ZOOM},WHEEL=${WHEEL_STEP},TPAD=${TRACKPAD_WHEEL_STEP},BTN=${ZOOM_BTN_FACTOR};
  var pages=document.getElementById('mf-pages');
  var pct=document.getElementById('mf-pct');
  if(!pages)return;
  var z=1,spacer=null;
  // 三位小数：和 PRINT_SCALE1_STYLE 同一个口径，浮点毛刺不进 CSS
  function f(n){return Math.round(n*1000)/1000}
  function apply(){
    pages.style.zoom=z===1?'':String(f(z));
    if(pct)pct.textContent=Math.round(z*100)+'%';
    /*
     * 撑开可滚动区域。缩小到 z 倍后，内容只占原来的 z 倍高度，能滚到的位置
     * 也跟着少 —— 后面几页再也滚不到（z=0.5 时滚动量只剩一半）。
     *
     * 【必须写 px，不能写百分比】
     * 要补的差额 = 未缩放高度 H - 已缩放高度 Hz = H(1-z)。
     * 一开始写的是「height:(1/z-1)×100%」，数学上等价，但**在真实浏览器里等于没写**：
     * 百分比高度是相对包含块（body）的高度解析的，而 body 的高度是 auto
     * （内容撑出来的），CSS 规定这时百分比高度按 auto 处理 → 占位实际高度 0。
     * 实测（真 Edge）缩到 0.35 时文档滚动高仍是 900px（= 视口高），
     * 三页里有两页滚不到；node 里的 DOM 桩没有布局引擎，这条**测不出来**。
     * 所以改成量真实高度再算 px：rect.height = z·H，乘 (1/z - 1) 正好是 H(1-z)。
     * 用 ceil 不留小数，宁可多 1px 也不能短 1px。
     */
    var need=1/z-1;
    if(need>0.001){
      if(!spacer){
        spacer=document.createElement('div');
        spacer.className='mf-print-spacer';
        spacer.setAttribute('aria-hidden','true');
        document.body.appendChild(spacer);
      }
      /*
       * 用**写进 CSS 的那个缩放值**（3 位小数）重算一遍，而不是内部那个全精度 z：
       * 浏览器按 style 里的 0.549 排版，拿 0.548812 去算会多补约 1px ——
       * 量出来「补完比未缩放还高一点点」。两边用同一个数，补完正好回到 H。
       */
      var zr=Number(pages.style.zoom)||1;
      spacer.style.height=Math.ceil(pages.getBoundingClientRect().height*(1/zr-1))+'px';
    }else if(spacer){
      spacer.parentNode.removeChild(spacer);
      spacer=null;
    }
  }
  /**
   * 以光标为锚点缩放：缩放前后，光标底下那个点不许动。
   *
   * 推导（x = 内容的文档坐标；用 zoom 缩放后，文档坐标本身就是 z·x；
   *      视觉坐标 = 文档坐标 - 滚动量，光标在视觉坐标 e 处）：
   *   缩放前：x·z0 - v0 = e   →   x = (e + v0) / z0
   *   缩放后要求同一个 x 还在 e 处：x·z1 - v1 = e
   *   → v1 = x·z1 - e = (e + v0)·k - e        （k = z1/z0）
   *
   * 【为什么不是「e - k·(e - v0)」】
   * 那个写法看着更顺眼（「光标到滚动起点的距离按比例缩」），但符号是反的：
   * 它把 k 作用在「滚动量」上，而真正要按 k 缩的是「光标在内容里的位置」。
   * 实测（e=500, v0=0, k=2，放大一倍）：正确解 v1 = 500，让 x=500 的内容点
   * 停在光标下；错解给 -500（被夹到 0），内容点跑到了视口 1000 处 ——
   * 也就是「越放大，视线越往右下漂」。这一条只有拿**真实浏览器的
   * getBoundingClientRect**去量才会暴露（node 里两个公式都能自洽通过，见坑 106）。
   */
  function setZoom(nz,cx,cy){
    var z0=z;
    nz=Math.max(MIN,Math.min(MAX,nz));
    if(nz===z0)return;
    var v0=Math.max(0,window.scrollX||0),w0=Math.max(0,window.scrollY||0);
    z=nz;
    apply();
    var k=z/z0;
    var v1=(v0+cx)*k-cx,w1=(w0+cy)*k-cy;
    var maxV=Math.max(0,document.documentElement.scrollWidth-window.innerWidth);
    var maxW=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);
    window.scrollTo(Math.min(maxV,Math.max(0,Math.round(v1))),Math.min(maxW,Math.max(0,Math.round(w1))));
  }
  function wheel(e){
    var d=e.deltaY;
    /*
     * deltaMode：0=像素（Chrome/Edge/Safari），1=行（Firefox 的滚轮给 3 行），
     * 2=页。不归一的话 Firefox 一格只走 3×0.0015，缩放几乎不动 ——
     * 同一个手势在两个浏览器里差 33 倍。
     */
    if(e.deltaMode===1)d*=16;else if(e.deltaMode===2)d*=window.innerHeight||800;
    // 横向滚轮（触控板左右扫）不参与缩放：没有纵向意图就不该动画面
    if(d===0)return;
    e.preventDefault();
    // ctrlKey = 触控板捏合（浏览器伪装）/ 桌面 Ctrl+滚轮，两件事同一个动作
    var s=e.ctrlKey?TPAD:WHEEL;
    setZoom(z*Math.exp(-d*s),e.clientX,e.clientY);
  }
  pages.addEventListener('wheel',wheel,{passive:false});
  // 兜底再挂一次：万一有东西把 pages 上的监听吞掉，页面级监听仍然生效
  window.addEventListener('wheel',function(e){if(e.defaultPrevented)return;wheel(e)},{passive:false});
  var zi=document.getElementById('mf-zin'),zo=document.getElementById('mf-zout');
  if(zi)zi.addEventListener('click',function(){setZoom(z*BTN,window.innerWidth/2,window.innerHeight/2)});
  if(zo)zo.addEventListener('click',function(){setZoom(z/BTN,window.innerWidth/2,window.innerHeight/2)});
  window.addEventListener('keydown',function(e){
    if(!(e.ctrlKey||e.metaKey))return;
    var k=e.key;
    if(k==='='||k==='+'){e.preventDefault();setZoom(z*BTN,window.innerWidth/2,window.innerHeight/2)}
    else if(k==='-'||k==='_'){e.preventDefault();setZoom(z/BTN,window.innerWidth/2,window.innerHeight/2)}
    else if(k==='0'){e.preventDefault();setZoom(1,window.innerWidth/2,window.innerHeight/2)}
  });
  /* 双击复位 100% */
  document.addEventListener('dblclick',function(){setZoom(1,window.innerWidth/2,window.innerHeight/2)});
  /*
   * 拖拽平移。用 pointer 事件而不是 mouse/touch 两套：一根手指和一个鼠标
   * 走同一条代码路径（Canvas.jsx 的拖拽也是这么做的，包括 setPointerCapture
   * 要包 try/catch —— 指针已经释放时它会抛 NotFoundError）。
   */
  var drag=null;
  function cap(id){try{pages.setPointerCapture(id)}catch(err){}}
  document.addEventListener('pointerdown',function(e){
    if(e.button!==0&&e.button!==1)return;
    /*
     * 点在按钮/缩放条上不启动平移。这些是 <button>，浏览器不会因为
     * preventDefault 就不派发 click（click 的派发在 pointerup 之后、
     * 不受 pointerdown 的影响），所以这里放行它们是安全的。
     */
    if(e.target&&e.target.closest&&e.target.closest('.mf-print-fab,.mf-print-zoom'))return;
    drag={id:e.pointerId,x:e.clientX,y:e.clientY,sx:Math.max(0,window.scrollX||0),sy:Math.max(0,window.scrollY||0)};
    cap(e.pointerId);
  });
  window.addEventListener('pointermove',function(e){
    if(!drag||e.pointerId!==drag.id)return;
    /*
     * 拖拽期间必须拦住原生行为。触摸设备上 pointerdown 的默认动作是
     * 「滚动/交给合成器做手势」，不拦的话手指拖拽会变成橡皮筋或页面回弹，
     * 而 pointermove 照样派发、我们又在滚 —— 两个滚动源互相打架会抖。
     * 实测 headless Edge 模拟触摸下，只有 pointerdown 掉进合成器时
     * pointermove 才会断；touch-action:none 从源头把这条路堵死（见 PRINT_CSS）。
     */
    e.preventDefault();
    window.scrollTo(Math.max(0,Math.round(drag.sx-(e.clientX-drag.x))),
                     Math.max(0,Math.round(drag.sy-(e.clientY-drag.y))));
  },{passive:false});
  function end(e){if(drag&&(!e||e.pointerId===drag.id))drag=null}
  window.addEventListener('pointerup',end);
  window.addEventListener('pointercancel',end);
  window.addEventListener('blur',function(){drag=null});
  /*
   * 打印前把屏幕缩放中和掉、打印后还原：内联 zoom 打死 @media 里的规则，
   * 所以纸上那一条只能靠这里。用 beforeprint/afterprint 而不是 onbeforeprint
   * 属性 —— 属性赋值会覆盖掉别处可能已经挂上的处理函数。
   */
  var before=null;
  function neutralize(){
    if(before===null)before=z;
    pages.style.zoom='';
  }
  function restore(){if(before===null)return;z=before;before=null;apply()}
  window.addEventListener('beforeprint',neutralize);
  window.addEventListener('afterprint',restore);
  // 老 WebView 不派发 beforeprint/afterprint，退回 matchMedia 兜底
  if(window.matchMedia){
    var mq=window.matchMedia('print');
    var on=(m)=>{(m.matches?neutralize:restore)()};
    if(mq.addEventListener)mq.addEventListener('change',on);
    else if(mq.addListener)mq.addListener(on);
  }
  apply();
})();
`

/**
 * 生成打印视图的完整 HTML。
 *
 * 每页都是「一个固定尺寸的窗口 + 整张图按偏移平移进去」：不能用 CSS transform
 * 把整张图缩小后交给浏览器自动分页 —— transform 不参与分页计算，浏览器会按
 * **未缩放**的高度切页，切出来的每一页内容都是错位的。所以分页自己算，
 * 每页只画落在这页范围内的节点和连线。
 *
 * `autoPrint` 默认 false：打印视图打开时**不要**自己弹打印对话框。
 * 浏览器里没有「直接生成 PDF 文件」的接口，唯一的出口就是打印对话框里的
 * 「另存为 PDF」，而这个对话框一旦被自动唤起就会抢走焦点、盖住刚打开的这一页，
 * 用户来不及看就被要求点确定。所以改成页面右上角挂一颗图标按钮（只显示在屏幕上，
 * 打印时隐藏），由用户看过之后再自己点。
 *
 * 【关于 viewport meta】
 * 这一页主要在桌面浏览器/桌面壳里看，但要有手机端的两条兜底：
 *   · 不加 viewport meta，手机会按 980px 虚拟宽度渲染 —— 整张 A4 横页被压成
 *     一小块、字全糊（这一页是给人核对版面的，糊了就白看）。
 *   · 刻意**不写** `user-scalable=no`：页宽是 277mm（约 1047px），手机上一定
 *     要能双指放大才看得清细节，禁掉缩放等于禁止核对。
 *
 * @param autoPrint 只有测试和「一键直出」场景才传 true，会额外注入 load 后自动打印
 * @returns {{html: string, pageCount: number, scale: number, chartCount: number}}
 */
export function buildPrintHtml({ name = '', layout, autoPrint = false } = {}) {
  const { scale, pageWorldH, pages } = printPages(layout)
  const { nodes, edges, relationEdges, hiddenTreeTo, charts, byId } = layout

  const minX = layout.boxes.reduce((m, b) => Math.min(m, b.x), 0)
  const minY = layout.boxes.reduce((m, b) => Math.min(m, b.y), 0)
  // 图比版心窄时左右居中；比版心宽时按比例缩小（scale < 1）
  const shiftX = (PAGE.contentW - layout.width * scale) / 2

  /*
   * 所有页外面套一层容器 —— **只为了屏幕缩放**，没有别的用途。
   *
   * 【为什么不把缩放写在 .page 上】
   * .page 的宽高（277×190mm）就是纸的物理尺寸，@page 的 margin 和分页都建立在
   * 它上面。动等于动版面。
   *
   * 【为什么不用 body 当缩放容器】
   * html/body 上挂 transform 会让 Chrome 把 body 提升成 containing block，
   * 连带改掉 position:fixed 元素的固定基准：右上角那颗 .mf-print-fab
   * 会从「永远钉在屏幕右上角」变成「钉在 body 右上角」，页数一多它能跑出屏幕。
   * 所以缩放**只落在 body 内部这一层普通 div 上**，fixed 的基准一个像素都不变。
   *
   * 【为什么默认空字符串，而不是 zoom:1 / transform:none】
   * 默认这一页必须与改动前**逐字节相同**（默认外观逐像素一致），所以 style 在
   * scale===1 时整个不存在；顺带也挡住了 `zoom` 一旦被认成非法值让整条声明作废。
   */
  const zoomStyle = PRINT_SCALE1_STYLE(1)
  const pageHtml = `<div class="mf-print-pages" id="mf-pages"${zoomStyle}>${pages
    .map((p, i) => {
      const top = p.top
      const bottom = p.top + p.height
      // 边界外留一点余量：正好压在切线上、被切掉一半的盒子也要画出来
      const M = 80
      const visNodes = nodes.filter((n) => n.y + n.h > top - M && n.y < bottom + M)
      const visCharts = charts.filter((c) => c.y + c.h > top - M && c.y < bottom + M)
      const visEdges = edges.filter((e) => {
        if (hiddenTreeTo.has(e.to)) return false
        const a = byId.get(e.from)
        const b = byId.get(e.to)
        if (!a || !b) return false
        return spans(a, b, top - M, bottom + M)
      })
      const visRel = relationEdges.filter((r) => spans(r.a, r.b, top - M, bottom + M))

      const tx = shiftX - minX * scale
      const ty = -(minY + top) * scale
      const arrow = `mf-arrow-${i}`

      return `<section class="page" data-page="${i + 1}">
<div class="world" style="transform:translate(${round(tx)}px,${round(ty)}px) scale(${round(scale, 4)})">
<svg class="mf-print-edges" width="${round(layout.width)}" height="${round(layout.height)}" viewBox="0 0 ${round(layout.width)} ${round(layout.height)}">
<defs><marker id="${arrow}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#c8ced7"/></marker></defs>
${visEdges.map((e) => `<path class="mf-print-edge" data-edge="${esc(e.from)}&gt;${esc(e.to)}" d="${edgePath(byId.get(e.from), byId.get(e.to))}"/>`).join('')}
${visRel.map((r) => `<path class="mf-print-edge" data-rel="${esc(r.from)}&gt;${esc(r.to)}" d="${edgePath(r.a, r.b)}" marker-end="url(#${arrow})"/>`).join('')}
${visCharts.map((c) => leaderPath(c)).join('')}
</svg>
${visNodes.map((n) => nodeHtml(n)).join('')}
${visCharts.map((c) => `<div class="mf-print-chart" data-chart-for="${esc(c.id)}" style="left:${round(c.x)}px;top:${round(c.y)}px;width:${round(c.w)}px;height:${round(c.h)}px">${normalizeSvg(c.svg)}</div>`).join('')}
</div>
</section>`
    })
    .join('\n')}</div>`

  const title = esc(name || '导图')
  /*
   * 右上角一颗**只有图标**的按钮：屏幕上用来触发打印，纸上不存在。
   *
   * 【为什么不写文字】
   * 用户原话：「保存或打印搞一个按钮就行了，放在右上角，字去掉，保持干净」。
   * 于是不再有「N 页 · 导图 + N 张流程图」和「去打印对话框里选另存为 PDF」那两行说明。
   *
   * 【为什么这是更稳的结构】
   * position:fixed 的元素**不参与排版**，所以再不需要给 body 留让位内边距了。
   * 之前那条 44px 高的工具栏必须和 body 的 padding-top 对上，一旦对不上
   * （实测工具栏自然撑成 58px、内边距按 54px 写的）就会压住第一页 4px。
   * 现在这个耦合从根上没有了 —— 按钮浮在页面右上角，与版面完全无关。
   */
  const bar = autoPrint ? ''
    : `<button type="button" class="mf-print-fab" onclick="window.print()"`
      + ' title="打印 / 保存为 PDF" aria-label="打印 / 保存为 PDF">'
      + `${PRINT_ICON}</button>`
  /*
   * 缩放控制条：**放在左下角**，刻意不与右上角那颗打印按钮同侧。
   * 两者都是 position:fixed，同一侧就要靠 top 堆叠来错开，页数、字号、
   * 百分比的宽度一变就会叠在一起 —— 分开放是「结构上不可能打架」。
   * 下面那句「滚轮缩放 · 拖拽平移」同时是**入口说明**：滚轮被缩放占用、
   * 翻页改成了拖拽，这件事不写出来没人猜得到。
   */
  const zoomBar = autoPrint ? ''
    : `<div class="mf-print-zoom" id="mf-zoom">`
      + '<span class="mf-print-pct" id="mf-pct">100%</span>'
      + '<button type="button" id="mf-zout" title="缩小 (Ctrl + −)" aria-label="缩小">&#8722;</button>'
      + '<button type="button" id="mf-zin" title="放大 (Ctrl + +)" aria-label="放大">+</button>'
      + '<span class="mf-print-hint">滚轮缩放 · 拖拽平移</span>'
      + '</div>'
  /*
   * autoPrint（一键直出）时完全不注入脚本：那条路是一次性的、没人会去点，
   * 多一段脚本只会多一个出错的地方。于是「不自动弹对话框」那条断言里的
   * window.onload / setTimeout(print) 仍然是唯一的 onload 来源。
   */
  const zoomScript = autoPrint ? '' : `<script>${PRINT_ZOOM_JS}<\/script>`
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<style>${PRINT_CSS}</style></head>
<body>
${bar}
${zoomBar}
${pageHtml}
${zoomScript}
${autoPrint ? '<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>' : ''}
</body></html>`

  return { html, pageCount: pages.length, scale, chartCount: charts.length, pageWorldH }
}

function spans(a, b, lo, hi) {
  const y0 = Math.min(a.y, b.y)
  const y1 = Math.max(a.y + a.h, b.y + b.h)
  return y1 > lo && y0 < hi
}

/**
 * 节点 → 流程图的那条虚线引线。
 *
 * 起点是节点底边中点；终点是**图的上边缘**，横坐标夹在图自己的横向范围内
 * （两边各留 10px）。图被往左挪过时（见 chartX），引线就是一条斜线 ——
 * 这正是它存在的意义：图可以不在节点正下方，但归属必须看得清。
 */
function leaderPath(c) {
  const nx = c.node.x + c.node.w / 2
  const cx = Math.min(Math.max(nx, c.x + 10), c.x + c.w - 10)
  return `<line class="mf-print-leader" x1="${round(nx)}" y1="${round(c.node.y + c.node.h)}"`
    + ` x2="${round(cx)}" y2="${round(c.y)}"/>`
}

function nodeHtml(n) {
  const fs = n.depth === 0 ? 15 : 14
  const extra = `${n.node.bold ? 'font-weight:600;' : ''}${n.node.italic ? 'font-style:italic;' : ''}`
  return `<div class="mf-print-node" data-node-id="${esc(n.id)}" style="left:${round(n.x)}px;top:${round(n.y)}px;width:${round(n.w)}px;height:${round(n.h)}px"><span class="t" style="font-size:${fs}px;${extra}">${esc(n.node.text)}</span></div>`
}

const round = (v, d = 2) => {
  const p = Math.pow(10, d)
  return Math.round(v * p) / p
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

/**
 * 纯白、无页眉页脚、无页码。
 * 版心尺寸必须和 PAGE 里的像素值一致：打印时 1in = 96px，mm 和 px 是死换算。
 *
 * 【流程图盒子为什么没有 padding】
 * svg 被撑成 width/height:100%，盒子内容区一旦比 viewBox 更扁（多了 6px 内边距
 * 就会），preserveAspectRatio 的 meet 会**再缩一次** —— 扁图白丢 47% 的尺寸。
 * 所以盒子内容区必须严格等于 viewBox 的长宽比（见 chartSize），只留 1px 边框，
 * 这点误差对最扁的图也只有 3%。
 */
const PRINT_CSS = `
@page{size:A4 landscape;margin:10mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body{color:#1f2328;font:14px/1.4 Inter,system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
.page{position:relative;overflow:hidden;width:${PAGE.wMm - 2 * PAGE.marginMm}mm;height:${PAGE.hMm - 2 * PAGE.marginMm}mm;background:#fff;break-after:page;page-break-after:always}
.page:last-child{break-after:auto;page-break-after:auto}
.world{position:absolute;left:0;top:0;transform-origin:0 0}
.mf-print-edges{position:absolute;left:0;top:0;overflow:visible}
/*
 * 打印用比屏幕深一档的灰：白主题的 --mf-edge 是 #e8e8ea（91% 亮度），
 * 在屏幕上是「极浅灰柔和曲线」，落到纸上几乎看不见。
 */
.mf-print-edge{fill:none;stroke:#c8ced7;stroke-width:1.6;stroke-linecap:round}
.mf-print-leader{fill:none;stroke:#b9c0c9;stroke-width:1;stroke-dasharray:4 4}
.mf-print-node{position:absolute;display:flex;align-items:center;border:1px solid #dee2e7;border-radius:8px;background:#fff;padding:0 12px;overflow:hidden}
.mf-print-node .t{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;width:100%;line-height:18px}
.mf-print-chart{position:absolute;display:flex;align-items:center;justify-content:center;border:1px solid #e3e6ea;border-radius:10px;background:#fff;overflow:hidden}
.mf-print-chart svg{display:block;width:100%!important;height:100%!important;max-width:none!important}
/*
 * 右上角那颗打印按钮：只给屏幕。position:fixed 不参与排版，所以**不需要**给 body
 * 留让位内边距（那条内边距一旦和按钮实际高度对不上就会压住第一页）。
 * 纸上 display:none —— 每页多一颗按钮就是每页一块脏东西。
 *
 * 【手机上的两个细节】
 *   · top/right 都加上安全区：刘海屏 / 挖孔屏上写死 12px 会落在状态栏底下，
 *     按钮被切一半。桌面浏览器里 env() 取不到值、回退 0px，还是 12px。
 *   · 触摸设备把热区放到 44×44（WCAG 建议值）：36px 对拇指偏小，
 *     而这一颗是整页唯一的操作入口，点不中就什么都干不了。
 *     用 pointer:coarse 而不是宽度断点 —— 手机横屏也宽，但依然是手指在点。
 */
.mf-print-fab{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));right:calc(12px + env(safe-area-inset-right,0px));z-index:9;display:flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:1px solid #cfd6de;border-radius:10px;background:#fff;color:#1f2328;cursor:pointer;box-shadow:0 1px 3px rgba(16,24,40,.12)}
.mf-print-fab:hover{background:#eef1f5}
.mf-print-fab svg{display:block}
@media (pointer:coarse){.mf-print-fab{width:44px;height:44px}}
/*
 * 所有页的容器，**也是屏幕上唯一被缩放的那一层**。
 * transform-origin 用默认值：祖先链上没有任何 transform/filter/perspective，
 * 所以这里就是「左上角」，光标锚点的公式正是按左上角原点推的。
 *
 * width:fit-content 是给触摸设备让路的：body 宽 390px 而一页宽 277mm（1047px），
 * 不收缩的话容器的可点区域是 1047px，右边那 657px 落在别的元素上 ——
 * touch-action:none 也就跟着失效，手指从右侧空白处拖拽会变成浏览器滚动。
 * 收缩到内容宽之后（:has 不被支持时退化成块级满宽，只影响手机拖拽起点），
 * 容器正好盖住纸张本身。
 *
 * touch-action:none 只在指针粗的设备上开：它是「这一页永远不做浏览器手势」，
 * 在手机上正好（双指缩放内容是脚本的缩放，不是页面的双指缩放）。
 * 桌面端刻意留着 —— 桌面靠「页面级双指缩放」没有任何意义，但留着不动
 * 能让改动更小，也让浏览器自己的滚动条/键盘翻页照旧可用。
 */
.mf-print-pages{width:100%}
.mf-print-pages:has(> .page){width:fit-content}
/*
 * 【为什么 touch-action:none 必须写】
 * 触摸设备上 pointerdown 的默认动作是「交给合成器做滚动手势」，浏览器一旦接管，
 * 后续 pointermove 就断供，我们的拖拽平移会变成半死不活的橡皮筋。
 * 只要这一层把浏览器手势关掉，拖拽就完全归脚本 —— 桌面端不写（鼠标没有这个问题，
 * 手写板/触摸屏笔记本也仍然能用滚动条）。
 * 【为什么只给粗指针设备】
 * 手机上这一层就是「纸张」本身，关掉浏览器手势是好事；桌面写字楼场景里
 * 双指缩放整页、Ctrl+滚轮调浏览器缩放都还有用，没必要一起没收。
 */
@media (pointer:coarse){.mf-print-pages{touch-action:none}}
/*
 * 缩小到 z 倍后，内容占的高度只有原来的 z，滚动条能滚到的位置也跟着少 ——
 * 后面几页就滚不到了。这块占位由脚本按「实际内容高 × (1/z - 1)」撑成 px 高度
 * （不能写百分比：body 高度是 auto，百分比高度会按 auto 处理，等于不生效）。
 * 屏幕外的东西，不参与打印。
 */
.mf-print-spacer{width:1px}
/*
 * 缩放控制条：左下角（右上角那颗是打印按钮，刻意不同侧）。
 * position:fixed 不参与排版，所以它和 body 的内边距毫无关系 ——
 * 这条解耦在本文件里是既有做法（见 .mf-print-fab 的注释）。
 */
.mf-print-zoom{position:fixed;left:calc(12px + env(safe-area-inset-left,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9;display:flex;align-items:center;gap:8px;padding:4px 6px;border:1px solid #cfd6de;border-radius:10px;background:rgba(255,255,255,.94);box-shadow:0 1px 3px rgba(16,24,40,.12);font-size:12px;line-height:1;color:#5b636d}
.mf-print-zoom button{width:26px;height:26px;padding:0;border:1px solid #cfd6de;border-radius:7px;background:#fff;color:#1f2328;font:inherit;font-size:15px;line-height:1;cursor:pointer}
.mf-print-zoom button:hover{background:#eef1f5}
/*
 * 百分比固定宽度：数字从 100% 变到 50% 时宽度一变，右边的按钮就会横着跳。
 * 用 min-width + 等宽数字把这一格钉死。
 */
.mf-print-pct{min-width:40px;text-align:center;font-variant-numeric:tabular-nums;color:#1f2328}
.mf-print-hint{white-space:nowrap;color:#8a929b}
/* 手机上按不出「滚轮」，那半句提示是噪音（手指看到的是拖拽平移） */
@media (pointer:coarse){.mf-print-hint{display:none}.mf-print-zoom button{width:36px;height:36px}}
@media print{html,body{background:#fff!important}.mf-print-fab{display:none!important}.mf-print-zoom{display:none!important}.mf-print-spacer{display:none!important}.mf-print-pages{zoom:1!important;width:auto!important}}
`
