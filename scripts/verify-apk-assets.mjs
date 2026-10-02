/**
 * 打包产物校验：APK 里的 assets/public 是否和 dist/ 逐字节一致，
 * 以及原生代码确实编进了 dex。
 *
 * 【为什么逐个 entry 解，而不是整包解开】
 * 这个 APK 里有重复条目（res/9n.9.png 出现两次），
 * 用常规「整包解压」会直接报 duplicate entry 半途失败。
 * 所以用 zip 的 entry 表按名字单独读。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import zlib from 'node:zlib'

const APK = process.argv[2] || 'android/app/build/outputs/apk/release/app-release.apk'
const DIST = process.argv[3] || 'dist'
const PREFIX = 'assets/public/'

const sha = (b) => createHash('sha256').update(b).digest('hex').toUpperCase()

/* ---------- 极简 zip 读取（只解中央目录里列出的条目） ---------- */
function readZipEntries(buf) {
  // 找 End of Central Directory
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('找不到 zip 中央目录')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录条目签名不对')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const uncompSize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    out.set(name, { method, compSize, uncompSize, localOff })
    off += 46 + nameLen + extraLen + commentLen
  }
  return { entries: out, buf }
}

function readEntry(zip, name) {
  const e = zip.entries.get(name)
  if (!e) return null
  const { buf, } = zip
  const lnameLen = buf.readUInt16LE(e.localOff + 26)
  const lextraLen = buf.readUInt16LE(e.localOff + 28)
  const dataAt = e.localOff + 30 + lnameLen + lextraLen
  const raw = buf.subarray(dataAt, dataAt + e.compSize)
  if (e.method === 0) return Buffer.from(raw)
  if (e.method === 8) return zlib.inflateRawSync(raw)
  throw new Error('不认识的压缩方式 ' + e.method)
}

/* ---------- dist 里的真实文件 ---------- */
function walk(dir, base = dir, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, base, acc)
    else acc.push(relative(base, p).split(sep).join('/'))
  }
  return acc
}

const apkBuf = readFileSync(APK)
const zip = readZipEntries(apkBuf)
const distFiles = walk(DIST).sort()

let same = 0, diff = 0, missing = 0
const problems = []
for (const f of distFiles) {
  const a = readEntry(zip, PREFIX + f)
  const d = readFileSync(join(DIST, f.split('/').join(sep)))
  if (!a) { missing++; problems.push('APK 里缺 ' + f); continue }
  if (sha(a) === sha(d)) same++
  else { diff++; problems.push('内容不同 ' + f) }
}

const pubEntries = [...zip.entries.keys()].filter((k) => k.startsWith(PREFIX) && !k.endsWith('/'))
console.log(`APK: ${APK}`)
console.log(`dist 文件数 ${distFiles.length} · APK 内 ${PREFIX}* 条目 ${pubEntries.length}`)
console.log(`逐字节一致 ${same} · 内容不同 ${diff} · 缺失 ${missing}`)
if (problems.length) console.log('问题：\n  ' + problems.slice(0, 10).join('\n  '))

/* ---------- 关键文件点名 ---------- */
console.log('\n关键资源：')
for (const f of distFiles.filter((x) => /assets\/index-.*\.(js|css)$/.test(x))) {
  const a = readEntry(zip, PREFIX + f)
  console.log(`  ${f}  APK=${a ? a.length : '缺失'}B  dist=${statSync(join(DIST, f.split('/').join(sep))).size}B  ${a && sha(a) === sha(readFileSync(join(DIST, f.split('/').join(sep)))) ? '一致' : '不一致'}`)
}

/* ---------- 旧构建不该在里面 ---------- */
console.log('\n旧构建残留检查：')
const OLD = ['index-BMhsUKir.js', 'index-DsLrY141.css', 'index-76xhC4c_.js', 'index-C3YhVs9T.js',
  // 搬家之前的包（主题还挂在顶部面板那条）：文件名就是「手机版还是不行」的物证
  'index-CgTrO2qm.js']
for (const o of OLD) {
  const found = [...zip.entries.keys()].some((k) => k.includes(o))
  console.log(`  ${o}  ${found ? '★ 仍在包里（不该）' : '不在包里（正确）'}`)
}

/* ---------- 原生返回键代码 ---------- */
const dex = [...zip.entries.keys()].filter((k) => /^classes\d*\.dex$/.test(k))
let hit = false
for (const d of dex) {
  const b = readEntry(zip, d)
  if (b && b.includes(Buffer.from('__mfHardwareBack'))) hit = true
}
console.log(`\n原生返回键：classes.dex 里有 __mfHardwareBack = ${hit ? '是' : '否'}（${dex.join(', ')}）`)

/* ---------- 外形功能确实在新 JS 里 ---------- */
const jsName = distFiles.find((x) => /assets\/index-.*\.js$/.test(x))
if (jsName) {
  const js = readEntry(zip, PREFIX + jsName)
  /*
   * 这些字符串是**这一轮的 UI 改动**在产物里的指纹：
   * 只要 APK 里那份 JS 还有它们，就说明「打出来的包」确实是新代码，
   * 而不是一份没被重新 sync 的旧资源（APK 资产是最容易悄悄过期的东西）。
   */
  const marks = [
    'data-shape-picker', 'inv_trapezoid', 'doublecircle', 'data-reset-familiarity',
    // 第六轮（手机端手感）：底部操作条 / 长按菜单 / 思维导图两个入口 / 触屏菜单行
    'data-mobile-bottom-bar', 'data-mobile-tabs-btn', 'data-mobile-tabs-sheet',
    'data-touch-hint', 'data-drawer-close',
    // 第七轮（格式与顶栏）：多格式导入导出 + 导出面板 + 离线 HTML 内嵌载荷
    'data-export-sheet', 'data-export-format', 'data-export-open', 'mf-outline',
    'mindfold-doc', 'data-mf-depth', 'data-mindfold-export', 'OPML', 'FreeMind',
    // 第八轮：主题切换从顶部面板搬进左侧栏头部（抽屉头 / 侧栏头）—— 指纹跟着换名
    'data-theme-row', 'data-theme-option',
    // 同轮：并进头部那一行 → 值里带 placement
    'data-placement',
  ]
  console.log('\n新功能字符串（在 APK 内那份 JS 里）：')
  for (const m of marks) console.log(`  ${m}  ${js.includes(Buffer.from(m)) ? '有' : '没有'}`)

  /*
   * ---------- 反向指纹：这些东西**必须不在**包里 ----------
   * 这一条是「手机版还是不行呀 顶部栏里面的切换主题的按钮3个」的现场记录：
   * 源码里主题早就搬走了，但 APK 里那份 JS 是**搬家之前**构建的
   * （dist 21:43 构建，源码 23:18 才改），于是手机上顶部一直挂着三颗色块。
   * 只检查「新串在不在」抓不到这种「旧串还在」，所以这里连反向串一起查。
   */
  const forbidden = ['data-mobile-theme-row', 'data-mobile-theme"']
  console.log('\n反向指纹（旧构建残留，必须没有）：')
  let stale = 0
  for (const m of forbidden) {
    const has = js.includes(Buffer.from(m))
    if (has) stale++
    console.log(`  ${m}  ${has ? '★ 还在（说明这份 JS 是搬家之前的旧构建）' : '不在（正确）'}`)
  }
  if (stale) missing += stale
}

process.exit(diff + missing > 0 ? 1 : 0)
