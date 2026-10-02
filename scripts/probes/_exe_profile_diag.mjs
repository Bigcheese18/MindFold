/**
 * 诊断：用**默认** WebView2 数据目录启动便携版，看窗口到底有没有正常渲染。
 *
 * 对照关系：
 *   · 我之前那次成功的桌面壳验证：spawn + 自定义 WEBVIEW2_USER_DATA_FOLDER（临时目录）→ 正常
 *   · 用户双击：默认目录 %LOCALAPPDATA%\com.mindfold.app → 窗口 14×14、标题空
 * 所以这里只改「数据目录」这一个变量（一次只动一个变量）。
 */
import { spawn } from 'node:child_process'
import MiniWS from '../browser/_ws.mjs'

const EXE = process.argv[2] || 'C:/Users/21238/Desktop/MindFold-发布/MindFold-便携版.exe'
const MODE = process.argv[3] || 'default'   // default | temp
const PORT = 9413
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect(url) {
  const ws = new MiniWS(url)
  let id = 0
  const pending = new Map()
  const handlers = new Map()
  ws.onmessage = (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method && handlers.has(msg.method)) handlers.get(msg.method)(msg.params)
  }
  await ws.opened
  return {
    send(m, p = {}) {
      const mid = ++id
      ws.send(JSON.stringify({ id: mid, method: m, params: p }))
      return new Promise((res, rej) => pending.set(mid, { resolve: res, reject: rej }))
    },
    on(e, f) { handlers.set(e, f) }, close() { ws.close() },
  }
}

const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
}
if (MODE === 'temp') {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  env.WEBVIEW2_USER_DATA_FOLDER = mkdtempSync(join(tmpdir(), 'mf-diag-'))
}

console.log(`模式: ${MODE}  (${MODE === 'temp' ? '临时数据目录' : '默认数据目录 %LOCALAPPDATA%\\com.mindfold.app'})`)
const proc = spawn(EXE, [], { stdio: 'ignore', env, detached: false })
let exited = null
proc.on('exit', (code) => { exited = code })

let target = null
for (let i = 0; i < 50; i++) {
  await sleep(400)
  if (exited !== null) break
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page?.webSocketDebuggerUrl) { target = page; break }
  } catch { /* 还没起 */ }
}

if (exited !== null) {
  console.log(`✗ 进程在连上调试端口之前就退出了，exit code = ${exited}`)
  process.exit(1)
}
if (!target) {
  console.log('✗ 20 秒内没有出现调试页面（WebView2 没能初始化）')
  try { proc.kill() } catch { /* ignore */ }
  process.exit(1)
}

const cdp = await connect(target.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
const ev = async (e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'fail')
  return r.result.value
}
await sleep(5000)

const info = await ev(`({
  url: location.href,
  title: document.title,
  rootChildren: document.querySelector('#root')?.firstElementChild ? 1 : 0,
  nodes: document.querySelectorAll('[data-node-id]').length,
  outer: [window.outerWidth, window.outerHeight],
  inner: [innerWidth, innerHeight],
  dpr: devicePixelRatio,
})`)
console.log('页面信息: ' + JSON.stringify(info))

const ok = info.rootChildren === 1 && info.nodes > 0
console.log(ok
  ? `✓ 正常渲染：${info.nodes} 个节点，窗口 ${info.outer[0]}×${info.outer[1]}`
  : `✗ 没渲染出来`)

cdp.close()
try { proc.kill() } catch { /* ignore */ }
await sleep(800)
process.exit(ok ? 0 : 1)
