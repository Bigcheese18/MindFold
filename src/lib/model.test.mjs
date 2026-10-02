/**
 * 核心逻辑自检 —— 不依赖浏览器，直接跑解析/编译/布局。
 * 用法：node src/lib/model.test.mjs
 */
import {
  parseMarkdown, outlineToMermaid, mermaidToOutline, collectFolds, toMarkdown,
} from './model.js'
import {
  layoutTree as layoutTreeSafe, edgePath as edgePathSafe,
  fitView as fitViewSafe, boundsOf as boundsOfSafe,
} from './layout.js'
import { SAMPLE_MD } from './sample.js'

let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}

/* ---------------- 1. Markdown 解析 ---------------- */
console.log('\n[1] Markdown 解析：硬编码 [F] 识别')

const MD = `# 计算机网络

## 传输层

- TCP 三次握手 [F]
  - 第一次握手
  - 第二次握手

  \`\`\`mermaid
  flowchart TD
    A["客户端"] --> B["服务端"]
  \`\`\`

- 没有折角的普通节点
- 只有标记没有代码 [F]
- 这张图应该被忽略 ![截图](./a.png)
- 末尾用双括号的写法 [[折角]]
`

const { root, foldCount, total } = parseMarkdown(MD, '测试')
check('节点总数正确', total === 9, `得到 ${total}`)
check('折角数 = 3（[F] x2 + [[折角]] x1）', foldCount === 3, `得到 ${foldCount}`)

const folds = collectFolds(root)
const tcp = folds.find((f) => f.node.text === 'TCP 三次握手')
check('折角文字已剥离 [F] 标记', !!tcp, folds.map((f) => f.node.text).join(' | '))
check('mermaid 代码块绑定到折角', !!tcp?.node.fold.mermaid && tcp.node.fold.corner === true)
check('mermaid 内容正确', tcp?.node.fold.mermaid?.includes('A["客户端"] --> B["服务端"]'))

const hollow = folds.find((f) => f.node.text === '只有标记没有代码')
check('只有 [F] 无代码 → 空心折角', hollow && hollow.node.fold.corner === false)

const dbl = folds.find((f) => f.node.text === '末尾用双括号的写法')
check('[[折角]] 语法同样识别', !!dbl)

const img = []
const walk = (n) => { if (n.text.includes('png') || n.text.includes('![')) img.push(n.text); n.children.forEach(walk) }
walk(root)
check('图片被彻底忽略', img.length === 0, img.join(' | '))

/* ---------------- 2. 缩进列表 → Mermaid ---------------- */
console.log('\n[2] 傻瓜模式：缩进列表 → Mermaid')

const outline = `三次握手
  第一次握手
    SYN=1
  第二次握手
    SYN+ACK`
const mmd = outlineToMermaid(outline, 'TD')
check('首行声明 flowchart TD', mmd.startsWith('flowchart TD'), mmd.split('\n')[0])
check('生成 5 个节点', (mmd.match(/n\d+\["/g) || []).length === 5)
check('生成 4 条边', (mmd.match(/-->/g) || []).length === 4)
check('CHILD 挂在正确父节点下', mmd.includes('n0 --> n1') && mmd.includes('n1 --> n2') && mmd.includes('n0 --> n3'))
check('中文标签用双引号包裹', mmd.includes('n0["三次握手"]'))

const lr = outlineToMermaid(outline, 'LR')
check('方向可切换', lr.startsWith('flowchart LR'))

/* ---------------- 3. Mermaid → 缩进列表（往返） ---------------- */
console.log('\n[3] 反向解析（手写代码 → 缩进列表）')

const back = mermaidToOutline(mmd)
check('能从 mermaid 反推缩进列表', !!back)
check('往返后层级一致', back === outline, JSON.stringify(back))

const back2 = mermaidToOutline('flowchart LR\n  A["根"] --> B["子"]\n  A --> C["子2"]')
check('解析 LR 方向', back2 === '根\n  子\n  子2', JSON.stringify(back2))

// 同一行里既有节点定义又有连线（最容易写错的一类）
const back3 = mermaidToOutline('flowchart TD\n  A["开始"] --> B["结束"]')
check('同一行的定义+连线不会串味', back3 === '开始\n  结束', JSON.stringify(back3))

check('非 flowchart 内容返回 null', mermaidToOutline('这不是图') === null)

/* --- 回归：链式连线不能丢边（会造出孤立节点） --- */
console.log('\n[3b] 反向解析的坑（都会造出「孤立节点」）')

/** 从生成的 mermaid 里解出边与节点，检查连通性 */
function graphOf(src) {
  const ids = [...src.matchAll(/^\s*(n\d+)\["/gm)].map((m) => m[1])
  const edges = [...src.matchAll(/(n\d+) --> (n\d+)/g)].map((m) => [m[1], m[2]])
  const hasIn = new Set(edges.map((e) => e[1]))
  const hasOut = new Set(edges.map((e) => e[0]))
  return {
    ids, edges,
    roots: ids.filter((id) => !hasIn.has(id)),
    isolated: ids.filter((id) => !hasIn.has(id) && !hasOut.has(id)),
  }
}

const chain = mermaidToOutline('flowchart TD\n  A["甲"] --> B["乙"] --> C["丙"]')
check('一行链式 A-->B-->C 保留两级父子', chain === '甲\n  乙\n    丙', JSON.stringify(chain))
check('链式重编译后只有 1 个根、无孤立节点', (() => {
  const g = graphOf(outlineToMermaid(chain, 'TD'))
  return g.roots.length === 1 && g.isolated.length === 0
})(), JSON.stringify(graphOf(outlineToMermaid(chain, 'TD'))))

const dashed = mermaidToOutline('flowchart TD\n  node-1["甲"] --> node-2["乙"]')
check('带横线的 id 不被切断', dashed === '甲\n  乙', JSON.stringify(dashed))

const diamond = mermaidToOutline('flowchart TD\n  A{条件?} --> B["是"]')
check('菱形 {标签} 不丢标签', diamond === '条件?\n  是', JSON.stringify(diamond))

const cjk = mermaidToOutline('flowchart TD\n  开始["根"] --> 结束["末"]')
check('中文 id 可解析', cjk === '根\n  末', JSON.stringify(cjk))

const edgeLabel = mermaidToOutline('flowchart TD\n  A["甲"] -->|说明| B["乙"]')
check('边标签不会被当成节点', edgeLabel === '甲\n  乙', JSON.stringify(edgeLabel))

const branch = mermaidToOutline('flowchart TD\n  A["根"] --> B["左"]\n  A --> C["右"]\n  B --> D["左1"]')
check('多分支往返层级正确', branch === '根\n  左\n    左1\n  右', JSON.stringify(branch))

/* --- 结构不变量：任何缩进列表编译出来都必须是「一棵连通树」 --- */
console.log('\n[3c] outlineToMermaid 的结构不变量')

const outlineCases = {
  '正常两级': '根\n  甲\n  乙',
  '第一行就缩进': '  甲\n    乙',
  '缩进跳级': '根\n    甲',
  '制表符': '根\n\t甲\n\t\t乙',
  '奇数空格': '根\n   甲\n  乙',
  '列表符号': '- 根\n  - 甲\n    - 乙',
  '空行穿插': '根\n\n  甲\n\n  乙',
  '回到更浅层': '根\n  甲\n    甲1\n  乙',
  '中文括号引号': '根\n  数组 [1,2,3]\n  含"引号"的',
  '多层深缩进': '根\n  甲\n    甲1\n      甲11\n  乙',
}
for (const [name, outline] of Object.entries(outlineCases)) {
  const g = graphOf(outlineToMermaid(outline, 'TD'))
  const ok = g.roots.length === 1 && g.isolated.length === 0
  check(`${name}：1 个根、0 孤立`, ok,
    ok ? '' : `roots=${g.roots.length} isolated=${g.isolated.length}`)
}

/* --- 往返不变量：mermaid → outline → mermaid 边集不变 --- */
console.log('\n[3d] 往返后边集不变')
const roundTrips = [
  ['直线链', 'flowchart TD\n  A["a"] --> B["b"]\n  B --> C["c"]'],
  ['一个根两个分支', 'flowchart TD\n  A["a"] --> B["b"]\n  A --> C["c"]'],
  ['同一行写完整链', 'flowchart TD\n  A["a"] --> B["b"] --> C["c"] --> D["d"]'],
  ['深层嵌套', 'flowchart TD\n  A["a"] --> B["b"]\n  B --> C["c"]\n  C --> D["d"]'],
]
for (const [name, src] of roundTrips) {
  const outline = mermaidToOutline(src)
  const back = outlineToMermaid(outline, 'TD')
  const edgesOf = (s) => [...s.matchAll(/(\w+) --> (\w+)/g)].map((m) => m[1] + '>' + m[2]).sort().join(',')
  // 重编译用的是 n0/n1… 编号，只比较「边的条数 + 拓扑形状」
  const count = (s) => (s.match(/-->/g) || []).length
  const g1 = graphOf(back)
  check(`${name}：边数保持 ${count(src)}`, count(back) === count(src), `${count(src)} → ${count(back)}`)
  check(`${name}：仍是单根连通树`, g1.roots.length === 1 && g1.isolated.length === 0,
    JSON.stringify({ roots: g1.roots.length, isolated: g1.isolated.length }))
}

/* ---------------- 4. 布局 ---------------- */
console.log('\n[4] 布局引擎')

const L = `- 甲
  - 甲1
  - 甲2
- 乙
  - 乙1`
// 注意：parseMarkdown 会用 docName 造一个合成根节点包住整棵树，
// 所以下面统一从 root.children 起步，不要拿 root 当业务节点。
const { root: lroot } = parseMarkdown(L, '根')
const jia = lroot.children[0]
const lay = layoutTreeSafe(lroot)
check('布局产出 6 个节点（合成根 + 5 个内容节点）', lay.nodes.length === 6, `得到 ${lay.nodes.length}`)
check('根在最左（x 最小）', lay.byId.get(lroot.id).x === Math.min(...lay.nodes.map((n) => n.x)))
check('子节点 x 大于父节点 x', lay.byId.get(jia.id).x > lay.byId.get(lroot.id).x)

/* --- 布局方向：必须是横向树，而不是纵向堆叠 --- */
const b = boundsOfSafe(lay.nodes)
check('整体是横向的（宽 > 高）', b.width > b.height,
  `宽 ${Math.round(b.width)} × 高 ${Math.round(b.height)}`)
check('所有子节点都在父节点右侧',
  lay.nodes.filter((n) => n.parentId).every((n) => n.x > lay.byId.get(n.parentId).x))
check('同层节点垂直不重叠', (() => {
  const byDepth = {}
  for (const n of lay.nodes) (byDepth[n.depth] ||= []).push(n)
  return Object.values(byDepth).every((arr) => {
    arr.sort((a, b2) => a.y - b2.y)
    return arr.every((n, i) => i === 0 || n.y >= arr[i - 1].y + arr[i - 1].h)
  })
})())

/**
 * 父节点必须垂直居中于自己子树的跨度内。
 * 这是之前真实踩过的坑：在递归**之后**读 cursorY，父节点会被摆到子节点下方，
 * 整棵树看起来就是一根向下延伸的竖条。
 */
const notCentered = lay.nodes.filter((n) => {
  const kids = lay.nodes.filter((k) => k.parentId === n.id)
  if (!kids.length) return false
  const top = Math.min(...kids.map((k) => k.y + k.h / 2))
  const bottom = Math.max(...kids.map((k) => k.y + k.h / 2))
  const cy = n.y + n.h / 2
  return cy < top - 0.5 || cy > bottom + 0.5
})
check('父节点垂直居中于子节点跨度（无向下堆叠）', notCentered.length === 0,
  notCentered.map((n) => n.node.text).join(', '))

check('根节点在垂直方向的中间位置', (() => {
  const rootCy = lay.byId.get(lroot.id).y + lay.byId.get(lroot.id).h / 2
  const top = Math.min(...lay.nodes.map((n) => n.y + n.h / 2))
  const bottom = Math.max(...lay.nodes.map((n) => n.y + n.h / 2))
  return Math.abs(rootCy - (top + bottom) / 2) < 1
})())

/* --- fitView：居中 + 20% 留白 --- */
console.log('\n[4b] fitView 自动适配')
const FV = fitViewSafe(lay.nodes, 1200, 800)
check('fitView 返回有限的 x/y/zoom',
  Number.isFinite(FV.x) && Number.isFinite(FV.y) && Number.isFinite(FV.zoom), JSON.stringify(FV))

// 变换后内容包围盒应正好居中
const cx = (b.minX + b.width / 2) * FV.zoom + FV.x
const cy2 = (b.minY + b.height / 2) * FV.zoom + FV.y
check('内容中心对齐视口中心（小图）', Math.abs(cx - 600) < 1 && Math.abs(cy2 - 400) < 1,
  `中心=(${cx.toFixed(1)}, ${cy2.toFixed(1)}) 期望=(600, 400)`)
check('小图不会放得过大（zoom 有上限）', FV.zoom <= 1.3, `zoom=${FV.zoom.toFixed(3)}`)

// 用真实规模的文档验证「刚好铺满 + 留白 20%」。
// 小图会因为 zoom 上限而填不满，所以这条必须用足够大的树来测。
const { root: bigRoot } = parseMarkdown(SAMPLE_MD, '计算机网络')
const bigLay = layoutTreeSafe(bigRoot)
const bigB = boundsOfSafe(bigLay.nodes)
const vw = 1440
const vh = 900
const BF = fitViewSafe(bigLay.nodes, vw, vh)

const bLeft = bigB.minX * BF.zoom + BF.x
const bRight = bigB.maxX * BF.zoom + BF.x
const bTop = bigB.minY * BF.zoom + BF.y
const bBot = bigB.maxY * BF.zoom + BF.y

check('大图内容完整落在视口内', bLeft >= -0.5 && bTop >= -0.5 && bRight <= vw + 0.5 && bBot <= vh + 0.5,
  `[${bLeft.toFixed(0)}, ${bTop.toFixed(0)}] → [${bRight.toFixed(0)}, ${bBot.toFixed(0)}]`)
check('大图居中', Math.abs((bLeft + bRight) / 2 - vw / 2) < 1 && Math.abs((bTop + bBot) / 2 - vh / 2) < 1,
  `中心=(${((bLeft + bRight) / 2).toFixed(1)}, ${((bTop + bBot) / 2).toFixed(1)})`)

const fillW = (bRight - bLeft) / vw
const fillH = (bBot - bTop) / vh
check('受限的那一边正好用满 80%（四周合计留白 20%）',
  Math.abs(Math.max(fillW, fillH) - 0.8) < 0.02,
  `横向 ${(fillW * 100).toFixed(1)}%，纵向 ${(fillH * 100).toFixed(1)}%`)

check('空节点数组不会崩', (() => {
  const r = fitViewSafe([], 800, 600)
  return Number.isFinite(r.zoom) && r.zoom === 1
})())
check('视口尺寸为 0 时不会产生 NaN', (() => {
  const r = fitViewSafe(bigLay.nodes, 0, 0)
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.zoom)
})())

/* --- fitView 在手机窄屏下的缩放下限 --- */
console.log('\n[4b-2] 手机窄屏的缩放下限')
// 同一张图放进 375px 宽的视口：默认下限会缩到 0.2 左右，角标热区只剩 9px。
const phoneFitDefault = fitViewSafe(bigLay.nodes, 375, 667)
check('窄屏默认下限确实会缩得很小（说明下限是必要的）',
  phoneFitDefault.zoom < 0.3,
  `zoom=${phoneFitDefault.zoom.toFixed(3)}`)

const phoneFit = fitViewSafe(bigLay.nodes, 375, 667, undefined, { minZoom: 0.75 })
check('传入 minZoom 后不会低于该值',
  phoneFit.zoom >= 0.75,
  `zoom=${phoneFit.zoom.toFixed(3)}`)

// 折角角标热区 24px，缩放后必须仍可点击
const HIT = 24
check('窄屏下折角角标热区仍 ≥18px（可点击）',
  HIT * phoneFit.zoom >= 18,
  `${(HIT * phoneFit.zoom).toFixed(1)}px`)

check('窄屏下仍保持居中',
  (() => {
    const l = bigB.minX * phoneFit.zoom + phoneFit.x
    const r2 = bigB.maxX * phoneFit.zoom + phoneFit.x
    return Math.abs((l + r2) / 2 - 375 / 2) < 1
  })())

check('minZoom 不会把上限顶破（仍受 1.3 约束）',
  fitViewSafe(lay.nodes, 1200, 800, undefined, { minZoom: 5 }).zoom <= 1.3,
  `zoom=${fitViewSafe(lay.nodes, 1200, 800, undefined, { minZoom: 5 }).zoom.toFixed(3)}`)

/* --- 贝塞尔曲线 --- */
console.log('\n[4c] 连接线是平滑贝塞尔曲线')
const e0 = lay.edges.find((e) => lay.byId.get(e.from) && lay.byId.get(e.to))
const p = edgePathSafe(lay.byId.get(e0.from), lay.byId.get(e0.to))
check('使用三次贝塞尔 C 命令（不是直线 L）', / C /.test(p) && !/\sL\s/.test(p), p)
check('起点在父节点右边缘', (() => {
  const a = lay.byId.get(e0.from)
  return p.startsWith(`M ${a.x + a.w} ${a.y + a.h / 2}`)
})(), p)
check('终点在子节点左边缘', (() => {
  const c = lay.byId.get(e0.to)
  return p.trim().endsWith(`${c.x} ${c.y + c.h / 2}`)
})(), p)

// 折叠后布局应收缩：根 + 甲 + 乙 + 乙1 = 4
jia.collapsed = true
const lay2 = layoutTreeSafe(lroot)
check('折叠子树后节点减少', lay2.nodes.length === 4, `得到 ${lay2.nodes.length}`)

/* ---------------- 5. 深层折角透传 ---------------- */
console.log('\n[5] 折叠时的折角透传')

const D = `- A
  - B [F]
    - C [F]`
const { root: droot } = parseMarkdown(D, '根')
const aNode = droot.children[0]
aNode.collapsed = true
const lay3 = layoutTreeSafe(droot)
const aItem = lay3.byId.get(aNode.id)
check('折叠后 A 透传 2 个隐藏折角', aItem.hiddenFold === 2, `得到 ${aItem.hiddenFold}`)
check('折叠后 A 自身仍渲染', !!aItem)
check('折叠后 A 的子节点被隐藏', lay3.nodes.length === 2, `得到 ${lay3.nodes.length}`)

/* ---------------- 6. 导出 Markdown 往返 ---------------- */
console.log('\n[6] 导出 Markdown')

const outMd = toMarkdown(root)
const reparsed = parseMarkdown(outMd, '测试')
check('导出的 MD 能被重新解析', reparsed.foldCount === 3, `得到 ${reparsed.foldCount}`)
check('导出的 MD 保留 mermaid 代码块', outMd.includes('```mermaid'))

/* ---------------- 7. 粗体/斜体往返 ---------------- */
console.log('\n[7] 粗体 / 斜体往返')

const STYLE_MD = ['- **加粗的节点**', '- *斜体的节点*', '- 普通节点', '- **又粗又** 不是斜体'].join('\n')
const { root: sroot } = parseMarkdown(STYLE_MD, 'x')
check('识别 **粗体**', sroot.children[0].bold === true && sroot.children[0].text === '加粗的节点',
  JSON.stringify(sroot.children[0].text))
check('识别 *斜体*', sroot.children[1].italic === true && sroot.children[1].text === '斜体的节点',
  JSON.stringify(sroot.children[1].text))
check('普通节点不带样式', !sroot.children[2].bold && !sroot.children[2].italic)

const styledOut = toMarkdown(sroot)
check('导出时写回 **粗体**', styledOut.includes('**加粗的节点**'), styledOut)
check('导出时写回 *斜体*', styledOut.includes('*斜体的节点*'), styledOut)
const styleBack = parseMarkdown(styledOut, 'x')
check('样式往返不丢失',
  styleBack.root.children[0].bold === true && styleBack.root.children[1].italic === true,
  JSON.stringify(styleBack.root.children.map((n) => [n.text, n.bold, n.italic])))

/* ---------------- 8. 代码块归属：必须「紧跟」 ---------------- */
console.log('\n[8] 代码块归属判定')

const FENCE = '```'
const mk = (lines) => parseMarkdown(lines.join('\n'), 'x')

// 折角 → 子节点 → 代码块（真实排版）：应当绑定
const t1 = mk(['- A [F]', '  - a1', '  ' + FENCE + 'mermaid', '  flowchart TD', '    X --> Y', '  ' + FENCE])
check('子节点之后的代码块绑到 A', !!t1.root.children[0].fold.mermaid)

// 折角 → 同级的另一个节点（无 [F]）→ 代码块：不应绑定到 A
const t2 = mk(['- A [F]', '- B', '  ' + FENCE + 'mermaid', '  flowchart TD', '    X --> Y', '  ' + FENCE])
check('隔了一个同级节点后，代码块不再绑到 A',
  !t2.root.children[0].fold.mermaid && !t2.root.children[1].fold,
  JSON.stringify(t2.root.children.map((n) => [n.text, !!n.fold?.mermaid])))

// 嵌套折角：内层先拿到自己的代码块
const t3 = mk([
  '- A [F]',
  '  - B [F]',
  '    ' + FENCE + 'mermaid',
  '    flowchart TD',
  '      P --> Q',
  '    ' + FENCE,
  '  ' + FENCE + 'mermaid',
  '  flowchart TD',
  '    M --> N',
  '  ' + FENCE,
])
const A3 = t3.root.children[0]
const B3 = A3.children[0]
check('嵌套折角：内层 B 拿到第一个代码块', B3.fold.mermaid.includes('P --> Q'), JSON.stringify(B3.fold.mermaid))
check('嵌套折角：外层 A 拿到第二个代码块', A3.fold.mermaid.includes('M --> N'), JSON.stringify(A3.fold.mermaid))

// 非 mermaid 代码块不应被当成流程图
const t4 = mk(['- A [F]', '  ' + FENCE + 'js', '  const a = 1', '  ' + FENCE])
check('非 mermaid 代码块不绑定', !t4.root.children[0].fold.mermaid)

console.log(`\n${'='.repeat(46)}`)
console.log(`  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)