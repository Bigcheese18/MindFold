/**
 * 节点外形（形状）纯函数测试
 * ============================
 * 「流程图不应该只有一种图案」这件事的地基。
 *
 * 这条链路有三个环节，**必须同时成立**，否则症状会很难查：
 *   1. 缩进列表：行尾 `{判断}` → 形状 key
 *   2. 编译：形状 key → mermaid 的括号对
 *   3. 反向：mermaid 的括号对 → 形状 key（切回缩进列表不能丢）
 *
 * 最容易漏的是第 3 环：只做 1+2 时，图看着是对的，
 * 但用户一切回缩进列表形状就没了 —— 所以这里每个形状都做**往返**测试。
 *
 * 另外两类必须守住的：
 *   · **老文档逐字节不变**：正文里的 `{…}`、`[…]`、`(…)` 绝不能被当成形状；
 *   · **形状表与 mermaid 真语法一致**：写错括号 mermaid 会直接报错，
 *     所以形状表要和 mermaid 的解析器口径对齐（见 shapes.js 的注释）。
 */
import {
  parseOutline, outlineToMermaid, mermaidToOutline, mermaidToOutlineEx,
  shapeAtOutlineRow, setShapeInOutline, SHAPES, shapeOf, isShape, nextShape,
} from './model.js'
import { setShapeInCode, getNodeShapeInCode } from './codeOps.js'
import { splitShapeMark, shapeMark, readNodeShape, parseShapeName } from './shapes.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ================================================================== */
console.log('\n[1] 老文档必须逐字节不变（最重要的一条）')
/* ================================================================== */

// 这些行全是**真实文档里会长这样**的内容，一个字符都不许动
const OLD_LINES = [
  '{待定} 这一步还没定',          // 花括号在行首
  '中间 {判断} 有花括号',          // 花括号在中间
  '{随便}',                        // 行尾花括号但名字不认识
  '文字 {空格 名字}',              // 两个词，不认识
  '【重要】注意',                  // 中文方括号
  '核对「凭据」里的 [token]',      // 方括号在中间
  '处理(特殊)情况',                // 圆括号
  '引用 (-> 别的节点)',            // 引用标记
  'SYN=1 ACK=1',
]
for (const line of OLD_LINES) {
  const p = parseOutline(line)
  // `(-> 目标)` 是引用标记，本来就不算「显示文字」—— label 里应被剥掉。
  // 其余内容必须逐字节保留。
  const want = line.trim().replace(/\s*\(->[^)]*\)\s*$/, '')
  const got = p.length ? p[0].label : null
  check(`「${line}」原样保留`, got === want, JSON.stringify(got))
  check(`「${line}」形状是默认方框`, p.length ? p[0].shape === 'rect' : false,
    JSON.stringify(p[0]?.shape))
}

// 整篇编译：没有形状标记时，输出里不许出现任何非 ["..."] 的括号
const OLD_DOC = [
  'TCP 三次握手',
  '  第一次握手',
  '    SYN=1',
  '  第二次握手',
  '    SYN=1 ACK=1',
  '  第三次握手',
  '    ACK=1',
].join('\n')
const oldMmd = outlineToMermaid(OLD_DOC)
check('整篇老文档：每个节点都是 ["..."]',
  oldMmd.split('\n').slice(1).filter((l) => l.includes('["')).length === 7 &&
  !/\{"|\(\["|\[\["|\[\(/.test(oldMmd), oldMmd)
check('★ 老文档往返一圈逐字节相同',
  mermaidToOutline(oldMmd) === OLD_DOC, JSON.stringify(mermaidToOutline(oldMmd)))

/* ================================================================== */
console.log('\n[2] 每种外形：编译 + 反向读回（往返不丢）')
/* ================================================================== */

for (const s of SHAPES) {
  const outline = `起点\n  判定步骤 {${s.label}}\n  起点 --> 判定步骤`
  const mmd = outlineToMermaid(outline)
  const defLine = mmd.split('\n').find((l) => l.includes('n1'))
  const okCompile = !!defLine && defLine.includes(s.mermaid[0]) && defLine.includes(s.mermaid[1])
  const back = mermaidToOutline(mmd)
  // rect 是默认外形，`{方框}` 会被规范化掉 —— 语义相同，这是有意的
  const okBack = s.key === 'rect'
    ? !back.includes('{') && defLine.includes('["')
    : back.includes(`判定步骤 {${s.label}}`)
  const shape = parseOutline(back).find((n) => n.label === '判定步骤')?.shape
  check(`${s.label} (${s.key}) 编译`, okCompile, defLine)
  check(`${s.label} (${s.key}) 读回`, okBack, JSON.stringify(back))
  check(`${s.label} (${s.key}) 形状 key 一致`, shape === s.key, String(shape))
}

check('形状表里 key 无重复', new Set(SHAPES.map((s) => s.key)).size === SHAPES.length)
check('形状表里 label 无重复', new Set(SHAPES.map((s) => s.label)).size === SHAPES.length)
check('形状表里 mermaid 括号对无重复',
  new Set(SHAPES.map((s) => s.mermaid.join('|'))).size === SHAPES.length)

/* ================================================================== */
console.log('\n[3] 别名：用户不会记得 inv_trapezoid 这种名字')
/* ================================================================== */

for (const [alias, key] of [
  ['判断', 'diamond'], ['条件', 'diamond'], ['菱形', 'diamond'], ['decision', 'diamond'],
  ['数据库', 'cylinder'], ['db', 'cylinder'], ['cylinder', 'cylinder'],
  ['开始', 'rounded'], ['结束', 'rounded'], ['起止', 'rounded'], ['event', 'rounded'],
  ['输入', 'lean_right'], ['输出', 'lean_left'], ['in-out', 'lean_right'],
  ['子流程', 'subroutine'], ['subprocess', 'subroutine'], ['fr-rect', 'subroutine'],
  ['双圆', 'doublecircle'], ['double-circle', 'doublecircle'], ['dbl-circ', 'doublecircle'],
  ['方框', 'rect'], ['process', 'rect'], ['默认', 'rect'],
  ['优先', 'inv_trapezoid'], ['trap-t', 'inv_trapezoid'],
]) {
  check(`{${alias}} → ${key}`, parseOutline(`甲 {${alias}}`)[0]?.shape === key,
    String(parseOutline(`甲 {${alias}}`)[0]?.shape))
}

check('大小写不敏感：{DIAMOND} / {Diamond}',
  parseShapeName('DIAMOND') === 'diamond' && parseShapeName('Diamond') === 'diamond')
check('认不出返回 null', parseShapeName('随便') === null && parseShapeName('') === null)
check('未知 key 退化成方框（不抛错）', shapeOf('不存在').key === 'rect')
check('isShape 判据正确', isShape('diamond') && !isShape('菱形') && !isShape(''))
check('nextShape 循环一圈回到起点',
  (() => { let k = 'rect'; for (let i = 0; i < SHAPES.length; i++) k = nextShape(k); return k === 'rect' })())

/* ================================================================== */
console.log('\n[4] splitShapeMark / shapeMark 的边界')
/* ================================================================== */

check('没有标记：文本逐字节不变',
  splitShapeMark('普通文字') .text === '普通文字' && splitShapeMark('普通文字').shape === null)
check('认不出的标记：整行当正文',
  splitShapeMark('文字 {随便}').text === '文字 {随便}' && splitShapeMark('文字 {随便}').shape === null)
check('认得出的标记：摘掉并给出 key',
  splitShapeMark('文字 {判断}').text === '文字' && splitShapeMark('文字 {判断}').shape === 'diamond')
check('行尾空格不影响',
  splitShapeMark('文字 {判断}   ').text === '文字' && splitShapeMark('文字 {判断}   ').shape === 'diamond')
check('标记必须紧贴行尾（中间隔着字就不算）',
  splitShapeMark('文字 {判断} 后面还有字').shape === null)
check('空标记 {} 当正文', splitShapeMark('文字 {}').shape === null)
check('rect 不写标记（默认外形）', shapeMark('rect') === '')
check('非默认外形写中文名', shapeMark('diamond') === ' {菱形}', JSON.stringify(shapeMark('diamond')))
check('shapeMark → splitShapeMark 可逆（rect 不写标记，读回 null=默认）',
  SHAPES.every((s) => {
    const line = '文字' + shapeMark(s.key)
    const back = splitShapeMark(line)
    return back.text === '文字' && back.shape === (s.key === 'rect' ? null : s.key)
  }))

/* ================================================================== */
console.log('\n[5] readNodeShape：从 mermaid 括号对反推外形')
/* ================================================================== */

for (const s of SHAPES) {
  const code = `A${s.mermaid[0]}甲${s.mermaid[1]}`
  const r = readNodeShape(code, 'A')
  check(`读回 ${s.key}`, r?.key === s.key && r?.label === '甲', JSON.stringify(r))
}
// 长的开括号必须先匹配：双圆不能被认成圆、胶囊不能被认成圆角
check('★ 双圆不被认成圆', readNodeShape('A((("甲")))', 'A')?.key === 'doublecircle')
check('★ 胶囊不被认成圆角', readNodeShape('A(["甲"])', 'A')?.key === 'stadium')
check('★ 圆柱不被认成方框', readNodeShape('A[("甲")]', 'A')?.key === 'cylinder')
check('★ 六边形不被认成菱形', readNodeShape('A{{"甲"}}', 'A')?.key === 'hexagon')
check('★ 梯形 / 倒梯形 分得开',
  readNodeShape('A[/"甲"\\]', 'A')?.key === 'trapezoid' &&
  readNodeShape('A[\\"甲"/]', 'A')?.key === 'inv_trapezoid')
check('★ 右斜 / 左斜 分得开',
  readNodeShape('A[/"甲"/]', 'A')?.key === 'lean_right' &&
  readNodeShape('A[\\"甲"\\]', 'A')?.key === 'lean_left')
check('裸 id（没有定义）返回 null', readNodeShape('flowchart TD\n  A --> B', 'A') === null)
check('id 前缀相同的节点不混淆',
  readNodeShape('AB["甲"]', 'A') === null && readNodeShape('A{"乙"}', 'A')?.key === 'diamond')
check('&quot; 转义能还原成双引号',
  readNodeShape('A["x&quot;y"]', 'A')?.label === 'x"y',
  JSON.stringify(readNodeShape('A["x&quot;y"]', 'A')))
check('id 与括号之间有空格也认', readNodeShape('A   ["甲"]', 'A')?.key === 'rect')

/* ================================================================== */
console.log('\n[6] 正文里的括号不能影响解析（老 DEF 正则被重写过的重点回归）')
/* ================================================================== */

check('标签里的方括号不是新节点',
  parseOutline('甲["x"] -->|B| C["y"]'.replace(/"/g, '')).length >= 1)
check('mermaid: 标签里的花括号不当形状',
  mermaidToOutline('flowchart TD\n  A["看这个 {判断} 字样"]').includes('看这个 {判断} 字样'),
  JSON.stringify(mermaidToOutline('flowchart TD\n  A["看这个 {判断} 字样"]')))
check('mermaid: 空标签不退化成裸 id',
  mermaidToOutline('flowchart TD\n  A[""]') !== null &&
  mermaidToOutlineEx('flowchart TD\n  A[""]')?.outline === '',
  JSON.stringify(mermaidToOutlineEx('flowchart TD\n  A[""]')?.outline))
check('老式无引号 [x] 仍然解析成节点',
  eq(parseOutline('甲\n乙').map((n) => n.label), ['甲', '乙']))
check('mermaid: 无引号 [x] 仍能反推',
  mermaidToOutline('flowchart TD\n  A[x]').includes('x'),
  JSON.stringify(mermaidToOutline('flowchart TD\n  A[x]')))
check('mermaid: 无引号 (x) / {x} / ((x)) 仍能反推',
  ['(x)', '{x}', '((x))'].every((sh) => {
    const src = `flowchart TD\n  A${sh}`
    const id = sh.slice(0, sh.indexOf('x'))
    const back = mermaidToOutline(src)
    return back !== null && back.includes('x')
  }))

/* ================================================================== */
console.log('\n[7] shapeAtOutlineRow / setShapeInOutline（改形状的真实入口）')
/* ================================================================== */

const BASE = '甲\n  乙\n  丙 (-> 丁)\n  丁'
check('rect → 菱形',
  setShapeInOutline(BASE, 1, 'diamond') === '甲\n  乙 {菱形}\n  丙 (-> 丁)\n  丁',
  JSON.stringify(setShapeInOutline(BASE, 1, 'diamond')))
check('有引用的行：标记在引用之前',
  setShapeInOutline(BASE, 2, 'diamond') === '甲\n  乙\n  丙 {菱形} (-> 丁)\n  丁',
  JSON.stringify(setShapeInOutline(BASE, 2, 'diamond')))
check('菱形 → 方框：标记被摘掉',
  setShapeInOutline('甲\n  乙 {菱形}', 1, 'rect') === '甲\n  乙',
  JSON.stringify(setShapeInOutline('甲\n  乙 {菱形}', 1, 'rect')))
check('反复换形状不叠标记',
  setShapeInOutline(setShapeInOutline(BASE, 1, 'diamond'), 1, 'cylinder') ===
  '甲\n  乙 {圆柱}\n  丙 (-> 丁)\n  丁',
  JSON.stringify(setShapeInOutline(setShapeInOutline(BASE, 1, 'diamond'), 1, 'cylinder')))
check('深层缩进保住',
  setShapeInOutline('甲\n  乙\n    丙\n      丁', 3, 'circle') === '甲\n  乙\n    丙\n      丁 {圆形}',
  JSON.stringify(setShapeInOutline('甲\n  乙\n    丙\n      丁', 3, 'circle')))
check('★ Tab 缩进不被改成空格，列表符号不被吃掉',
  setShapeInOutline('- 甲\n\t- 乙', 1, 'diamond') === '- 甲\n\t- 乙 {菱形}',
  JSON.stringify(setShapeInOutline('- 甲\n\t- 乙', 1, 'diamond')))
check('有序列表 1. 也保住',
  setShapeInOutline('1. 甲\n2. 乙', 1, 'diamond') === '1. 甲\n2. 乙 {菱形}',
  JSON.stringify(setShapeInOutline('1. 甲\n2. 乙', 1, 'diamond')))
check('★ 只有引用的行不成节点，行号不错位',
  setShapeInOutline('甲\n  (-> 乙)\n  乙', 1, 'diamond') === '甲\n  (-> 乙)\n  乙 {菱形}',
  JSON.stringify(setShapeInOutline('甲\n  (-> 乙)\n  乙', 1, 'diamond')))
check('shapeAtOutlineRow 读得对',
  shapeAtOutlineRow('甲\n  乙 {菱形}\n  丙', 1) === 'diamond' &&
  shapeAtOutlineRow('甲\n  乙 {菱形}\n  丙', 2) === 'rect',
  JSON.stringify([shapeAtOutlineRow('甲\n  乙 {菱形}\n  丙', 1), shapeAtOutlineRow('甲\n  乙 {菱形}\n  丙', 2)]))
check('越界行号 → 原样返回',
  setShapeInOutline(BASE, 99, 'diamond') === BASE)
check('非法形状名 → 原样返回',
  setShapeInOutline(BASE, 1, '不存在的形状') === BASE)
check('★ 改形状不影响标签文字本身',
  parseOutline(setShapeInOutline(BASE, 1, 'diamond'))[1].label === '乙',
  JSON.stringify(parseOutline(setShapeInOutline(BASE, 1, 'diamond'))[1].label))
check('★ 改形状不改变引用边（图不变）',
  eq(mermaidToOutlineEx(outlineToMermaid(setShapeInOutline(BASE, 2, 'diamond')))?.stats,
    mermaidToOutlineEx(outlineToMermaid(BASE))?.stats),
  JSON.stringify([mermaidToOutlineEx(outlineToMermaid(BASE))?.stats,
    mermaidToOutlineEx(outlineToMermaid(setShapeInOutline(BASE, 2, 'diamond')))?.stats]))

/* ================================================================== */
console.log('\n[8] setShapeInCode（代码模式改形状，其余一个字不动）')
/* ================================================================== */

check('单独一行定义',
  setShapeInCode('flowchart TD\n  A["甲"]', 'A', 'diamond') === 'flowchart TD\n  A{"甲"}',
  JSON.stringify(setShapeInCode('flowchart TD\n  A["甲"]', 'A', 'diamond')))
check('连线里的定义也改得动，连线不动',
  setShapeInCode('flowchart TD\n  A --> B["乙"]', 'B', 'diamond') === 'flowchart TD\n  A --> B{"乙"}',
  JSON.stringify(setShapeInCode('flowchart TD\n  A --> B["乙"]', 'B', 'diamond')))
check('老式无引号 [x] 也认（规范化为带引号）',
  setShapeInCode('flowchart TD\n  A[甲]', 'A', 'diamond') === 'flowchart TD\n  A{"甲"}',
  JSON.stringify(setShapeInCode('flowchart TD\n  A[甲]', 'A', 'diamond')))
check('★ 双圆 → 圆：不残留多余括号',
  setShapeInCode('flowchart TD\n  A((("甲")))', 'A', 'circle') === 'flowchart TD\n  A(("甲"))',
  JSON.stringify(setShapeInCode('flowchart TD\n  A((("甲")))', 'A', 'circle')))
check('★ 13×13 两两互转全部自洽（含形状读回校验）',
  (() => {
    for (const from of SHAPES) for (const to of SHAPES) {
      const c1 = `flowchart TD\n  A${from.mermaid[0]}甲${from.mermaid[1]}`
      const c2 = setShapeInCode(c1, 'A', to.key)
      if (c2 !== `flowchart TD\n  A${to.mermaid[0]}甲${to.mermaid[1]}`) return false
      if (getNodeShapeInCode(c2, 'A') !== to.key) return false
    }
    return true
  })())
check('id 前缀相同不受牵连（A 与 AB）',
  setShapeInCode('flowchart TD\n  AB["甲"]\n  A["乙"]', 'A', 'diamond') ===
  'flowchart TD\n  AB["甲"]\n  A{"乙"}',
  JSON.stringify(setShapeInCode('flowchart TD\n  AB["甲"]\n  A["乙"]', 'A', 'diamond')))
check('标签里的特殊字符保住',
  setShapeInCode('flowchart TD\n  A["带 &quot; 引号 (括号)"]', 'A', 'diamond') ===
  'flowchart TD\n  A{"带 &quot; 引号 (括号)"}',
  JSON.stringify(setShapeInCode('flowchart TD\n  A["带 &quot; 引号 (括号)"]', 'A', 'diamond')))
check('没有该节点的定义 → null', setShapeInCode('flowchart TD\n  A --> B', 'B', 'diamond') === null)
check('非法形状名 → null', setShapeInCode('flowchart TD\n  A["甲"]', 'A', '乱写') === null)
check('getNodeShapeInCode 读得对',
  getNodeShapeInCode('flowchart TD\n  A[("甲")]', 'A') === 'cylinder' &&
  getNodeShapeInCode('flowchart TD\n  A --> B', 'A') === null)

/* ================================================================== */
console.log('\n[9] 形状 + 其它语法共存')
/* ================================================================== */

check('形状 + 引用 (-> )',
  (() => {
    const back = mermaidToOutline(outlineToMermaid('甲\n  乙 {判断} (-> 丙)\n  丙'))
    return back.includes('乙 {判断}') && back.includes('(-> 丙)')
  })(), JSON.stringify(mermaidToOutline(outlineToMermaid('甲\n  乙 {判断} (-> 丙)\n  丙'))))
check('形状 + 列表符号',
  outlineToMermaid('- 甲\n  - 乙 {判断}').includes('n1{"乙"}'),
  outlineToMermaid('- 甲\n  - 乙 {判断}'))
check('形状 + 方向',
  outlineToMermaid('甲 {判断}', 'LR').startsWith('flowchart LR') &&
  outlineToMermaid('甲 {判断}', 'LR').includes('n0{"甲"}'),
  outlineToMermaid('甲 {判断}', 'LR'))
check('形状 + 标签里的引号被转义',
  outlineToMermaid('甲 {判断}').includes('&quot;') === false)
check('带引号的标签在菱形里正确转义',
  outlineToMermaid('说 "重要" 的话 {判断}').includes('说 &quot;重要&quot; 的话'),
  outlineToMermaid('说 "重要" 的话 {判断}'))
check('★ 图语义往返不变（形状不改变节点/边数）',
  (() => {
    const o1 = '甲\n  乙\n  丙 {判断} (-> 丁)\n  丁'
    const o2 = mermaidToOutline(outlineToMermaid(o1))
    return eq(mermaidToOutlineEx(outlineToMermaid(o1))?.stats,
      mermaidToOutlineEx(outlineToMermaid(o2))?.stats)
  })())

/* ================================================================== */
console.log('\n[10] 形状表与 mermaid 真语法的一致性（写错括号会让整张图报错）')
/* ================================================================== */

// 这张表是从 mermaid 11.17.2 的解析器里核出来的，不是照文档抄的。
// 这里把「括号对必须成对出现在同一行、且能被自己的读取器认回」钉住 ——
// 真语法是否合法由浏览器端套件 shape.mjs 用真 mermaid 渲染验证。
check('每种外形的开/闭括号都非空',
  SHAPES.every((s) => s.mermaid[0].length > 0 && s.mermaid[1].length > 0))
check('★ 开括号长度 ≥ 2（单括号会被 mermaid 当成旧式写法）',
  SHAPES.every((s) => s.mermaid[0].length >= 2),
  JSON.stringify(SHAPES.filter((s) => s.mermaid[0].length < 2).map((s) => s.key)))
check('★ 闭合括号首字符必须是引号（标签一律用 " 包住）',
  SHAPES.every((s) => s.mermaid[1][0] === '"'),
  JSON.stringify(SHAPES.filter((s) => s.mermaid[1][0] !== '"').map((s) => s.key)))
check('★ 双圆的闭括号是 ")))（曾经少写一个 )，mermaid 直接报错）',
  shapeOf('doublecircle').mermaid[1] === '")))',
  JSON.stringify(shapeOf('doublecircle').mermaid))
check('★ 每种外形的括号对都能被 readNodeShape 原样认回',
  SHAPES.every((s) => readNodeShape(`A${s.mermaid[0]}x${s.mermaid[1]}`, 'A')?.key === s.key),
  JSON.stringify(SHAPES.filter((s) => readNodeShape(`A${s.mermaid[0]}x${s.mermaid[1]}`, 'A')?.key !== s.key)
    .map((s) => s.key)))

/* ================================================================== */
console.log(`\n${'='.repeat(46)}`)
console.log(`  节点外形  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)
