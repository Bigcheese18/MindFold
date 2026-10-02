/**
 * Mermaid 源码结构化编辑测试（纯代码模式的右键操作）
 * ====================================================
 * 重点验证 PRD 要求的「原子性」：
 *   · 合并后节点恰好 +1，不产生孤立节点、不产生重复节点
 *   · 两条边都插进「边区」，定义插进「定义区」
 *   · 任何一步失败都整体放弃（返回 ok:false，一个字都不改）
 *   · 唯一 ID 递增且不与现有 id 冲突
 *
 * 纯函数测试，不需要浏览器。
 */
import {
  listNodeIds, listEdges, nextNodeId, parentsOf, childrenOf,
  mergeToNewNode, setNodeLabelInCode, getNodeLabelInCode, linkNodesInCode,
  insertNodeInCode, deleteNodeInCode, DEFAULT_MERGE_LABEL,
} from './codeOps.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}

const BASE = [
  'flowchart TD',
  '  A["开始"]',
  '  B["服务端"]',
  '  C["客户端"]',
  '  A --> B',
  '  A --> C',
].join('\n')

/* ================================================================== */
console.log('\n[1] 解析辅助')
/* ================================================================== */

check('列出所有节点 id（按出现顺序）',
  JSON.stringify(listNodeIds(BASE)) === JSON.stringify(['A', 'B', 'C']),
  JSON.stringify(listNodeIds(BASE)))

check('节点定义里的标签文字不会被当成 id',
  listNodeIds('flowchart TD\n  A["B 是标签里的字"]').length === 1,
  JSON.stringify(listNodeIds('flowchart TD\n  A["B 是标签里的字"]')))

check('边标签不会被当成节点',
  JSON.stringify(listNodeIds('flowchart TD\n  A["x"] -->|B| C["y"]')) === JSON.stringify(['A', 'C']),
  JSON.stringify(listNodeIds('flowchart TD\n  A["x"] -->|B| C["y"]')))

check('样式行 / 子图行不产生节点',
  listNodeIds('flowchart TD\n  A["x"]\n  style A fill:#f00\n  classDef foo fill:#000\n  subgraph S\n  end').length === 1,
  JSON.stringify(listNodeIds('flowchart TD\n  A["x"]\n  style A fill:#f00\n  classDef foo fill:#000\n  subgraph S\n  end')))

check('列出边（含链式 A-->B-->C 两段）',
  (() => {
    const e = listEdges('flowchart TD\n  A --> B --> C')
    return e.has('A\u0000B') && e.has('B\u0000C') && e.size === 2
  })(),
  JSON.stringify([...listEdges('flowchart TD\n  A --> B --> C')]))

check('parentsOf / childrenOf 正确',
  parentsOf(BASE, 'B').join() === 'A' && childrenOf(BASE, 'A').join() === 'B,C',
  `${parentsOf(BASE, 'B')} / ${childrenOf(BASE, 'A')}`)

/* ================================================================== */
console.log('\n[2] 唯一 ID 生成')
/* ================================================================== */

check('没有 n<数字> 时从 n0 开始', nextNodeId(BASE) === 'n0', nextNodeId(BASE))
check('按现有最大值 +1',
  nextNodeId('flowchart TD\n  n0["a"]\n  n3["b"]') === 'n4',
  nextNodeId('flowchart TD\n  n0["a"]\n  n3["b"]'))
check('中间有空洞时仍然取最大值 +1（避免和手写引用撞车）',
  nextNodeId('flowchart TD\n  n0["a"]\n  n1["b"]\n  n9["c"]') === 'n10',
  nextNodeId('flowchart TD\n  n0["a"]\n  n1["b"]\n  n9["c"]'))
check('生成的 id 不与现有 id 冲突',
  (() => {
    const src = 'flowchart TD\n  n0["a"]\n  n1["b"]\n  n2["c"]'
    const id = nextNodeId(src)
    return !listNodeIds(src).includes(id)
  })())

/* ================================================================== */
console.log('\n[3] 合并到新节点（核心）')
/* ================================================================== */

const MERGE_SRC = [
  'flowchart TD',
  '  n0["开始"]',
  '  n1["服务端"]',
  '  n2["客户端"]',
  '  n0 --> n1',
  '  n0 --> n2',
].join('\n')

const m1 = mergeToNewNode(MERGE_SRC, 'n1', 'n2')
check('合并成功', m1.ok === true, JSON.stringify(m1))
check('新 id 是 n3', m1.newId === 'n3', String(m1.newId))
check('节点数恰好 +1',
  listNodeIds(m1.code).length === listNodeIds(MERGE_SRC).length + 1,
  `${listNodeIds(MERGE_SRC).length} → ${listNodeIds(m1.code).length}`)
check('边数恰好 +2',
  listEdges(m1.code).size === listEdges(MERGE_SRC).size + 2,
  `${listEdges(MERGE_SRC).size} → ${listEdges(m1.code).size}`)
check('两条汇聚边都指向新节点',
  listEdges(m1.code).has('n1\u0000n3') && listEdges(m1.code).has('n2\u0000n3'))
check('新节点被定义为新结果节点',
  getNodeLabelInCode(m1.code, 'n3') === DEFAULT_MERGE_LABEL,
  String(getNodeLabelInCode(m1.code, 'n3')))
check('没有孤立节点（每个非根节点都有入边）',
  (() => {
    const edges = listEdges(m1.code)
    const hasIn = new Set([...edges].map((k) => k.split('\u0000')[1]))
    const roots = listNodeIds(m1.code).filter((id) => !hasIn.has(id))
    return roots.length === 1 && roots[0] === 'n0'
  })())

console.log('    生成结果：')
console.log(m1.code.split('\n').map((l) => '      ' + l).join('\n'))

check('定义插在定义区（在最后一条边之前）', (() => {
  const lines = m1.code.split('\n')
  const defAt = lines.findIndex((l) => l.includes('n3['))
  const firstEdge = lines.findIndex((l) => l.includes('-->'))
  return defAt >= 0 && defAt < firstEdge
})(), m1.code)

check('边插在边区（在最后一条原有边之后）', (() => {
  const lines = m1.code.split('\n')
  const lastEdge = lines.map((l, i) => (l.includes('-->') ? i : -1)).filter((i) => i >= 0).pop()
  const newEdge = lines.findIndex((l) => l.includes('n1 --> n3'))
  return newEdge > 0 && newEdge <= lastEdge
})(), m1.code)

// A === B：不能产生重复边
const mSame = mergeToNewNode(MERGE_SRC, 'n1', 'n1')
check('A 与 B 是同一个节点时只连一条边（不产生重复）',
  mSame.ok === true && mSame.added === 1 && listEdges(mSame.code).size === listEdges(MERGE_SRC).size + 1,
  JSON.stringify({ ok: mSame.ok, added: mSame.added }))

// 节点不存在 → 整体放弃
const mBad = mergeToNewNode(MERGE_SRC, 'n1', 'ZZZ')
check('目标节点不存在 → 整体放弃', mBad.ok === false && !!mBad.error, JSON.stringify(mBad))

const mNotFlow = mergeToNewNode('不是流程图', 'A', 'B')
check('不是 flowchart → 整体放弃', mNotFlow.ok === false, JSON.stringify(mNotFlow))

// 非 flowchart 语法（sequenceDiagram）也要挡住
check('sequenceDiagram 不会被误改',
  mergeToNewNode('sequenceDiagram\n  A->>B: hi', 'A', 'B').ok === false)

/* ================================================================== */
console.log('\n[4] 改标签')
/* ================================================================== */

const renamed = setNodeLabelInCode(m1.code, 'n3', '断开连接')
check('改标签成功', renamed !== null && getNodeLabelInCode(renamed, 'n3') === '断开连接',
  String(getNodeLabelInCode(renamed, 'n3')))
check('改标签不动其他内容',
  listNodeIds(renamed).length === listNodeIds(m1.code).length &&
  listEdges(renamed).size === listEdges(m1.code).size)
check('改标签只改目标那一个节点',
  getNodeLabelInCode(renamed, 'n1') === '服务端' && getNodeLabelInCode(renamed, 'n2') === '客户端',
  `${getNodeLabelInCode(renamed, 'n1')} / ${getNodeLabelInCode(renamed, 'n2')}`)

check('标签里的双引号被转义',
  (() => {
    const r = setNodeLabelInCode(m1.code, 'n3', '他说"你好"')
    return r.includes('&quot;')
  })())

check('节点不存在时改标签返回 null',
  setNodeLabelInCode(m1.code, 'ZZZ', 'x') === null)

check('读不到的标签返回 null', getNodeLabelInCode(BASE, 'ZZZ') === null)

/* ================================================================== */
console.log('\n[5] 新增同级 / 子节点')
/* ================================================================== */

const insChild = insertNodeInCode(BASE, 'B', 'child')
check('新增子节点成功', insChild.ok === true, JSON.stringify(insChild))
check('子节点有边 目标 --> 新节点',
  listEdges(insChild.code).has(`B\u0000${insChild.newId}`), insChild.code)
check('新增子节点后节点数 +1',
  listNodeIds(insChild.code).length === listNodeIds(BASE).length + 1)

const insSib = insertNodeInCode(BASE, 'B', 'sibling')
check('新增同级节点：挂到 B 的父节点（A）下',
  listEdges(insSib.code).has(`A\u0000${insSib.newId}`), insSib.code)

// A 是根，没有父节点 → 同级只能是另一个根，不应凭空造边
const insRootSib = insertNodeInCode(BASE, 'A', 'sibling')
check('根节点的同级不凭空造边',
  insRootSib.ok === true && listEdges(insRootSib.code).size === listEdges(BASE).size,
  insRootSib.code)

/* ================================================================== */
console.log('\n[6] 删除节点（子节点改挂父节点，不删断）')
/* ================================================================== */

const DEL_SRC = [
  'flowchart TD',
  '  A["根"]',
  '  B["中间"]',
  '  C["叶子"]',
  '  A --> B',
  '  B --> C',
].join('\n')

const del = deleteNodeInCode(DEL_SRC, 'B')
check('删除成功', del.ok === true, JSON.stringify(del))
check('被删节点彻底消失', !listNodeIds(del.code).includes('B'), del.code)
check('节点数 -1', listNodeIds(del.code).length === 2, String(listNodeIds(del.code).length))
check('子节点改挂到父节点（A --> C）',
  listEdges(del.code).has('A\u0000C'), del.code)
check('没有留下孤立节点',
  (() => {
    const edges = listEdges(del.code)
    const hasIn = new Set([...edges].map((k) => k.split('\u0000')[1]))
    return listNodeIds(del.code).filter((id) => !hasIn.has(id)).length === 1
  })(), del.code)

const delRoot = deleteNodeInCode(DEL_SRC, 'A')
check('删根节点：子节点变成新根，不崩',
  delRoot.ok === true && !listNodeIds(delRoot.code).includes('A'), JSON.stringify(delRoot))

check('删除不存在的节点 → 整体放弃',
  deleteNodeInCode(DEL_SRC, 'ZZZ').ok === false)

check('删除后同一行上别的边不会被误删', (() => {
  const src = 'flowchart TD\n  A["a"]\n  B["b"]\n  C["c"]\n  A --> B\n  B --> C'
  const r = deleteNodeInCode(src, 'A')
  // A --> B 该删，B --> C 该留
  return r.ok && !listEdges(r.code).has('A\u0000B') && listEdges(r.code).has('B\u0000C')
})(), (() => {
  const src = 'flowchart TD\n  A["a"]\n  B["b"]\n  C["c"]\n  A --> B\n  B --> C'
  const r = deleteNodeInCode(src, 'A')
  return r.ok ? r.code : JSON.stringify(r)
})())

/* ================================================================== */
console.log('\n[7] 边界：保留用户格式与注释')
/* ================================================================== */

const WITH_COMMENT = [
  'flowchart LR',
  '  %% 这是注释',
  '  A["开始"]',
  '  B["结束"]',
  '  A --> B',
].join('\n')
const wc = mergeToNewNode(WITH_COMMENT, 'A', 'B')
check('注释行原样保留', wc.ok && wc.code.includes('%% 这是注释'), wc.ok ? wc.code : JSON.stringify(wc))
check('方向声明 LR 不被改动', wc.ok && wc.code.split('\n')[0].trim() === 'flowchart LR',
  wc.ok ? wc.code.split('\n')[0] : '')

// 空行 / 缩进风格保留
const INDENTED = 'flowchart TD\n\n    A["x"]\n    B["y"]\n\n    A --> B\n'
const ind = mergeToNewNode(INDENTED, 'A', 'B')
check('原有空行不被清掉', ind.ok && ind.code.includes('\n\n'), ind.ok ? JSON.stringify(ind.code) : '')

// 合并两次：产生两个不同的结果节点，互不冲突
const m2 = mergeToNewNode(m1.code, 'n1', 'n2')
check('连续合并两次产生不同的新节点',
  m2.ok && m2.newId === 'n4' && listNodeIds(m2.code).length === 5,
  JSON.stringify({ id: m2.newId, n: listNodeIds(m2.code).length }))
check('第二次合并没有覆盖第一次的结果节点',
  listNodeIds(m2.code).includes('n3') && listNodeIds(m2.code).includes('n4'))

/* ================================================================== */
console.log('\n[8] 单对单连线 linkNodesInCode（指向）')
/* ================================================================== */

/*
 * 和合并的**本质区别**：只加一条边，不新建节点。
 * 所以这里的核心不变量是「节点集合一个都不能变」——
 * 合并那边验的是「节点数恰好 +1」，两者正好相反，必须分开测。
 */
const LINK_SRC = [
  'flowchart TD',
  '  A["开始"]',
  '  B["中间"]',
  '  C["结束"]',
  '  A --> B',
].join('\n')

const l1 = linkNodesInCode(LINK_SRC, 'B', 'C')
check('连线成功', l1.ok === true, JSON.stringify(l1))
check('★ 节点集合一个都没变（这是和合并最本质的区别）',
  listNodeIds(l1.code).join() === listNodeIds(LINK_SRC).join(),
  `${listNodeIds(LINK_SRC).join()} → ${listNodeIds(l1.code).join()}`)
check('★ 边数恰好 +1',
  listEdges(l1.code).size === listEdges(LINK_SRC).size + 1,
  `${listEdges(LINK_SRC).size} → ${listEdges(l1.code).size}`)
check('新边就是 B --> C', listEdges(l1.code).has('B\u0000C'))
check('原有边一条没丢', listEdges(l1.code).has('A\u0000B'))
check('没有引入新节点定义（没有 n4/新 id）',
  listNodeIds(l1.code).length === 3, listNodeIds(l1.code).join())
check('返回值带 from / to', l1.from === 'B' && l1.to === 'C')

console.log('    生成结果：')
console.log(l1.code.split('\n').map((l) => '      ' + l).join('\n'))

check('新边插在边区（最后一条原有边之后）', (() => {
  const lines = l1.code.split('\n')
  const oldEdge = lines.findIndex((l) => l.includes('A --> B'))
  const newEdge = lines.findIndex((l) => l.includes('B --> C'))
  return oldEdge >= 0 && newEdge > oldEdge
})(), l1.code)

/* ---- 去重：两种写法都要能识别出来 ---- */
const lDup = linkNodesInCode(LINK_SRC, 'A', 'B')
check('★ 已存在 A --> B → 拒绝，且提示「该连线已存在」',
  lDup.ok === false && lDup.error === '该连线已存在', JSON.stringify(lDup))
check('★ 拒绝时返回的 code 是 undefined（一个字都没改）', lDup.code === undefined)

const NO_SPACE = 'flowchart TD\n  A["x"]\n  B["y"]\n  A-->B'
const lDup2 = linkNodesInCode(NO_SPACE, 'A', 'B')
check('★ 紧凑写法 A-->B 也算已存在（去重不能只看一种格式）',
  lDup2.ok === false && lDup2.error === '该连线已存在', JSON.stringify(lDup2))

const CHAIN = 'flowchart TD\n  A["x"]\n  B["y"]\n  C["z"]\n  A --> B --> C'
const lChain = linkNodesInCode(CHAIN, 'A', 'B')
check('★ 链式写法 A --> B --> C 里的 A→B 也算已存在',
  lChain.ok === false && lChain.error === '该连线已存在', JSON.stringify(lChain))
check('链式写法里不存在的边仍可添加',
  linkNodesInCode(CHAIN, 'C', 'A').ok === true)

/* ---- 自环 ---- */
const lSelf = linkNodesInCode(LINK_SRC, 'B', 'B')
check('★ 不能指向自身', lSelf.ok === false && lSelf.error === '不能指向自身', JSON.stringify(lSelf))

/* ---- 反向边是合法的（A→B 存在时 B→A 应该能加） ---- */
const lRev = linkNodesInCode(LINK_SRC, 'B', 'A')
check('★ 反向边 B --> A 与已有的 A --> B 是两条边，不误判为重复',
  lRev.ok === true && listEdges(lRev.code).has('B\u0000A') && listEdges(lRev.code).has('A\u0000B'),
  JSON.stringify({ ok: lRev.ok }))

/* ---- 不存在的节点 ---- */
check('源节点不存在 → 拒绝',
  linkNodesInCode(LINK_SRC, 'ZZZ', 'C').ok === false)
check('目标节点不存在 → 拒绝',
  linkNodesInCode(LINK_SRC, 'A', 'ZZZ').ok === false)

/* ---- 非 flowchart ---- */
check('不是 flowchart → 拒绝', linkNodesInCode('不是流程图', 'A', 'B').ok === false)
check('sequenceDiagram → 拒绝',
  linkNodesInCode('sequenceDiagram\n  A->>B: hi', 'A', 'B').ok === false)

/* ---- id 形态：连字符 / 中文 都必须裸写且合法 ---- */
const HYPHEN = 'flowchart TD\n  A["x"]\n  node-1["y"]\n  A --> node-1'
const lHy = linkNodesInCode(HYPHEN, 'node-1', 'A')
check('★ 连字符 id 能正常连线', lHy.ok === true, JSON.stringify(lHy))
check('★ 生成的是裸 id，**没有加引号**（加引号 mermaid 会报语法错误）',
  lHy.ok && lHy.code.includes('node-1 --> A') && !lHy.code.includes('"node-1"'),
  lHy.ok ? lHy.line : '')
check('中文 id 能正常连线',
  linkNodesInCode('flowchart TD\n  甲["x"]\n  乙["y"]', '甲', '乙').ok === true)
check('含空格的 id 被拒绝（mermaid 不接受这种 id）',
  linkNodesInCode('flowchart TD\n  A["x"]\n  B["y"]', 'A B', 'B').ok === false)

/* ---- 注释与格式保留 ---- */
const lComment = linkNodesInCode(WITH_COMMENT, 'B', 'A')
check('注释行原样保留', lComment.ok && lComment.code.includes('%% 这是注释'))
check('方向声明不被改动',
  lComment.ok && lComment.code.split('\n')[0].trim() === 'flowchart LR')

/* ---- 连续连线累积 ---- */
const l3 = linkNodesInCode(l1.code, 'C', 'A')
check('连续连线可累积（两次各 +1 条边）',
  l3.ok && listEdges(l3.code).size === listEdges(LINK_SRC).size + 2,
  l3.ok ? String(listEdges(l3.code).size) : JSON.stringify(l3))
check('连续连线后节点集合仍然不变',
  l3.ok && listNodeIds(l3.code).join() === listNodeIds(LINK_SRC).join())

/* ---- 多对一：两条指向同一目标的边都能加（这是「指向」和「合并」的分工） ---- */
const lFan = linkNodesInCode(LINK_SRC, 'A', 'C')
check('★ 可以手动加第二条指向同一目标的边（不新建节点）',
  lFan.ok && listEdges(lFan.code).has('A\u0000C') && listEdges(lFan.code).has('A\u0000B'),
  JSON.stringify({ ok: lFan.ok }))

/* ================================================================== */
console.log(`\n${'='.repeat(46)}`)
console.log(`  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)

