/**
 * 主画布的撤销 / 重做历史栈（纯函数）
 * ====================================
 * 【和另外两套「历史」的区别，别搞混】
 *   1. `src/lib/history.js`      —— **全屏折角弹窗内**的 Mermaid 源码历史
 *   2. `store.js` 的 `hist:<id>` —— 文档的**历史版本**（左下角时钟按钮，落盘、最多 10 版）
 *   3. 本模块                     —— **主画布**的节点树历史（拖拽 / 改字 / 折角 / 删除）
 *
 * 三者互相独立，谁都不能消费或清空谁的栈。第 3 个和第 1 个尤其要分清：
 * 画布上的 Ctrl+Z 绝不能把用户在弹窗里写的流程图退掉。
 *
 * ---------------------------------------------------------------------------
 * 【为什么不用 history.js 那套 past/current/future】
 * 那套要求调用方每次变更都把「新状态」也交进来（它自己维护 current）。
 * 主画布存在若干**不记录历史**的树变更（弹窗保存折角内容、恢复历史版本），
 * 一旦漏交一次，它内部的 current 就过期了，下一次 commitSnapshot 会把
 * 过期的状态压进 past —— 撤销就会跳到莫名其妙的地方。
 *
 * 这里换成更抗造的形状：`past` / `future` 两个数组，**不保存 current**。
 * 撤销时由调用方把「当前树」现传进来，所以不管中间有多少旁路变更都不会错位。
 *
 * ---------------------------------------------------------------------------
 * 【快照存什么】
 * 整棵节点树的深拷贝（含折角内容）。恢复时用 `mergeFoldContent` 合并：
 * 结构 / 文字 / 样式听快照的，**折角内容听当前树的**。
 * 这一条是「作用域严格隔离」在数据层面的落点 —— 见 mergeFoldContent 的注释。
 *
 * 全部是纯函数：不改入参、返回新对象，可以在 Node 里测干净。
 */

import { cloneTree, walkTree, normalizeRelations } from './model.js'

/** 主画布的历史深度。画布操作比打字粗得多，可以比弹窗（20）留多一点 */
export const CANVAS_HISTORY_LIMIT = 30

export function emptyCanvasHistory() {
  return { past: [], future: [] }
}

/**
 * 两条 relations 列表在**画布语义**上是否相同。
 *
 * 只比 from/to 集合，顺序不影响渲染 —— 用户在 A、B 上依次操作得到
 * `[A→C, B→C]` 还是 `[B→C, A→C]`，画出来是同一条线。
 * 不做这一步的话，「在原顺序上重排一下」会被误判成一次可撤销的变更。
 */
export function sameRelations(a, b) {
  const na = normalizeRelations(a)
  const nb = normalizeRelations(b)
  if (na.length !== nb.length) return false
  const key = (r) => `${r.from}\u0000${r.to}`
  const setB = new Set(nb.map(key))
  return na.every((r) => setB.has(key(r)))
}

/**
 * 两棵树的**画布语义**是否相同。
 *
 * 刻意忽略三样东西：
 *   · `fold.mermaid` / `fold.outline` —— 那是弹窗的地盘（改它不该占画布的历史格）
 *   · `fold.openCount`                —— 只是「看过几次」的计数，不是内容
 *   · `fold.updatedAt`                —— 时间戳，同上
 *
 * 这一条同时解决了两个问题：
 *   1. 点开折角（openCount+1）不会产生一个假的「可撤销」历史点；
 *   2. 弹窗里改代码时，即使忘了传 record:false 也不会污染画布历史。
 *
 * 比的是 id / 文字 / 折叠 / 粗斜体 / 有没有折角 / corner / 子节点顺序，
 * 也就是画布上「看得见、摸得着」的全部内容。
 */
export function sameCanvasTree(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.id !== b.id || a.text !== b.text) return false
  if (!!a.collapsed !== !!b.collapsed) return false
  if (!!a.bold !== !!b.bold) return false
  if (!!a.italic !== !!b.italic) return false
  if (!!a.fold !== !!b.fold) return false
  if (a.fold && b.fold && !!a.fold.corner !== !!b.fold.corner) return false
  const ca = a.children || []
  const cb = b.children || []
  if (ca.length !== cb.length) return false
  for (let i = 0; i < ca.length; i++) {
    if (!sameCanvasTree(ca[i], cb[i])) return false
  }
  return true
}

/**
 * 记录一次「已经生效」的变更。
 *
 * @param state   当前历史
 * @param prevTree **变更前**的那棵树（undo 要回到它）
 * @param changed 这次操作有没有真的改变树
 * @param prevRelations 变更前的 relations（可省略 → 视为空）
 * @returns 新历史
 *
 * 没有实质变化时**原样返回**：不入栈，也**不清空 future**。
 * 后者很重要 —— 用户撤销之后随手点一下不产生变化的操作（比如原样提交文字），
 * 重做链不能就这么没了。
 *
 * 入栈的是深拷贝：快照一旦进栈就与外界无关，调用方后续怎么改树都不影响它。
 * 不这么做的话「快照不可变」就变成了一条只靠调用方自觉维持的口头约定。
 *
 * 【relations 必须和树进同一个快照】
 * 「指向同一结果」一次改动两个东西：树上多一个节点、relations 里多两条虚线。
 * 若只存树，撤销之后节点没了、虚线还在，就变成两条指向空气的悬空虚线；
 * 只存虚线则相反。两者必须打包在同一次快照里，同进同退。
 */
export function recordCanvasSnapshot(state, prevTree, changed, prevRelations = null) {
  if (!changed || !prevTree) return state
  const past = [...state.past, {
    tree: cloneTree(prevTree, true),
    relations: normalizeRelations(prevRelations),
  }]
  if (past.length > CANVAS_HISTORY_LIMIT) past.splice(0, past.length - CANVAS_HISTORY_LIMIT)
  return { past, future: [] }
}

/**
 * 撤销一步。
 * @param currentTree 画布**当前**的树，会被压进 future 供重做使用
 * @param currentRelations 画布当前的 relations，同上
 * @returns {{ history, tree, relations } | null}  null = 没有可撤销的
 */
export function undoCanvas(state, currentTree, currentRelations = null) {
  if (!state?.past?.length) return null
  const entry = state.past[state.past.length - 1]
  const future = [
    { tree: cloneTree(currentTree, true), relations: normalizeRelations(currentRelations) },
    ...state.future,
  ]
  if (future.length > CANVAS_HISTORY_LIMIT) future.length = CANVAS_HISTORY_LIMIT
  return {
    history: { past: state.past.slice(0, -1), future },
    tree: entry.tree,
    relations: entry.relations || [],
  }
}

/** 重做一步。语义与 undoCanvas 对称。 */
export function redoCanvas(state, currentTree, currentRelations = null) {
  if (!state?.future?.length) return null
  const entry = state.future[0]
  const past = [...state.past, {
    tree: cloneTree(currentTree, true),
    relations: normalizeRelations(currentRelations),
  }]
  if (past.length > CANVAS_HISTORY_LIMIT) past.splice(0, past.length - CANVAS_HISTORY_LIMIT)
  return {
    history: { past, future: state.future.slice(1) },
    tree: entry.tree,
    relations: entry.relations || [],
  }
}

export function canCanvasUndo(state) {
  return !!state && state.past.length > 0
}
export function canCanvasRedo(state) {
  return !!state && state.future.length > 0
}

/**
 * 把历史快照与当前树合并成「要写回去的那棵树」。
 *
 * 【为什么必须合并，而不是直接写回快照】
 * 折角里的流程图（`fold.mermaid` / `fold.outline`）是用户在**全屏弹窗**里
 * 一个字一个字写出来的，它属于弹窗的地盘。而画布快照是整棵树的拷贝，
 * 时间点上可能早于那次编辑。若直接写回，就会出现这种事故：
 *
 *     拖一下节点  →  打开弹窗写流程图  →  关闭  →  画布按 Ctrl+Z
 *     ⇒ 流程图被退回到「拖拽之前」，用户刚写的东西凭空消失
 *
 * 所以规则是：
 *   · 快照里**还有折角**、当前树里**也还有折角** → 整个折角用**当前**的
 *     （内容、熟悉度、实心/空心标记全部听当前的 —— 这次撤销不该动折角）
 *   · 快照里还有折角、当前树里已经没有（正在撤销「取消折角」）→ 用快照的
 *     （把删掉的内容整个还回来）
 *   · 快照里就没有折角 → 结果也没有（正在撤销「打上折角」）
 *
 * 【为什么是「整个折角」而不是逐字段挑】
 * `fold.corner` 表达的是「这个折角有没有内容」（实心 / 空心角标），
 * 它和 `fold.mermaid` 是联动的。若内容取当前的、corner 取快照的，
 * 就会出现「有流程图却显示空心折角」这种自相矛盾的状态。
 * 一个折角要么整份听当前的，要么整份听快照的 —— 没有第三种。
 *
 * 结果是：画布撤销只动结构 / 文字 / 样式，折角内容永远跟着当前树走 ——
 * 两套历史在**数据层**也彻底隔离开了，而不只是两个互不相干的数组。
 *
 * 返回的是一棵**新树**，快照本身不会被改动（否则重做就回不去了）。
 */
export function mergeFoldContent(snapRoot, currentRoot) {
  // 当前树里「还有折角」的节点 → 它那份折角
  const live = new Map()
  walkTree(currentRoot, (n) => {
    if (n.fold) live.set(n.id, n.fold)
  })

  const rebuild = (n) => {
    const cur = n.fold ? live.get(n.id) : null
    return {
      ...n,
      // 浅拷贝一层：新树不和外面对同一个 fold 对象
      fold: n.fold ? { ...(cur || n.fold) } : null,
      children: (n.children || []).map(rebuild),
    }
  }
  return rebuild(snapRoot)
}
