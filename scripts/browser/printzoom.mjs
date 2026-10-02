/**
 * 真实浏览器验收：打印预览页的滚轮缩放（坑 106 —— 自洽不等于正确）。
 *
 * 上面的 node 测试全是字符串和 DOM 桩：写入端和读取端一起错也能全绿。
 * 这一条走真家伙 —— 真构建产物（dist-print）、真 Edge、真输入事件
 * （CDP Input.dispatchMouseEvent），并且**从真实应用点「导出 PDF」把预览页开出来**，
 * 而不是自己拼一份 HTML。
 *
 * 验四件事：
 *   1) 滚轮真的缩放，且**以光标为锚点**（用真实 getBoundingClientRect 量，
 *      不是用我们自己的公式去自证）；
 *   2) Ctrl+滚轮（触控板捏合）步长更细；
 *   3) 拖拽平移真的能滚（滚轮被缩放占用后的翻页入口）；
 *   4) 打印时版面**一个像素都不变**：切到 print 媒体下量 .page 宽度 / .world
 *      transform，并且用 Page.printToPDF 真出一份 PDF，比较「屏幕缩放 100% /
 *      40% / 300%」三种状态下产出的 PDF —— 页数与字节必须完全一致。
 *
 * 前置：先出构建产物并起静态服务（这一页必须在**构建产物**上测，不能测 dev server）：
 *   $env:TMP/$env:TEMP 指到工作区内（否则 esbuild 删临时文件会被拒）
 *   npx vite build --outDir dist
 *   node scripts/serve-dist.mjs dist 5312
 * 用法：node scripts/browser/printzoom.mjs [url]     默认 http://127.0.0.1:5312/
 *
 * 【本套件为什么从 .build/probe/ 搬到这里】
 * 它原本是 print-zoom 完成任务时放在 .build/ 下的一次性探针。但它验的是
 * 「打印页的滚轮缩放」这个**长期行为**，而且抓到的三条坑（锚点公式符号、
 * 百分比补高、touch-action 漏写）都是 node 测不出来的那类 —— 这种套件
 * 必须留在会被反复跑的位置，否则下次改动没人能复现。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import MiniWS from './_ws.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
const APP = process.argv[2] || process.env.MF_APP_URL || 'http://127.0.0.1:5312/'
const PORT = 9413
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (m) => console.log(`  · ${m}`)
const rounded = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d

async function connect(wsUrl) {
  const ws = new MiniWS(wsUrl)
  await ws.opened
  let id = 0
  const pending = new Map()
  ws.onmessage = (raw) => {
    const m = JSON.parse(raw)
    if (m.id !== undefined && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  }
  return {
    send: (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id; pending.set(mid, { res, rej })
      ws.send(JSON.stringify({ id: mid, method, params }))
    }),
    close: () => ws.close(),
  }
}

const list = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())

/** 等条件而不是等时间（坑 108：sleep 固定毫秒会让测试给出相反结论） */
async function waitFor(label, fn, timeoutMs = 30000) {
  const t0 = Date.now()
  for (;;) {
    try { if (await fn()) return true } catch { /* 还在挂载 */ }
    if (Date.now() - t0 > timeoutMs) { console.log(`  ! 等待超时：${label}`); return false }
    await sleep(150)
  }
}

const userDir = mkdtempSync(join(tmpdir(), 'mf-zoom-'))
let proc
let appCdp
let prevCdp
try {
  proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, '--window-size=1280,900',
    // 预览页是 window.open 出来的，不能拦弹窗
    '--disable-popup-blocking', 'about:blank'], { stdio: 'ignore' })

  const target = await waitFor('DevTools 端口', async () => {
    const l = await list()
    return l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  }).then(async (ok) => (ok ? (await list()).find((t) => t.type === 'page') : null))
  if (!target) throw new Error(`连不上 Edge 的 DevTools 端口 ${PORT}`)

  appCdp = await connect(target.webSocketDebuggerUrl)
  await appCdp.send('Page.enable')
  await appCdp.send('Runtime.enable')
  await appCdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await appCdp.send('Page.navigate', { url: APP })
  const evApp = async (expression) => (await appCdp.send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true })).result.value

  console.log(`\n[0] 真实应用：${APP}`)
  const mounted = await waitFor('应用挂载', () => evApp(`!!document.querySelector('[data-tool="export-pdf"]')`))
  check('真实构建产物加载起来了，并且有「导出 PDF」这颗按钮', mounted)
  if (!mounted) throw new Error('应用没挂载，后面的浏览器验收无从谈起')

  const before = new Set((await list()).map((t) => t.id))
  await evApp(`document.querySelector('[data-tool="export-pdf"]').click(); true`)
  const prevTarget = await waitFor('打印预览页（window.open 出来的新窗口）', async () => {
    const l = await list()
    return l.some((t) => t.type === 'page' && !before.has(t.id) && t.webSocketDebuggerUrl)
  }).then(async (ok) => (ok
    ? (await list()).find((t) => t.type === 'page' && !before.has(t.id))
    : null))
  if (!prevTarget) throw new Error('预览页没开出来（浏览器把 window.open 拦了？）')
  note(`预览页目标：${prevTarget.url || '(about:blank)'}`)

  prevCdp = await connect(prevTarget.webSocketDebuggerUrl)
  await prevCdp.send('Page.enable')
  await prevCdp.send('Runtime.enable')
  await prevCdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  const ev = async (expression) => (await prevCdp.send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true })).result.value
  const wheel = (x, y, deltaY, modifiers = 0) => prevCdp.send('Input.dispatchMouseEvent',
    { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers })

  const ready = await waitFor('预览页 DOM', () => ev(`!!document.getElementById('mf-pages') && document.querySelectorAll('.page').length>0`))
  check('预览页里真的有 id=mf-pages 的缩放容器和分页 section', ready)
  if (!ready) throw new Error('预览页 DOM 不对')

  /* ================================================================== */
  console.log('\n[1] 默认状态与页面结构（真实浏览器）')

  const meta = await ev(`(() => {
    const p = document.getElementById('mf-pages')
    const pages = [...document.querySelectorAll('.page')]
    return {
      zoomInline: p.style.zoom,
      computedZoom: getComputedStyle(p).zoom,
      pageCount: pages.length,
      pageW: pages[0].getBoundingClientRect().width,
      pageH: pages[0].getBoundingClientRect().height,
      worlds: [...document.querySelectorAll('.world')].map(w => w.style.transform),
      pct: document.getElementById('mf-pct').textContent,
      fabRight: getComputedStyle(document.querySelector('.mf-print-fab')).right,
      zoomLeft: getComputedStyle(document.querySelector('.mf-print-zoom')).left,
      zoomBottom: getComputedStyle(document.querySelector('.mf-print-zoom')).bottom,
      scrollH: document.documentElement.scrollHeight,
      hasSpacer: !!document.querySelector('.mf-print-spacer'),
    }
  })()`)
  note(`页数 ${meta.pageCount}，纸宽 ${rounded(meta.pageW, 1)}px（${rounded(meta.pageW / 96 * 25.4, 1)}mm），`
    + `纸高 ${rounded(meta.pageH, 1)}px，滚动高 ${meta.scrollH}px`)
  check('默认没有任何内联 zoom（未缩放 = 改动前的外观）', meta.zoomInline === '' && meta.computedZoom === '1',
    `inline=${JSON.stringify(meta.zoomInline)} computed=${meta.computedZoom}`)
  check('纸宽就是 A4 横向版心 277mm（1046.9px）', Math.abs(meta.pageW - 1046.93) < 1.5, `${rounded(meta.pageW, 1)}px`)
  check('百分比默认 100%', meta.pct === '100%', meta.pct)
  check('每页都有一个 .world transform（分页结构在）', meta.worlds.length === meta.pageCount,
    `${meta.worlds.length} vs ${meta.pageCount}`)

  /* ================================================================== */
  console.log('\n[2] 滚轮真的缩放（CDP 真输入事件）')

  await ev(`window.scrollTo(0, 0); true`)
  await wheel(600, 450, -100)                     // 向上滚一格 = 放大
  await sleep(220)
  const up = await ev(`(() => {
    const p = document.getElementById('mf-pages')
    const pg = document.querySelector('.page')
    return { zoom: p.style.zoom, computed: getComputedStyle(p).zoom,
      pct: document.getElementById('mf-pct').textContent,
      pageW: pg.getBoundingClientRect().width,
      scrollY: Math.round(window.scrollY),
      worlds: [...document.querySelectorAll('.world')].map(w => w.style.transform) }
  })()`)
  note(`滚轮上一格（deltaY=-100）：zoom ${JSON.stringify(up.zoom)}（computed ${up.computed}），`
    + `百分比 ${up.pct}，纸宽 ${rounded(up.pageW, 1)}px，scrollY ${up.scrollY}`)
  check('滚轮向上 = 放大，实测约 1.162 倍', Math.abs(Number(up.zoom) - 1.1618) < 0.002, up.zoom)
  check('CSS zoom 真的生效了（纸宽按比例变大，不是只改了个字符串）',
    Math.abs(up.pageW / meta.pageW - Number(up.zoom)) < 0.01,
    `${rounded(up.pageW, 1)} / ${rounded(meta.pageW, 1)} = ${rounded(up.pageW / meta.pageW, 4)} vs ${up.zoom}`)
  check('百分比显示同步', up.pct === '116%', up.pct)
  check('缩放**没有**碰 .world 的 transform（分页 scale 原样）',
    JSON.stringify(up.worlds) === JSON.stringify(meta.worlds))

  await wheel(600, 450, 100)                      // 向下滚一格 = 回到 1
  await sleep(220)
  const back = await ev(`document.getElementById('mf-pages').style.zoom`)
  check('再向下滚一格回到未缩放（内联 zoom 被清空）', back === '', JSON.stringify(back))

  /* ================================================================== */
  console.log('\n[3] 以光标为锚点（用真实 getBoundingClientRect 量）')

  await ev(`window.scrollTo(0, 600); true`)
  await sleep(200)
  const anchorBefore = await ev(`(() => {
    const pg = document.querySelector('.page')
    const r = pg.getBoundingClientRect()
    return { scrollY: window.scrollY, rectTop: r.top, rectLeft: r.left, zoom: 1 }
  })()`)
  const CY = 420
  const CX = 600
  await wheel(CX, CY, -100)
  await sleep(250)
  const anchorAfter = await ev(`(() => {
    const pg = document.querySelector('.page')
    const r = pg.getBoundingClientRect()
    return { scrollY: window.scrollY, rectTop: r.top, rectLeft: r.left,
      zoom: Number(document.getElementById('mf-pages').style.zoom) }
  })()`)
  /*
   * 锚点的**定义**：光标底下的内容点，其内容坐标在缩放前后必须相同。
   * 内容坐标 = (滚动量 + 视口坐标) / 缩放倍数。
   * 这里用真实的 .page 元素量：既不用我们自己的公式，也不看脚本的内部状态。
   */
  const contentY = (a) => (a.scrollY + a.rectTop) / a.zoom
  const contentX = (a) => (a.scrollX !== undefined ? (a.scrollX + a.rectLeft) / a.zoom : (0 + a.rectLeft) / a.zoom)
  note(`锚点实测：光标 (${CX},${CY})，滚动 ${anchorBefore.scrollY}→${anchorAfter.scrollY}，`
    + `纸顶 ${rounded(anchorBefore.rectTop, 1)}→${rounded(anchorAfter.rectTop, 1)}px，`
    + `内容坐标 ${rounded(contentY(anchorBefore), 1)}→${rounded(contentY(anchorAfter), 1)}`)
  check('缩放后「光标底下的内容坐标」不变（真实 rect，容差 1px）',
    Math.abs(contentY(anchorAfter) - contentY(anchorBefore)) <= 1,
    `${rounded(contentY(anchorBefore), 2)} vs ${rounded(contentY(anchorAfter), 2)}`)
  check('滚动量确实被调整了（不是「什么都不做」也通过）',
    anchorAfter.scrollY !== anchorBefore.scrollY, `${anchorBefore.scrollY} → ${anchorAfter.scrollY}`)

  /* ================================================================== */
  console.log('\n[4] Ctrl+滚轮（触控板捏合）步长更细')

  /*
   * 【量之前必须先复位】双击 = 脚本自己的「复位到 100%」，它会把内部的 z 归 1。
   * 只把 style.zoom 清空是**没用的**：那改的是 CSS，脚本内部的 z 还停在上一个
   * 用例的值上，于是量出来的是「上一个 z × 本次步长」。
   * 这个坑本探针踩了两次（第一次还据此得出了「Chrome 会改写小 deltaY」的错误结论：
   * 1.209 其实是 1.162 × 1.0408）。
   */
  const resetZoom = () => ev(`(() => {
    document.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return document.getElementById('mf-pages').style.zoom
  })()`)
  /** 页面内派发的合成 WheelEvent：绕过浏览器输入层，handler 拿到的就是给的数 */
  const synth = (deltaY, ctrlKey) => ev(`(() => {
    document.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const p = document.getElementById('mf-pages')
    const e = new WheelEvent('wheel', { deltaY: ${deltaY}, ctrlKey: ${ctrlKey},
      clientX: 600, clientY: 450, bubbles: true, cancelable: true })
    p.dispatchEvent(e)
    return { zoom: Number(p.style.zoom), prevented: e.defaultPrevented }
  })()`)

  const padSynth = await synth(-4, true)
  const mouseSynth = await synth(-4, false)
  note(`合成 wheel（deltaY=-4）：Ctrl → ${padSynth.zoom}，无 Ctrl → ${mouseSynth.zoom}`)
  check('Ctrl+滚轮走触控板步长，实测 1.0408 倍（exp(4×0.01)）',
    Math.abs(padSynth.zoom - 1.0408) < 1e-3, `${padSynth.zoom}`)
  check('不带 Ctrl 的同样位移走鼠标步长，变化更小（1.0060）',
    Math.abs(mouseSynth.zoom - 1.006012) < 1e-3 && mouseSynth.zoom < padSynth.zoom,
    `${mouseSynth.zoom}`)
  check('两种都被 preventDefault（Ctrl+滚轮不会触发浏览器整页缩放）',
    padSynth.prevented && mouseSynth.prevented)

  // 同一组位移再走一遍 CDP 真输入：顺带看浏览器有没有改写小 deltaY
  await resetZoom()
  await wheel(600, 450, -4, 2)
  await sleep(220)
  const padReal = await ev(`Number(document.getElementById('mf-pages').style.zoom)`)
  await resetZoom()
  await wheel(600, 450, -4, 0)
  await sleep(220)
  const mouseReal = await ev(`Number(document.getElementById('mf-pages').style.zoom)`)
  note(`CDP 真输入（deltaY=-4）：Ctrl → ${padReal}，无 Ctrl → ${mouseReal}`)
  check('真输入与合成事件量到的步长一致（浏览器没有偷偷改写 deltaY）',
    Math.abs(padReal - padSynth.zoom) < 2e-3 && Math.abs(mouseReal - mouseSynth.zoom) < 2e-3,
    `真输入 ${padReal}/${mouseReal} vs 合成 ${padSynth.zoom}/${mouseSynth.zoom}`)
  check('真输入下 Ctrl 那一档也比鼠标档更粗一点点（同一 deltaY 下 ctrl 步长更大）',
    padReal > mouseReal, `${padReal} vs ${mouseReal}`)

  /* ================================================================== */
  console.log('\n[5] 缩放上下限（真实浏览器夹紧）')

  await ev(`document.getElementById('mf-pages').style.zoom=''; true`)
  for (let i = 0; i < 40; i++) await wheel(600, 450, -100)
  await sleep(300)
  const maxZ = await ev(`Number(document.getElementById('mf-pages').style.zoom)`)
  for (let i = 0; i < 90; i++) await wheel(600, 450, 100)
  await sleep(300)
  const minZ = await ev(`Number(document.getElementById('mf-pages').style.zoom)`)
  check('一直放大被夹在 5', maxZ === 5, `${maxZ}`)
  check('一直缩小被夹在 0.35', minZ === 0.35, `${minZ}`)
  const spacer = await ev(`(() => { const s = document.querySelector('.mf-print-spacer')
    return s ? { h: s.style.height, scrollH: document.documentElement.scrollHeight } : null })()`)
  note(`缩到 ${minZ} 倍后：补高占位 ${spacer ? spacer.h : '(没有)'}，文档滚动高 ${spacer ? spacer.scrollH : '-'}px`)
  check('缩小后补出撑高占位，滚动范围回到未缩放的量级（否则后面几页滚不到）',
    !!spacer && parseFloat(spacer.h) > 0 && spacer.scrollH >= meta.scrollH - 2,
    `${spacer ? spacer.scrollH : '-'} vs ${meta.scrollH}`)

  /* ================================================================== */
  console.log('\n[6] 拖拽平移（滚轮被缩放占用后的翻页入口）')

  await ev(`document.getElementById('mf-pages').style.zoom=''; window.scrollTo(0, 0); true`)
  await sleep(200)
  const scroll0 = await ev(`Math.round(window.scrollY)`)
  await prevCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 600, button: 'left', clickCount: 1, buttons: 1 })
  for (let i = 1; i <= 6; i++) {
    await prevCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 600 - i * 40, button: 'left', buttons: 1 })
  }
  await prevCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 360, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(300)
  const scroll1 = await ev(`Math.round(window.scrollY)`)
  note(`拖拽实测：按住 (700,600) 往上拖 240px → scrollY ${scroll0} → ${scroll1}`)
  check('拖拽真的把页面滚动了（手指往上拖 = 往后看）', scroll1 >= scroll0 + 200,
    `${scroll0} → ${scroll1}`)
  const zoomAfterDrag = await ev(`document.getElementById('mf-pages').style.zoom`)
  check('拖拽不会顺手改缩放', zoomAfterDrag === '', JSON.stringify(zoomAfterDrag))

  /* ================================================================== */
  console.log('\n[7] 双击复位 100%')

  await wheel(600, 450, -100)
  await sleep(200)
  const zoomed = await ev(`document.getElementById('mf-pages').style.zoom`)
  await prevCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 450, button: 'left', clickCount: 2, buttons: 1 })
  await prevCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 600, y: 450, button: 'left', clickCount: 2, buttons: 0 })
  await sleep(300)
  const afterDbl = await ev(`document.getElementById('mf-pages').style.zoom`)
  check(`双击复位到 100%（从 ${zoomed} 回到空）`, afterDbl === '', JSON.stringify(afterDbl))

  /* ================================================================== */
  console.log('\n[8] 缩放按钮与百分比')

  await ev(`document.getElementById('mf-zin').click(); true`)
  await sleep(200)
  const afterIn = await ev(`({ zoom: document.getElementById('mf-pages').style.zoom, pct: document.getElementById('mf-pct').textContent })`)
  await ev(`document.getElementById('mf-zout').click(); true`)
  await sleep(200)
  const afterOut = await ev(`({ zoom: document.getElementById('mf-pages').style.zoom, pct: document.getElementById('mf-pct').textContent })`)
  check('点「+」放大到 1.25 倍、百分比跟着走', Math.abs(Number(afterIn.zoom) - 1.25) < 1e-9 && afterIn.pct === '125%',
    `${afterIn.zoom} / ${afterIn.pct}`)
  check('点「−」回到 100%', afterOut.zoom === '' && afterOut.pct === '100%', `${afterOut.zoom} / ${afterOut.pct}`)

  /* ================================================================== */
  console.log('\n[9] 打印时版面一个像素都不变（print 媒体 + 真出 PDF）')

  const printState = async () => ev(`(() => {
    const p = document.getElementById('mf-pages')
    const pages = [...document.querySelectorAll('.page')]
    return {
      inlineZoom: p.style.zoom,
      computedZoom: getComputedStyle(p).zoom,
      pageW: pages[0].getBoundingClientRect().width,
      pageCount: pages.length,
      worlds: [...document.querySelectorAll('.world')].map(w => w.style.transform),
      zoomBar: getComputedStyle(document.querySelector('.mf-print-zoom')).display,
      fab: getComputedStyle(document.querySelector('.mf-print-fab')).display,
      spacer: getComputedStyle(document.querySelector('.mf-print-spacer') || document.body).display,
    }
  })()`)

  const pdf = async () => {
    const r = await prevCdp.send('Page.printToPDF', {
      landscape: true, printBackground: true, preferCSSPageSize: true,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    })
    return Buffer.from(r.data, 'base64')
  }
  /** PDF 里跟时间/随机 ID 有关的部分与页面无关，抹掉再比字节 */
  const pdfSig = (buf) => {
    const s = buf.toString('latin1')
      .replace(/\/CreationDate\s*\([^)]*\)/g, '')
      .replace(/\/ModDate\s*\([^)]*\)/g, '')
      .replace(/\/ID\s*\[[^\]]*\]/g, '')
    return {
      bytes: buf.length,
      pages: (s.match(/\/Type\s*\/Page[^s]/g) || []).length,
      mediaBoxes: (s.match(/\/MediaBox/g) || []).length,
      hash: createHash('sha256').update(s, 'latin1').digest('hex').slice(0, 16),
    }
  }

  // 三种屏幕缩放状态下各出一份 PDF
  const pdfs = []
  for (const z of [1, 0.4, 3]) {
    await ev(`(() => { const p=document.getElementById('mf-pages')
      p.style.zoom = ${z === 1 ? "''" : `'${z}'`}; window.scrollTo(0,0); return getComputedStyle(p).zoom })()`)
    await sleep(250)
    pdfs.push([z, pdfSig(await pdf())])
  }
  note('三种屏幕缩放状态下 Page.printToPDF 的产出：')
  for (const [z, s] of pdfs) {
    console.log(`      zoom=${z === 1 ? '100%' : z * 100 + '%'} → ${s.bytes} 字节 / ${s.pages} 页 / `
      + `${s.mediaBoxes} 个 MediaBox / 内容哈希 ${s.hash}`)
  }
  check('屏幕缩放 100% / 40% / 300% 下，打印出的 PDF **页数完全相同**',
    pdfs.every(([, s]) => s.pages === pdfs[0][1].pages) && pdfs[0][1].pages >= 1)
  check('三种状态出的 PDF **字节完全相同**（屏幕缩放对纸上产出零影响）',
    pdfs.every(([, s]) => s.hash === pdfs[0][1].hash),
    pdfs.map(([z, s]) => `${z}:${s.hash}`).join(' '))
  check('PDF 里每页都是同一个 MediaBox（分页尺寸没被缩放改掉）',
    pdfs[0][1].mediaBoxes === pdfs[0][1].pages, `${pdfs[0][1].mediaBoxes} vs ${pdfs[0][1].pages}`)

  /*
   * 用**脚本自己的缩放路径**（真滚轮）进入缩放态，再模拟打印/退出打印。
   * 不能手写 style.zoom —— 那只会改样式，脚本内部记的 z 还是 1，
   * 打印后「恢复」时自然恢复成 1（我第一次就是这么写的，量出来是空串）。
   */
  await ev(`window.scrollTo(0,0); true`)
  await wheel(600, 450, -100)
  await wheel(600, 450, -100)
  await sleep(250)
  const zoomedForPrint = await ev(`document.getElementById('mf-pages').style.zoom`)
  await prevCdp.send('Emulation.setEmulatedMedia', { media: 'print' })
  await sleep(300)
  const inPrint = await printState()
  note(`print 媒体下：computed zoom=${inPrint.computedZoom}，纸宽 ${rounded(inPrint.pageW, 1)}px，`
    + `控制条 display=${inPrint.zoomBar}，打印按钮 display=${inPrint.fab}`)
  check('print 媒体下内联 zoom 被复位（computed zoom = 1）', inPrint.computedZoom === '1',
    inPrint.computedZoom)
  check('print 媒体下纸宽回到 277mm 版心（缩放没有渗进纸面）',
    Math.abs(inPrint.pageW - 1046.93) < 1.5, `${rounded(inPrint.pageW, 1)}px`)
  check('print 媒体下 .world 分页 transform 与未缩放时逐字节相同',
    JSON.stringify(inPrint.worlds) === JSON.stringify(meta.worlds))
  check('print 媒体下缩放控制条隐藏（纸上不存在）', inPrint.zoomBar === 'none', inPrint.zoomBar)
  check('print 媒体下打印按钮隐藏（既有行为未变）', inPrint.fab === 'none', inPrint.fab)

  await prevCdp.send('Emulation.setEmulatedMedia', { media: 'screen' })
  await sleep(300)
  const backScreen = await ev(`document.getElementById('mf-pages').style.zoom`)
  note(`退出 print 媒体后：zoomed=${zoomedForPrint} → 恢复成 ${JSON.stringify(backScreen)}`)
  check('回到 screen 媒体后，用户原来的缩放被恢复', backScreen === zoomedForPrint,
    `${JSON.stringify(backScreen)} vs ${JSON.stringify(zoomedForPrint)}`)

  /*
   * 截图留证：一张缩到 ~64% 的全貌。
   * 【必须走脚本自己的路径】直接写 style.zoom 只会改 CSS：页面看着缩了，
   * 左下角的百分比还停在上一个值（我第一次截的图就是「画面 55%、标签 135%」，
   * vision 一眼就看出不一致）。用「双击复位 + 点两次缩小」，
   * 标签和画面才是同一个数 —— 用户能走的路也只有这一条。
   */
  await ev(`document.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`)
  await sleep(200)
  await ev(`document.getElementById('mf-zout').click(); true`)
  await sleep(200)
  await ev(`document.getElementById('mf-zout').click(); true`)
  await sleep(400)
  const shotState = await ev(`({ zoom: document.getElementById('mf-pages').style.zoom,
    pct: document.getElementById('mf-pct').textContent, scrollY: window.scrollY })`)
  note(`截图时：style.zoom=${shotState.zoom}，标签 ${shotState.pct}`)
  check('截图状态自洽：百分比标签与实际 zoom 一致（1/1.25² = 64%）',
    Math.abs(Number(shotState.zoom) - 0.64) < 1e-9 && shotState.pct === '64%',
    `${shotState.zoom} / ${shotState.pct}`)
  const shot = await prevCdp.send('Page.captureScreenshot', { format: 'png' })
  // 产物落在工作区的 .build/ 下：这是「留证」不是交付物，不进 src/ 也不进 scripts/
  const shotPath = join(ROOT, '.build/print-zoom-shot.png')
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  note(`截图：${shotPath}`)
  const pdfPath = join(ROOT, '.build/print-zoom-proof.pdf')
  writeFileSync(pdfPath, await pdf())
  note(`PDF 留证：${pdfPath}`)

  console.log(`\n${fail === 0 ? '真实浏览器验收通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.log(`\n探针异常：${e.message}\n`)
} finally {
  try { appCdp?.close() } catch { /* ignore */ }
  try { prevCdp?.close() } catch { /* ignore */ }
  try { proc?.kill() } catch { /* ignore */ }
  try { rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
}
process.exit(fail === 0 ? 0 : 1)
