/** 验证：从非桌面位置启动便携版，读 localStorage 确认用户数据在 */
import { spawn } from 'node:child_process'
import MiniWS from '../browser/_ws.mjs'

const EXE = process.argv[2]
const PORT = 9415
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const proc = spawn(EXE, [], {
  stdio: 'ignore',
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
})

let target = null
for (let i = 0; i < 60; i++) {
  await sleep(400)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const pg = list.find((x) => x.type === 'page')
    if (pg?.webSocketDebuggerUrl) { target = pg; break }
  } catch { /* not up */ }
}
if (!target) { console.log('✗ 连不上调试端口'); proc.kill(); process.exit(1) }

const ws = new MiniWS(target.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
ws.onmessage = (raw) => {
  const m = JSON.parse(raw)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) }
}
await ws.opened
const send = (method, params = {}) => {
  const i = ++id
  ws.send(JSON.stringify({ id: i, method, params }))
  return new Promise((r) => pend.set(i, r))
}
await send('Runtime.enable')
await sleep(6000)

const expr = `(() => {
  const ks = Object.keys(localStorage)
  let tabCount = 0, tabs = localStorage.getItem('mf:tabs') || ''
  try { tabCount = JSON.parse(tabs || '[]').length } catch {}
  return {
    keys: ks.length,
    tabCount,
    docKeys: ks.filter(k => k.startsWith('mf:doc:')).length,
    tabsPreview: tabs.slice(0, 100),
    active: localStorage.getItem('mf:active'),
  }
})()`
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
const v = r.result.value
console.log('localStorage 内容：')
console.log(JSON.stringify(v, null, 1))
console.log(v.docKeys > 0
  ? `✓ 数据在：${v.docKeys} 份文档，${v.tabCount} 个标签页`
  : '✗ localStorage 是空的（数据可能没恢复）')

ws.close()
try { proc.kill() } catch { /* ignore */ }
await sleep(600)
process.exit(v.docKeys > 0 ? 0 : 1)
