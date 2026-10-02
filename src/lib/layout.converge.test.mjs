/**
 * 汇聚布局自检（「指向同一结果」的多对一排版）
 * 用法：node src/lib/layout.converge.test.mjs
 *
 * 【这个文件在测什么】
 * 需求：汇聚节点 C 不能被排到源节点 A、B 的上下两端或屏幕边缘，
 * 而必须落在 A、B 的**垂直中间**，且 X 稳稳落在源节点的右侧下一层。
 *
 * 这里直接对纯布局函数下手 —— 不启动浏览器、不渲染 SVG，
 * 因此每条断言都是确定的数值关系，不依赖时序。
 */
import { layoutTree, boundsOf, edgePath, convergenceGroups, NODE_H, GAP_X, GAP_Y } from './layout.js'
import { makeNode } from './model.js'
import { convergeToNewNode } from './treeOps.js'

let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}

/** 中心 y（布局里 y 是左边缘，节点高固定 NODE_H） */
const cy = (n) => n.y + n.h / 2

/**
 * 搭一棵树：
 *   root
 *     ├ a
 *     ├ b
 *     └ c        ← 汇聚节点（追加在末尾，正是会被排到底部的那个）
 * 再补上 a→c、b→c 两条汇聚关系。
 */
function buildTwoToOne() {
  const root = makeNode('root')
  const a = makeNode('A')
  const b = makeNode('B')
  const c = makeNode('C')
  root.children = [a, b, c]
  const relations = [
    { from: a.id, to: c.id },
    { from: b.id, to: c.id },
  ]
  return { root, a, b, c, relations, ids: { a: a.id, b: b.id, c: c.id } }
}

console.log('\n[1] 汇聚节点 Y 轴居中于源节点')

{
  const { root, relations, ids } = buildTwoToOne()
  const noRel = layoutTree(root, { includeRoot: true })
  const withRel = layoutTree(root, { includeRoot: true, relations })

  const cBefore = noRel.byId.get(ids.c)
  const cAfter = withRel.byId.get(ids.c)
  const a = withRel.byId.get(ids.a)
  const b = withRel.byId.get(ids.b)

  check('不传 relations 时保持旧行为（C 排在 A、B 之下）',
    cBefore.y > a.y && cBefore.y > withRel.byId.get(ids.b).y,
    `cBefore.y=${cBefore.y}`)

  check('传了 relations 后 C 的中心严格等于 A、B 中心的中点',
    Math.abs(cy(cAfter) - (cy(a) + cy(b)) / 2) < 0.001,
    `cy(C)=${cy(cAfter)} 期望=${(cy(a) + cy(b)) / 2}`)

  check('C 不再被挤到底部（它的中心不高于 B 的中心）',
    cy(cAfter) <= cy(b) + 0.001, `cy(C)=${cy(cAfter)} cy(B)=${cy(b)}`)

  check('C 不再被挤到顶部（它的中心不低于 A 的中心）',
    cy(cAfter) >= cy(a) - 0.001, `cy(C)=${cy(cAfter)} cy(A)=${cy(a)}`)

  check('A、B 自身的位置没有被改动（只挪汇聚节点）',
    a.y === noRel.byId.get(ids.a).y && b.y === noRel.byId.get(ids.b).y)
}

console.log('\n[2] X 轴层级对齐')

{
  const { root, relations, ids } = buildTwoToOne()
  const l = layoutTree(root, { includeRoot: true, relations })
  const c = l.byId.get(ids.c)
  const a = l.byId.get(ids.a)
  const b = l.byId.get(ids.b)

  check('C 落在源节点的右侧（x 严格更大）',
    c.x > a.x && c.x > b.x, `c.x=${c.x} a.x=${a.x}`)

  // 需求的公式：源节点那一列 + 列宽 + GAP_X
  const expectX = a.x + a.w + GAP_X
  check('C 的 x = 源节点列 + 列宽 + GAP_X（固定层间距）',
    c.x === expectX, `c.x=${c.x} 期望=${expectX}`)

  check('C 与源节点同 depth（树结构未被改动）',
    c.depth === a.depth && c.depth === b.depth,
    `c.depth=${c.depth} a.depth=${a.depth}`)

  // 跨层场景：A 是 B 的祖先
  const r2 = makeNode('root')
  const up = makeNode('上游')
  const down = makeNode('下游')
  up.children = [down]
  const sink = makeNode('汇')
  r2.children = [up, sink]
  const cross = layoutTree(r2, {
    includeRoot: true,
    relations: [{ from: up.id, to: sink.id }, { from: down.id, to: sink.id }],
  })
  const ld = cross.byId.get(down.id)
  const ls = cross.byId.get(sink.id)
  check('跨层汇聚时 C 落在最深源节点的右侧（连线不会倒着画）',
    ls.x > ld.x, `sink.x=${ls.x} down.x=${ld.x}`)
}

console.log('\n[3] 防跨屏：紧凑的倒三角形')

{
  // 造一个「源节点分居很开」的场景，验证汇聚点不会横跨整个画布
  const root = makeNode('root')
  const a = makeNode('A')
  const mid = makeNode('中间分支')
  const b = makeNode('B')
  root.children = [a, mid, b]
  // 给中间分支挂很多子节点，把 A 和 B 在垂直方向撑得很远
  mid.children = Array.from({ length: 12 }, (_, i) => makeNode(`m${i}`))
  const c = makeNode('C')
  root.children.push(c)
  const relations = [{ from: a.id, to: c.id }, { from: b.id, to: c.id }]

  const l = layoutTree(root, { includeRoot: true, relations })
  const la = l.byId.get(a.id)
  const lb = l.byId.get(b.id)
  const lc = l.byId.get(c.id)

  check('C 的中心落在 A、B 中心之间（源很远时也一样）',
    cy(lc) >= Math.min(cy(la), cy(lb)) - 0.001 &&
    cy(lc) <= Math.max(cy(la), cy(lb)) + 0.001,
    `cy(C)=${cy(lc)} 区间=[${Math.min(cy(la), cy(lb))}, ${Math.max(cy(la), cy(lb))}]`)

  /*
   * 连线的水平跨度 = 源节点右边缘 → C 左边缘。
   *
   * C 落在源节点**所在列的右侧紧邻一列**，所以跨度 = (本列最宽节点 - 本节点)
   * + GAP_X。它只取决于「这一列有多宽」，**与两个源节点相距多远完全无关** ——
   * 这正是「不横跨画布」的保证：把 A、B 撑开 10 倍，跨度一分不变。
   */
  const colW = Math.max(...l.nodes.filter((n) => n.depth === la.depth).map((n) => n.w))
  const spanA = lc.x - (la.x + la.w)
  const spanB = lc.x - (lb.x + lb.w)
  const maxSpan = colW - Math.min(la.w, lb.w) + GAP_X
  check('A 的连线跨度 = 列内余量 + GAP_X（只取决于列宽）',
    Math.abs(spanA - (colW - la.w + GAP_X)) < 0.001,
    `spanA=${spanA} 期望=${colW - la.w + GAP_X}`)
  check('B 的连线跨度同理', Math.abs(spanB - (colW - lb.w + GAP_X)) < 0.001,
    `spanB=${spanB} 期望=${colW - lb.w + GAP_X}`)
  check('跨度上界是一个「列宽 + 层间距」的小常数（不会横跨画布）',
    spanA <= maxSpan && maxSpan < 400, `spanA=${spanA} 上界=${maxSpan}`)
  check('两个源节点的连线跨度相同（对称的倒三角）',
    spanA === spanB, `spanA=${spanA} spanB=${spanB}`)
  check('连线跨度远小于源节点之间的垂直距离（不是横跨的长线）',
    spanA < Math.abs(cy(la) - cy(lb)), `spanA=${spanA} 垂直距离=${Math.abs(cy(la) - cy(lb))}`)

  check('画布宽度没有因为汇聚而异常膨胀',
    l.width < 2000, `width=${l.width}`)
}

console.log('\n[4] 边界情形')

{
  // 单源（普通「指向」）不应该被当成汇聚去重排
  const root = makeNode('root')
  const a = makeNode('A')
  const c = makeNode('C')
  root.children = [a, c]
  const single = layoutTree(root, {
    includeRoot: true, relations: [{ from: a.id, to: c.id }],
  })
  const plain = layoutTree(root, { includeRoot: true })
  check('只有一个源时不重排（那是普通「指向」而非汇聚）',
    single.byId.get(c.id).y === plain.byId.get(c.id).y)

  // 悬空关系（端点不在树里）不能崩
  const dangling = layoutTree(root, {
    includeRoot: true,
    relations: [{ from: 'ghost', to: c.id }, { from: a.id, to: 'ghost2' }],
  })
  check('悬空关系不会导致异常，节点数不变',
    dangling.nodes.length === plain.nodes.length)

  // 自环
  const selfLoop = layoutTree(root, {
    includeRoot: true, relations: [{ from: a.id, to: a.id }],
  })
  check('自环被忽略', selfLoop.nodes.length === plain.nodes.length)

  // 空树
  const empty = layoutTree(makeNode('only'), { includeRoot: true, relations: [] })
  check('空 relations 时布局正常', empty.nodes.length === 1)

  // relations 不是数组（防御）
  const bad = layoutTree(root, { includeRoot: true, relations: null })
  check('relations 为 null 时按「无汇聚」处理', bad.nodes.length === plain.nodes.length)

  // 折叠隐藏：源节点被折叠时它自己仍在布局里（只是子树不渲染），不应崩
  const hiddenRoot = makeNode('root')
  const pa = makeNode('A')
  pa.children = [makeNode('a1'), makeNode('a2')]
  pa.collapsed = true
  const pc = makeNode('C')
  hiddenRoot.children = [pa, pc]
  const hidden = layoutTree(hiddenRoot, {
    includeRoot: true, relations: [{ from: pa.id, to: pc.id }],
  })
  check('折叠态下布局仍然可用（单源不触发重排）',
    hidden.nodes.length === 3, `nodes=${hidden.nodes.length}`)
}

console.log('\n[5] 三个及以上源节点')

{
  const root = makeNode('root')
  const srcs = ['A', 'B', 'D'].map(makeNode)
  const c = makeNode('C')
  root.children = [...srcs, c]
  const relations = srcs.map((s) => ({ from: s.id, to: c.id }))
  const l = layoutTree(root, { includeRoot: true, relations })
  const lc = l.byId.get(c.id)
  const centers = srcs.map((s) => cy(l.byId.get(s.id)))

  check('C 的中心落在所有源节点的中心区间内',
    cy(lc) >= Math.min(...centers) - 0.001 && cy(lc) <= Math.max(...centers) + 0.001,
    `cy(C)=${cy(lc)} 区间=[${Math.min(...centers)}, ${Math.max(...centers)}]`)
}

console.log('\n[6] 树结构绝不被布局改动')

{
  const { root, a, b, c, relations } = buildTwoToOne()
  layoutTree(root, { includeRoot: true, relations })
  check('布局是纯函数：children 顺序不变',
    root.children.map((n) => n.id).join(',') === [a, b, c].map((n) => n.id).join(','))
  check('布局是纯函数：父子关系不变',
    root.children.every((n) => n.children === undefined || Array.isArray(n.children)))
}

/* ================================================================== */
console.log('\n[7] 汇聚节点有专属通道：不再和下一列的树节点叠在一起')

/** 任意两个节点框相交的对（横穿的最硬判据） */
function overlapPairs(l) {
  const out = []
  const ns = l.nodes
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i], b = ns[j]
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (ox > 0.01 && oy > 0.01) out.push([a.id, b.id])
    }
  }
  return out
}

/**
 * 通用体检。三条不变量：
 *   1. 节点框互不重叠          —— 「连线/节点直接横穿」的结构性判据
 *   2. 树边永远父在左、子在右   —— 挪动汇聚节点绝不能把自己的树边拽成倒钩
 *   3. 要搬进通道的汇聚点在所有源右侧 —— 「新结果节点跑到左边去」的判据
 *      只对**真的会被搬**的目标成立：不搬的（带子树、通道在它左边的）保持原位，
 *      单源「指向」本来就不重排，它们出现「目标在源左侧」是设计如此，不是 bug。
 */
function audit(name, root, relations) {
  const l = layoutTree(root, { includeRoot: true, relations })
  const ov = overlapPairs(l)
  check(`${name} · 节点框互不重叠`, ov.length === 0,
    ov.map(([p, q]) => `${l.byId.get(p).node.text}×${l.byId.get(q).node.text}`).join(' '))

  const badTree = []
  for (const e of l.edges) {
    const a = l.byId.get(e.from), b = l.byId.get(e.to)
    if (a && b && a.x + a.w > b.x) badTree.push(`${a.node.text}→${b.node.text}`)
  }
  check(`${name} · 树边不倒钩（父永远在子左边）`, badTree.length === 0, badTree.join(' '))

  const mustBeRight = new Set(
    convergenceGroups(l.byId, relations)
      .filter((g) => g.relocate && !g.inCycle)
      .map((g) => g.target.id))
  const badRel = []
  for (const r of relations) {
    const a = l.byId.get(r.from), b = l.byId.get(r.to)
    // 自环永远「落在自己左边」，不是问题；环里的节点无解，见 [16]
    if (!a || !b || r.from === r.to || !mustBeRight.has(b.id)) continue
    if (b.x < a.x + a.w) badRel.push(`${a.node.text}→${b.node.text}`)
  }
  check(`${name} · 汇聚边不倒钩（要搬的汇聚点在源右侧）`, badRel.length === 0, badRel.join(' '))
  return l
}

{
  /*
   * 用户报的「直接横穿」：两个源节点之间夹着一大堆节点，汇聚节点的垂直中点
   * 正好落在下一列的正中间。老实现把它和下一列的树节点摆在**同一个 x** 上，
   * 两个节点框直接重叠（实测各重叠 6px），连线从那一列中间横穿过去。
   */
  const root = makeNode('root')
  const a = makeNode('A')
  const mid = makeNode('中间分支')
  const b = makeNode('B')
  mid.children = Array.from({ length: 12 }, (_, i) => makeNode(`m${i}`))
  root.children = [a, mid, b]
  const c = makeNode('C')
  root.children.push(c)
  const relations = [{ from: a.id, to: c.id }, { from: b.id, to: c.id }]

  const l = audit('两个源之间夹着 12 个节点', root, relations)
  const lc = l.byId.get(c.id)
  const la = l.byId.get(a.id)
  const deep = l.nodes.filter((n) => n.depth === lc.depth + 1)

  check('通道起点仍在「源列 + 列宽 + GAP_X」（连接线跨度没变长）',
    lc.x === la.x + Math.max(...l.nodes.filter((n) => n.depth === 1).map((n) => n.w)) + GAP_X,
    `C.x=${lc.x}`)

  check('下一列整体让开了通道（每个节点都在汇聚节点右边）',
    deep.length > 0 && deep.every((n) => n.x > lc.x + lc.w),
    `C 右边缘=${lc.x + lc.w} 下一列 x=${[...new Set(deep.map((n) => n.x))].join(',')}`)

  check('让开的宽度 = 通道最宽节点 + GAP_X（只让出必需的那一点）',
    deep[0].x === lc.x + lc.w + GAP_X,
    `${deep[0].x} vs ${lc.x + lc.w + GAP_X}`)

  check('让开通道没有动 Y：汇聚点仍是两个源的中点',
    Math.abs(cy(lc) - (cy(la) + cy(l.byId.get(b.id))) / 2) < 0.001)
}

/* ================================================================== */
console.log('\n[8] 链式汇聚：新结果永远在自己的源右侧')

{
  /*
   * 用户报的「新结果节点跑到左边去」。第二层汇聚的源是**第一层的结果节点**，
   * 而它已经被挪到通道里了 —— 老实现按「层号」推列，于是算出来的目标列
   * 正好等于源自己所在的位置：目标左边缘压在源右边缘**左边 98px**，
   * 连线整个掉头往回画。
   */
  const a = makeNode('A')
  const b = makeNode('B')
  const c = makeNode('C')
  const root = makeNode('root')
  root.children = [a, b, c]

  let relations = []
  const r1 = convergeToNewNode(root, relations, a.id, b.id)
  relations = r1.relations
  const r2 = convergeToNewNode(root, relations, r1.newNodeId, c.id)
  relations = r2.relations

  const l = audit('两层链式汇聚', root, relations)
  const n1 = l.byId.get(r1.newNodeId)
  const n2 = l.byId.get(r2.newNodeId)

  check('第二层结果落在第一层结果的右侧（不退 98px）',
    n2.x >= n1.x + n1.w, `n1 右边缘=${n1.x + n1.w} n2.x=${n2.x}`)
  check('两层结果之间正好隔着一个 GAP_X',
    n2.x === n1.x + n1.w + GAP_X, `${n2.x} vs ${n1.x + n1.w + GAP_X}`)

  // 摆到更深的层上去：源节点跨层时也不能算回头
  const deepTree = makeNode('root')
  const x1 = makeNode('X1')
  const x2 = makeNode('X2')
  const deep = makeNode('deep')
  deep.children = [x1, x2]
  const da = makeNode('A')
  const db = makeNode('B')
  deepTree.children = [da, db, deep, makeNode('tail1'), makeNode('tail2')]
  let rel2 = []
  const q1 = convergeToNewNode(deepTree, rel2, da.id, db.id)
  rel2 = q1.relations
  const q2 = convergeToNewNode(deepTree, rel2, q1.newNodeId, x2.id)
  rel2 = q2.relations
  const l2 = audit('跨层链式汇聚', deepTree, rel2)
  const m1 = l2.byId.get(q1.newNodeId)
  const m2 = l2.byId.get(q2.newNodeId)
  const mx2 = l2.byId.get(x2.id)
  check('跨层链式：新结果在最深的源右侧',
    m2.x >= mx2.x + mx2.w, `X2 右边缘=${mx2.x + mx2.w} 新结果=${m2.x}`)
  check('跨层链式：新结果在第一层结果右侧',
    m2.x >= m1.x + m1.w, `N1 右边缘=${m1.x + m1.w} N2=${m2.x}`)
}

/* ================================================================== */
console.log('\n[9] 同一对源的多个汇聚点：并排，而且每个都在正中间')

{
  /*
   * A、B 同时汇聚到 N1 和 N2（「指向」两次也能做到）。
   *
   * 两者中点完全相同，老实现把它们**上下错开** `节点高 + GAP_Y` ——
   * 结果是第二个不再落在源的中点上了。用户的原话：
   * 「指向同一结果指多了，新结果节点好像不会在中间位置了」（实测偏 56px）。
   * 现在改成横向让开：y 都精确等于中点，靠一条子通道并排。
   */
  const a = makeNode('A')
  const b = makeNode('B')
  const n1 = makeNode('只看这里')
  const n2 = makeNode('再看这里')
  const root = makeNode('root')
  root.children = [a, b, n1, n2]
  const relations = [
    { from: a.id, to: n1.id }, { from: b.id, to: n1.id },
    { from: a.id, to: n2.id }, { from: b.id, to: n2.id },
  ]
  const l = audit('同一对源的多个汇聚点', root, relations)
  const p = l.byId.get(n1.id)
  const q = l.byId.get(n2.id)
  const mid = (cy(l.byId.get(a.id)) + cy(l.byId.get(b.id))) / 2

  check('第一个结果精确落在源的中点', Math.abs(cy(p) - mid) < 0.001, `cy=${cy(p)} 中点=${mid}`)
  check('第二个结果也精确落在源的中点（不再被错开 56px）',
    Math.abs(cy(q) - mid) < 0.001, `cy=${cy(q)} 中点=${mid}`)
  check('两者横向让开（并排，各占一条子通道）', p.x !== q.x, `${p.x} vs ${q.x}`)
  check('两者都在所有源的右侧',
    p.x >= l.byId.get(a.id).x + l.byId.get(a.id).w && q.x >= l.byId.get(b.id).x + l.byId.get(b.id).w)
}

/* ================================================================== */
console.log('\n[10] 批量体检：各种形状都不重叠、不倒钩')

{
  // 源节点分居两条分支
  {
    const p = makeNode('P')
    p.children = [makeNode('p1'), makeNode('p2'), makeNode('p3')]
    const q = makeNode('Q')
    q.children = [makeNode('q1'), makeNode('q2')]
    const s = makeNode('S')
    const root = makeNode('root')
    root.children = [p, q, s]
    audit('源分居两条分支', root, [
      { from: p.id, to: s.id }, { from: q.id, to: s.id }, { from: p.children[1].id, to: s.id },
    ])
  }

  // 父子关系当源（需求里明确要求支持）
  {
    const up = makeNode('上游')
    const down = makeNode('下游')
    up.children = [down, makeNode('旁支')]
    const sink = makeNode('汇')
    const root = makeNode('root')
    root.children = [up, sink]
    audit('父子关系当源', root, [
      { from: up.id, to: sink.id }, { from: down.id, to: sink.id },
    ])
  }

  // 四个源 + 各自带子树
  {
    const srcs = ['A', 'B', 'C', 'D'].map(makeNode)
    srcs.forEach((s, i) => { s.children = [makeNode(`${s.text}1`), makeNode(`${s.text}2`)] })
    const sink = makeNode('汇总')
    const root = makeNode('root')
    root.children = [...srcs, sink]
    audit('四个源各自带子树', root, srcs.map((s) => ({ from: s.id, to: sink.id })))
  }

  // 六个源（超过「线多到要按需显示」的一半），全在最深一层
  {
    const deep = makeNode('deep')
    const leaves = Array.from({ length: 6 }, (_, i) => makeNode(`l${i}`))
    deep.children = leaves
    const sink = makeNode('汇')
    const root = makeNode('root')
    root.children = [deep, sink]
    audit('六个源都在第 2 层', root, leaves.map((n) => ({ from: n.id, to: sink.id })))
  }

  // 同一个源重复指向同一结果：只按「不同的源」计数，不能因此多算一个源
  {
    const a = makeNode('A')
    const b = makeNode('B')
    const sink = makeNode('汇')
    const root = makeNode('root')
    root.children = [a, b, sink]
    const dup = [
      { from: a.id, to: sink.id }, { from: a.id, to: sink.id }, { from: b.id, to: sink.id },
    ]
    const l = audit('同一个源重复指向', root, dup)
    check('重复的源不会让 Y 算错（仍等于两个不同源的中点）',
      Math.abs(cy(l.byId.get(sink.id)) - (cy(l.byId.get(a.id)) + cy(l.byId.get(b.id))) / 2) < 0.001)
  }
}

/* ================================================================== */
console.log('\n[11] 带子树的汇聚节点：能搬就搬（居中），不能搬才保持原位')

{
  /*
   * 判据是「源的层号有没有比它自己深」：
   *   · 源的层号 ≤ 它自己那一层 → 通道开在**它自己那一列的右边**，
   *     子节点那一列（depth+1）照样在通道右边 ⇒ 可以搬，而且能居中。
   *   · 源比它更深 → 通道会落到它子节点那一列的**右边**，搬过去
   *     「父 → 子」的树边就掉头往左画 ⇒ 只能保持原位。
   * 这一条是列模型的硬约束：一个位置不可能同时在源列的右边、
   * 又在更浅那一列的左边。
   */
  const a = makeNode('A')
  const b = makeNode('B')
  const c = makeNode('C')
  const d = makeNode('D')
  c.children = [d]
  const root = makeNode('root')
  root.children = [a, b, c]
  const relations = [{ from: a.id, to: c.id }, { from: b.id, to: c.id }]

  const plain = layoutTree(root, { includeRoot: true })
  const l = audit('带子树的汇聚节点（源同层）', root, relations)
  const lc = l.byId.get(c.id)
  const mid = (cy(l.byId.get(a.id)) + cy(l.byId.get(b.id))) / 2
  check('源同层时它可以搬，而且居中于两个源之间',
    Math.abs(cy(lc) - mid) < 0.001, `cy=${cy(lc)} 中点=${mid}`)
  check('它搬到了自己那一列的右边（不再和兄弟挤在同一列）',
    lc.x > plain.byId.get(c.id).x, `${lc.x} > ${plain.byId.get(c.id).x}`)
  check('它仍然在自己的子节点左边（树边没有倒钩）',
    lc.x + lc.w <= l.byId.get(d.id).x, `C 右边缘=${lc.x + lc.w} D.x=${l.byId.get(d.id).x}`)

  // 源比它更深：这时「在源右侧」和「在子节点左侧」不可兼得，保持原位
  const root2 = makeNode('root')
  const keep = makeNode('C')
  const kid = makeNode('D')
  keep.children = [kid]
  const branch = makeNode('E')
  const e1 = makeNode('E1')
  const e2 = makeNode('E2')
  branch.children = [e1, e2]
  root2.children = [keep, branch]
  const rel2 = [{ from: e1.id, to: keep.id }, { from: e2.id, to: keep.id }]
  const plain2 = layoutTree(root2, { includeRoot: true })
  const l2 = audit('带子树的汇聚节点（源更深）', root2, rel2)
  const lc2 = l2.byId.get(keep.id)
  check('源更深时它保持树的原位（x、y 都没动）',
    lc2.x === plain2.byId.get(keep.id).x && lc2.y === plain2.byId.get(keep.id).y,
    `x ${lc2.x}/${plain2.byId.get(keep.id).x}`)
  check('这时它也不会被拧成倒钩（宁可连线回指）',
    lc2.x + lc2.w <= l2.byId.get(kid.id).x,
    `C 右边缘=${lc2.x + lc2.w} D.x=${l2.byId.get(kid.id).x}`)
}

/* ================================================================== */
console.log('\n[12] 回指的关系边从目标右侧进入')

{
  const far = { x: 600, y: 0, w: 72, h: NODE_H }
  const near = { x: 100, y: 0, w: 72, h: NODE_H }

  const back = edgePath(far, near)
  check('目标整个在源左侧 → 从源的左边缘出发',
    back.startsWith(`M ${far.x} `), back)
  check('并且落在目标的右边缘上（箭头指进目标）',
    back.endsWith(`${near.x + near.w} ${near.y + near.h / 2}`), back)

  const fwd = edgePath(near, far)
  check('正常向右的边没被改动（仍从源右边缘到目标左边缘）',
    fwd.startsWith(`M ${near.x + near.w} `) && fwd.endsWith(`${far.x} ${far.y + far.h / 2}`),
    fwd)

  // 同列相邻（目标左边缘 == 源左边缘）不算回指，保持老画法
  const same = edgePath(near, { x: near.x, y: 60, w: 72, h: NODE_H })
  check('同列的边不会被误判成回指', same.startsWith(`M ${near.x + near.w} `), same)
}

/* ================================================================== */
console.log('\n[13] 通道层号跟着源走：不许把相邻两列越推越远（回归）')

{
  /*
   * 用户反馈：「中间线非常非常非常长」。
   *
   * 场景：两个**深**节点汇聚出 N —— N 挂在公共父节点下，**树层很浅**，
   * 但它的通道开在最深那个源那一层的右边（d3），也就是「d1 的节点站在 d3 上」。
   * N 再和 d2 的节点汇聚时，如果按「源的树层」定通道层号，通道就落在 N 自己
   * **左边**；为了让它落到源右侧只能继续往右推，而它一往右，那一列的让位宽度
   * 又跟着涨，第二轮把它推得更右 —— 正反馈。实测 10 轮后相邻两列之间被拉开
   * **2514px** 的空白，中间一根树边横跨半个画布。
   *
   * 修法：通道层号取 max(源的树层, 源自己的通道层号)。依赖方向永远朝着层号
   * 小的那边，整张图塌缩成一次从左到右的扫描，不可能自我放大。
   */
  const p2 = makeNode('P2')
  const p1 = makeNode('P1', [p2])
  const p = makeNode('P', [p1])
  const q2 = makeNode('Q2')
  const q1 = makeNode('Q1', [q2])
  const q = makeNode('Q', [q1])
  const root = makeNode('root')
  root.children = [p, q]

  let relations = []
  const r1 = convergeToNewNode(root, relations, p2.id, q2.id)
  relations = r1.relations
  const r2 = convergeToNewNode(root, relations, r1.newNodeId, q1.id)
  relations = r2.relations

  const plain = layoutTree(root, { includeRoot: true })
  const l = audit('深节点汇聚出的结果再和浅节点汇聚', root, relations)

  check('树列一动不动（和「完全没有汇聚」逐位相同）',
    [p, p1, p2, q, q1, q2].every((n) => l.byId.get(n.id).x === plain.byId.get(n.id).x),
    [p, p1, p2, q, q1, q2].map((n) => `${l.byId.get(n.id).x}/${plain.byId.get(n.id).x}`).join(' '))

  const gap = l.byId.get(p2.id).x - (l.byId.get(p1.id).x + l.byId.get(p1.id).w)
  check('相邻两列的空档还是 GAP_X（老实现被推到 2514px）',
    gap === GAP_X, `空档=${gap}`)

  check('画布宽度没有被撑开（老实现 3310px）', l.width < 1500, `width=${l.width}`)

  const n1 = l.byId.get(r1.newNodeId)
  const n2 = l.byId.get(r2.newNodeId)
  check('两个结果都落在树列右侧（不是插到中间去了）',
    n1.x >= plain.byId.get(p2.id).x && n2.x >= plain.byId.get(p2.id).x,
    `N1=${n1.x} N2=${n2.x} 最深树列=${plain.byId.get(p2.id).x}`)
  check('第二个结果排在第一个右边（链式，不重叠）',
    n2.x >= n1.x + n1.w, `N1 右边缘=${n1.x + n1.w} N2.x=${n2.x}`)

  // 反过来的顺序也要成立：先浅后深
  const root2 = makeNode('root')
  const a = makeNode('A')
  const b = makeNode('B', [makeNode('B1', [makeNode('B2')])])
  root2.children = [a, b]
  let rel3 = []
  const s1 = convergeToNewNode(root2, rel3, a.id, b.id)
  rel3 = s1.relations
  const deep2 = b.children[0].children[0]
  const s2 = convergeToNewNode(root2, rel3, s1.newNodeId, deep2.id)
  rel3 = s2.relations
  const l2 = audit('先浅后深再接更深', root2, rel3)
  check('先浅后深也不会把画布撑开', l2.width < 1500, `width=${l2.width}`)
}

/* ================================================================== */
console.log('\n[14] 随机图体检：随机树 + 随机 relations（固定种子，可复现）')

{
  /*
   * 上面每个用例都是我手写的形状 —— 手写的用例只能覆盖我想到的情况。
   * 这个 bug（通道让位宽度的正反馈）就是「我没想到的那种形状」：
   * 深节点汇聚出的结果，再拿去和浅节点汇聚。
   * 所以这里用固定种子的伪随机图扫一遍，把不变量当**性质**来验。
   *
   * 随机图里故意掺进自环、悬空 id、缺字段、重复关系，以及会成环的关系
   * （A→B 且 B→A）—— 这些都不该让布局崩掉或发散。
   * 种子固定 ⇒ 每次跑出来的图完全一样，失败能精确复现。
   */
  const rng = (seed) => {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  }
  const MAXW = 240          // nodeWidth 的上限（layout.js 里 Math.min(240, …)）

  let cases = 0
  let relTotal = 0
  let groupTotal = 0
  let movedTotal = 0
  let keptTotal = 0
  const bad = { nan: [], overlap: [], backward: [], rel: [], width: [], det: [] }

  for (let seed = 1; seed <= 150; seed++) {
    const rnd = rng(seed * 2654435761)
    const root = makeNode('r')
    const all = [root]
    const want = 4 + Math.floor(rnd() * 17)
    let guard = 0
    while (all.length < want && guard++ < 500) {
      const p = all[Math.floor(rnd() * all.length)]
      if (p.children.length >= 4) continue
      const n = makeNode('n' + all.length)
      p.children.push(n)
      all.push(n)
    }

    const rels = []
    const relCount = Math.floor(rnd() * 12)
    for (let i = 0; i < relCount; i++) {
      const a = all[Math.floor(rnd() * all.length)]
      const b = all[Math.floor(rnd() * all.length)]
      const r = rnd()
      if (r < 0.08) rels.push({ from: a.id, to: a.id })          // 自环
      else if (r < 0.16) rels.push({ from: 'ghost', to: b.id })   // 悬空源
      else if (r < 0.2) rels.push({ from: a.id, to: null })       // 缺字段
      else rels.push({ from: a.id, to: b.id })
    }
    for (const r of rels.slice()) if (rnd() < 0.4) rels.push({ ...r })  // 重复关系

    /*
     * 再叠一层**真实形状**：随机挑一个目标，从不同源塞 2~4 条入边。
     * 没有这一步，随机关系里凑出「同一个 to 有 ≥2 个不同 from」的概率很低，
     * 整个体检就会在「没有汇聚」的分支上空跑 —— 那是假绿。
     */
    if (rnd() < 0.75) {
      const sink = all[Math.floor(rnd() * all.length)]
      const k = 2 + Math.floor(rnd() * 3)
      for (let i = 0; i < k; i++) {
        const src = all[Math.floor(rnd() * all.length)]
        if (src.id !== sink.id) rels.push({ from: src.id, to: sink.id })
      }
    }

    cases++
    relTotal += rels.length

    const l = layoutTree(root, { includeRoot: true, relations: rels })
    const plain = layoutTree(root, { includeRoot: true })
    const tag = `seed=${seed}(${all.length}节点/${rels.length}关系)`

    if (l.nodes.some((x) => !Number.isFinite(x.x) || !Number.isFinite(x.y))) bad.nan.push(tag)

    const ov = overlapPairs(l)
    if (ov.length) {
      bad.overlap.push(`${tag} ${ov.map(([p, q]) =>
        `${l.byId.get(p).node.text}×${l.byId.get(q).node.text}`).join(',')}`)
    }

    for (const e of l.edges) {
      const a = l.byId.get(e.from)
      const b = l.byId.get(e.to)
      if (a && b && a.x + a.w > b.x + 0.01) { bad.backward.push(`${tag} ${a.node.text}→${b.node.text}`); break }
    }

    // 只有「真的要进通道、而且不在环里」的目标才必须落在源右侧；
    // 环里无解（见 [16]），不搬的保持原位也是设计如此
    const gs = convergenceGroups(l.byId, rels)
    groupTotal += gs.length
    movedTotal += gs.filter((g) => g.relocate).length
    keptTotal += gs.filter((g) => !g.relocate).length
    const willMove = new Set(gs.filter((g) => g.relocate && !g.inCycle).map((g) => g.target.id))
    for (const r of rels) {
      const a = l.byId.get(r.from)
      const b = l.byId.get(r.to)
      // 自环（a === b）永远「落在自己左边」，不是问题；布局本来就忽略自环
      if (!a || !b || r.from === r.to || !willMove.has(b.id)) continue
      if (b.x < a.x + a.w - 0.01) {
        bad.rel.push(`${tag} ${a.node.text}→${b.node.text} 左边缘${Math.round(b.x)} < 源右边缘${Math.round(a.x + a.w)}`)
        break
      }
    }

    /*
     * 宽度上界：加通道最多只该多出「通道里那些节点 + 它们之间的层间距」。
     * 正反馈（每轮互相推）会**立刻**越过这条线 —— 实测老实现是 3310px，
     * 而这条上界算出来只有 1500 上下。
     */
    const bound = plain.width + gs.length * (MAXW + GAP_X) + GAP_X + 1
    if (l.width > bound) bad.width.push(`${tag} width=${Math.round(l.width)} 上界=${Math.round(bound)}`)

    // 纯函数：同一个输入跑两次必须逐位相同（也顺带证明没改坏传入的树）
    const again = layoutTree(root, { includeRoot: true, relations: rels })
    if (again.nodes.some((x, i) => x.x !== l.nodes[i].x || x.y !== l.nodes[i].y)) bad.det.push(tag)
  }

  const brief = (arr) => arr.slice(0, 3).join(' | ')
  /*
   * 先确认这次体检**真的跑到了汇聚布局**：没有这一条，随机图可能整场都在
   * 「没有汇聚」的分支上，六条断言全绿却什么都没验到。
   */
  check(`随机图覆盖到汇聚布局（${groupTotal} 个汇聚点：搬 ${movedTotal} / 留 ${keptTotal}）`,
    groupTotal >= 60 && movedTotal >= 30 && keptTotal >= 10,
    `groups=${groupTotal} moved=${movedTotal} kept=${keptTotal}`)
  check(`${cases} 个随机图（共 ${relTotal} 条随机关系）：坐标都是有限数`,
    bad.nan.length === 0, brief(bad.nan))
  check('随机图：节点框互不重叠', bad.overlap.length === 0, brief(bad.overlap))
  check('随机图：树边永不倒钩', bad.backward.length === 0, brief(bad.backward))
  check('随机图：叶子汇聚点永不落在源左侧', bad.rel.length === 0, brief(bad.rel))
  check('随机图：画布宽度有界（正反馈会立刻越界）', bad.width.length === 0, brief(bad.width))
  check('随机图：布局是纯函数（同输入两次逐位相同）', bad.det.length === 0, brief(bad.det))
}

/* ================================================================== */
console.log('\n[15] 大盘性能：800 节点 + 120 条汇聚关系')

{
  // 汇聚布局从「两趟」变成「逐层扫描 + 层内迭代」，得确认大盘不退化
  const root = makeNode('root')
  const flat = [root]
  while (flat.length < 800) {
    const p = flat[Math.floor(flat.length / 3)] || root
    if (p.children.length >= 3) { flat.push(makeNode('x' + flat.length)); continue }
    const n = makeNode('n' + flat.length)
    p.children.push(n)
    flat.push(n)
  }
  const rels = []
  for (let i = 0; i < 120; i++) {
    const a = flat[(i * 7) % flat.length]
    const b = flat[(i * 13 + 5) % flat.length]
    if (a.id !== b.id) rels.push({ from: a.id, to: b.id })
  }

  const t0 = Date.now()
  const l = layoutTree(root, { includeRoot: true, relations: rels })
  const ms = Date.now() - t0

  check('800 节点 + 120 条关系的布局在 150ms 内完成', ms < 150, `${ms}ms`)
  check('大盘坐标全部有限', l.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)))
  check('大盘节点数正确', l.nodes.length === 800, `${l.nodes.length}`)
  check('大盘也不重叠', overlapPairs(l).length === 0)
}

/* ================================================================== */
console.log('\n[16] 汇聚点互相指向（成环）：无解，但照样居中、不重叠')

{
  /*
   * A、B 互相指向（「指向」两次就能做出来），而且各自还有别的入边
   * —— 两个都是汇聚点。这时「每个汇聚点都在自己所有源的右边」要求
   * x_A > x_B 且 x_B > x_A，**无解**。
   *
   * 随机图体检抓到的实际后果：两个节点在层内迭代里互相往右推，每轮各加
   * 一个「节点宽 + GAP_X」，推到上限停下时目标**仍然压在自己的源身上**
   * （实测 seed=42：目标 x=1728，源右边缘 1968），画布也被撑到 2016px。
   *
   * 处理：环里的节点照样进通道（于是照样居中、也不会压住同列的兄弟），
   * 只是**不再按「源的右边缘」往右推** —— 那一项在环里永远追不上。
   * 代价是环里必有一条边回指，那是不可避免的最小代价。
   */
  const a = makeNode('A')
  const b = makeNode('B')
  const x1 = makeNode('X1')
  const x2 = makeNode('X2')
  const root = makeNode('root')
  root.children = [a, b, x1, x2]
  const relations = [
    { from: x1.id, to: a.id }, { from: b.id, to: a.id },
    { from: x2.id, to: b.id }, { from: a.id, to: b.id },
  ]

  const plain = layoutTree(root, { includeRoot: true })
  const l = audit('汇聚点互相指向', root, relations)
  const gs = convergenceGroups(l.byId, relations)

  check('前置：两个节点都算汇聚点（各有 ≥2 个源）', gs.length === 2, `${gs.length}`)
  check('前置：它们都是「可以搬」的形状（没有子树）', gs.every((g) => g.movable))
  check('★ 环被识别出来了（两个都在环里）', gs.every((g) => g.inCycle === true))
  check('环里的节点照样进通道（所以还是居中的）', gs.every((g) => g.relocate))

  // 每个都居中于自己的源之间
  for (const g of gs) {
    const mid = (Math.min(...g.sources.map((s) => s.y + s.h / 2)) +
      Math.max(...g.sources.map((s) => s.y + s.h / 2))) / 2
    check(`${g.target.node.text} 居中于自己的源之间`,
      Math.abs(cy(g.target) - mid) < 0.001, `cy=${cy(g.target)} 中点=${mid}`)
  }

  /*
   * 环里**恰好一条**边回指 —— 这是理论上的最小值：环上总得有一条边往回画。
   * 多一条都说明布局把两个节点推歪了。
   */
  const backward = relations.filter((r) => {
    const s = l.byId.get(r.from), t = l.byId.get(r.to)
    return s && t && r.from !== r.to && t.x < s.x + s.w
  })
  check('★ 环里恰好只有一条边回指（理论最小值）',
    backward.length === 1, `${backward.length} 条：${backward.map((r) => `${l.byId.get(r.from).node.text}→${l.byId.get(r.to).node.text}`).join(',')}`)

  check('画布没有因为成环而膨胀（老实现 2016px）',
    l.width <= plain.width + 2 * (240 + GAP_X) + GAP_X + 1, `width=${l.width} 上界≈${plain.width + 2 * (240 + GAP_X) + GAP_X + 1}`)
}

/* ================================================================== */
console.log('\n[17] 两个浅节点指向一个深叶子：搬到它自己那一列的右边')

{
  /*
   * 随机图体检抓到的另一类：叶子在 d3，两个源都在 d1。
   * 老规则按「源推出来的层号」放通道（d1 右边、只有 d2 那一列的位置），
   * 结果叶子被搬到它自己父节点（d2）的**左边**，树边倒钩。
   *
   * 新规则：通道层号取 max(源推出来的层号, 它自己那一层)，
   * 于是通道永远在它自己那一列的右边 —— 父节点在左边、子节点在右边，
   * 而且它还能精确居中。「指向」两次连到同一个深节点，界面上完全做得到。
   */
  const leaf = makeNode('深叶子')
  const lv3 = makeNode('L3', [leaf])
  const lv2 = makeNode('L2', [lv3])
  const a = makeNode('A')
  const b = makeNode('B')
  const root = makeNode('root')
  root.children = [a, b, lv2]
  const relations = [{ from: a.id, to: leaf.id }, { from: b.id, to: leaf.id }]

  const plain = layoutTree(root, { includeRoot: true })
  const l = audit('两个浅节点指向一个深叶子', root, relations)
  const L = l.byId.get(leaf.id)
  const P = l.byId.get(lv3.id)
  const gs = convergenceGroups(l.byId, relations)

  check('前置：它确实是个汇聚点（2 个源）', gs.length === 1 && gs[0].sources.length === 2)
  check('通道层号取「它自己那一层」（不是被源拉到更浅的 d1）',
    gs.length === 1 && gs[0].lane === gs[0].target.depth, `lane=${gs[0].lane} depth=${gs[0].target.depth}`)
  check('它搬到了自己那一列的右边', L.x > plain.byId.get(leaf.id).x,
    `${L.x} > ${plain.byId.get(leaf.id).x}`)
  check('它精确居中于两个浅源之间',
    Math.abs(cy(L) - (cy(l.byId.get(a.id)) + cy(l.byId.get(b.id))) / 2) < 0.001,
    `cy=${cy(L)}`)
  check('它仍然在自己的父节点右边（树边不倒钩）', P.x + P.w <= L.x,
    `父右边缘=${P.x + P.w} 叶子 x=${L.x}`)
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)