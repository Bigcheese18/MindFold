/**
 * Mermaid 源码的结构化编辑（纯函数）
 * ====================================
 * 「纯代码模式」下右侧流程图上的右键操作**不能**再回到缩进列表去改 ——
 * 那会用缩进列表重新编译，把用户手写的多对一 / 环 / 边标签全部冲掉。
 * 所以这些操作直接改 Mermaid 源码。
 *
 * 设计要点：
 *
 * 1. **按行插入到「定义区」和「边区」**，而不是无脑追加到末尾。
 *    追加到末尾也能跑，但代码会越来越乱；分行插入能让生成结果看起来
 *    像是人手写的。
 *
 * 2. **原子性**：所有函数都是「先算出新代码 → 重新解析校验 → 通过才返回」。
 *    校验不通过就返回 `{ ok:false }`，调用方一个字都不改。
 *    这样不会出现「插了定义没插边」的半成品，也就不会产生孤立节点。
 *
 * 3. **唯一 ID 靠递增 + 冲突检测**，而不是随机数 ——
 *    随机 id 在代码里很难看，而且用户可能想手写引用它。
 */

import { SHAPES, isShape, shapeOf, readNodeShape } from './shapes.js'

/**
 * 和 model.js 保持一致的 id 规则：允许连字符与中文。
 *
 * 导出给 codeLineMap.js 复用 —— 「什么算一个节点 id」这件事只能有一处定义，
 * 否则行号映射和编辑操作会对同一个字符串给出不同判断。
 *
 * 【连字符只能在 id 内部且不连续】理由见 model.js 同名字符串的注释：
 * `[A-Za-z0-9_-]+` 会把 `A-->B` 贪心吃成 id `A--`，导致 0 条边、
 * 删除/换位/合并全部失灵。这是一处**实测过的真实 bug**，不是理论洁癖。
 */
export const NODE_ID_SRC = '[A-Za-z0-9_\\u4e00-\\u9fa5](?:-?[A-Za-z0-9_\\u4e00-\\u9fa5])*'

/** 节点外形：["标签"] / [标签] / (标签) / {标签} / ((标签)) */
export const NODE_SHAPE_SRC = '\\(\\([^)]*\\)\\)|\\["[^"]*"\\]|\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}'

/** 箭头（用于识别「边行」与配对端点） */
const ARROW_TOK = '-->|==>|-\\.->'
const ARROW_ANY = new RegExp(ARROW_TOK)

/** 这行是样式 / 子图声明，不产生节点也不产生边 */
const META = /^\s*(classDef|class|style|linkStyle|click|direction|subgraph|end)\b/i

/** 这行是样式 / 子图声明吗（不产生节点，也不产生边） */
export function isMetaLine(line) {
  return META.test(String(line || ''))
}

/**
 * 把一行里所有「节点定义外形」缩成裸 id，并挖掉边标签 —— 只留 id 和箭头。
 * 导出版本给 codeLineMap 用，语义与内部实现完全一致。
 */
export function stripNodeShapes(line) {
  return stripLine(line)
}

/* 内部沿用短名字，读起来清爽些；定义只有上面那一处 */
const ID = NODE_ID_SRC
const SHAPE = NODE_SHAPE_SRC

/** 生成新的正则实例，避免模块级 lastIndex 串味 */
const defStripRe = () => new RegExp(`(${ID})\\s*(?:${SHAPE})`, 'g')
const defLineRe = () => new RegExp(`^(\\s*)(${ID})\\s*(?:\\(\\(|\\[|\\(|\\{)`)
const tokenRe = () => new RegExp(`${ID}|${ARROW_TOK}`, 'g')
const idRe = () => new RegExp(ID, 'g')

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* ------------------------------------------------------------------ */
/* 解析辅助                                                             */
/* ------------------------------------------------------------------ */

/** 把一行里所有「节点定义外形」缩成裸 id，并挖掉边标签 —— 只留 id 和箭头 */
function stripLine(line) {
  return String(line)
    .replace(defStripRe(), '$1')
    .replace(/\|[^|]*\|/g, ' ')   // -->|说明| 里的说明不是节点
}

/** 一行里按顺序出现的 id 与箭头 */
function tokensOf(line) {
  return [...stripLine(line).matchAll(tokenRe())].map((m) => m[0])
}

/** 这行是不是「边行」 */
export function isEdgeLine(line) {
  return ARROW_ANY.test(String(line))
}

/**
 * 列出现有节点 id（按首次出现顺序，已去重）。
 * 样式行、子图行、注释行会被跳过。
 */
export function listNodeIds(code) {
  const out = []
  const seen = new Set()
  for (const line of String(code || '').split('\n')) {
    if (!line.trim()) continue
    if (/^\s*(flowchart|graph)\b/i.test(line)) continue
    if (/^\s*%%/.test(line)) continue
    if (META.test(line)) continue
    for (const m of stripLine(line).matchAll(idRe())) {
      if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]) }
    }
  }
  return out
}

/**
 * 现有边集合，元素形如 `A\u0000B`（用不可见字符分隔，避免 id 里含分隔符）。
 * 支持链式 `A --> B --> C`：按 token 顺序配对，不会漏掉第二段。
 */
export function listEdges(code) {
  const out = new Set()
  for (const line of String(code || '').split('\n')) {
    if (!line.trim() || /^\s*%%/.test(line)) continue
    const toks = tokensOf(line)
    for (let i = 0; i + 2 < toks.length; i++) {
      const [a, arrow, b] = [toks[i], toks[i + 1], toks[i + 2]]
      if (!ARROW_ANY.test(arrow)) continue
      if (a === '-->' || a === '==>' || a === '-.->') continue
      if (b === '-->' || b === '==>' || b === '-.->') continue
      out.add(`${a}\u0000${b}`)
    }
  }
  return out
}

/**
 * 生成一个没被占用的节点 id：按现有 `n<数字>` 的最大值 +1。
 * 代码里一个 `n<数字>` 都没有时从 n0 开始。
 */
export function nextNodeId(code) {
  const ids = listNodeIds(code)
  let max = -1
  for (const id of ids) {
    const m = id.match(/^n(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  const used = new Set(ids)
  let n = max + 1
  while (used.has(`n${n}`)) n++
  return `n${n}`
}

/** 节点的父节点们（谁指向它） */
export function parentsOf(code, id) {
  const out = []
  for (const key of listEdges(code)) {
    const [a, b] = key.split('\u0000')
    if (b === id && !out.includes(a)) out.push(a)
  }
  return out
}

/** 节点的子节点们（它指向谁） */
export function childrenOf(code, id) {
  const out = []
  for (const key of listEdges(code)) {
    const [a, b] = key.split('\u0000')
    if (a === id && !out.includes(b)) out.push(b)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 代码顺序换位（Move Node）                                            */
/* ------------------------------------------------------------------ */
/*
 * 【为什么改代码顺序就能移动节点】
 * dagre 布局时按「边被加入的顺序」决定同一层里节点的左右次序：
 * 先写的排前面（TD 下是更靠左）。所以把 `P --> A` 和 `P --> B` 两行
 * 对调，A、B 在图上的左右位置就会颠倒。
 *
 * 这正是本功能的立足点：**只重排行，不改拓扑**。
 * 换位后校验「节点集合」和「边集合」必须与原来完全一致 ——
 * 只要有一个不一致就整体放弃。这样绝不可能把图改断。
 *
 * 跨层级提升/下沉会真的改拓扑，所以额外做了严格的环检测。
 */

/** 这个 token 是箭头吗 */
const isArrow = (t) => ARROW_ANY.test(t)

/**
 * 一行如果恰好是「一条边」，返回 [from, to]，否则返回 null。
 * 链式（A --> B --> C）、多边行都返回 null —— 这些行不能整行对调，
 * 因为对调会把中间节点的父子关系也换掉。
 */
function edgeEndpoints(line) {
  const toks = tokensOf(line)
  if (toks.length !== 3) return null
  if (!isArrow(toks[1]) || isArrow(toks[0]) || isArrow(toks[2])) return null
  return [toks[0], toks[2]]
}

/** 这一行是不是「只有一条节点声明」（纯声明行，不含边） */
function declOnlyId(line) {
  if (isEdgeLine(line)) return null
  const m = line.match(defLineRe())
  if (!m) return null
  // 整行去掉外形后必须只剩这个 id，否则不是纯声明行
  const rest = stripLine(line).trim()
  return rest === m[2] ? m[2] : null
}

/** 某个节点作为子节点时，父节点下所有子节点的**书写顺序** */
export function childrenInOrder(code, parentId) {
  const out = []
  for (const line of String(code || '').split('\n')) {
    const toks = tokensOf(line)
    for (let i = 0; i + 2 < toks.length; i++) {
      const [a, arrow, b] = [toks[i], toks[i + 1], toks[i + 2]]
      if (!isArrow(arrow) || isArrow(a) || isArrow(b)) continue
      if (a === parentId && !out.includes(b)) out.push(b)
    }
  }
  return out
}

/**
 * 同层级兄弟节点（按代码书写顺序）。
 * 没有父节点的节点，它的「同级」就是其他根节点。
 */
export function siblingsOf(code, id) {
  const src = String(code || '')
  const parents = parentsOf(src, id)
  if (parents.length) return childrenInOrder(src, parents[0])

  const edges = listEdges(src)
  const hasIn = new Set([...edges].map((k) => k.split('\u0000')[1]))
  return listNodeIds(src).filter((n) => !hasIn.has(n))
}

/** 节点在代码里有没有显式标签（`id["..."]` / `id[...]` / `id(...)` …） */
export function nodeHasLabel(code, id) {
  const re = new RegExp(`(^|[^\\w\\-])${escapeRe(id)}\\s*(?:\\(\\(|\\[|\\(|\\{)`)
  return String(code || '').split('\n').some((l) => re.test(stripComment(l)))
}

function stripComment(line) {
  return String(line).replace(/%%.*$/, '')
}

/**
 * 补全声明：节点只在连线里出现过（`n0 --> n1` 但没有 `n1["…"]`）时，
 * 给它补一行 `n1["n1"]`。
 *
 * 只在节点**完全没有标签**时才补 —— 如果它已经有行内标签
 * （`n0 --> n1["标签"]`），再补一行会造出两个互相打架的标签。
 * mermaid 对裸 id 的显示文字就是 id 本身，所以 `n1["n1"]` 语义完全等价。
 */
export function ensureDeclaration(code, id) {
  const src = String(code || '')
  if (nodeHasLabel(src, id)) return src
  const lines = src.split('\n')
  const { defAt } = insertionPoints(lines)
  const out = lines.slice()
  out.splice(defAt, 0, `  ${id}["${id}"]`)
  return out.join('\n')
}

/** 找到「父 --> 子」这条边的独立行下标（链式写法返回 -1） */
function findSimpleEdgeLine(lines, from, to) {
  for (let i = 0; i < lines.length; i++) {
    const ep = edgeEndpoints(lines[i])
    if (ep && ep[0] === from && ep[1] === to) return i
  }
  return -1
}

/** 找到某个节点的纯声明行下标 */
function findDeclLine(lines, id) {
  for (let i = 0; i < lines.length; i++) {
    if (declOnlyId(lines[i]) === id) return i
  }
  return -1
}

/** 交换两行 */
function swapAt(lines, i, j) {
  if (i < 0 || j < 0 || i === j) return false
  const t = lines[i]
  lines[i] = lines[j]
  lines[j] = t
  return true
}

const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x))

/** 在边集合上做可达性判断 */
function reachesIn(nodes, edgeSet, from, to) {
  const adj = new Map(nodes.map((n) => [n, []]))
  for (const k of edgeSet) {
    const [a, b] = k.split('\u0000')
    if (adj.has(a)) adj.get(a).push(b)
  }
  const seen = new Set([from])
  const stack = [from]
  while (stack.length) {
    const n = stack.pop()
    for (const m of adj.get(n) || []) {
      if (m === to) return true
      if (!seen.has(m)) { seen.add(m); stack.push(m) }
    }
  }
  return false
}

/**
 * 环检测 —— 只判「**这次操作新加的边**有没有闭合出一个环」。
 *
 * 为什么不直接比较「改前改后整张图有没有环」：
 * 用户完全可能故意写了一个环（`A→B→A` 是合法且常用的写法）。
 * 那种图改前就有环，用「整图有无环」做判据会被绕过 ——
 * 实测确实漏判过：在已有的三节点环上做提升，加出一条 2-节点环却放行了。
 *
 * 正确判据是：对每条新增边 u→v，看 v 能不能走回 u。能走回就是新闭合的环。
 */
function addedEdgesCloseCycle(nodes, oldEdges, newEdges) {
  const added = [...newEdges].filter((k) => !oldEdges.has(k))
  if (!added.length) return false
  for (const k of added) {
    const [u, v] = k.split('\u0000')
    if (u === v) return true                    // 自环
    if (reachesIn(nodes, newEdges, v, u)) return true
  }
  return false
}

/**
 * 换位/跨层级操作共用的安全校验。
 * 返回错误字符串，null 表示通过。
 */
function verifyMove(before, after) {
  const nodesA = listNodeIds(before)
  const nodesB = listNodeIds(after)
  if (nodesA.length !== nodesB.length || !nodesA.every((n) => nodesB.includes(n))) {
    return '节点集合发生了变化，已放弃修改'
  }
  if (addedEdgesCloseCycle(nodesA, listEdges(before), listEdges(after))) {
    return '这次移动会形成环（节点变成自己的后代），已拒绝'
  }
  return null
}

/**
 * 同级换位：把节点在同一层里往前 / 往后挪一位（A + C）。
 *
 * 【命名口径】函数名和 `dir` 用的是「代码顺序」的说法（-1 往前 / +1 往后），
 * 因为这一层只认代码行序。菜单上显示成「左移一位 / 右移一位」还是
 * 「上移一位 / 下移一位」，取决于布局方向（TD 同层左右排开，LR 上下排开）——
 * 那是展示层的事，由 FoldModal 的 `swapHoriz` 决定，不要写死在这里。
 *
 * 做的事纯粹是**重排行**：
 *   1. 交换「父 --> 自己」和「父 --> 兄弟」这两行连线
 *      —— 这才是决定 dagre 同级次序的东西
 *   2. 交换两者的纯声明行，让代码读起来和图一致
 *
 * 只重排、不改内容，所以拓扑天然不变；末尾仍然会重新解析校验一遍。
 *
 * @param dir -1 = 往前挪一位，+1 = 往后挪一位
 * @returns {{ok:true, code, movedTo}|{ok:false, boundary?:true, error}}
 */
export function moveSiblingOrder(code, id, dir) {
  const src = String(code || '')
  if (!/^\s*(flowchart|graph)\s/m.test(src)) {
    return { ok: false, error: '当前代码不是 flowchart' }
  }
  if (!listNodeIds(src).includes(id)) {
    return { ok: false, error: `代码里找不到节点 ${id}` }
  }

  const sibs = siblingsOf(src, id)
  const i = sibs.indexOf(id)
  if (i < 0) return { ok: false, error: `代码里找不到节点 ${id}` }
  const j = i + dir
  if (j < 0) return { ok: false, boundary: true, error: '同级里已经是第一位了' }
  if (j >= sibs.length) return { ok: false, boundary: true, error: '同级里已经是最后一位了' }
  const other = sibs[j]

  // 先把两边的声明补全，否则没有声明行可交换
  let work = ensureDeclaration(src, id)
  work = ensureDeclaration(work, other)

  const lines = work.split('\n')
  const parent = parentsOf(src, id)[0] || null

  if (parent) {
    const a = findSimpleEdgeLine(lines, parent, id)
    const b = findSimpleEdgeLine(lines, parent, other)
    if (a < 0 || b < 0) {
      const bad = a < 0 ? id : other
      return {
        ok: false,
        error: `无法换位：${bad} 的连线不是独立一行（可能是 A-->B-->C 这种链式写法），`
          + '请先把连线拆成一行一条',
      }
    }
    swapAt(lines, a, b)
  }

  // 声明行也跟着换，代码顺序和图顺序保持一致
  const da = findDeclLine(lines, id)
  const db = findDeclLine(lines, other)
  if (da >= 0 && db >= 0) swapAt(lines, da, db)

  const next = lines.join('\n')

  // 校验 1：拓扑不能变
  const err = verifyMove(src, next)
  if (err) return { ok: false, error: err }
  // 换位只重排、不改内容，所以边集合必须**完全相等**
  if (!eqSet(listEdges(src), listEdges(next))) {
    return { ok: false, error: '换位校验失败（边集合被改动），已放弃修改' }
  }

  // 校验 2：相对顺序必须真的反过来了
  const sibs2 = siblingsOf(next, id)
  const before = sibs.indexOf(id) - sibs.indexOf(other)
  const after = sibs2.indexOf(id) - sibs2.indexOf(other)
  if (!(before * after < 0)) {
    return { ok: false, boundary: true, error: '已经在边界上，位置没有变化' }
  }

  return { ok: true, code: next, movedTo: other }
}

/**
 * 跨层级提升：把节点变成**父节点的同级**（挂到祖父节点下）。
 *
 * 重写 `父 --> 自己` 为 `祖父 --> 自己`。
 * 父节点是根时拒绝 —— 那会让自己变成第二个根，把图拆成两块。
 */
export function promoteNode(code, id) {
  const src = String(code || '')
  if (!listNodeIds(src).includes(id)) {
    return { ok: false, error: `代码里找不到节点 ${id}` }
  }
  const parents = parentsOf(src, id)
  const P = parents[0]
  if (!P) return { ok: false, error: '这个节点没有父节点，已经在顶层了' }
  const G = parentsOf(src, P)[0]
  if (!G) return { ok: false, error: '父节点已经是根节点，再提升会让图断开，已拒绝' }

  const lines = src.split('\n')
  const have = listEdges(src)
  const out = []
  let found = false

  for (const line of lines) {
    const ep = edgeEndpoints(line)
    if (ep && ep[0] === P && ep[1] === id) {
      found = true
      // 祖父 --> 自己 已经存在的话，这条边直接删掉（避免重复边）
      if (have.has(`${G}\u0000${id}`)) continue
      out.push(`  ${G} --> ${id}`)
      continue
    }
    out.push(line)
  }
  if (!found) {
    return { ok: false, error: `无法提升：${P} --> ${id} 不是独立一行（链式写法），请先拆开` }
  }

  const next = out.join('\n')
  const err = verifyMove(src, next)
  if (err) return { ok: false, error: err }

  // 提升后必须仍然有父节点，不能变成孤儿
  if (!parentsOf(next, id).length) {
    return { ok: false, error: '提升后节点会变成孤立节点，已拒绝' }
  }
  return { ok: true, code: next, from: P, to: G }
}

/**
 * 跨层级下沉：把节点变成**自己子节点的同级**。
 *
 * 重写 `自己 --> 子节点` 为 `父 --> 子节点`，同时保留 `父 --> 自己`。
 * 结果是自己和原来的子节点并列挂在父节点下 —— 也就是「下沉」了一层。
 *
 * 子节点因此不会丢，图也不会断。
 */
export function demoteNode(code, id) {
  const src = String(code || '')
  if (!listNodeIds(src).includes(id)) {
    return { ok: false, error: `代码里找不到节点 ${id}` }
  }
  const P = parentsOf(src, id)[0]
  if (!P) return { ok: false, error: '这个节点没有父节点，无法下沉' }
  const kids = childrenOf(src, id)
  if (!kids.length) return { ok: false, error: '这个节点没有子节点，无法下沉' }

  const lines = src.split('\n')
  const have = listEdges(src)
  const out = []
  let rewritten = 0

  for (const line of lines) {
    const ep = edgeEndpoints(line)
    if (ep && ep[0] === id && kids.includes(ep[1])) {
      rewritten++
      // 父 --> 子 已存在 → 这条边直接删掉
      if (have.has(`${P}\u0000${ep[1]}`)) continue
      out.push(`  ${P} --> ${ep[1]}`)
      continue
    }
    out.push(line)
  }
  if (rewritten !== kids.length) {
    return { ok: false, error: '无法下沉：有连线不是独立一行（链式写法），请先拆开' }
  }

  const next = out.join('\n')
  const err = verifyMove(src, next)
  if (err) return { ok: false, error: err }

  // 自己必须还挂在父节点下，不能变成孤儿
  if (!parentsOf(next, id).includes(P)) {
    return { ok: false, error: '下沉后节点会失去父节点，已拒绝' }
  }
  return { ok: true, code: next, from: P, kids }
}

/* ------------------------------------------------------------------ */
/* 插入位置计算                                                         */
/* ------------------------------------------------------------------ */

/**
 * 算出「节点定义区末尾」和「边区末尾」的插入下标。
 *
 *   flowchart TD
 *     A["x"]        ← 定义区
 *     B["y"]        ← 定义区末尾 = 2
 *     A --> B       ← 边区末尾 = 3
 */
function insertionPoints(lines) {
  let headerIdx = lines.findIndex((l) => /^\s*(flowchart|graph)\s/i.test(l))
  if (headerIdx < 0) headerIdx = 0

  let lastDef = -1
  let lastEdge = -1
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim() || /^\s*%%/.test(l)) continue
    if (isEdgeLine(l)) { lastEdge = i; continue }   // 边行优先，避免被当成定义
    if (defLineRe().test(l)) lastDef = i
  }

  // 定义插到最后一个定义之后；一个定义都没有就插在标题之后
  const defAt = lastDef >= 0 ? lastDef + 1 : headerIdx + 1
  // 边插到最后一条边之后；没有边就插在定义区之后
  const edgeAt = lastEdge >= 0 ? lastEdge + 1 : defAt
  return { headerIdx, defAt, edgeAt }
}

/** 按下标从大到小插入，保证前面的下标不受影响 */
function spliceAll(lines, inserts) {
  const out = lines.slice()
  for (const ins of [...inserts].sort((a, b) => b.at - a.at)) {
    out.splice(ins.at, 0, ...ins.lines)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 操作：合并到新节点                                                    */
/* ------------------------------------------------------------------ */

export const DEFAULT_MERGE_LABEL = '新结果节点'

const escLabel = (s) => String(s ?? '').replace(/"/g, '&quot;')

/**
 * 让 A、B 两个节点都指向一个**新建**的结果节点。
 *
 * 生成 `n9["新结果节点"]` 放进定义区，`A --> n9`、`B --> n9` 放进边区。
 * dagre 会自动把 n9 排到下一层，形成汇聚终点。
 *
 * 原子性：先算后校验，任何一步不满足就整体放弃（返回 ok:false）。
 *
 * @returns {{ ok:true, code, newId, added } | { ok:false, error }}
 */
export function mergeToNewNode(code, idA, idB, label = DEFAULT_MERGE_LABEL) {
  const src = String(code || '')
  if (!/^\s*(flowchart|graph)\s/m.test(src)) {
    return { ok: false, error: '当前代码不是 flowchart，无法插入合并节点' }
  }
  const ids = listNodeIds(src)
  if (!ids.includes(idA)) return { ok: false, error: `代码里找不到节点 ${idA}` }
  if (!ids.includes(idB)) return { ok: false, error: `代码里找不到节点 ${idB}` }

  const newId = nextNodeId(src)
  const lines = src.split('\n')
  const { defAt, edgeAt } = insertionPoints(lines)

  // 新节点是全新的 id，理论上不可能已存在；这里仍然去重，
  // 顺便处理 A === B 的情况（只连一条边，不产生重复边）
  const have = listEdges(src)
  const wanted = []
  for (const from of [idA, idB]) {
    const key = `${from}\u0000${newId}`
    if (have.has(key)) continue
    if (wanted.some((w) => w.key === key)) continue
    wanted.push({ key, line: `  ${from} --> ${newId}` })
  }
  if (!wanted.length) return { ok: false, error: '这两条连线已经存在，无需重复添加' }

  const next = spliceAll(lines, [
    { at: defAt, lines: [`  ${newId}["${escLabel(label)}"]`] },
    { at: edgeAt, lines: wanted.map((w) => w.line) },
  ]).join('\n')

  // ---- 校验：节点只多一个、目标 id 存在、边都在 ----
  const afterIds = listNodeIds(next)
  const afterEdges = listEdges(next)
  if (afterIds.length !== ids.length + 1 || !afterIds.includes(newId)) {
    return { ok: false, error: '生成结果校验失败（节点数不对），已放弃修改' }
  }
  if (!wanted.every((w) => afterEdges.has(w.key))) {
    return { ok: false, error: '生成结果校验失败（连线缺失），已放弃修改' }
  }

  return { ok: true, code: next, newId, added: wanted.length }
}

/* ------------------------------------------------------------------ */
/* 操作：单对单连线（指向）                                              */
/* ------------------------------------------------------------------ */

/**
 * 在代码里加一条 `A --> B`。
 *
 * 和 mergeToNewNode 的区别：**只加一条边，不新建节点、不改节点集合**。
 * 所以校验的侧重点也不同 —— 那边验「节点数恰好 +1」，这边验「节点集合一个不变」。
 *
 * 插入位置用 insertionPoints()：追加到**已有的边区之后**，而不是无脑
 * 写到文件末尾。文件末尾可能还有空行或注释，写在那儿会让代码越看越乱；
 * 需求里「追加到末尾（或者根据代码结构自动插入到连线区）」两种都允许，
 * 这里选后者，和新增节点/合并节点的行为保持一致。
 *
 * ---------------------------------------------------------------------------
 * 【为什么 id 一律裸写，绝不加引号 —— 这是实测结论，不是偏好】
 *
 * 需求原本要求「id 含连字符等特殊字符时自动加引号，如 A --> "n-b"」。
 * 但用项目自己的 renderMermaid 逐条验过，加引号会**直接报语法错误**：
 *
 *     ✓  A --> node-1       裸写连字符 id    正常渲染
 *     ✗  A --> "node-1"     加引号           Parse error on line 4
 *     ✗  A --> "B"          普通 id 加引号    Parse error on line 4
 *
 * 加引号不但没解决问题，反而把整张图弄坏。而本项目有一条铁律：
 * 「语法错误时右侧保留上一版正确的图」—— 所以用户看到的现象会是
 * 「点完指向，图不动了」，比报错更难排查。
 *
 * 而且真正需要引号的字符（空格、括号、标点）**根本不可能出现在 id 里**：
 * 图上的 id 全部来自 listNodeIds()，只可能是
 * `[A-Za-z0-9_中文]` 加「不连续的单连字符」，mermaid 全都接受。
 * 所以这里裸写，并且在写入前**显式校验 id 合法**，把不合法的挡在门外
 * （正常路径下不可能触发，但防御成本几乎为零）。
 */
export function linkNodesInCode(code, fromId, toId) {
  const src = String(code || '')
  if (!/^\s*(flowchart|graph)\s/m.test(src)) {
    return { ok: false, error: '当前代码不是 flowchart，无法添加连线' }
  }
  if (!fromId || !toId) return { ok: false, error: '连线两端必须都是节点' }
  if (fromId === toId) return { ok: false, error: '不能指向自身' }

  // id 合法性：必须能作为一个独立的 mermaid id token 出现
  const idOk = (v) => new RegExp(`^${ID}$`).test(String(v))
  if (!idOk(fromId) || !idOk(toId)) {
    return { ok: false, error: '节点 id 含 mermaid 不接受的字符，已放弃修改' }
  }

  const ids = listNodeIds(src)
  if (!ids.includes(fromId)) return { ok: false, error: `代码里找不到节点 ${fromId}` }
  if (!ids.includes(toId)) return { ok: false, error: `代码里找不到节点 ${toId}` }

  // 去重：已经有一条 A --> B 就直接拒绝，不做「改成两条」这种傻事
  const key = `${fromId}\u0000${toId}`
  if (listEdges(src).has(key)) return { ok: false, error: '该连线已存在' }

  const lines = src.split('\n')
  const { edgeAt } = insertionPoints(lines)
  const edgeLine = `  ${fromId} --> ${toId}`
  const next = spliceAll(lines, [{ at: edgeAt, lines: [edgeLine] }]).join('\n')

  // ---- 原子性校验：新边真的在，且节点集合一个都没变 ----
  if (!listEdges(next).has(key)) {
    return { ok: false, error: '生成结果校验失败（连线缺失），已放弃修改' }
  }
  const afterIds = listNodeIds(next)
  if (afterIds.length !== ids.length || !ids.every((id) => afterIds.includes(id))) {
    return { ok: false, error: '生成结果校验失败（节点集合变了），已放弃修改' }
  }

  return { ok: true, code: next, from: fromId, to: toId, line: edgeLine }
}

/* ------------------------------------------------------------------ */
/* 操作：改节点标签                                                      */
/* ------------------------------------------------------------------ */

/**
 * 把某个节点的 `id["旧标签"]` 换成 `id["新标签"]`，其余一个字不动。
 * 找不到该节点的显式定义时返回 null（调用方决定怎么提示）。
 */
export function setNodeLabelInCode(code, id, label) {
  const lines = String(code || '').split('\n')
  const re = new RegExp(`^(\\s*)(${escapeRe(id)})(\\s*)\\[\\s*"([^"]*)"\\s*\\](.*)$`)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re)
    if (!m) continue
    const next = lines.slice()
    next[i] = `${m[1]}${m[2]}${m[3]}["${escLabel(label)}"]${m[5]}`
    return next.join('\n')
  }
  return null
}

/** 读某个节点当前的显示标签（拿不到就返回 null） */
export function getNodeLabelInCode(code, id) {
  const lines = String(code || '').split('\n')
  const re = new RegExp(`^\\s*${escapeRe(id)}\\s*\\[\\s*"([^"]*)"\\s*\\]`)
  for (const line of lines) {
    const m = line.match(re)
    if (m) return m[1]
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 操作：改节点外形                                                      */
/* ------------------------------------------------------------------ */

/**
 * 匹配「某个 id 的完整显式定义」，含括号对与标签。
 * 组：1=前缀  2=id  3=id 与括号间的空白  4..=标签（命中哪个组取决于括号种类）
 *
 * 形状片段按开括号从长到短排（`(((` 先于 `((`、`(["` 先于 `("`），
 * 否则双圆会被认成圆。后面接的老式无引号写法要保留 ——
 * 用户手写的 `A[x]` / `A(x)` 也得能改外形。
 */
function defRegexFor(id) {
  const shapeAlts = SHAPES
    .map((s) => [s.mermaid[0], s.mermaid[1]])
    .sort((a, b) => b[0].length - a[0].length)
    .map(([o, c]) => `${escapeRe(o)}([^"]*)${escapeRe(c)}`)
  const legacy = ['\\(\\(([^)]*)\\)\\)', '\\[([^\\]]*)\\]', '\\(([^)]*)\\)', '\\{([^}]*)\\}']
  return new RegExp(
    `(^|[^\\w\\u4e00-\\u9fa5-])(${escapeRe(id)})(\\s*)(?:${[...shapeAlts, ...legacy].join('|')})`
  )
}

/**
 * 把某个节点的括号对换成新外形，**标签和其余部分一个字不动**。
 *
 * 例：`n1["判断"]` + diamond → `n1{"判断"}`
 *
 * 为什么不能「一个大正则扫全行、整行重建」：
 * 一行的定义可能和连线混在一起（`n0 --> n1["甲"]`），节点两边都可能有内容。
 * 这里只替换**匹配到的那一段**，前缀原样留着。
 *
 * 找不到该节点的显式定义时返回 null（调用方提示「先补一行定义」）。
 */
export function setShapeInCode(code, id, key) {
  if (!isShape(key)) return null
  const [open, close] = shapeOf(key).mermaid
  const lines = String(code || '').split('\n')
  const re = defRegexFor(id)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(re)
    if (!m) continue
    // 标签组号不固定 —— 扫一遍所有组，取第一个被匹配到的。
    // 判据必须是 !== undefined：空标签 `A[""]` 的值是空串，用 truthy 会漏。
    const g = m.slice(4).find((x) => x !== undefined)
    const label = String(g ?? '')
    const next = lines.slice()
    next[i] = line.slice(0, m.index) + m[1] + m[2] + m[3] + open + label + close +
      line.slice(m.index + m[0].length)
    return next.join('\n')
  }
  return null
}

/** 读某个节点当前的外形 key（拿不到就返回 null） */
export function getNodeShapeInCode(code, id) {
  return readNodeShape(String(code || ''), id)?.key ?? null
}

/* ------------------------------------------------------------------ */
/* 操作：新增同级 / 子节点                                               */
/* ------------------------------------------------------------------ */

/**
 * 在代码里新增一个节点。
 *   child   → `目标 --> 新节点`
 *   sibling → `父节点 --> 新节点`（父节点 = 第一个指向目标的节点）
 *             目标没有父节点时只加定义（它本身是根，同级也是根）
 *
 * @returns {{ ok:true, code, newId } | { ok:false, error }}
 */
export function insertNodeInCode(code, targetId, position = 'child', label = '新节点') {
  const src = String(code || '')
  if (!/^\s*(flowchart|graph)\s/m.test(src)) {
    return { ok: false, error: '当前代码不是 flowchart' }
  }
  const ids = listNodeIds(src)
  if (!ids.includes(targetId)) return { ok: false, error: `代码里找不到节点 ${targetId}` }

  const newId = nextNodeId(src)
  const lines = src.split('\n')
  const { defAt, edgeAt } = insertionPoints(lines)

  let from = targetId
  if (position === 'sibling') {
    const parents = parentsOf(src, targetId)
    from = parents.length ? parents[0] : null
  }

  const inserts = [{ at: defAt, lines: [`  ${newId}["${escLabel(label)}"]`] }]
  const expectEdges = []
  if (from) {
    inserts.push({ at: edgeAt, lines: [`  ${from} --> ${newId}`] })
    expectEdges.push(`${from}\u0000${newId}`)
  }

  const next = spliceAll(lines, inserts).join('\n')
  const afterIds = listNodeIds(next)
  const afterEdges = listEdges(next)

  if (afterIds.length !== ids.length + 1 || !afterIds.includes(newId)) {
    return { ok: false, error: '生成结果校验失败，已放弃修改' }
  }
  if (!expectEdges.every((k) => afterEdges.has(k))) {
    return { ok: false, error: '生成结果校验失败，已放弃修改' }
  }
  return { ok: true, code: next, newId }
}

/* ------------------------------------------------------------------ */
/* 操作：删除节点                                                        */
/* ------------------------------------------------------------------ */

/**
 * 删除一个节点：定义行和所有与它相连的边一起删掉。
 *
 * 为了不把图删断，**子节点会改挂到它的第一个父节点上**
 * （对应缩进列表里「删除时子节点上移一级」的承诺）。
 * 它没有父节点时，子节点就变成新的根。
 *
 * @returns {{ ok:true, code, removedEdges, rewired } | { ok:false, error }}
 */
export function deleteNodeInCode(code, id) {
  const src = String(code || '')
  const ids = listNodeIds(src)
  if (!ids.includes(id)) return { ok: false, error: `代码里找不到节点 ${id}` }

  const parents = parentsOf(src, id)
  const kids = childrenOf(src, id)
  const up = parents.length ? parents[0] : null

  const lines = src.split('\n')
  const kept = []
  let removedEdges = 0

  for (const line of lines) {
    if (!line.trim()) { kept.push(line); continue }
    // 定义行：整行删掉（含 `id["标签"]` 单独成行的情况）
    const defOnly = defLineRe().test(line) && !isEdgeLine(line)
    if (defOnly && new RegExp(`^\\s*${escapeRe(id)}\\s*(?:\\(\\(|\\[|\\(|\\{)`).test(line)) {
      continue
    }
    // 边行：只删掉「涉及 id」的那些；同一行上还有别的边时保留（罕见，但别误删）
    if (isEdgeLine(line)) {
      const toks = tokensOf(line)
      const involves = toks.some((t) => t === id)
      if (involves) {
        // 只处理「整行就是一条边」的常见情况
        const pairs = []
        for (let i = 0; i + 2 < toks.length; i++) {
          const [a, arrow, b] = [toks[i], toks[i + 1], toks[i + 2]]
          if (!ARROW_ANY.test(arrow)) continue
          if (a === id || b === id) { removedEdges++; continue }
          pairs.push([a, b])
        }
        if (!pairs.length) continue          // 整行都被删掉了
        kept.push(pairs.map(([a, b]) => `  ${a} --> ${b}`).join('\n'))
        continue
      }
    }
    kept.push(line)
  }

  // 子节点改挂到第一个父节点
  const rewired = []
  if (up) {
    const have = listEdges(kept.join('\n'))
    for (const k of kids) {
      if (k === up || k === id) continue
      const key = `${up}\u0000${k}`
      if (have.has(key)) continue
      rewired.push(key)
    }
  }

  let out = kept
  if (rewired.length) {
    const { edgeAt } = insertionPoints(kept)
    out = spliceAll(kept, [
      { at: edgeAt, lines: rewired.map((k) => { const [a, b] = k.split('\u0000'); return `  ${a} --> ${b}` }) },
    ])
  }

  const next = out.join('\n')

  // ---- 校验：id 彻底消失，且子节点没有变成孤儿 ----
  const afterIds = listNodeIds(next)
  if (afterIds.includes(id)) return { ok: false, error: '删除校验失败，已放弃修改' }
  if (afterIds.length !== ids.length - 1) {
    return { ok: false, error: '删除校验失败（节点数不对），已放弃修改' }
  }
  const afterEdges = listEdges(next)
  if (!rewired.every((k) => afterEdges.has(k))) {
    return { ok: false, error: '删除校验失败（改挂失败），已放弃修改' }
  }

  return { ok: true, code: next, removedEdges, rewired: rewired.length }
}
