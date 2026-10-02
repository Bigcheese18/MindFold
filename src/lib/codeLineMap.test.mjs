/**
 * parseCodeLineMap 纯函数测试
 * ============================
 * 这张表是「双向高亮联动」的地基，所以先把它单独钉死。
 *
 * 重点：
 *   · 行号口径 1-based，和编辑器行号栏一致
 *   · **声明行优先**，没有声明行才回退到连线行
 *   · 注释 / 样式行 / 子图行 / 表头行不产生映射
 *   · 标签文字里的 id、`-->`、`|边标签|` 都不能被当成节点
 *   · ★ 语法错误**不中断**：坏行之前的映射必须完好
 *   · 纯函数：不改入参、可重复调用
 */
import {
  parseCodeLineMap, parseCodeLineIndex,
} from './codeLineMap.js'

/** 便捷读取：第 lineNo 行上有哪些节点（测的是 byLine 这条反向通道） */
const nodesAt = (code, lineNo) => parseCodeLineIndex(code).byLine[lineNo] || []

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ================================================================== */
console.log('\n[1] 基本：声明行优先')
/* ================================================================== */

const CODE1 = [
  'flowchart TD',            // 1
  '  n0["根节点"]',           // 2
  '  n1["甲"]',               // 3
  '  n0 --> n1',             // 4
].join('\n')

check('n0 落在第 2 行（声明行，不是连线行）', parseCodeLineMap(CODE1).n0 === 2,
  JSON.stringify(parseCodeLineMap(CODE1)))
check('n1 落在第 3 行', parseCodeLineMap(CODE1).n1 === 3)
check('表头行本身不产生映射', !('flowchart' in parseCodeLineMap(CODE1)))
check('行号是 1-based（第一行代码是 2 不是 1）', parseCodeLineMap(CODE1).n0 !== 1)

const CODE2 = [
  'flowchart TD',
  '  n0["a"]',
  '  n1["b"]',
  '  n3["c"]',
].join('\n')
check('需求给的例子形态：{ n0:2, n1:3, n3:4 }', eq(parseCodeLineMap(CODE2), { n0: 2, n1: 3, n3: 4 }),
  JSON.stringify(parseCodeLineMap(CODE2)))

/* ================================================================== */
console.log('\n[2] 回退：没有声明行时用连线行')
/* ================================================================== */

const CODE3 = [
  'flowchart TD',
  '  n0 --> n1',
  '  n1 --> n2',
].join('\n')
check('n0 回退到第 2 行', parseCodeLineMap(CODE3).n0 === 2, JSON.stringify(parseCodeLineMap(CODE3)))
check('n1 取**第一次**出现的连线行 = 2', parseCodeLineMap(CODE3).n1 === 2)
check('n2 回退到第 3 行', parseCodeLineMap(CODE3).n2 === 3)

const CODE4 = [
  'flowchart TD',
  '  n1 --> n2',
  '  n0["根"]',
  '  n0 --> n1',
].join('\n')
const idx4 = parseCodeLineIndex(CODE4)
check('有声明行的节点用声明行（n0 → 3，不是 4）', idx4.lineMap.n0 === 3, JSON.stringify(idx4.lineMap))
check('n1 没有声明行 → 回退到连线行 2', idx4.lineMap.n1 === 2)
check('decl 只装声明行', eq(idx4.decl, { n0: 3 }), JSON.stringify(idx4.decl))
check('fallback 只装回退行', eq(idx4.fallback, { n1: 2, n2: 2 }), JSON.stringify(idx4.fallback))
check('declCount / fallbackCount 统计正确',
  idx4.declCount === 1 && idx4.fallbackCount === 2, `${idx4.declCount}/${idx4.fallbackCount}`)

/* ================================================================== */
console.log('\n[3] 节点外形')
/* ================================================================== */

const SHAPES = [
  'flowchart TD',
  '  A["方括号带引号"]',
  '  B[裸方括号]',
  '  C(圆括号)',
  '  D((双圆))',
  '  E{花括号}',
  '  F{{六边形}}',
].join('\n')
const shapes = parseCodeLineMap(SHAPES)
check('["…"] 认得出', shapes.A === 2, JSON.stringify(shapes))
check('[裸] 认得出', shapes.B === 3)
check('(圆) 认得出', shapes.C === 4)
check('((双圆)) 认得出', shapes.D === 5)
check('{花} 认得出', shapes.E === 6)
check('{{六边}} 认得出', shapes.F === 7)

check('一行里两个声明都记下（都算这一行）',
  (() => { const m = parseCodeLineMap('flowchart TD\n  A["x"] B["y"]'); return m.A === 2 && m.B === 2 })(),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A["x"] B["y"]')))

/* ================================================================== */
console.log('\n[4] 不该产生映射的东西')
/* ================================================================== */

const NOISE = [
  'flowchart TD',                        // 1 表头
  '  %% n9["注释里的节点"]',               // 2 整行注释
  '  n0["真的"]',                         // 3
  '  classDef big fill:#f9f',            // 4 样式定义
  '  class n0 big',                      // 5 样式应用
  '  style n0 fill:#bbf',                // 6 行内样式
  '  linkStyle 0 stroke:red',            // 7 连线样式
  '  click n0 href "http://x"',          // 8 点击事件
  '  subgraph 子图名',                    // 9 子图
  '  direction LR',                      // 10
  '  end',                               // 11
  '  n0 --> n1',                         // 12
].join('\n')
const noise = parseCodeLineMap(NOISE)
check('注释行里的 n9 不进表', !('n9' in noise), JSON.stringify(noise))
check('classDef 里的 id 不进表', !('big' in noise), JSON.stringify(noise))
check('style / linkStyle / click 行的 id 不进表',
  !('red' in noise) && !('href' in noise) && !('x' in noise), JSON.stringify(noise))
check('subgraph / direction / end 不进表',
  !('子图名' in noise) && !('LR' in noise), JSON.stringify(noise))
check('真正的声明仍在（n0 → 3）', noise.n0 === 3, JSON.stringify(noise))
check('连线里的 n1 回退到 12', noise.n1 === 12, JSON.stringify(noise))
check('整张表只有 n0 / n1 两个节点', eq(Object.keys(noise).sort(), ['n0', 'n1']), JSON.stringify(noise))

check('标签文字里的 id 不算节点',
  eq(parseCodeLineMap('flowchart TD\n  A["见 B[1]"]'), { A: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A["见 B[1]"]')))
check('标签里的 --> 不算连线',
  (() => {
    const m = parseCodeLineMap('flowchart TD\n  A["a --> b"]')
    return eq(m, { A: 2 })
  })(), JSON.stringify(parseCodeLineMap('flowchart TD\n  A["a --> b"]')))
check('|边标签| 里的 id 不算节点',
  eq(parseCodeLineMap('flowchart TD\n  A -->|走这里| B'), { A: 2, B: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A -->|走这里| B')))
check('A["x"] --> B["y"] 一行里两个声明都在第 2 行',
  eq(parseCodeLineMap('flowchart TD\n  A["x"] --> B["y"]'), { A: 2, B: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A["x"] --> B["y"]')))
check('前置 id 前缀不会被切出假节点（An0 不该产生 n0）',
  (() => { const m = parseCodeLineMap('flowchart TD\n  An0["x"]'); return eq(m, { An0: 2 }) })(),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  An0["x"]')))

/* ================================================================== */
console.log('\n[5] 链式、自环、中文 id、开放连线')
/* ================================================================== */

check('链式 A --> B --> C 三个都落在同一行',
  eq(parseCodeLineMap('flowchart TD\n  A --> B --> C'), { A: 2, B: 2, C: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A --> B --> C')))
check('自环 A --> A 也认',
  eq(parseCodeLineMap('flowchart TD\n  A --> A'), { A: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A --> A')))
check('中文 id',
  eq(parseCodeLineMap('flowchart TD\n  开始["起点"]\n  结束["终点"]\n  开始 --> 结束'),
    { 开始: 2, 结束: 3 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  开始["起点"]\n  结束["终点"]\n  开始 --> 结束')))
check('带连字符的 id',
  eq(parseCodeLineMap('flowchart TD\n  node-a["x"]'), { 'node-a': 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  node-a["x"]')))
check('开放连线 A --- B 也当连线行',
  eq(parseCodeLineMap('flowchart TD\n  A --- B'), { A: 2, B: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A --- B')))
check('虚箭头 A -.-> B',
  eq(parseCodeLineMap('flowchart TD\n  A -.-> B'), { A: 2, B: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A -.-> B')))
check('粗箭头 A ==> B',
  eq(parseCodeLineMap('flowchart TD\n  A ==> B'), { A: 2, B: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A ==> B')))
check('graph LR 表头也跳过',
  eq(parseCodeLineMap('graph LR\n  A["x"]'), { A: 2 }),
  JSON.stringify(parseCodeLineMap('graph LR\n  A["x"]')))
check('表头后面直接跟语句（;A-->B）不整行丢弃',
  eq(parseCodeLineMap('graph TD;A-->B'), { A: 1, B: 1 }),
  JSON.stringify(parseCodeLineMap('graph TD;A-->B')))

/* ------------------------------------------------------------------ */
console.log('\n[5b] ★ 无空格箭头 A-->B（连带修掉的一处真实 bug）')
/* ------------------------------------------------------------------ */
/*
 * 旧 id 规则是 `[A-Za-z0-9_-]+`，正则从左往右贪心匹配，会把 `A-->B`
 * 吃成 id `A--` + `B`，于是**边表是空的**。
 * 手写 mermaid 时 `A-->B`（不加空格）恰恰是最常见的写法，
 * 结果整张图在双轨制里被拆成 3 棵互不相连的树，删除/换位也全部失灵。
 * 现在 id 里的连字符只能是「单个且后面还有 id 字符」，`A--` 匹配不出来。
 */
check('A-->B 无空格：只有两个节点', eq(Object.keys(parseCodeLineMap('flowchart TD\n  A-->B')), ['A', 'B']),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A-->B')))
check('A-->B 无空格：两端都在连线行上', eq(parseCodeLineMap('flowchart TD\n  A-->B'), { A: 2, B: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A-->B')))
check('A-->B 无空格：不再冒出幽灵节点 A--',
  !('A--' in parseCodeLineMap('flowchart TD\n  A-->B')), JSON.stringify(parseCodeLineMap('flowchart TD\n  A-->B')))
check('紧凑链式 A-->B-->C', eq(parseCodeLineMap('flowchart TD\n  A-->B-->C'), { A: 2, B: 2, C: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A-->B-->C')))
check('紧凑混合 A-->B --> C 也对',
  eq(parseCodeLineMap('flowchart TD\n  A-->B --> C'), { A: 2, B: 2, C: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A-->B --> C')))
check('带连字符的 id 没有被误伤（node-1 --> node-2）',
  eq(parseCodeLineMap('flowchart TD\n  node-1 --> node-2'), { 'node-1': 2, 'node-2': 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  node-1 --> node-2')))
check('带连字符的 id 紧凑写法也认（node-1-->node-2）',
  eq(parseCodeLineMap('flowchart TD\n  node-1-->node-2'), { 'node-1': 2, 'node-2': 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  node-1-->node-2')))
check('多重内部连字符 a-b-c --> d',
  eq(parseCodeLineMap('flowchart TD\n  a-b-c --> d'), { 'a-b-c': 2, d: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  a-b-c --> d')))
check('裸边标签 A -- 说明 --> B 里「说明」不算节点',
  eq(parseCodeLineMap('flowchart TD\n  A -- 说明 --> B'), { A: 2, B: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A -- 说明 --> B')))
check('裸边标签（无空格分隔的连字符 id）不被误伤',
  eq(parseCodeLineMap('flowchart TD\n  node-a --> node-b'), { 'node-a': 2, 'node-b': 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  node-a --> node-b')))

/* ================================================================== */
console.log('\n[6] 反向映射 byLine')
/* ================================================================== */

const CODE6 = [
  'flowchart TD',        // 1
  '  n0["根"]',           // 2
  '  n1["甲"]',           // 3
  '  n0 --> n1',         // 4
].join('\n')
check('第 2 行 → [n0]', eq(nodesAt(CODE6, 2), ['n0']), JSON.stringify(nodesAt(CODE6, 2)))
check('第 4 行 → [n0, n1]（连线的两端都算「这一行包含的节点」）',
  eq(nodesAt(CODE6, 4), ['n0', 'n1']), JSON.stringify(nodesAt(CODE6, 4)))
check('第 1 行（表头）→ 空', eq(nodesAt(CODE6, 1), []))
check('越界行号 → 空数组而不是 undefined', eq(nodesAt(CODE6, 999), []))
check('byLine 覆盖每一行代码（含只有声明、只有连线、什么都没有的行）',
  (() => {
    const idx = parseCodeLineIndex(CODE6)
    return idx.byLine[2].length === 1 && idx.byLine[3].length === 1
      && idx.byLine[4].length === 2 && idx.byLine[1] === undefined
  })(), JSON.stringify(parseCodeLineIndex(CODE6).byLine))
check('lineMap 与 byLine 互为一致（每个 id 的行号上都能找到它）',
  (() => {
    const idx = parseCodeLineIndex(CODE6)
    return Object.entries(idx.lineMap).every(([id, line]) => (idx.byLine[line] || []).includes(id))
  })(), JSON.stringify(parseCodeLineIndex(CODE6)))

/* ================================================================== */
console.log('\n[7] ★ 语法错误不中断：坏行之前的映射必须完好')
/* ================================================================== */

const BROKEN = [
  'flowchart TD',            // 1
  '  n0["根"]',               // 2
  '  n1["甲"]',               // 3
  '  n2["未闭合',              // 4  ← 引号 + 外形都没闭合
  '  n3["丙"]',               // 5
  '  n0 --> n3',             // 6
].join('\n')
const brokenMap = parseCodeLineMap(BROKEN)
check('坏行之前的两行完全正确（n0→2, n1→3）',
  brokenMap.n0 === 2 && brokenMap.n1 === 3, JSON.stringify(brokenMap))
check('坏行之后的 n3 仍然解析出来（n3→5）', brokenMap.n3 === 5, JSON.stringify(brokenMap))
check('未闭合的 n2 也尽量记下（n2→4）', brokenMap.n2 === 4, JSON.stringify(brokenMap))
check('n2 记在宽松（decl）通道而不是回退通道', parseCodeLineIndex(BROKEN).decl.n2 === 4,
  JSON.stringify(parseCodeLineIndex(BROKEN).decl))
check('坏行被报告出来', parseCodeLineIndex(BROKEN).malformed.some((m) => m.line === 4),
  JSON.stringify(parseCodeLineIndex(BROKEN).malformed))
check('报告里说明原因', /没有闭合/.test(parseCodeLineIndex(BROKEN).malformed[0].reason),
  parseCodeLineIndex(BROKEN).malformed[0].reason)
check('ok = false', parseCodeLineIndex(BROKEN).ok === false)

// 第一行就坏掉，后面必须还能用
const BROKEN_HEAD = [
  'flowchart TD',
  '  n0["未闭合',
  '  n1["好的"]',
  '  n0 --> n1',
].join('\n')
check('第一行就报错，后面照常解析',
  parseCodeLineMap(BROKEN_HEAD).n1 === 3, JSON.stringify(parseCodeLineMap(BROKEN_HEAD)))

// 箭头悬空（正在打字的中间态，最常见）
const DANGLING = 'flowchart TD\n  n0["a"]\n  n0 -->'
check('悬空箭头被报告', parseCodeLineIndex(DANGLING).malformed.length === 1,
  JSON.stringify(parseCodeLineIndex(DANGLING).malformed))
check('悬空箭头不影响已有映射', parseCodeLineMap(DANGLING).n0 === 2, JSON.stringify(parseCodeLineMap(DANGLING)))
check('悬空箭头不会凭空造出节点', eq(Object.keys(parseCodeLineMap(DANGLING)), ['n0']),
  JSON.stringify(parseCodeLineMap(DANGLING)))

// 引号奇数个
const ODD_QUOTE = 'flowchart TD\n  n0["a]\n  n1["b"]'
check('引号奇数个被报告', parseCodeLineIndex(ODD_QUOTE).malformed.length === 1,
  JSON.stringify(parseCodeLineIndex(ODD_QUOTE).malformed))
check('奇数引号之后的合法行仍然解析', parseCodeLineMap(ODD_QUOTE).n1 === 3,
  JSON.stringify(parseCodeLineMap(ODD_QUOTE)))

// 完全无法解析的垃圾：不能抛异常
check('纯垃圾输入不抛异常且返回对象',
  (() => { try { return typeof parseCodeLineMap('???\n!!!\n***') === 'object' } catch { return false } })())
check('中文乱码输入不抛异常',
  (() => { try { parseCodeLineMap('根["（（[[{{'); return true } catch { return false } })())

/* ================================================================== */
console.log('\n[8] 边界与纯函数性质')
/* ================================================================== */

check('空字符串 → 空表', eq(parseCodeLineMap(''), {}))
check('null / undefined → 空表', eq(parseCodeLineMap(null), {}) && eq(parseCodeLineMap(undefined), {}))
check('只有换行 → 空表', eq(parseCodeLineMap('\n\n\n'), {}))
check('只有表头 → 空表', eq(parseCodeLineMap('flowchart TD'), {}))
check('CRLF 换行不产生偏差（行号与 \\n 切分一致）',
  eq(parseCodeLineMap('flowchart TD\r\n  A["x"]\r\n  B["y"]'), { A: 2, B: 3 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\r\n  A["x"]\r\n  B["y"]')))
check('CRLF 下的连线行回退也正确',
  eq(parseCodeLineMap('flowchart TD\r\n  A-->B'), { A: 2, B: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\r\n  A-->B')))
check('缩进用 Tab 也认', eq(parseCodeLineMap('flowchart TD\n\tA["x"]'), { A: 2 }))
check('行尾空格不影响', eq(parseCodeLineMap('flowchart TD\n  A["x"]   '), { A: 2 }))
check('行内 %% 注释被剥掉',
  eq(parseCodeLineMap('flowchart TD\n  A["x"] %% B["y"]'), { A: 2 }),
  JSON.stringify(parseCodeLineMap('flowchart TD\n  A["x"] %% B["y"]')))

const MUT = 'flowchart TD\n  A["x"]\n  A --> B'
const before = MUT
parseCodeLineMap(MUT)
check('不改入参', MUT === before)
check('重复调用结果稳定',
  eq(parseCodeLineMap(MUT), parseCodeLineMap(MUT)), JSON.stringify(parseCodeLineMap(MUT)))

// 真实场景：outlineToMermaid 编译出来的代码也要能被解析
import { outlineToMermaid } from './model.js'
const compiled = outlineToMermaid('根节点\n  第一步\n  第二步\n    细节', 'TD')
const cm = parseCodeLineMap(compiled)
check('编译产物：3 个声明行 + 连线行，节点全部有映射',
  Object.keys(cm).length >= 4, JSON.stringify(cm))
check('编译产物：所有映射行号都在有效范围内',
  Object.values(cm).every((n) => n >= 1 && n <= compiled.split('\n').length), JSON.stringify(cm))
check('编译产物：每个节点都有确定的行号',
  Object.values(cm).every((n) => Number.isInteger(n)), JSON.stringify(cm))

/* ================================================================== */
console.log('\n[9] ★ 跨模块一致性：行号映射 与 编辑操作 / 双轨制 必须对同一段代码给出同一套节点')
/* ================================================================== */
/*
 * 三个模块各有一套「什么算节点」的规则（model 的解析、codeOps 的编辑、
 * codeLineMap 的行号）。它们必须永远一致，否则会出现
 * 「图上有这个节点、右键菜单却说找不到」这种最难查的 bug。
 * 这里用行为等价来钉死，而不是比较正则字符串 —— 后者一改写法就失效。
 */
import * as codeOps from './codeOps.js'
import { mermaidToOutlineEx } from './model.js'

const CONSISTENCY_CASES = [
  ['空格箭头', 'flowchart TD\n  A["x"]\n  B["y"]\n  A --> B'],
  ['紧凑箭头', 'flowchart TD\n  A["x"]\n  B["y"]\n  A-->B'],
  ['紧凑链式', 'flowchart TD\n  A-->B-->C'],
  ['连字符 id', 'flowchart TD\n  node-1["甲"]\n  node-2["乙"]\n  node-1-->node-2'],
  ['中文 id', 'flowchart TD\n  开始["起点"]\n  结束["终点"]\n  开始-->结束'],
  ['多对一', 'flowchart TD\n  A-->C\n  B-->C'],
  ['自环', 'flowchart TD\n  A-->A'],
  ['虚线箭头', 'flowchart TD\n  A-.->B'],
  ['粗箭头', 'flowchart TD\n  A==>B'],
  ['带边标签', 'flowchart TD\n  A-->|说明|B'],
  ['带声明行内联', 'flowchart TD\n  A["x"]-->B["y"]'],
]

for (const [name, src] of CONSISTENCY_CASES) {
  const mapIds = Object.keys(parseCodeLineMap(src)).sort()
  const opsIds = codeOps.listNodeIds(src).sort()
  const modelIds = (mermaidToOutlineEx(src)?.rowIds || []).slice().sort()
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  check(`${name}：行号映射的节点集 == codeOps 的节点集`,
    same(mapIds, opsIds), `${JSON.stringify(mapIds)} vs ${JSON.stringify(opsIds)}`)
  check(`${name}：行号映射的节点集 == model 反推的节点集`,
    same(mapIds, modelIds), `${JSON.stringify(mapIds)} vs ${JSON.stringify(modelIds)}`)
}

// 边也必须一致（紧凑写法曾经在三个模块里全部漏掉）
for (const [name, src] of CONSISTENCY_CASES) {
  const opsEdges = [...codeOps.listEdges(src)].sort()
  const ex = mermaidToOutlineEx(src)
  const modelEdgeCount = ex?.stats?.edges ?? -1
  check(`${name}：codeOps 与 model 的边数一致`,
    opsEdges.length === modelEdgeCount, `${opsEdges.length} vs ${modelEdgeCount}`)
}

check('★ 紧凑箭头 A-->B 确实被识别成 1 条边（回归：曾经是 0 条）',
  codeOps.listEdges('flowchart TD\n  A-->B').size === 1,
  String(codeOps.listEdges('flowchart TD\n  A-->B').size))
check('★ 紧凑箭头下 parentsOf 正确（回归）',
  eq(codeOps.parentsOf('flowchart TD\n  A-->B', 'B'), ['A']),
  JSON.stringify(codeOps.parentsOf('flowchart TD\n  A-->B', 'B')))
check('★ 紧凑箭头下 deleteNodeInCode 可用（回归：曾经直接失败）',
  codeOps.deleteNodeInCode('flowchart TD\n  A["x"]\n  B["y"]\n  A-->B', 'B').ok === true,
  JSON.stringify(codeOps.deleteNodeInCode('flowchart TD\n  A["x"]\n  B["y"]\n  A-->B', 'B')))
check('★ 紧凑箭头下双轨制反推出的是树而不是三棵孤树（回归）',
  mermaidToOutlineEx('flowchart TD\n  A["x"]\n  B["y"]\n  A-->B')?.stats?.treeEdges === 1,
  JSON.stringify(mermaidToOutlineEx('flowchart TD\n  A["x"]\n  B["y"]\n  A-->B')?.stats))

/* ================================================================== */
console.log(`\n${'='.repeat(46)}`)
console.log(`  parseCodeLineMap  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)
