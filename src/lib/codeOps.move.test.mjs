/**
 * 代码顺序换位（Move Node）测试
 * ==============================
 * 核心不变量：**换位只重排行，不改拓扑**。
 * 所以每个操作之后都要断言「节点集合」和「边集合」与原来完全一致，
 * 并且同级相对顺序真的反过来了。
 *
 * 跨层级提升/下沉会真的改拓扑，重点验证环检测和「不产生孤儿」。
 *
 * 纯函数测试，不需要浏览器。
 */
import {
  listNodeIds, listEdges, parentsOf, childrenOf,
  siblingsOf, childrenInOrder, ensureDeclaration, nodeHasLabel,
  moveSiblingOrder, promoteNode, demoteNode,
} from './codeOps.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}

const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x))
/** 拓扑完全一致：节点集合 + 边集合都不变 */
const sameTopology = (a, b) => eqSet(new Set(listNodeIds(a)), new Set(listNodeIds(b)))
  && eqSet(listEdges(a), listEdges(b))

const TREE = [
  'flowchart TD',
  '  n0["开始"]',
  '  n1["甲"]',
  '  n2["乙"]',
  '  n3["丙"]',
  '  n0 --> n1',
  '  n0 --> n2',
  '  n0 --> n3',
].join('\n')

/* ================================================================== */
console.log('\n[1] 同级兄弟的识别')
/* ================================================================== */

check('childrenInOrder 按书写顺序返回子节点',
  childrenInOrder(TREE, 'n0').join() === 'n1,n2,n3',
  childrenInOrder(TREE, 'n0').join())
check('siblingsOf 返回同父的兄弟',
  siblingsOf(TREE, 'n2').join() === 'n1,n2,n3',
  siblingsOf(TREE, 'n2').join())
check('siblingsOf 对根节点返回其他根',
  siblingsOf(TREE, 'n0').join() === 'n0',
  siblingsOf(TREE, 'n0').join())

const FOREST = 'flowchart TD\n  A["甲根"]\n  B["乙根"]\n  A --> A1\n  B --> B1'
check('多根时根节点的同级是其他根',
  siblingsOf(FOREST, 'A').join() === 'A,B',
  siblingsOf(FOREST, 'A').join())

/* ================================================================== */
console.log('\n[2] 补全声明')
/* ================================================================== */

const NO_DECL = 'flowchart TD\n  n0["开始"]\n  n0 --> n1\n  n0 --> n2'
check('节点只在连线里出现时能被识别为「没有标签」',
  nodeHasLabel(NO_DECL, 'n1') === false && nodeHasLabel(NO_DECL, 'n0') === true,
  `${nodeHasLabel(NO_DECL, 'n1')} / ${nodeHasLabel(NO_DECL, 'n0')}`)

const declared = ensureDeclaration(NO_DECL, 'n1')
check('补全声明会插入 n1["n1"]',
  /n1\s*\[\s*"n1"\s*\]/.test(declared), declared)
check('补全声明插在定义区（在第一条连线之前）', (() => {
  const lines = declared.split('\n')
  const def = lines.findIndex((l) => l.includes('n1['))
  const edge = lines.findIndex((l) => l.includes('-->'))
  return def >= 0 && def < edge
})(), declared)
check('补全声明不改变拓扑', sameTopology(NO_DECL, declared), declared)
check('已有声明时不重复补',
  ensureDeclaration(declared, 'n1') === declared)

// 有行内标签的节点不能再补声明，否则两个标签会打架
const INLINE = 'flowchart TD\n  n0["开始"]\n  n0 --> n1["服务端"]'
check('有行内标签的节点不会被补出第二个标签',
  ensureDeclaration(INLINE, 'n1') === INLINE, ensureDeclaration(INLINE, 'n1'))

/* ================================================================== */
console.log('\n[3] 同级上移 / 下移（A + C）')
/* ================================================================== */

const up = moveSiblingOrder(TREE, 'n2', -1)
check('n2 上移成功', up.ok === true, JSON.stringify(up))
check('上移后拓扑完全不变', up.ok && sameTopology(TREE, up.code))
check('上移后 n2 排到 n1 前面',
  up.ok && childrenInOrder(up.code, 'n0').join() === 'n2,n1,n3',
  up.ok ? childrenInOrder(up.code, 'n0').join() : '')
check('上移交换的是连线行（父 --> 子 的行序）', up.ok && (() => {
  const lines = up.code.split('\n').filter((l) => l.includes('-->'))
  return lines[0].includes('n2') && lines[1].includes('n1')
})(), up.ok ? up.code : '')
check('上移也交换了声明行', up.ok && (() => {
  const lines = up.code.split('\n')
  return lines.findIndex((l) => l.includes('n1[')) > lines.findIndex((l) => l.includes('n2['))
})(), up.ok ? up.code : '')

const down = moveSiblingOrder(TREE, 'n1', 1)
check('n1 下移成功', down.ok === true, JSON.stringify(down))
check('下移后拓扑完全不变', down.ok && sameTopology(TREE, down.code))
check('下移后 n1 排到 n2 后面',
  down.ok && childrenInOrder(down.code, 'n0').join() === 'n2,n1,n3',
  down.ok ? childrenInOrder(down.code, 'n0').join() : '')

/* ---- 边界 ---- */
const first = moveSiblingOrder(TREE, 'n1', -1)
check('第一个节点上移 → 越界，不改代码',
  first.ok === false && first.boundary === true, JSON.stringify(first))
const last = moveSiblingOrder(TREE, 'n3', 1)
check('最后一个节点下移 → 越界，不改代码',
  last.ok === false && last.boundary === true, JSON.stringify(last))
check('越界时不返回 code（调用方无从误用）', first.code === undefined && last.code === undefined)

/* ---- 连续移动 ---- */
let cur = TREE
for (let k = 0; k < 2; k++) {
  const r = moveSiblingOrder(cur, 'n3', -1)
  if (r.ok) cur = r.code
}
check('连续上移两次后 n3 排到最前',
  childrenInOrder(cur, 'n0').join() === 'n3,n1,n2',
  childrenInOrder(cur, 'n0').join())
check('连续移动后拓扑仍然不变', sameTopology(TREE, cur))

/* ---- 不存在声明行时自动补全 ---- */
const noDeclMove = moveSiblingOrder(NO_DECL, 'n2', -1)
check('节点没有声明行时也能换位（自动补全声明）',
  noDeclMove.ok === true, JSON.stringify(noDeclMove))
check('补全后拓扑不变', noDeclMove.ok && sameTopology(NO_DECL, noDeclMove.code),
  noDeclMove.ok ? noDeclMove.code : '')
check('补全 + 换位后顺序正确',
  noDeclMove.ok && childrenInOrder(noDeclMove.code, 'n0').join() === 'n2,n1',
  noDeclMove.ok ? childrenInOrder(noDeclMove.code, 'n0').join() : '')

/* ---- 链式写法要明确拒绝，而不是改坏 ---- */
/*
 * n0 --> n1 --> n2 是一条链（n1 的父是 n0），再加一条 n0 --> n3。
 * 于是 n0 的子节点是 n1、n3；把 n3 上移要交换
 * `n0 --> n1 --> n2` 和 `n0 --> n3` 两行 —— 前者是链，不能整行对调。
 */
const CHAIN = 'flowchart TD\n  n0["开始"]\n  n1["甲"]\n  n2["乙"]\n  n3["丙"]\n  n0 --> n1 --> n2\n  n0 --> n3'
const chainMove = moveSiblingOrder(CHAIN, 'n3', -1)
check('链式写法拒绝换位并给出说明',
  chainMove.ok === false && /链式/.test(chainMove.error || ''), JSON.stringify(chainMove))
check('链式拒绝时不返回 code', chainMove.code === undefined)

/* ---- 非 flowchart ---- */
check('sequenceDiagram 拒绝换位',
  moveSiblingOrder('sequenceDiagram\n  A->>B: hi', 'A', 1).ok === false)

/* ---- 单节点：上下都越界 ---- */
const SINGLE = 'flowchart TD\n  n0["独苗"]'
check('只有一个节点时上移越界',
  moveSiblingOrder(SINGLE, 'n0', -1).boundary === true)
check('只有一个节点时下移越界',
  moveSiblingOrder(SINGLE, 'n0', 1).boundary === true)

/* ================================================================== */
console.log('\n[4] 跨层级提升（B）')
/* ================================================================== */

const DEEP = [
  'flowchart TD',
  '  n0["根"]',
  '  n1["中间"]',
  '  n2["叶子"]',
  '  n0 --> n1',
  '  n1 --> n2',
].join('\n')

const pro = promoteNode(DEEP, 'n2')
check('提升成功', pro.ok === true, JSON.stringify(pro))
check('提升后 n2 挂到祖父 n0 下',
  pro.ok && parentsOf(pro.code, 'n2').join() === 'n0',
  pro.ok ? parentsOf(pro.code, 'n2').join() : '')
check('提升后 n2 与 n1 成为同级',
  pro.ok && childrenInOrder(pro.code, 'n0').join() === 'n1,n2',
  pro.ok ? childrenInOrder(pro.code, 'n0').join() : '')
check('提升后没有孤儿节点', pro.ok && (() => {
  const edges = listEdges(pro.code)
  const hasIn = new Set([...edges].map((k) => k.split('\u0000')[1]))
  return listNodeIds(pro.code).every((n) => hasIn.has(n) || n === 'n0')
})(), pro.ok ? pro.code : '')
check('提升不产生环', pro.ok && !(() => {
  // n2 不该能走回 n0
  const edges = listEdges(pro.code)
  const adj = new Map()
  for (const k of edges) { const [a, b] = k.split('\u0000'); adj.set(a, [...(adj.get(a) || []), b]) }
  const seen = new Set()
  const walk = (n) => { if (seen.has(n)) return false; seen.add(n); return (adj.get(n) || []).some((m) => m === 'n0' || walk(m)) }
  return walk('n2')
})())

check('根节点无法提升', promoteNode(DEEP, 'n0').ok === false)
check('父节点是根时拒绝提升（会拆成两块图）',
  promoteNode(DEEP, 'n1').ok === false,
  JSON.stringify(promoteNode(DEEP, 'n1')))

/* ================================================================== */
console.log('\n[5] 跨层级下沉（B）')
/* ================================================================== */

const dem = demoteNode(DEEP, 'n1')
check('下沉成功', dem.ok === true, JSON.stringify(dem))
check('下沉后 n1 的子节点改挂到 n0',
  dem.ok && parentsOf(dem.code, 'n2').join() === 'n0',
  dem.ok ? parentsOf(dem.code, 'n2').join() : '')
check('下沉后 n1 与 n2 成为同级',
  dem.ok && childrenInOrder(dem.code, 'n0').join() === 'n1,n2',
  dem.ok ? childrenInOrder(dem.code, 'n0').join() : '')
check('下沉后 n1 仍然挂在父节点下（没变成孤儿）',
  dem.ok && parentsOf(dem.code, 'n1').join() === 'n0',
  dem.ok ? parentsOf(dem.code, 'n1').join() : '')
check('下沉后 n2 没有丢', dem.ok && listNodeIds(dem.code).includes('n2'))
check('下沉后节点数不变',
  dem.ok && listNodeIds(dem.code).length === listNodeIds(DEEP).length)

check('根节点无法下沉', demoteNode(DEEP, 'n0').ok === false)
check('没有子节点时无法下沉',
  demoteNode(DEEP, 'n2').ok === false, JSON.stringify(demoteNode(DEEP, 'n2')))

/* ================================================================== */
console.log('\n[6] 环检测（极其危险的那条）')
/* ================================================================== */

/*
 * 构造一个「提升会形成环」的场景：
 *   n0 --> n1 --> n2 --> n0   （本身已经是环）
 * 再对 n1 提升会走 n0 的父节点，这里先把结构做成
 *   n0 --> n1 --> n2,  且 n2 --> n0
 * 此时 n1 的父是 n0，n0 的父是 n2（因为 n2 --> n0）。
 * 提升 n1 → 变成 n2 --> n1，而 n1 本来就能走到 n2，于是成环。
 */
const RING = [
  'flowchart TD',
  '  n0["甲"]',
  '  n1["乙"]',
  '  n2["丙"]',
  '  n0 --> n1',
  '  n1 --> n2',
  '  n2 --> n0',
].join('\n')

const ringPromote = promoteNode(RING, 'n1')
check('会形成环的提升被拒绝',
  ringPromote.ok === false && /环/.test(ringPromote.error || ''),
  JSON.stringify(ringPromote))

// 原本就有环的图，做不会新增环的操作时仍然允许
// （RING 里每个节点都只有一个子节点，加一条分支才有兄弟可换）
const RING_BRANCH = [
  'flowchart TD',
  '  n0["甲"]',
  '  n1["乙"]',
  '  n2["丙"]',
  '  n3["丁"]',
  '  n0 --> n1',
  '  n1 --> n2',
  '  n2 --> n0',
  '  n1 --> n3',
].join('\n')
const ringMove = moveSiblingOrder(RING_BRANCH, 'n3', -1)
check('原本有环的图仍可换位（换位不新增边，所以不新增环）',
  ringMove.ok === true, JSON.stringify(ringMove))
check('有环图换位后边集合完全不变',
  ringMove.ok && eqSet(listEdges(RING_BRANCH), listEdges(ringMove.code)))

/*
 * 下沉成环：n0 --> n1 --> n2，另外 n2 --> n0。
 * 下沉 n1 会加 n0 --> n2；而 n2 --> n0 已存在 → 形成 n0 ⇄ n2 两节点环。
 */
const demoteRing = demoteNode(RING, 'n1')
check('会形成环的下沉被拒绝',
  demoteRing.ok === false && /环/.test(demoteRing.error || ''),
  JSON.stringify(demoteRing))

/* ================================================================== */
console.log('\n[7] 复杂拓扑下不破坏连通性')
/* ================================================================== */

const WIDE = [
  'flowchart TD',
  '  r["根"]',
  '  a["A"]', '  b["B"]', '  c["C"]',
  '  a1["A1"]', '  a2["A2"]',
  '  r --> a', '  r --> b', '  r --> c',
  '  a --> a1', '  a --> a2',
].join('\n')

let w = WIDE
for (const [id, dir] of [['c', -1], ['b', 1], ['a1', 1], ['a2', -1]]) {
  const r = moveSiblingOrder(w, id, dir)
  if (r.ok) w = r.code
}
check('多次换位后拓扑仍然完全不变', sameTopology(WIDE, w))
check('多次换位后每个非根节点都还有入边', (() => {
  const edges = listEdges(w)
  const hasIn = new Set([...edges].map((k) => k.split('\u0000')[1]))
  return listNodeIds(w).filter((n) => n !== 'r').every((n) => hasIn.has(n))
})(), w)

check('换位不丢注释', (() => {
  const withComment = 'flowchart TD\n  %% 注释\n  n0["根"]\n  n1["甲"]\n  n2["乙"]\n  n0 --> n1\n  n0 --> n2'
  const r = moveSiblingOrder(withComment, 'n2', -1)
  return r.ok && r.code.includes('%% 注释')
})(), '')

check('换位保留方向声明', (() => {
  const lr = 'flowchart LR\n  n0["根"]\n  n1["甲"]\n  n2["乙"]\n  n0 --> n1\n  n0 --> n2'
  const r = moveSiblingOrder(lr, 'n2', -1)
  return r.ok && r.code.split('\n')[0].trim() === 'flowchart LR'
})(), '')

/* ================================================================== */
console.log(`\n${'='.repeat(46)}`)
console.log(`  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)
