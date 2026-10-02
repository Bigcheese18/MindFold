/**
 * MindFold 数据模型 & Markdown 解析
 * =================================
 *
 * 【数据结构总览】
 *
 * Doc (一个文档 / 一个标签页)
 *   id          string        文档唯一 id
 *   name        string        文件名（不含扩展名）
 *   path        string        逻辑路径，如 "学习/计算机网络"
 *   root        Node          大纲树的根节点
 *   theme       'white'|'sepia'|'dark'
 *   view        { x, y, zoom }  画布视口
 *   relations   Relation[]    「指向同一结果」的汇聚虚线（可选，缺省视为 []）
 *
 * Relation (主画布上的一条关联虚线)
 *   from        string        出发节点 id
 *   to          string        汇聚节点 id
 *
 * 【relations 为什么挂在 Doc 上，而不是 Node 上】
 * 它是**树之外**的附加边：`Node` 只有 children，天然只能表达「单父节点」。
 * 把多对一塞进 Node 会立刻破坏树的不变量 —— `layoutTree` 按 children 算布局、
 * `cloneTree` / `sameCanvasTree` / `normalizeNode` / `fingerprint` 全都按树遍历，
 * 任何一个漏改都会出问题。挂在 Doc 上则与树并列，上面这些函数一行都不用动。
 *
 * **绝不能**把 A、B 变成新节点的子节点来「表达」汇聚 —— 那会真的拆掉原树。
 * 虚线只是视觉层，树结构必须保持原样。
 *
 * Node (一个折角单位 = 导图上的一个节点)
 *   id          string
 *   text        string        节点纯文本（末尾的 [F] 标记已被剥离）
 *   children    Node[]
 *   collapsed   boolean       是否折叠子树
 *   bold/italic boolean       基础样式（右键菜单 Ctrl+B / Ctrl+I）
 *   fold        Fold | null   折角数据。null = 没有折角
 *
 * Fold (折角 —— 产品灵魂)
 *   corner      boolean       true=实心折角（有 mermaid 代码）；false=空心虚线折角
 *   openCount   number        打开次数，驱动颜色分级：0灰 / 1-2蓝 / 3-4橙 / 5+红
 *   mermaid     string        Mermaid 源码（经缩进列表编译后的结果）
 *   outline     string        缩进列表原文（傻瓜模式的源头，可往返）
 *   updatedAt   number
 *
 * 【Markdown 识别规则（硬编码，绝不做语义识别）】
 *   1. 标题 # ~ ######、无序列表 - / * / +、有序列表 1. 都视为节点。
 *   2. 行尾出现 [F] 或 [[折角]] → 该节点有折角。
 *   3. 该行下方紧跟的 ```mermaid 代码块 → 绑定为折角的流程图。
 *   4. 有 [F] 但没有代码块 → 空心虚线折角。
 *   5. 图片 ![](...) 与 <img> 直接忽略（纯文本理念）。
 */

export const FOLD_MARK = /(\[\[折角\]\]|\[F\])\s*$/

/* 节点外形（方框 / 菱形 / 数据库 …）。表在 shapes.js，三处编译共用一张 */
export {
  SHAPES, shapeOf, isShape, parseShapeName, readNodeShape, nextShape, shapeMark,
} from './shapes.js'
import { splitShapeMark, shapeOf, readNodeShape, isShape, shapeMark, SHAPES } from './shapes.js'
/** 正则转义（shapeOf 表里的括号要原样匹配 `[` `(` `{` 这些元字符） */
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

let _seq = 0
export const uid = (p = 'n') => `${p}_${Date.now().toString(36)}_${(_seq++).toString(36)}`

export function makeNode(text = '', children = []) {
  return { id: uid(), text, children, collapsed: false, bold: false, italic: false, fold: null }
}

export function makeFold({ corner = true, outline = '', mermaid = '' } = {}) {
  return { corner, openCount: 0, mermaid, outline, updatedAt: Date.now() }
}

/* ------------------------------------------------------------------ */
/* 缩进列表 <-> Mermaid 双向编译（傻瓜模式核心）                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 括号引用语法：(-> 目标节点)                                          */
/* ------------------------------------------------------------------ */
/*
 * 缩进列表天然只能表达「单父节点」的树，但流程图经常有「多对一」：
 *
 *   - 服务端未收到 ACK (-> 断开连接)
 *   - 客户端主动关闭   (-> 断开连接)
 *
 * 两条边都指向同一个「断开连接」，右侧图会自动汇聚。
 *
 * 这是**硬编码标记**，和 [F] / [[折角]] 一样绝不做语义识别 ——
 * 只有出现 `(->` 才算引用，普通括号（如「处理(特殊)情况」）原样保留。
 *
 * 支持三种写法：
 *   (-> 断开连接)          ASCII 括号 + ASCII 箭头
 *   （-> 断开连接）        全角括号（中文输入法下很常见）
 *   (→ 断开连接)           Unicode 箭头
 *   (-> "带)括号的名字")    目标名含特殊字符时用引号包起来
 *   (-> 结束#2)            目标重名时指定「第 2 个叫『结束』的节点」
 */

/** 把引用对象还原成文本写法 */
export function formatRef(ref) {
  const name = ref.target
  // 名字里出现括号/井号/引号/首尾空格时，必须用引号包起来才能被重新解析
  const needsQuote = /[()（）#"]/.test(name) || name !== name.trim()
  const body = needsQuote ? `"${name.replace(/"/g, '')}"` : name
  const occ = ref.occurrence > 1 ? `#${ref.occurrence}` : ''
  return `(-> ${body}${occ})`
}

/**
 * 扫描一行文字里的所有引用。
 * 用字符扫描而不是正则：目标名可能被引号包住，里面还会出现 `)`，
 * 正则很难正确处理这种嵌套。
 *
 * @returns {{ refs: {target, occurrence}[], spans: [start, end][] }}
 */
export function scanRefs(text) {
  const s = String(text ?? '')
  const refs = []
  const spans = []
  let i = 0

  while (i < s.length) {
    const open = s[i]
    if (open !== '(' && open !== '（') { i++; continue }
    const close = open === '(' ? ')' : '）'

    let j = i + 1
    while (j < s.length && /\s/.test(s[j])) j++
    if (s[j] === '-' && s[j + 1] === '>') j += 2
    else if (s[j] === '→') j += 1
    else { i++; continue }   // 只是普通括号，跳过

    // 从箭头后收集到配对的右括号；引号内的括号不算配对
    let depth = 1
    let quote = null
    let body = ''
    let closed = false
    while (j < s.length) {
      const c = s[j]
      if (quote) {
        if (c === quote) quote = null
        else body += c
        j++
        continue
      }
      if (c === '"' || c === "'") { quote = c; j++; continue }
      if (c === open) { depth++; body += c; j++; continue }
      if (c === close) {
        depth--
        if (depth === 0) { closed = true; break }
        body += c
        j++
        continue
      }
      body += c
      j++
    }
    if (!closed) { i++; continue }

    const ref = parseRefBody(body)
    if (ref) {
      refs.push(ref)
      spans.push([i, j + 1])
    }
    i = j + 1
  }

  return { refs, spans }
}

/** 解析引用体：` 名称 ` / `名称#2` / `"带)括号"#2` */
function parseRefBody(body) {
  let s = String(body ?? '').trim()
  if (!s) return null

  // 尾部重名序号： #2
  let occurrence = 1
  const om = s.match(/#\s*(\d+)\s*$/)
  if (om) {
    occurrence = Math.max(1, parseInt(om[1], 10))
    s = s.slice(0, om.index).trim()
  }
  // 去掉包裹的引号
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    s = s.slice(1, -1).trim()
  }
  if (!s) return null
  return { target: s, occurrence }
}

/** 去掉一行文字里的所有引用标记，得到「图上显示的纯文字」 */
export function stripRefs(text) {
  const s = String(text ?? '')
  const { spans } = scanRefs(s)
  if (!spans.length) return s.trim()
  let out = ''
  let last = 0
  for (const [a, b] of spans) {
    out += s.slice(last, a)
    last = b
  }
  out += s.slice(last)
  // 去掉引用后可能留下多余空格
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

/* ------------------------------------------------------------------ */
/* 缩进列表 → Mermaid                                                   */
/* ------------------------------------------------------------------ */

/**
 * 把缩进列表编译成 Mermaid flowchart。
 * 输入示例：
 *   TCP 三次握手
 *     第一次握手
 *       SYN=1
 *     第二次握手
 * 输出：flowchart TD\n  n0["TCP 三次握手"]\n  n0 --> n1["第一次握手"] ...
 *
 * 约定：缩进用 2 空格（Tab 也按 2 空格折算）。缩进跳级时挂到最近的上级。
 *
 * 输出分成三段，而不是「定义一行、连线一行」交错：
 *   1. 全部节点定义
 *   2. 树边（缩进产生的父子关系）
 *   3. 引用边（(-> 目标)）
 * 交错输出会让引用边在目标节点定义之前出现，可读性很差。
 */
export function outlineToMermaid(outline, direction = 'TD') {
  const nodes = parseOutline(outline)

  if (!nodes.length) return ''

  const esc = (s) => s.replace(/"/g, '&quot;')
  const out = [`flowchart ${direction}`]

  // 1. 节点定义。用 ["..."] 包裹，避免中文/括号/箭头被 mermaid 解析成语法。
  //    外形（{判断} / {数据库} …）在这里决定用哪一对括号；
  //    没有外形标记的节点仍然是 ["..."]，和以前逐字节相同。
  for (const n of nodes) {
    out.push(`  ${n.id}${shapeOf(n.shape).mermaid[0]}${esc(n.label)}${shapeOf(n.shape).mermaid[1]}`)
  }

  // 2. 树边
  const emitted = new Set()
  for (const n of nodes) {
    if (!n.parentId) continue
    emitted.add(`${n.parentId}\u0000${n.id}`)
    out.push(`  ${n.parentId} --> ${n.id}`)
  }

  // 3. 引用边（多对一 / 交叉连线）。和树边重复的就不再输出。
  for (const n of nodes) {
    for (const r of n.refs) {
      if (!r.targetId) continue
      const key = `${n.id}\u0000${r.targetId}`
      if (emitted.has(key)) continue
      emitted.add(key)
      out.push(`  ${n.id} --> ${r.targetId}`)
    }
  }

  return out.join('\n')
}

/**
 * 缩进列表 → 节点数组（编辑器渲染与 Mermaid 编译共用同一份解析结果，
 * 保证「左边看到的层级」和「右边生成的图」永远是同一棵树）。
 *
 * 约定：缩进用 2 空格（Tab 折算成 2 空格）；缩进跳级时挂到最近的上级。
 *
 * @returns {{ id, label, rawLabel, refs, depth, parentId, lineIndex, childCount, hasChildren }[]}
 *   label    去掉引用标记后的纯文字（图上显示的就是它）
 *   rawLabel 原始行文字（含 (-> 目标)）
 *   refs     [{ target, occurrence, targetId, resolved, ambiguous }]
 */
export function parseOutline(outline) {
  const lines = String(outline || '').split('\n')
  const nodes = []   // 只含非空行
  const stack = []   // stack[depth] = nodeId

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex]
    if (!raw.trim()) continue

    const expanded = raw.replace(/\t/g, '  ')
    const indent = expanded.match(/^ */)[0].length
    const depth = Math.floor(indent / 2)
    // 去掉列表符号，保持极简
    const rawLabel0 = expanded.trim().replace(/^([-*+]|\d+[.)])\s+/, '')
    // 行尾外形标记：`第一次握手 {判断}` → 外形=菱形、文字=`第一次握手`。
    // 只认行尾、且名字在已知表里，所以 `【重要】`、`{待定}` 这类正文一个字符都不动。
    const sm = splitShapeMark(rawLabel0)
    const rawLabel = sm.text
    // 引用标记不参与「显示文字」，但必须留在 rawLabel 里
    const label = stripRefs(rawLabel)
    // 只有引用、没有文字的行是无效节点（图上会是个空框），直接跳过
    if (!label) continue

    const id = `n${nodes.length}`
    let parentId = null
    for (let d = depth - 1; d >= 0; d--) {
      if (stack[d] !== undefined) { parentId = stack[d]; break }
    }

    // 缩进了却找不到任何上级（典型情况：第一行就带缩进）。
    // 若不兜底，它会变成第二个根节点 —— 在图上就是一块断开的孤岛。
    // 挂到最近的前一个节点上，至少保证整张图是连通的。
    if (parentId === null && depth > 0 && nodes.length) {
      parentId = nodes[nodes.length - 1].id
    }

    stack.length = depth + 1
    stack[depth] = id
    nodes.push({
      id, label, rawLabel, refs: scanRefs(rawLabel).refs,
      depth, parentId, lineIndex, childCount: 0,
      shape: sm.shape || 'rect',
      // 写了标记但认不出（`{待定}`）—— 记下来供编辑器提示，但绝不改文档
      shapeRaw: sm.shape ? null : sm.raw,
    })
  }

  // 回填 childCount（渲染折叠三角要用）
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) byId.get(n.parentId).childCount++
  }
  for (const n of nodes) n.hasChildren = n.childCount > 0

  // 解析引用目标。必须在收集完所有节点之后再做 ——
  // 引用可以指向写在后面的节点（前向引用）。
  const byLabel = new Map()
  for (const n of nodes) {
    if (!byLabel.has(n.label)) byLabel.set(n.label, [])
    byLabel.get(n.label).push(n.id)
  }
  for (const n of nodes) {
    n.refs = n.refs.map((r) => {
      const ids = byLabel.get(r.target) || []
      // 重名时按出现顺序取第 occurrence 个；越界就退回最后一个，不静默丢弃
      const pick = ids.length ? ids[Math.min(r.occurrence, ids.length) - 1] : null
      return {
        ...r,
        targetId: pick,
        resolved: pick !== null,
        // 重名 → 提示用户（同名节点在图上本来就难分辨）
        ambiguous: ids.length > 1,
      }
    })
  }

  return nodes
}

/**
 * 读缩进列表里第 `rowIndex` 个节点（按图上的行序）当前的外形。
 *
 * 【为什么用 parseOutline 而不是「数第几行非空」】
 * parseOutline 会**跳过只有引用标记、没有文字的行**（那不成节点）。
 * 若这里自己数行，遇到那种行就会和 rowIds 错位一格 ——
 * 症状是「改了形状，结果改到隔壁节点上」，很难查。
 * parseOutline 返回的 lineIndex 就是权威的「第几个节点在第几行」。
 */
export function shapeAtOutlineRow(outline, rowIndex) {
  const nodes = parseOutline(outline)
  return nodes[rowIndex]?.shape ?? null
}

/**
 * 改缩进列表里第 `rowIndex` 个节点的外形，其余行一个字不动。
 *
 * 只换行尾那个 `{…}` 标记：
 *   1. 复现 parseOutline 的拆解（去列表符号 → 摘旧形状标记）得到正文；
 *   2. 用 scanRefs 的**真实下标**把 `(-> …)` 引用切出来 ——
 *      不能用 stripRefs 的长度去切片，它会 trim + 合并空格，偏移对不上；
 *   3. 拼回 `正文 + 新标记 + 引用`。rect 是默认外形 → 标记为空串。
 *
 * 行首缩进、列表符号、引用全部原样保留。标记永远在**引用之前**，
 * 因为 parseOutline 也是先摘形状、再 scanRefs 的。
 */
export function setShapeInOutline(outline, rowIndex, key) {
  if (!isShape(key)) return String(outline ?? '')
  const src = String(outline ?? '')
  const node = parseOutline(src)[rowIndex]
  if (!node) return src

  const lines = src.split('\n')
  const raw = lines[node.lineIndex]
  if (raw === undefined) return src

  /**
   * 【必须用原始行取缩进和列表符号，不能借 parseOutline 的中间量】
   * parseOutline 内部把 Tab 折成 2 空格、又 trim 掉了行首 ——
   * 照抄那套的话，用 Tab 缩进的文档会在被改的那一行悄悄变成空格，
   * 而 `- ` / `1. ` 这种列表符号会被整段吃掉。
   * 只换形状标记，缩进和符号一律原样搬过去。
   */
  const indentRaw = raw.match(/^[ \t]*/)[0]
  const afterIndent = raw.slice(indentRaw.length)
  const bulletM = afterIndent.match(/^([-*+]|\d+[.)])[ \t]+/)
  const bullet = bulletM ? bulletM[0] : ''
  // 和 parseOutline 同口径：去掉缩进与列表符号后再摘形状标记
  const rawLabel = splitShapeMark(afterIndent.slice(bullet.length).trim()).text

  const { spans } = scanRefs(rawLabel)
  const base = (spans.length ? rawLabel.slice(0, spans[0][0]) : rawLabel).trimEnd()
  const refsPart = spans.length ? rawLabel.slice(spans[0][0]) : ''

  const mark = shapeMark(key)
  lines[node.lineIndex] = indentRaw + bullet + base + mark + (refsPart ? ' ' + refsPart : '')
  return lines.join('\n')
}

/**
 * 反向：Mermaid flowchart → 缩进列表。
 * 仅用于「用户手写了 mermaid 代码，想回到缩进列表编辑」的场景。
 *
 * 实现要点：不能用一个「节点定义正则」加一个「边正则」分别扫同一行 ——
 * A["x"] --> B 里 B 会被前一个正则的贪婪匹配吃掉。这里先把两类记号
 * 都替换成占位符，再把剩下的裸标识符补全，最后统一解析。
 * 解析失败时返回 null，调用方保留原源码即可。
 *
 * 【多对一 / 交叉连线怎么保住】
 * 见下面「生成森林」那一段：额外边会被写成 (-> 目标) 引用，
 * 所以 A-->C、B-->C 这种结构往返一次不会丢边。
 *
 * @returns {{
 *   outline: string,
 *   rowIds: string[],             行下标 → mermaid 节点 id（点图定位行要用）
 *   warnings: string[],
 *   lossless: boolean,
 *   suggestCodeMode: boolean,
 *   stats: object,
 * } | null}
 */
export function mermaidToOutlineEx(src) {
  const text = String(src || '')
  if (!/^\s*(flowchart|graph)\s/m.test(text)) return null

  const labels = new Map()
  const order = []
  const edges = []
  /**
   * 节点外形。mermaid 的括号对本身就带着形状语义
   * （`A{"x"}` 是菱形、`B([\"y\"])` 是胶囊），这里顺手读出来。
   * 读不出来的（裸 id、或 mermaid 认的形状我们没有对应）留空 → 按方框算。
   */
  const shapeOfNode = new Map()

  const note = (id, label) => {
    if (!labels.has(id)) order.push(id)
    if (label !== undefined) labels.set(id, label)      // 显式定义优先
    else if (!labels.has(id)) labels.set(id, id)        // 裸 id 占位
  }

  // id 允许连字符与中文：mermaid 里 `node-1`、`开始` 都是合法 id。
  // 早先只认 [A-Za-z0-9_]，会把 node-1 从横线处切成 `node` + `1` 两个节点。
  //
  // 【连字符只能出现在 id 内部，且不能连续】
  // 这条限制是必须的：`-` 同时是箭头的组成部分，而正则从左往右匹配时
  // `[A-Za-z0-9_-]+` 会**贪心地把 `A-->B` 吃成 id `A--`**，于是
  //   · 节点表变成 3 个（A / B / A--）
  //   · 边表变成 0 条
  // 手写 `A-->B`（不加空格，mermaid 官方文档的写法）本来是最常见的写法，
  // 结果整张图在双轨制里被拆成三棵孤立的树。
  // 改成「单个连字符 + 必须有后续 id 字符」后：`node-1` 仍是完整 id，
  // 而 `A--` 匹配不出来，`A-->B` 就能正常切成 A / --> / B。
  const ID = '[A-Za-z0-9_\\u4e00-\\u9fa5](?:-?[A-Za-z0-9_\\u4e00-\\u9fa5])*'
  /**
   * 节点定义。
   *
   * 【为什么从 SHAPES 表里生成，而不是手写一串括号】
   * 外形表里有 13 种括号对，手写必然和 shapes.js 漂移 ——
   * 一旦漂移，症状是「图能画出来，但切回缩进列表文字就丢了」，
   * 而且只在那一种外形上发作，极难发现。生成出来就不可能不一致。
   *
   * 【排序：开括号长的优先】
   * `((("x")))`（双圆）必须先于 `(("x"))`（圆）、`(["x"])`（胶囊）必须先于
   * `("x")`（圆角），否则会把双圆认成圆。
   *
   * 【两处共用开括号怎么办】
   * lean_left(`[\"`…`"\]`) 和 inv_trapezoid(`[\"`…`"/]`) 开括号相同、闭括号不同。
   * 因为整个片段（含闭括号）一起参与匹配，正则回溯会自己选对的那个。
   *
   * 【后面跟的老写法不能删】
   * 无引号 `A[x]` / `A(x)` / `A{x}` / `A((x))` 是手写 mermaid 的常见写法，
   * 老 DEF 就认，`codeLineMap` / `codeOps` 的测试全压在这上面。
   */
  const SHAPE_ALTS = SHAPES
    .map((s) => [s.mermaid[0], s.mermaid[1]])
    .sort((a, b) => b[0].length - a[0].length)
    .map(([o, c]) => `${escRe(o)}([^"]*)${escRe(c)}`)
  // 无引号老写法（顺序：双括号先于单括号）
  const LEGACY_ALTS = ['\\(\\(([^)]*)\\)\\)', '\\[([^\\]]*)\\]', '\\(([^)]*)\\)', '\\{([^}]*)\\}']
  const DEF = new RegExp(
    `(${ID})\\s*(?:${[...SHAPE_ALTS, ...LEGACY_ALTS].join('|')})`, 'g'
  )
  const BARE = new RegExp(ID, 'g')
  /**
   * 箭头。按「长的优先」排列：
   *   --|文字|-->   -- 文字 -->   -->   ==>   -.->   ---
   * 注意 `--+` 放在最后，避免把 `-->` 拆成 `--` + `>`。
   */
  const ARROW = /--+\s*\|[^|]*\|\s*--+>|--+\s*[^->\s][^->]*?\s*--+>|--+>|==+>|-\.->|--+/g
  // 这些行是样式 / 子图声明，不产生节点
  const META = /^(classDef|class|style|linkStyle|subgraph|end|direction|click|linkStyle)\b/i
  // 边上的标签（-->|说明| B），不是节点
  const EDGE_LABEL = /\|[^|]*\|/g

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || /^(flowchart|graph)\s/i.test(line) || line.startsWith('%%')) continue
    if (META.test(line)) continue

    // --- 1. 收集本行所有「节点出现」（位置 + id + 可选标签）---
    const occ = []
    let m
    DEF.lastIndex = 0
    while ((m = DEF.exec(line))) {
      /**
       * 标签在第几个捕获组？
       * 生成出来的 DEF 有 1 + 13 + 4 个组，**命中哪一个取决于用了哪种括号**，
       * 组号不固定。所以扫一遍所有组、取第一个「被匹配到的」。
       * 注意判据必须是 `!== undefined`：空标签 `A[""]` 的值是空串，
       * 用 truthy 判断会把它当成「没匹配到」而退化成裸 id。
       */
      const g = m.slice(2).find((x) => x !== undefined)
      const label = String(g ?? '').trim().replace(/^["']|["']$/g, '')
      occ.push({ start: m.index, end: m.index + m[0].length, id: m[1], label })
      // 外形：用节点自己的定义段去反查，认不出就不记（→ 方框）
      const sh = readNodeShape(m[0], m[1])
      if (sh && isShape(sh.key)) shapeOfNode.set(m[1], sh.key)
    }

    // 把已识别的「定义段」挖成等长空格，再找裸标识符。
    // 保持长度不变，这样后面的箭头位置仍然对得上原始坐标。
    let blanked = line
    for (const o of [...occ].sort((a, b) => b.start - a.start)) {
      blanked = blanked.slice(0, o.start) + ' '.repeat(o.end - o.start) + blanked.slice(o.end)
    }
    // 边标签也要挖掉，否则 `-->|说明| B` 里的「说明」会被当成一个节点
    blanked = blanked.replace(EDGE_LABEL, (s) => ' '.repeat(s.length))

    BARE.lastIndex = 0
    while ((m = BARE.exec(blanked))) {
      occ.push({ start: m.index, end: m.index + m[0].length, id: m[0], label: undefined })
    }
    occ.sort((a, b) => a.start - b.start)
    // 按出现顺序登记，保证 order 反映从左到右的书写顺序
    for (const o of occ) note(o.id, o.label)

    // --- 2. 箭头：连到它前面最近、后面最近的节点 ---
    // 关键：不能「匹配一条边就消费掉右端 id」，否则 A --> B --> C 里的
    // B --> C 会被吃掉，C 变成没有父节点的第二个根 —— 图上就多出一个断开的孤块。
    ARROW.lastIndex = 0
    while ((m = ARROW.exec(blanked))) {
      const aStart = m.index
      const aEnd = m.index + m[0].length
      let from = null
      for (const o of occ) { if (o.end <= aStart) from = o; else break }
      let to = null
      for (const o of occ) { if (o.start >= aEnd) { to = o; break } }
      // 自环 A --> A 是合法写法（重试 / 回退到自身），必须保留。
      // 早先这里挡了 from.id !== to.id，导致自环被静默丢掉 ——
      // 往返一圈后那条边就没了。
      if (from && to) edges.push([from.id, to.id])
    }
  }

  if (!labels.size) return null

  // ---- 去重边，保持书写顺序 ----
  const uniq = []
  const seenEdge = new Set()
  for (const [a, b] of edges) {
    const k = `${a}\u0000${b}`
    if (seenEdge.has(k)) continue
    seenEdge.add(k)
    uniq.push([a, b])
  }

  // ---- 邻接表 + 入度 ----
  const childrenOf = new Map()
  const indeg = new Map()
  for (const id of order) indeg.set(id, 0)
  for (const [a, b] of uniq) {
    if (!childrenOf.has(a)) childrenOf.set(a, [])
    childrenOf.get(a).push(b)
    indeg.set(b, (indeg.get(b) || 0) + 1)
  }

  /**
   * 生成森林 —— 「多对一 / 交叉连线」能往返不丢的关键。
   *
   * 老实现用 `seen` 把图**压平**成一棵树：A-->C、B-->C 会退化成
   * 「A 带子节点 C」+「孤立的 B」，B-->C 这条边直接消失。
   * 现在改成把图拆成「一棵生成树 + 若干条额外边」，
   * 额外边用 (-> 目标) 写回缩进列表，信息一点不丢。
   *
   * 根的选择：优先入度为 0 的节点。纯环（每个节点都有入边）没有入度 0 的节点，
   * 就按书写顺序挑一个当「伪根」，环里其余的边自然成为额外边 —— 环也能表达。
   */
  const visited = new Set()
  const treeEdge = new Set()      // "a\0b"
  const treeChildren = new Map()
  const roots = []

  const dfs = (id) => {
    visited.add(id)
    for (const c of childrenOf.get(id) || []) {
      if (visited.has(c)) continue
      visited.add(c)
      treeEdge.add(`${id}\u0000${c}`)
      if (!treeChildren.has(id)) treeChildren.set(id, [])
      treeChildren.get(id).push(c)
      dfs(c)
    }
  }
  for (const id of order) {
    if ((indeg.get(id) || 0) === 0 && !visited.has(id)) { roots.push(id); dfs(id) }
  }
  for (const id of order) {
    if (!visited.has(id)) { roots.push(id); dfs(id) }   // 纯环 → 伪根
  }

  // ---- 额外边 → 引用 ----
  const extraOf = new Map()
  for (const [a, b] of uniq) {
    if (treeEdge.has(`${a}\u0000${b}`)) continue
    if (!extraOf.has(a)) extraOf.set(a, [])
    extraOf.get(a).push(b)
  }

  // ---- 同名节点的出现序号（重名时引用必须写 #n 才不歧义）----
  const totalByName = new Map()
  const occByName = new Map()
  for (const id of order) {
    const L = labels.get(id)
    totalByName.set(L, (totalByName.get(L) || 0) + 1)
    occByName.set(id, totalByName.get(L))
  }

  const warnings = []
  let lossless = true

  const refTextOf = (b) => {
    const L = labels.get(b)
    const total = totalByName.get(L) || 1
    const occ = occByName.get(b) || 1
    // 名字里同时有单双引号时没法安全地写进引用 —— 极罕见，但要如实报告
    if (/["']/.test(L) && L.includes('"') && L.includes("'")) {
      lossless = false
      warnings.push(`节点「${L}」的名字里同时有单引号和双引号，无法用 (-> ...) 引用`)
    }
    return formatRef({ target: L, occurrence: total > 1 ? occ : 1 })
  }

  // ---- 输出缩进列表 ----
  const out = []
  const rowIds = []
  const walk = (id, depth) => {
    const refs = extraOf.get(id) || []
    let line = '  '.repeat(depth) + labels.get(id)
    // 外形写在行尾。rect 是默认外形 —— 不写标记，
    // 所以「本来就没有外形的图」编译出来和以前逐字节相同。
    const shapeKey = shapeOfNode.get(id)
    if (shapeKey && shapeKey !== 'rect') line += shapeMark(shapeKey)
    if (refs.length) line += ' ' + refs.map(refTextOf).join(' ')
    out.push(line)
    rowIds.push(id)
    for (const c of treeChildren.get(id) || []) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)

  // ---- 复杂度评估：太乱就建议直接用代码模式 ----
  const cycle = hasCycle(order, childrenOf)
  const refEdges = uniq.length - treeEdge.size
  let ambiguous = 0
  for (const [, ids] of extraOf) {
    for (const b of ids) if ((totalByName.get(labels.get(b)) || 1) > 1) ambiguous++
  }
  if (cycle) warnings.push('图里有环（A→B→A 这类），缩进列表只能把回边写成 (-> ...) 引用')
  if (ambiguous) warnings.push(`有 ${ambiguous} 条引用指向重名节点，已用 #序号 区分`)

  /**
   * 什么时候建议切到代码模式：
   *   · 有环 —— 树状思维本来就不适合表达循环
   *   · 交叉引用占比很高 —— 缩进列表里会全是 (-> ...)，反而更难读
   *   · 引用指向重名节点 —— 需要靠 #序号 消歧义，容易写错
   */
  const suggestCodeMode = cycle || ambiguous > 0 ||
    (refEdges >= 3 && refEdges > order.length * 0.4)

  return {
    outline: out.join('\n'),
    rowIds,
    warnings,
    lossless,
    suggestCodeMode,
    stats: {
      nodes: order.length,
      edges: uniq.length,
      treeEdges: treeEdge.size,
      refEdges,
      roots: roots.length,
      cycles: cycle ? 1 : 0,
      ambiguous,
    },
  }
}

/** 有向图里有没有环（三色 DFS 找回边） */
function hasCycle(order, childrenOf) {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map(order.map((id) => [id, WHITE]))
  let found = false
  const visit = (id) => {
    color.set(id, GRAY)
    for (const c of childrenOf.get(id) || []) {
      const col = color.get(c) ?? WHITE
      if (col === GRAY) { found = true; return }
      if (col === WHITE) { visit(c); if (found) return }
    }
    color.set(id, BLACK)
  }
  for (const id of order) {
    if (found) break
    if (color.get(id) === WHITE) visit(id)
  }
  return found
}

/**
 * 兼容入口：只要缩进列表文本。
 * 需要 warnings / stats / suggestCodeMode 时用 mermaidToOutlineEx。
 */
export function mermaidToOutline(src) {
  return mermaidToOutlineEx(src)?.outline ?? null
}

/* ------------------------------------------------------------------ */
/* Markdown 解析                                                        */
/* ------------------------------------------------------------------ */

/**
 * 「折角 → 代码块」的归属管理器。
 *
 * 为什么不能简单地「遇到任何节点就清空候选」：真实文档里，带折角的节点
 * 几乎总是长这样 ——
 *
 *   - TCP 三次握手 [F]
 *     - 第一次握手        ← 子节点先出现
 *     - 第二次握手
 *
 *     ```mermaid          ← 代码块跟在子节点后面
 *     ...
 *     ```
 *
 * 但也不能「无限期保留候选」，否则一段跟谁都无关的 mermaid 代码块会被
 * 错误地绑到很远处的某个折角上（PRD 要求的是「紧跟」）。所以用**层级**判断：
 * 当新节点出现时，深度 ≥ 它的候选都已离开自己的子树，直接丢弃。
 *
 *   A(depth1) 遇到 子节点(depth2) → 2 > 1，A 仍在自己的子树内，保留
 *   A(depth1) 遇到 B(depth1)      → 1 ≥ 1，A 的子树已结束，丢弃
 *
 * 嵌套折角靠 LIFO 正确处理：内层折角后进先出，先拿到属于自己的代码块。
 */
function makeFoldRegistry() {
  const open = [] // { node, depth }，越靠后越深
  return {
    add(node, depth) { open.push({ node, depth }) },

    /** 新节点入栈时，丢弃所有已经离开自己子树的候选 */
    prune(depth) {
      while (open.length && open[open.length - 1].depth >= depth) open.pop()
    },

    /** 取最近的未绑定折角节点（LIFO → 嵌套时先满足内层） */
    take() {
      while (open.length) {
        const { node } = open.pop()
        if (node.fold && !node.fold.mermaid) return node
      }
      return null
    },
  }
}

function stripImages(line) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // ![alt](url)
    .replace(/<img[^>]*>/gi, '')          // <img ...>
    .replace(/^\s*\[[^\]]*\]\([^)]*\)\s*$/, '') // 整行只有链接 → 丢弃
}

/**
 * 代码块常常因为挂在列表项下面而整体缩进。
 * 去掉所有行共有的最小缩进，否则 mermaid 会把缩进当成语法错误。
 */
function stripFenceIndent(lines) {
  const indents = lines
    .filter((l) => l.trim())
    .map((l) => l.match(/^[ \t]*/)[0].replace(/\t/g, '  ').length)
  if (!indents.length) return lines
  const min = Math.min(...indents)
  if (min === 0) return lines
  return lines.map((l) => l.slice(Math.min(min, l.match(/^[ \t]*/)[0].length)))
}

/**
 * 清洗行内标记，同时把 Markdown 的粗体/斜体识别成节点样式。
 *
 * 返回 { text, bold, italic } 而不是裸字符串 —— 这样 `toMarkdown` 才能把
 * 样式写回去，导出与导入互为逆运算（README 里承诺的「互逆」靠这个成立）。
 * 判定用「先探测、后剥离」：探测必须在剥离之前，否则标记已经没了。
 */
function cleanInline(line) {
  const stripped = line
    .replace(/^\s*>\s?/, '')                 // 引用
    .replace(/^\s*([-*+]|\d+[.)])\s+/, '')   // 列表符号

  const bold = /\*\*[^*]+\*\*/.test(stripped)
  // 斜体：单个 * 包裹，且前面不是 *（避免把 ** 粗体误判成斜体）
  const italic = /(^|[^*])\*[^*\n]+\*/.test(stripped)

  const text = stripped
    .replace(/\*\*(.+?)\*\*/g, '$1')         // 粗体
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2') // 斜体
    .replace(/`([^`]+)`/g, '$1')             // 行内代码
    .replace(/\s+$/, '')

  return { text, bold, italic }
}

/**
 * 解析 Markdown → Node 树
 * @returns {{ root: Node, foldCount: number, total: number }}
 */
export function parseMarkdown(md, docName = '未命名') {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n')
  const root = makeNode(docName)
  const stack = [{ depth: -1, node: root }]

  let foldCount = 0
  let total = 0
  const registry = makeFoldRegistry() // 管理「折角 → 代码块」的归属

  const pushNode = (text, depth) => {
    // 新节点入栈前先清理已离开子树的折角候选
    registry.prune(depth)
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop()
    const parent = stack[stack.length - 1].node
    const node = makeNode(text)
    parent.children.push(node)
    stack.push({ depth, node })
    total++
    return node
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]

    // --- mermaid 代码块：绑定给最近的、尚未绑定代码块的折角节点 ---
    // 注意：这里必须用「经典 for + let i」，因为读到围栏后要跳过整个代码块。
    // 用 for...of 遍历（无论是 entries() 还是普通元素）都无法回写索引。
    const fence = rawLine.trim().match(/^```+\s*(mermaid|mmd)?\s*$/i)
    if (fence) {
      const isMermaid = /mermaid|mmd/i.test(fence[1] || '')
      const body = []
      let j = i + 1
      while (j < lines.length && !/^\s*```+\s*$/.test(lines[j])) { body.push(lines[j]); j++ }
      if (isMermaid) {
        const target = registry.take()
        if (target) {
          target.fold.mermaid = stripFenceIndent(body).join('\n').trim()
          target.fold.corner = true
          target.fold.outline = mermaidToOutline(target.fold.mermaid) || ''
        }
      }
      i = j // 跳过整个代码块（j 指向收尾围栏，循环自增后正好落到它后面）
      continue
    }

    const noImage = stripImages(rawLine)
    if (!noImage.trim()) {
      // 空行不打断「折角 → 代码块」的绑定：markdown 里 [F] 与 ``` 之间
      // 通常隔着空行（尤其挂在列表项下面时），否则代码块永远绑不上。
      continue
    }

    // --- 标题 # ~ ###### ---
    const heading = noImage.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const depth = heading[1].length - 1
      const { text, bold, italic } = cleanInline(heading[2])
      const hasFold = FOLD_MARK.test(text)
      const node = pushNode(text.replace(FOLD_MARK, '').trim(), depth)
      node.bold = bold
      node.italic = italic
      if (hasFold) {
        node.fold = makeFold({ corner: false })
        registry.add(node, depth)
        foldCount++
      }
      continue
    }

    // --- 列表项 / 普通段落 ---
    const li = noImage.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    const indent = li ? li[1].replace(/\t/g, '  ').length : 0
    const depth = 1 + Math.floor(indent / 2)
    const { text, bold, italic } = cleanInline(li ? li[3] : noImage)

    // 去掉折叠标记后再判断是否为空
    const hasFold = FOLD_MARK.test(text)
    const label = text.replace(FOLD_MARK, '').trim()
    if (!label) continue

    const node = pushNode(label, depth)
    node.bold = bold
    node.italic = italic
    if (hasFold) {
      node.fold = makeFold({ corner: false })
      registry.add(node, depth)
      foldCount++
    }
  }

  return { root, foldCount, total }
}

/* ------------------------------------------------------------------ */
/* 导出：Node 树 → Markdown（与解析器互逆）                             */
/* ------------------------------------------------------------------ */

export function toMarkdown(root) {
  const out = []
  const walk = (node, depth) => {
    if (depth > 0) {
      // 折角标记：实心与空心都写 [F]（重新导入时靠「下面有没有代码块」区分）
      const mark = node.fold ? ' [F]' : ''
      // 把应用内的粗体/斜体写回 Markdown，保证导出→导入不丢样式
      let text = node.text
      if (node.italic) text = `*${text}*`
      if (node.bold) text = `**${text}**`
      out.push('  '.repeat(depth - 1) + '- ' + text + mark)
    }
    if (depth > 0 && node.fold && node.fold.corner && node.fold.mermaid) {
      out.push('')
      out.push('  ```mermaid')
      for (const l of node.fold.mermaid.split('\n')) out.push('  ' + l)
      out.push('  ```')
    }
    for (const c of node.children) walk(c, depth + 1)
  }
  walk(root, 0)
  return out.join('\n')
}

/* ------------------------------------------------------------------ */
/* 树工具                                                              */
/* ------------------------------------------------------------------ */

export function walkTree(node, fn, parent = null) {
  fn(node, parent)
  for (const c of node.children) walkTree(c, fn, node)
}

export function findNode(root, id) {
  let hit = null
  walkTree(root, (n) => { if (n.id === id) hit = n })
  return hit
}

export function findParent(root, id) {
  let hit = null
  walkTree(root, (n, p) => { if (n.id === id) hit = p })
  return hit
}

export function countTree(node) {
  let n = 0
  walkTree(node, () => n++)
  return n
}

export function collectFolds(root) {
  const list = []
  walkTree(root, (n, p) => { if (n.fold) list.push({ node: n, parent: p }) })
  return list
}

/** 深拷贝一棵树（换 id，避免跨标签页冲突） */
export function cloneTree(node, keepIds = false) {
  return {
    ...node,
    id: keepIds ? node.id : uid(),
    fold: node.fold ? { ...node.fold } : null,
    children: node.children.map((c) => cloneTree(c, keepIds)),
  }
}

/**
 * 把任意输入整形成合法的 relations 数组。
 *
 * localStorage 和备份 JSON 都是用户能直接改的，这里做最小校验：
 * 缺 from/to 的、自环的（自己指向自己没有意义）一律丢弃。
 * 不去校验 id 是否真的在树里 —— 那需要整棵树，而且悬空引用在渲染层
 * 会被 byId 查不到自然跳过，不该让整条记录把导入卡死。
 */
export function normalizeRelations(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const from = typeof r.from === 'string' ? r.from : ''
    const to = typeof r.to === 'string' ? r.to : ''
    if (!from || !to || from === to) continue
    const key = `${from}\u0000${to}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from, to })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 折角熟悉度 → 颜色分级                                                */
/* ------------------------------------------------------------------ */

export function foldLevel(openCount = 0) {
  if (openCount <= 0) return 0
  if (openCount <= 2) return 1
  if (openCount <= 4) return 2
  return 3
}

/**
 * 角标配色。挑选时以「白字压在实色圆点上要看得清」为准：
 * 10px 的白色数字对比度越低越糊，所以橙、红都比纯色板取深一档。
 *   gray-400  #9ca3af  未读（只画小圆点，不显示数字）
 *   blue-500  #3b82f6  初识 1-2 次
 *   orange-600#ea580c  熟悉 3-4 次（用 500 的 #f59e0b 白字只有 2.1:1，太糊）
 *   red-600   #dc2626  精通 5 次以上
 */
export const FOLD_COLORS = ['#9ca3af', '#3b82f6', '#ea580c', '#dc2626']
export const FOLD_LABELS = ['未读', '初识', '熟悉', '精通']

export function foldColor(openCount) {
  return FOLD_COLORS[foldLevel(openCount)]
}