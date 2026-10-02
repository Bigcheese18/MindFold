/**
 * 节点外形 —— 「流程图不应该只有一种图案」。
 *
 * 【为什么单开一个文件】
 * 形状牵动三处：缩进列表的文本语法、mermaid 源码的编译、以及反向解析。
 * 三处必须共用同一张表，否则「写得进去、画不出来」或「画得出来、读不回来」
 * 这类 bug 会藏在两者之间的缝里。表放在这里，model.js 只负责调用。
 *
 * 【语法怎么定的（关键：绝不能和现有文档打架）】
 * 折角里存的是**用户已有的 markdown 缩进列表**，里面本来就充斥着
 * 中文方括号、日文引号、书名号这类字符：
 *
 *     TCP 三次握手
 *       第一次握手
 *         SYN=1 【重要】
 *         核对「凭据」里的 [token]
 *
 * 所以外形标记必须满足两条硬约束：
 *   1. 只认**行尾**的标记（`{判断}` 这种裸花括号在正文中间很常见）；
 *   2. 必须是 `{名字}` 且名字**在已知表里**，`{随便什么字}` 一律当正文。
 *
 * 因此 `第 3 步 {判断}` → 外形=菱形、文字=`第 3 步`；
 * 而 `{判断} 第 3 步`（不在行尾）→ 原样是文字，一个字符都不动。
 * 这条规则让**所有不存在的老文档行为完全不变**（有回归测试守着）。
 */

/** 行尾外形标记。只匹配 ASCII 花括号，且两个花括号之间没有换行/花括号 */
export const SHAPE_MARK = /\{([^{}\n]*)\}\s*$/

/**
 * 支持的外形。`mermaid` 是写进代码的括号对，`hint` 是给下拉框看的一句话。
 *
 * 【这张表为什么是这几个】
 * 不是按 mermaid 文档抄的，而是从 mermaid 11.17.2 自己的词法表里核出来的
 * （node_modules/mermaid/dist/chunks/mermaid.core/chunk-SHT3W25Y.mjs，
 *  addVertex 的第 48–71 号分支）。凡是 mermaid 解析器真认的形状都在，
 * 认不出的（比如 parallelogram / rhombus 这些别名）一律不收 ——
 * 写进去只会得到一张报错的图。
 */
export const SHAPES = [
  { key: 'rect', label: '方框', glyph: '▭', mermaid: ['["', '"]'], hint: '普通步骤' },
  { key: 'rounded', label: '圆角', glyph: '▢', mermaid: ['("', '")'], hint: '起止 / 事件' },
  { key: 'diamond', label: '菱形', glyph: '◇', mermaid: ['{"', '"}'], hint: '判断 / 分支' },
  { key: 'circle', label: '圆形', glyph: '○', mermaid: ['(("', '"))'], hint: '连接点' },
  { key: 'stadium', label: '胶囊', glyph: '⬭', mermaid: ['(["', '"])'], hint: '终端 / 起止' },
  { key: 'cylinder', label: '圆柱', glyph: '⛁', mermaid: ['[("', '")]'], hint: '数据库 / 存储' },
  { key: 'hexagon', label: '六边形', glyph: '⬡', mermaid: ['{{"', '"}}'], hint: '准备 / 条件' },
  { key: 'subroutine', label: '双边框', glyph: '⧉', mermaid: ['[["', '"]]'], hint: '子流程 / 调用' },
  { key: 'lean_right', label: '右斜', glyph: '◸', mermaid: ['[/"', '"/]'], hint: '输入' },
  { key: 'lean_left', label: '左斜', glyph: '◹', mermaid: ['[\\"', '"\\]'], hint: '输出' },
  { key: 'trapezoid', label: '梯形', glyph: '⏢', mermaid: ['[/"', '"\\]'], hint: '手动操作' },
  { key: 'inv_trapezoid', label: '倒梯形', glyph: '⏢', mermaid: ['[\\"', '"/]'], hint: '优先操作' },
  { key: 'doublecircle', label: '双圆', glyph: '◎', mermaid: ['((("', '")))'], hint: '结束 / 汇总' },
]

/** key → 外形定义 */
const BY_KEY = new Map(SHAPES.map((s) => [s.key, s]))

/**
 * 中文/英文别名 → key。用户不会记得 `inv_trapezoid` 这种名字，
 * 所以常用说法都收进来：写 `{数据库}` 和 `{圆柱}` 是同一个东西。
 */
const ALIAS = new Map()
for (const s of SHAPES) {
  ALIAS.set(s.key, s.key)
  ALIAS.set(s.label, s.key)
}
// 中文别名（按直觉给，不按英文直译）
const EXTRA_ALIAS = {
  '方框': 'rect', '矩形': 'rect', '步骤': 'rect', '默认': 'rect', '普通': 'rect',
  '圆角': 'rounded', '圆角矩形': 'rounded', '开始': 'rounded', '结束': 'rounded', '起止': 'rounded',
  '菱形': 'diamond', '判断': 'diamond', '条件': 'diamond', '分支': 'diamond', '决策': 'diamond',
  '圆': 'circle', '圆形': 'circle', '节点': 'circle', '连接点': 'circle',
  '胶囊': 'stadium', '体育场': 'stadium', '终端': 'stadium', '药丸': 'stadium',
  '圆柱': 'cylinder', '数据库': 'cylinder', '存储': 'cylinder', 'db': 'cylinder',
  '六边形': 'hexagon', '准备': 'hexagon', '预处理': 'hexagon',
  '双边框': 'subroutine', '子流程': 'subroutine', '子程序': 'subroutine', '调用': 'subroutine',
  '右斜': 'lean_right', '输入': 'lean_right',
  '左斜': 'lean_left', '输出': 'lean_left',
  '梯形': 'trapezoid', '手动': 'trapezoid', '人工': 'trapezoid',
  '倒梯形': 'inv_trapezoid', '优先': 'inv_trapezoid', '优先操作': 'inv_trapezoid',
  '双圆': 'doublecircle', '双圈': 'doublecircle', '汇总': 'doublecircle',
  // 英文别名（mermaid 官方别名，用户可能直接照抄）
  'rectangle': 'rect', 'process': 'rect', 'proc': 'rect',
  'event': 'rounded',
  'decision': 'diamond', 'question': 'diamond', 'diam': 'diamond',
  'circ': 'circle',
  'terminal': 'stadium', 'pill': 'stadium',
  'db': 'cylinder', 'database': 'cylinder', 'cyl': 'cylinder',
  'prepare': 'hexagon', 'hex': 'hexagon',
  'subprocess': 'subroutine', 'subproc': 'subroutine', 'framed-rectangle': 'subroutine', 'fr-rect': 'subroutine',
  'lean-right': 'lean_right', 'in-out': 'lean_right', 'lean-r': 'lean_right',
  'lean-left': 'lean_left', 'out-in': 'lean_left', 'lean-l': 'lean_left',
  'priority': 'trapezoid', 'trapezoid-bottom': 'trapezoid', 'trap-b': 'trapezoid',
  'manual': 'inv_trapezoid', 'trapezoid-top': 'inv_trapezoid', 'inv-trapezoid': 'inv_trapezoid', 'trap-t': 'inv_trapezoid',
  'double-circle': 'doublecircle', 'dbl-circ': 'doublecircle',
}
for (const [k, v] of Object.entries(EXTRA_ALIAS)) if (!ALIAS.has(k)) ALIAS.set(k, v)

/** 把用户写的形状名解析成 key；认不出返回 null（调用方保留原文） */
export function parseShapeName(name) {
  const s = String(name ?? '').trim()
  if (!s) return null
  return ALIAS.get(s) || ALIAS.get(s.toLowerCase()) || null
}

/** key → 外形定义；未知 key 退化成方框（不抛错，图不能因为一个字段没掉） */
export function shapeOf(key) {
  return BY_KEY.get(key) || BY_KEY.get('rect')
}

/** 该 key 是不是合法外形 */
export const isShape = (key) => BY_KEY.has(key)

/**
 * 拆出一行末尾的外形标记。
 *
 * 只认行尾 —— 这是「不破坏老文档」的全部秘密。返回的 `shape` 为 null 时，
 * `text` 必须和输入**逐字节相同**（有测试守着）。
 *
 * @returns {{ text: string, shape: string|null, raw: string|null }}
 *   text  去掉标记后的正文（原样保留行尾空格以外的内容）
 *   shape 外形 key，或 null
 *   raw   原始标记文字（`{判断}`），用于「用户写了但认不出」时如实反馈
 */
export function splitShapeMark(line) {
  const s = String(line ?? '')
  const m = s.match(SHAPE_MARK)
  if (!m) return { text: s, shape: null, raw: null }
  const key = parseShapeName(m[1])
  // 认不出 → 整个标记当正文，一个字符都不动
  if (!key) return { text: s, shape: null, raw: m[1] }
  return { text: s.slice(0, m.index).replace(/\s+$/, ''), shape: key, raw: m[1] }
}

/** 把外形写成行尾标记。rect 是默认外形，不写标记（老文档就长这样） */
export function shapeMark(key) {
  return key && key !== 'rect' ? ` {${shapeOf(key).label}}` : ''
}

/**
 * 生成 mermaid 的节点定义 `n0["文字"]` / `n0{"文字"}` …。
 *
 * 转义只处理双引号：mermaid 的 `["..."]` 里双引号必须写成 &quot;，
 * 这和老实现（outlineToMermaid 里的 esc）完全一致，不能改口径。
 */
export function mermaidNodeDef(id, label, key) {
  const [open, close] = shapeOf(key).mermaid
  return `${id}${open}${String(label).replace(/"/g, '&quot;')}${close}`
}

/**
 * 从 mermaid 的括号对反推外形 key。
 *
 * 【为什么按「配对长度」排】
 * `((("文字")))` 必须先于 `(("文字"))` 判断，`(["文字"])` 又必须先于
 * `("文字")`。按开括号从长到短试，再校验闭括号，就不会把双圆认成圆、
 * 把胶囊认成圆角。
 */
const OPENERS = SHAPES
  .map((s) => ({ key: s.key, open: s.mermaid[0], close: s.mermaid[1] }))
  .sort((a, b) => b.open.length - a.open.length)

/** @returns {{ key: string, label: string } | null} */
export function readNodeShape(src, id) {
  const s = String(src ?? '')
  const re = new RegExp(`(^|[^\\w\\u4e00-\\u9fa5-])${escapeRe(id)}`, 'g')
  let m
  while ((m = re.exec(s))) {
    const at = m.index + m[1].length
    const rest = s.slice(at + id.length)
    // 允许 id 和括号之间有空格（mermaid 自己允许）
    const gapM = rest.match(/^\s*/)
    const body = rest.slice(gapM[0].length)
    for (const o of OPENERS) {
      if (!body.startsWith(o.open)) continue
      const inner = body.slice(o.open.length)
      // 找闭括号：允许里面被 &quot; 转义过的引号
      const end = inner.indexOf(o.close)
      if (end < 0) continue
      const label = inner.slice(0, end).replace(/&quot;/g, '"').trim()
      return { key: o.key, label }
    }
    // 该位置不是定义（比如只是连线里的裸 id），继续往后找
  }
  return null
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 给下拉框用：一路「下一个外形」，键盘快捷键用 */
export function nextShape(key) {
  const i = SHAPES.findIndex((s) => s.key === (key || 'rect'))
  return SHAPES[(i + 1) % SHAPES.length].key
}