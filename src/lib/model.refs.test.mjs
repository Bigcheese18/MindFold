/**
 * 双轨制 / 括号引用语法 测试
 * ==========================
 * 覆盖 PRD 新增诉求：
 *   1. (-> 目标) 引用语法：解析、编译成 mermaid 边、去掉标记后显示纯文字
 *   2. 多对一：两个节点引用同一个目标 → 右侧汇聚
 *   3. 往返不丢边：mermaid → 缩进列表 → mermaid 的边必须完全一致
 *      （这是「双轨制切换数据不丢失」的核心保障）
 *   4. 环、自环、重名节点、全角括号、Unicode 箭头等边界
 *   5. 复杂度评估：什么时候该建议用户切到代码模式
 *
 * 【为什么按「标签」而不是按 id 比对】
 * 往返时 id 一定会被重新编号（A/B/C → n0/n1/n2），拿 id 比对等于自欺欺人。
 * 所以这里把边表示成 `源标签 → 目标标签`，并**保留重复项**（用排序数组当多重集）——
 * 重名节点那种「两条边指向同名节点」的情况，只有多重集才能如实反映。
 *
 * 另外这个文件里的 mermaid 解析是**测试自己实现的**，不复用 src/lib/model.js：
 * 用被测代码去验证被测代码是循环论证。
 */
import {
  outlineToMermaid, parseOutline, mermaidToOutline, mermaidToOutlineEx,
  stripRefs, scanRefs, formatRef,
} from './model.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}

/* ---------------- 测试自带的极简 mermaid 解析 ---------------- */

const ID_SRC = '[A-Za-z0-9_\\u4e00-\\u9fa5][\\w\\-\\u4e00-\\u9fa5]*'

/**
 * 把 mermaid 源码解析成「标签多重集」：排序后的 `源标签\u0000目标标签` 数组。
 * 不依赖 src/lib，独立实现。
 */
function labelEdges(src) {
  const labels = new Map()
  const edges = []

  for (const raw of String(src).split('\n')) {
    let line = raw.trim()
    if (!line || /^(flowchart|graph)\b/i.test(line) || line.startsWith('%%')) continue

    // 1. 收集节点定义 id["标签"]
    const defRe = new RegExp(`(${ID_SRC})\\s*\\[\\s*"([^"]*)"\\s*\\]`, 'g')
    for (const m of line.matchAll(defRe)) labels.set(m[1], m[2])
    // 把定义段缩成裸 id，这样后面按顺序扫 id/箭头能覆盖整行
    line = line.replace(new RegExp(`(${ID_SRC})\\s*\\[\\s*"[^"]*"\\s*\\]`, 'g'), '$1')
    // 边标签不是节点
    line = line.replace(/\|[^|]*\|/g, ' ')

    // 2. 按出现顺序取出所有 id 与箭头，再配对
    //    这样 A --> B --> C 里的 B --> C 不会被漏掉
    const toks = [...line.matchAll(new RegExp(`${ID_SRC}|-->`, 'g'))].map((m) => m[0])
    for (let i = 0; i + 2 < toks.length; i++) {
      if (toks[i] !== '-->' && toks[i + 1] === '-->' && toks[i + 2] !== '-->') {
        edges.push([toks[i], toks[i + 2]])
      }
    }
  }

  const name = (id) => labels.get(id) ?? id
  return edges.map(([a, b]) => `${name(a)}\u0000${name(b)}`).sort()
}

const sameEdges = (a, b) => {
  const A = labelEdges(a), B = labelEdges(b)
  return A.length === B.length && A.every((x, i) => x === B[i])
}

const edgeDiff = (a, b) => {
  const A = labelEdges(a), B = labelEdges(b)
  const missing = A.filter((x) => !B.includes(x))
  const extra = B.filter((x) => !A.includes(x))
  return { missing, extra }
}

/** 往返一次：mermaid → 缩进列表 → mermaid */
const roundTrip = (src) => {
  const ex = mermaidToOutlineEx(src)
  if (!ex) return { ex: null }
  return { ex, outline: ex.outline, back: outlineToMermaid(ex.outline) }
}

/** 断言往返后边完全一致（失败时打印缺了哪些、多了哪些） */
const checkRoundTrip = (name, src) => {
  const r = roundTrip(src)
  if (!r.ex) { check(name, false, '反推缩进列表失败'); return r }
  const d = edgeDiff(src, r.back)
  check(name, d.missing.length === 0 && d.extra.length === 0,
    `丢失 ${JSON.stringify(d.missing)} 多出 ${JSON.stringify(d.extra)}\n    缩进列表:\n${r.outline.split('\n').map((l) => '      ' + l).join('\n')}`)
  return r
}

/* ================================================================== */
console.log('\n[1] 引用语法解析')
/* ================================================================== */

const r1 = scanRefs('服务端未收到 ACK (-> 断开连接)')
check('识别 ASCII 括号引用', r1.refs.length === 1 && r1.refs[0].target === '断开连接',
  JSON.stringify(r1.refs))

const r2 = scanRefs('客户端主动关闭（-> 断开连接）')
check('识别全角括号引用（中文输入法常见）',
  r2.refs.length === 1 && r2.refs[0].target === '断开连接', JSON.stringify(r2.refs))

const r3 = scanRefs('超时 (→ 重传)')
check('识别 Unicode 箭头 →', r3.refs.length === 1 && r3.refs[0].target === '重传',
  JSON.stringify(r3.refs))

const r4 = scanRefs('A (-> B) (-> C)')
check('一行可以挂多个引用', r4.refs.length === 2, JSON.stringify(r4.refs))

const r5 = scanRefs('处理(特殊)情况')
check('普通括号不会被误判成引用', r5.refs.length === 0, JSON.stringify(r5.refs))

const r6 = scanRefs('状态码 (200) 与 (-> 成功)')
check('普通括号与引用混在一行时只认引用',
  r6.refs.length === 1 && r6.refs[0].target === '成功', JSON.stringify(r6.refs))

const r7 = scanRefs('结束 (-> 结束#2)')
check('支持 #n 指定同名节点的第 n 个',
  r7.refs.length === 1 && r7.refs[0].target === '结束' && r7.refs[0].occurrence === 2,
  JSON.stringify(r7.refs))

const r8 = scanRefs('括号 (-> "带)括号的目标")')
check('引号包住的目标名里可以含右括号',
  r8.refs.length === 1 && r8.refs[0].target === '带)括号的目标', JSON.stringify(r8.refs))

check('stripRefs 去掉引用只留文字',
  stripRefs('服务端未收到 ACK (-> 断开连接)') === '服务端未收到 ACK',
  stripRefs('服务端未收到 ACK (-> 断开连接)'))

check('stripRefs 保留普通括号',
  stripRefs('处理(特殊)情况') === '处理(特殊)情况',
  stripRefs('处理(特殊)情况'))

check('formatRef 对普通名字不加引号', formatRef({ target: '断开连接', occurrence: 1 }) === '(-> 断开连接)',
  formatRef({ target: '断开连接', occurrence: 1 }))

check('formatRef 对含括号的名字加引号',
  formatRef({ target: 'a)b', occurrence: 1 }) === '(-> "a)b")',
  formatRef({ target: 'a)b', occurrence: 1 }))

check('formatRef 带重名序号', formatRef({ target: '结束', occurrence: 2 }) === '(-> 结束#2)',
  formatRef({ target: '结束', occurrence: 2 }))

/* ================================================================== */
console.log('\n[2] 引用 → mermaid 边（多对一汇聚）')
/* ================================================================== */

const OUTLINE = [
  'TCP 三次握手',
  '  服务端未收到 ACK (-> 断开连接)',
  '  客户端主动关闭 (-> 断开连接)',
  '  断开连接',
].join('\n')

const parsed = parseOutline(OUTLINE)
check('parseOutline 剥掉引用标记，label 是纯文字',
  parsed[1].label === '服务端未收到 ACK' && parsed[2].label === '客户端主动关闭',
  JSON.stringify(parsed.map((n) => n.label)))
check('parseOutline 保留原始行文字 rawLabel',
  parsed[1].rawLabel === '服务端未收到 ACK (-> 断开连接)', parsed[1].rawLabel)
check('引用解析到正确的目标 id（前向引用也能解析）',
  parsed[1].refs[0].targetId === parsed[3].id && parsed[1].refs[0].resolved,
  JSON.stringify(parsed[1].refs))
check('引用的节点文字里不含 -> 标记',
  !parsed[1].label.includes('->'), parsed[1].label)

const mmd = outlineToMermaid(OUTLINE)
const es = labelEdges(mmd)
check('两个节点指向同一个目标 → 两条独立边',
  es.includes(`服务端未收到 ACK\u0000断开连接`) && es.includes(`客户端主动关闭\u0000断开连接`),
  es.join(' | '))
check('树上原有的父子边仍然保留', es.includes(`TCP 三次握手\u0000服务端未收到 ACK`), es.join(' | '))
check('节点定义行里没有残留引用标记', !mmd.includes('(->'), mmd)

const orphan = parseOutline('A (-> 不存在)\nB')
check('引用不存在的目标 → resolved=false（不静默当成功）',
  orphan[0].refs[0].resolved === false && orphan[0].refs[0].targetId === null,
  JSON.stringify(orphan[0].refs))

/* ================================================================== */
console.log('\n[3] 往返不丢边（双轨制切换的核心保障）')
/* ================================================================== */

// --- 多对一 ---
const MP = [
  'flowchart TD',
  '  A["开始"]', '  B["服务端"]', '  C["客户端"]', '  D["断开连接"]',
  '  A --> B', '  A --> C', '  B --> D', '  C --> D',
].join('\n')
const mp = checkRoundTrip('多对一：往返后边完全一致', MP)
check('多对一：额外边被写成 (-> ...) 引用',
  !!mp.outline && mp.outline.includes('(-> 断开连接)'), String(mp.outline))
check('多对一：目标节点只占一行（没有被压平成两个节点）',
  parseOutline(mp.outline).filter((n) => n.label === '断开连接').length === 1,
  String(mp.outline))
check('多对一：所有节点都在（4 个）',
  parseOutline(mp.outline).length === 4, String(parseOutline(mp.outline).length))

// --- 交叉连线 ---
checkRoundTrip('交叉连线：往返后边完全一致', [
  'flowchart LR',
  '  A["A"]', '  B["B"]', '  C["C"]', '  D["D"]',
  '  A --> B', '  A --> C', '  B --> D', '  C --> D', '  A --> D',
].join('\n'))

// --- 环 ---
const CYCLE = ['flowchart TD', '  A["重传"]', '  B["等待 ACK"]', '  A --> B', '  B --> A'].join('\n')
const cy = checkRoundTrip('环：往返后边完全一致', CYCLE)
check('环：被判定为需要建议代码模式', cy.ex?.suggestCodeMode === true,
  JSON.stringify(cy.ex?.stats))

// --- 自环 ---
checkRoundTrip('自环：往返后边完全一致',
  ['flowchart TD', '  A["重试"]', '  A --> A'].join('\n'))

// --- 三节点环 ---
checkRoundTrip('三节点环：往返后边完全一致', [
  'flowchart TD', '  A["甲"]', '  B["乙"]', '  C["丙"]',
  '  A --> B', '  B --> C', '  C --> A',
].join('\n'))

// --- 链式（历史 bug：会丢 B-->C 的边）---
checkRoundTrip('链式 A-->B-->C 往返不丢边',
  ['flowchart TD', '  A["一"]', '  B["二"]', '  C["三"]', '  A --> B --> C'].join('\n'))

// --- 纯树 ---
const TREE = [
  'flowchart TD',
  '  A["根"]', '  B["左"]', '  C["右"]', '  D["左一"]',
  '  A --> B', '  A --> C', '  B --> D',
].join('\n')
const tr = checkRoundTrip('纯树：往返后边完全一致', TREE)
check('纯树：不产生任何引用', !!tr.outline && !tr.outline.includes('(->'), String(tr.outline))
check('纯树：不建议切代码模式', tr.ex?.suggestCodeMode === false,
  JSON.stringify(tr.ex?.stats))

// --- 重名节点（必须靠 #序号 消歧义）---
const DUP = [
  'flowchart TD',
  '  A["开始"]', '  B["结束"]', '  C["中间"]', '  D["结束"]',
  '  A --> B', '  A --> C', '  C --> D', '  C --> B',
].join('\n')
const dp = checkRoundTrip('重名节点：往返后边完全一致（多重集比对）', DUP)
check('重名节点：指向第 1 个同名节点时不写 #序号（更干净）',
  !!dp.outline && dp.outline.includes('(-> 结束)') && !dp.outline.includes('结束#1'),
  String(dp.outline))
check('重名节点：会给出重名警告',
  !!dp.ex && dp.ex.warnings.some((w) => w.includes('重名')), JSON.stringify(dp.ex?.warnings))
check('重名节点：建议切代码模式', dp.ex?.suggestCodeMode === true, JSON.stringify(dp.ex?.stats))

// 指向**第 2 个**同名节点时必须写 #2，否则会指错人
const DUP2 = [
  'flowchart TD',
  '  A["开始"]', '  B["结束"]', '  C["中间"]', '  D["结束"]',
  '  A --> B', '  A --> C', '  A --> D', '  C --> D',
].join('\n')
const dp2 = checkRoundTrip('重名节点：指向第 2 个同名节点也往返一致', DUP2)
check('重名节点：指向第 2 个时写 #2 消歧义',
  !!dp2.outline && dp2.outline.includes('(-> 结束#2)'), String(dp2.outline))

// --- 带标签的边 ---
checkRoundTrip('带 |标签| 的边：边标签不会被当成节点', [
  'flowchart TD',
  '  A["开始"]', '  B["成功"]', '  C["失败"]',
  '  A -->|成功| B', '  A -->|失败| C',
].join('\n'))

// --- 中文 id ---
checkRoundTrip('中文 id：往返后边完全一致',
  ['flowchart TD', '  开始["开始"]', '  结束["结束"]', '  开始 --> 结束'].join('\n'))

// --- 连字符 id（历史 bug：会被切成两个节点）---
checkRoundTrip('连字符 id 不会被切断成两个节点',
  ['flowchart TD', '  node-1["一"]', '  node-2["二"]', '  node-1 --> node-2'].join('\n'))

// --- 多根森林 ---
const FOREST = [
  'flowchart TD',
  '  A["甲根"]', '  B["乙根"]', '  C["甲子"]', '  D["乙子"]',
  '  A --> C', '  B --> D',
].join('\n')
const fo = checkRoundTrip('多根森林：往返后边完全一致', FOREST)
check('多根森林：识别出 2 个根', fo.ex?.stats.roots === 2, JSON.stringify(fo.ex?.stats))

// --- 菱形（分叉再汇聚）---
checkRoundTrip('菱形分叉汇聚：往返后边完全一致', [
  'flowchart TD',
  '  A["判断"]', '  B["是"]', '  C["否"]', '  D["结束"]',
  '  A --> B', '  A --> C', '  B --> D', '  C --> D',
].join('\n'))

/* ================================================================== */
console.log('\n[4] 缩进列表 → mermaid → 缩进列表')
/* ================================================================== */

/*
 * 注意：这里断言的是**边一致**，不是文本一致。
 * 反推出来的缩进列表是「生成树 + 引用」的规范形式，层级可能被重排
 * （例如原本写成根节点的 D，如果它是某条树的第一个目标，就会被收进子树）。
 * 图是等价的，但文本会规范化 —— 所以真实交互里切换模式时**不重新编译**，
 * 只在用户实际编辑了某一侧时才派生另一侧（见 FoldModal 的 syncFrom 逻辑）。
 */
const IDEM = 'A\n  B (-> D)\n  C (-> D)\nD'
const IDEM_BACK = outlineToMermaid(IDEM)
const IDEM_OUT = mermaidToOutline(IDEM_BACK)
check('缩进列表往返后边完全一致', sameEdges(IDEM_BACK, outlineToMermaid(IDEM_OUT)),
  `差异 ${JSON.stringify(edgeDiff(IDEM_BACK, outlineToMermaid(IDEM_OUT)))}`)
check('缩进列表往返后节点数不变',
  parseOutline(IDEM).length === parseOutline(IDEM_OUT).length,
  `${parseOutline(IDEM).length} vs ${parseOutline(IDEM_OUT).length}`)
check('缩进列表往返后引用仍然是引用（没变成树边）',
  IDEM_OUT.includes('(-> D)'), JSON.stringify(IDEM_OUT))

/* ================================================================== */
console.log('\n[5] 复杂度评估 → 建议代码模式')
/* ================================================================== */

const dense = [
  'flowchart TD',
  '  A["A"]', '  B["B"]', '  C["C"]', '  D["D"]', '  E["E"]',
  '  A --> B', '  A --> C', '  A --> D', '  A --> E',
  '  B --> E', '  C --> E', '  D --> E',
].join('\n')
const dn = mermaidToOutlineEx(dense)
check('高度交叉 → 建议代码模式', dn?.suggestCodeMode === true, JSON.stringify(dn?.stats))

const simple = mermaidToOutlineEx(TREE)
check('普通树 → 不建议代码模式', simple?.suggestCodeMode === false,
  JSON.stringify(simple?.stats))

check('不可解析的源码返回 null', mermaidToOutlineEx('这不是流程图') === null)
check('空的 mermaid 返回 null', mermaidToOutlineEx('') === null)
check('没有节点定义的流程图返回 null',
  mermaidToOutlineEx('flowchart TD\n  %% 只有注释') === null)

/* ================================================================== */
console.log('\n[6] 与折角解析的兼容')
/* ================================================================== */

check('含引用的缩进列表不影响 childCount',
  (() => {
    const ns = parseOutline('A\n  B (-> A)\n  C')
    return ns[0].childCount === 2 && ns[0].hasChildren === true
  })())

check('只写引用没有文字的行被跳过（不会生成空节点）',
  parseOutline('A\n  (-> A)\nB').length === 2,
  JSON.stringify(parseOutline('A\n  (-> A)\nB').map((n) => n.label)))

check('引用目标是自己时也能解析（自环）',
  (() => {
    const ns = parseOutline('重试 (-> 重试)')
    return ns[0].refs[0].targetId === ns[0].id
  })())

/* ================================================================== */
console.log(`\n${'='.repeat(46)}`)
console.log(`  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)
