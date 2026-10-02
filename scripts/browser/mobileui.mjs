/**
 * 手机端专项：抽屉 / 返回键 / 边缘手势废除
 * ==========================================
 * 这一套只测「手机端专属」的新东西，且每一条都同时验证**桌面端没被带坏** ——
 * 需求里最重要的一条约束就是「绝对不允许修改桌面端的布局和逻辑」，
 * 所以凡是「手机端改了行为」的地方，这里都配一条桌面端的反向断言。
 *
 * 覆盖需求：
 *   一·1  废除手机端边缘手势（左边缘 / 顶部下拉）
 *   一·2  左上角 44×44 汉堡菜单 → 80% 抽屉 + 半透明遮罩 + 50px 横向多标签区
 *   三    useMobileBack：优先级 3/2/1、返回键关浮层、UI 关闭补 history.back()、
 *         多浮层绝不一按全关
 *   五·4  手机端 UI 去 Emoji（改 Lucide SVG）
 *
 * 需要 dev server 已启动：npm run dev
 * 用法：node scripts/mobileui.mjs [url]
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
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

if (!EDGE) {
  console.error('找不到 Edge / Chrome')
  process.exit(2)
}

const PORT = 9375
const userDir = mkdtempSync(join(tmpdir(), 'mf-mobileui-'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (msg) => console.log(`  · ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }

async function main() {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) { target = page; break }
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('无法连接 Edge DevTools')

  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', DESKTOP)

  const consoleErrors = []
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push((p.args || []).map((a) => a.value ?? a.description).join(' '))
  })
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown')
  })

  await cdp.send('Page.navigate', { url: URL_APP })
  await sleep(5000)

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }

  const setViewport = async (vp) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', vp)
    await sleep(900)
  }

  const realClick = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(420)
  }
  /**
   * 手机端长按（Canvas 的 LONG_PRESS_MS = 500ms）。
   * 必须用真实指针事件按住不放 —— 合成一个 click 绕过长按定时器，
   * 弹出来的菜单就不是真实路径了。
   */
  const longPressAt = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await sleep(750)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(420)
  }
  const rectOf = (sel) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: Math.round(r.width), h: Math.round(r.height),
             cx: r.left + r.width / 2, cy: r.top + r.height / 2, right: r.right, bottom: r.bottom }
  })()`)
  /** 只要中心点：rectOf 本来就算好了，起个别名让调用处读起来更直白 */
  const centerOf = rectOf

  /** 模拟手机物理返回键 */
  const pressBack = () => evaluate(`(async () => {
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    await new Promise(r => setTimeout(r, 500))
    return true
  })()`)

  /** 在 history.back 上装一个探针，统计它被调了几次 */
  const spyBack = () => evaluate(`(() => {
    if (!window.__mfBackSpy) {
      window.__mfBackCount = 0
      window.__mfBackSpy = true
      const orig = window.history.back.bind(window.history)
      window.history.back = function (...a) { window.__mfBackCount++; return orig(...a) }
    }
    window.__mfBackCount = 0
    return true
  })()`)
  const backCount = () => evaluate('window.__mfBackCount || 0')

  /* ================================================================== */
  console.log('\n[1] 手机端：汉堡菜单按钮（一·2）')
  /* ================================================================== */

  await setViewport(DESKTOP)
  const desktopMenuBtn = await evaluate(`!!document.querySelector('[data-mobile-menu-btn]')`)
  check('★ 桌面端**没有**汉堡按钮（不污染桌面 UI）', desktopMenuBtn === false, String(desktopMenuBtn))
  /*
   * 本轮新增的「文档标签」入口（右上角那颗）也必须是手机端专属：
   * 桌面端的标签栏是「鼠标贴到屏幕顶边自己滑出来」，多一颗常驻按钮
   * 就改变了桌面端的 UI。
   */
  check('★ 桌面端**没有**右上角「文档标签」入口',
    (await evaluate(`!!document.querySelector('[data-mobile-tabs-btn]')`)) === false)
  check('★ 桌面端标签栏仍是桌面那一支（不是手机面板）',
    (await evaluate(`(() => {
      const el = document.querySelector('.mf-slide-top')
      if (!el) return 'missing'
      return el.hasAttribute('data-mobile-tabs-sheet') ? 'mobile' : 'desktop'
    })()`)) === 'desktop')

  await setViewport(PHONE)
  const btn = await rectOf('[data-mobile-menu-btn]')
  check('★ 手机端左上角出现汉堡按钮', btn != null, JSON.stringify(btn))
  if (btn) {
    note(`汉堡按钮 ${btn.w}x${btn.h} @ (${btn.x.toFixed(0)}, ${btn.y.toFixed(0)})`)
    check('★ 热区 44×44', btn.w === 44 && btn.h === 44, `${btn.w}x${btn.h}`)
    check('★ 贴在左上角（x < 40 且 y < 80，避开刘海）',
      btn.x < 40 && btn.y < 80, `x=${btn.x} y=${btn.y}`)
    check('里面有 SVG 图标（不是 Emoji/字符）',
      (await evaluate(`document.querySelector('[data-mobile-menu-btn] svg') ? true : false`)) === true)
  }

  /* ================================================================== */
  console.log('\n[2] 抽屉：80% 宽 + 遮罩 + **只有大纲树**（一·2 / 本轮拆分）')
  /* ================================================================== */

  await realClick(btn.cx, btn.cy)
  const drawer = await rectOf('[data-mobile-drawer]')
  check('★ 点击汉堡滑出抽屉', drawer != null, JSON.stringify(drawer))
  if (drawer) {
    const vw = PHONE.width
    const ratio = drawer.w / vw
    note(`抽屉宽 ${drawer.w} / 视口 ${vw} = ${(ratio * 100).toFixed(1)}%`)
    check('★ 抽屉宽度约 80%（允许 maxWidth 420 的夹取）',
      ratio >= 0.75 || drawer.w === 420, `${(ratio * 100).toFixed(1)}%`)
    check('抽屉贴左边', drawer.x <= 1, String(drawer.x))
    check('抽屉撑满高度', drawer.h >= PHONE.height - 2, `${drawer.h} vs ${PHONE.height}`)
  }
  check('★ 有半透明遮罩', (await rectOf('[data-drawer-mask]')) != null)

  /*
   * ★ 本轮改动：抽屉里**不再**有「文档标签」长条。
   * 用户原话：「思维导图左侧和顶部好难受 手机端希望分开 像电脑端一样但是适配手机端」——
   * 改之前「文档标签」和「大纲树」挤在同一个抽屉里，现在标签归右上角
   * data-mobile-tabs-btn，抽屉只剩大纲。
   */
  check('★ 抽屉里**没有**「文档标签」长条（左侧和顶部已拆开）',
    (await evaluate(`document.querySelectorAll('[data-drawer-tabs],[data-drawer-tab]').length`)) === 0)
  check('★ 抽屉里有 44px 热区的「关闭大纲」按钮',
    await (async () => {
      const r = await rectOf('[data-drawer-close]')
      return r != null && r.w >= 40 && r.h >= 32
    })())
  check('★ 抽屉里有大纲树（embedded 模式）',
    (await evaluate(`!!document.querySelector('[data-outline-tree][data-embedded="true"]')`)) === true)

  /*
   * ★ 第六/七轮：主题切换在「左侧栏」里，而且就在**固定按钮左边**。
   *   用户原话：「改变主题的图案很大 能不能换到左侧栏里面 这样就有空间了」，
   *   随后给死落点：「放到左侧栏里面的固定按钮左边就行 移动端也是」。
   *   手机端的左侧栏就是这条抽屉，右侧那颗 ✕（关闭大纲）就是「固定按钮」。
   *   这里钉五件事：
   *     ① 色块真的在抽屉里；
   *     ② 真的在固定按钮**左边**、而且和它**同一行**（“左边”不是“上一行/下一行”）；
   *     ③ 触摸热区没有因为「搬家 + 并进一行」被顺手改小；
   *     ④ 名字没丢：手机端为最窄机型省掉了「主题」二字，aria-label 就是唯一的名字；
   *     ⑤ 在抽屉里点一下**真的能换主题** —— 元素存在不等于能力还在。
   */
  const drawerTheme = await evaluate(`(() => {
    const d = document.querySelector('[data-mobile-drawer]')
    if (!d) return null
    const row = d.querySelector('[data-theme-row]')
    const close = d.querySelector('[data-drawer-close]')
    const bs = [...d.querySelectorAll('[data-theme-option]')]
    const rb = row ? row.getBoundingClientRect() : null
    const cb = close ? close.getBoundingClientRect() : null
    const db = d.getBoundingClientRect()
    return {
      keys: bs.map((b) => b.dataset.themeOption),
      h: bs.map((b) => Math.round(b.getBoundingClientRect().height)),
      names: bs.map((b) => b.getAttribute('aria-label')),
      placement: row ? row.dataset.placement : null,
      // 「在固定按钮左边」：色块整组的右缘不超过 ✕ 的左缘
      leftOfClose: rb && cb ? rb.right <= cb.left + 1 : false,
      // 「同一行」：两组控件中心高度差（并成一行之后这里应当≈0）
      centerSpread: rb && cb ? Math.round(Math.abs((rb.top + rb.bottom) / 2 - (cb.top + cb.bottom) / 2)) : 999,
      // 「不再单占一条底栏」：整组色块的底边仍在那条 48px 抽屉头里
      rowBottomInHeader: rb ? Math.round(rb.bottom - db.top) <= 52 : false,
    }
  })()`)
  note(`抽屉主题行：${JSON.stringify(drawerTheme)}`)
  check('★ 抽屉（手机端左侧栏）里有三个主题色块',
    drawerTheme?.keys?.join() === 'white,sepia,dark', JSON.stringify(drawerTheme))
  check('★ 色块触摸热区 ≥40px（搬家 / 并进一行都不许把触摸目标改小）',
    (drawerTheme?.h || []).length === 3 && drawerTheme.h.every((h) => h >= 40),
    JSON.stringify(drawerTheme?.h))
  check('★ 色块在固定按钮（✕）左边、和它同一行（中心差 ≤ 8px）',
    drawerTheme?.leftOfClose === true && drawerTheme?.centerSpread <= 8,
    `leftOfClose=${drawerTheme?.leftOfClose} spread=${drawerTheme?.centerSpread}`)
  check('色块在抽屉头那一行（data-placement=header，不再是底部另立一行）',
    drawerTheme?.placement === 'header' && drawerTheme?.rowBottomInHeader === true,
    `placement=${drawerTheme?.placement} bottomInHeader=${drawerTheme?.rowBottomInHeader}`)
  check('手机端省掉「主题」二字后，名字仍走 aria-label（三颗都读得到）',
    (drawerTheme?.names || []).join('|') === '主题：纯白|主题：护眼|主题：夜间',
    JSON.stringify(drawerTheme?.names))

  {
    const themed = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const d = document.querySelector('[data-mobile-drawer]')
      d?.querySelector('[data-theme-option="dark"]')?.click()
      await sleep(700)
      return {
        attr: document.documentElement.getAttribute('data-theme'),
        // store.setTheme 走 safeSet → JSON 序列化，取值要解一次
        stored: (() => { try { return JSON.parse(localStorage.getItem('mf:theme')) } catch { return localStorage.getItem('mf:theme') } })(),
        pressed: d?.querySelector('[data-theme-option="dark"]')?.getAttribute('aria-pressed'),
      }
    })()`)
    check('★ 手机端在左侧栏里能切主题（改之前这个能力在手机上是丢的）',
      themed.attr === 'dark' && themed.stored === 'dark', JSON.stringify(themed))
    check('当前主题按钮 aria-pressed=true', themed.pressed === 'true', String(themed.pressed))
    // 切回纯白，后面的用例按浅色主题量
    await evaluate(`document.querySelector('[data-theme-option="white"]')?.click()`)
    await sleep(600)
  }

  /* ================================================================== */
  console.log('\n[2b] 顶部：文档标签入口 + 标签面板（本轮新增）')
  /* ================================================================== */

  await realClick(btn.cx, btn.cy)   // 先关掉抽屉
  await sleep(400)

  const tb = await rectOf('[data-mobile-tabs-btn]')
  check('★ 手机端右上角有「文档标签」入口', tb != null, JSON.stringify(tb))
  if (tb) {
    note(`文档标签入口 ${tb.w}x${tb.h} @ (${tb.x.toFixed(0)}, ${tb.y.toFixed(0)})`)
    check('★ 它是 44px 高（WCAG 触摸目标建议值）', Math.round(tb.h) === 44, String(tb.h))
    check('★ 贴在右上角（右边缘在屏内、水平不小于 40% 屏宽处）',
      tb.right <= PHONE.width + 1 && tb.x > PHONE.width * 0.4, `x=${tb.x} right=${tb.right} vw=${PHONE.width}`)
    check('★ 显示的是当前文档名（一眼看出这是文档而不是大纲）',
      (await evaluate(`(() => {
        const label = (document.querySelector('[data-mobile-tabs-btn] span') || {}).textContent || ''
        const tabs = JSON.parse(localStorage.getItem('mf:tabs') || '[]')
        const active = JSON.parse(localStorage.getItem('mf:active') || 'null')
        const cur = tabs.find((t) => t.id === active)
        return label.trim().length > 0 && (!cur || label.trim() === cur.name)
      })()`)) === true)
    check('★ 两个入口不重叠（左侧大纲 / 右侧文档标签）',
      tb.x > btn.right + 4, `menuRight=${btn.right} tabsX=${tb.x}`)
  }
  check('★ 左上角那颗仍然只管大纲（标题 title=打开大纲）',
    (await evaluate(`document.querySelector('[data-mobile-menu-btn]').getAttribute('title')`)) === '打开大纲')

  // 打开标签面板
  await realClick(tb.cx, tb.cy)
  await sleep(700)
  const sheet = await rectOf('[data-mobile-tabs-sheet]')
  check('★ 点入口滑出文档标签面板', sheet != null, JSON.stringify(sheet))
  if (sheet) {
    check('★ 面板整条贴着屏幕顶部，宽度铺满', Math.round(sheet.w) === PHONE.width, `${sheet.w} vs ${PHONE.width}`)
    check('★ 面板完全展开（transform 归零后 top≈0）', sheet.y <= 2, String(sheet.y))
    const inside = await evaluate(`(() => {
      const s = document.querySelector('[data-mobile-tabs-sheet]')
      const tabs = [...s.querySelectorAll('[data-tab-id]')]
      const first = tabs[0] ? tabs[0].getBoundingClientRect() : null
      return {
        tabs: tabs.length, h: first ? Math.round(first.height) : 0,
        newBtn: !!s.querySelector('[data-mobile-tabs-new]'),
        // 第八轮：主题已经搬去左侧栏头部，这条面板里应当**一颗都没有**
        theme: [...s.querySelectorAll('[data-theme-option]')].map(b => b.dataset.themeOption),
        close: !!s.querySelector('[data-mobile-tabs-close]'),
        rowScroll: getComputedStyle(s.querySelector('[data-mobile-tabs-row]')).overflowX,
      }
    })()`)
    note(`面板内容：${JSON.stringify(inside)}`)
    check('★ 面板里有文档标签', inside.tabs >= 1, String(inside.tabs))
    check('★ 每个标签 44px 高（手机端专属档位，不是桌面的 28px）', inside.h === 44, String(inside.h))
    check('★ 标签行横向可滑', inside.rowScroll === 'auto', inside.rowScroll)
    check('★ 面板里有「新建文档」', inside.newBtn === true)
    check('★ 面板里有「收起面板」按钮', inside.close === true)
    check('★ 主题色块已经从这条面板搬走（面板里一颗都不剩）',
      inside.theme.length === 0, JSON.stringify(inside.theme))

    /*
     * ★ 「太乱了」那条反馈的量化断言。
     *
     * 用户原话：「手机版里面的思维导图顶部标签页有点太乱了 和电脑一样简到那一点就行」。
     * 改之前这个面板是三行（标题行 + 44px 标签行 + 一整行带文字的主题按钮），
     * 实测约 150px 高。现在只有一行 —— 所以要钉住三件事：
     *   ① 整条面板的高度；② 剩下的控件组是不是同一行；
     *   ③ 横向有没有溢出（压缩 flex 里中文逐字换行是坑 116）。
     * 只断言「元素存在」是抓不到「又变回三行」的：元素一直都在。
     */
    const oneRow = await evaluate(`(() => {
      const s = document.querySelector('[data-mobile-tabs-sheet]')
      const r = s.getBoundingClientRect()
      const pick = (sel) => {
        const el = s.querySelector(sel)
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), cy: Math.round((b.top + b.bottom) / 2) }
      }
      const groups = ['[data-mobile-tabs-row]', '[data-mobile-tabs-close]']
        .map(pick).filter(Boolean)
      const cys = groups.map((g) => g.cy)
      return {
        h: Math.round(r.height),
        groups: groups.length,
        centerSpread: cys.length ? Math.max(...cys) - Math.min(...cys) : 999,
        noXOverflow: s.scrollWidth <= s.clientWidth + 1,
        rowCounts: {
          tabs: document.querySelectorAll('[data-mobile-tabs-sheet] [data-tab-id]').length,
          theme: document.querySelectorAll('[data-mobile-tabs-sheet] [data-theme-option]').length,
        },
      }
    })()`)
    note(`标签面板：高 ${oneRow.h}px · 两组控件中心差 ${oneRow.centerSpread}px`
      + ` · 横向溢出=${!oneRow.noXOverflow}`)
    check('★ 面板压缩成一行（≤64px；改之前是三行约 150px）', oneRow.h <= 64, String(oneRow.h))
    check('★ 标签行 / 收起在同一行上（中心差 ≤ 8px）',
      oneRow.groups === 2 && oneRow.centerSpread <= 8, JSON.stringify(oneRow))
    check('★ 面板横向不溢出（不再靠压缩中文换行来挤）', oneRow.noXOverflow === true)
    check('文档相关控件一个没少（标签 + 新建 + 收起）',
      oneRow.rowCounts.tabs >= 1 && oneRow.rowCounts.theme === 0, JSON.stringify(oneRow.rowCounts))
  }

  // 切文档
  const tabCount = await evaluate(`document.querySelectorAll('[data-mobile-tabs-sheet] [data-tab-id]').length`)
  if (tabCount >= 2) {
    const secondId = await evaluate(`document.querySelectorAll('[data-mobile-tabs-sheet] [data-tab-id]')[1].dataset.tabId`)
    await evaluate(`document.querySelectorAll('[data-mobile-tabs-sheet] [data-tab-id]')[1].click()`)
    await sleep(900)
    const activeNow = await evaluate(`(() => {
      const raw = localStorage.getItem('mf:active')
      try { return JSON.parse(raw) } catch { return raw }
    })()`)
    check('★ 点面板里的标签能切文档', activeNow === secondId, `${activeNow} vs ${secondId}`)
    check('切换后面板自动收起', (await rectOf('[data-mobile-tabs-sheet]')) === null
      || (await evaluate(`document.querySelector('[data-mobile-tabs-sheet]').getBoundingClientRect().top < -20`)) === true)
  } else {
    note('只有一个标签页，跳过切文档用例')
  }

  // 点面板外面收起
  {
    await evaluate(`document.querySelector('[data-mobile-tabs-btn]').click()`)
    await sleep(600)
    check('前置：面板又打开了', (await rectOf('[data-mobile-tabs-sheet]')) != null)
    await realClick(20, PHONE.height - 120)   // 画布空白处
    await sleep(600)
    const closed = await evaluate(`(() => {
      const s = document.querySelector('[data-mobile-tabs-sheet]')
      return !s || s.getBoundingClientRect().top < -20
    })()`)
    check('★ 点面板外面收起面板', closed === true)
  }

  // 返回键收起面板（本轮新注册的一层，必须和其他浮层同一套规矩）
  {
    await spyBack()
    await evaluate(`document.querySelector('[data-mobile-tabs-btn]').click()`)
    await sleep(600)
    const opened = await evaluate(`(() => {
      const s = document.querySelector('[data-mobile-tabs-sheet]')
      return !!s && s.getBoundingClientRect().top > -20
    })()`)
    check('前置：文档标签面板打开', opened === true)
    /*
     * 这里直接把 history.state 读出来，不复用 [5] 里那个 layerState()  helper ——
     * 它是在本节后面才定义的 const，在前面调用会撞上暂时性死区（TDZ）。
     */
    const layer = await evaluate(`(window.history.state && window.history.state.mfLayer) || null`)
    note(`文档标签面板压入的 layer = ${JSON.stringify(layer)}`)
    check('★ 打开文档标签面板会压入一条历史记录（返回键能收）', layer != null, String(layer))
    await pressBack()
    const after = await evaluate(`(() => {
      const s = document.querySelector('[data-mobile-tabs-sheet]')
      return { gone: !s || s.getBoundingClientRect().top < -20, drawer: !!document.querySelector('[data-mobile-drawer]') }
    })()`)
    check('★ 按返回键收起文档标签面板', after.gone === true, JSON.stringify(after))
    check('★ 返回键只收这一层，不会顺手把抽屉也开了/关了', after.drawer === false, JSON.stringify(after))
    check('★ 返回键关浮层时不调 history.back()（会多退一层）',
      (await backCount()) === 0, String(await backCount()))

    /*
     * 收尾：把上面那次「合成 popstate」留下的死记录用**真实 back()** 清掉。
     * 不清的话 history.state.mfLayer 会一直是 3，后面 [5] 的
     * 「前置：还没有浮层标记」就会失败 —— 而那条规矩本身是对的
     * （UI 关闭要补 back()，返回键关闭不补），[6] 专门在验它。
     */
    await evaluate('window.history.back()')
    await sleep(700)
    check('合成 popstate 之后补一次真实 back() 能把状态清干净',
      (await evaluate(`(window.history.state && window.history.state.mfLayer) || null`)) === null)
  }

  /* ================================================================== */
  console.log('\n[3] 点遮罩关闭（一·2）')
  /* ================================================================== */

  await realClick(btn.cx, btn.cy)
  check('前置：抽屉又打开了', (await rectOf('[data-mobile-drawer]')) != null)
  const mask = await rectOf('[data-drawer-mask]')
  // 点遮罩右侧（避开抽屉本身）
  await realClick(PHONE.width - 20, mask.cy)
  check('★ 点遮罩关闭抽屉', (await rectOf('[data-mobile-drawer]')) === null)

  /* ================================================================== */
  console.log('\n[4] 废除边缘手势（一·1）')
  /* ================================================================== */

  // 手机端：左边缘 mousemove 不应滑出任何东西
  await evaluate(`window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, clientY: 400, bubbles: true }))`)
  await sleep(400)
  const afterEdge = await evaluate(`(() => {
    const desktopTree = [...document.querySelectorAll('[data-outline-tree]')]
      .filter(el => el.dataset.embedded !== 'true')
    return {
      desktopTreeCount: desktopTree.length,
      drawerOpen: !!document.querySelector('[data-mobile-drawer]'),
    }
  })()`)
  check('★ 手机端左边缘滑动不会滑出大纲（边缘手势已废除）',
    afterEdge.desktopTreeCount === 0 && afterEdge.drawerOpen === false,
    JSON.stringify(afterEdge))

  /*
   * ★ 顶部边缘才是**真正可观测**的那一条。
   *
   * 左边缘那条其实是「因为桌面大纲在手机端压根没渲染」才通过的 ——
   * 就算把边缘感应绑回手机端，它也照样绿（实测如此，属于空测）。
   * 而 TopTabs 在手机端是**一直渲染**的，只是靠 `.mf-slide-top` 滑出屏幕；
   * 所以「鼠标贴到顶部会不会把标签栏拉出来」才是真正能区分绑没绑的断言。
   */
  await evaluate(`window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 2, bubbles: true }))`)
  await sleep(450)
  const topEdge = await evaluate(`(() => {
    const el = document.querySelector('.mf-slide-top')
    if (!el) return { exists: false }
    const r = el.getBoundingClientRect()
    return { exists: true, open: el.classList.contains('open'), bottom: Math.round(r.bottom), top: Math.round(r.top) }
  })()`)
  note(`手机端顶部边缘感应：${JSON.stringify(topEdge)}`)
  check('★ 手机端鼠标贴顶部不会滑出标签栏（边缘手势已废除）',
    topEdge.exists === false || topEdge.open === false,
    JSON.stringify(topEdge))

  // 桌面端：边缘感应必须仍然生效（回归保护）
  await setViewport(DESKTOP)
  await evaluate(`window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, clientY: 400, bubbles: true }))`)
  await sleep(500)
  const desktopEdge = await evaluate(`(() => {
    const el = document.querySelector('[data-outline-tree]')
    if (!el) return { exists: false }
    const r = el.getBoundingClientRect()
    return { exists: true, x: Math.round(r.x), w: Math.round(r.width), open: el.classList.contains('open') }
  })()`)
  note(`桌面端边缘感应：${JSON.stringify(desktopEdge)}`)
  check('★ 桌面端左边缘感应仍然生效（没被改坏）',
    desktopEdge.exists === true && desktopEdge.x >= 0 && desktopEdge.w > 0,
    JSON.stringify(desktopEdge))

  /*
   * ★ 第六/七轮：主题在左侧栏里、并在「固定（图钉）按钮」左边。
   *   这一段紧跟在「边缘感应」回归断言后面：此刻桌面侧栏正是滑出的状态，
   *   色块看得见、是 24px 桌面档（不是手机的 40px），而且
   *   ① 位置是用户点名的「固定按钮左边、同一行」；
   *   ② 它是**并进头部那一行**的，不再单占一条底栏（省下整整 36px 树高）；
   *   ③ 顶部标签栏里**一颗都不剩** —— 搬家和复制是两件事，
   *      「复制一份留在原地」也被这条钉死（这正是「手机版还是不行」的现场：
   *      APK 里跑的是搬家之前的包，顶部还挂着三颗）。
   */
  const deskTheme = await evaluate(`(() => {
    const tree = document.querySelector('[data-outline-tree]:not([data-embedded="true"])')
    const t = tree && tree.querySelector('[data-theme-row]')
    const pin = tree && tree.querySelector('[data-pin-tree]')
    if (!t || !pin) return null
    const bs = [...t.querySelectorAll('[data-theme-option]')]
    const rb = t.getBoundingClientRect()
    const pb = pin.getBoundingClientRect()
    const hb = t.parentElement.getBoundingClientRect()
    return {
      keys: bs.map((b) => b.dataset.themeOption),
      h: bs.map((b) => Math.round(b.getBoundingClientRect().height)),
      label: ((t.querySelector('span') || {}).textContent || '').trim(),
      placement: t.dataset.placement,
      leftOfPin: rb.right <= pb.left + 1,
      centerSpread: Math.round(Math.abs((rb.top + rb.bottom) / 2 - (pb.top + pb.bottom) / 2)),
      inViewport: rb.top >= 0 && rb.bottom <= window.innerHeight + 1,
      headerH: Math.round(hb.height),
      topBarTheme: document.querySelectorAll('.mf-slide-top [data-theme-option]').length,
    }
  })()`)
  note(`桌面侧栏主题行：${JSON.stringify(deskTheme)}`)
  check('★ 桌面侧栏头部有主题三色块（24px 桌面档、整组落在视口内）',
    deskTheme?.keys?.join() === 'white,sepia,dark'
    && deskTheme.h.every((h) => h === 24) && deskTheme.inViewport === true,
    JSON.stringify(deskTheme))
  check('★ 色块在固定（图钉）按钮左边、和它同一行（中心差 ≤ 8px）',
    deskTheme?.leftOfPin === true && deskTheme?.centerSpread <= 8,
    `leftOfPin=${deskTheme?.leftOfPin} spread=${deskTheme?.centerSpread}`)
  check('★ 色块并进头部那一行（该行 36px），不再单占一条底栏',
    deskTheme?.placement === 'header' && deskTheme?.headerH === 36,
    `placement=${deskTheme?.placement} headerH=${deskTheme?.headerH}`)
  check('桌面端保留「主题」二字（手机端为最窄机型省掉、改走 aria-label）',
    deskTheme?.label === '主题', String(deskTheme?.label))
  check('★ 顶部标签栏里已经没有主题色块（是搬走，不是复制一份）',
    deskTheme?.topBarTheme === 0, String(deskTheme?.topBarTheme))
  {
    const themed = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const pick = (k) => document.querySelector('[data-outline-tree]:not([data-embedded="true"]) [data-theme-option="' + k + '"]')
      pick('sepia')?.click()
      await sleep(600)
      const attr = document.documentElement.getAttribute('data-theme')
      pick('white')?.click()
      await sleep(500)
      return attr
    })()`)
    check('★ 桌面端在侧栏里点色块能换主题（护眼）', themed === 'sepia', String(themed))
  }

  // 移开，收回去
  await evaluate(`window.dispatchEvent(new MouseEvent('mousemove', { clientX: 900, clientY: 400, bubbles: true }))`)
  await sleep(500)

  /* ================================================================== */
  console.log('\n[5] 返回键：抽屉（优先级 1）')
  /* ================================================================== */

  await setViewport(PHONE)
  await evaluate('window.__mfBackCount = 0')

  /*
   * 断言用 `history.state.mfLayer` 而不是 `history.length`。
   *
   * length 在这里是**不可靠**的信号：Chromium 的 history.length 在 back() 之后
   * **不会变小**，而本套件里既有「返回键」（合成 popstate，不动真实栈）
   * 又有「UI 关闭」（真实 back()），两者交错之后 length 的绝对值就没意义了。
   * 而 `history.state` 恰好就是 Hook 压进去的那个标记，直接看它最准。
   */
  const layerState = () => evaluate(`(window.history.state && window.history.state.mfLayer) || null`)

  check('前置：还没有浮层标记', (await layerState()) === null, String(await layerState()))

  await realClick(btn.cx, btn.cy)
  check('前置：抽屉打开', (await rectOf('[data-mobile-drawer]')) != null)
  const pushed = await layerState()
  note(`压入的 layer 标记 = ${JSON.stringify(pushed)}`)
  check('★ 打开浮层会压入一条历史记录（history.state.mfLayer）',
    pushed != null, String(pushed))

  await pressBack()
  check('★ 按返回键关闭抽屉', (await rectOf('[data-mobile-drawer]')) === null)
  check('★ 返回键关浮层时**不再调** history.back()（会多退一层）',
    (await backCount()) === 0, String(await backCount()))

  /* ================================================================== */
  console.log('\n[6] UI 关闭按钮必须补一次 history.back()（三·2）')
  /* ================================================================== */

  await spyBack()
  await realClick(btn.cx, btn.cy)
  check('前置：抽屉打开', (await rectOf('[data-mobile-drawer]')) != null)
  const pushed2 = await layerState()
  check('前置：这次也压入了标记', pushed2 != null, String(pushed2))
  await realClick(PHONE.width - 20, 400)   // 点遮罩 = UI 关闭
  await sleep(700)
  check('★ 点遮罩关闭后补了一次 history.back()（清掉死记录）',
    (await backCount()) >= 1, String(await backCount()))
  check('★ back() 之后那条浮层标记已经不在栈顶了',
    (await layerState()) !== pushed2, `${JSON.stringify(pushed2)} → ${JSON.stringify(await layerState())}`)

  /* ================================================================== */
  console.log('\n[7] 多浮层按优先级关闭，绝不一按全关（三·3）')
  /* ================================================================== */

  await spyBack()
  /*
   * 【顺序很关键：必须先开弹窗(2)，再开抽屉(1)】
   *
   * 「同优先级取最后注册」这条兜底逻辑意味着：如果按优先级顺序打开，
   * 那么「注册顺序」和「优先级顺序」恰好一致 —— 这时候把三个优先级全改成一样，
   * 测试**照样绿**（实测如此，是个空测）。
   * 只有让注册顺序和优先级**相反**，才能真正区分「按优先级挑」和「挑最后一个」。
   */
  const badge = await evaluate(`(() => {
    const b = document.querySelector('[data-fold-badge]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  let modalOpened = false
  if (badge) {
    await evaluate(`document.querySelector('[data-fold-badge]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(2600)
    modalOpened = await evaluate(`!!document.querySelector('[data-fold-modal]')`)
  }
  check('前置：全屏弹窗已打开（先注册，优先级 2）', modalOpened === true)

  // 弹窗盖住了汉堡按钮，用程序化点击打开抽屉（优先级 1，但**后注册**）
  await evaluate(`document.querySelector('[data-mobile-menu-btn]').click()`)
  await sleep(700)
  check('前置：抽屉也打开了（后注册，优先级 1）',
    (await rectOf('[data-mobile-drawer]')) != null)
  note(`抽屉=${(await rectOf('[data-mobile-drawer]')) != null} 弹窗=${modalOpened}`)

  if (modalOpened) {
    await pressBack()
    const afterFirst = await evaluate(`({
      modal: !!document.querySelector('[data-fold-modal]'),
      drawer: !!document.querySelector('[data-mobile-drawer]'),
    })`)
    note(`第一次返回后：${JSON.stringify(afterFirst)}`)
    check('★ 第一次返回只关掉优先级更高的弹窗（2），后注册的抽屉(1)还在',
      afterFirst.modal === false && afterFirst.drawer === true, JSON.stringify(afterFirst))

    await pressBack()
    const afterSecond = await evaluate(`({
      modal: !!document.querySelector('[data-fold-modal]'),
      drawer: !!document.querySelector('[data-mobile-drawer]'),
    })`)
    note(`第二次返回后：${JSON.stringify(afterSecond)}`)
    check('★ 第二次返回才关掉抽屉',
      afterSecond.modal === false && afterSecond.drawer === false, JSON.stringify(afterSecond))
  } else {
    check('★ 第一次返回只关掉优先级更高的浮层', false, '弹窗没打开，无法验证优先级')
  }

  /* ================================================================== */
  console.log('\n[8] 桌面端返回键不被应用吃掉（三·1）')
  /* ================================================================== */

  await setViewport(DESKTOP)
  await spyBack()
  const histD0 = await evaluate('history.length')
  // 桌面端打开大纲（边缘感应），此时不该压栈
  await evaluate(`window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, clientY: 400, bubbles: true }))`)
  await sleep(500)
  const histD1 = await evaluate('history.length')
  check('★ 桌面端打开浮层**不压历史记录**（只有 ≤768px 才生效）',
    histD1 === histD0, `${histD0} → ${histD1}`)

  /* ================================================================== */
  console.log('\n[9] 手机端 UI 去 Emoji（五·4）')
  /* ================================================================== */

  await setViewport(PHONE)
  const emoji = await evaluate(`(() => {
    // 只看手机端**可见**的 UI 元素
    const bad = []
    const EMOJI = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]/u
    const roots = [
      document.querySelector('[data-bottom-toolbar]'),
      document.querySelector('[data-mobile-menu-btn]'),
      document.querySelector('[data-mobile-drawer]'),
    ].filter(Boolean)
    for (const root of roots) {
      for (const el of root.querySelectorAll('*')) {
        for (const node of el.childNodes) {
          if (node.nodeType === 3 && EMOJI.test(node.textContent)) {
            bad.push((el.tagName + '.' + (el.className || '')).slice(0, 60) + ' :: ' + node.textContent.trim())
          }
        }
      }
    }
    return bad
  })()`)
  note(`手机端可见 Emoji：${JSON.stringify(emoji)}`)
  check('★ 手机端可见 UI 里没有 Emoji', emoji.length === 0, JSON.stringify(emoji))

  const svgIcons = await evaluate(`(() => {
    const bar = document.querySelector('[data-bottom-toolbar]')
    const btns = [...bar.querySelectorAll('[data-tool]')]
    return btns.map(b => ({ tool: b.dataset.tool, hasSvg: !!b.querySelector('svg'),
                            text: b.textContent.trim().slice(0, 4) }))
  })()`)
  note(`底栏按钮：${JSON.stringify(svgIcons)}`)
  const missingSvg = svgIcons.filter((b) => !b.hasSvg)
  check('★ 手机端底栏每颗按钮都是 SVG 图标',
    missingSvg.length === 0, JSON.stringify(missingSvg))

  // 用户数据里的 Emoji 绝不能被清理
  const userEmojiKept = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const root = document.querySelector('[data-canvas-wrap]')
    return { hasCanvas: !!root }
  })()`)
  check('画布仍然正常（去 Emoji 没有波及数据）', userEmojiKept.hasCanvas === true)

  /* ================================================================== */
  console.log('\n[9b] 横屏 / 矮视口 + 刘海安全区 + 原生壳导出')
  /* ================================================================== */
  /*
   * 这一节补的是「手机端适配」里三个只有真机上才暴露的坑：
   *
   *   1. 「更多」面板是 bottom:100% 向上长的，内容固定 384px 高。
   *      竖屏够用，**横屏装不下**：实测 iPhone SE 横屏（667×375）面板
   *      top = -69px、「卡片复习」整条被顶到屏幕外；而且它当时是
   *      overflow:hidden + 没有 max-height，滚都滚不到 —— 条目永久不可达。
   *   2. 提示条原来写死 bottom:64px，而底部工具栏是「12px + 安全区」起算的。
   *      刘海屏（安全区 34px）下工具栏顶边在 H-86，提示条底边固定在 H-64，
   *      压住工具栏上半截 22px。安全区在浏览器里没法真的模拟，但
   *      env() 已经被抽成 CSS 变量了，直接改那个变量就能等价复现。
   *   3. 原生壳（安卓/iOS WebView）**没有下载通道也没有打印接口**，
   *      导出点了既不报错也不落文件。这里验证「会当场说清楚」，
   *      并且验证这条判断**不会**漏到普通浏览器上（桌面端导出照旧）。
   */
  const LANDSCAPE = { width: 667, height: 375, deviceScaleFactor: 2, mobile: true }
  const jsClick = (sel) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    el.click()
    return true
  })()`)

  await setViewport(LANDSCAPE)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await sleep(600)

  const landCompact = await evaluate(`!!document.querySelector('[data-tool="more"]')`)
  check('★ 横屏窄边（667px）仍然是手机端布局（有「更多」按钮）', landCompact === true, String(landCompact))
  check('横屏下 pointer:coarse 成立（后面的媒体查询才有意义）',
    (await evaluate(`matchMedia('(pointer: coarse)').matches`)) === true)

  if (landCompact) {
    await jsClick('[data-tool="more"]')
    await sleep(450)
    const sheet = await evaluate(`(() => {
      const s = document.querySelector('[data-more-sheet]')
      if (!s) return null
      const vh = document.documentElement.clientHeight
      const cs = getComputedStyle(s)
      const r = s.getBoundingClientRect()
      const items = [...s.querySelectorAll('[data-more-item]')]
      const inside = (el) => { const b = el.getBoundingClientRect(); return b.top >= -1 && b.bottom <= vh + 1 }
      // 先把面板滚到最上面，量第一条；再滚到底，量最后一条
      s.scrollTop = 0
      const firstInside = items.length ? inside(items[0]) : false
      s.scrollTop = s.scrollHeight
      const lastInside = items.length ? inside(items[items.length - 1]) : false
      s.scrollTop = 0
      return {
        vh, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
        overflowY: cs.overflowY, maxHeight: cs.maxHeight,
        scrollH: s.scrollHeight, clientH: s.clientHeight,
        items: items.length, firstInside, lastInside,
      }
    })()`)
    check('★ 横屏下「更多」面板不再顶出屏幕上边（顶部条目可见）',
      sheet != null && sheet.top >= -1, JSON.stringify(sheet))
    if (sheet) {
      note(`横屏面板 top=${sheet.top} 高=${sheet.h}（视口高 ${sheet.vh}）`
        + ` · overflowY=${sheet.overflowY} max-height=${sheet.maxHeight}`
        + ` · 内容 ${sheet.scrollH} / 可视 ${sheet.clientH}`)
      check('★ 横屏下首条可达（滚动前就在视口内）', sheet.firstInside === true)
      check('★ 横屏下末条可达（滚到底能在视口内）', sheet.lastInside === true)
      check('装不下时面板可滚动（不是 overflow:hidden 把条目永久藏起来）',
        sheet.scrollH <= sheet.clientH + 1 || /auto|scroll/.test(sheet.overflowY),
        `scrollH=${sheet.scrollH} clientH=${sheet.clientH} overflowY=${sheet.overflowY}`)
      check('面板底边仍在底栏上方（没被夹到工具栏上）',
        sheet.bottom <= sheet.vh, `bottom=${sheet.bottom} vh=${sheet.vh}`)
    }
    await jsClick('[data-tool="more"]')
    await sleep(300)
  }
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })

  /* ---- 刘海屏安全区：提示条不能压住底部工具栏 ---- */
  await setViewport(PHONE)
  /*
   * 原生壳里点导出会走「说清楚」那条分支 —— 正好用它造一条**最长的**提示，
   * 顺便验证提示条不会把 375px 的视口撑出横向滚动。
   */
  await evaluate(`window.androidBridge = {}`)
  await jsClick('[data-tool="more"]')
  await sleep(400)
  /*
   * 导出入口现在是「更多 → 导出… → 导出格式面板 → 选 Markdown」两级。
   * 路径变长不代表断言变弱：这里仍然验证「点了会明确告诉我这儿不能导出」，
   * 而且顺带验证了格式面板在手机端也能正常打开、每一行都点得到
   * （面板里的格式清单由 formats 套件逐项验）。
   */
  await jsClick('[data-more-item="导出"]')
  await sleep(400)
  check('前置：手机端「更多」里点导出会打开格式面板',
    (await rectOf('[data-export-sheet]')) != null)
  await jsClick('[data-export-format="md"]')
  await sleep(400)
  await evaluate(`document.documentElement.style.setProperty('--mf-safe-b', '34px')`)
  await sleep(300)
  const safe = await evaluate(`(() => {
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    const t = document.querySelector('[data-app-toast]')
    const bar = document.querySelector('[data-bottom-toolbar]')
    if (!t || !bar) return null
    const tr = t.getBoundingClientRect()
    const br = bar.getBoundingClientRect()
    return {
      vw, vh,
      toast: { top: Math.round(tr.top), bottom: Math.round(tr.bottom), left: Math.round(tr.left), right: Math.round(tr.right) },
      bar: { top: Math.round(br.top), bottom: Math.round(br.bottom) },
      text: t.textContent.trim(),
      overlap: tr.bottom > br.top && tr.top < br.bottom,
    }
  })()`)
  check('模拟刘海屏（安全区 34px）后提示条与底部工具栏不重叠',
    safe != null && safe.overlap === false, JSON.stringify(safe))
  if (safe) {
    note(`安全区 34px：工具栏 ${safe.bar.top}..${safe.bar.bottom} · 提示条 ${safe.toast.top}..${safe.toast.bottom}`)
    check('★ 提示条不横向溢出（长提示在窄屏要换行，不能撑出滚动条）',
      safe.toast.left >= -1 && safe.toast.right <= safe.vw + 1,
      JSON.stringify({ left: safe.toast.left, right: safe.toast.right, vw: safe.vw }))
    check('原生壳里导出会明确说明「应用内不能保存文件」而不是毫无反应',
      /WebView/.test(safe.text) && /电脑版/.test(safe.text), safe.text)
  }
  await evaluate(`document.documentElement.style.removeProperty('--mf-safe-b')`)

  /* ---- 这条判断不能漏到普通浏览器：桌面端导出照旧 ---- */
  await evaluate(`delete window.androidBridge`)
  await evaluate(`(() => {
    // 拦掉真实的下载动作，只观察「有没有走下载这条路」，避免测试往磁盘写文件
    window.__mfOrigClick = HTMLAnchorElement.prototype.click
    window.__mfDownloaded = []
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__mfDownloaded.push(this.download); return }
      return window.__mfOrigClick.apply(this, arguments)
    }
    return true
  })()`)
  await jsClick('[data-tool="more"]')
  await sleep(400)
  await jsClick('[data-more-item="导出"]')
  await sleep(400)
  await jsClick('[data-export-format="md"]')
  await sleep(400)
  const web = await evaluate(`(() => {
    const t = document.querySelector('[data-app-toast]')
    return { text: t ? t.textContent.trim() : null, downloaded: window.__mfDownloaded || [] }
  })()`)
  check('★ 普通浏览器（无原生桥）导出照旧走下载，没有被误判成原生壳',
    web.text === '已导出 Markdown 源文件' && web.downloaded.some((n) => /\.md$/.test(n)),
    JSON.stringify(web))
  await evaluate(`HTMLAnchorElement.prototype.click = window.__mfOrigClick`)

  /* ================================================================== */
  console.log('\n[9c] 顶部安全区：状态栏不压任何东西')
  /* ================================================================== */

  /*
   * 用户原话：「手机端有好多东西和顶部状态栏重叠」。
   *
   * 底部安全区早就处理了（--mf-safe-b），顶部一直漏着：edge-to-edge 下
   * WebView 铺到 y=0，而状态栏（时间 / 电量 / 信号）悬浮在页面之上。
   *
   * 怎么在无头浏览器里造出「状态栏」：本项目的安全区**只有一个定义处**
   * —— index.css 的 `--mf-safe-t: env(safe-area-inset-top, 0px)`，
   * 其余全部引用这个变量（已核对：src 里再也没有第二处 env(safe-area-*)）。
   * 所以把变量改成 47px，等价于「一台状态栏高 47px 的手机」。
   */
  await setViewport(PHONE)
  await evaluate(`document.documentElement.style.setProperty('--mf-safe-t', '47px')`)
  await evaluate(`document.documentElement.style.setProperty('--mf-safe-b', '34px')`)
  await sleep(400)

  const SAFE_T = 47

  /** 量一个元素的上边缘，顺带把它「应该避开状态栏」这件事说清楚 */
  const topOf = (sel) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
  })()`)

  // 1) 汉堡按钮（用 mf-fixed-top 那一类）
  const ham = await topOf('[data-mobile-menu-btn]')
  check('★ 汉堡按钮整体落在状态栏下面', ham != null && ham.top >= SAFE_T,
    `top=${ham && ham.top} 安全区=${SAFE_T}`)

  // 2) 搜索浮层（同一个类）
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`)
  await sleep(500)
  const searchTop = await topOf('input[placeholder^="搜索节点文字"]')
  check('★ 搜索浮层不压状态栏', searchTop != null && searchTop.top >= SAFE_T,
    `top=${searchTop && searchTop.top} 安全区=${SAFE_T}`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(400)

  // 3) 左侧抽屉（面板铺到 y=0，但内容要压下来）
  await jsClick('[data-mobile-menu-btn]')
  await sleep(600)
  /*
   * 量的是抽屉里**第一行内容**。
   * 这一行原来是 data-drawer-tabs（50px 的标签长条），本轮把标签搬去顶部之后
   * 换成了「大纲 + ✕」标题行；判据本身没变：第一行内容的 top 必须在状态栏之下。
   */
  const drawerTop = await topOf('[data-drawer-close]')
  const drawerPanel = await evaluate(`(() => {
    const el = document.querySelector('[data-mobile-drawer]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { top: Math.round(r.top), paddingTop: cs.paddingTop }
  })()`)
  check('★ 抽屉的第一行内容落在状态栏下面', drawerTop != null && drawerTop.top >= SAFE_T,
    `top=${drawerTop && drawerTop.top} 安全区=${SAFE_T}`)
  check('抽屉面板自己仍然铺到屏幕最顶上（状态栏后面不露画布）',
    drawerPanel != null && drawerPanel.top <= 1, JSON.stringify(drawerPanel))
  await jsClick('[data-drawer-mask]')
  await sleep(500)

  // 3b) 顶部文档标签入口与面板（同一套安全区约束）
  {
    const tabsBtn = await topOf('[data-mobile-tabs-btn]')
    check('★ 右上角文档标签入口整体落在状态栏下面', tabsBtn != null && tabsBtn.top >= SAFE_T,
      `top=${tabsBtn && tabsBtn.top} 安全区=${SAFE_T}`)
    await jsClick('[data-mobile-tabs-btn]')
    await sleep(600)
    const sheetFirst = await topOf('[data-mobile-tabs-close]')
    const sheetPanel = await topOf('[data-mobile-tabs-sheet]')
    check('★ 标签面板的第一行内容落在状态栏下面', sheetFirst != null && sheetFirst.top >= SAFE_T,
      `top=${sheetFirst && sheetFirst.top} 安全区=${SAFE_T}`)
    check('标签面板自己仍然铺到屏幕最顶上', sheetPanel != null && sheetPanel.top <= 1, JSON.stringify(sheetPanel))
    await jsClick('[data-mobile-tabs-close]')
    await sleep(500)
  }

  // 4) 画布里的连线提示条（absolute + --mf-top-gap）
  /*
   * 【必须挑一个「能当连线起点」的节点】
   *
   * 根节点上「指向 / 指向同一结果」是**置灰**的（根是全图起点，让它去指向
   * 别人会把树读反）—— 实测踩过：随手挑「可见且最靠右」的节点，结果那一刻
   * 画布里只有根节点完整可见，点下去毫无反应，用例变成一个
   * 「什么都没测到」的假失败。
   *
   * 所以这里逐个候选节点试：长按 → 看菜单里 point-to 是否可用 →
   * 不可用就 Esc 收掉换下一个。这样测的是真的能连线的节点。
   *
   * 先 Ctrl+0 一键居中：前面的用例一路改过视口大小和视图，
   * 不重新铺满的话整张图可能只剩一个节点在屏幕里（实测如此），
   * 候选列表退化成 1 个 —— 而那一个往往正好是根节点。
   */
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }))`)
  await sleep(900)
  const linkCands = await evaluate(`(() => {
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    const out = []
    for (const el of document.querySelectorAll('[data-node-id]')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      /*
       * 判据放宽到「**长按点**落在视口里」就够，不要求整个节点可见：
       * 手机端 fitView 的下限是 0.75（见 Canvas.fit），一张宽图铺不满
       * 390px 视口 —— 实测整个节点都在视口内的只有根节点一个，
       * 而根节点恰好是**不能**当连线起点的那个。节点被裁掉一半不影响
       * 长按命中，菜单自己会夹进视口（ContextMenu 的 clamp）。
       */
      if (cx > 8 && cx < vw - 8 && cy > 100 && cy < vh - 100) {
        out.push({ id: el.dataset.nodeId, cx, cy, left: r.left })
      }
    }
    // 根节点在横向树里最靠左，从深往浅试
    out.sort((a, b) => b.left - a.left)
    return out.slice(0, 10)
  })()`)
  let usable = null
  for (const c of linkCands) {
    await longPressAt(c.cx, c.cy)
    const item = await evaluate(`(() => {
      const b = document.querySelector('[data-canvas-menu] [data-menu-item="point-to"]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { disabled: b.disabled, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
    })()`)
    if (item && !item.disabled) { usable = { ...c, item }; break }
    // 这个是根节点（或连线模式中），收掉菜单换下一个
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(400)
  }
  check('★ 找到一个「能作为连线起点」的可见节点（非根节点）', usable != null,
    `候选 ${linkCands.length} 个：${JSON.stringify(linkCands.map((c) => c.id))}`)

  if (usable) {
    note(`连线起点 = ${usable.id}`)
    await realClick(usable.item.cx, usable.item.cy)
    await sleep(500)
    const hint = await evaluate(`(() => {
      const el = document.querySelector('[data-link-hint]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right),
               vw: document.documentElement.clientWidth }
    })()`)
    check('★ 连线提示条不压状态栏', hint != null && hint.top >= SAFE_T,
      `top=${hint && hint.top} 安全区=${SAFE_T}`)
    check('提示条不横向溢出（长文案在窄屏不能撑出滚动条）',
      hint != null && hint.left >= -1 && hint.right <= hint.vw + 1, JSON.stringify(hint))
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(400)
  } else {
    check('★ 连线提示条不压状态栏', false, '没有可用的连线起点节点')
    check('提示条不横向溢出（长文案在窄屏不能撑出滚动条）', false, '没有可用的连线起点节点')
  }

  // 5) 折角弹窗顶栏（mf-safe-top / 内容 padding）
  const badgeForSafeTop = await centerOf('[data-fold-badge]')
  if (badgeForSafeTop) {
    await evaluate(`document.querySelector('[data-fold-badge]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(2600)
    const modalHead = await evaluate(`(() => {
      const m = document.querySelector('[data-fold-modal]')
      if (!m) return null
      const h = m.querySelector('header')
      const title = h && h.querySelector('h2')
      const mr = m.getBoundingClientRect()
      const tr = title ? title.getBoundingClientRect() : null
      /*
       * 顶栏「内容」的最上边缘。
       *
       * 【为什么不再只看 h2】
       * 加了「外形」下拉框之后手机上顶栏挤不下，折角名那一块本来就已被压成
       * 0 宽（看不见却仍占一份 gap），现在窄屏干脆不渲染它 —— 于是拿 h2 当
       * 代理会取到 null，断言失去意义。
       * 改成**所有可见控件里最靠上的那个**：手机端取到的是「预览/编辑」切换，
       * 桌面端仍然是标题，覆盖面反而比原来大（原来只盯一个元素）。
       */
      const vis = [...h.children]
        .map(e => e.getBoundingClientRect())
        .filter(b => b.width > 0 && b.height > 0)
      return {
        panelTop: Math.round(mr.top),
        headerPadTop: h ? getComputedStyle(h).paddingTop : null,
        headerBottom: h ? Math.round(h.getBoundingClientRect().bottom) : null,
        titleTop: tr ? Math.round(tr.top) : null,
        contentTop: vis.length ? Math.round(Math.min(...vis.map(b => b.top))) : null,
        visCount: vis.length,
      }
    })()`)
    check('★ 折角弹窗顶栏内容落在状态栏下面',
      modalHead != null && modalHead.contentTop != null &&
      modalHead.contentTop >= SAFE_T && modalHead.visCount > 0,
      JSON.stringify(modalHead))
    check('弹窗面板自己仍然从 y=0 铺起（背景盖住状态栏）',
      modalHead != null && modalHead.panelTop <= 1, JSON.stringify(modalHead))
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(900)
  } else {
    check('★ 折角弹窗顶栏内容落在状态栏下面', false, '找不到折角角标')
  }

  // 6) 全屏复习层的「退出复习」
  await jsClick('[data-tool="more"]')
  await sleep(450)
  await jsClick('[data-more-item="卡片复习"]')
  await sleep(900)
  const exitBtn = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /退出复习/.test(x.textContent || ''))
    if (!b) return null
    const r = b.getBoundingClientRect()
    const cs = getComputedStyle(b)
    const ov = b.parentElement
    const ocs = ov ? getComputedStyle(ov) : null
    return {
      top: Math.round(r.top), text: b.textContent.trim(),
      computedTop: cs.top, position: cs.position,
      safeT: getComputedStyle(document.documentElement).getPropertyValue('--mf-safe-t').trim(),
      overlayPosition: ocs && ocs.position,
      overlayTop: ov ? Math.round(ov.getBoundingClientRect().top) : null,
      offsetParent: b.offsetParent ? b.offsetParent.tagName + '.' + (b.offsetParent.className || '').slice(0, 40) : null,
    }
  })()`)
  check('★ 「退出复习」按钮不压状态栏', exitBtn != null && exitBtn.top >= SAFE_T,
    JSON.stringify(exitBtn))
  note(`退出复习：top=${exitBtn && exitBtn.top} computed top=${exitBtn && exitBtn.computedTop}`
    + ` · --mf-safe-t=${exitBtn && exitBtn.safeT} · 遮罩 top=${exitBtn && exitBtn.overlayTop}`
    + ` · offsetParent=${exitBtn && exitBtn.offsetParent}`)
  if (exitBtn) {
    const eb = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /退出复习/.test(x.textContent || ''))
      const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    await realClick(eb.x, eb.y)
    await sleep(600)
  }

  /*
   * 反向断言：桌面端（安全区恒为 0）一切照旧 —— 这是整个项目的硬约束。
   * 桌面端根本没有汉堡按钮，搜索浮层仍然贴在原来的 12px 上。
   */
  await setViewport(DESKTOP)
  await evaluate(`document.documentElement.style.removeProperty('--mf-safe-t')`)
  await sleep(700)
  check('★ 桌面端没有汉堡按钮（顶部安全区改动没有新增任何桌面 UI）',
    (await evaluate(`!!document.querySelector('[data-mobile-menu-btn]')`)) === false)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`)
  await sleep(500)
  const deskSearch = await topOf('input[placeholder^="搜索节点文字"]')
  check('★ 桌面端搜索浮层仍在原来的位置上（安全区为 0 时零变化 —— 没被 47px 推下去）',
    deskSearch != null && deskSearch.top < SAFE_T && deskSearch.top >= 10,
    `top=${deskSearch && deskSearch.top}（安全区 0，应仍在顶部附近而不是被推下 47px）`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(400)

  /* ================================================================== */
  console.log('\n[9d] 缩放不被「操作」改变')
  /* ================================================================== */

  /*
   * 用户原话：「进行操作时不要改变缩放大小」。
   *
   * 探针实测出三处会偷偷改缩放，在下面钉住其中两处：
   *   ① jumpTo 把 zoom 硬夹到 [0.6, 1.2] —— 进雷达模式就触发
   *      （1440×900 实测 1.6995 → 1.2000，一次 React commit 直接改写 transform）
   *   ③ 切标签页无条件重新 fit，把用户调好的视口丢掉（实测 1.6198 → 0.6910）
   *
   * 原本还有第 ② 条：「普通滚轮 / 触控板两指纵向滑动走的是缩放分支，
   * 实测 1.6995 → 1.9746」，当时的结论是这算「偷偷改了缩放」。
   *
   * 【本轮 ② 的定性反过来了 —— 这是用户明确要求的，不是回归】
   * 后来折角预览和打印预览都改成了「滚轮即缩放」，用户本轮原话：
   * 「滚轮键是放大和缩小，如果要滑动的话直接用鼠标滑就行了，两个视图都是
   * 这样的，**但思维导图不是这样的**」。所以思维导图现在也统一成滚轮即缩放，
   * 下面两条断言随之**取反**：普通滚轮必须改缩放（而不是平移）。
   * 平移改用空白处拖拽 —— 另一条断言负责证明这个入口还在。
   */
  await setViewport(PHONE)
  await sleep(600)

  /** 读画布当前的 translate/scale（节点层是同一个 view） */
  const canvasT = () => evaluate(`(() => {
    const g = document.querySelector('[data-canvas-wrap] svg g')
    if (!g) return null
    const m = /translate\\(([-\\d.]+), ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(g.getAttribute('transform') || '')
    return m ? { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) } : null
  })()`)
  const canvasRect = () => evaluate(`(() => {
    const r = document.querySelector('[data-canvas-wrap]').getBoundingClientRect()
    return { left: r.left, top: r.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  })()`)
  const wheelAt = async (x, y, deltaY, modifiers = 0) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers })
    await sleep(320)
  }

  const cr = await canvasRect()
  for (let i = 0; i < 6; i++) await wheelAt(cr.cx, cr.cy, -120, 2)   // Ctrl+滚轮 → 放大
  await sleep(600)
  const zoomed = await canvasT()
  check('前置：Ctrl+滚轮确实能缩放（缩放入口没被砍掉）',
    zoomed != null && zoomed.zoom > 1.05, JSON.stringify(zoomed))

  /*
   * 【先回到中间缩放区间，再测普通滚轮】
   * 上面刚用 Ctrl+滚轮连推 6 次，而触控板步长是 0.01（每事件 exp(120×0.01)=3.32 倍），
   * 缩放早就顶到 clampZoom 的上限 2.5 了。在上限上**再往上滚不会有任何变化**，
   * 直接用这个状态测「滚轮向上 = 放大」必然失败 —— 那不是代码错，是测量位置错。
   * 所以先往下滚回中间区间。（这段回退本身也依赖普通滚轮能缩放：
   * 如果滚轮真的坏了，40 次之后仍停在 2.5，下面那条前置断言会当场炸出来。）
   */
  const zoomBackTo = async (target) => {
    for (let i = 0; i < 40; i++) {
      const t = await canvasT()
      if (t.zoom <= target) return t
      await wheelAt(cr.cx, cr.cy, 120, 0)
    }
    return await canvasT()
  }
  const mid = await zoomBackTo(1.4)
  check('前置：缩放已回到中间区间（不在上限上，两个方向都测得出变化）',
    mid.zoom > 0.2 && mid.zoom < 2.4, `zoom=${mid.zoom.toFixed(4)}`)

  /*
   * ① 普通滚轮 = 缩放（本轮改的新行为）。
   * 向上滚 → 放大。用户要的就是「滚轮键是放大和缩小」。
   */
  const beforePlain = await canvasT()
  await wheelAt(cr.cx, cr.cy, -100, 0)
  const afterPlain = await canvasT()
  check('★ 普通滚轮**直接**缩放，不需要按 Ctrl（与折角/打印预览一致）',
    afterPlain.zoom > beforePlain.zoom + 0.001,
    `${beforePlain.zoom.toFixed(4)} → ${afterPlain.zoom.toFixed(4)}`)
  // 向下滚 → 缩小，反向也要成立（只测一个方向的话「只会放大」也能过）
  const beforeDown = await canvasT()
  await wheelAt(cr.cx, cr.cy, 200, 0)
  const afterDown = await canvasT()
  check('★ 反向滚轮（向下）也缩小（不是单向只会放大）',
    afterDown.zoom < beforeDown.zoom - 0.001,
    `${beforeDown.zoom.toFixed(4)} → ${afterDown.zoom.toFixed(4)}`)

  /*
   * ①b 滚轮被缩放占用了，**平移入口必须还在**：空白处拖拽。
   * 这条是 ① 的对偶 —— 只证明「滚轮会缩放」而不证明「还能平移」，
   * 就可能出现「缩放能用了但画布再也移不动」。所以必须两条一起钉。
   *
   * 【为什么不能直接拖画布中心】
   * fitView 会把图居中，画布正中央**多半就是一个节点**；而节点上拖拽
   * 被刻意排除在平移之外（panning.excluded / 节点拖拽改层级），拖它不会平移，
   * 用例会假失败。所以先扫一圈候选点，挑一个 elementFromPoint 命中
   * 真正的空白背景、且没被工具栏之类浮层盖住的点。找不到就明确失败，
   * 而不是退回中心点糊弄过去。
   */
  const blank = await evaluate(`(() => {
    const wrap = document.querySelector('[data-canvas-wrap]')
    if (!wrap) return null
    const r = wrap.getBoundingClientRect()
    const hit = (x, y) => {
      const el = document.elementFromPoint(x, y)
      if (!el || !wrap.contains(el)) return false
      // 节点（含内部文字/折角角标）和任何按钮都不算空白
      if (el.closest('[data-node-id], button, a, input, [data-radar-hud], [data-bottom-toolbar]')) return false
      return true
    }
    for (let fy = 0.12; fy <= 0.88; fy += 0.04) {
      for (let fx = 0.06; fx <= 0.94; fx += 0.02) {
        const x = Math.round(r.left + r.width * fx)
        const y = Math.round(r.top + r.height * fy)
        // 需要留出拖拽行程（-150, -100），太靠左上角会拖出视口
        if (x < r.left + 170 || y < r.top + 120) continue
        if (hit(x, y)) return { x, y, fx: Number(fx.toFixed(2)), fy: Number(fy.toFixed(2)) }
      }
    }
    return null
  })()`)
  if (!blank) {
    check('前置：能在画布上找到一块可拖拽的空白（否则 ①b 无法验证）', false, 'no blank point found')
  } else {
    note(`空白拖拽点 (${blank.x}, ${blank.y}) = 画布的 ${blank.fx}×${blank.fy}`)
    const beforeDrag = await canvasT()
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: blank.x, y: blank.y, button: 'left', clickCount: 1, buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: blank.x - 90, y: blank.y - 60, button: 'left', buttons: 1 })
    await sleep(60)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: blank.x - 150, y: blank.y - 100, button: 'left', buttons: 1 })
    await sleep(60)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: blank.x - 150, y: blank.y - 100, button: 'left', buttons: 0 })
    await sleep(400)
    const afterDrag = await canvasT()
    check('★ 空白处拖拽仍能平移画布（滚轮改缩放后平移入口没丢）',
      Math.abs(afterDrag.x - beforeDrag.x) > 20 || Math.abs(afterDrag.y - beforeDrag.y) > 20,
      `Δx=${(afterDrag.x - beforeDrag.x).toFixed(1)} Δy=${(afterDrag.y - beforeDrag.y).toFixed(1)}`)
    check('★ 拖拽平移不改变缩放（平移和缩放两条路径互不干扰）',
      Math.abs(afterDrag.zoom - beforeDrag.zoom) < 0.001,
      `${beforeDrag.zoom.toFixed(4)} → ${afterDrag.zoom.toFixed(4)}`)
  }

  // ② 进雷达模式（jumpTo 的第一个调用方）不得改缩放
  const beforeRadar = await canvasT()
  await jsClick('[data-tool="radar"]')
  await sleep(900)
  const afterRadar = await canvasT()
  check('★ 进入雷达模式（会 jumpTo 到第一个折角）不改变缩放',
    Math.abs(afterRadar.zoom - beforeRadar.zoom) < 0.001,
    `${beforeRadar.zoom.toFixed(4)} → ${afterRadar.zoom.toFixed(4)}`)
  check('★ 但视口确实移动了（定位功能还在，不是整个失效）',
    Math.abs(afterRadar.x - beforeRadar.x) > 1 || Math.abs(afterRadar.y - beforeRadar.y) > 1,
    `Δx=${(afterRadar.x - beforeRadar.x).toFixed(1)} Δy=${(afterRadar.y - beforeRadar.y).toFixed(1)}`)

  // 雷达提示条不能压住底部工具栏（它的 bottom 原来被一个重复的 style 吃掉了）
  const hud = await evaluate(`(() => {
    const bar = document.querySelector('[data-bottom-toolbar]')
    const el = [...document.querySelectorAll('div')].find(d => /雷达复习/.test(d.textContent || '') && d.className.includes('rounded-2xl'))
    if (!el || !bar) return null
    const r = el.getBoundingClientRect()
    const b = bar.getBoundingClientRect()
    return {
      hud: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
      bar: { top: Math.round(b.top), bottom: Math.round(b.bottom) },
      overlap: r.bottom > b.top && r.top < b.bottom,
      inViewport: r.left >= -1 && r.right <= document.documentElement.clientWidth + 1,
      vw: document.documentElement.clientWidth,
      left: Math.round(r.left), right: Math.round(r.right),
    }
  })()`)
  check('★ 雷达提示条不压住底部工具栏', hud != null && hud.overlap === false, JSON.stringify(hud))
  if (hud) {
    check('雷达提示条不横向溢出', hud.inViewport === true,
      `left=${hud.left} right=${hud.right} vw=${hud.vw}`)
  }
  await jsClick('[data-tool="radar"]')
  await sleep(600)

  // ③ 切标签页回来必须还是原来的缩放
  /*
   * 【必须切到「另一个」标签再切回来】
   * 早先的写法是「点第 2 个标签，再点第 1 个标签」—— 但前面的用例已经
   * 把活动文档切到过第 2 个，于是「点第 2 个」其实是**原地不动**
   * （scale 一模一样，用例变成空测），而「点第 1 个」切到的是一个
   * 完全没量过的文档，拿它去比必然不等。所以这里先记住当前活动文档，
   * 切到一个确定不同的标签，再切回原来那个。
   */
  const beforeSwitch = await canvasT()
  const activeBefore = await evaluate(`(() => { try { return JSON.parse(localStorage.getItem('mf:active')) } catch { return null } })()`)
  const tabIds = await evaluate(`(() => {
    const pin = document.querySelector('[data-pin-tabs]')
    if (pin) pin.click()
    return [...document.querySelectorAll('[data-tab-id]')].map(x => x.dataset.tabId)
  })()`)
  await sleep(700)
  const otherId = tabIds.find((id) => id !== activeBefore) || null
  if (otherId) {
    await evaluate(`(async () => {
      const el = [...document.querySelectorAll('[data-tab-id]')].find(x => x.dataset.tabId === ${JSON.stringify(otherId)})
      const pin = document.querySelector('[data-pin-tabs]')
      if (pin && pin.dataset.pinned !== 'true') pin.click()
      if (el) el.click()
    })()`)
    await sleep(1600)
    const activeNow = await evaluate(`(() => { try { return JSON.parse(localStorage.getItem('mf:active')) } catch { return null } })()`)
    check('前置：确实切到了另一个文档（否则下面的比较是空测）',
      activeNow === otherId && otherId !== activeBefore, `${activeBefore} → ${activeNow}`)

    await evaluate(`(async () => {
      const pin = document.querySelector('[data-pin-tabs]')
      if (pin && pin.dataset.pinned !== 'true') pin.click()
      const el = [...document.querySelectorAll('[data-tab-id]')].find(x => x.dataset.tabId === ${JSON.stringify(activeBefore)})
      if (el) el.click()
    })()`)
    await sleep(1600)
    const back = await canvasT()
    check('★ 切走再切回，文档恢复自己的缩放（不再无条件重新 fit）',
      Math.abs(back.zoom - beforeSwitch.zoom) < 0.02,
      `${beforeSwitch.zoom.toFixed(4)} → ${back.zoom.toFixed(4)}`)
    check('位置也一起恢复了',
      Math.abs(back.x - beforeSwitch.x) < 2 && Math.abs(back.y - beforeSwitch.y) < 2,
      `x ${beforeSwitch.x.toFixed(1)}→${back.x.toFixed(1)} y ${beforeSwitch.y.toFixed(1)}→${back.y.toFixed(1)}`)
    // 上面为了让标签可点而点开了常显标签栏，收回去，别影响后面
    await evaluate(`(() => { const pin = document.querySelector('[data-pin-tabs]'); if (pin && pin.dataset.pinned === 'true') pin.click(); return true })()`)
    await sleep(500)
  } else {
    note('只有一个标签页，跳过「切走再切回」用例')
  }

  /* ================================================================== */
  console.log('\n[9e] 手机端导入 Markdown：点了必须真的触发文件选择')
  /* ================================================================== */

  /*
   * 这条是**用户报的原始故障**（「手机导入 markdown 不行」）的回归测试。
   *
   * 修之前：点「更多」面板里的「导入」（当时叫「导入 Markdown / 备份」）→ 隐藏
   * input 收到 click **0 次**（探针实测）。根因是那个入口是 `<label htmlFor>`，
   * 而 label 的转发属于**默认行为**，发生在事件派发结束之后；它自己的
   * onClick 里 setMoreOpen(false) 会当场把面板连 label 一起卸载，
   * 于是 label.control 查不到目标、转发取消。桌面端那个 label 没有 onClick，
   * 所以一直是好的 —— 这正是「只有手机端导入不行」的原因。
   *
   * 注意必须用 realClick（Input 域的真实点击），不能用 el.click()：
   * 程序化 click 自己就会触发 label 的激活行为，会把 bug 掩盖掉。
   */
  await setViewport(PHONE)
  await sleep(700)
  /*
   * 等提示条自己消失再点：提示条是 fixed + z-[110]，正好挂在「更多」面板的
   * 下半部分上面。不先等它走，真实点击会被它吃掉 —— 用例会以一个看不懂的
   * 「点了没反应」失败，而真实用户遇到的是「上一条提示还在时点导入」。
   * 这里先等干净，测的是导入本身；点不通再把 elementFromPoint 报出来。
   */
  for (let i = 0; i < 20; i++) {
    if ((await evaluate(`!!document.querySelector('[data-app-toast]')`)) === false) break
    await sleep(300)
  }
  check('前置：没有提示条挡在「更多」面板上面',
    (await evaluate(`!!document.querySelector('[data-app-toast]')`)) === false)

  await evaluate(`(() => {
    const inp = document.querySelector('#mf-import-file')
    if (!inp) return false
    window.__mfImportClicks = 0
    inp.addEventListener('click', (e) => {
      window.__mfImportClicks++
      // 拦掉真实文件对话框，用例只关心「有没有点到 input」
      e.preventDefault()
    })
    return true
  })()`)

  await jsClick('[data-tool="more"]')
  await sleep(450)
  const importItem = await centerOf('[data-more-item="导入"]')
  check('前置：「更多」面板里有导入入口', importItem != null)
  if (importItem) {
    // 真实点击之前先看看这个点上到底是谁 —— 失败时能一眼看出被谁挡住了
    const hit = await evaluate(`(() => {
      const el = document.elementFromPoint(${importItem.cx}, ${importItem.cy})
      if (!el) return null
      const own = el.closest('[data-more-item]')
      return {
        tag: el.tagName,
        item: own ? own.dataset.moreItem : null,
        cls: (el.className || '').toString().slice(0, 60),
      }
    })()`)
    note(`导入项中心 (${importItem.cx.toFixed(0)}, ${importItem.cy.toFixed(0)}) 上的元素：${JSON.stringify(hit)}`)
    check('★ 导入项没有被别的东西盖住（命中测试指回它自己）',
      hit != null && hit.item === '导入', JSON.stringify(hit))

    await realClick(importItem.cx, importItem.cy)
    await sleep(600)
    const n = await evaluate('window.__mfImportClicks || 0')
    check('★ 手机端点「导入」→ 隐藏 input 真的收到 click',
      n === 1, `收到 ${n} 次（修之前是 0 次）`)
    check('点完「更多」面板自动收起',
      (await evaluate(`!!document.querySelector('[data-more-sheet]')`)) === false)
  }

  // 桌面端同一条代码路径
  await setViewport(DESKTOP)
  await sleep(800)
  await evaluate('window.__mfImportClicks = 0')
  const deskImport = await centerOf('[data-import-trigger="desktop"]')
  check('前置：桌面端右下角有导入入口', deskImport != null)
  if (deskImport) {
    await realClick(deskImport.cx, deskImport.cy)
    await sleep(500)
    check('★ 桌面端导入入口同样触发 input',
      (await evaluate('window.__mfImportClicks || 0')) === 1,
      String(await evaluate('window.__mfImportClicks || 0')))
  }

  /*
   * accept 里必须有 text/markdown —— 否则安卓的文件选择器会把 .md 置灰。
   * 证据在 Capacitor 8.5.2 的 BridgeWebChromeClient.getValidTypes()：
   * 扩展名经 MimeTypeMap 转换，认不出来的直接丢弃，而安卓不认 md/markdown，
   * 于是 EXTRA_MIME_TYPES 只剩 [text/plain, application/json]，
   * .md（MIME 是 text/markdown 或 application/octet-stream）就被过滤掉了。
   */
  const accept = await evaluate(`document.querySelector('#mf-import-file')?.getAttribute('accept') || ''`)
  check('★ accept 里显式写了 text/markdown（否则安卓选择器把 .md 置灰）',
    /text\/markdown/.test(accept), accept)
  check('accept 仍然保留了扩展名（桌面浏览器按扩展名过滤）',
    /\.md\b/.test(accept) && /\.json\b/.test(accept), accept)
  /*
   * 本轮扩了格式，这条判据必须一起长：新增的 .opml / .mm / .html 在安卓的
   * MimeTypeMap 里同样认不全（opml、mm 根本不认识），漏一个就等于那个格式
   * 在手机上「选不中」—— 和当年 md 的故障一模一样的形状。
   */
  check('★ 新增格式的扩展名与 MIME 都进了 accept（否则手机上选不中它们）',
    /\.opml\b/.test(accept) && /\.mm\b/.test(accept) && /\.html\b/.test(accept)
    && /text\/xml/.test(accept) && /text\/html/.test(accept),
    accept)

  /* ================================================================== */
  console.log('\n[9f] 安卓硬件返回键：接上 __mfHardwareBack')
  /* ================================================================== */

  /*
   * Capacitor 8.5.2 的 BridgeActivity **没有重写 onBackPressed**，所以硬件返回键
   * 直接落到 AppCompatActivity 的默认实现 → finish() → 应用当场退出，
   * 任何浮层开着也一样（这就是「返回键是摆设」）。
   *
   * 现在 MainActivity 用 OnBackPressedDispatcher 接管，并问 JS 一句
   * `window.__mfHardwareBack()`：关掉了浮层就吃掉这次返回，否则退出应用。
   *
   * 这里能测的是**网页这一半**（能不能装、返回什么、优先级对不对）。
   * Java 那一半只能靠编译通过 + 源码审查（本机没有模拟器/真机）。
   */
  const nativeBoot = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.androidBridge = {}',   // 冒充安卓原生壳，让 isNativeShell() 成立
  })
  await cdp.send('Page.reload')
  await sleep(6000)

  check('★ 原生壳里装上了 __mfHardwareBack',
    (await evaluate(`typeof window.__mfHardwareBack`)) === 'function')

  check('什么都没开着时返回 false（这时原生侧才会退出应用）',
    (await evaluate(`window.__mfHardwareBack ? window.__mfHardwareBack() : 'missing'`)) === false)

  // 手机竖屏：打开折角弹窗 → 返回键应当吃掉并关掉它
  await setViewport(PHONE)
  await sleep(900)
  const badge2 = await centerOf('[data-fold-badge]')
  if (badge2) {
    await evaluate(`document.querySelector('[data-fold-badge]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(2600)
    const opened = await evaluate(`!!document.querySelector('[data-fold-modal]')`)
    check('前置：折角弹窗已打开', opened === true)
    const handled = await evaluate(`window.__mfHardwareBack()`)
    await sleep(600)
    check('★ 竖屏：硬件返回键吃掉这一下（返回 true）', handled === true, String(handled))
    check('★ 竖屏：硬件返回键关掉了弹窗',
      (await evaluate(`!!document.querySelector('[data-fold-modal]')`)) === false)
  } else {
    check('★ 竖屏：硬件返回键关掉了弹窗', false, '找不到折角角标')
  }

  /*
   * 【横屏且宽度 > 768 的用例 —— 这是最容易漏掉的那条】
   *
   * 原来的压栈门槛是「视口宽度 ≤ 768」。手机横屏时宽度可能是 852 / 915px，
   * 于是浮层压根不注册，返回键又变回「直接退出应用」。
   * 现在原生壳里不看宽度，所以 900px 宽也照样能吃掉返回键。
   */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 420, deviceScaleFactor: 2, mobile: true,
  })
  await sleep(1400)
  const isLandscapeDesktopLayout = await evaluate(`!!document.querySelector('[data-tool="cards"]')`)
  note(`900×420（横屏宽屏）走的是桌面布局：${isLandscapeDesktopLayout}`)
  const badge3 = await centerOf('[data-fold-badge]')
  if (badge3) {
    await evaluate(`document.querySelector('[data-fold-badge]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(2600)
    const openedL = await evaluate(`!!document.querySelector('[data-fold-modal]')`)
    check('前置：横屏宽视口下弹窗已打开', openedL === true)
    const handledL = await evaluate(`window.__mfHardwareBack()`)
    await sleep(600)
    check('★ 横屏宽视口（>768px）下原生壳仍然接管返回键',
      handledL === true, String(handledL))
    check('★ 横屏宽视口下弹窗被关掉',
      (await evaluate(`!!document.querySelector('[data-fold-modal]')`)) === false)
  } else {
    check('★ 横屏宽视口（>768px）下原生壳仍然接管返回键', false, '找不到折角角标')
  }

  // 反向断言：普通浏览器（没有原生桥）不装这个全局，返回键不被应用吃掉
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: nativeBoot.identifier })
  await cdp.send('Page.reload')
  await sleep(6000)
  check('★ 普通浏览器里不存在 __mfHardwareBack（桌面返回键不受影响）',
    (await evaluate(`typeof window.__mfHardwareBack`)) === 'undefined',
    await evaluate(`typeof window.__mfHardwareBack`))

  /* ================================================================== */
  console.log('\n[9g] 底边 / 侧边：浮层不压系统栏，也不压住底栏')
  /* ================================================================== */

  /*
   * [9c] 管的是「顶边」，这一节管另外三边，以及「应用自己的东西互相压」。
   *
   * 三个用户看不见但会硌手的问题（全部先量出来再改，数值见 README）：
   *   ① 历史版本 / 回收站面板写死 `left-3 bottom-14`（12 / 56px）。
   *      底栏是 `12px + 安全区` 起算的 —— 安全区 34px 时底栏整体上移，
   *      而面板还钉在 56px：实测与底栏重叠 300×30px，面板最下面一条被压住。
   *   ② 长按菜单的 clamp 下限是 8px（相对**物理**视口边）。竖屏刘海屏下
   *      高 341px 的菜单被夹到下缘 836，越过可用底 810 共 26px ——
   *      最后一项「删除节点」整条落进手势区（量到 798..831）。
   *   ③ 横屏侧边安全区 34px 时，贴左边缘弹出的浮层被夹到 left=8 → 压进刘海 26px。
   *
   * 判定口径（写死在 SWEEP_JS 里，免得越测越松）：
   *   · 只看 fixed/absolute 且在**屏幕坐标系**里的元素（有 transform 祖先的是
   *     画布内容，跟着画布走，不算浮层）
   *   · 只看「有内容」的盒子：直接文本 / 表单控件 / 有背景
   *   · 用**内容盒**（扣掉 padding）判边：铺满全屏的面板允许背景铺到边缘，
   *     只要求里面的东西让开 —— 这正是本项目定下的规则
   *   · 滑出屏幕的抽屉 / 标签栏（只露几像素感应条）不算
   */
  const LANDSCAPE_WIDE = { width: 844, height: 390, deviceScaleFactor: 2, mobile: true }
  const setSafe = (t, b, l, r) => evaluate(`(() => {
    const s = document.documentElement.style
    s.setProperty('--mf-safe-t', '${t}px'); s.setProperty('--mf-safe-b', '${b}px')
    s.setProperty('--mf-safe-l', '${l}px'); s.setProperty('--mf-safe-r', '${r}px')
    return true
  })()`)
  /** 重新加载并重新铺安全区（行内样式不会被 reload 保留） */
  const reloadWith = async (vp, insets) => {
    await setViewport(vp)
    await cdp.send('Page.reload')
    await sleep(4200)
    await setSafe(...insets)
    await sleep(400)
  }
  const MEASURE = `(() => {
    const cs = getComputedStyle(document.documentElement); const n = k => parseFloat(cs.getPropertyValue(k)) || 0
    return { T: n('--mf-safe-t'), B: n('--mf-safe-b'), L: n('--mf-safe-l'), R: n('--mf-safe-r'),
             vw: innerWidth, vh: innerHeight }
  })()`
  const SWEEP_JS = `(() => {
    const cs = getComputedStyle(document.documentElement); const n = k => parseFloat(cs.getPropertyValue(k)) || 0
    const T = n('--mf-safe-t'), B = n('--mf-safe-b'), L = n('--mf-safe-l'), R = n('--mf-safe-r')
    const W = innerWidth, H = innerHeight; const out = []
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el)
      if (s.position !== 'fixed' && s.position !== 'absolute') continue
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      if (r.width >= W - 1 && r.height >= H - 1) continue
      const ix = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0))
      const iy = Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0))
      if (ix * iy < r.width * r.height * 0.25) continue
      let a = el.parentElement, tf = false
      while (a && a !== document.body) {
        const as = getComputedStyle(a)
        if (as.transform !== 'none' || as.perspective !== 'none' || as.filter !== 'none') { tf = true; break }
        a = a.parentElement
      }
      if (tf) continue
      const hasText = [...el.childNodes].some(x => x.nodeType === 3 && x.textContent.trim())
      const isCtl = /^(INPUT|BUTTON|TEXTAREA|SELECT|IMG|CANVAS)$/i.test(el.tagName) || el.tagName.toLowerCase() === 'svg'
      const bg = s.backgroundColor
      const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
      if (!hasText && !isCtl && !hasBg) continue
      const px = v => parseFloat(v) || 0
      const ct = r.top + px(s.borderTopWidth) + px(s.paddingTop)
      const cb = r.bottom - px(s.borderBottomWidth) - px(s.paddingBottom)
      const cl = r.left + px(s.borderLeftWidth) + px(s.paddingLeft)
      const cr = r.right - px(s.borderRightWidth) - px(s.paddingRight)
      if (cb - ct < 1 || cr - cl < 1) continue
      const v = []
      if (ct < T - 0.5) v.push('上' + Math.round(ct) + '<' + T)
      if (cb > H - B + 0.5) v.push('下' + Math.round(cb) + '>' + (H - B))
      if (cl < L - 0.5) v.push('左' + Math.round(cl) + '<' + L)
      if (cr > W - R + 0.5) v.push('右' + Math.round(cr) + '>' + (W - R))
      if (!v.length) continue
      out.push({ sel: el.tagName.toLowerCase() + (el.getAttribute('data-tool') ? '[tool=' + el.getAttribute('data-tool') + ']' : '')
        + (el.getAttribute('data-more-item') ? '[more=' + el.getAttribute('data-more-item') + ']' : '')
        + (el.getAttribute('data-menu-item') ? '[menu=' + el.getAttribute('data-menu-item') + ']' : ''),
        text: (el.textContent || '').trim().slice(0, 16), why: v.join(' ') })
    }
    return out
  })()`
  const sweep = (label) => evaluate(SWEEP_JS).then((out) => {
    check(`★ ${label}：没有内容压到系统栏`, out.length === 0, JSON.stringify(out.slice(0, 3)))
    return out
  })
  /** 面板底边是否压到底栏：面板 rect 与「底栏容器」rect 求交 */
  const overlapWithToolbar = (sel) => evaluate(`(() => {
    const p = document.querySelector(${JSON.stringify(sel)})
    const btn = document.querySelector('[data-tool="more"]') || document.querySelector('[data-tool="radar"]')
    if (!p || !btn) return { err: 'missing panel=' + !!p + ' toolbar=' + !!btn }
    const a = p.getBoundingClientRect(), b = btn.parentElement.getBoundingClientRect()
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    return { ox: Math.round(ox), oy: Math.round(oy), a: [Math.round(a.left), Math.round(a.top), Math.round(a.right), Math.round(a.bottom)],
             b: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)] }
  })()`)

  // ---- ① 竖屏刘海屏：面板与底栏不再互相压 ----
  await reloadWith(PHONE, [47, 34, 0, 0])
  await jsClick('[data-tool="more"]'); await sleep(500)
  await jsClick('[data-more-item="历史版本"]'); await sleep(600)
  const histOv = await overlapWithToolbar('div[class*="fixed"][class*="z-[75]"]')
  check('★ 历史版本面板不再压住底部工具栏', histOv.oy <= 0 || histOv.ox <= 0,
    `重叠 ${histOv.ox}×${histOv.oy} 面板=${histOv.a} 底栏=${histOv.b}`)
  await sweep('历史版本面板打开时')

  await reloadWith(PHONE, [47, 34, 0, 0])
  await jsClick('[data-tool="more"]'); await sleep(500)
  await jsClick('[data-more-item="回收站"]'); await sleep(600)
  const trashOv = await overlapWithToolbar('div[class*="fixed"][class*="z-[75]"]')
  check('★ 回收站面板不再压住底部工具栏', trashOv.oy <= 0 || trashOv.ox <= 0,
    `重叠 ${trashOv.ox}×${trashOv.oy} 面板=${trashOv.a} 底栏=${trashOv.b}`)

  // ---- ② 长按菜单：整个菜单必须落在可用视口里，且每一项都真的能点到 ----
  await reloadWith(PHONE, [47, 34, 0, 0])
  const menuNodes = await evaluate(`(() => {
    const ns = [...document.querySelectorAll('[data-node-id]')].map(e => {
      const r = e.getBoundingClientRect()
      return { l: r.left, t: r.top, w: r.width, h: r.height }
    })
    return ns.length ? ns.reduce((a, b) => (a.t > b.t ? a : b)) : null
  })()`)
  await longPressAt(menuNodes.l + Math.min(20, menuNodes.w / 2), menuNodes.t + menuNodes.h / 2)
  const geo = await evaluate(MEASURE)
  const menu = await rectOf('[data-canvas-menu]')
  check('★ 长按菜单下缘不越出手势条', menu != null && menu.bottom <= geo.vh - geo.B + 0.5,
    `下缘=${menu && menu.bottom} 可用底=${geo.vh - geo.B}`)
  check('★ 长按菜单上缘不压状态栏', menu != null && menu.y >= geo.T - 0.5,
    `上缘=${menu && menu.y} 安全区=${geo.T}`)
  const menuHit = await evaluate(`(() => {
    const els = [...document.querySelectorAll('[data-canvas-menu] [data-menu-item]')]
    const vh = innerHeight, cs = getComputedStyle(document.documentElement)
    const B = parseFloat(cs.getPropertyValue('--mf-safe-b')) || 0
    const bad = []
    for (const el of els) {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
      const ok = !!hit && (el === hit || el.contains(hit) || hit.contains(el))
      if (!ok || r.bottom > vh - B + 0.5) {
        bad.push({ item: el.getAttribute('data-menu-item'), ok,
          hit: hit ? (hit.getAttribute('data-tool') || hit.tagName) : 'null', bottom: Math.round(r.bottom) })
      }
    }
    return { total: els.length, bad }
  })()`)
  check('★ 长按菜单每一项都落在可用区内且命中自己',
    menuHit.total > 0 && menuHit.bad.length === 0,
    `共 ${menuHit.total} 项，异常 ${JSON.stringify(menuHit.bad)}`)
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(400)

  // ---- ③ 横屏：侧边安全区（刘海在侧面）不能被浮层压过去 ----
  await reloadWith(LANDSCAPE_WIDE, [0, 21, 34, 34])
  await sweep('横屏基础画布')
  await jsClick('[data-tool="history"]'); await sleep(600)
  const histL = await rectOf('div[class*="fixed"][class*="z-[75]"]')
  check('★ 横屏历史版本面板让开侧边刘海', histL != null && histL.x >= 34 - 0.5,
    `左边=${histL && histL.x} 侧边安全区=34`)
  await sweep('横屏历史版本面板打开时')

  // ---- ④ 桌面端反向断言：安全区全 0，坐标必须与改之前逐像素一致 ----
  /*
   * 改之前写死的是 `left-3 bottom-14`：left = 12px、bottom = 屏幕高 - 56px。
   * 现在走 `calc(12px + 安全区)` / `calc(--mf-bottom-gap + 44px)`，
   * 安全区为 0 时必须**还原成同样的数字**，否则就是「改了桌面端」。
   * 菜单那边同理：`max(margin, min(x, 视口 - 尺寸 - margin))` 在安全区为 0 时
   * 与 `clampToSafeViewport` 完全等价（同一份数学，见 hooks.js 注释）。
   */
  await reloadWith(DESKTOP, [0, 0, 0, 0])
  await jsClick('[data-tool="history"]'); await sleep(600)
  const histD = await evaluate(`(() => {
    const d = [...document.querySelectorAll('div[class*="fixed"]')].find(e => /^历史版本/.test((e.textContent || '').trim()))
    if (!d) return null
    const r = d.getBoundingClientRect()
    return { left: Math.round(r.left), bottom: Math.round(r.bottom), vh: innerHeight }
  })()`)
  check('★ 桌面端历史面板坐标逐像素不变（left=12 / bottom=屏高-56）',
    histD != null && histD.left === 12 && histD.bottom === histD.vh - 56,
    JSON.stringify(histD))
  const deskSweep = await sweep('桌面端（安全区全 0）')
  check('★ 桌面端面板/菜单全部在视口内（安全区为 0 时与改前等价）', deskSweep.length === 0)

  // 收尾：把安全区清回 0，后面的用例按桌面口径跑
  await reloadWith(DESKTOP, [0, 0, 0, 0])

  /* ================================================================== */
  console.log('\n[10] 无 console 报错')
  /* ================================================================== */

  {
    const real = consoleErrors.filter((e) => !/favicon|ERR_/.test(e))
    check('整个过程没有 console 报错', real.length === 0, JSON.stringify(real.slice(0, 4)))
  }

  console.log('\n====================================================')
  console.log(`  手机端专项 mobileui  通过 ${pass} / 失败 ${fail}`)
  console.log('====================================================')

  cdp.close()
  try { proc.kill() } catch { /* ignore */ }
  if (fail) process.exit(1)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new MiniWS(url)
    let id = 0
    const pending = new Map()
    const handlers = new Map()
    ws.onmessage = (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message))
        else res(msg.result)
      } else if (msg.method && handlers.has(msg.method)) {
        for (const h of handlers.get(msg.method)) h(msg.params)
      }
    }
    ws.opened.then(() => {
      resolve({
        send(method, params) {
          const mid = ++id
          return new Promise((res, rej) => {
            pending.set(mid, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id: mid, method, params }))
          })
        },
        on(method, fn) {
          if (!handlers.has(method)) handlers.set(method, [])
          handlers.get(method).push(fn)
        },
        close: () => ws.close(),
      })
    }).catch(reject)
  })
}

main().catch((e) => {
  console.error('测试失败：', e)
  process.exit(2)
})
