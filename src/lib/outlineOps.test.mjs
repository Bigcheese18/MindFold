/**
 * 缩进列表编辑器的行操作测试
 * ==========================
 * 键盘行为没法在 headless 浏览器里端到端验证（实测按键能到 window，
 * 但不会路由到 input），所以把行操作抽成纯函数，在这里测干净。
 */
import {
  textToRows, rowsToText, computeParents, visibleRows, groupTints,
  insertAfter, changeDepth, mergeWithPrev, deleteRow, toggleCollapsed, pasteRows,
  maxAllowedDepth,
  setRowLabelText, insertSiblingText, insertChildText, deleteRowText,
} from './outlineOps.js'
import { outlineToMermaid, mermaidToOutline } from './model.js'
import { moveNode } from './treeOps.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}

const depths = (rows) => rows.map((r) => r.depth)
const labels = (rows) => rows.map((r) => r.label)

/* ---------------- 1. 文本 ⇄ 行 ---------------- */
console.log('\n[1] 文本 ⇄ 行数组')
const t1 = textToRows('根\n  甲\n    甲1\n  乙')
check('层级解析正确', JSON.stringify(depths(t1)) === '[0,1,2,1]', JSON.stringify(depths(t1)))
check('标签去掉缩进', JSON.stringify(labels(t1)) === '["根","甲","甲1","乙"]', JSON.stringify(labels(t1)))
check('空行被丢弃', textToRows('a\n\n\nb').length === 2)
check('列表符号被剥离', JSON.stringify(labels(textToRows('- a\n  - b'))) === '["a","b"]')
check('Tab 缩进折算成 2 空格', JSON.stringify(depths(textToRows('a\n\tb'))) === '[0,1]')
check('往返文本一致', rowsToText(t1) === '根\n  甲\n    甲1\n  乙', JSON.stringify(rowsToText(t1)))
// 规范化只针对「列表符号」和「Tab」；已有的空格缩进按层级原样保留
check('列表符号在序列化时被丢掉', rowsToText(textToRows('- a\n  - b')) === 'a\n  b',
  JSON.stringify(rowsToText(textToRows('- a\n  - b'))))
check('Tab 缩进序列化成 2 空格', rowsToText(textToRows('a\n\t\tb')) === 'a\n    b',
  JSON.stringify(rowsToText(textToRows('a\n\t\tb'))))

/* ---------------- 2. 父子关系与折叠 ---------------- */
console.log('\n[2] 父子关系与折叠')
const { parent, childCount } = computeParents(t1)
check('父子关系正确', JSON.stringify(parent) === '[-1,0,1,0]', JSON.stringify(parent))
check('子节点计数正确', JSON.stringify(childCount) === '[2,1,0,0]', JSON.stringify(childCount))

check('默认全部可见', visibleRows(t1).length === 4)
const collapsedRoot = new Set([t1[0].key])
check('折叠根节点后只剩 1 行', visibleRows(t1, collapsedRoot).length === 1,
  `${visibleRows(t1, collapsedRoot).length}`)
const collapsedMid = new Set([t1[1].key])
check('折叠中间节点只隐藏其子树',
  JSON.stringify(visibleRows(t1, collapsedMid).map((v) => v.index)) === '[0,1,3]',
  JSON.stringify(visibleRows(t1, collapsedMid).map((v) => v.index)))
check('折叠只影响后代，不影响兄弟', visibleRows(t1, collapsedMid).length === 3)

/* ---------------- 3. 缩进 ---------------- */
console.log('\n[3] 缩进 / 反缩进')
const r3 = textToRows('根\n甲\n乙')
check('第 2 行最多缩进到第 1 级', maxAllowedDepth(r3, 1) === 1, `${maxAllowedDepth(r3, 1)}`)
const indented = changeDepth(r3, 1, +1)
check('Tab 让第 2 行缩进一级', indented.changed && depths(indented.rows)[1] === 1,
  JSON.stringify(depths(indented.rows)))
const outdented = changeDepth(indented.rows, 1, -1)
check('Shift+Tab 反缩进', outdented.changed && depths(outdented.rows)[1] === 0)
check('已经在第 0 级时反缩进无变化', changeDepth(r3, 0, -1).changed === false)

// 关键：不能比上一行深超过一级（防止悬空层级）
const chain = textToRows('a\n  b\n    c')
const deepTab = changeDepth(chain, 2, +1)
check('深层行不能再无限制缩进（上限 = 上一行 + 1）',
  deepTab.changed === false || depths(deepTab.rows)[2] <= depths(chain)[1] + 1,
  JSON.stringify(depths(deepTab.rows)))

// 缩进后编译出的图仍然是「森林」：边数 = 节点数 - 根数，且根数 == 缩进列表里 0 级的行数
const afterTab = changeDepth(textToRows('根\n甲\n乙'), 1, +1).rows
const g = outlineToMermaid(rowsToText(afterTab), 'TD')
const ids = [...g.matchAll(/^\s*(n\d+)\["/gm)].map((m) => m[1])
const edges = [...g.matchAll(/(n\d+) --> (n\d+)/g)].map((m) => [m[1], m[2]])
const hasIn = new Set(edges.map((e) => e[1]))
const roots = ids.filter((id) => !hasIn.has(id))
check('缩进后：边数 = 节点数 - 根数（是森林，没有断边）',
  edges.length === ids.length - roots.length,
  `ids=${ids.length} edges=${edges.length} roots=${roots.length}`)
check('根数 == 缩进列表里 0 级的行数（严丝合缝）',
  roots.length === afterTab.filter((r) => r.depth === 0).length,
  `图中根 ${roots.length} 个，列表 0 级 ${afterTab.filter((r) => r.depth === 0).length} 行`)

// 单根输入必须产出单根连通树
const single = outlineToMermaid('根\n  甲\n    甲1\n  乙', 'TD')
const sIds = [...single.matchAll(/^\s*(n\d+)\["/gm)].map((m) => m[1])
const sEdges = [...single.matchAll(/(n\d+) --> (n\d+)/g)].map((m) => [m[1], m[2]])
const sIn = new Set(sEdges.map((e) => e[1]))
check('单根缩进列表 → 单根连通树',
  sIds.filter((id) => !sIn.has(id)).length === 1 && sEdges.length === sIds.length - 1,
  `ids=${sIds.length} edges=${sEdges.length}`)
check('缩进列表里每一行都在图里有对应节点',
  ids.length === afterTab.length, `${ids.length} vs ${afterTab.length}`)

/* ---------------- 4. 换行 / 合并 / 删除 ---------------- */
console.log('\n[4] 换行 / 合并 / 删除')
const ins = insertAfter(t1, 1, 1)
check('Enter 在指定行后插入', ins.rows.length === 5 && ins.rows[2].label === '')
check('新行继承缩进层级', ins.rows[2].depth === 1, `${ins.rows[2].depth}`)
check('新行获得焦点', ins.caret === 0 && !!ins.focusKey)

/*
 * 回归：insertAfter 必须显式返回 changed:true。
 * OutlineList 的 apply() 用 `if (!result.changed) return` 做统一守卫，
 * 漏掉这个字段的话按 Enter 会静默无反应（这个 bug 真实存在过，
 * 而且因为当时以为是「headless 不路由键盘」而被掩盖了很久）。
 */
check('insertAfter 返回 changed:true（否则 Enter 会静默失效）',
  ins.changed === true, JSON.stringify({ changed: ins.changed }))

// 所有会改变行的操作都必须带 changed 标记，否则 apply() 会吞掉它们
// 注意用「确实会产生变化」的参数：changeDepth 会夹到合法范围，
// 被夹回原值时它返回 changed:false 是正确行为。
for (const [name, r] of [
  ['changeDepth', changeDepth(t1, 1, -1)],
  ['mergeWithPrev', mergeWithPrev(t1, 2)],
  ['deleteRow', deleteRow(t1, 1)],
  ['pasteRows', pasteRows(t1, 0, 'a\nb')],
  ['insertAfter', insertAfter(t1, 0, 0)],
]) {
  check(`${name} 的成功结果带 changed:true`, r.changed === true, JSON.stringify({ changed: r.changed }))
}
check('changeDepth 被夹回原值时不谎报 changed', changeDepth(t1, 1, 1).changed === false)

const merged = mergeWithPrev(t1, 2)
check('行首退格把当前行并入上一行',
  merged.changed && merged.rows[1].label === '甲甲1' && merged.rows.length === 3,
  JSON.stringify(labels(merged.rows)))
check('合并后光标落在接缝处', merged.caret === 1, `${merged.caret}`)
check('第一行无法再合并', mergeWithPrev(t1, 0).changed === false)

const del = deleteRow(t1, 2)
check('删除行', del.rows.length === 3 && !labels(del.rows).includes('甲1'),
  JSON.stringify(labels(del.rows)))
const delLast = deleteRow(textToRows('唯一一行'), 0)
check('只剩一行时清空而不是删掉', delLast.rows.length === 1 && delLast.rows[0].label === '')

/* ---------------- 5. 粘贴 ---------------- */
console.log('\n[5] 多行粘贴')
const pasted = pasteRows(t1, 1, 'X\n  Y\nZ')
check('多行粘贴拆成多行', pasted.changed && pasted.rows.length === 7, `${pasted.rows.length}`)
check('粘贴内容整体缩进到当前行层级',
  JSON.stringify(pasted.rows.slice(2, 5).map((r) => r.depth)) === '[1,2,1]',
  JSON.stringify(pasted.rows.slice(2, 5).map((r) => r.depth)))
check('单行粘贴不拦截（交给浏览器）', pasteRows(t1, 1, '单行').changed === false)

/* ---------------- 6. 同级分组底色 ---------------- */
console.log('\n[6] 同级分组')
// 注意要带缩进，否则 5 行都是根，各自成组
const g6 = groupTints(textToRows('根\n  甲\n    甲1\n  乙\n    乙1'))
check('同级兄弟共用同一底色（甲 与 乙 同为根的子节点）',
  g6[1] === g6[3], JSON.stringify(g6))
check('子组与父组底色不同', g6[1] !== g6[0], JSON.stringify(g6))
check('不同分支的子节点各自成组', g6[2] !== g6[4], JSON.stringify(g6))
check('组序号只有 0/1 两种（交替）', [...new Set(g6)].every((v) => v === 0 || v === 1), JSON.stringify(g6))

/* ---------------- 7. 编辑结果与 Mermaid 保持一致 ---------------- */
console.log('\n[7] 编辑器 ↔ Mermaid 一致性')
const cases = ['根\n  甲\n    甲1\n  乙', '根\n甲\n乙', '根\n  甲\n  乙\n    乙1']
for (const text of cases) {
  const rows = textToRows(text)
  const serialized = rowsToText(rows)
  // 1) 序列化后再解析，层级不变
  const again = textToRows(serialized)
  const same = JSON.stringify(depths(rows)) === JSON.stringify(depths(again))
  check(`「${text.split('\n')[0]}…」序列化幂等`, same,
    `${JSON.stringify(depths(rows))} vs ${JSON.stringify(depths(again))}`)

  // 2) computeParents 与 outlineToMermaid 的父子关系一致
  const { parent: p } = computeParents(rows)
  const mmd = outlineToMermaid(serialized, 'TD')
  const parentInMmd = new Array(rows.length).fill(-1)
  for (const m of mmd.matchAll(/(n\d+) --> (n\d+)/g)) {
    parentInMmd[Number(m[2].slice(1))] = Number(m[1].slice(1))
  }
  check(`「${text.split('\n')[0]}…」父子关系与编译结果一致`,
    JSON.stringify(p) === JSON.stringify(parentInMmd),
    `${JSON.stringify(p)} vs ${JSON.stringify(parentInMmd)}`)
}

/* ---------------- 8. 拖拽移动：严格验证插入逻辑 ---------------- */
console.log('\n[8] 拖拽移动（跨层级 / 同层换序 / 防环）')

/** 用缩进文本建树，便于断言 */
const tree = (text) => {
  const root = { id: 'root', text: 'ROOT', children: [], collapsed: false, fold: null }
  const stack = [{ depth: -1, node: root }]
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const indent = line.match(/^ */)[0].length
    const depth = Math.floor(indent / 2)
    const node = { id: line.trim(), text: line.trim(), children: [], collapsed: false, fold: null }
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop()
    stack[stack.length - 1].node.children.push(node)
    stack.push({ depth, node })
  }
  return root
}
/** 树 → 缩进文本（忽略合成根） */
const dump = (root) => {
  const out = []
  const walk = (n, d) => { out.push('  '.repeat(d) + n.text); n.children.forEach((c) => walk(c, d + 1)) }
  root.children.forEach((c) => walk(c, 0))
  return out.join('\n')
}
const countNodes = (root) => {
  let n = 0
  const walk = (x) => { n++; x.children.forEach(walk) }
  walk(root)
  return n
}
const apply = (text, from, to, pos) => {
  const root = tree(text)
  const r = moveNode(root, from, to, pos)
  return { moved: r.moved, reason: r.reason, text: dump(root), count: countNodes(root) }
}

const T = 'A\n  A1\n  A2\nB\n  B1\n  B2'

// --- 同层换序：往前 ---
{
  const r = apply(T, 'B2', 'B1', 'before')
  check('同层：B2 插到 B1 前面', r.moved && r.text === 'A\n  A1\n  A2\nB\n  B2\n  B1', JSON.stringify(r.text))
}
// --- 同层换序：往后 ---
{
  const r = apply(T, 'B1', 'B2', 'after')
  check('同层：B1 插到 B2 后面', r.moved && r.text === 'A\n  A1\n  A2\nB\n  B2\n  B1', JSON.stringify(r.text))
}
// --- 同层：第一个插到最后一个后面 ---
{
  const r = apply(T, 'A1', 'A2', 'after')
  check('同层：A1 移到 A2 之后', r.moved && r.text.startsWith('A\n  A2\n  A1'), JSON.stringify(r.text))
}
// --- 跨层级：变成子节点 ---
{
  const r = apply(T, 'A1', 'B1', 'child')
  check('跨层：A1 成为 B1 的子节点',
    r.moved && r.text === 'A\n  A2\nB\n  B1\n    A1\n  B2', JSON.stringify(r.text))
}
// --- 跨层级：插到别的分支前面（同级上方）---
{
  const r = apply(T, 'A1', 'B1', 'before')
  check('跨层：A1 插到 B1 前面（成为 B 的子节点）',
    r.moved && r.text === 'A\n  A2\nB\n  A1\n  B1\n  B2', JSON.stringify(r.text))
}
// --- 跨层级：插到别的分支后面 ---
{
  const r = apply(T, 'A1', 'B1', 'after')
  check('跨层：A1 插到 B1 后面',
    r.moved && r.text === 'A\n  A2\nB\n  B1\n  A1\n  B2', JSON.stringify(r.text))
}
// --- 往上移（用户报的「无法插到上面」）---
{
  const r = apply('A\n  A1\n  A2\n  A3', 'A3', 'A1', 'before')
  check('同层上移：A3 插到 A1 前面（之前做不到）',
    r.moved && r.text === 'A\n  A3\n  A1\n  A2', JSON.stringify(r.text))
}
// --- 把子节点提升为根级兄弟 ---
{
  const r = apply(T, 'A1', 'B', 'after')
  check('把 A1 提升到 B 之后（成为根级）',
    r.moved && r.text === 'A\n  A2\nB\n  B1\n  B2\nA1', JSON.stringify(r.text))
}

// --- 防环 ---
{
  const r = apply('A\n  A1\n    A11', 'A', 'A11', 'child')
  check('不能把父节点拖进自己的子树（防环）', r.moved === false && r.reason === 'cycle', r.reason)
}
{
  const r = apply('A\n  A1', 'A', 'A1', 'before')
  check('不能把父节点插到自己子节点的兄弟位（防环）', r.moved === false && r.reason === 'cycle', r.reason)
}
// --- 无效目标 ---
{
  const r = apply(T, 'A1', 'A1', 'child')
  check('拖到自己身上无效', r.moved === false && r.reason === 'self')
}
{
  const r = apply(T, 'A1', '不存在', 'child')
  check('目标不存在时不动数据', r.moved === false && r.reason === 'missing')
}

// --- 不丢节点：任意组合都不能丢 ---
{
  const names = ['A', 'A1', 'A2', 'B', 'B1', 'B2']
  let lost = 0
  let wrongCount = 0
  for (const from of names) {
    for (const to of names) {
      for (const pos of ['child', 'before', 'after']) {
        const r = apply(T, from, to, pos)
        if (r.count !== 7) wrongCount++          // 合成根 + 6 个节点
        for (const n of names) {
          if (!r.text.includes(n)) lost++
        }
      }
    }
  }
  check('穷举 108 种拖拽组合：节点总数始终不变', wrongCount === 0, `${wrongCount} 次异常`)
  check('穷举 108 种拖拽组合：没有任何节点丢失', lost === 0, `${lost} 次丢失`)
}

// --- 拖拽后与编译结果一致 ---
{
  const root = tree(T)
  moveNode(root, 'A1', 'B1', 'child')
  const text = dump(root)
  const { computeParents } = await import('./outlineOps.js')
  const rows = textToRows(text)
  const { parent: p } = computeParents(rows)
  const mmd = outlineToMermaid(text, 'TD')
  const parentInMmd = new Array(rows.length).fill(-1)
  for (const m of mmd.matchAll(/(n\d+) --> (n\d+)/g)) {
    parentInMmd[Number(m[2].slice(1))] = Number(m[1].slice(1))
  }
  check('拖拽后的树与编译出的 Mermaid 父子关系一致',
    JSON.stringify(p) === JSON.stringify(parentInMmd),
    `${JSON.stringify(p)} vs ${JSON.stringify(parentInMmd)}`)
}

/* ---------------- 9. 右侧流程图操作 → 左侧文本 ---------------- */
console.log('\n[9] 流程图上的操作改的是左侧文本')

const O = 'A\n  A1\n    A11\n  A2\nB'
check('改字：替换第 i 行',
  setRowLabelText(O, 1, '改过的') === 'A\n  改过的\n    A11\n  A2\nB',
  JSON.stringify(setRowLabelText(O, 1, '改过的')))
check('改字：内容没变时返回 null（不产生无意义的改动）',
  setRowLabelText(O, 1, 'A1') === null)
check('改字：下标越界返回 null', setRowLabelText(O, 99, 'x') === null)

check('新增同级：缩进与目标一致',
  insertSiblingText(O, 1, '新') === 'A\n  A1\n  新\n    A11\n  A2\nB',
  JSON.stringify(insertSiblingText(O, 1, '新')))
check('新增子节点：比目标深一级',
  insertChildText(O, 1, '新') === 'A\n  A1\n    新\n    A11\n  A2\nB',
  JSON.stringify(insertChildText(O, 1, '新')))

// 删除：子节点上移一级，内容一个不丢
const delText = deleteRowText(O, 1)
check('删除节点：直接子节点提升一级',
  delText === 'A\n  A11\n  A2\nB', JSON.stringify(delText))
check('删除节点：孙节点仍挂在原父节点下（结构没散）', (() => {
  // A11 提升到 A 下；它自己若有子节点，相对层级不变
  const deep = 'A\n  A1\n    A11\n      A111\n  A2'
  const d = deleteRowText(deep, 1)
  const rows = textToRows(d)
  const { parent } = computeParents(rows)
  const iA11 = rows.findIndex((r) => r.label === 'A11')
  const iA111 = rows.findIndex((r) => r.label === 'A111')
  return parent[iA111] === iA11
})(), JSON.stringify(deleteRowText('A\n  A1\n    A11\n      A111\n  A2', 1)))
check('删除节点：内容一个不丢', (() => {
  const d = deleteRowText(O, 1)
  const lines = d.split('\n').map((l) => l.trim())
  // 注意不能用 includes 判断：'A11' 里也含 'A1'
  return JSON.stringify(lines) === JSON.stringify(['A', 'A11', 'A2', 'B'])
})(), JSON.stringify(delText))
check('删除最后一行 → 清空', deleteRowText('唯一', 0) === '')

// 删完再编译，仍然是一棵合法的树
check('删除后编译出的图仍然连通', (() => {
  const d = deleteRowText(O, 1)
  const mmd = outlineToMermaid(d, 'TD')
  const ids = [...mmd.matchAll(/^\s*(n\d+)\["/gm)].map((m) => m[1])
  const edges = [...mmd.matchAll(/(n\d+) --> (n\d+)/g)].map((m) => [m[1], m[2]])
  const hasIn = new Set(edges.map((e) => e[1]))
  const roots = ids.filter((id) => !hasIn.has(id))
  return edges.length === ids.length - roots.length
})(), JSON.stringify(deleteRowText(O, 1)))

console.log(`\n${'='.repeat(46)}`)
console.log(`  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)
