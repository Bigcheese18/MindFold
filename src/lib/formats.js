/**
 * 多格式导入导出
 * ================
 * 用户原话：「加一个导入的格式 html 不止 markdown 可以扩展多一点 导入也是」。
 * 于是这里把「导图 ←→ 外部格式」这件事收口到一个纯函数模块，两头共用：
 *
 *   导出：Markdown（model.js 里的 toMarkdown）· 离线 HTML（exporters.js）
 *         · **OPML** · **FreeMind .mm** · **单文档 JSON**
 *   导入：上面全部 + 纯文本缩进大纲，**按内容自动认格式**，不再只看扩展名
 *
 * 【为什么是这几个格式，不是随便凑数】
 *   · OPML —— 大纲类工具的事实标准（幕布 / XMind / OmniOutliner / Workflowy /
 *     dynalist 都读写它），把导图搬出去、把别处的大纲搬进来都靠它；
 *   · FreeMind `.mm` —— 脑图类工具的老标准（FreeMind / Freeplane / XMind 都认），
 *     是「在别的脑图软件里接着用」的低摩擦出口；
 *   · 单文档 JSON —— 我们自己格式的**无损**出口：折角次数、mermaid 源码、
 *     汇聚连线这些 OPML 装不下的东西，只有它能原样带回来。
 *   （离线 HTML 也内嵌了同一份 JSON，所以导出的那一页同样能无损回导。）
 *
 * 【本文件是纯函数：不碰 DOM、不碰 localStorage】
 * 手机 / 桌面 / 桌面壳三端共用一份实现，也能在 node 里直接跑测试。
 * 外部依赖只有两个：model.js（树工具 + Markdown 解析）和 store.js 的
 * `normalizeDocPayload`（「导入的文档结构校验」全项目只有那一处实现）。
 */

import {
  makeNode, makeFold, parseMarkdown, normalizeRelations, mermaidToOutline, FOLD_MARK,
  walkTree,
} from './model.js'
import { normalizeDocPayload } from './store.js'

/** 单文档 JSON 自己的格式标记；识别时先看它 */
export const DOC_FORMAT = 'mindfold-doc'
export const DOC_FORMAT_VERSION = 1

/** 离线 HTML 里内嵌载荷的脚本 id：导出写、导入读，同一份常量 */
export const EMBED_SCRIPT_ID = 'mf-outline'

/**
 * 一次最多导入多少节点。
 * 防御性的：把一整张网页存成 HTML 再导入时 `<p>` 可能上万，无限建节点会当场
 * 把界面卡死 —— 那就不是「导入失败」，是「应用坏了」。
 */
export const MAX_IMPORT_NODES = 4000
/** 单个节点的文字上限（外来 HTML 里常有整段正文被当成一个节点） */
export const MAX_NODE_TEXT = 500

/** detectFormat 的返回值。集中成常量，免得各处写裸字符串拼错还看不出来 */
export const FORMAT = {
  BACKUP: 'backup',
  DOC_JSON: 'doc-json',
  OFFLINE_HTML: 'offline-html',
  HTML: 'html',
  PRINT_HTML: 'print-html',
  OPML: 'opml',
  FREEMIND: 'freemind',
  MARKDOWN: 'markdown',
  OUTLINE: 'outline',
  UNKNOWN: 'unknown',
}

/** 给人看的格式名（提示条里用：已按「OPML」导入 N 个节点） */
export const FORMAT_LABEL = {
  [FORMAT.BACKUP]: '整库备份',
  [FORMAT.DOC_JSON]: '单文档 JSON',
  [FORMAT.OFFLINE_HTML]: '离线 HTML',
  [FORMAT.HTML]: 'HTML',
  [FORMAT.PRINT_HTML]: '打印预览页',
  [FORMAT.OPML]: 'OPML',
  [FORMAT.FREEMIND]: 'FreeMind',
  [FORMAT.MARKDOWN]: 'Markdown',
  [FORMAT.OUTLINE]: '缩进大纲',
  [FORMAT.UNKNOWN]: '未知格式',
}

/**
 * 导入用的 accept 列表。扩展名和 MIME 都要写，理由见 App.jsx 里那段长注释
 * （安卓的 MimeTypeMap 不认识 md / opml / mm，只写扩展名会让文件在系统选择器里
 * 被置灰，用户根本选不中）。
 */
export const IMPORT_EXTENSIONS = [
  '.md', '.markdown', '.mdx', '.txt', '.text',
  '.opml', '.xml', '.mm',
  '.html', '.htm',
  '.json',
]
export const IMPORT_MIME = [
  'text/markdown', 'text/x-markdown', 'text/plain',
  'text/xml', 'application/xml', 'application/x-opml',
  'text/html', 'application/json',
]

/* ================================================================== */
/* 一、通用小工具                                                       */
/* ================================================================== */

/**
 * XML 属性值转义。
 *
 * 【换行为什么要写成 &#10;】
 * XML 规范规定属性值里的换行会被**规范化成空格**（attribute-value
 * normalization）。直接把 mermaid 源码塞进 `_note="..."`，任何合规的解析器读回来
 * 都是一行。写成字符引用 `&#10;` 就能原样穿过这一步。制表符同理，尖括号引号按常规转。
 */
function xml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c])).replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')
}

/**
 * 实体解码。手写而不用 DOMParser / textarea：
 *   · 本文件要能在 node 里跑测试（node 没有 DOMParser）；
 *   · 用 textarea 就得造 DOM，纯函数立刻变成非纯的。
 * 覆盖真正会遇到的那几个命名实体 + 全部数字引用（含 &#x27; 这种十六进制）。
 */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m
      try { return String.fromCodePoint(code) } catch { return m }
    }
    const named = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
      ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
      mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7',
    }[g]
    return named === undefined ? m : named
  })
}

/**
 * 标签流扫描器：把 XML / HTML 拆成有序的「开标签 / 自闭标签 / 闭标签」。
 *
 * 【为什么自己写一遍】
 * 三种格式（OPML / FreeMind / HTML）都要处理**嵌套**，而嵌套必须知道标签的先后
 * 顺序和自闭合与否。一个「找 `<outline ...>`」的正则拿不到「谁是谁的孩子」。
 *
 * 【每个 token 都带 start/end 字节偏移】
 * 上层要能按偏移把一段**原始**内容切出来（`<li>` 自己的文字、NOTE 备注……），
 * 正则的子匹配做不到这件事。有了偏移，`sliceUntilClose` 就是几行。
 *
 * 【属性里为什么不能用「匹配到 > 为止」】
 * `text="a > b"`（手写 XML 里很常见）会把标签切断。所以属性部分用
 * 「双引号串 | 单引号串 | 不含 `>"'` 的串」三种交替，引号里的 `>` 自然被排除。
 */
export function* tokenize(src) {
  const s = String(src ?? '')
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let m
  while ((m = re.exec(s))) {
    const start = m.index
    const end = m.index + m[0].length
    if (m[1]) { yield { kind: 'close', name: m[1].toLowerCase(), attrs: {}, selfClosing: false, start, end }; continue }
    if (m[2]) {
      yield { kind: 'open', name: m[2].toLowerCase(), attrs: parseAttrs(m[3] || ''), selfClosing: m[4] === '/', start, end }
      continue
    }
    // 注释 / CDATA / doctype / 处理指令：一律当没看见（但吃掉偏移，切片仍然准）
  }
}

/** 属性串 → 对象（键小写）。值里的实体在这一步解码，调用方不用再管 */
export function parseAttrs(src) {
  const out = {}
  const re = /([\w:.-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g
  let m
  while ((m = re.exec(String(src || '')))) {
    const key = m[1].toLowerCase()
    if (Object.prototype.hasOwnProperty.call(out, key)) continue // 第一个说了算
    let v = m[2]
    if (v === undefined) v = ''
    else if (v[0] === '"' || v[0] === "'") v = v.slice(1, -1)
    out[key] = decodeEntities(v)
  }
  return out
}

/**
 * 一段 HTML 里的纯文本：标签当分隔、解码实体、空白折叠。
 *
 * 【行内标签为什么不能一律换成空格】
 * `<p>富文本<i>节点</i></p>` 里 `<i>` 只是排版，换成空格会得到「富文本 节点」，
 * 中文词组被硬生生拆开。所以：行内标签（b/i/span/a/strong/em…）直接删掉，
 * 只有真正分段的标签（br、块级元素的结束标签）才补一个空格。
 */
export function textOf(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|ul|ol|h[1-6]|tr|td|section|article|blockquote|pre|body|html)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ''))
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
}

/** 行尾折角标记（`[F]` / `[[折角]]`）→ 拆出文字与标记，和 Markdown 的约定一致 */
function takeFoldMark(text) {
  const t = String(text ?? '')
  if (!FOLD_MARK.test(t)) return { text: t.trim(), marked: false }
  return { text: t.replace(FOLD_MARK, '').trim(), marked: true }
}

/**
 * 这段文字像不像 mermaid 源码 —— 决定一条「备注」算不算折角里的流程图。
 * 只在「备注」这种含义模糊的位置用；明确写了 `mf-fold="1"` 的地方不看这个。
 */
const MERMAID_HEAD = /^\s*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|mindmap|timeline|gitGraph|C4Context|sankey-beta|xychart-beta|block-beta|packet-beta|architecture-beta)\b/
const looksLikeMermaid = (s) => MERMAID_HEAD.test(String(s ?? ''))

const clampText = (s) => {
  const t = String(s ?? '')
  return t.length > MAX_NODE_TEXT ? t.slice(0, MAX_NODE_TEXT) : t
}

/**
 * 扁平项 → Node 树。所有「外部格式」的解析器最后都汇到这里。
 *
 * 【为什么不各自写一遍入栈逻辑】
 * `parseMarkdown` 里那套「新节点入栈前弹掉深度 ≥ 自己的」是从 Markdown 缩进语义
 * 长出来的，而 OPML / FreeMind / HTML 拿到的深度同样只是「相对层级」，语义一样。
 * 抄四份的结果一定是三份跑偏 —— 而层级错乱是最难从界面看出来的 bug（树还在，
 * 就是挂错了爹）。所以这里只有一份。
 *
 * items: [{ depth, text, fold?, mermaid?, bold?, italic? }]
 */
export function buildFromFlat(items, docName) {
  const root = makeNode(String(docName || '未命名'))
  const stack = [{ depth: -1, node: root }]
  let total = 0
  let foldCount = 0
  let truncated = false

  for (const it of items) {
    const text = clampText(it.text)
    if (!text.trim()) continue
    if (total >= MAX_IMPORT_NODES) { truncated = true; break }

    while (stack.length > 1 && stack[stack.length - 1].depth >= it.depth) stack.pop()
    const parent = stack[stack.length - 1].node

    const node = makeNode(text)
    node.bold = !!it.bold
    node.italic = !!it.italic
    if (it.fold) {
      const mermaid = String(it.mermaid || '').trim()
      node.fold = makeFold({ corner: !!mermaid, mermaid })
      // corner=true 的含义与应用内一致：这个折角里真的有图
      if (mermaid) node.fold.outline = mermaidToOutline(mermaid) || ''
      foldCount++
    }
    parent.children.push(node)
    stack.push({ depth: it.depth, node })
    total++
  }

  return { root, total, foldCount, truncated }
}

/** 从第 i 个 token 开始，取到同名闭标签**之前**的原始文本（不进入嵌套的同名标签） */
function sliceUntilClose(src, tokens, i, name, missingCap = 4000) {
  const from = tokens[i]
  let depth = 1
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]
    if (t.name !== name || t.selfClosing) continue
    if (t.kind === 'open') depth++
    else if (t.kind === 'close') { depth--; if (depth <= 0) return src.slice(from.end, t.start) }
  }
  return src.slice(from.end, from.end + missingCap)
}

/** 跳到同名闭标签的下标（没有就到最后），供上层跳过一整段子树 */
function skipToClose(tokens, i, name) {
  let depth = 1
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]
    if (t.name !== name || t.selfClosing) continue
    if (t.kind === 'open') depth++
    else if (t.kind === 'close') { depth--; if (depth <= 0) return j }
  }
  return tokens.length - 1
}

/* ================================================================== */
/* 二、导出                                                            */
/* ================================================================== */

/**
 * 单文档 → 我们自己的 JSON 载荷。
 * 「单文档 JSON 文件」和「离线 HTML 里内嵌的那一段」是同一个对象，
 * 所以两种导出的回导能力天然一致，不会一个能读一个读不回来。
 */
export function docToJson(doc, { exportedAt } = {}) {
  return {
    format: DOC_FORMAT,
    version: DOC_FORMAT_VERSION,
    name: doc?.name || '未命名',
    exportedAt: exportedAt || new Date().toISOString(),
    root: doc?.root || makeNode('未命名'),
    relations: normalizeRelations(doc?.relations),
  }
}

/* ---------------- OPML ---------------- */

/**
 * 导出 OPML 2.0。
 *
 * 每个节点一个 `<outline text="...">`，嵌套就是孩子（OPML 的天然形状）。
 * 折角用两个属性带出去：
 *   `mf-fold="1"`  这个节点有折角
 *   `_note="..."`  折角的 mermaid 源码（`_note` 是 OPML 的标准属性，
 *                  OmniOutliner 之类会把它当备注显示 —— 在别的工具里是
 *                  「一句可读的备注」，回到 MindFold 里就是那张流程图）
 * 自定义属性在别的工具里被忽略，不会污染人家的数据。
 *
 * 【为什么 openCount（打开过几次）不写】
 * OPML 没有任何地方放它，硬塞一个属性只会让文件变成「只有 MindFold 认识」的格式。
 * 学习进度要靠单文档 JSON 或整库备份无损带走 —— 提示条里会如实说明。
 */
export function toOpml(root, { name = '' } = {}) {
  const title = name || root?.text || '未命名'
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${xml(title)}</title>`,
    '  </head>',
    '  <body>',
    opmlNode({ ...root, text: title }, 2),
    '  </body>',
    '</opml>',
  ]
  return lines.join('\n') + '\n'
}

function opmlNode(node, indent) {
  const pad = '  '.repeat(indent)
  let attrs = ` text="${xml(node.text || '')}"`
  if (node.fold) {
    attrs += ' mf-fold="1"'
    if (node.fold.corner && node.fold.mermaid) attrs += ` _note="${xml(node.fold.mermaid)}"`
  }
  const kids = node.children || []
  if (!kids.length) return `${pad}<outline${attrs}/>`
  return `${pad}<outline${attrs}>\n`
    + kids.map((c) => opmlNode(c, indent + 1)).join('\n')
    + `\n${pad}</outline>`
}

/**
 * 解析 OPML。
 *
 * 【外层那个 outline 必须拆掉】
 * 我们导出的 OPML 是 `<outline text="文档名">` 包住整棵树。若直接按层级建树，
 * 文档名会变成根下面多出来的一个节点 —— 每来回导一次就深一层。这是「导出→导入」
 * 往返测试必须钉住的东西。
 * 判据：**唯一一个 depth 0 的条目，且它还有孩子** → 那是文档容器。
 * 手写的 OPML 常常有多个并列顶层条目，那种情况一律原样当根的孩子。
 *
 * @returns {{items, title, name}} items 已去掉外层容器、深度已归零
 */
export function parseOpml(text, preferredName = '') {
  const items = []
  let depth = 0
  for (const t of tokenize(text)) {
    if (t.name !== 'outline') continue
    if (t.kind === 'close') { depth = Math.max(0, depth - 1); continue }
    const a = t.attrs
    const { text: label, marked } = takeFoldMark(a.text ?? a.title ?? '')
    const note = a._note ?? a.note ?? ''
    const mermaid = looksLikeMermaid(note) ? note.trim() : ''
    items.push({
      depth, text: label,
      fold: marked || a['mf-fold'] === '1' || !!mermaid,
      mermaid,
    })
    if (!t.selfClosing) depth++
  }
  if (!items.length) throw new Error('这个 OPML 里没有可用的节点')

  const title = (/<title>([\s\S]*?)<\/title>/i.exec(String(text)) || [, ''])[1]
  let container = ''
  if (items[0].depth === 0 && items.length > 1 && items.every((it, i) => i === 0 || it.depth >= 1)) {
    container = items[0].text
    items.shift()
    for (const it of items) it.depth--
  }
  return { items, title: textOf(title), container, name: preferredName || container || textOf(title) }
}

/* ---------------- FreeMind .mm ---------------- */

/**
 * 导出 FreeMind / Freeplane 的 `.mm`。
 *
 * 折角怎么带：`mf-fold="1"` 属性 + 一个 `<icon BUILTIN="bookmark"/>`（在 FreeMind
 * 里看得见，用户知道这里有个「折角」）+ mermaid 源码放进标准的
 * `<richcontent TYPE="NOTE">` —— 那正是 FreeMind 存备注的地方。
 *
 * 【读的时候为什么不认 bookmark 图标】
 * 图标是**别人工具里的用户数据**：人家可能就用书签标重点，认它会平白多出一堆
 * 空洞的折角。所以只认 `mf-fold` 和「像 mermaid 的备注」两条 —— 前者是我们写的，
 * 后者是内容本身在自证。图标只负责「在对方软件里好看」。
 */
export function toFreeMind(root, { name = '' } = {}) {
  const title = name || root?.text || '未命名'
  let seq = 0
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<map version="1.0.1">\n'
    + '<!-- 由 MindFold 导出：折角节点带 mf-fold 属性与备注，可原样再导入 -->\n'
    + fmNode({ ...root, text: title }, 0, () => `mf-${++seq}`) + '\n</map>\n'
}

function fmNode(node, depth, nextId) {
  const pad = '  '.repeat(depth)
  let attrs = ` TEXT="${xml(node.text || '')}" ID="${nextId()}"`
  if (depth === 1) attrs += ' POSITION="right"'
  const kids = node.children || []
  const extra = []
  if (node.fold) {
    attrs += ' mf-fold="1"'
    extra.push(`${pad}  <icon BUILTIN="bookmark"/>`)
    if (node.fold.corner && node.fold.mermaid) {
      const ps = String(node.fold.mermaid).split('\n')
        .map((l) => `<p>${l ? xml(l) : '<br/>'}</p>`).join('')
      extra.push(`${pad}  <richcontent TYPE="NOTE"><html><head></head><body>${ps}</body></html></richcontent>`)
    }
  }
  const head = `${pad}<node${attrs}`
  if (!kids.length && !extra.length) return head + '/>'
  return head + '>\n'
    + [...extra, ...kids.map((c) => fmNode(c, depth + 1, nextId))].join('\n')
    + `\n${pad}</node>`
}

/**
 * 解析 FreeMind / Freeplane `.mm`。
 *
 * 节点文字优先取 `TEXT` 属性，没有就退到 `<richcontent TYPE="NODE">` 里的纯文本
 * （Freeplane 存富文本节点时就是这个形状）。备注取 `<richcontent TYPE="NOTE">`，
 * 只有它像 mermaid 时才当流程图 —— 否则备注就是备注，丢掉。
 * 根节点（唯一那个 depth 0）永远是文档容器，剥掉。
 */
export function parseFreeMind(text, preferredName = '') {
  const src = String(text)
  const tokens = [...tokenize(src)]
  const items = []
  let depth = 0

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.name === 'richcontent') {
      if (t.kind !== 'open') continue
      const type = String(t.attrs.type || '').toUpperCase()
      const body = textOf(sliceUntilClose(src, tokens, i, 'richcontent'))
      const cur = items[items.length - 1]
      if (cur && body) {
        if (type === 'NOTE') {
          // 备注像 mermaid → 这个节点就是折角。只看内容，不看图标（理由见 toFreeMind 注释）
          if (!cur.mermaid && looksLikeMermaid(body)) { cur.mermaid = body; cur.fold = true }
        } else if (type === 'NODE' && !cur.text) cur.text = body
      }
      // 备注里的 `<p>` 只是分行，不该被当成节点 —— 整段跳过
      i = skipToClose(tokens, i, 'richcontent')
      continue
    }
    if (t.name !== 'node') continue
    if (t.kind === 'close') { depth = Math.max(0, depth - 1); continue }
    const a = t.attrs
    const { text: label, marked } = takeFoldMark(a.text ?? a.title ?? '')
    items.push({ depth, text: label, fold: marked || a['mf-fold'] === '1', mermaid: '' })
    if (!t.selfClosing) depth++
  }
  if (!items.length) throw new Error('这个 .mm 文件里没有可用的节点')

  let container = ''
  if (items[0].depth === 0) {
    container = items[0].text
    items.shift()
    for (const it of items) it.depth--
  }
  return { items, container, name: preferredName || container }
}

/* ---------------- HTML ---------------- */

/**
 * HTML → 大纲。
 *
 * 认这几种（都是「人写的大纲」的真实形状）：
 *   1. `<h1>`~`<h6>` —— 层级 = 标题级别；
 *   2. `<ul>/<ol>/<li>` 嵌套 —— 层级 = 列表嵌套深度，出现在标题下面时自动成为
 *      那个标题的孩子（不这么做的话 h2 和它下面的列表会变成兄弟）；
 *   3. 不在列表里的 `<p>` —— 每段一个节点（网页、Word「另存为网页」、
 *      Google Docs 导出的 HTML 大多是这种）；
 *   4. 我们自己导出的离线 HTML 里那些 `data-mf-depth` 标记 —— 见下面。
 *
 * 【为什么必须跳过 script/style 的内容】
 * 网页里的 JS 和 CSS 本身就是一大坨文本，全收进来就是几十个乱码节点。
 * `svg/iframe/template/noscript/head` 同理。
 *
 * 【`<li><p>文字</p></li>` 为什么不能重复出两个节点】
 * `<li>` 已经把自己的文字收走了，里层的 `<p>` 再收一遍就是同一句话两个节点。
 * 所以列表里的 `<p>` 一律跳过（列表外才当节点）。
 *
 * 【节点数上限】
 * 一张网页的 `<p>` 可能上万。这不是「导入失败」，是「导进来也没法用」——
 * 到上限就停，并把 truncated 如实报给用户，而不是把界面卡死。
 */
export function parseHtml(text, preferredName = '') {
  // 先把不该看的元素连内容一起挖掉。
  // 注意 title 要从**原始**文本里取 —— head 整块都在下面这条里被挖掉了。
  const raw = String(text ?? '')
  const src = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')

  const tokens = [...tokenize(src)]
  const items = []
  const listStack = []
  let headingDepth = null
  let truncated = false

  const push = (d, raw, foldFlag = false) => {
    if (truncated) return
    const { text: label, marked } = takeFoldMark(textOf(raw))
    if (!label) return
    if (items.length >= MAX_IMPORT_NODES) { truncated = true; return }
    items.push({ depth: Math.max(0, d), text: label, fold: marked || foldFlag })
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]

    const head = /^h([1-6])$/.exec(t.name)
    if (head) {
      if (t.kind !== 'open') continue
      const level = Number(head[1]) - 1
      headingDepth = level
      push(level, sliceUntilClose(src, tokens, i, t.name))
      continue
    }

    if (t.name === 'ul' || t.name === 'ol') {
      if (t.kind === 'close') listStack.pop()
      else if (!t.selfClosing) listStack.push(null)
      continue
    }

    if (t.name === 'li') {
      if (t.kind !== 'open') continue
      const parent = listStack.length >= 2
        ? listStack[listStack.length - 2]
        : (headingDepth === null ? -1 : headingDepth)
      const d = (parent === null || parent === undefined ? -1 : parent) + 1
      if (listStack.length) listStack[listStack.length - 1] = d
      push(d, liOwnHtml(src, tokens, i))
      continue
    }

    // 第 4 条：MindFold 离线 HTML 自己的 `data-mf-depth` 标记。
    // 只在「内嵌 JSON 丢了」时才走到这儿（比如用户把那一页另存之后又删了脚本），
    // 属于兜底路径，但也让它能读回文字与折角，不至于白丢一整份文档。
    if (t.kind === 'open' && t.attrs['data-mf-depth'] !== undefined) {
      const d = Number(t.attrs['data-mf-depth'])
      push(
        Number.isFinite(d) ? d : 0,
        t.attrs['data-mf-text'] !== undefined ? decodeEntities(t.attrs['data-mf-text']) : textOf(sliceUntilClose(src, tokens, i, t.name)),
        t.attrs['data-mf-fold'] === '1',
      )
      continue
    }

    if (t.name === 'p') {
      if (t.kind !== 'open') continue
      if (listStack.length) continue          // 列表项自己的段落，已在 <li> 里收过
      push(headingDepth === null ? 0 : headingDepth + 1, sliceUntilClose(src, tokens, i, 'p'))
      continue
    }
  }

  if (!items.length) throw new Error('这个 HTML 里没有找到可用的标题或列表')

  const titleTag = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw) || [, ''])[1]
  const title = textOf(titleTag)
  return { items, truncated, title, name: preferredName || title }
}

/**
 * `<li>` 自己的文字：**到它内部第一个嵌套列表/嵌套条目为止**。
 * 不这么做的话父条目的文字会把整棵子孙的文字全吞进来（`- A` 变成「A B C D」），
 * 这是 HTML 大纲导入最容易踩的一脚。
 */
function liOwnHtml(src, tokens, i) {
  const from = tokens[i]
  let nest = 0
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]
    if ((t.name === 'ul' || t.name === 'ol') && !t.selfClosing) {
      if (t.kind === 'open') { if (nest === 0) return src.slice(from.end, t.start); nest++ }
      else nest--
      continue
    }
    if (t.name === 'li' && !t.selfClosing) {
      if (t.kind === 'open') nest++
      else if (nest === 0) return src.slice(from.end, t.start)
      else nest--
    }
  }
  return src.slice(from.end, from.end + 4000)
}

/* ---------------- 纯文本缩进大纲 ---------------- */

/**
 * 缩进大纲（没有 `-` 项目符号、只靠缩进分层的 .txt）。
 *
 * 【为什么先「补项目符号」再交给 Markdown 解析器】
 * 折角标记 `[F]`、mermaid 代码块绑定、粗体斜体、图片忽略……这些规则 Markdown
 * 解析器已经有一份、也有测试守着。这里再写一遍就等于给自己留一个分叉点。
 * 所以只做一件事：把缩进换算成**规范的两空格层级**并补上 `- `，然后交给
 * `parseMarkdown`。
 *
 * 【缩进宽度不能假设是 2】
 * 记事本、IDE、从 PDF 里复制的文本，一层可能是 2/4/8 个空格或一个 tab。
 * 先量出所有正缩进的**最大公约数**当一层，`4 空格`和`8 空格`的文件都能读对；
 * 完全没有缩进的文件就一层都不加（全是并列行）。
 */
export function parseIndentOutline(text, docName = '') {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const norm = (l) => l.replace(/\t/g, '    ')
  let unit = 0
  for (const l of lines) {
    if (!l.trim()) continue
    const n = norm(l).match(/^ */)[0].length
    if (n > 0) unit = unit === 0 ? n : gcd(unit, n)
  }
  if (unit < 1) unit = 2
  if (unit > 8) unit = 8

  const out = []
  let inFence = false
  for (const raw of lines) {
    const line = norm(raw)
    // 代码围栏里的内容一个字都不能动：mermaid 源码被补上 `- ` 就毁了
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue }
    if (inFence) { out.push(line); continue }
    const m = line.match(/^( *)(\S.*)$/)
    if (!m) { out.push(line); continue }
    const level = Math.round(m[1].length / unit)
    const body = m[2].replace(/\s+$/, '')
    // 已经带项目符号 / 标题 / 引用符的行原样保留（那本来就是 Markdown）
    const marked = /^(?:[-*+]|\d+[.)])[ \t]/.test(body) || /^#{1,6}[ \t]/.test(body) || body[0] === '>'
    out.push('  '.repeat(level * 2) + (marked ? body : '- ' + body))
  }

  const parsed = parseMarkdown(out.join('\n'), docName)
  return { root: parsed.root, total: parsed.total, foldCount: parsed.foldCount, truncated: false }
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a)

/* ---------------- 离线 HTML 内嵌载荷 ---------------- */

/**
 * 从导出的离线 HTML 里取回内嵌的 JSON 载荷。
 *
 * 这是「导出的 HTML 能无损回导」的关键：光解析 HTML 结构，折角次数、mermaid
 * 源码、汇聚连线都会丢；内嵌一份 JSON 就全都在，而这个 script 标签在浏览器里
 * 打开那一页时**不显示、不执行、不影响看**（type 不是可执行类型）。
 */
export function readEmbeddedDoc(html) {
  const re = new RegExp(`<script[^>]*id=["']${EMBED_SCRIPT_ID}["'][^>]*>([\\s\\S]*?)</script>`, 'i')
  const m = re.exec(String(html ?? ''))
  if (!m) return null
  try {
    const payload = JSON.parse(m[1])
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

/* ================================================================== */
/* 三、格式识别与统一入口                                               */
/* ================================================================== */

const MD_MARKERS = /^[ \t]*(?:#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|```)/m

function tryJson(text) {
  try {
    const v = JSON.parse(String(text ?? ''))
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

const extOf = (filename) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || '').trim())
  return m ? m[1].toLowerCase() : ''
}

/**
 * 按**内容**认格式，扩展名只做兜底。
 *
 * 【为什么不能只看扩展名】
 * 用户手上的文件常常名不副实：从网页另存下来的大纲叫 `导图.html` 但内容是纯
 * `<ul>`；XMind 导出的 OPML 有人存成 `.xml`；mermaid 笔记存成 `.txt`。
 * 内容自证比文件名可靠，而认错的代价是「导进来一棵歪树」—— 比报错难发现得多。
 */
export function detectFormat(filename = '', text = '') {
  const s = String(text ?? '').replace(/^\uFEFF/, '')
  const head = s.slice(0, 8000)
  const headTrim = head.trim()
  const ext = extOf(filename)

  // 0. 空文件/纯空白：任何格式都不是。放在最前面，否则一个 0 字节的 .txt
  //    会被当成「缩进大纲」建出一篇空文档，用户只会觉得「点了没反应」。
  if (!headTrim) return FORMAT.UNKNOWN

  // 1. JSON 家族：必须整体解析成功才算数（被截断的 JSON 不是 JSON）
  if (headTrim[0] === '{' || headTrim[0] === '[') {
    const parsed = tryJson(s)
    if (!parsed) return FORMAT.UNKNOWN
    if (parsed.format === DOC_FORMAT || (parsed.root && typeof parsed.root === 'object')) return FORMAT.DOC_JSON
    if (parsed.app === 'MindFold' && Array.isArray(parsed.docs)) return FORMAT.BACKUP
    return FORMAT.UNKNOWN
  }

  // 2. XML 家族
  if (/<opml[\s>]/i.test(head) || (/<outline[\s>]/i.test(head) && /<\/opml>/i.test(s))) return FORMAT.OPML
  if (/<map[\s>]/i.test(head) && /<node[\s>]/i.test(head)) return FORMAT.FREEMIND

  // 3. HTML 家族（我们自己导出的两种都有明确标记，先认它们）
  if (/<!doctype\s+html|<html[\s>]|<body[\s>]|<h[1-6][\s>]|<[uo]l[\s>]|<li[\s>]|<div[\s>]|<p[\s>]/i.test(head)) {
    if (/mf-print-pages|mf-print-node/.test(head)) return FORMAT.PRINT_HTML
    if (new RegExp(`id=["']${EMBED_SCRIPT_ID}["']`).test(head) || /data-mindfold-export/.test(head)) {
      return FORMAT.OFFLINE_HTML
    }
    return FORMAT.HTML
  }

  // 4. 扩展名兜底
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return FORMAT.MARKDOWN
  if (ext === 'opml') return FORMAT.OPML
  if (ext === 'mm') return FORMAT.FREEMIND
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return FORMAT.HTML
  if (ext === 'json') return FORMAT.UNKNOWN
  if (ext === 'txt' || ext === 'text') return MD_MARKERS.test(s) ? FORMAT.MARKDOWN : FORMAT.OUTLINE

  // 5. 内容兜底
  if (MD_MARKERS.test(s)) return FORMAT.MARKDOWN
  /*
   * 「任何一段非空文本都是缩进大纲」这条以前写得太大方了：随便一个 `.bin`、
   * 一句中文、一段乱码都会被当成大纲收进来 —— 用户看到的是「导入了一个我没写过的
   * 文档」，比报错更让人困惑。所以内容兜底要求**至少两行有字**（一行文本没有
   * 「大纲」可言）。用户明确存的 `.txt` 不受这条限制：那是他亲手选的文件。
   */
  return s.split('\n').filter((l) => l.trim()).length >= 2 ? FORMAT.OUTLINE : FORMAT.UNKNOWN
}

/** 文件名 → 文档名（去掉扩展名、去掉路径、夹一下长度） */
export function docNameFromFile(filename) {
  const base = String(filename || '').split(/[\\/]/).pop() || ''
  return base.replace(/\.[A-Za-z0-9]+$/, '').trim().slice(0, 120)
}

/**
 * 统一导入入口：识别格式 → 解析成 Node 树。
 *
 * 返回 `{format, formatLabel, name, root, relations, total, foldCount, truncated}`。
 * 整库备份是唯一的例外：它要动 tabs / 回收站 / 文件夹，由 store.importAll 处理，
 * 所以这里只识别出来并把解析好的载荷原样返回 `backup` 字段。
 * 认不出或解析不出内容时**抛错**，错误文案是直接给用户看的一句话。
 */
export function parseDocument(text, { filename = '', name = '' } = {}) {
  const format = detectFormat(filename, text)
  const formatLabel = FORMAT_LABEL[format] || '未知格式'

  if (format === FORMAT.UNKNOWN || format === FORMAT.PRINT_HTML) {
    throw new Error(format === FORMAT.PRINT_HTML
      ? '这是打印预览页，没法当数据导入 —— 请选「离线 HTML」或「单文档 JSON」那份文件'
      : '认不出这个文件的格式（支持 Markdown / 纯文本大纲 / OPML / FreeMind / HTML / MindFold JSON）')
  }

  const clean = String(text ?? '').replace(/^\uFEFF/, '')
  const explicit = String(name || '').trim()
  const fromFile = docNameFromFile(filename)

  if (format === FORMAT.BACKUP) {
    return { format, formatLabel, backup: tryJson(clean) }
  }

  if (format === FORMAT.DOC_JSON || format === FORMAT.OFFLINE_HTML) {
    const payload = format === FORMAT.OFFLINE_HTML ? readEmbeddedDoc(clean) : tryJson(clean)
    if (!payload) throw new Error('这个文件里没有找到可用的导图数据')
    const doc = normalizeDocPayload({ ...payload, name: payload.name || explicit || fromFile || '导入的导图' })
    if (!doc) throw new Error('这个文件里的导图结构不完整，读不回来')
    let total = 0
    let foldCount = 0
    // 只数**根以下**的节点：和 Markdown / OPML / HTML 那几个解析器的 total 口径一致
    // （它们数的是「从文件里读出来了几个节点」，文档自己不算一个节点）。
    walkTree(doc.root, (n, parent) => {
      if (!parent) return
      total++
      if (n.fold) foldCount++
    })
    if (!total) throw new Error('这个文档里没有任何节点，不用导入')
    return {
      format, formatLabel, name: doc.name, root: doc.root, relations: doc.relations,
      total, foldCount, truncated: false,
    }
  }

  const mk = (built, parsedName, extraTruncated = false) => {
    // 解析成功但一个节点都没有 = 这个文件里没有内容。宁可报错，也不能建一篇
    // 空文档丢给用户（他会以为导入成功了，然后找不到任何东西）。
    if (!built.total) throw new Error('这个文件里没有任何节点，不用导入')
    return {
      format, formatLabel,
      /*
       * 文档名：调用方给的 > 文件里自带的标题 > 文件名。
       *
       * 【为什么文件自带的标题排在文件名前面】
       * OPML 的 <title>、FreeMind 的根节点、HTML 的 <title> 都是**生成这个文件的
       * 那个软件记下的文档真名**；而文件名常常是导出时自动生成的
       * （`backup.opml`、`导出(1).html`、`MindFold-2024-05-01.md`）。
       * 拿它当文档名，用户导进来只会看到一排 `导出(1)`。
       */
      name: explicit || parsedName || fromFile || '导入的导图',
      relations: [],
      root: built.root,
      total: built.total,
      foldCount: built.foldCount,
      truncated: !!(built.truncated || extraTruncated),
    }
  }

  if (format === FORMAT.MARKDOWN) {
    const p = parseMarkdown(clean, explicit || fromFile || '导入的导图')
    return mk(p, '')
  }
  if (format === FORMAT.OUTLINE) {
    const p = parseIndentOutline(clean, explicit || fromFile || '导入的导图')
    return mk(p, '')
  }
  if (format === FORMAT.OPML) {
    const p = parseOpml(clean, '')
    return mk(buildFromFlat(p.items, explicit || fromFile || p.name || '导入的导图'), p.name)
  }
  if (format === FORMAT.FREEMIND) {
    const p = parseFreeMind(clean, '')
    return mk(buildFromFlat(p.items, explicit || fromFile || p.name || '导入的导图'), p.name)
  }
  // FORMAT.HTML
  const p = parseHtml(clean, '')
  return mk(buildFromFlat(p.items, explicit || fromFile || p.name || '导入的导图'), p.name, p.truncated)
}
