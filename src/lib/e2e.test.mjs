/**
 * 端到端校验：示例文档 → 解析 → 折角 → 渲染 → 布局
 * 确认首屏真的能画出带折角的导图（而不是只有数据结构对）。
 */
import { parseMarkdown, collectFolds, foldColor, foldLevel } from './model.js'
import { layoutTree } from './layout.js'
import { SAMPLE_MD, SAMPLE_MD_2 } from './sample.js'

let bad = 0
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) bad++ }

for (const [name, md] of [['计算机网络', SAMPLE_MD], ['线性代数', SAMPLE_MD_2]]) {
  console.log(`\n=== ${name} ===`)
  const { root, foldCount, total } = parseMarkdown(md, name)
  const folds = collectFolds(root)
  const withMmd = folds.filter((f) => f.node.fold.corner && f.node.fold.mermaid)

  console.log(`  节点 ${total} · 折角 ${foldCount} · 其中带流程图 ${withMmd.length}`)
  ok(foldCount > 0, '识别到折角')
  ok(withMmd.length > 0, '折角绑定了 mermaid 代码')
  ok(folds.every((f) => !/\[F\]|\[\[折角\]\]/.test(f.node.text)), '折角文字已剥离标记')

  // 布局可渲染
  const lay = layoutTree(root, { includeRoot: true })
  ok(lay.nodes.length === total + 1, `布局节点数 = 内容节点 + 合成根 (${lay.nodes.length})`)
  ok(lay.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), '所有节点坐标有限')
  ok(lay.nodes.every((n) => n.w > 0 && n.w <= 240), '节点宽度在合理区间')
  ok(lay.edges.length === lay.nodes.length - 1, '边数 = 节点数 - 1（是一棵树）')

  // 折角颜色分级
  const lv = [0, 1, 2, 3, 5, 9].map((c) => foldLevel(c))
  ok(JSON.stringify(lv) === JSON.stringify([0, 1, 1, 2, 3, 3]), '熟悉度分级 灰/蓝/橙/红 正确')
  // 角标配色：0 灰 → 1-2 蓝 → 3-4 橙 → 5+ 深红
  ok(foldColor(0) === '#9ca3af' && foldColor(1) === '#3b82f6' &&
     foldColor(3) === '#ea580c' && foldColor(10) === '#dc2626',
    `角标颜色映射正确（0=${foldColor(0)} 1=${foldColor(1)} 3=${foldColor(3)} 10=${foldColor(10)}）`)

  // 缩进列表都能反推（弹窗里「傻瓜模式」可用的前提）
  ok(withMmd.every((f) => !!f.node.fold.outline), '每个折角都能反推出缩进列表')
}

console.log(`\n${'='.repeat(46)}`)
console.log(bad ? `  存在 ${bad} 项问题` : '  端到端校验全部通过')
console.log('='.repeat(46))
process.exit(bad ? 1 : 0)