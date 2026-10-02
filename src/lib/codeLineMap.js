/**
 * 代码行号映射（纯函数）
 * ======================
 * 「全屏弹窗 · 纯代码模式」下左右两侧要能互相定位：
 *
 *   右侧图上的节点 n3  →  左侧代码的第几行？
 *   左侧光标停在第 4 行 →  右侧图上该高亮哪些节点？
 *
 * 这两个方向都要一张表。而 `<textarea>` 里的每一行**不是 DOM 元素**，
 * 没法靠 querySelector 找，所以只能自己解析源码算出行号。
 *
 * ---------------------------------------------------------------------------
 * 为什么用正则解析（A 方案）而不是 AST
 * ---------------------------------------------------------------------------
 * 1. 需求是「**语法有错也要能解析出上半部分的正确映射**」。
 *    真正的 Mermaid 解析器遇到第一处错误就整体失败 —— 那正是我们要避免的：
 *    用户正在打字的中间态几乎永远是错的，而联动必须一直可用。
 *    逐行正则天然「错一行只丢一行」，不会因为一处错误让整张表作废。
 * 2. 不引入新依赖（离线优先、要打包成 Tauri），也不额外拉进 mermaid 的
 *    内部 parser（它是异步 + 全局单例，和渲染互相干扰）。
 * 3. 代码里的节点书写形式很有限（`id["…"]` / `id(…)` / `id{…}`），
 *    正则的精度足够，且行为完全可预测、可单测。
 *
 * ---------------------------------------------------------------------------
 * 行号口径
 * ---------------------------------------------------------------------------
 * **1-based**，和编辑器左侧行号栏、以及 mermaid 报错的 `error.line` 完全一致。
 * 按 `\n` 切分（和 textarea 的 value 一致），行尾残留的 `\r` 只是显示噪音，剥掉。
 *
 * ---------------------------------------------------------------------------
 * 映射优先级
 * ---------------------------------------------------------------------------
 *   1. **声明行优先**：`n0["文字"]` 所在的行 —— 这是节点的「家」。
 *   2. **连线行回退**：节点没有独立声明行（`n0 --> n1` 里才第一次出现）时，
 *      用包含它的那条连线的行号。
 *
 * 两者都记在返回值里（`decl` / `fallback`），合成结果在 `lineMap`。
 */

import { NODE_ID_SRC, NODE_SHAPE_SRC, isMetaLine, stripNodeShapes } from './codeOps.js'

const ID = NODE_ID_SRC
const SHAPE = NODE_SHAPE_SRC

/**
 * id 左边不能紧挨着另一个 id 字符。
 * 否则 `An0["x"]` 会把 `n0` 也当成一个节点（它只是 `An0` 的一部分）。
 *
 * 用**零宽断言**而不是「消费掉前一个字符」：
 * 消费写法在 `A["x"]B["y"]` 这种紧挨着的两处声明上会漏掉第二个，
 * 零宽断言不占位，天然没有这个问题。
 */
const LEFT_GUARD = '(?<![A-Za-z0-9_\\u4e00-\\u9fa5\\-])'

/** `flowchart TD` / `graph LR` 首行 */
const HEADER_RE = /^\s*(?:flowchart|graph)\b\s*(?:TB|TD|BT|RL|LR)?/i

/**
 * 连线记号。
 *
 * 比 codeOps 的 ARROW_TOK 多认了 `---` / `-.-` 这两种「开放连线」——
 * 行号映射只关心「这行是不是连线」，多认几种只有好处；
 * 编辑操作那边故意不动：开放连线不能整行对调，语义不同。
 *
 * **不收录裸 `--` / `==`**：它们单独出现时只是边标签的分隔符
 * （`A -- 说明 --> B`），把它当连线记号会把 `node-a` 这类带连字符的 id 切碎。
 * 长的记号必须排在前面，否则 `-.->` 会先被 `-.-` 吃掉。
 */
const LINK_SRC = '-->|==>|-\\.->|---|-\\.-'
const LINK_RE = new RegExp(LINK_SRC)
const LINK_SPLIT_RE = new RegExp(LINK_SRC)

/**
 * `A -- 说明 --> B` 里的「说明」不是节点。
 * pipe 形式（`A -->|说明| B`）已经被 stripNodeShapes 挖掉了，这里补上裸形式。
 * 要求 `--` 后面必须有空白，否则 `node-a` 会被误伤。
 */
const BARE_LABEL_RE = /(?:--|==)\s+[^\-=>]+?\s*(?=-->|---|==>|-\.->|-\.-)/g

/** 生成新正则，避免模块级 lastIndex 串味 */
const declRe = () => new RegExp(`${LEFT_GUARD}(${ID})\\s*(?:${SHAPE})`, 'g')
const looseDeclRe = () => new RegExp(`${LEFT_GUARD}(${ID})\\s*(?:\\(|\\[|\\{)`, 'g')
const idRe = () => new RegExp(ID, 'g')

/** 去掉 `%%` 行尾注释 */
function stripComment(line) {
  return String(line).replace(/%%.*$/, '')
}

/**
 * 把成对的引号内容清空。
 *
 * 目的是**不把标签文字当成节点**：`A["见 B[1]"]` 里的 `B[` 长得很像声明，
 * 但它只是标签内容。清空后 `A[""]`，宽松匹配就只会认出 A。
 * 未闭合的引号（`n5["未闭合`）原样保留 —— 那正是我们要救回来的语法错误行。
 */
function stripQuoted(line) {
  return String(line).replace(/"[^"]*"/g, '""')
}

/** 一行里所有出现在「声明位置」的节点 id（严格：外形必须闭合） */
function declIdsOnLine(line) {
  const out = []
  const re = declRe()
  let m
  while ((m = re.exec(line)) !== null) {
    out.push(m[1])
    if (m.index === re.lastIndex) re.lastIndex++      // 空匹配保护
  }
  return out
}

/** 一行里所有「id 后面跟了外形起始符」的 id（宽松：闭合与否都算） */
function looseDeclIdsOnLine(line) {
  const out = []
  const re = looseDeclRe()
  let m
  while ((m = re.exec(line)) !== null) {
    out.push(m[1])
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return out
}

/**
 * 一行里出现的所有 id。
 *
 * 先把外形与标签文字挖掉，再**按连线记号切开**，最后在每一段里取 id。
 * 按连线切这一步很关键：`A-->B` 里的 `A--` 在旧的贪心 id 规则下会被
 * 当成一个节点；先切掉 `-->` 之后，两段分别只含 `A` 和 `B`。
 * 顺带的好处是 `node-a --> node-b` 这类带连字符的 id 完全不受影响。
 */
function idsOnLine(line) {
  const clean = stripQuoted(stripNodeShapes(stripComment(line))).replace(BARE_LABEL_RE, '')
  const out = []
  for (const seg of clean.split(LINK_SPLIT_RE)) {
    for (const m of seg.matchAll(idRe())) if (!out.includes(m[0])) out.push(m[0])
  }
  return out
}

/** 这行有没有连线记号（挖掉标签后判断，避免标签里的 `-->` 误判） */
function hasLink(line) {
  return LINK_RE.test(stripQuoted(stripNodeShapes(stripComment(line))))
}

/**
 * 这一行为什么看起来是坏的 —— 只为**报告**，绝不中断解析。
 *
 * 只挑误判率极低的三种：
 *   · 外形起始符没闭合（`n5["未闭合`）
 *   · 引号奇数个
 *   · 箭头某一端没有节点
 *
 * 刻意**不做**括号计数校验：mermaid 有 `A>text]` 这种不对称外形，
 * 计数会把它误判成语法错误，反而制造噪音。
 */
function brokenReason(line, unclosed) {
  if (unclosed.length) return `节点外形没有闭合：${unclosed[0]}`
  if ((line.match(/"/g) || []).length % 2 === 1) return '引号没有闭合'
  const clean = stripQuoted(stripNodeShapes(line)).replace(BARE_LABEL_RE, '')
  if (LINK_RE.test(clean)) {
    const parts = clean.split(LINK_SPLIT_RE)
    if (!parts[0].trim()) return '箭头前面缺少节点'
    if (!parts[parts.length - 1].trim()) return '箭头后面缺少目标节点'
  }
  return null
}

function push(map, key, id) {
  const arr = map[key] || (map[key] = [])
  if (!arr.includes(id)) arr.push(id)
}

/**
 * 解析整份代码，返回完整索引。
 *
 * @param {string} code Mermaid 源码
 * @returns {{
 *   lineMap: Record<string, number>,   // id → 行号（声明优先，连线回退）★ 主产物
 *   decl: Record<string, number>,      // 只有「声明行」的映射
 *   fallback: Record<string, number>,  // 只有「连线行」的映射
 *   byLine: Record<number, string[]>,  // 行号 → 该行的节点 id（反向联动用）
 *   ids: string[],                     // 按首次出现顺序
 *   declCount: number, fallbackCount: number,
 *   malformed: {line:number, reason:string, ids:string[]}[],
 *   ok: boolean,                       // malformed 为空
 * }}
 */
export function parseCodeLineIndex(code) {
  const src = String(code ?? '')
  // 行尾的 \r 只是 Windows 换行残留，剥掉不影响行号
  const lines = src.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))

  const decl = {}
  const fallback = {}
  const byLine = {}
  const malformed = []
  const ids = []
  const seen = new Set()

  const note = (id) => {
    if (!seen.has(id)) { seen.add(id); ids.push(id) }
  }

  /* ---------------- 第一遍：声明行 ---------------- */
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const raw = lines[i]
    if (!raw.trim()) continue
    if (/^\s*%%/.test(raw)) continue                 // 整行注释
    let s = stripComment(raw)
    if (!s.trim()) continue

    // 首行：只切掉 `flowchart TD` 这段，行尾可能还有 `;A-->B`，不能整行丢掉
    const h = s.match(HEADER_RE)
    if (h) s = s.slice(h[0].length)
    if (!s.trim()) continue
    if (isMetaLine(s)) continue                      // classDef / style / subgraph …

    const strict = declIdsOnLine(s)
    for (const id of strict) {
      if (!(id in decl)) decl[id] = lineNo
      note(id)
      push(byLine, lineNo, id)
    }

    // 语法坏掉的行：记一笔，然后把能认出来的 id **宽松**记下，绝不中断
    const loose = looseDeclIdsOnLine(stripQuoted(s))
    const unclosed = loose.filter((id) => !strict.includes(id))
    const why = brokenReason(s, unclosed)
    if (why) malformed.push({ line: lineNo, reason: why, ids: unclosed })
    for (const id of unclosed) {
      if (!(id in decl)) decl[id] = lineNo
      note(id)
      push(byLine, lineNo, id)
    }
  }

  /* ---------------- 第二遍：连线行回退 ---------------- */
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const raw = lines[i]
    if (!raw.trim() || /^\s*%%/.test(raw)) continue
    let s = stripComment(raw)
    if (!s.trim()) continue
    const h = s.match(HEADER_RE)
    if (h) s = s.slice(h[0].length)
    if (!s.trim() || isMetaLine(s)) continue
    if (!hasLink(s)) continue

    for (const id of idsOnLine(s)) {
      // 声明行永远优先：已经找到「家」的节点不再被连线行改写
      if (!(id in decl) && !(id in fallback)) fallback[id] = lineNo
      note(id)
      push(byLine, lineNo, id)
    }
  }

  /* ---------------- 合成 ---------------- */
  const lineMap = {}
  for (const id of ids) {
    const n = id in decl ? decl[id] : fallback[id]
    if (n != null) lineMap[id] = n
  }

  return {
    lineMap,
    decl,
    fallback,
    byLine,
    ids,
    declCount: Object.keys(decl).length,
    fallbackCount: Object.keys(fallback).length,
    malformed,
    ok: malformed.length === 0,
  }
}

/**
 * ★ 需求指定的入口：`{ "n0": 1, "n1": 2, "n3": 4 }`
 *
 * 行号 1-based。声明行优先，没有声明行的节点回退到它的连线行。
 * 语法错误不会让这个函数失败，只会让**出错那一行**少几个映射。
 *
 * 应用侧（FoldModal）用的是信息更全的 `parseCodeLineIndex`，
 * 因为它同时需要反向的 `byLine`。这个薄出口是模块的**对外契约**：
 * 调用方只想「拿到 id → 行号」这一件事时用它，不必关心索引的内部结构。
 */
export function parseCodeLineMap(code) {
  return parseCodeLineIndex(code).lineMap
}
