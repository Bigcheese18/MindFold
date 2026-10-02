/**
 * Mermaid 渲染桥接
 * ================
 * 两个关键约束（来自 PRD）：
 *   1. 语法错误时，右侧必须保留上一版正确的图，绝不能白屏/消失。
 *      → 因此渲染成功才 commit，失败只回报错误行号。
 *   2. 长流程图不强行缩小，保持字号，靠滚动查看。
 *      → 交给外层容器滚动 + 用户滚轮缩放，这里只负责输出 SVG。
 */

import mermaid from 'mermaid'

let inited = false

/** 初始化 mermaid（模块内部使用；外部换肤请用 applyTheme） */
function initMermaid(theme = 'neutral') {
  mermaid.initialize({
    startOnLoad: false,
    // 用 neutral 而不是 default：neutral 的配色更克制，符合极简定位
    theme,
    securityLevel: 'strict',
    fontFamily: 'Inter, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
    /**
     * 显式指定 dagre 布局。
     *
     * mermaid 11 里流程图默认就是 dagre（defaultRenderer: 'dagre-wrapper'），
     * 但这里写明有两个原因：
     *   1. 「多对一 / 交叉连线」时 dagre 会做分层（rank）与交叉最小化，
     *      汇聚点自动排到下层中间，比手写坐标靠谱 —— 这是 PRD 明确要的效果；
     *   2. 默认值可能随版本变化，写死能避免升级后布局突然变样。
     * 顶层 layout 走 mermaid 的 registerLayoutLoaders（已内置 'dagre'）。
     */
    layout: 'dagre',
    flowchart: {
      defaultRenderer: 'dagre-wrapper',
      curve: 'basis',
      padding: 12,
      nodeSpacing: 40,
      rankSpacing: 48,
      useMaxWidth: false, // 关键：关掉自动缩宽，长图才能横向滚动
      htmlLabels: true,
    },
    themeVariables: { fontSize: '14px' },
  })
  inited = true
}

export const MERMAID_THEMES = {
  white: { theme: 'neutral', variables: {} },
  sepia: {
    theme: 'base',
    variables: {
      primaryColor: '#fdf6e3',
      primaryTextColor: '#5b4636',
      primaryBorderColor: '#c9a97a',
      lineColor: '#b08d57',
      secondaryColor: '#f5ecd7',
      tertiaryColor: '#faf3e3',
      background: '#fdf9f0',
      mainBkg: '#fdf6e3',
      nodeBorder: '#c9a97a',
      clusterBkg: '#f7efdd',
      titleColor: '#5b4636',
      edgeLabelBackground: '#fdf9f0',
    },
  },
  dark: {
    theme: 'dark',
    variables: {
      primaryColor: '#1e293b',
      primaryTextColor: '#e5e7eb',
      primaryBorderColor: '#475569',
      lineColor: '#64748b',
      secondaryColor: '#27272a',
      tertiaryColor: '#1f2937',
      background: '#111318',
      mainBkg: '#1e293b',
      nodeBorder: '#475569',
      clusterBkg: '#1a1d24',
      edgeLabelBackground: '#111318',
    },
  },
}

export function applyTheme(themeKey) {
  const cfg = MERMAID_THEMES[themeKey] || MERMAID_THEMES.white
  mermaid.initialize({
    startOnLoad: false,
    theme: cfg.theme,
    themeVariables: cfg.variables,
    securityLevel: 'strict',
    fontFamily: 'Inter, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
    layout: 'dagre',
    flowchart: {
      defaultRenderer: 'dagre-wrapper',
      curve: 'basis', padding: 12, nodeSpacing: 40, rankSpacing: 48, useMaxWidth: false, htmlLabels: true,
    },
  })
  inited = true
}

let renderSeq = 0

/**
 * 渲染 mermaid 源码 → SVG 字符串
 * @returns {{ ok: true, svg: string } | { ok: false, error: string, line: number|null }}
 */
export async function renderMermaid(code) {
  if (!inited) initMermaid()
  const src = String(code || '').trim()
  if (!src) return { ok: false, error: '空内容', line: null }

  const id = `mf-mmd-${++renderSeq}`
  try {
    // mermaid 11 的 parse 会抛错，先 parse 再 render，能得到更干净的错误定位
    await mermaid.parse(src)
  } catch (e) {
    return { ok: false, error: cleanError(e), line: extractLine(e, src) }
  }

  try {
    const { svg } = await mermaid.render(id, src)
    return { ok: true, svg }
  } catch (e) {
    // render 阶段失败时清掉 mermaid 遗留的临时节点，否则页面会残留半成品
    document.getElementById('d' + id)?.remove()
    document.getElementById(id)?.remove()
    return { ok: false, error: cleanError(e), line: extractLine(e, src) }
  }
}

function cleanError(e) {
  const msg = String(e?.message || e || '未知错误')
  // 去掉堆栈噪音，只留第一行有效信息
  return msg.split('\n').filter((l) => l.trim()).slice(0, 3).join(' ').slice(0, 300)
}

/**
 * 从 mermaid 抛出的错误里尽量挖出行号。
 * mermaid 的报错格式不稳定，所以做多路兜底；挖不到就返回 null（调用方标整个块）。
 */
function extractLine(e, src) {
  const msg = String(e?.message || '')
  const hash = e?.hash
  if (hash && typeof hash.loc?.first_line === 'number') return hash.loc.first_line

  let m = msg.match(/line\s+(\d+)/i) || msg.match(/Lexical error on line (\d+)/i)
  if (m) return parseInt(m[1], 10)

  // 兜底：mermaid 报错里常回显出错的那一行原文，拿它去源码里找
  const quoted = msg.match(/"([^"]{3,60})"/)
  if (quoted) {
    const lines = src.split('\n')
    const idx = lines.findIndex((l) => l.includes(quoted[1]))
    if (idx >= 0) return idx + 1
  }
  return null
}

/**
 * 「行尾小问号气泡」用的语法速查表。
 * 按错误关键词匹配，命不中就返回通用提示 —— 用户永远能看到点有用的东西。
 */
const SYNTAX_TIPS = [
  { re: /expecting|got 'EOF'|Parse error/i, tip: '语法不完整：检查箭头两侧是否都有节点，或括号/引号是否成对闭合。' },
  { re: /Lexical error|Unrecognized|unknown token/i, tip: '出现了无法识别的字符。含空格或标点的文字请用双引号包起来，如 A["我的 节点"]。' },
  { re: /flowchart|graph|diagram/i, tip: '第一行必须是图表类型声明，推荐：flowchart TD（TD 上下 / LR 左右）。' },
  { re: /subgraph|end/i, tip: 'subgraph 必须用 end 收尾，且成对出现。' },
  { re: /-->/i, tip: '箭头写法：A --> B；带文字用 A -->|说明| B。' },
]

export function syntaxTip(error) {
  for (const t of SYNTAX_TIPS) if (t.re.test(String(error))) return t.tip
  return '检查节点定义写法：id["显示文字"]，连线写法：A --> B。文字含空格务必加双引号。'
}