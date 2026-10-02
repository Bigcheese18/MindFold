/**
 * 让 WebView2 自己开口：打开详细日志，看初始化到底死在哪儿。
 * 注意：日志会写到数据目录下的 chrome_debug.log。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = process.argv[2]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dataDir = mkdtempSync(join(tmpdir(), 'mf-wvlog-'))
console.log('EXE: ' + EXE)
console.log('临时数据目录: ' + dataDir)

const proc = spawn(EXE, [], {
  stdio: 'inherit',
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: dataDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--enable-logging --v=1 --no-sandbox',
  },
})
let exited = null
proc.on('exit', (c) => { exited = c })

await sleep(15000)
console.log('进程是否退出: ' + (exited === null ? '还活着' : '退出了，exit=' + exited))

// 找日志
const cands = [
  join(dataDir, 'EBWebView', 'chrome_debug.log'),
  join(dataDir, 'chrome_debug.log'),
  join(dataDir, 'EBWebView', 'Default', 'chrome_debug.log'),
]
let found = false
for (const c of cands) {
  if (existsSync(c)) {
    found = true
    const txt = readFileSync(c, 'utf8')
    console.log(`\n=== ${c} （${txt.length} 字节，最后 4000 字符）===`)
    console.log(txt.slice(-4000))
  }
}
if (!found) {
  console.log('\n没有找到 chrome_debug.log。目录内容：')
  const { readdirSync } = await import('node:fs')
  const walk = (d, depth = 0) => {
    if (depth > 2) return
    try {
      for (const n of readdirSync(d)) {
        console.log('  '.repeat(depth + 1) + n)
        const p = join(d, n)
        try { if (require('node:fs').statSync(p).isDirectory()) walk(p, depth + 1) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  walk(dataDir)
}

try { proc.kill() } catch { /* ignore */ }
await sleep(500)
try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(0)
