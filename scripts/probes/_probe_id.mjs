/**
 * 一次性探针：mermaid 到底接受哪些 id 写法？
 * 决定「指向」生成 A --> B 时要不要给 id 加引号。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import MiniWS from './_ws.mjs'

const URL_APP = process.argv[2] || 'http://127.0.0.1:5173/'
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const PORT = 9361
const userDir = mkdtempSync(join(tmpdir(), 'mf-probe-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CASES = [
  ['裸 id，普通', 'flowchart TD\n  A["x"]\n  B["y"]\n  A --> B'],
  ['裸 id，带连字符', 'flowchart TD\n  A["x"]\n  node-1["y"]\n  A --> node-1'],
  ['带引号的 id', 'flowchart TD\n  A["x"]\n  node-1["y"]\n  A --> "node-1"'],
  ['带引号的普通 id', 'flowchart TD\n  A["x"]\n  B["y"]\n  A --> "B"'],
  ['引号 + 已有定义', 'flowchart TD\n  A["x"]\n  B["y"]\n  A --> "B"\n  B --> A'],
  ['中文 id 裸写', 'flowchart TD\n  甲["x"]\n  乙["y"]\n  甲 --> 乙'],
]

async function main() {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
    '--window-size=1200,800', 'about:blank',
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) { target = page; break }
    } catch { /* not up */ }
  }
  if (!target) throw new Error('无法连接 Edge')

  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: URL_APP })
  await sleep(5000)

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }

  const out = await evaluate(`(async () => {
    const { renderMermaid } = await import('/src/lib/mermaid.js')
    const cases = ${JSON.stringify(CASES)}
    const res = []
    for (const [name, src] of cases) {
      const r = await renderMermaid(src)
      // 数一下渲染出来的节点数，确认不是「parse 过了但图是空的」
      let nodes = 0
      if (r.ok) {
        const m = r.svg.match(/class="node[^"]*"/g)
        nodes = m ? m.length : 0
      }
      res.push({ name, ok: r.ok, nodes, error: r.ok ? null : String(r.error).slice(0, 120) })
    }
    return res
  })()`)

  for (const r of out) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(18)} nodes=${r.nodes} ${r.error || ''}`)
  }
  cdp.close()
  try { proc.kill() } catch { /* ignore */ }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new MiniWS(url)
    let id = 0
    const pending = new Map()
    ws.onmessage = (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message))
        else res(msg.result)
      }
    }
    ws.opened.then(() => resolve({
      send(method, params) {
        const mid = ++id
        return new Promise((res, rej) => {
          pending.set(mid, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      },
      close: () => ws.close(),
    })).catch(reject)
  })
}

main().catch((e) => { console.error('探针失败：', e); process.exit(2) })
