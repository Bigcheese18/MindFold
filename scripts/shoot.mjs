/**
 * 截图工具：渲染首屏 + 折角弹窗，用于人工核对视觉。
 * 用法：node scripts/shoot.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, createReadStream, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, resolve as resolvePath } from 'node:path'
import { createServer } from 'node:http'
import MiniWS from './browser/_ws.mjs'

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
const DIST = resolvePath(process.cwd(), 'dist')
const PORT = 9344
const userDir = mkdtempSync(join(tmpdir(), 'mf-shot-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MIME = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }

function serveStatic(root) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0])
      if (p === '/') p = '/index.html'
      const file = join(root, p)
      if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
      createReadStream(file).pipe(res)
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }))
  })
}

async function connect(wsUrl) {
  const ws = new MiniWS(wsUrl)
  await ws.opened
  let id = 0
  const pending = new Map()
  ws.onmessage = (raw) => {
    const m = JSON.parse(raw)
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    }
  }
  return {
    send: (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id; pending.set(mid, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id: mid, method, params }))
    }),
    close: () => ws.close(),
  }
}

async function main() {
  const srv = await serveStatic(DIST)
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) { target = page; break }
    } catch { /* wait */ }
  }
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  // headless 下 --window-size 对复用目标不生效，必须显式设置视口
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${srv.port}/` })
  await sleep(5000)

  const ev = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(name, Buffer.from(r.data, 'base64'))
    console.log('已保存', name)
  }

  // 1. 首屏（纯白主题）
  await shot('shot-1-canvas-white.png')

  // 2. 夜间主题
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.title === '夜间')
    if (b) b.click(); return !!b
  })()`)
  await sleep(1200)
  await shot('shot-2-canvas-dark.png')

  // 回到纯白
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.title==='纯白'); if(b)b.click(); return !!b })()`)
  await sleep(800)

  // 3. 折角弹窗（电脑端左右分栏）
  await ev(`(() => {
    for (const n of document.querySelectorAll('[data-node-id]')) {
      const hit = n.querySelector('.mf-fold-hit'), fold = n.querySelector('.mf-fold')
      if (hit && fold && !fold.classList.contains('mf-fold-hollow')) { hit.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true }
    }
    return false
  })()`)
  await sleep(3000)
  await shot('shot-3-fold-modal.png')

  // 4. 先关闭弹窗，再进雷达复习模式（弹窗是全屏遮罩，会盖住画布）
  await ev(`(() => {
    const btns = [...document.querySelectorAll('.mf-unfold button')]
    const x = btns.find(b => b.textContent.trim() === '✕')
    if (x) x.click()
    return !!x
  })()`)
  await sleep(1500)
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('雷达')); if(b)b.click(); return !!b })()`)
  await sleep(1500)
  await shot('shot-4-radar.png')

  // 5. 卡片复习模式
  await ev(`(() => {
    const r = [...document.querySelectorAll('button')].find(x => (x.title || '').includes('雷达'))
    if (r) r.click()   // 先退出雷达
    return true
  })()`)
  await sleep(600)
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('卡片复习')); if(b)b.click(); return !!b })()`)
  await sleep(2000)
  await shot('shot-5-card-review.png')

  // 6. 左侧大纲树滑出（先退出卡片复习 —— 该按钮没有 title，按文字找）
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '退出复习')
    if (b) b.click()
    return !!b
  })()`)
  await sleep(900)
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.title || '').includes('常显大纲'))
    if (b) b.click()
    return !!b
  })()`)
  await sleep(1200)
  await shot('shot-6-outline.png')

  // 7. 文件夹：新建两个并把文档归类，展示分组效果
  await ev(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const header = [...document.querySelectorAll('aside div')]
      .find(d => /^文档\\s*\\d*/.test(d.textContent.trim()) && d.className.includes('flex'))
    if (!header) return false
    const setInput = (el, v) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    for (const name of ['计算机网络', '数学']) {
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 130, clientY: 560 }))
      await sleep(350)
      const mk = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '新建文件夹')
      if (!mk) return false
      mk.click()
      await sleep(500)
      const input = document.querySelector('aside input:not([placeholder])')
      if (input) { setInput(input, name); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }
      await sleep(600)
    }
    // 把两个文档分别移入文件夹
    const rows = [...document.querySelectorAll('[data-doc-id]')]
    for (let i = 0; i < Math.min(rows.length, 2); i++) {
      const row = document.querySelectorAll('[data-doc-id]')[i]
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 600 }))
      await sleep(350)
      const target = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === (i === 0 ? '计算机网络' : '数学'))
      if (target) target.click()
      await sleep(700)
    }
    return true
  })()`)
  await sleep(1200)
  await shot('shot-7-folders.png')

  await cdp.close(); proc.kill(); srv.close()
  try { rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

main().catch((e) => { console.error(e.message); process.exit(1) })