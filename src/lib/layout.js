/**
 * 导图布局引擎（横向树布局：根节点在最左，逐层向右生长）
 * =====================================================
 * 刻意不用第三方布局库：纯函数、易测，后续在 Tauri 里也没依赖负担。
 *
 * 算法（两趟 + 汇聚重排）：
 *   第一趟 后序遍历，按「叶子占一格」累积垂直位置，并让**父节点垂直居中于
 *          自己子树的跨度**；同时记录每层最宽节点。
 *   第二趟 按层宽把 x 落定，保证同一层左边缘对齐；同时给「指向同一结果」的
 *          汇聚节点留出一条**专属通道**，后面的列整体让开
 *          （见下面的 applyConvergenceLayout）。
 * 折叠的子树在布局阶段就剪枝，所以折叠越多布局越快。
 */

export const NODE_H = 34        // 节点高度
export const GAP_Y = 22         // 兄弟节点垂直间距（够松才看得清分支）
export const GAP_X = 96         // 层级之间的水平间距
export const PAD = 48           // 画布内边距
export const FIT_MARGIN = 0.2   // fitView 的整体留白比例（每边各 10%）

export function measureText(text, fontSize = 14) {
  // 中文字符按 1em 计，ASCII 按 0.56em 计 —— 够准了，不需要 canvas 测量
  let w = 0
  for (const ch of String(text)) {
    w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.56
  }
  return w
}

export function nodeWidth(node) {
  const base = measureText(node.text, 14)
  return Math.max(72, Math.min(240, base + 28))
}

/** 节点的包围盒（画布坐标系） */
export function boundsOf(nodes) {
  if (!nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) {
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.x + n.w > maxX) maxX = n.x + n.w
    if (n.y + n.h > maxY) maxY = n.y + n.h
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

/**
 * 计算「整张图刚好居中铺满视口」的 view 变换。
 *
 * @param nodes  布局结果
 * @param vw/vh  视口尺寸（像素）
 * @param marginRatio 整体留白比例，0.2 = 四周合计留 20%（每边 10%）
 * @param opts.minZoom 缩放下限；手机窄屏必须抬高，见下面注释
 * @returns {{ x, y, zoom }}  可直接作为 Canvas 的 view
 */
export function fitView(nodes, vw, vh, marginRatio = FIT_MARGIN, opts = {}) {
  if (!nodes.length || !(vw > 0) || !(vh > 0)) return { x: 0, y: 0, zoom: 1 }

  const b = boundsOf(nodes)
  const w = Math.max(1, b.width)
  const h = Math.max(1, b.height)

  // 可用区域 = 视口去掉留白
  const availW = vw * (1 - marginRatio)
  const availH = vh * (1 - marginRatio)

  // 取较小的缩放比，保证两个方向都装得下；上限 1.3 避免小图被放得过大
  //
  // 缩放下限：桌面默认 0.15 没问题，但手机上会出人命 ——
  // 一张约 930px 宽的图塞进 375px 视口 → zoom≈0.21，节点文字糊成一团，
  // 折角角标 24px 的点击热区只剩 9px，根本点不中。
  // 折角是「屏幕尺寸」概念（FoldCorner 里按 1/zoom 反向补偿），
  // 所以这里保证 zoom 不会低到让热区小到不能点：24 * 0.75 = 18px。
  // 宁可让用户横向平移看全图，也不能给出一屏点不中的小字。
  const minZoom = opts.minZoom ?? 0.15
  const zoom = Math.min(1.3, Math.max(minZoom, Math.min(availW / w, availH / h)))

  // 内容中心对齐视口中心
  const cx = b.minX + w / 2
  const cy = b.minY + h / 2
  return {
    x: vw / 2 - cx * zoom,
    y: vh / 2 - cy * zoom,
    zoom,
  }
}

/**
 * @param {Node} root
 * @param {object} opts
 * @param {boolean} opts.includeRoot 是否渲染根节点（根节点通常作为标题居中）
 * @param {Relation[]} opts.relations 「指向同一结果」的汇聚边；给了才会做汇聚布局
 * @param {(node) => number} [opts.bandExtra]
 *   给这个节点的**子树末尾**额外预留的垂直空间（像素）。默认不传 = 0，
 *   画布上的布局一个像素都不会变。
 *   只有 PDF 导出会用到它：流程图要放在节点所在分支的正下方，得先在布局里
 *   把这块地方空出来。注意加的是「子树末尾」而不是节点自己 —— 节点必须始终
 *   垂直居中于它自己的子树，否则父节点会跟着往下偏。
 * @param {Set<string>} [opts.lockIds]
 *   这些节点一律不搬进汇聚通道（默认不传 ⇒ 画布行为不变）。
 *   同样只有 PDF 导出用：预留了流程图位置的节点一旦被搬走，那块空间就白留了。
 * @returns {{ nodes: LayoutNode[], edges: LayoutEdge[], byId, width, height }}
 *   LayoutNode: { id, node, x, y, w, h, depth, parentId, hiddenFold, childCount }
 */
export function layoutTree(root, { includeRoot = true, relations = [], bandExtra = null, lockIds = null } = {}) {
  const nodes = []
  const edges = []
  let cursorY = 0
  // 逐层累计最宽节点，取代固定列宽 —— 否则长文本节点会溢出到下一层
  const depthWidth = []

  // 返回子树占用的垂直高度
  const walk = (node, depth, parentId = null) => {
    const w = nodeWidth(node)
    depthWidth[depth] = Math.max(depthWidth[depth] || 0, w)

    // 折叠时节点本身仍然渲染，只是不渲染子树（PRD：父节点要透传浅色折角）
    const children = node.collapsed ? [] : node.children

    // ★ 关键：子树起点必须在递归之前记录。
    //   早先写成「递归之后读 cursorY」，那时 cursorY 已经被子节点推到了子树末尾，
    //   于是父节点被摆到自己子节点的**下方**，整棵树看起来是向下堆叠的竖条。
    const startY = cursorY

    let contentH
    const childIds = []

    if (!children.length) {
      contentH = NODE_H
    } else {
      let sum = 0
      for (const c of children) {
        const ch = walk(c, depth + 1, node.id)
        childIds.push(c.id)
        sum += ch
      }
      sum += GAP_Y * (children.length - 1)
      contentH = Math.max(NODE_H, sum)
    }

    // 子树末尾额外预留的空间（PDF 的流程图用；默认 0）
    const extra = bandExtra ? Math.max(0, bandExtra(node) || 0) : 0
    const height = contentH + extra

    // 父节点垂直居中于**自己子树**的跨度 [startY, startY + contentH]。
    // 这里刻意用 contentH 而不是 height：预留出来的那块空间是给流程图的，
    // 不该把节点自己往下拽。
    const selfY = startY + contentH / 2 - NODE_H / 2
    cursorY = startY + height + GAP_Y

    // 深层折角透传：折叠时统计被遮挡的折角数量。
    // 注意不要把自己算进去 —— 折叠的是「子树」，节点自身的折角仍在渲染。
    let hiddenFold = 0
    if (node.collapsed) {
      const count = (n) => {
        let k = n.fold ? 1 : 0
        for (const c of n.children) k += count(c)
        return k
      }
      for (const c of node.children) hiddenFold += count(c)
    }

    const item = {
      id: node.id,
      node,
      x: 0, // 两趟布局：先排 y 与层宽，最后再算 x
      y: selfY,
      w,
      h: NODE_H,
      depth,
      parentId,
      hiddenFold,
      childCount: node.children.length,
    }
    nodes.push(item)

    for (const cid of childIds) {
      edges.push({ from: node.id, to: cid })
    }

    return height
  }

  if (includeRoot) {
    walk(root, 0)
  } else {
    // 根节点作为标题独占一行，子节点从 depth=1 开始
    for (const c of root.collapsed ? [] : root.children) {
      walk(c, 1, null)
      edges.push({ from: '__root__', to: c.id })
    }
  }

  /*
   * 第二趟 + 第三趟：列 x 与**汇聚通道**一起落定。
   *
   * 这两趟不能分开做。老写法是「先把每列的 x 累加出来，再单独把汇聚节点挪到
   * 源列右侧那一列」—— 那等于让汇聚节点和下一列的**树节点共用同一个 x**，
   * 于是它直接压在人家身上（实测 C 与 m5、m6 各重叠 6px），连线也从那一列
   * 的节点中间横穿过去。正确做法是先给汇聚节点留出**专属通道**：通道开在
   * 源列右侧，后面的列整体让开，汇聚节点所在的位置上就没有任何别的节点。
   */
  const byId = byIdOf(nodes)
  // 返回值（每层的 x）留给调试和测试用，布局树本身只关心节点的 x/y
  applyConvergenceLayout(nodes, byId, relations, depthWidth, lockIds)

  if (!nodes.length) {
    return { nodes, edges, byId, width: PAD * 2, height: PAD * 2 }
  }

  const maxX = nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0)
  const maxY = nodes.reduce((m, n) => Math.max(m, n.y + n.h), 0)

  return {
    nodes,
    edges: edges.filter((e) => byId.has(e.to)),
    byId,
    width: maxX + PAD,
    height: maxY + PAD,
  }
}

/* ================================================================== */
/* 汇聚布局（「指向同一结果」的多对一）                                  */
/* ================================================================== */

/** id → LayoutNode */
function byIdOf(nodes) {
  const m = new Map()
  for (const n of nodes) m.set(n.id, n)
  return m
}

/** 一个节点渲染出来的子节点个数（折叠的子树在布局里根本不存在） */
function renderedChildren(node) {
  if (!node || node.collapsed) return 0
  return Array.isArray(node.children) ? node.children.length : 0
}

/**
 * 把 relations 收成「一个汇聚目标 + 它的全部源节点」，并定好每条通道开在哪。
 *
 * 只认**渲染得出来**的边：两端都在布局里、非自环。同一个源出现多次只算一次
 * —— 渲染层也是按「≥2 条入边」判断汇聚的，两边必须用同一把尺子，
 * 否则会出现「入边被藏掉、节点却不算汇聚」这种半截状态。
 * 只有一个源的不算汇聚，那是普通的「指向」，保持树的常规排布。
 *
 * 【relocate：这个目标能不能搬进通道】
 * 三个条件同时成立才搬：
 *   · 它自己没有渲染出来的子节点（有子树的节点搬不得，见 applyConvergenceLayout）；
 *   · 它的**树层 ≥ 通道层号** —— 保证通道一定在它自己那一列的右边。
 * 第二条是「绝不往左搬」的判据。反例：两个**浅**节点用「指向」连到一个**深**叶子
 * （叶子在 d3、源在 d1），通道开在 d1 右边、x 只有 d2 那一列的位置，
 * 而它自己的父节点在 d2、更靠右 —— 搬过去就出现「子节点在自己父节点左边」
 * 的倒钩树边。这种情况保持原位（和带子树的节点同一套规则）。
 *   · 它不在「汇聚点互相指向」的环里（A→B 且 B→A 时几何上无解，见下面成环那段）。
 *
 * 【层号必须跟着源走】
 * 汇聚结果的「树层」和它的「实际位置」是两回事：它挂在公共父节点下面，树层
 * 可能很浅，而通道开在**最深那个源**那一层的右边 —— 「d1 的节点站在 d3 上」。
 * 它再作为源去汇聚时，如果按树层定通道层号，通道就落在它**左边**；靠「兜底取
 * 源的右边缘」把它推到源右侧之后，它所在那一列的让位宽度又跟着涨，下一轮又
 * 把它推得更右 —— 正反馈。实测 10 轮后相邻两列之间被拉开 2514px 的空白，
 * 中间一根树边横跨半个画布（用户原话：「中间线非常非常非常长」）。
 * 所以层号取 max(源的树层, 源自己的通道层号)：依赖方向永远朝着层号小的那边，
 * 整张图塌缩成**一次从左到右的扫描**，不可能自我放大。
 *
 * @returns {Array<{target, sources, depth, movable, relocate, x}>}
 *   depth    通道开在这一层的右边（已经抬过层号）
 *   movable  它没有渲染出来的子节点
 *   relocate 最终是否搬进通道
 */
export function convergenceGroups(byId, relations, lockIds = null) {
  const map = new Map()
  for (const r of Array.isArray(relations) ? relations : []) {
    if (!r || !r.from || !r.to || r.from === r.to) continue
    const src = byId.get(r.from)
    const tgt = byId.get(r.to)
    // 端点被折叠隐藏时布局里没有它 —— 跳过，和渲染层的过滤保持一致
    if (!src || !tgt) continue
    let g = map.get(r.to)
    if (!g) { g = { target: tgt, sources: [] }; map.set(r.to, g) }
    if (!g.sources.includes(src)) g.sources.push(src)
  }

  const out = []
  for (const g of map.values()) {
    if (g.sources.length < 2) continue
    out.push({
      target: g.target,
      sources: g.sources,
      station: Math.max(...g.sources.map((s) => s.depth)),
      movable: renderedChildren(g.target.node) === 0,
      x: g.target.x,
    })
  }
  // 先浅后深：浅层的通道会把深层的列推得更右，顺序反了就要多跑好几轮
  out.sort((a, b) => a.station - b.station)

  // 抬层号：源如果已经在第 k 条通道里，目标也放第 k 条（排到它右边即可）。
  // 只复制已有层号、不做加法，所以层号永远不超过树的最大深度，也就不会
  // 冒出空列把图撑开。这里用 movable（relocate 的超集）判断：多抬一点点
  // 只会让通道更靠右，不会算错，也不会自我放大。
  const groupOfTarget = new Map(out.map((g) => [g.target.id, g]))
  for (let round = 0; round <= out.length; round++) {
    let raised = false
    for (const g of out) {
      for (const s of g.sources) {
        const sg = groupOfTarget.get(s.id)
        if (sg && sg.movable && sg !== g && sg.station > g.station) { g.station = sg.station; raised = true }
      }
    }
    if (!raised) break
  }

  /*
   * 成环的关系（A→B 且 B→A，两边都是汇聚点）在几何上**无解**：
   * 「每个汇聚点都在自己所有源的右边」要求 x_A > x_B 且 x_B > x_A。
   *
   * 环里的节点照样进通道（这样它还是居中、也不会压住同列的兄弟），
   * 只是**不再按「源的右边缘」往右推** —— 否则两个节点会互相推着往右跑。
   * 代价是环里必有一条边回指，那是不可避免的最小代价：一个环里总得有一条
   * 边往回画，而回指的线会从目标右边缘进入（见 edgePath），方向仍读得对。
   */
  const candidate = new Map()
  for (const g of out) if (g.movable) candidate.set(g.target.id, g)
  const deps = new Map()
  for (const g of out) {
    const list = []
    for (const s of g.sources) {
      const sg = candidate.get(s.id)
      if (sg && sg !== g) list.push(sg)
    }
    deps.set(g, list)
  }
  const state = new Map()     // 0 未访问 / 1 在递归栈上 / 2 已完成
  const stack = []
  const visit = (g) => {
    state.set(g, 1)
    stack.push(g)
    for (const d of deps.get(g) || []) {
      const st = state.get(d) || 0
      if (st === 1) {
        // 栈上从 d 到栈顶这一段就是一个环
        for (let i = stack.indexOf(d); i < stack.length; i++) stack[i].inCycle = true
      } else if (st === 0) {
        visit(d)
      }
    }
    stack.pop()
    state.set(g, 2)
  }
  for (const g of out) if (!state.get(g)) visit(g)

  for (const g of out) {
    /*
     * 通道开在哪一层：取「源推出来的层号」和「它自己那一层」的较大值。
     *
     * 加上「它自己那一层」这个下限，是为了让通道**永远在它自己那一列的右边** ——
     * 于是它一定在自己的父节点右边（树边不会倒钩）、又一定在自己的子节点左边
     * （子节点那一列会被让开）。少了这个下限，「两个浅节点指向一个深叶子」
     * 就会把叶子搬到它父节点的左边。
     */
    g.lane = Math.max(g.station, g.target.depth)
    /*
     * 谁进通道：
     *   · 没有渲染出来的子节点 → 总能进（通道在它自己那一列的右边，一定在
     *     子节点那一列的左边，因为子节点在 depth+1）；
     *   · 有子节点 → 只有当「源的层号不比它自己深」时才进（这时通道仍然在
     *     它自己那一列的右边，子节点那一列照样在通道右边）。源比它还深时，
     *     通道会在它子节点那一列的**右边**，搬过去「父 → 子」的树边就掉头。
     *
     * 【lockIds：这些节点不许搬】
     * 只有一个调用方用它 —— PDF 导出。带流程图的节点，图要贴在它自己那条
     * 分支的正下方，所以布局阶段就在它的子树末尾预留了一块空间。节点一旦被
     * 搬进通道，那块预留就留在了原地、图却跟着节点跑了，图会掉进别的分支里
     * （实测下移过 1514px，而且会把下面所有图连锁顶下去）。
     * 锁住的节点走的就是「保持树的原位」那条既有分支，和「有子节点」「源更深」
     * 一样是支持的行为，不是特例。默认不传 ⇒ 画布上的汇聚行为一个字都没变。
     */
    g.relocate = (g.movable || g.target.depth >= g.station)
      && !(lockIds && lockIds.has(g.target.id))
  }
  return out
}

/**
 * 列 x + 汇聚通道（第二趟与第三趟合体）。
 *
 * 【要修的三个现象】
 *
 * 1. `convergeToNewNode` 为了「不打乱原有兄弟顺序」，把新节点**追加到公共父节点
 *    的 children 末尾**，第一趟按 children 顺序自上而下分 y，于是汇聚节点本该
 *    落在 A、B 下方、被拉出一根长线。
 * 2. 汇聚节点归位后如果只算「源列右侧那一列」，它会和下一列已有的树节点
 *    **共用同一个 x** —— 两个节点框直接叠在一起，连线从那一列中间横穿。
 * 3. 「源列那一列」是按**层号**推出来的，而汇聚节点自己并不待在层号对应的列上。
 *    一旦它又成为别的汇聚的源，算出来的目标列就可能落在它左边 —— 连线掉头往回画。
 *
 * 【修法：给汇聚节点一条专属通道】
 *
 *     A ─┐
 *         ├─→ C        ← C 待在「源列右侧的通道」里，通道两边都是空的
 *     B ─┘   ⇢ 下一列整体让开
 *
 * X：通道起点 = 源列右边缘 + GAP_X，并且**兜底**取「所有源节点真实右边缘 + GAP_X」
 *     的最大值。用真实右边缘而不是层号推列，是修现象 3 的关键：汇聚节点自己
 *     可能已经被挪到别的列上了，按层号算会算出它左边去。
 * Y：垂直居中于所有源节点的中点（两个源时就精确是 (y1 + y2) / 2）。
 *     同一条通道上如果有多个汇聚节点，按 GAP_Y 依次错开，绝不叠在一起。
 *
 * 【为什么通道必须让后面的列整体右移】
 * 通道占的是源列与下一列之间的水平空间。不让开的话通道里就有树节点，
 * 现象 2 原样复现。让开的宽度 = 通道里最宽节点的宽度 + GAP_X。
 * 注意这只是**把后面的列往右推**：没有汇聚的图（通道宽度为 0）算出来的
 * 坐标和以前逐位相同。
 *
 * 【谁能进通道：relocate】
 * 两个条件同时成立才搬（判据全在 convergenceGroups 里，见那里的说明）：
 *   · 它自己没有渲染出来的子节点。通道在源列右侧，而「它自己子节点所在的那一列」
 *     不可能比源列更深（它是汇聚目标的身份挂在 LCA 下面，深度 ≤ 最深源），
 *     所以通道必然在它子节点所在列的**右侧** —— 硬搬进去，它就会跑到自己子节点
 *     右边，「父 → 子」的树边掉头往左画。这不是取舍，是列模型的硬约束：
 *     一个位置不可能同时在源列的右边、又在更浅那一列的左边。
 *   · 它的树层 ≥ 通道层号 —— 否则通道在它**左边**，搬过去会跑到自己父节点左边。
 *     反例：两个浅节点「指向」一个深叶子（叶子 d3、源 d1），通道开在 d1 右边、
 *     只有 d2 那一列的位置，而它父节点在 d2、更靠右。
 * 不满足的节点保持树的原位（x、y 一个字不动），它的入边由 relations 照常画出来。
 *
 * 【通道层号必须跟着源走，不能只看源的树层】
 * 汇聚结果的「树层」和它的「实际位置」是两回事：它挂在公共父节点下面，树层
 * 可能很浅，而通道开在**最深那个源**那一层的右边 —— 「d1 的节点站在 d3 上」。
 * 它再作为源去汇聚时，如果按树层定通道层号，通道就落在它**左边**；靠「兜底取
 * 源的右边缘」把它推到源右侧之后，它所在那一列的让位宽度又跟着涨，下一轮又
 * 把它推得更右 —— 正反馈。实测 10 轮后相邻两列之间被拉开 2514px 的空白，
 * 中间一根树边横跨半个画布（用户原话：「中间线非常非常非常长」）。
 * 所以层号取 max(源的树层, 源自己的通道层号)：依赖方向永远朝着层号小的那边，
 * 整张图塌缩成**一次从左到右的扫描**，不可能自我放大。
 *
 * 【同层链式靠层内迭代】
 * A、B → N1 与 N1、C → N2 的通道层号相同（N2 的源就是同一条通道上的 N1）：
 * 层内迭代把「刚算出来的位置」写回节点，下一轮同层另一组才读得到。
 * 纯链式最长不超过这一层的组数。
 *
 * @param nodes      第一趟排好的布局节点（会被就地修改 x、y）
 * @param byId       id → LayoutNode
 * @param relations  汇聚边 [{from, to}]
 * @param depthWidth 每层最宽节点的宽度
 * @param lockIds    这些 id 一律不搬进通道（见 convergenceGroups 的 lockIds）
 * @returns {number[]} 每层落定的 x
 */
export function applyConvergenceLayout(nodes, byId, relations, depthWidth = [], lockIds = null) {
  const xOfDepth = []
  if (!nodes.length) return xOfDepth

  const maxDepth = Math.max(0, depthWidth.length - 1)

  const groups = convergenceGroups(byId, relations, lockIds)
  const relocateIds = new Set()
  for (const g of groups) if (g.relocate) relocateIds.add(g.target.id)

  // 通道层号已经在 convergenceGroups 里定好了（纯组合计算，不含几何）
  const maxStation = groups.reduce((m, g) => Math.max(m, g.lane), maxDepth)

  const byLane = new Map()
  for (const g of groups) {
    if (!byLane.has(g.lane)) byLane.set(g.lane, [])
    byLane.get(g.lane).push(g)
  }
  const byDepthNodes = new Map()
  for (const n of nodes) {
    if (!byDepthNodes.has(n.depth)) byDepthNodes.set(n.depth, [])
    byDepthNodes.get(n.depth).push(n)
  }
  for (let d = 0; d <= maxStation; d++) xOfDepth[d] = PAD

  /*
   * ---- 先定 Y：居中于所有源节点的垂直中点 ----
   *
   * 需求的原话是 `(y1 + y2) / 2`。源节点 ≥ 2 时取「最上点的中心」与
   * 「最下点的中心」的中值，两个源时它就精确等于 (y1 + y2) / 2。
   *
   * 【为什么不夹取到某个区间】
   * 曾经写成「把 target 夹进 [srcTop + h/2, srcBottom - h/2]」是错的：
   * 那个区间是「源节点跨度收缩一个节点高」后的范围，当源节点挨得比较近时
   * 区间会退化成几乎一个点甚至反向，于是 target 被顶到区间上端 ——
   * 实测 A=17、B=73 时算出来是 17 而不是 45。直接取中点，
   * 不做任何夹取：中点必然落在源节点之间，不可能跑到屏幕边缘。
   *
   * 【必须在 X 之前算，而且要迭代到稳定】
   * 链式汇聚（A、B → N1，N1、C → N2）里，N2 的中点取决于 **N1 的 y**，
   * 而 N1 的 y 也是算出来的 —— 按 Map 的遍历顺序算就会读到 N1 的旧值。
   * 求平均值这个迭代是收敛的：链上每轮往前推进一环，环里每轮把误差缩一半。
   * 所以轮数上限 = 组数（覆盖链）+ 24（覆盖环里把误差压到 1e-6 以下）。
   * 不收敛的输入不存在 —— 这个映射只会取平均，永远不会放大。
   *
   * Y 定了才能排 X：两个中点相同的汇聚节点要靠「并排」而不是「上下错开」
   * 来避免重叠（见下面 (2)）。
   */
  for (let round = 0; round <= groups.length + 24; round++) {
    let moved = false
    for (const g of groups) {
      if (!g.relocate) continue
      const top = Math.min(...g.sources.map((s) => s.y + s.h / 2))
      const bottom = Math.max(...g.sources.map((s) => s.y + s.h / 2))
      const y = (top + bottom) / 2 - g.target.h / 2
      if (Math.abs(y - g.target.y) > 1e-6) { g.target.y = y; moved = true }
    }
    if (!moved) break
  }

  /*
   * ---- 再定 X：一遍从左到右 ----
   *
   * 先落这一列的树节点，再排这一层的通道，最后算出「下一列至少从哪里开始」。
   *
   * 通道的 x = max(本列右侧一格, 每个源的真实右边缘 + GAP_X)。
   * 用真实右边缘而不是层号推列，是修「汇聚点压在源身上」的关键。
   * 环里的节点（inCycle）跳过「源的右边缘」这一项 —— 见 convergenceGroups。
   */
  let acc = PAD
  for (let d = 0; d <= maxStation; d++) {
    xOfDepth[d] = acc
    const colW = depthWidth[d] || 0
    const natural = acc + colW + GAP_X

    // (1) 这一列的树节点。要进通道的汇聚目标不进列，由 (2) 放
    for (const n of byDepthNodes.get(d) || []) {
      if (!relocateIds.has(n.id)) n.x = acc
    }

    /*
     * (2) 这一层的通道。
     *
     * 【同一条通道上两个汇聚节点怎么办：并排，不是上下错开】
     * A、B 同时汇聚到 N1、N2 时两者中点完全相同。老实现把它们上下错开
     * `节点高 + GAP_Y`，结果是**第二个节点不再落在源的中点上了** ——
     * 用户的原话：「指向同一结果指多了，新结果节点好像不会在中间位置了」。
     * 现在改成横向让开：y 会撞就再往右排一条子通道，两者的 y 都精确等于
     * 中点。代价只是画布宽一点，换来「每个结果都在正中间」这条视觉承诺。
     *
     * 源可能是同一层刚排好的另一个汇聚点（链式），所以层内迭代到稳定。
     */
    const gs = byLane.get(d) || []
    const here = gs.filter((g) => g.relocate)
    here.sort((a, b) => a.target.y - b.target.y || (a.target.id < b.target.id ? -1 : 1))
    for (let iter = 0; iter <= here.length + 1; iter++) {
      let moved = false
      for (const g of here) {
        let want = natural
        if (!g.inCycle) {
          for (const s of g.sources) want = Math.max(want, s.x + s.w + GAP_X)
        }
        // 和已经放好的邻居纵向撞上了 → 再往右让一条子通道
        for (const p of here) {
          if (p === g) continue
          const ox = Math.min(want + g.target.w, p.x + p.target.w) - Math.max(want, p.x)
          const oy = Math.min(g.target.y + g.target.h, p.target.y + p.target.h) -
            Math.max(g.target.y, p.target.y)
          if (ox > 0.5 && oy > 0.5) want = p.x + p.target.w + GAP_X
        }
        if (want > g.x + 1e-6) { g.x = want; g.target.x = want; moved = true }
      }
      if (!moved) break
    }
    for (const g of here) g.target.x = g.x

    // (3) 下一列的起点：本列宽度 + GAP_X，并且要越过这一层的通道
    let laneRight = 0
    for (const g of here) laneRight = Math.max(laneRight, g.x + g.target.w)
    acc = laneRight > 0 ? Math.max(natural, laneRight + GAP_X) : natural
  }

  // 不搬的（带子树且源比它更深的）保持树的原位 —— x、y 都一个字不动
  for (const g of groups) {
    if (g.relocate) continue
    g.target.x = xOfDepth[g.target.depth] ?? PAD
  }

  return xOfDepth
}

/**
 * 生成平滑的三次贝塞尔曲线（连接线是产品视觉的核心，必须浅、必须圆）。
 *
 * 控制点沿水平方向外推，且**左右对称**（都用同一个 dx），
 * 这样曲线在父节点处水平出发、在子节点处水平进入 —— 也就是标准的
 * 「S 形汇流」，不会出现生硬的折角或斜直线。
 *
 * 【回指的线要从右侧进】
 * 树边永远是父在左、子在右，但**汇聚边不一定**：两个更深的节点指向一个
 * 更浅的节点时，关系是真实「往回指」的（布局不会为了好看去挪一个带着子树的
 * 节点，见 applyConvergenceLayout）。这时若还按老规矩「源的右边缘 → 目标的
 * 左边缘」，线会先向右再强行折回左边，看着像画错了。所以目标整个落在源节点
 * 左侧时改成「源的左边缘 → 目标的右边缘」：几何上镜像一下，箭头依然指进目标，
 * 方向读起来才是对的。
 */
export function edgePath(from, to) {
  if (to.x + to.w <= from.x) {
    const mx1 = from.x                  // 源节点左边缘
    const my1 = from.y + from.h / 2
    const mx2 = to.x + to.w             // 目标节点右边缘
    const my2 = to.y + to.h / 2
    const mdx = Math.max(32, Math.abs(mx2 - mx1) * 0.55)
    return `M ${mx1} ${my1} C ${mx1 - mdx} ${my1}, ${mx2 + mdx} ${my2}, ${mx2} ${my2}`
  }

  const x1 = from.x + from.w      // 父节点右边缘
  const y1 = from.y + from.h / 2  // 父节点垂直中心
  const x2 = to.x                 // 子节点左边缘
  const y2 = to.y + to.h / 2      // 子节点垂直中心

  // 控制点外推距离：随水平间距增长，但保底 32px，避免近距离时曲线过直
  const dx = Math.max(32, Math.abs(x2 - x1) * 0.55)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}