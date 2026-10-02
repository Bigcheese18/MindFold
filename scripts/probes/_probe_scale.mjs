/**
 * 一次性探针：滚轮缩放打到上下限时，库会不会「回弹」到 minScale / maxScale？
 * 决定测试该等多久，或者该不该关掉 zoomAnimation 的 padding。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import MiniWS from './_ws.mjs'

const URL_APP = process.argv[2] || 'http://127.0.0.1:5173/'
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p))
const PORT = 9371
const userDir = mkdtempSync(join(tmpdir(), 'mf-scale-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TALL = ['flowchart TD']
for (let i = 0; i < 12; i++) TALL.push(`  n${i}["节点 ${i}"]`)
for (let i = 0; i < 11; i++) TALL.push(`  n${i} --> n${i + 1}`)
const SRC = TALL.join('\n')

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
  let target = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) { target = page; break }
    } catch { /* not up */ }
  }
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: URL_APP })
  await sleep(5000)
  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    ;[...document.querySelectorAll('[data-fold-badge]')][0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(2500)
    document.querySelector('[data-mode-tab="code"]').click()
    await sleep(600)
    const ta = document.querySelector('[data-fold-modal] [data-code-input]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(SRC)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(1800)
    return true
  })()`)

  const scale = () => evaluate(`(() => {
    const c = document.querySelector('[data-graph-viewport] .react-transform-component')
    return new DOMMatrixReadOnly(getComputedStyle(c).transform).a
  })()`)
  const wheel = async (x, y, deltaY, mod = 0) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: mod })
  }

  const vr = await evaluate(`(() => { const r = document.querySelector('[data-graph-viewport]').getBoundingClientRect(); return { cx: r.left + r.width/2, cy: r.top + r.height/2 } })()`)

  console.log('=== 放大到上限 ===')
  for (let i = 0; i < 40; i++) { await wheel(vr.cx, vr.cy, -120, 2); await sleep(30) }
  for (const t of [0, 200, 400, 800, 1600, 3000]) {
    if (t) await sleep(t === 200 ? 200 : 200)
    console.log(`  +${t}ms: scale=${(await scale()).toFixed(4)}`)
  }

  console.log('=== 缩小到下限 ===')
  for (let i = 0; i < 70; i++) { await wheel(vr.cx, vr.cy, 120, 2); await sleep(30) }
  for (const t of [0, 200, 400, 800, 1600, 3000]) {
    if (t) await sleep(t === 200 ? 200 : 200)
    console.log(`  +${t}ms: scale=${(await scale()).toFixed(4)}`)
  }

  cdp.close(); try { proc.kill() } catch { /* ignore */ }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new MiniWS(url); let id = 0
    const pending = new Map(); const handlers = new Map()
    ws.onmessage = (raw) => {
      let msg; try { msg = JSON.parse(raw) } catch { return }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id); pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result)
      } else if (msg.method && handlers.has(msg.method)) { for (const h of handlers.get(msg.method)) h(msg.params) }
    }
    ws.opened.then(() => resolve({
      send(method, params) { const mid = ++id; return new Promise((res, rej) => { pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params })) }) },
      on(method, fn) { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(fn) },
      close: () => ws.close(),
    })).catch(reject)
  })
}

main().catch((e) => { console.error('探针失败：', e); process.exit(2) })
