/**
 * 桌面壳（Tauri + WebView2）实机验证
 * ===================================
 * 为什么非要真启动一次：EXE 里的 JS/CSS **是压缩存的**，
 * 在二进制里 ASCII 搜 `data-shape-picker` 搜不到 —— 只能搜到文件名。
 * 所以「打包产物里到底有没有这个功能」这件事，只有让它跑起来才知道。
 *
 * 做法：用远程调试端口把 WebView2 打开，然后连它的 CDP。
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9411
 * 页面地址是 http://tauri.localhost/（Tauri 的内置协议）。
 *
 * 用法：node scripts/probes/_desktop_shell_check.mjs <exe路径>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import MiniWS from '../browser/_ws.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const EXE = process.argv[2] || 'src-tauri/target/release/mindfold.exe'
const PORT = 9411
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(EXE)) { console.error('找不到 EXE: ' + EXE); process.exit(2) }

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}${e ? ' → ' + e : ''}`) }
}
const note = (m) => console.log(`  · ${m}`)

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
    on(e, f) { handlers.set(e, f) },
    close() { ws.close() },
  }
}

const userData = mkdtempSync(join(tmpdir(), 'mf-wv2-'))
const proc = spawn(EXE, [], {
  stdio: 'ignore',
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: userData,
  },
})

let target = null
for (let i = 0; i < 80; i++) {
  await sleep(300)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url))
    if (page?.webSocketDebuggerUrl) { target = page; break }
  } catch { /* 还没起来 */ }
}
if (!target) {
  console.error('连不上 WebView2 调试端口（EXE 有没有正常启动？）')
  try { proc.kill() } catch { /* ignore */ }
  process.exit(2)
}

const cdp = await connect(target.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
const errs = []
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') errs.push((p.args || []).map((a) => a.value ?? a.description).join(' '))
})
cdp.on('Runtime.exceptionThrown', (p) => {
  errs.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '?')
})

const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
  return r.result.value
}
const waitFor = async (expr, label, timeoutMs = 30000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { if (await ev(expr)) return true } catch { /* 还在起 */ }
    await sleep(250)
  }
  note('等待超时：' + label)
  return false
}

console.log(`\n=== 桌面壳验证：${EXE} ===`)
check('页面地址是 http://tauri.localhost/', /tauri\.localhost/.test(target.url), target.url)
check('React 已挂载（#root 有内容）',
  await waitFor(`!!document.querySelector('#root')?.firstElementChild`, '#root'))

const res = await ev(`(() => {
  const js = [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src'))
  const css = [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.getAttribute('href'))
  return { js, css }
})()`)
/*
 * 【为什么要从 dist/index.html 现读资源名，而不是写死两个哈希名】
 * 这里原本写死了上一轮的两个名字（index-CtfSoqoB.js / index-CBnQM97f.css）。
 * 每轮重新构建后 index-<hash> 必然变，于是这两条断言**每次都假失败** ——
 * 实测这一轮就是：页面加载的明明是这一轮的 index-DN75tVHy.js，
 * 断言却因为名字对不上而报红（报错信息里还恰好把正确的名字打印出来了）。
 * 这和第 111 条坑是同一个病：**把「当下的事实」抄进断言里**。
 * 现在的判据是「页面加载的资源 == dist/index.html 里引用的那个」——
 * 这才真正验到了「EXE 里嵌的是这一轮的产物」，而且永远不会过期。
 * 另外还额外断言「旧的资源名一个都不在」。
 */
const expected = (() => {
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8')
  const js = (html.match(/assets\/index-[\w-]+\.js/) || [])[0]
  const css = (html.match(/assets\/index-[\w-]+\.css/) || [])[0]
  return { js, css }
})()
note(`dist/index.html 引用的产物：${expected.js} / ${expected.css}`)
check('能读出 dist/index.html 里的资源名（前置）',
  Boolean(expected.js && expected.css), JSON.stringify(expected))
check('★ 加载的 JS 就是 dist/index.html 里那一个（EXE 嵌的是这一轮产物）',
  res.js.some((s) => s.includes(expected.js)), JSON.stringify(res.js))
check('★ 加载的 CSS 就是 dist/index.html 里那一个',
  res.css.some((s) => s.includes(expected.css)), JSON.stringify(res.css))
check('旧的资源名一个都不在（前几轮的都搜不到）',
  !res.js.some((s) => /index-(CtfSoqoB|BMhsUKir|76xhC4c_|C3YhVs9T|DlndIGJv)\.js/.test(s)),
  JSON.stringify(res.js))

check('画布渲染出节点',
  await waitFor(`document.querySelectorAll('[data-node-id]').length > 0`, '画布节点'))

/* ---------------- 折角弹窗 + 外形下拉框 ---------------- */
console.log('\n[外形] 打开折角弹窗，用下拉框改形状')
check('折角角标存在', await waitFor(`document.querySelectorAll('[data-fold-badge]').length > 0`, '角标'))
await ev(`document.querySelector('[data-fold-badge]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
check('折角弹窗打开', await waitFor(`!!document.querySelector('[data-fold-modal]')`, '弹窗'))

const pk = await ev(`(() => {
  const s = document.querySelector('[data-shape-picker]')
  return s ? { n: s.options.length, keys: [...s.options].map(o => o.value), disabled: s.disabled } : null
})()`)
check('外形下拉框存在且有 13 项', pk && pk.n === 13, JSON.stringify(pk && { n: pk.n }))
check('13 项就是 13 种外形', pk && pk.keys.join(',') ===
  'rect,rounded,diamond,circle,stadium,cylinder,hexagon,subroutine,lean_right,lean_left,trapezoid,inv_trapezoid,doublecircle',
  JSON.stringify(pk?.keys))

// 切代码模式，直接写一个菱形，看图上是不是多边形
await ev(`document.querySelector('[data-mode-tab="code"]')?.click()`)
await waitFor(`!!document.querySelector('[data-fold-modal] textarea')`, '代码编辑器')
await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const ta = document.querySelector('[data-fold-modal] textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'flowchart TD\\n  A["普通"] --> B{"判断"}\\n  B --> C[(\\"数据库\\")]')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(2500)
  return 1
})()`)
const shapes = await ev(`(() => {
  const m = document.querySelector('[data-fold-modal]')
  return [...m.querySelectorAll('g.node')].map(g => ({
    label: (g.textContent || '').trim(),
    poly: g.querySelectorAll('polygon').length,
    path: g.querySelectorAll('path').length,
  }))
})()`)
const byLabel = Object.fromEntries(shapes.map((s) => [s.label, s]))
check('「普通」渲染成方框', byLabel['普通'] && byLabel['普通'].poly === 0, JSON.stringify(shapes))
check('★ 「判断」在桌面壳里真的是菱形（多边形）',
  byLabel['判断'] && byLabel['判断'].poly === 1, JSON.stringify(byLabel['判断']))
check('★ 「数据库」在桌面壳里真的是圆柱（path）',
  byLabel['数据库'] && byLabel['数据库'].path === 1, JSON.stringify(byLabel['数据库']))

/* ---------------- 顶栏不能被挤爆 ---------------- */
console.log('\n[顶栏] 桌面端与改前一致')
const hdr = await ev(`(() => {
  const m = document.querySelector('[data-fold-modal]')
  const h = m.querySelector('header')
  const reset = m.querySelector('[data-reset-familiarity]')
  const cb = [...h.querySelectorAll('button')].find(b => (b.getAttribute('title')||'').includes('关闭'))
  const r = cb.getBoundingClientRect()
  return {
    overflowPx: h.scrollWidth - h.clientWidth,
    title: !!h.querySelector('h2'),
    resetText: reset ? reset.textContent.trim() : null,
    closeRight: Math.round(r.right), vw: innerWidth,
  }
})()`)
check('顶栏不溢出', hdr.overflowPx <= 0, JSON.stringify(hdr))
check('标题仍然渲染（桌面端没被省掉）', hdr.title === true, JSON.stringify(hdr))
check('重置按钮仍是完整中文（没换成 ↺）', hdr.resetText === '重置熟悉度', JSON.stringify(hdr))
check('关闭按钮在视口内', hdr.closeRight <= hdr.vw, JSON.stringify(hdr))
await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(800)

/* ---------------- 上一轮的桌面端不变性 ---------------- */
console.log('\n[回归] 上一轮验过的桌面端行为')
const tools = await ev(`[...document.querySelectorAll('[data-tool]')].map(e => e.getAttribute('data-tool'))`)
check('底栏 11 颗工具', tools.length === 11, JSON.stringify(tools))
check('底栏没有多余的 merge 入口', !tools.includes('merge'), JSON.stringify(tools))

check('桌面壳里没有装原生返回键（不该装）',
  await ev(`typeof window.__mfHardwareBack === 'undefined'`))

// 滚轮 = 缩放（本轮改的：三个视图统一）；Ctrl+滚轮 = 缩放（捏合通道）
// 选择器是**探出来的**，不是猜的：
//   · 滚轮要打在 [data-canvas-wrap] 上（画布容器）
//   · transform 在它里面那个 div.origin-top-left 上（实测 matrix(0.63,…,164,82)）
/*
 * 【为什么这里从「普通滚轮平移」改成「普通滚轮缩放」】
 * 用户本轮原话：「滚轮键是放大和缩小，如果要滑动的话直接用鼠标滑就行了，
 * 两个视图都是这样的，但思维导图不是这样的」。折角预览和打印预览都是滚轮即缩放，
 * 思维导图必须跟上。所以普通滚轮现在**要**改缩放，不再平移。
 * 平移入口改为空白处拖拽 —— 那条由 scripts/browser/mobileui.mjs 覆盖。
 *
 * 注意断言强度：兜底那条现在还额外要求「真的变大了」，
 * 因为只断言「变了」的话，把缩放改成缩小也能过。
 */
const wheel = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const wrap = document.querySelector('[data-canvas-wrap]')
  if (!wrap) return { error: '找不到画布容器' }
  const inner = wrap.querySelector('.origin-top-left')
  if (!inner) return { error: '找不到画布 transform 元素' }
  const read = () => getComputedStyle(inner).transform
  const m0 = read()
  // 先向上滚一次（放大）——此时缩放值未知，但 clampZoom 上限 2.5，
  // 为避免落在上限上测不出变化，先向下滚几次降到下限附近再向上
  for (let i = 0; i < 12; i++) {
    wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
    await sleep(60)
  }
  const mBase = read()
  wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
  await sleep(400)
  const mUp = read()
  wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true }))
  await sleep(400)
  const mDown = read()
  return { m0, mBase, mUp, mDown }
})()`)
const parse = (s) => {
  const m = String(s).match(/matrix\(([^)]+)\)/)
  if (!m) return null
  const v = m[1].split(',').map(Number)
  return { scale: v[0], tx: v[4], ty: v[5] }
}
const pb = parse(wheel.mBase), pu = parse(wheel.mUp), pd = parse(wheel.mDown)
check('★ 普通滚轮**直接**缩放，不需要按 Ctrl',
  pb && pu && pu.scale > pb.scale + 1e-4, JSON.stringify([pb, pu]))
check('★ Ctrl+滚轮（触控板捏合通道）也能缩放',
  pu && pd && Math.abs(pd.scale - pu.scale) > 1e-4, JSON.stringify([pu, pd]))

/*
 * ================================================================
 * 本轮新功能：折角弹窗「收起编辑区」在**已发布的 EXE** 里真的能用
 * ================================================================
 * 上面那一段（外形下拉框）验的是上一轮的功能。这一段验本轮的：
 * 点一下收起 → 左栏和分割线从 DOM 消失、右栏吃满全宽 → 再点 → 回到原宽度。
 * 为什么非要在这里再验一遍：EXE 里的 JS 是压缩过的，二进制搜字符串搜不到
 * 功能名，只能真跑一次。而且这正是用户提的那个需求
 * （「把左边的编辑区域关闭，只留右边的区域，然后右边的区域放大到全屏」）。
 */
console.log('\n[收起编辑区] 关掉左栏、预览独占全宽（本轮新功能）')
// 上面的外形那节用 Escape 关掉了弹窗（滚轮那节要在没弹窗的画布上量），
// 这里先重新打开它，再验收起/展开。
await ev(`document.querySelector('[data-fold-badge]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
const reopened = await waitFor(`!!document.querySelector('[data-edit-collapse]')`, '收起按钮')
check('重新打开折角弹窗后，桌面端有「收起编辑」按钮', reopened)
const collapse = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const btn = document.querySelector('[data-edit-collapse]')
  if (!btn) return { error: '桌面端没有收起按钮' }
  const pane = (n) => document.querySelector('[data-pane-section="' + n + '"]')
  const splitter = () => {
    // 分割线没有 data- 属性，按「cursor:col-resize」找
    return [...document.querySelectorAll('div')].find(el => {
      const s = getComputedStyle(el)
      return s.cursor === 'col-resize' && el.getBoundingClientRect().width > 0
    }) || null
  }
  const w = (el) => el ? Math.round(el.getBoundingClientRect().width) : null
  /*
   * 【必须先等弹窗开完再量「收起前」】
   * 弹窗是有打开动画的（缩放 + 淡入），期间两栏宽度会从很小的值一路长到最终值。
   * 第一次写这条探针时没等，量到的「收起前」是 78px / 78px ——
   * 于是后面「收起后 = 左右之和」「展开后回到原宽」两条都假失败
   * （真实值是 638 / 638 / 分割线 4，收起后 1280 = 整窗宽）。
   * 判据用「连续三次采样宽度不再变」，而不是 sleep 一个猜的毫秒数。
   */
  let before = null, last = -1, stable = 0
  for (let i = 0; i < 60; i++) {
    const l = w(pane('edit')), r = w(pane('preview'))
    if (l !== null && l === last && l > 200) { stable++; if (stable >= 3) { before = { left: l, right: r, splitter: Boolean(splitter()) }; break } }
    else { stable = 0 }
    last = l
    await sleep(100)
  }
  if (!before) return { error: '弹窗布局一直没有稳定下来' }
  btn.click()
  await sleep(900)
  const after = {
    right: w(pane('preview')), left: w(pane('edit')), splitter: Boolean(splitter()),
    label: (document.querySelector('[data-edit-collapse]') || {}).textContent || '',
  }
  document.querySelector('[data-edit-collapse]').click()
  await sleep(900)
  const back = { right: w(pane('preview')), left: w(pane('edit')) }
  return { before, after, back, aria: btn.getAttribute('aria-pressed') }
})()`)
if (collapse.error) {
  check('桌面端有「收起编辑」按钮', false, collapse.error)
} else {
  note(`收起前：右栏 ${collapse.before.right}px / 左栏 ${collapse.before.left}px / 分割线 ${collapse.before.splitter}`)
  note(`收起后：右栏 ${collapse.after.right}px / 左栏 ${collapse.after.left} / 分割线 ${collapse.after.splitter} / 按钮文字「${collapse.after.label.trim()}」`)
  note(`展开后：右栏 ${collapse.back.right}px / 左栏 ${collapse.back.left}px`)
  check('★ 点「收起编辑」后左栏从 DOM 消失', collapse.after.left === null)
  check('★ 分割线也一起消失（不留半收状态）', collapse.after.splitter === false)
  check('★ 右栏变宽、吃掉左栏让出的空间',
    collapse.after.right > collapse.before.right + 100,
    `${collapse.before.right} → ${collapse.after.right}`)
  check('★ 右栏宽度 ≈ 收起前左右两栏之和（预览真的独占全宽）',
    Math.abs(collapse.after.right - (collapse.before.right + collapse.before.left)) <= 6,
    `${collapse.after.right} vs ${collapse.before.right + collapse.before.left}`)
  check('按钮文字变成「展开编辑」（双态提示）',
    collapse.after.label.includes('展开'), collapse.after.label)
  check('★ 再点一下，左栏回来且宽度与原来一致（±2px）',
    collapse.back.left !== null && Math.abs(collapse.back.left - collapse.before.left) <= 2,
    `${collapse.before.left} → ${collapse.back.left}`)
  check('★ 展开后右栏回到原宽度（±2px）',
    Math.abs(collapse.back.right - collapse.before.right) <= 2,
    `${collapse.before.right} → ${collapse.back.right}`)
}

// 历史版本面板坐标（安全区为 0 时和改前一样）
// 面板**没有 data- 属性**，只能按类名找（实测 class 里有 z-[75] 且宽 300px）
const hist = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const btn = document.querySelector('[data-tool="history"]')
  if (!btn) return { error: '没有历史按钮' }
  btn.click()
  await sleep(900)
  const p = [...document.querySelectorAll('div')].find(e =>
    typeof e.className === 'string' && e.className.includes('z-[75]') && e.className.includes('w-[300px]'))
  if (!p) return { error: '面板没出现' }
  const r = p.getBoundingClientRect()
  return {
    left: Math.round(r.left), bottomGap: Math.round(innerHeight - r.bottom), vh: innerHeight,
  }
})()`)
check('★ 历史面板左侧仍是 12px', hist.left === 12, JSON.stringify(hist))
check('★ 历史面板底部仍是「屏高 - 56」', hist.bottomGap === 56, JSON.stringify(hist))

console.log('\n[控制台]')
const real = errs.filter((e) => !/favicon|Failed to load resource/.test(e))
check('无 console 报错', real.length === 0, real.slice(0, 3).join(' | '))

cdp.close()
try { proc.kill() } catch { /* ignore */ }
await sleep(600)
try { rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n${'='.repeat(46)}`)
console.log(`  桌面壳（已发布 EXE）  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)
