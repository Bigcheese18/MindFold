import { parseOutline } from '../../lib/model'

/** 从 mermaid 源码里读方向（flowchart TD / graph LR …） */
export function parseDirection(src) {
  const m = String(src || '').match(/^\s*(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)\b/im)
  return m ? m[1] : 'TD'
}

/**
 * 两份缩进列表的「结构」是否一致（层级 + 文字序列）。
 *
 * 用来判断存下来的 outline 是不是就是 mermaid 反推出的那一份：
 *   · 从 Markdown 导入的折角 → outline 由 mermaidToOutline 生成 → 结构一致
 *   · 在代码模式改过的折角   → outline 由 applyCode 写成 ex.outline → 结构一致
 *   · 在缩进模式加了 (-> 引用) → 用户手写的那份和反推结果会不一样
 *
 * 一致时行序和 mermaid 的 rowIds 完全对应；不一致时只能按行号推 n<行号>。
 */
export function sameOutlineShape(a, b) {
  const A = parseOutline(a).map((n) => `${n.depth}\u0000${n.label}`)
  const B = parseOutline(b).map((n) => `${n.depth}\u0000${n.label}`)
  return A.length === B.length && A.every((x, i) => x === B[i])
}

/** 只替换方向，其余代码原样保留（代码模式改方向不能丢用户的边） */
export function withDirection(src, dir) {
  const lines = String(src || '').split('\n')
  const i = lines.findIndex((l) => /^\s*(?:flowchart|graph)\s/i.test(l))
  if (i < 0) return src
  lines[i] = lines[i].replace(/^(\s*)(flowchart|graph)\s+\S+/i, `$1$2 ${dir}`)
  return lines.join('\n')
}
