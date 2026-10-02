/**
 * 树的移动操作 + 汇聚关系（纯函数）
 * ================================
 * 拖拽改层级是「改结构」里最容易出错的一类操作：跨层级、同层换序、
 * 拖进自己的子树形成环、目标正好是自己的父节点…… 这里把逻辑收成一个
 * 纯函数，就能把这些情况逐条测掉。
 *
 * 注意：**原地修改**传入的 root（调用方负责先 cloneTree）。
 *
 * ---------------------------------------------------------------------------
 * 【「指向同一结果」为什么放在这里】
 * 它做两件事：在树上挂一个新节点（结构变更）、往 relations 里加两条虚线。
 * 两件事都必须能整体成功或整体失败，否则会出现「节点建了但虚线没建」这种
 * 半截状态。收成纯函数就能在 Node 里把每个边界逐条测掉（见 relatestest）。
 */

// 显式写 .js：Vite 能省略扩展名，但 Node 直接跑测试时不行
import { findNode, findParent, makeNode, walkTree } from './model.js'

/**
 * 把 dragId 节点移动到 targetId 节点处。
 *
 * @param position 'child'  成为目标的子节点（追加到末尾）
 *                 'before' 插到目标前面（成为它的上一个兄弟）
 *                 'after'  插到目标后面（成为它的下一个兄弟）
 * @returns {{ moved: boolean, reason?: string }}
 */
export function moveNode(root, dragId, targetId, position = 'child') {
  if (dragId === targetId) return { moved: false, reason: 'self' }

  const src = findNode(root, dragId)
  const oldParent = findParent(root, dragId)
  const target = findNode(root, targetId)
  if (!src || !oldParent || !target) return { moved: false, reason: 'missing' }
  // 根节点不能移动（没有父节点可以摘下来）
  if (oldParent.id === root.id && root.children.length === 0) return { moved: false, reason: 'missing' }

  // 不能把节点拖进自己的子树，否则会形成环（自己成为自己的祖先）
  for (let p = target; p; p = findParent(root, p.id)) {
    if (p.id === dragId) return { moved: false, reason: 'cycle' }
  }

  if (position === 'child') {
    oldParent.children = oldParent.children.filter((c) => c.id !== dragId)
    target.children.push(src)
    target.collapsed = false   // 拖进去的节点如果被折叠了会「看不见」，展开它
    return { moved: true }
  }

  // before / after：插到目标的兄弟位置
  const targetParent = findParent(root, targetId)
  if (!targetParent) return { moved: false, reason: 'root-has-no-sibling' }

  // 先在旧位置摘掉，再在新位置插入。
  // 同层换序时 oldParent === targetParent：filter 会产生新数组并赋回
  // oldParent.children，所以下面的 findIndex 看到的是「已摘除」的列表，
  // 索引不会因为先摘后插而偏移。
  oldParent.children = oldParent.children.filter((c) => c.id !== dragId)
  const idx = targetParent.children.findIndex((c) => c.id === targetId)
  if (idx < 0) return { moved: false, reason: 'target-gone' }
  targetParent.children.splice(position === 'before' ? idx : idx + 1, 0, src)
  return { moved: true }
}

/* ================================================================== */
/* 「指向同一结果」（多对一汇聚）                                        */
/* ================================================================== */

export const DEFAULT_RESULT_LABEL = '新结果节点'

/**
 * 一个节点从根到自己的 id 路径（含自己）。
 *
 * 用 `parentById` 映射而不是每次现找父节点：找 N 个节点的祖先链时，
 * 每次 `findParent` 都要遍历整棵树，节点一多就是 O(N²)。
 *
 * @returns {string[]}  [根, …, 自己]；节点不存在时返回 []
 */
export function pathToRoot(root, id, parentById = null) {
  const byId = parentById || buildParentMap(root)
  // 节点根本不在树里 → 空路径。
  // 不检查的话会返回 `[id]`（它自己），因为循环先 push 再发现没有父亲。
  // 那样 LCA 会把一个不存在的 id 当成合法祖先，得出荒谬的结论。
  if (!byId.has(id)) return []
  const path = []
  let cur = id
  // 防御自引用 / 环：最多走 10000 层
  for (let guard = 0; cur != null && guard < 10000; guard++) {
    path.push(cur)
    const p = byId instanceof Map ? byId.get(cur) : byId[cur]
    if (p === undefined || p === null) break
    cur = p
  }
  return path.reverse()
}

/** id → 父节点 id 的映射（根节点映射到自己，方便 LCA 收敛） */
export function buildParentMap(root) {
  const map = new Map()
  const walk = (n, parentId) => {
    map.set(n.id, parentId)
    for (const c of n.children || []) walk(c, n.id)
  }
  walk(root, null)
  return map
}

/**
 * 最近公共祖先（Lowest Common Ancestor）。
 *
 * 实现：把 A 的祖先链收进 Set（含 A 自己），再从 B **由近及远**往上走，
 * 第一个落在 Set 里的就是 LCA —— 从近处开始找，命中必然是最低的那个，
 * 不需要额外比较深度。
 *
 * 【这里是倒着遍历的，别改成正序】
 * pathToRoot 返回的是 `[根, …, 自己]`（正序）。若直接 for...of 就是
 * 根 → 自己（由远及近），第一次命中会返回**最高的**公共祖先 ——
 * 对 `LCA(n1, n2)`（n1 是 n2 的父节点）会返回 n0 而不是 n1，
 * 于是「父子关系」下新节点会挂到爷爷下面，虚线横穿两层。
 * 必须从数组末尾（自己）往回走才是「最近」。
 *
 * @returns {string|null}  两个节点都在树里时一定有值（至少是根）
 */
export function lowestCommonAncestor(root, aId, bId, parentById = null) {
  const byId = parentById || buildParentMap(root)
  const mine = new Set(pathToRoot(root, aId, byId))
  if (!mine.size) return null
  const pathB = pathToRoot(root, bId, byId)
  for (let i = pathB.length - 1; i >= 0; i--) {
    if (mine.has(pathB[i])) return pathB[i]
  }
  return null
}

/**
 * 是不是「A 和 B 已经是同一个汇聚结果」——即存在某个节点 C，
 * 使得 `A → C` 和 `B → C` 两条关系都在。
 *
 * 用于防重复：同一对节点反复操作时不该再生成一个新的结果节点。
 *
 * @returns {string|null}  已存在的那个结果节点 id
 */
export function findSharedTarget(relations, aId, bId) {
  const list = Array.isArray(relations) ? relations : []
  // A 指向的所有节点 → 看 B 有没有指向同一个
  const toOfA = new Set()
  for (const r of list) {
    if (r && r.from === aId && r.to) toOfA.add(r.to)
  }
  if (!toOfA.size) return null
  for (const r of list) {
    if (r && r.from === bId && r.to && toOfA.has(r.to)) return r.to
  }
  return null
}

/** 关系列表里有没有这条边（去重用） */
export function hasRelation(relations, from, to) {
  return (Array.isArray(relations) ? relations : []).some((r) => r && r.from === from && r.to === to)
}

/**
 * 去掉所有指向 / 出发自这些 id 的关系记录。
 *
 * 【为什么删除节点必须联动清理】
 * relations 存的是裸 id。节点被删掉之后那些 id 就成了悬空引用，
 * 渲染层会画出「从空气到空气」的虚线，layout 里查 byId 也查不到。
 * 所以删除节点时必须把相关的两条都剪掉。
 *
 * @returns {Array} 新数组
 */
export function pruneRelations(relations, removedIds) {
  const gone = removedIds instanceof Set ? removedIds : new Set(removedIds || [])
  if (!gone.size) return Array.isArray(relations) ? relations.slice() : []
  return (Array.isArray(relations) ? relations : [])
    .filter((r) => r && !gone.has(r.from) && !gone.has(r.to))
}

/** 收集一棵子树里所有节点的 id（删除时用来连带清理 relations） */
export function subtreeIds(node) {
  const out = []
  const walk = (n) => {
    out.push(n.id)
    for (const c of n.children || []) walk(c)
  }
  if (node) walk(node)
  return out
}

/**
 * 计算「A 和 B 的汇聚点应该挂在哪」——也就是 LCA 这个公共父节点。
 *
 * 【为什么不能用「A 的父节点」】
 * 需求里写了 A、B 可能是**父子关系**：B 是 A 的孙子。此时若把新节点挂在
 * A 的父节点下，B 到新节点的虚线会横穿好几层，视觉上完全是乱的。
 * LCA 对这种情况天然给出正确的答案：
 *
 *     A 是 B 的祖先 → LCA(A,B) = A        → 新节点成为 A 的另一个子节点
 *     A 和 B 是兄弟 → LCA(A,B) = 它们的父   → 新节点成为第三个兄弟
 *     A 和 B 跨分支 → LCA 是两条链的分叉点  → 挂在分叉点下，虚线最短
 *
 * @returns {{ ok:true, parentId } | { ok:false, reason }}
 *   reason: 'self'        A 和 B 是同一个节点
 *           'missing'     节点不在树里
 *           'root-parent' 公共父节点就是根节点，且它就是 A 或 B 本身
 */
export function planConvergence(root, aId, bId) {
  if (aId === bId) return { ok: false, reason: 'self' }
  const a = findNode(root, aId)
  const b = findNode(root, bId)
  if (!a || !b) return { ok: false, reason: 'missing' }

  const parentById = buildParentMap(root)
  const lca = lowestCommonAncestor(root, aId, bId, parentById)
  if (!lca) return { ok: false, reason: 'missing' }

  // LCA 就是 A 或 B 自己时（父子关系），新节点挂在它下面即可 ——
  // 这正是「成为它的另一个子节点」，虚线从子代直接连上来，最短。
  return { ok: true, parentId: lca, lca }
}

/**
 * 执行「指向同一结果」：新建汇聚节点 + 两条 relations。
 *
 * 全部落在一个函数里，保证原子性：任何一步失败都**不改动**传入的 root 和
 * relations（先算后写）。
 *
 * 插入位置：追加在公共父节点的**最后一个子节点之后**（需求明确要求
 * 「不打乱原有顺序」）。追加在末尾天然满足这一点 —— 它不会挤动任何已有兄弟。
 *
 * @returns {{ ok:true, newNodeId, parentId, relations, label } | { ok:false, reason, existing? }}
 *   reason: 'self' | 'missing' | 'duplicate'
 */
export function convergeToNewNode(root, relations, aId, bId, label = DEFAULT_RESULT_LABEL) {
  const plan = planConvergence(root, aId, bId)
  if (!plan.ok) return { ok: false, reason: plan.reason }

  // 防重复：A、B 已经指向同一个节点 → 不再生成第二个
  const existing = findSharedTarget(relations, aId, bId)
  if (existing) return { ok: false, reason: 'duplicate', existing }

  const parent = findNode(root, plan.parentId)
  if (!parent) return { ok: false, reason: 'missing' }

  const fresh = makeNode(label)
  // 追加到末尾：不打乱原有顺序（splice 到中间会让后面的兄弟整体右移一层）
  parent.children.push(fresh)
  // 公共父节点折叠着的话，新节点根本看不见 —— 展开它
  parent.collapsed = false

  const nextRelations = (Array.isArray(relations) ? relations.slice() : [])
  // A、B 相同的情况在 planConvergence 已经被挡掉，这里两条必然不同
  if (!hasRelation(nextRelations, aId, fresh.id)) nextRelations.push({ from: aId, to: fresh.id })
  if (!hasRelation(nextRelations, bId, fresh.id)) nextRelations.push({ from: bId, to: fresh.id })

  return {
    ok: true,
    newNodeId: fresh.id,
    parentId: parent.id,
    relations: nextRelations,
    label,
    expanded: true,
  }
}

/**
 * 同一个文档里，某个节点参与的所有 relations。
 * 悬停高亮 + 「只显示相关线」模式用它。
 */
export function relationsOf(relations, id) {
  return (Array.isArray(relations) ? relations : []).filter((r) => r && (r.from === id || r.to === id))
}

/** 虚线数量超过这个值时，画布默认只显示「悬停节点相关的线」 */
export const RELATION_HIDE_THRESHOLD = 50

/**
 * 导入大图优化（PRD 第三章）：
 * 节点数 > 50 时，默认只展开前两层，其余折叠。
 *
 * 放在这里而不是 App 里：它是纯粹的树变换，和上面几个函数同类。
 */
export function applyLargeImportDefault(root, total) {
  if (total <= 50) return
  walkTree(root, (n, parent) => {
    // parent 为 null 是根；根与第一层保持展开，第一层以下的父节点收起
    if (!parent) return
    if (parent.id === root.id) return
    if (n.children.length) n.collapsed = true
  })
}
