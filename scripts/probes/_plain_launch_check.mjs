/**
 * 「像用户一样双击」的启动验证（**不加任何环境变量**）
 * ==================================================
 *
 * 【为什么必须和 _desktop_shell_check.mjs 分开做】
 * 那套 CDP 探针为了能连进去，必须设两个环境变量：
 *     WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…
 *     WEBVIEW2_USER_DATA_FOLDER=<临时目录>
 * 第二个尤其关键：它把 WebView2 的**用户数据目录换成了临时目录**。
 *
 * 而用户双击时走的是**默认**配置目录（%LOCALAPPDATA%\com.mindfold.app）。
 * 所以「CDP 探针 34/34 通过」**证明不了**「双击能打开」——
 * 上一轮就是在这里差点得出错误结论：当时桌面上的 EXE 双击打不开，
 * 而带环境变量的探针却是通的。
 *
 * 这个脚本因此刻意什么都不设：不设 WEBVIEW2_*、不换用户数据目录，
 * 和双击完全一致。判据也只有两个最朴素的：
 *   1) 进程在 N 秒后还活着（Tauri 的 setup 失败会当场 panic 退出）；
 *   2) 它真的拉起了 WebView2 子进程（说明界面起来了，不是空跑）。
 * 进程若退出，把退出码和 stderr 一起打出来 —— 那个才是现场。
 *
 * 用法：node scripts/probes/_plain_launch_check.mjs <exe路径> [等待秒数]
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const EXE = process.argv[2] || 'src-tauri/target/release/mindfold.exe'
const WAIT_S = Number(process.argv[3] || 14)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(EXE)) { console.error('找不到 EXE: ' + EXE); process.exit(2) }

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}${e ? ' → ' + e : ''}`) }
}
const note = (m) => console.log(`  · ${m}`)

/** 数一下 WebView2 子进程（用 tasklist，避免依赖 PowerShell 的 Start-Process 会挂住 shell） */
const countWebView2 = () => {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq msedgewebview2.exe', '/NH'], { encoding: 'utf8' })
    return (out.match(/msedgewebview2\.exe/gi) || []).length
  } catch { return -1 }
}

console.log(`\n=== 像用户一样双击：${EXE} ===`)
note('不设置任何 WEBVIEW2_* 环境变量，用默认用户数据目录')

const before = countWebView2()
note(`启动前系统里的 msedgewebview2 进程数：${before}`)

/** 用 pipe 收 stderr：Tauri setup 失败时会往这里打 panic */
const proc = spawn(EXE, [], { stdio: ['ignore', 'pipe', 'pipe'] })
let err = ''
let out = ''
proc.stderr.on('data', (d) => { err += String(d) })
proc.stdout.on('data', (d) => { out += String(d) })

let exited = null
proc.on('exit', (code, signal) => { exited = { code, signal } })

for (let i = 1; i <= WAIT_S; i++) {
  await sleep(1000)
  if (exited) break
}
await sleep(1500)

const after = countWebView2()
if (exited) {
  note(`进程已退出：exit code = ${exited.code}（signal=${exited.signal}）`)
  if (exited.code === 3221226505 || exited.code === -1073740791) {
    note('这个码是 0xC0000409（STATUS_STACK_BUFFER_OVERRUN）——Tauri 的 setup 失败后 panic abort 的典型退出码')
  }
  if (err.trim()) note(`stderr：${err.trim().split('\n').slice(0, 8).join(' | ')}`)
  if (out.trim()) note(`stdout：${out.trim().split('\n').slice(0, 4).join(' | ')}`)
} else {
  note(`进程仍然活着（等了 ${WAIT_S}s+1.5s）`)
}

check('★ 双击后进程没有当场退出（Tauri setup 没失败）', exited === null,
  exited ? `exit=${exited.code}` : '')
check('★ 真的拉起了 WebView2 子进程（界面起来了）', after > before,
  `启动前 ${before} → 启动后 ${after}`)
check('stderr 里没有 Tauri setup 的 panic', !/Failed to setup app|panicked at/i.test(err),
  err.trim().slice(0, 200))

// 收尾：把这次启动的实例关掉，别留在用户机器上
if (!exited) {
  try { proc.kill() } catch { /* ignore */ }
  await sleep(1500)
  const left = countWebView2()
  note(`关闭后 msedgewebview2 进程数：${left}`)
}

console.log(`\n双击启动验证 ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
