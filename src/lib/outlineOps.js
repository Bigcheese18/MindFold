/**
 * 缩进列表的行操作（纯函数）
 * ==========================
 * 从 OutlineList 组件里抽出来，原因有两个：
 *   1. 这些是编辑器的核心逻辑（缩进、换行、合并、删除、折叠），值得单独测；
 *   2. headless 浏览器不会把按键路由到 input 上（实测 window 能收到、input 收不到），
 *      键盘行为没法用浏览器端到端验证，抽成纯函数就能在 Node 里测干净。
 *
 * 所有函数都返回**新的**数组/集合，不改动入参。
 */

let seq = 0
export const newRow = (depth = 0, label = '') => ({ key: `r${++seq}`, depth, label })

/** 缩进列表文本 → 行数组（丢掉空行；列表符号会被规范化掉） */
export function textToRows(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const expanded = l.replace(/\t/g, '  ')
      const indent = expanded.match(/^ */)[0].length
      const label = expanded.trim().replace(/^([-*+]|\d+[.)])\s+/, '')
      return newRow(Math.floor(indent / 2), label)
    })
}

/** 行数组 → 文本（规范化为 2 空格缩进） */
export function rowsToText(rows) {
  return rows.map((r) => '  '.repeat(r.depth) + r.label).join('\n')
}

/**
 * 计算父子关系。
 * 必须和 outlineToMermaid 里的算法**完全一致**，否则左边看到的层级
 * 和右边生成的图会对不上（这正是之前出孤立节点的根源）。
 */
export function computeParents(rows) {
  const stack = []
  const parent = new Array(rows.length).fill(-1)
  const childCount = new Array(rows.length).fill(0)

  rows.forEach((r, i) => {
    let p = -1
    for (let d = r.depth - 1; d >= 0; d--) {
      if (stack[d] !== undefined) { p = stack[d]; break }
    }
    // 缩进了却没有上级 → 挂到前一行（与编译器里的兜底一致）
    if (p === -1 && r.depth > 0 && i > 0) p = i - 1

    parent[i] = p
    stack.length = r.depth + 1
    stack[r.depth] = i
    if (p >= 0) childCount[p]++
  })

  return { parent, childCount }
}

/** 折叠后需要显示的行：[{ index, depth, collapsed, hasChildren }] */
export function visibleRows(rows, collapsed = new Set()) {
  const { parent, childCount } = computeParents(rows)
  const out = []
  const walk = (i, depth) => {
    const isCollapsed = collapsed.has(rows[i].key)
    out.push({ index: i, depth, collapsed: isCollapsed, hasChildren: childCount[i] > 0 })
    if (isCollapsed) return
    for (let j = i + 1; j < rows.length; j++) {
      if (parent[j] === i) walk(j, depth + 1)
      else if (parent[j] === -1 || parent[j] < i) break
    }
  }
  for (let i = 0; i < rows.length; i++) {
    if (parent[i] === -1) walk(i, 0)
  }
  return out
}

/** 第 i 行最多能缩进到第几级：不能比上一行深超过一级 */
export function maxAllowedDepth(rows, i) {
  const prev = rows[i - 1]
  return (prev ? prev.depth : -1) + 1
}

/** 在第 i 行之后插入一行 */
export function insertAfter(rows, i, depth) {
  const row = newRow(depth, '')
  const next = rows.slice()
  next.splice(i + 1, 0, row)
  // changed 必须显式给 true：OutlineList 的 apply() 用 `if (!result.changed) return`
  // 做统一守卫，漏了这个字段的话按 Enter 会静默无反应。
  return { rows: next, changed: true, focusKey: row.key, caret: 0 }
}

/** 改变第 i 行的缩进（delta = +1 / -1），并夹到合法范围 */
export function changeDepth(rows, i, delta) {
  const cur = rows[i]
  if (!cur) return { rows, changed: false }
  let d = cur.depth + delta
  d = Math.max(0, Math.min(d, maxAllowedDepth(rows, i)))
  if (d === cur.depth) return { rows, changed: false }
  const next = rows.slice()
  next[i] = { ...cur, depth: d }
  return { rows: next, changed: true, focusKey: cur.key }
}

/** 光标在行首按退格：把当前行并入上一行，返回光标应落的位置 */
export function mergeWithPrev(rows, i) {
  if (i <= 0) return { rows, changed: false }
  const cur = rows[i]
  const prev = rows[i - 1]
  const caret = prev.label.length
  const next = rows.slice()
  next[i - 1] = { ...prev, label: prev.label + cur.label }
  next.splice(i, 1)
  return { rows: next, changed: true, focusKey: next[i - 1].key, caret }
}

/** 删除第 i 行；只剩一行时清空内容而不是删掉 */
export function deleteRow(rows, i) {
  if (rows.length <= 1) {
    const next = rows.slice()
    next[0] = { ...next[0], label: '' }
    return { rows: next, changed: true, focusKey: next[0].key, caret: 0 }
  }
  const next = rows.slice()
  const [removed] = next.splice(i, 1)
  const focus = next[Math.max(0, i - 1)]
  return { rows: next, changed: true, focusKey: focus.key, caret: 'end', removedKey: removed.key }
}

/** 切换折叠状态，返回新的 Set */
export function toggleCollapsed(collapsed, key) {
  const next = new Set(collapsed)
  next.has(key) ? next.delete(key) : next.add(key)
  return next
}

/**
 * 多行粘贴：把文本按行拆开，整体缩进到 baseDepth。
 * 单行粘贴不处理（交给浏览器默认行为，保留光标位置）。
 */
export function pasteRows(rows, i, text) {
  if (!/[\n\r]/.test(String(text || ''))) return { rows, changed: false }
  const base = rows[i] ? rows[i].depth : 0
  const pasted = textToRows(text).map((r) => ({ ...r, depth: base + r.depth }))
  if (!pasted.length) return { rows, changed: false }
  const next = rows.slice()
  next.splice(i + 1, 0, ...pasted)
  return { rows: next, changed: true, focusKey: pasted[pasted.length - 1].key, caret: 'end' }
}

/**
 * 同级分组：给每一行算一个「组序号」，相邻的兄弟组交替着色。
 * 这样即使缩进很浅，也能一眼看出哪几行属于同一组。
 */
export function groupTints(rows) {
  const { parent } = computeParents(rows)
  const seen = new Map()
  let g = 0
  return rows.map((_, i) => {
    const p = parent[i]
    const gk = p === -1 ? `root-${i}` : `n-${p}`
    if (!seen.has(gk)) seen.set(gk, g++ % 2)
    return seen.get(gk)
  })
}

/* ------------------------------------------------------------------ */
/* 文本级封装                                                          */
/* ------------------------------------------------------------------ */
/*
 * 右侧流程图上的操作（改字 / 新增同级 / 新增子节点 / 删除）都**不直接改图**，
 * 而是回到左侧的缩进文本上改，再由文本重新编译出图 ——
 * 这样「左侧文本」永远是唯一的事实来源，两边不会打架。
 */

/** 在文本上执行一个行操作，返回新文本 */
function withRows(outline, fn) {
  const rows = textToRows(outline)
  const r = fn(rows)
  if (!r || !r.changed) return null
  return rowsToText(r.rows)
}

/** 改第 i 行的文字 */
export function setRowLabelText(outline, i, label) {
  const rows = textToRows(outline)
  if (!rows[i]) return null
  if (rows[i].label === label) return null
  const next = rows.slice()
  next[i] = { ...next[i], label }
  return rowsToText(next)
}

/** 在第 i 行后面新增一个同级节点 */
export function insertSiblingText(outline, i, label = '新节点') {
  const rows = textToRows(outline)
  if (!rows[i]) return null
  const row = newRow(rows[i].depth, label)
  const next = rows.slice()
  next.splice(i + 1, 0, row)
  return rowsToText(next)
}

/** 在第 i 行后面新增一个子节点（缩进一级） */
export function insertChildText(outline, i, label = '新节点') {
  const rows = textToRows(outline)
  if (!rows[i]) return null
  const row = newRow(rows[i].depth + 1, label)
  const next = rows.slice()
  next.splice(i + 1, 0, row)
  return rowsToText(next)
}

/**
 * 删除第 i 行，并把它的**直接子节点提升一级**（挂到它的父节点下）。
 *
 * 为什么不连子树一起删：右键菜单点一下就静默丢掉一整棵子树太危险了。
 * 提升一级能保证内容一个不丢，结构也仍然成立 —— 子节点升一级后，
 * 孙节点相对它的层级不变（编译时按「最近的更浅一级」找父节点，仍然挂在原父节点下）。
 */
export function deleteRowText(outline, i) {
  const rows = textToRows(outline)
  if (!rows[i]) return null
  if (rows.length <= 1) return ''   // 只剩一行 → 清空
  const { parent } = computeParents(rows)
  const next = []
  for (let k = 0; k < rows.length; k++) {
    if (k === i) continue
    next.push(parent[k] === i ? { ...rows[k], depth: Math.max(0, rows[k].depth - 1) } : rows[k])
  }
  return rowsToText(next)
}

export { withRows }
