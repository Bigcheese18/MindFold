/**
 * 决定性对比：把旧的 DEF 正则和新的（从形状表生成的）DEF
 * 拿去解析**真实的示例文档**，逐节点比对结果。
 *
 * 目的：证明「重写 DEF 以支持 13 种外形」没有改变任何老文档的解析。
 * 这比数测试条数可靠 —— 条数可能因为断言写法变化而变，
 * 但「解析结果一模一样」是直接证据。
 */
import { parseMarkdown, mermaidToOutlineEx, collectFolds } from '../../src/lib/model.js'
import { SHAPES } from '../../src/lib/shapes.js'
import { SAMPLE_MD, SAMPLE_MD_2 } from '../../src/lib/sample.js'

const ID = '[A-Za-z0-9_\\u4e00-\\u9fa5](?:-?[A-Za-z0-9_\\u4e00-\\u9fa5])*'
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- 旧 DEF（改动前的原样，逐字符照抄）----
const OLD_DEF = new RegExp(
  `(${ID})\\s*(?:\\(\\(([^)]*)\\)\\)|\\["([^"]*)"\\]|\\[([^\\]]*)\\]|\\(([^)]*)\\)|\\{([^}]*)\\})`, 'g'
)

// ---- 新 DEF（从 SHAPES 生成，和 model.js 一致）----
const SHAPE_ALTS = SHAPES.map((s) => [s.mermaid[0], s.mermaid[1]])
  .sort((a, b) => b[0].length - a[0].length)
  .map(([o, c]) => `${escRe(o)}([^"]*)${escRe(c)}`)
const LEGACY_ALTS = ['\\(\\(([^)]*)\\)\\)', '\\[([^\\]]*)\\]', '\\(([^)]*)\\)', '\\{([^}]*)\\}']
const NEW_DEF = new RegExp(`(${ID})\\s*(?:${[...SHAPE_ALTS, ...LEGACY_ALTS].join('|')})`, 'g')

/** 用给定 DEF 抽出「节点 id → 标签」的顺序表 */
function extract(code, DEF) {
  const out = []
  for (const rawLine of String(code).split('\n')) {
    const line = rawLine.trim()
    if (!line || /^(flowchart|graph)\s/i.test(line) || line.startsWith('%%')) continue
    let m
    DEF.lastIndex = 0
    while ((m = DEF.exec(line))) {
      const g = m.slice(2).find((x) => x !== undefined)
      out.push(m[1] + '=' + String(g ?? '').trim().replace(/^["']|["']$/g, ''))
    }
  }
  return out
}

/* ---------- 1. 真实示例文档 ---------- */
const DOCS = [['计算机网络', SAMPLE_MD], ['线性代数', SAMPLE_MD_2]]
console.log('示例文档：' + JSON.stringify(DOCS.map(([n]) => n)))

let totalNodes = 0
let totalFolds = 0
let diffCount = 0

for (const [name, md] of DOCS) {
  const { root, total } = parseMarkdown(md, name)
  const folds = collectFolds(root).filter((f) => f.node.fold?.mermaid)

  totalNodes += total
  totalFolds += folds.length
  console.log(`\n=== ${name} ===  节点 ${total} · 带流程图 ${folds.length}`)

  for (const f of folds) {
    const mmd = f.node.fold.mermaid
    const a = extract(mmd, OLD_DEF)
    const b = extract(mmd, NEW_DEF)
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffCount++
      console.log('  ✗ 解析不一致！源=' + JSON.stringify(mmd.slice(0, 100)))
      console.log('    旧: ' + JSON.stringify(a))
      console.log('    新: ' + JSON.stringify(b))
    }
  }
  console.log(`  ${folds.length} 张流程图：旧/新 DEF 解析${diffCount ? '有差异' : '完全一致'}`)

  // 顺带确认节点数没被解析改动影响（e2e 也断言相对关系，这里给绝对值）
  console.log(`  节点数 ${total}（绝对值，供跨版本对比）`)
}

console.log(`\n合计：节点 ${totalNodes} · 折角流程图 ${totalFolds}`)
console.log(diffCount === 0
  ? '✓ 所有真实文档：旧 DEF 与新 DEF 解析结果逐字符一致'
  : `✗ 有 ${diffCount} 处不一致`)

/* ---------- 2. 手写 mermaid 的各种括号写法 ---------- */
console.log('\n=== 手写括号写法的覆盖对比 ===')
const CASES = [
  'flowchart TD\n  A["x"]',
  'flowchart TD\n  A[""]',
  'flowchart TD\n  A[x]',
  'flowchart TD\n  A(x)',
  'flowchart TD\n  A{x}',
  'flowchart TD\n  A((x))',
  'flowchart TD\n  A(("x"))',
  'flowchart TD\n  A["x"] --> B["y"]',
  'flowchart TD\n  A-->B',
  'flowchart TD\n  A["说 &quot; 话"]',
  'flowchart TD\n  node-1["甲"]\n  node-2["乙"]\n  node-1-->node-2',
  'flowchart TD\n  开始["起点"] --> 结束["终点"]',
  'flowchart TD\n  A["见 B[1]"]\n  B["y"]',
  'flowchart TD\n  A["a --> b"]',
  'flowchart TD\n  A["含 (括号) 的"]',
]
let caseDiff = 0
for (const c of CASES) {
  const a = extract(c, OLD_DEF)
  const b = extract(c, NEW_DEF)
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    caseDiff++
    console.log('  ✗ ' + JSON.stringify(c.split('\n')[1]))
    console.log('    旧: ' + JSON.stringify(a))
    console.log('    新: ' + JSON.stringify(b))
  }
}
console.log(caseDiff === 0
  ? `✓ ${CASES.length} 种手写写法：旧/新 DEF 结果完全一致`
  : `✗ ${caseDiff} 处不一致`)

process.exit(diffCount + caseDiff ? 1 : 0)
