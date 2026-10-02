/**
 * 手机端流畅性回归测试
 * ====================
 * 守住「触摸平移 / 双指缩放不掉帧」这条线。
 *
 * 【为什么需要它】
 * 这两条手势原来每帧都走 setState → 整棵画布重渲染。29 / 300 个节点时看不出问题，
 * 800 个节点时实测掉到 40fps、p95 50ms、119 帧里掉 40 帧。
 * 改成「手势中只写 DOM，结束才提交一次 state」之后是 59fps / p95 16.7ms / 掉 1~2 帧。
 * 这类退化不会让任何功能测试变红，只能靠帧率指标守。
 *
 * 【判定阈值怎么定的】
 *   修复前：800 节点 p95 = 50ms，掉帧率 34%
 *   修复后：800 节点 p95 = 16.7ms，掉帧率 ~1%
 * 阈值取 p95 ≤ 25ms 且掉帧率 ≤ 15%，两边都留了足够余量，
 * 既不会因为抖动误报，又能确实抓住「又变成每帧重渲染」这种退化。
 *
 * 需要 dev server 已启动：npm run dev
 * 用法：node scripts/perftest.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import MiniWS from './_ws.mjs'

const URL_APP = process.argv[2] || 'http://127.0.0.1:5173/'
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

if (!EDGE) {
  console.error('找不到 Edge / Chrome')
  process.exit(2)
}

const PORT = 9362
const userDir = mkdtempSync(join(tmpdir(), 'mf-perftest-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DEV = { name: 'Pixel 7（4x CPU 降速）', w: 412, h: 915, dpr: 2.6, throttle: 4 }
const SIZES = [300, 800]
const P95_LIMIT = 25        // ms
const DROP_RATIO = 0.15     // 掉帧比例上限

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (m) => console.log(`  · ${m}`)

function summ(r) {
  const f = r.frames.filter((x) => x > 0)
  if (!f.length) return null
  const sorted = [...f].sort((a, b) => a - b)
  return {
    fps: 1000 / (f.reduce((a, b) => a + b, 0) / f.length),
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1],
    dropped: f.filter((x) => x > 24).length,
    frames: f.length,
  }
}

async function main() {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, '--window-size=420,940', 'about:blank',
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p?.webSocketDebuggerUrl) { target = p; break }
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('无法连接 Edge DevTools')

  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: DEV.w, height: DEV.h, deviceScaleFactor: DEV.dpr, mobile: true,
    screenWidth: DEV.w, screenHeight: DEV.h,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: DEV.throttle })

  const consoleErrors = []
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown')
  })

  await cdp.send('Page.navigate', { url: URL_APP })
  await sleep(6000)

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }

  console.log(`\n${'='.repeat(56)}\n  ${DEV.name}  ${DEV.w}x${DEV.h} @${DEV.dpr}x\n${'='.repeat(56)}`)

  const INSTALL = `(() => {
    window.__perf = { frames: [], on: false }
    const p = window.__perf
    let last = 0
    const tick = (t) => {
      // 无条件续帧，否则第一帧就退出循环（踩过：探针全空）
      requestAnimationFrame(tick)
      if (!p.on) { last = 0; return }
      if (last) p.frames.push(t - last)
      last = t
    }
    requestAnimationFrame(tick)
    p.reset = () => { p.frames = []; p.on = true; last = 0 }
    p.stop = () => { p.on = false; return { frames: p.frames } }
    return true
  })()`

  /** 文档 id 按规模唯一 —— 否则离开页面时 unmount 的 flushPending 会把上一份写回来 */
  const seed = async (n) => {
    await evaluate(`(() => {
      const N = ${n}
      let seq = 0
      const mk = (text) => ({ id: 'p' + (seq++), text, children: [], collapsed: false, bold: false, italic: false, fold: null })
      const root = mk('根节点')
      const q = [root]
      let made = 1
      while (made < N && q.length) {
        const cur = q.shift()
        for (let k = 0; k < 6 && made < N; k++) {
          const c = mk('节点 ' + made); cur.children.push(c); q.push(c); made++
        }
      }
      const id = 'perftest-' + N
      localStorage.setItem('mf:doc:' + id, JSON.stringify({
        id, name: '性能 ' + N, path: 'perf', folderId: null, root,
        view: { x: 80, y: 60, zoom: 1 }, updatedAt: Date.now(),
      }))
      localStorage.setItem('mf:tabs', JSON.stringify([id]))
      localStorage.setItem('mf:active', JSON.stringify(id))
      return made
    })()`)
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await sleep(250)
    await cdp.send('Page.navigate', { url: URL_APP })
    await sleep(5500)
    return evaluate(`document.querySelectorAll('[data-node-id]').length`)
  }

  const layerT = () => evaluate(`(() => {
    const el = document.querySelector('[data-node-id]')?.parentElement
    return el ? getComputedStyle(el).transform : null
  })()`)

  /**
   * 找一个**真正空白**的画布点来做平移手势。
   *
   * 为什么必须找：Canvas 的空白处拖拽才是平移；如果起点落在节点上，
   * 那条路径会变成「拖拽节点改层级」（`onBackgroundPointerDown` 见到
   * `[data-node-id]` 就直接放行）。800 个节点时画布很密，
   * 固定取屏幕中心大概率砸在某个节点上 —— 于是平移手势根本没发生，
   * 帧率当然是满分（什么都没干），测试变成空测。
   */
  const findEmptyPoint = () => evaluate(`(() => {
    const vw = innerWidth, vh = innerHeight
    const bar = document.querySelector('[data-bottom-toolbar]')
    const br = bar ? bar.getBoundingClientRect() : null
    for (let y = 70; y < vh - 90; y += 14) {
      for (let x = 16; x < vw - 16; x += 14) {
        if (br && y >= br.top - 6) continue
        const el = document.elementFromPoint(x, y)
        if (!el) continue
        if (el.closest('[data-node-id]')) continue
        return { x, y }
      }
    }
    return null
  })()`)

  const cx0 = DEV.w / 2
  const cy0 = DEV.h / 2

  for (const N of SIZES) {
    const rendered = await seed(N)
    console.log(`\n[${N} 个节点]  实际渲染 ${rendered}`)
    check(`规模 ${N}：真的渲染出 ${N} 个节点（防止种子失效导致空测）`,
      rendered === N, String(rendered))
    await evaluate(INSTALL)
    await sleep(300)

    /* ---- 单指平移（必须从空白处起手，否则会变成拖拽节点） ---- */
    const empty = await findEmptyPoint()
    check(`平移：找到空白起点（画布没被节点铺满）`, empty != null, JSON.stringify(empty))
    if (!empty) break
    const cx = empty.x
    const cy = empty.y
    note(`平移起点 (${cx}, ${cy})`)

    /*
     * 起手前先确认「这一点真的落在画布上」，并让这一帧稳定下来。
     *
     * 这两件事必须一起做，因为它们是同一个现象的两面：
     *   · 落入 `[data-canvas-wrap]` 才有平移可言 —— 被面板 / 抽屉挡住的话，
     *     触摸事件根本到不了画布，帧率却是满分（什么都没干的空测）。
     *   · 种子 + INSTALL 之后立刻起手，前几个 `touchMove` 会丢，
     *     transform 一直不动 → 实测「手势真的在动」会假失败（19/21）。
     *     多一次 `Runtime.evaluate` 往返 + 一小段 settle 就够了。
     */
    const hit = await evaluate(`(() => {
      const el = document.elementFromPoint(${cx}, ${cy})
      return {
        inCanvas: !!(el && el.closest('[data-canvas-wrap]')),
        hasWrap: !!document.querySelector('[data-canvas-wrap]'),
        tag: el ? el.tagName : null,
      }
    })()`)
    check('平移：起点落在画布上（没被面板/抽屉挡住）',
      hit.inCanvas === true && hit.hasWrap === true, JSON.stringify(hit))
    await sleep(250)

    const tBefore = await layerT()
    await evaluate(`window.__perf.reset()`)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] })
    let tMid = null
    for (let i = 1; i <= 40; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: cx + Math.sin(i / 5) * 60, y: cy + i * 4, id: 1 }],
      })
      if (i === 20) tMid = await layerT()
      await sleep(16)
    }
    /*
     * 读「手势最后一帧」之前必须让这一帧落地。
     *
     * 最后一次 touchMove 只是**排**了一帧绘制，紧接着读 transform 拿到的还是
     * 上一帧的值，而 touchEnd 之后提交的是最终值 —— 两者一比就成了假失败
     * （实测 3 次里挂 1 次：「末=2.2125 后=2.25」）。这不是 App 的问题：
     * 手势结束把手势中的实时值提交回 state 正是设计。
     */
    await sleep(60)
    const tEnd = await layerT()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(500)
    const tAfter = await layerT()
    const pan = summ(JSON.parse(await evaluate(`JSON.stringify(window.__perf.stop())`)))

    check('平移：手势真的在动（防止空测）',
      tMid !== tBefore && tMid !== tEnd,
      `起=${tBefore} 中=${tMid} 末=${tEnd}`)
    check('平移：手势结束已提交回 state', tAfter === tEnd, `末=${tEnd} 后=${tAfter}`)
    if (pan) {
      note(`平移 ${pan.fps.toFixed(1)}fps  p95=${pan.p95.toFixed(1)}ms  最长=${pan.max.toFixed(1)}ms  掉帧=${pan.dropped}/${pan.frames}`)
      check(`平移：p95 ≤ ${P95_LIMIT}ms`, pan.p95 <= P95_LIMIT, `${pan.p95.toFixed(1)}ms`)
      check(`平移：掉帧率 ≤ ${DROP_RATIO * 100}%`,
        pan.dropped / pan.frames <= DROP_RATIO, `${pan.dropped}/${pan.frames}`)
    } else {
      check('平移：采到帧', false)
    }

    await sleep(400)

    /* ---- 双指捏合（两指起手不挑位置，落在节点上也是捏合） ---- */
    await sleep(250)   // 同上：起手前让这一帧稳定，否则前几个 touchMove 会丢
    const pBefore = await layerT()
    await evaluate(`window.__perf.reset()`)
    const d0 = 60
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: cx0 - d0, y: cy0, id: 1 }, { x: cx0 + d0, y: cy0, id: 2 }],
    })
    let pMid = null
    for (let i = 1; i <= 40; i++) {
      const d = d0 + i * 3
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: cx0 - d, y: cy0, id: 1 }, { x: cx0 + d, y: cy0, id: 2 }],
      })
      if (i === 20) pMid = await layerT()
      await sleep(16)
    }
    await sleep(60)   // 同上：等最后一帧落地再读，否则「已提交回 state」会假失败
    const pEnd = await layerT()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(500)
    const pAfter = await layerT()
    const pinch = summ(JSON.parse(await evaluate(`JSON.stringify(window.__perf.stop())`)))

    check('捏合：手势真的在动（防止空测）',
      pMid !== pBefore && pMid !== pEnd,
      `起=${pBefore} 中=${pMid} 末=${pEnd}`)
    check('捏合：手势结束已提交回 state', pAfter === pEnd, `末=${pEnd} 后=${pAfter}`)
    if (pinch) {
      note(`捏合 ${pinch.fps.toFixed(1)}fps  p95=${pinch.p95.toFixed(1)}ms  最长=${pinch.max.toFixed(1)}ms  掉帧=${pinch.dropped}/${pinch.frames}`)
      check(`捏合：p95 ≤ ${P95_LIMIT}ms`, pinch.p95 <= P95_LIMIT, `${pinch.p95.toFixed(1)}ms`)
      check(`捏合：掉帧率 ≤ ${DROP_RATIO * 100}%`,
        pinch.dropped / pinch.frames <= DROP_RATIO, `${pinch.dropped}/${pinch.frames}`)
    } else {
      check('捏合：采到帧', false)
    }

    await sleep(400)
  }

  console.log('\n[收尾]')
  check('无未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  cdp.close()
  proc.kill()
  try { rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  通过 ${pass} / 失败 ${fail}`)
  console.log('='.repeat(56))
  await sleep(300)
  process.exit(fail ? 1 : 0)
}

async function connect(wsUrl) {
  const ws = new MiniWS(wsUrl)
  await ws.opened
  let id = 0
  const pending = new Map()
  const handlers = new Map()
  ws.onmessage = (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method && handlers.has(msg.method)) handlers.get(msg.method)(msg.params)
  }
  return {
    send(method, params = {}) {
      const mid = ++id
      return new Promise((resolve, reject) => { pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })) })
    },
    on(m, fn) { handlers.set(m, fn) },
    close() { ws.close() },
  }
}

main().catch((e) => { console.error('性能测试失败：', e.message); process.exit(2) })
