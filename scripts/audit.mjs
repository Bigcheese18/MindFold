/**
 * 死代码 / 未使用符号审计
 * ======================
 * 逐个检查导出符号与函数参数在项目内是否真的被引用。
 * 单文件内部使用的局部函数也会被列出，方便人工判断。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = 'src'
const files = []
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (['.js', '.jsx'].includes(extname(p))) files.push(p)
  }
})(ROOT)

const sources = files.map((f) => ({ f, text: readFileSync(f, 'utf8') }))

/** 统计某个标识符在所有源文件中的出现次数（按词边界） */
function count(sym) {
  const re = new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
  const hits = []
  for (const { f, text } of sources) {
    const n = (text.match(re) || []).length
    if (n) hits.push(`${f.replace(/\\/g, '/')}:${n}`)
  }
  return hits
}

/** 收集 export 出来的符号名 */
const exported = new Map()
for (const { f, text } of sources) {
  const re = /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g
  let m
  while ((m = re.exec(text))) exported.set(m[1], f)
  // export { a, b, c }
  const re2 = /export\s*\{([^}]+)\}/g
  while ((m = re2.exec(text))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim()
      if (name) exported.set(name, f)
    }
  }
}

console.log('=== 导出的符号：仅出现 1 次 = 定义处，说明没人用 ===')
/**
 * 有意的公开 API：只在 src 外部（测试、将来的调用方）使用。
 *
 * 这里**必须写清理由**，否则这个白名单会慢慢变成「什么都往里塞」的垃圾桶，
 * 审计也就废了。目前只有一条：需求点名要求存在的解析入口，
 * 应用内部走的是信息更全的 parseCodeLineIndex。
 */
const INTENTIONAL_API = new Map([
  ['parseCodeLineMap', '需求点名的行号映射入口；应用内部用 parseCodeLineIndex，本函数由 123 项纯函数测试覆盖'],
])

const dead = []
for (const [sym, f] of [...exported].sort()) {
  if (INTENTIONAL_API.has(sym)) continue
  const hits = count(sym)
  const total = hits.reduce((s, h) => s + Number(h.split(':')[1]), 0)
  if (total <= 1) {
    dead.push(sym)
    console.log(`  ✗ ${sym.padEnd(24)} ${f.replace(/\\/g, '/')}`)
  }
}
if (!dead.length) console.log('  （无）')
for (const [sym, why] of INTENTIONAL_API) console.log(`  ○ ${sym.padEnd(24)} 有意公开：${why}`)

console.log('\n=== 组件 props：声明但未在组件体内使用 ===')
/**
 * 粗略检查：函数组件签名里的 prop 名是否在 body 中出现。
 *
 * 解析前**必须先剥掉注释**：组件签名是跨行写的，而注释里出现的 `{ a, b }`
 * 会让 `[^}]*` 提前收尾，把注释里的词当成 prop。
 * 实测踩过：`// { line, seq } 一次性滚动请求` 让审计报出「未使用: seq」，
 * 一个纯粹的假阳性 —— 假阳性多了，真问题就被淹没。
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
for (const { f, text } of sources) {
  const src = stripComments(text)
  const compRe = /(?:export\s+default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(\s*\{([^}]*)\}/g
  let m
  while ((m = compRe.exec(src))) {
    const [, name, propsRaw] = m
    const props = propsRaw
      .split(',')
      .map((p) => p.split(':')[0].split('=')[0].trim())
      .filter((p) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p)) // 过滤掉注释/换行残留
    // 取该组件函数体（到下一个顶层 function 或文件末尾）
    const start = m.index
    const nextIdx = src.indexOf('\nfunction ', start + 1)
    const body = src.slice(start, nextIdx > 0 ? nextIdx : src.length)
    const unused = props.filter((p) => {
      const re = new RegExp(`\\b${p}\\b`, 'g')
      return (body.match(re) || []).length <= 1
    })
    if (unused.length) console.log(`  ${name.padEnd(16)} 未使用: ${unused.join(', ')}   (${f.replace(/\\/g, '/')})`)
  }
}

console.log('\n=== 重复实现（同一逻辑出现在多处）===')
const dupes = ['foldLevelOf', 'foldColorOf', 'foldColor', 'stripFenceIndent', 'clampZoom']
for (const d of dupes) {
  const hits = count(d)
  if (hits.length) console.log(`  ${d.padEnd(18)} ${hits.join('  ')}`)
}
