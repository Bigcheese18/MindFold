/**
 * 弹窗内的撤销/重做历史栈（纯函数）
 * ==================================
 * 【作用域】
 * 只管**当前折角弹窗内的 Mermaid 源码**（以及与之同步的缩进列表）。
 * 主画布上的节点层级 / 位置变动完全不在这里 —— 那属于文档级操作，
 * 混进同一个栈里会出现「撤销一下把整棵树的层级也退了」的灾难。
 *
 * 【为什么快照要同时存 code 和 outline】
 * 两侧是互相同步的：代码模式改的是 code，缩进模式改的是 outline。
 * 只存 code 的话，在缩进模式撤销会把用户手写的缩进排版冲掉
 * （code → outline 的反推是规范化的，结构会被重排）。
 * 所以两个都存，恢复时原样写回。
 *
 * rowIds 是「行下标 → 图上节点 id」的映射，也必须一起存：
 * 它由 code 和 outline 的关系决定，不能事后重算。
 *
 * 全部是纯函数，不改动入参，返回新对象 —— 这样可以在 Node 里测干净。
 */

export const HISTORY_LIMIT = 20

/** 快照相等判定：只比 code 和 outline（rowIds 是派生数据） */
export function sameSnapshot(a, b) {
  if (!a || !b) return false
  return a.code === b.code && a.outline === b.outline
}

/** 空历史 */
export function emptyHistory() {
  return { past: [], future: [], current: null }
}

/** 用初始快照开一个历史（打开弹窗时调用，等价于清空） */
export function initHistory(snapshot) {
  return { past: [], future: [], current: snapshot }
}

/**
 * 记录一次「已经生效」的新状态。
 *
 * 注意入栈的是**变化前的状态**（current），这样 undo 才能回到它。
 * 没有实质变化就不入栈，并且**不清空 future** ——
 * 否则用户撤销后随手点一下不产生变化的操作，重做链就没了。
 *
 * @returns {{ past, future, current, pushed: boolean }}
 */
export function commitSnapshot(state, next) {
  const { past, current, future } = state
  if (!current) return { past, future, current: next, pushed: false }
  if (sameSnapshot(current, next)) return { past, future, current, pushed: false }

  const np = [...past, current]
  if (np.length > HISTORY_LIMIT) np.splice(0, np.length - HISTORY_LIMIT)
  return { past: np, future: [], current: next, pushed: true }
}

/**
 * 撤销一步。没有可撤销的返回 null（调用方据此什么都不做）。
 * current 会被压进 future，所以重做能原路返回。
 */
export function undoSnapshot(state) {
  const { past, future, current } = state
  if (!past.length || !current) return null
  const prev = past[past.length - 1]
  const np = past.slice(0, -1)
  const nf = [current, ...future]
  if (nf.length > HISTORY_LIMIT) nf.length = HISTORY_LIMIT
  return { past: np, future: nf, current: prev }
}

/** 重做一步。没有可重做的返回 null。 */
export function redoSnapshot(state) {
  const { past, future, current } = state
  if (!future.length || !current) return null
  const next = future[0]
  const nf = future.slice(1)
  const np = [...past, current]
  if (np.length > HISTORY_LIMIT) np.splice(0, np.length - HISTORY_LIMIT)
  return { past: np, future: nf, current: next }
}

/** 能不能撤销 / 重做（UI 置灰用） */
export function canUndo(state) {
  return !!state && state.past.length > 0
}
export function canRedo(state) {
  return !!state && state.future.length > 0
}
