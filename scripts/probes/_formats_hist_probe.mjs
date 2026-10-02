/**
 * 探针：手机端「更多 → 导出面板」这条路上，history 到底漂了几格
 * ==============================================================
 * 背景：formats.mjs 里在手机端打开导出面板、按 Esc 关掉之后，
 * CDP 报 `Inspected target navigated or closed` —— 说明有一次 history.back()
 * 把整页退走了。这个探针只做一件事：把每一步的 history.length / state
 * 以及「有没有真的发生文档级导航」打出来，别靠猜。
 *
 * 用法：node scripts/probes/_formats_hist_probe.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import MiniWS from '../browser/_ws.mjs'

const URL_APP = process.argv[2] || 'http://127.0.0.1:5200/'
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))
const PORT = 9391
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
    send(method, params = {}) {
      const mid = ++id
      ws.send(JSON.stringify({ id: mid, method, params }))
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }))
    },
    on(ev, fn) { handlers.set(ev, fn) },
    close() { ws.close() },
  }
}

const main = async () => {
  const userDir = mkdtempSync(join(tmpdir(), 'mf-hprobe-'))
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, '--window-size=500,900', 'about:blank',
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) { target = page; break }
    } catch { /* ignore */ }
  }
  if (!target) throw new Error('无法连接 Edge')
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  let navs = 0
  const navLog = []
  cdp.on('Page.frameNavigated', (p) => { navs++; navLog.push('frameNavigated ' + (p.frame?.url || '')) })
  cdp.on('Page.navigatedWithinDocument', (p) => navLog.push('withinDocument ' + (p.url || '')))

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'eval failed' }
    return r.result.value
  }
  const state = async (tag) => {
    const s = await ev(`({ href: location.href, len: history.length, state: history.state, idx: (history.state && history.state.mfLayer) || null })`)
    console.log(`  [${tag}] ${JSON.stringify(s)}`)
    return s
  }
  const click = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true })()`)

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await cdp.send('Page.navigate', { url: URL_APP })
  await sleep(2500)
  console.log('--- A. 更多 → 导出 → Esc ---')
  await state('起点')
  await click('[data-tool="more"]'); await sleep(600)
  await state('打开更多')
  await click('[data-more-item="导出"]'); await sleep(800)
  await state('打开导出面板')
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(900)
  await state('Esc 关闭之后')
  await sleep(600)
  await state('再等一会儿')
  console.log(`  文档级导航次数 = ${navs}`)
  console.log('  事件：' + JSON.stringify(navLog.slice(-6)))

  console.log('--- B. 对照：更多 → 历史版本 → 关闭 ---')
  await click('[data-tool="more"]'); await sleep(600)
  await state('打开更多')
  await click('[data-more-item="历史版本"]'); await sleep(800)
  await state('打开历史版本')
  await ev(`document.querySelector('[data-more-item="历史版本"]') && true`)
  await click('[data-tool="more"]'); await sleep(500)
  await click('[data-more-item="历史版本"]'); await sleep(800)
  await state('再点一次收起历史版本')
  await sleep(600)
  await state('等一会儿')
  console.log(`  文档级导航次数 = ${navs}`)

  console.log('--- C. 返回键在只剩一条自己的记录时会不会退走整页 ---')
  await ev(`window.history.back()`)
  await sleep(800)
  await state('history.back() 一次之后')
  await sleep(400)
  console.log(`  文档级导航次数 = ${navs}`)
  console.log('  事件：' + JSON.stringify(navLog.slice(-4)))

  cdp.close()
  proc.kill()
}

main().catch((e) => { console.error(e); process.exit(2) })
