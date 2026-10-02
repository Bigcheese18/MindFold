/**
 * 手机端可用性探测
 * ================
 * 用 Edge headless + CDP 模拟真实手机（触摸 + devicePixelRatio + 窄视口），
 * 检查 MindFold 在手机上的**实际可用性**，而不是「端口能不能通」。
 *
 * 重点验证：
 *   1. 首屏是否横向溢出（窄屏最容易炸的地方）
 *   2. 长按/拖拽是否会触发浏览器原生的滚动、放大、选中文字
 *   3. 触控热区是否够大（折角角标 24px、折叠三角、分割线）
 *   4. 全屏弹窗在窄屏下是否自动堆叠成一列
 *   5. 有没有 hover-only 的交互（手机上永远触发不了）
 *
 * 用法：node scripts/mobile.mjs [url]
 *   默认指向 dev server：http://127.0.0.1:5173
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

const PORT = 9334
const userDir = mkdtempSync(join(tmpdir(), 'mf-mobile-'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (msg) => console.log(`  · ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 常见机型的 CSS 视口尺寸
const DEVICES = [
  { name: 'iPhone SE', w: 375, h: 667, dpr: 2 },
  { name: 'iPhone 14 Pro', w: 393, h: 852, dpr: 3 },
  { name: 'Pixel 7', w: 412, h: 915, dpr: 2.6 },
]

async function main() {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
    '--window-size=400,900', 'about:blank',
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

  const consoleErrors = []
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push((p.args || []).map((a) => a.value ?? a.description).join(' '))
  })
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown')
  })

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }

  for (const dev of DEVICES) {
    console.log(`\n${'='.repeat(52)}`)
    console.log(`  ${dev.name}  ${dev.w}x${dev.h} @${dev.dpr}x`)
    console.log('='.repeat(52))

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: dev.w, height: dev.h, deviceScaleFactor: dev.dpr, mobile: true,
      screenWidth: dev.w, screenHeight: dev.h,
    })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

    // 每次都用干净的存储，避免上一个机型留下的弹窗/滚动状态串味
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await sleep(200)
    await cdp.send('Page.navigate', { url: URL_APP })
    await sleep(4500)

    const mounted = await evaluate(`!!document.querySelector('[data-node-id]')`)
    if (!mounted) { check(`${dev.name}: 页面挂载`, false, '没有渲染出节点'); continue }

    /* ---- 1. 横向溢出 ---- */
    const overflow = await evaluate(`(() => {
      const de = document.documentElement
      return {
        scrollW: de.scrollWidth,
        clientW: de.clientWidth,
        bodyScrollW: document.body.scrollWidth,
        // 找出真正超出视口右边界的元素（排除画布内部本来就该超出的）
        culprits: [...document.querySelectorAll('body *')]
          .filter(el => {
            const r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) return false
            // 画布内的节点本来就可以超出视口（那是可平移的），不算溢出
            if (el.closest('[data-node-id]') || el.closest('svg')) return false
            return r.right > de.clientWidth + 1
          })
          .slice(0, 6)
          .map(el => (el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '')) + ' right=' + Math.round(el.getBoundingClientRect().right)),
      }
    })()`)
    check(`${dev.name}: 页面无横向溢出`,
      overflow.scrollW <= overflow.clientW + 1,
      `scrollW=${overflow.scrollW} clientW=${overflow.clientW} ${JSON.stringify(overflow.culprits)}`)

    /*
     * ★ 上面那条查不出「fixed 元素跑到屏幕外」。
     * `position: fixed` 的元素**不计入** documentElement.scrollWidth，
     * 所以左下角工具栏宽到 389px、右边界到 401px（iPhone SE 上溢出 26px，
     * 最后一颗按钮整个在屏幕外）时，scrollW 仍然是 375 —— 测试全绿。
     * 这正是这个 bug 一直没被发现的原因，所以必须单独量 fixed 元素。
     */
    const fixedOverflow = await evaluate(`(() => {
      const vw = document.documentElement.clientWidth
      const bad = []
      for (const el of document.querySelectorAll('body *')) {
        if (getComputedStyle(el).position !== 'fixed') continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        // 只看往右溢出（往左是隐藏式大纲，它本来就缩在屏幕外，是设计如此）
        if (r.right > vw + 1) {
          const tag = el.dataset.tool ? '[data-tool=' + el.dataset.tool + ']'
            : el.dataset.bottomToolbar !== undefined ? '[data-bottom-toolbar]'
              : el.tagName.toLowerCase()
          bad.push(tag + ' right=' + Math.round(r.right))
        }
      }
      return bad
    })()`)
    check(`${dev.name}: ★ 没有 fixed 元素溢出屏幕右侧`,
      fixedOverflow.length === 0, JSON.stringify(fixedOverflow))

    /* ---- 1b. 底部工具栏：装得下、点得到、不和右下角打架 ---- */
    const bar = await evaluate(`(() => {
      const vw = document.documentElement.clientWidth
      const el = document.querySelector('[data-bottom-toolbar]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const btns = [...el.querySelectorAll('[data-tool]')]
      const rects = btns.map(b => {
        const q = b.getBoundingClientRect()
        return { tool: b.dataset.tool, w: Math.round(q.width), h: Math.round(q.height), right: Math.round(q.right), bottom: Math.round(q.bottom), top: Math.round(q.top), left: Math.round(q.left) }
      })
      // 右下角那条「N 个折角 · 导入 · 导出 MD · 备份」
      let rightGroup = null
      for (const sp of document.querySelectorAll('span')) {
        if (!/个折角/.test(sp.textContent || '')) continue
        for (let p = sp; p && p !== document.body; p = p.parentElement) {
          if (getComputedStyle(p).position === 'fixed') { rightGroup = p; break }
        }
        if (rightGroup) break
      }
      const rr = rightGroup ? rightGroup.getBoundingClientRect() : null
      const overlap = rr
        ? (Math.min(r.right, rr.right) - Math.max(r.left, rr.left) > 0
           && Math.min(r.bottom, rr.bottom) - Math.max(r.top, rr.top) > 0)
        : false
      return {
        vw,
        bar: { left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) },
        count: btns.length,
        rects,
        minW: Math.min(...rects.map(x => x.w)),
        minH: Math.min(...rects.map(x => x.h)),
        tools: rects.map(x => x.tool),
        rightGroupVisible: rr ? Math.round(rr.width) > 0 : false,
        overlap,
      }
    })()`)
    check(`${dev.name}: 底部工具栏存在`, bar != null)
    if (bar) {
      note(`工具栏 [${bar.bar.left}, ${bar.bar.right}] 高 ${bar.bar.h}，${bar.count} 颗：${bar.tools.join(' ')}`)
      check(`${dev.name}: ★ 工具栏完整落在视口内`,
        bar.bar.right <= bar.vw + 1 && bar.bar.left >= -1,
        `right=${bar.bar.right} vw=${bar.vw}`)
      check(`${dev.name}: ★ 工具栏不和右下角信息条重叠`,
        bar.overlap === false, `overlap=${bar.overlap}`)
      check(`${dev.name}: 手机上右下角信息条已隐藏（内容进了「更多」面板）`,
        bar.rightGroupVisible === false, String(bar.rightGroupVisible))
      check(`${dev.name}: ★ 触摸热区 ≥40px`,
        bar.minW >= 40 && bar.minH >= 40, `${bar.minW}x${bar.minH}`)
      check(`${dev.name}: 撤销 / 重做在工具栏里`,
        bar.tools.includes('undo') && bar.tools.includes('redo'), bar.tools.join(' '))
      check(`${dev.name}: 次要动作收进「更多」，不占主行`,
        !bar.tools.includes('export-pdf') && bar.tools.includes('more'),
        bar.tools.join(' '))
    }

    /* ---- 2. 触摸手势：缩放/选中是否被正确抑制 ---- */
    const touch = await evaluate(`(() => {
      // 画布根节点 = touchAction:'none' 那一层，它是 svg 的祖父（不是父）。
      // 直接按节点往上找带 overflow-hidden 的那层更稳。
      const node = document.querySelector('[data-node-id]')
      let viewport = null
      for (let el = node; el && el !== document.body; el = el.parentElement) {
        if (getComputedStyle(el).touchAction === 'none') { viewport = el; break }
      }
      const cs = viewport ? getComputedStyle(viewport) : null
      return {
        found: !!viewport,
        touchAction: cs?.touchAction || null,
        userSelect: getComputedStyle(document.body).userSelect,
        // 手机上双指缩放页面会把整个 app 一起放大，很难受
        metaViewport: document.querySelector('meta[name=viewport]')?.content || null,
      }
    })()`)
    note(`canvas touch-action=${touch.touchAction} user-select=${touch.userSelect}`)
    note(`meta viewport: ${touch.metaViewport}`)

    check(`${dev.name}: 画布禁用了浏览器默认手势`,
      touch.touchAction === 'none',
      `touch-action=${touch.touchAction}`)

    check(`${dev.name}: 有 viewport meta 且禁止页面缩放`,
      !!touch.metaViewport && /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(touch.metaViewport),
      `meta=${touch.metaViewport}`)

    /*
     * ★ 真机是 hover:none / pointer:coarse —— 这是「触屏不弹键盘快捷键气泡」
     * 那条判断的**前提**。前提要是假的，弹窗里的气泡判断就是白写的。
     * movebrowser 那边用 stub 测分支，这里用真实触摸模拟钉住前提。
     */
    const pointer = await evaluate(`({
      hoverHover: window.matchMedia('(hover: hover)').matches,
      hoverNone: window.matchMedia('(hover: none)').matches,
      coarse: window.matchMedia('(pointer: coarse)').matches,
    })`)
    note(`指针能力：${JSON.stringify(pointer)}`)
    check(`${dev.name}: ★ 触摸设备报 hover:none（快捷键气泡判断的前提）`,
      pointer.hoverHover === false && pointer.hoverNone === true && pointer.coarse === true,
      JSON.stringify(pointer))

    /* ---- 3. 触控热区尺寸（WCAG 2.5.5 建议 44px，最低 24px） ---- */
    const targets = await evaluate(`(() => {
      const measure = (sel, label) => {
        const els = [...document.querySelectorAll(sel)]
        if (!els.length) return null
        const rects = els.map(el => el.getBoundingClientRect()).filter(r => r.width > 0)
        if (!rects.length) return null
        const minW = Math.min(...rects.map(r => r.width))
        const minH = Math.min(...rects.map(r => r.height))
        return { label, count: els.length, minW: Math.round(minW), minH: Math.round(minH) }
      }
      // 画布当前的 zoom —— 热区被 transform 缩放，必须一起报出来
      const g = document.querySelector('svg > g[transform]')
      const m = g?.getAttribute('transform')?.match(/scale\\(([\\d.]+)\\)/)
      return {
        canvasZoom: m ? Number(m[1]) : null,
        items: [
          measure('[data-fold-badge]', '折角角标'),
          measure('[data-fold-toggle]', '折叠三角'),
          measure('[data-outline-row]', '大纲行'),
        ].filter(Boolean),
      }
    })()`)
    note(`画布 zoom=${targets.canvasZoom}（角标热区会被这个值等比缩小）`)
    for (const t of targets.items) {
      const ok = t.minW >= 24 && t.minH >= 24
      check(`${dev.name}: ${t.label}热区 ≥24px`, ok, `${t.minW}x${t.minH} (n=${t.count})`)
    }

    /* ---- 4. 顶部栏 / 画布是否被挤出屏幕 ---- */
    const layout = await evaluate(`(() => {
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      const nodes = [...document.querySelectorAll('[data-node-id]')]
      const inView = nodes.filter(n => {
        const r = n.getBoundingClientRect()
        return r.width > 0 && r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh
      }).length
      return { vw, vh, nodes: nodes.length, inView }
    })()`)
    check(`${dev.name}: 首屏有节点可见`,
      layout.inView > 0,
      `可见 ${layout.inView}/${layout.nodes}`)
    note(`视口 ${layout.vw}x${layout.vh}，首屏可见节点 ${layout.inView}/${layout.nodes}`)

    /* ---- 5. 全屏折角弹窗在窄屏下是否堆叠 ---- */
    // 用 CDP 发真实触摸事件，而不是 dispatchEvent ——
    // React 的合成事件系统对 isTrusted=false 的合成事件在部分路径上不响应。
    const badgeBox = await evaluate(`(() => {
      const b = document.querySelector('[data-fold-badge]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
    })()`)

    let modal = { opened: false, reason: 'no badge' }
    if (badgeBox) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: badgeBox.x, y: badgeBox.y, id: 1 }],
      })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(1500)

      modal = await evaluate(`(() => {
        const dlg = document.querySelector('[data-fold-modal]')
        if (!dlg) return { opened: false }
        const container = dlg.querySelector('[data-modal-body]')
        const cs = container ? getComputedStyle(container) : null
        const kids = container ? [...container.children].filter(c => c.getBoundingClientRect().width > 0) : []
        const r = dlg.getBoundingClientRect()
        const panes = [...dlg.querySelectorAll('[data-pane-section]')].map(c => c.dataset.paneSection)
        const paneTabs = [...dlg.querySelectorAll('[data-pane-tab]')].map(b => b.dataset.paneTab)
        const active = dlg.querySelector('[data-pane-tab]')
        return {
          opened: true,
          direction: cs?.flexDirection || null,
          visiblePanes: kids.length,
          panes,
          paneTabs,
          pane: container?.dataset.pane || null,
          modeTabsVisible: !!dlg.querySelector('[data-mode-tab]'),
          dlgW: Math.round(r.width),
          dlgH: Math.round(r.height),
          vw: document.documentElement.clientWidth,
          vh: document.documentElement.clientHeight,
          // 手机端**不该有**左右分割线（单面板模式）
          splitterVisible: !!(() => {
            const s = dlg.querySelector('[role=separator]')
            return s && s.getBoundingClientRect().width > 0 && s.getBoundingClientRect().height > 0
          })(),
          // 用 dvh 而不是 vh：地址栏收起/展开时高度跟着变
          heightStyle: dlg.style.height || null,
        }
      })()`)

      if (modal.opened) {
        note(`弹窗 body: direction=${modal.direction} 可见面板=${modal.visiblePanes} pane=${modal.pane} 分割线=${modal.splitterVisible}`)
        check(`${dev.name}: ★ 手机端弹窗**不再分栏**（只渲染一个面板）`,
          modal.visiblePanes === 1,
          `可见面板=${modal.visiblePanes} direction=${modal.direction}`)
        check(`${dev.name}: ★ 顶部有【预览】/【编辑】两个切换按钮`,
          modal.paneTabs?.join() === 'preview,edit', JSON.stringify(modal.paneTabs))
        check(`${dev.name}: ★ 默认进入【预览】看全图`,
          modal.pane === 'preview', String(modal.pane))
        check(`${dev.name}: 预览面板时不显示「缩进列表 / Mermaid 代码」模式标签（减少噪音）`,
          modal.modeTabsVisible === false, String(modal.modeTabsVisible))
        check(`${dev.name}: 弹窗不超出视口`,
          modal.dlgW <= modal.vw + 1 && modal.dlgH <= modal.vh + 1,
          `dlg=${modal.dlgW}x${modal.dlgH} vp=${modal.vw}x${modal.vh}`)
        check(`${dev.name}: ★ 手机端没有左右分割线`,
          modal.splitterVisible === false,
          `splitterVisible=${modal.splitterVisible}`)
        check(`${dev.name}: ★ 用 100dvh 而不是 100vh（地址栏变化不会切掉底部）`,
          modal.heightStyle === '100dvh', String(modal.heightStyle))

        // 关掉，避免影响下一个机型
        await evaluate(`(() => {
          const dlg = document.querySelector('[data-fold-modal]')
          const btn = dlg && [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === '✕')
          if (btn) btn.click()
        })()`)
        await sleep(600)
      } else {
        note(`未能打开折角弹窗：${JSON.stringify(modal)}`)
      }
    } else {
      note('首屏没有折角角标')
    }

    /* ================================================================== */
    /* 新增交互只在最窄的机型上跑一遍（最受限的那一档）                      */
    /* ================================================================== */
    if (dev.w === DEVICES[0].w) {
      const tap = async (x, y) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      }
      const centerOf = (sel) => evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)})
        if (!el) return null
        const r = el.getBoundingClientRect()
        const vw = document.documentElement.clientWidth
        const vh = document.documentElement.clientHeight
        return {
          x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
          // 中心是否稳稳落在视口里 —— 触摸点在视口外时 CDP 会把它夹到边缘，
          // 于是「点节点」变成「点画布」，测试会以完全无关的方式失败
          inView: r.left + r.width / 2 > 8 && r.left + r.width / 2 < vw - 8
            && r.top + r.height / 2 > 8 && r.top + r.height / 2 < vh - 8,
        }
      })()`)

      /** 一键居中：把画布视口复位，保证下面的目标都在屏幕里 */
      const recenter = async () => {
        const c = await centerOf('[data-tool="center"]')
        if (c) await tap(c.x, c.y)
        await sleep(700)
      }

      /** 从 localStorage 读当前文档的父子关系 */
      const docTree = () => evaluate(`(() => {
        const id = JSON.parse(localStorage.getItem('mf:active'))
        const d = JSON.parse(localStorage.getItem('mf:doc:' + id))
        const out = []
        const walk = (n, p) => { out.push({ id: n.id, parent: p, text: n.text }); n.children.forEach(c => walk(c, n.id)) }
        walk(d.root, null)
        return out
      })()`)
      const parentOf = (t, id) => t.find((n) => n.id === id)?.parent

      /* ---- A. 「更多」面板：点开 / 有内容 / 点外面关掉 ---- */
      const moreBtn = await centerOf('[data-tool="more"]')
      check(`${dev.name}: 找到「更多」按钮`, moreBtn != null)
      /*
       * 前置条件不成立时**跳过**后续步骤，而不是硬跑。
       * 硬跑会在 `moreBtn.x` 上抛 TypeError，整个脚本以 exit 2 崩掉 ——
       * 后面几十条断言一条都不会跑，输出也看不出真正的问题在哪。
       * 一条断言失败就够了，别让它把整份报告带走。
       */
      if (moreBtn) {
        await tap(moreBtn.x, moreBtn.y)
        await sleep(400)
        const sheet = await evaluate(`(() => {
          const s = document.querySelector('[data-more-sheet]')
          if (!s) return null
          const r = s.getBoundingClientRect()
          const items = [...s.querySelectorAll('[data-more-item]')].map(b => b.dataset.moreItem)
          return {
            items,
            inViewport: r.left >= -1 && r.right <= document.documentElement.clientWidth + 1 && r.top >= -1,
            top: Math.round(r.top), bottom: Math.round(r.bottom),
            rowH: Math.round(s.querySelector('[data-more-item]')?.getBoundingClientRect().height || 0),
            text: s.innerText.replace(/\\n/g, ' | '),
          }
        })()`)
        check(`${dev.name}: ★ 点「更多」向上展开面板`, sheet != null, '没有 [data-more-sheet]')
        if (sheet) {
          note(`面板内容：${sheet.text}`)
          check(`${dev.name}: 面板完整落在视口内`, sheet.inViewport === true,
            JSON.stringify({ top: sheet.top, bottom: sheet.bottom }))
          check(`${dev.name}: 面板里能拿到桌面端的次要动作（导出 / 历史版本 / 回收站）`,
            ['导出', '历史版本', '回收站'].every((k) => sheet.items.includes(k)),
            JSON.stringify(sheet.items))
          check(`${dev.name}: 面板里有导入入口`, sheet.items.includes('导入'), JSON.stringify(sheet.items))
          check(`${dev.name}: 「导出」和「导入」都写明了支持哪些格式（不用点进去试）`,
            /Markdown/.test(sheet.text) && /OPML/.test(sheet.text) && /HTML/.test(sheet.text),
            sheet.text)
          check(`${dev.name}: 面板里显示折角数（原来在右下角那条）`,
            /个折角/.test(sheet.text), sheet.text)
          check(`${dev.name}: 面板行高够点（≥40px）`, sheet.rowH >= 40, String(sheet.rowH))
        }

        // 点面板外面 → 关掉
        await tap(dev.w / 2, 120)
        await sleep(400)
        const sheetClosed = await evaluate(`!!document.querySelector('[data-more-sheet]')`)
        check(`${dev.name}: 点面板外面关掉它`, sheetClosed === false, String(sheetClosed))
      }

      /* ---- B. 触摸拖拽节点 → 记录快照 → 点撤销能退回去 ---- */
      await recenter()

      const undoState = () => evaluate(`(() => {
        const b = document.querySelector('[data-tool="undo"]')
        return b ? { disabled: b.disabled, w: Math.round(b.getBoundingClientRect().width) } : null
      })()`)
      check(`${dev.name}: 初始撤销按钮置灰`, (await undoState())?.disabled === true,
        JSON.stringify(await undoState()))

      // 挑一对**都在视口里**的同层兄弟（按 left 分组 = 同深度）
      const pair = await evaluate(`(() => {
        const vw = document.documentElement.clientWidth
        const vh = document.documentElement.clientHeight
        const ok = (r) => r.left > 8 && r.right < vw - 8 && r.top > 8 && r.bottom < vh - 8
        const nodes = [...document.querySelectorAll('[data-node-id]')]
          .map(el => ({ id: el.dataset.nodeId, r: el.getBoundingClientRect() }))
          .filter(n => ok(n.r))
        const byLeft = new Map()
        for (const n of nodes) {
          const k = Math.round(n.r.left)
          if (!byLeft.has(k)) byLeft.set(k, [])
          byLeft.get(k).push(n)
        }
        for (const [, sibs] of byLeft) {
          if (sibs.length >= 2) return {
            a: { x: sibs[0].r.left + sibs[0].r.width / 2, y: sibs[0].r.top + sibs[0].r.height / 2, id: sibs[0].id },
            b: { x: sibs[1].r.left + sibs[1].r.width / 2, y: sibs[1].r.top + sibs[1].r.height / 2, id: sibs[1].id },
          }
        }
        return null
      })()`)
      check(`${dev.name}: 找到一对**都在视口内**的同层兄弟节点`, pair != null, JSON.stringify(pair))

      if (pair) {
        const treeBefore = await docTree()
        const originalParent = parentOf(treeBefore, pair.a.id)

        /*
         * 手机端**严禁拖拽节点改变层级**（需求二·2）。
         * 所以这里断言的是**层级一个字都没变** —— 和上一版正好相反。
         * 顺带断言「手指压着节点拖动 = 平移画布」，否则用户从节点上
         * 开始拖会毫无反应，那个不一致会被当成卡死。
         */
        const viewBefore = await evaluate(`(() => {
          let id = null
          try { id = JSON.parse(localStorage.getItem('mf:active')) } catch { id = localStorage.getItem('mf:active') }
          const d = JSON.parse(localStorage.getItem('mf:doc:' + id))
          return d.view
        })()`)

        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart', touchPoints: [{ x: pair.a.x, y: pair.a.y, id: 1 }],
        })
        const steps = 8
        for (let i = 1; i <= steps; i++) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{
              x: pair.a.x + (pair.b.x - pair.a.x) * (i / steps),
              y: pair.a.y + (pair.b.y - pair.a.y) * (i / steps),
              id: 1,
            }],
          })
          await sleep(60)
        }
        await sleep(250)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await sleep(1400)

        const treeAfter = await docTree()
        check(`${dev.name}: ★ 触摸拖拽节点**不改变层级**（移动端禁用拖拽）`,
          parentOf(treeAfter, pair.a.id) === originalParent,
          `${parentOf(treeAfter, pair.a.id)} 期望 ${originalParent}`)

        check(`${dev.name}: ★ 拖拽没有记录历史（撤销按钮保持置灰）`,
          (await undoState())?.disabled === true, JSON.stringify(await undoState()))

        const viewAfter = await evaluate(`(() => {
          let id = null
          try { id = JSON.parse(localStorage.getItem('mf:active')) } catch { id = localStorage.getItem('mf:active') }
          const d = JSON.parse(localStorage.getItem('mf:doc:' + id))
          return d.view
        })()`)
        const panned = Math.abs(viewAfter.x - viewBefore.x) > 5 || Math.abs(viewAfter.y - viewBefore.y) > 5
        check(`${dev.name}: ★ 手指压着节点拖动 = 平移画布（不会毫无反应）`,
          panned,
          `${JSON.stringify(viewBefore)} → ${JSON.stringify(viewAfter)}`)

        // 把画布挪回去，免得影响后面的用例
        await recenter()
      }

      /* ---- B2. 长按节点 500ms → 弹右键菜单（手机没有右键） ---- */
      {
        const target = await evaluate(`(() => {
          const vw = document.documentElement.clientWidth
          const vh = document.documentElement.clientHeight
          for (const el of document.querySelectorAll('[data-node-id]')) {
            const r = el.getBoundingClientRect()
            if (r.left > 8 && r.right < vw - 8 && r.top > 70 && r.bottom < vh - 90 && r.width > 0) {
              return { id: el.dataset.nodeId, x: r.left + r.width / 2, y: r.top + r.height / 2 }
            }
          }
          return null
        })()`)
        check(`${dev.name}: 找到一个可长按的节点`, target != null, JSON.stringify(target))

        if (target) {
          // 按住不动 600ms（> 500ms 阈值），期间不发 touchMove
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart', touchPoints: [{ x: target.x, y: target.y, id: 1 }],
          })
          await sleep(650)
          const menu = await evaluate(`(() => {
            const m = document.querySelector('[data-canvas-menu]')
            return m ? [...m.querySelectorAll('[data-menu-item]')].map(b => b.dataset.menuItem) : null
          })()`)
          check(`${dev.name}: ★ 长按 500ms 弹出右键菜单`, Array.isArray(menu) && menu.length > 0, JSON.stringify(menu))
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await sleep(300)

          // 滑动即关菜单（黄金标准）：手指一动菜单必须消失
          const stillOpen = await evaluate(`!!document.querySelector('[data-canvas-menu]')`)
          if (stillOpen) {
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart', touchPoints: [{ x: target.x, y: target.y, id: 1 }],
            })
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchMove', touchPoints: [{ x: target.x + 30, y: target.y + 30, id: 1 }],
            })
            await sleep(250)
            check(`${dev.name}: ★ 滑动即关菜单（touchmove 立刻 closeMenu）`,
              (await evaluate(`!document.querySelector('[data-canvas-menu]')`)) === true)
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
            await sleep(200)
          } else {
            // 松手时菜单已经关了（触摸结束也算一次交互结束），同样满足「不残留」
            check(`${dev.name}: ★ 滑动即关菜单（touchmove 立刻 closeMenu）`, true)
          }
        }
      }

      /* ---- B3. 长按后手指移动超过 10px → 取消长按，不弹菜单 ---- */
      {
        const target = await evaluate(`(() => {
          const vw = document.documentElement.clientWidth
          const vh = document.documentElement.clientHeight
          for (const el of document.querySelectorAll('[data-node-id]')) {
            const r = el.getBoundingClientRect()
            if (r.left > 8 && r.right < vw - 8 && r.top > 70 && r.bottom < vh - 90 && r.width > 0) {
              return { id: el.dataset.nodeId, x: r.left + r.width / 2, y: r.top + r.height / 2 }
            }
          }
          return null
        })()`)
        if (target) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart', touchPoints: [{ x: target.x, y: target.y, id: 1 }],
          })
          await sleep(120)   // 远不到 500ms
          // 移动 60px（远超 10px 阈值）→ 长按必须被取消
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x: target.x + 60, y: target.y, id: 1 }],
          })
          await sleep(600)   // 即使再等够 500ms，也不该弹菜单
          const menu = await evaluate(`!!document.querySelector('[data-canvas-menu]')`)
          check(`${dev.name}: ★ 长按期间移动 >10px 会取消长按（不弹菜单）`, menu === false, String(menu))
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await sleep(300)
          await recenter()
        }
      }

      /* ---- C. 弹窗里「移动位置」子菜单：触摸可用，且不弹快捷键气泡 ---- */
      await recenter()
      // 找一个**在视口里**的折角角标（首屏 7 个折角，不一定都在屏幕内）
      const badgeBox = await evaluate(`(() => {
        const vw = document.documentElement.clientWidth
        const vh = document.documentElement.clientHeight
        for (const b of document.querySelectorAll('[data-fold-badge]')) {
          const r = b.getBoundingClientRect()
          if (r.left > 8 && r.right < vw - 8 && r.top > 8 && r.bottom < vh - 8) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          }
        }
        return null
      })()`)
      check(`${dev.name}: 找到视口内的折角角标`, badgeBox != null)

      if (badgeBox) {
        await tap(badgeBox.x, badgeBox.y)
        await sleep(2400)
        const opened = await evaluate(`!!document.querySelector('[data-fold-modal]')`)
        check(`${dev.name}: 触摸能打开全屏弹窗`, opened === true)
        if (opened) {
          /*
           * 手机端弹窗默认进【预览】面板，而「缩进列表 / Mermaid 代码」模式标签
           * 只在【编辑】面板里出现（预览时藏起来减少噪音）。
           * 所以这里必须先切到【编辑】，否则点不到 data-mode-tab。
           */
          await evaluate(`(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms))
            document.querySelector('[data-pane-tab="edit"]')?.click()
            await sleep(600)
            document.querySelector('[data-mode-tab="code"]')?.click()
            await sleep(700)
          })()`)
          check(`${dev.name}: 切到【编辑】后模式标签可用`,
            (await evaluate(`!!document.querySelector('[data-mode-tab="code"]')`)) === true)
          // 切回【预览】再看图上的菜单（右键菜单只在图上有意义）
          await evaluate(`(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms))
            document.querySelector('[data-pane-tab="preview"]')?.click()
            await sleep(900)
          })()`)
          // 触摸长按不会出右键菜单，改用合成 contextmenu（headless 下更稳）
          const menuOpened = await evaluate(`(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms))
            const g = document.querySelector('[data-fold-modal] g.node')
            if (!g) return false
            const r = g.getBoundingClientRect()
            const inner = g.querySelector('rect, .label, foreignObject') || g
            inner.dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true, cancelable: true,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2,
            }))
            await sleep(450)
            return !!document.querySelector('[data-node-menu]')
          })()`)
          check(`${dev.name}: 弹窗里能弹出节点菜单`, menuOpened === true)

          const moveItem = await centerOf('[data-node-menu] [data-menu-item="move"]')
          check(`${dev.name}: 菜单里能拿到「移动位置」`, moveItem != null)
          if (moveItem) {
            await tap(moveItem.x, moveItem.y)
            await sleep(450)
            const sub = await evaluate(`(() => {
              const s = document.querySelector('[data-move-submenu]')
              if (!s) return null
              const r = s.getBoundingClientRect()
              return {
                items: [...s.querySelectorAll('[data-move-item]')].map(b => b.dataset.moveItem),
                inViewport: r.left >= -1 && r.right <= document.documentElement.clientWidth + 1,
                text: s.innerText.replace(/\\n/g, ' | '),
              }
            })()`)
            check(`${dev.name}: ★ 触摸也能展开子菜单`, sub != null, '子菜单没开')
            check(`${dev.name}: 子菜单完整落在视口内`, sub?.inViewport === true, JSON.stringify(sub))
            check(`${dev.name}: 子菜单四项都在`, sub?.items?.length === 4, JSON.stringify(sub?.items))
            check(`${dev.name}: 子菜单里没有常驻的快捷键文字（只在悬停气泡里出现）`,
              sub && !sub.text.includes('Alt'), String(sub?.text))
            check(`${dev.name}: 子菜单底部保留「两类操作区别」的一行说明`,
              sub && /只换顺序/.test(sub.text) && /改变层级/.test(sub.text), String(sub?.text))

            // 触摸悬停「上移」：触屏没有 hover，不该弹快捷键气泡
            const up = await centerOf('[data-move-submenu] [data-move-item="up"]')
            if (up) {
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: up.x, y: up.y, id: 1 }] })
              await sleep(300)
              const tipOnTouch = await evaluate(`!!document.querySelector('[data-move-tip]')`)
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
              await sleep(300)
              check(`${dev.name}: ★ 触屏不弹键盘快捷键气泡（手机没有键盘，且会黏住不走）`,
                tipOnTouch === false, String(tipOnTouch))
            }
          }
          await evaluate(`(() => {
            const dlg = document.querySelector('[data-fold-modal]')
            const btn = dlg && [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === '✕')
            if (btn) btn.click()
          })()`)
          await sleep(700)
        }
      }
    }
  }

  /* ---- 全局 console 错误 ---- */
  console.log(`\n${'='.repeat(52)}`)
  check('手机视口下无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  cdp.close()
  proc.kill()
  try { rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`\n${'='.repeat(52)}`)
  console.log(`  通过 ${pass} / 失败 ${fail}`)
  console.log('='.repeat(52))
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
    } else if (msg.method && handlers.has(msg.method)) {
      handlers.get(msg.method)(msg.params)
    }
  }
  return {
    send(method, params = {}) {
      const mid = ++id
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject })
        ws.send(JSON.stringify({ id: mid, method, params }))
      })
    },
    on(method, fn) { handlers.set(method, fn) },
    close() { ws.close() },
  }
}

main().catch((e) => {
  console.error('探测失败：', e.message)
  process.exit(2)
})