/**
 * 一次性探针 v2：把「浮层 vs 系统安全区 / 底栏」的几何关系全部量出来。
 * ================================================================
 * v1 的结论（已确认）：
 *   · 竖屏刘海屏（安全区 T47/B34）下，历史版本/回收站面板 rect 与底部工具栏
 *     **重叠 300×30px** —— 面板下缘被底栏压住。
 *   · 长按菜单（ContextMenu）在竖屏下 clamp 到「原始视口边 ±8px」，下缘 836 >
 *     可用底 810，且与底栏（758..798）**重叠 78px** —— 菜单最后几项压在底栏下面。
 * v1 的漏洞：长按菜单用 el.click() 会被合成事件绕过命中测试，
 *   所以 v2 一律加 **elementFromPoint 命中测试**：元素被别的盒子盖住时，
 *   合成 click 照样成功，真实手指点下去却点到盖住它的那一层。
 *
 * 用法：node scripts/probes/_sweep_safe.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import MiniWS from '../browser/_ws.mjs'

const URL_APP = process.argv[2] || 'http://127.0.0.1:5173/'
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

const PORT = 9392
const userDir = mkdtempSync(join(tmpdir(), 'mf-sweep-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
const LANDSCAPE = { width: 844, height: 390, deviceScaleFactor: 2, mobile: true }
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }

const NOTCH_P = [47, 34, 0, 0]
const NOTCH_L = [0, 21, 34, 34]
const NONE = [0, 0, 0, 0]
const PANEL_SEL = 'div[class*="fixed"][class*="z-\\[75\\]"]'

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new MiniWS(url)
    let id = 0
    const pend = new Map()
    ws.onmessage = (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.id && pend.has(msg.id)) {
        const { res, rej } = pend.get(msg.id)
        pend.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    }
    ws.opened.then(() => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id
          pend.set(mid, { res, rej })
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      },
      close: () => ws.close(),
    })).catch(reject)
  })
}

const RECT_JS = (sel) => `(()=>{
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(document.documentElement);
  const n = k => parseFloat(cs.getPropertyValue(k)) || 0;
  return { l:Math.round(r.left), t:Math.round(r.top), rt:Math.round(r.right), b:Math.round(r.bottom),
           w:Math.round(r.width), h:Math.round(r.height), text:(el.textContent||'').trim().slice(0,16),
           T:n('--mf-safe-t'), B:n('--mf-safe-b'), L:n('--mf-safe-l'), R:n('--mf-safe-r'),
           vw:innerWidth, vh:innerHeight };
})()`

/** 按文本找「贴边面板」（历史版本/回收站没有 data 属性） */
const PANEL_JS = (re) => `(()=>{
  const d=[...document.querySelectorAll('div[class*="fixed"]')].find(e=>new RegExp(${JSON.stringify(re)}).test((e.textContent||'').trim()));
  if(!d) return null; const r=d.getBoundingClientRect(); const cs=getComputedStyle(document.documentElement);
  const n=k=>parseFloat(cs.getPropertyValue(k))||0;
  return { l:Math.round(r.left),t:Math.round(r.top),rt:Math.round(r.right),b:Math.round(r.bottom),
           w:Math.round(r.width),h:Math.round(r.height),text:(d.textContent||'').trim().slice(0,10),
           T:n('--mf-safe-t'),B:n('--mf-safe-b'),L:n('--mf-safe-l'),R:n('--mf-safe-r'),vw:innerWidth,vh:innerHeight};
})()`

/** 每个匹配元素：矩形 + elementFromPoint 命中测试（能不能真的点到） */
const HIT_JS = (sel) => `(()=>{
  const els=[...document.querySelectorAll(${JSON.stringify(sel)})];
  if(!els.length) return null;
  const cs=getComputedStyle(document.documentElement); const n=k=>parseFloat(cs.getPropertyValue(k))||0;
  return els.map(el=>{
    const r=el.getBoundingClientRect();
    const cx=Math.round(r.left+r.width/2), cy=Math.round(r.top+r.height/2);
    const hit=document.elementFromPoint(cx,cy);
    const ok = !!hit && (el===hit || el.contains(hit) || hit.contains(el));
    return { label:(el.textContent||'').trim().slice(0,10) || el.getAttribute('data-menu-item') || el.tagName,
             cx, cy, t:Math.round(r.top), b:Math.round(r.bottom), l:Math.round(r.left), rt:Math.round(r.right),
             ok, hit: ok ? '' : (hit ? (hit.getAttribute('data-tool')||hit.tagName) + ':' + (hit.textContent||'').trim().slice(0,10) : 'null'),
             T:n('--mf-safe-t'), B:n('--mf-safe-b'), vh:innerHeight };
  });
})()`

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
    } catch { /* not up */ }
  }
  if (!target) throw new Error('无法连接 DevTools')
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }

  const setViewport = async (v) => { await cdp.send('Emulation.setDeviceMetricsOverride', v); await sleep(700) }
  const setInsets = async ([t, b, l, r]) => {
    await evaluate(`(()=>{const s=document.documentElement.style;
      s.setProperty('--mf-safe-t','${t}px');s.setProperty('--mf-safe-b','${b}px');
      s.setProperty('--mf-safe-l','${l}px');s.setProperty('--mf-safe-r','${r}px');return true})()`)
    await sleep(200)
  }
  const reload = async (insets) => {
    await cdp.send('Page.navigate', { url: URL_APP })
    await sleep(3200)
    await setInsets(insets)
    // 页内小工具：把任意元素/工具栏容器量成统一形状
    await evaluate(`(()=>{
      window.__mfR = (el) => { if(!el) return null; const r=el.getBoundingClientRect();
        const cs=getComputedStyle(document.documentElement); const n=k=>parseFloat(cs.getPropertyValue(k))||0;
        return {l:Math.round(r.left),t:Math.round(r.top),rt:Math.round(r.right),b:Math.round(r.bottom),
                w:Math.round(r.width),h:Math.round(r.height),T:n('--mf-safe-t'),B:n('--mf-safe-b'),
                L:n('--mf-safe-l'),R:n('--mf-safe-r'),vw:innerWidth,vh:innerHeight} };
      window.__mfToolbar = () => { const b=document.querySelector('[data-tool="more"]')||document.querySelector('[data-tool="radar"]');
        return b ? window.__mfR(b.parentElement) : null };
      return true })()`)
  }
  const clickSel = async (sel) => evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true})()`)
  const press = async (x, y, button = 'left', clickCount = 1) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount })
    await sleep(420)
  }
  const longPressAt = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await sleep(750)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(450)
  }
  const panBy = async (dy) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 195, y: 300, deltaX: 0, deltaY: dy, button: 'none' })
    await sleep(300)
  }

  const viol = (r, tag) => {
    if (!r) { console.log(`  （${tag} 没找到）`); return }
    const v = []
    if (r.t < r.T - 0.5) v.push(`上边 ${r.t} < 安全区 ${r.T}（压住状态栏 ${(r.T - r.t).toFixed(0)}px）`)
    if (r.b > r.vh - r.B + 0.5) v.push(`下边 ${r.b} > 可用底 ${r.vh - r.B}（超出 ${(r.b - (r.vh - r.B)).toFixed(0)}px）`)
    if (r.l < r.L - 0.5) v.push(`左边 ${r.l} < 安全区 ${r.L}`)
    if (r.rt > r.vw - r.R + 0.5) v.push(`右边 ${r.rt} > ${r.vw - r.R}`)
    console.log(`  ${v.length ? '✗' : '✓'} ${tag} rect=[${r.l},${r.t} → ${r.rt},${r.b}] ${r.w}×${r.h} 视口 ${r.vw}×${r.vh} 安全区 T${r.T}/B${r.B}/L${r.L}/R${r.R}`)
    for (const x of v) console.log(`      ⚠ ${x}`)
  }
  const panel = async (tag, re, sel) => { viol(sel ? await evaluate(RECT_JS(sel)) : await evaluate(PANEL_JS(re)), tag) }
  const hits = async (tag, sel) => {
    const arr = await evaluate(HIT_JS(sel))
    if (!arr) { console.log(`  （${tag} 没找到：${sel}）`); return }
    const covered = arr.filter((a) => !a.ok)
    console.log(`  ${covered.length ? '✗' : '✓'} ${tag}：${arr.length - covered.length}/${arr.length} 项可点`)
    for (const a of covered) console.log(`      ⚠ 「${a.label}」中心(${a.cx},${a.cy}) 命中 → ${a.hit}`)
    const out = arr.filter((a) => a.t < a.T - 0.5 || a.b > a.vh - a.B + 0.5)
    for (const a of out) console.log(`      ⚠ 「${a.label}」越界 t=${a.t} b=${a.b}（安全区 ${a.T}/${a.vh - a.B}）`)
  }
  const rectOf2 = (spec) => evaluate(spec.startsWith('js:') ? spec.slice(3) : RECT_JS(spec))
  const overlapStr = async (tag, a, b) => {
    const [ra, rb] = [await rectOf2(a), await rectOf2(b)]
    if (!ra || !rb) { console.log(`  （${tag} 缺元素 ${a}=${!!ra} ${b}=${!!rb}）`); return }
    const ox = Math.min(ra.rt, rb.rt) - Math.max(ra.l, rb.l)
    const oy = Math.min(ra.b, rb.b) - Math.max(ra.t, rb.t)
    console.log(`  ${ox > 0 && oy > 0 ? '✗ 重叠' : '✓ 不重叠'} ${tag}：${ox > 0 && oy > 0 ? `${ox}×${oy}px` : ''} a=[${ra.l},${ra.t},${ra.rt},${ra.b}] b=[${rb.l},${rb.t},${rb.rt},${rb.b}]`)
  }
  const nodes = () => evaluate(`(()=>{
    const ns=[...document.querySelectorAll('[data-node-id]')].map(e=>{const r=e.getBoundingClientRect();
      return {id:e.getAttribute('data-node-id'), l:Math.round(r.left), t:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height)}});
    return ns;
  })()`)
  /** 滚轮平移，把最靠上的节点挪到目标 y */
  const bringTopNodeTo = async (targetY) => {
    for (let i = 0; i < 10; i++) {
      const ns = await nodes()
      if (!ns.length) return null
      const top = ns.reduce((a, b) => (a.t < b.t ? a : b))
      const d = top.t - targetY
      if (Math.abs(d) <= 12) return top
      await panBy(Math.max(-120, Math.min(120, d)))
    }
    const ns = await nodes()
    return ns.length ? ns.reduce((a, b) => (a.t < b.t ? a : b)) : null
  }
  /** 长按某个节点 → 画布菜单 → 点某一项 */
  const contextAction = async (action) => {
    const ns = await nodes()
    if (!ns.length) return false
    const n = ns.reduce((a, b) => (a.t > b.t ? a : b))
    await longPressAt(n.l + Math.min(20, n.w / 2), n.t + n.h / 2)
    const ok = await clickSel(`[data-canvas-menu] [data-menu-item="${action}"]`)
    await sleep(700)
    return ok
  }

  console.log('\n========== A 竖屏刘海屏 390×844，安全区 47/34 ==========')
  await setViewport(PHONE)

  console.log('\n--- A1 历史版本面板 vs 底栏 ---')
  await reload(NOTCH_P)
  await clickSel('[data-tool="more"]'); await sleep(400)
  await clickSel('[data-more-item="历史版本"]'); await sleep(500)
  viol(await evaluate(PANEL_JS('^历史版本')), '历史版本面板')
  await overlapStr('历史版本面板 vs 底栏容器', PANEL_SEL, 'js:__mfToolbar()')

  console.log('\n--- A2 回收站面板 vs 底栏 ---')
  await reload(NOTCH_P)
  await clickSel('[data-tool="more"]'); await sleep(400)
  await clickSel('[data-more-item="回收站"]'); await sleep(500)
  viol(await evaluate(PANEL_JS('^回收站')), '回收站面板')
  await overlapStr('回收站面板 vs 底栏容器', PANEL_SEL, 'js:__mfToolbar()')

  console.log('\n--- A3 长按菜单：几何 + 命中测试 ---')
  await reload(NOTCH_P)
  const n0 = await nodes()
  const lowest = n0.reduce((a, b) => (a.t > b.t ? a : b))
  await longPressAt(lowest.l + Math.min(20, lowest.w / 2), lowest.t + lowest.h / 2)
  viol(await evaluate(RECT_JS('[data-canvas-menu]')), '长按菜单(靠近底部节点)')
  await overlapStr('长按菜单 vs 底栏容器', '[data-canvas-menu]', 'js:__mfToolbar()')
  await hits('长按菜单各项在真实指针下能否点到', '[data-canvas-menu] [data-menu-item]')

  console.log('\n--- A4 折角弹窗内：改字框 / 节点菜单（clamp 用的是 window.innerHeight） ---')
  await reload(NOTCH_P)
  const added = await contextAction('add-fold')
  const badge = await evaluate(`(()=>{
    const bs=[...document.querySelectorAll('[data-fold-badge]')].map(e=>{const r=e.getBoundingClientRect();
      return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}});
    return bs;
  })()`)
  console.log(`  打上折角=${added} 折角角标 ${badge.length} 个`)
  if (badge.length) {
    await press(badge[0].l + badge[0].w / 2, badge[0].t + badge[0].h / 2)
    await sleep(1200)
  }
  const modal = await evaluate(`!!document.querySelector('[data-fold-modal]')`)
  console.log(`  折角弹窗=${modal}`)
  if (modal) {
    /*
     * 手机端弹窗里的浮动控件，本轮换了一茬：
     *   · 左下角那条「指向 / 指向同一结果」（data-mobile-bar）已按用户要求删除
     *   · 右下角那条 152px 高的竖排控制区（data-zoom-panel）现在**只在桌面端**
     *     渲染，手机端换成一条横排的 data-mobile-bottom-bar（撤销/重做/回到中点）
     * 所以这里量的是新那条 —— 它贴右下角，正是最容易压到手势条的东西。
     */
    viol(await evaluate(RECT_JS('[data-mobile-bottom-bar]')), '弹窗右下操作条')
    const g = await evaluate(`(()=>{
      const vh=innerHeight, vw=innerWidth;
      const gs=[...document.querySelectorAll('[data-fold-modal] g.node')].map(e=>{const r=e.getBoundingClientRect();
        return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),
                inside: r.top>=0 && r.bottom<=vh && r.left>=0 && r.right<=vw}});
      return gs;
    })()`)
    const vis = g.filter((x) => x.inside)
    console.log(`  图内节点 ${g.length} 个（视口内 ${vis.length} 个）`)
    if (vis.length) {
      // ① 双击最靠上的图内节点 → 改字框（贴着节点下方出现）
      const hi = vis.reduce((a, b) => (a.t < b.t ? a : b))
      const hx = hi.l + hi.w / 2, hy = hi.t + hi.h / 2
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hx, y: hy, button: 'left', clickCount: 2 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hx, y: hy, button: 'left', clickCount: 2 })
      await sleep(600)
      console.log(`  双击最上方图内节点（节点 t=${hi.t}）`)
      viol(await evaluate(RECT_JS('[data-label-editor]')), '改字框（双击改名）')
      await evaluate(`(()=>{const i=document.querySelector('[data-label-input]'); if(i){i.blur()} return true})()`)
      await sleep(400)
      // ② 右键最靠下的图内节点 → 节点菜单（会向上翻转）
      const low = vis.reduce((a, b) => (a.t > b.t ? a : b))
      await press(low.l + low.w / 2, low.t + low.h / 2, 'right')
      const nm = await evaluate(RECT_JS('[data-node-menu]'))
      console.log(`  右键最下方图内节点（节点 t=${low.t}）→ node-menu=${!!nm}`)
      viol(nm, '弹窗内节点右键菜单')
      if (nm) await hits('弹窗内菜单各项能否点到', '[data-node-menu] [data-menu-item]')
    }
    await press(195, 300)   // 关掉菜单
  }

  console.log('\n========== B 横屏 844×390，安全区 0/21/34/34 ==========')
  await setViewport(LANDSCAPE)
  await reload(NOTCH_L)
  const inView = async () => (await nodes()).filter((n) => n.t >= 0 && n.t + n.h <= 390 && n.l >= 0 && n.l + n.w <= 844)
  const nL = await inView()
  console.log(`  视口内节点 ${nL.length} 个`)
  if (nL.length) {
    const low = nL.reduce((a, b) => (a.t > b.t ? a : b))
    await press(low.l + low.w / 2, low.t + low.h / 2, 'right')
    viol(await evaluate(RECT_JS('[data-canvas-menu]')), '横屏右键菜单')
    viol(await evaluate(RECT_JS('[data-tool="more"]')), '横屏底栏锚点')
    viol(await evaluate(RECT_JS('[data-tool="radar"]')), '横屏底栏最右（右安全区）')
  }
  await reload(NOTCH_L)
  await clickSel('[data-tool="history"]'); await sleep(500)
  viol(await evaluate(PANEL_JS('^历史版本')), '横屏历史版本面板')

  console.log('\n========== C 桌面 1440×900，安全区全 0（应零违规） ==========')
  await setViewport(DESKTOP)
  await reload(NONE)
  const nD = await nodes()
  if (nD.length) {
    const low = nD.reduce((a, b) => (a.t > b.t ? a : b))
    await press(low.l + low.w / 2, low.t + low.h / 2, 'right')
    viol(await evaluate(RECT_JS('[data-canvas-menu]')), '桌面右键菜单')
    await hits('桌面菜单各项能否点到', '[data-canvas-menu] [data-menu-item]')
  }
  await reload(NONE)
  await clickSel('[data-tool="history"]'); await sleep(500)
  viol(await evaluate(PANEL_JS('^历史版本')), '桌面历史版本面板')
  await overlapStr('桌面历史面板 vs 底栏', 'div[class*="fixed"][class*="bottom-14"]', '[data-tool="more"]')

  console.log('\n========== D 全量扫荡：每个浮层状态下，有没有「内容」落在系统栏下面 ==========')
  /*
   * 判定口径（写清楚，免得自己骗自己）：
   *   · 只看 position: fixed/absolute 且**在屏幕坐标系里**的元素
   *     （有 transform 祖先的是画布内容，跟着画布走，不算浮层）
   *   · 只看「有内容」的盒子：直接文本 / 表单控件 / 有背景
   *   · 用**内容盒**（扣掉 padding）判边：铺满全屏的面板允许背景铺到 y=0，
   *     只要求里面的东西让开 —— 这正是本项目定下的规则
   *   · 满屏容器本身跳过（背景铺满是设计），它的子元素会被逐个检查
   */
  const sweep = async (tag) => {
    const res = await evaluate(`(()=>{
      const cs=getComputedStyle(document.documentElement); const n=k=>parseFloat(cs.getPropertyValue(k))||0;
      const T=n('--mf-safe-t'), B=n('--mf-safe-b'), L=n('--mf-safe-l'), R=n('--mf-safe-r');
      const W=innerWidth, H=innerHeight; const out=[];
      for (const el of document.querySelectorAll('body *')) {
        const s=getComputedStyle(el);
        if (s.position!=='fixed' && s.position!=='absolute') continue;
        if (s.display==='none' || s.visibility==='hidden' || parseFloat(s.opacity)===0) continue;
        const r=el.getBoundingClientRect();
        if (r.width<1 || r.height<1) continue;
        if (r.width>=W-1 && r.height>=H-1) continue;
        /* 滑出屏幕的抽屉/标签栏（translate 到视口外，只露几像素感应条）不算：
           用「与视口的交集面积 / 自身面积」判断，露不到 1/4 就跳过 */
        const ix=Math.max(0, Math.min(r.right,W)-Math.max(r.left,0));
        const iy=Math.max(0, Math.min(r.bottom,H)-Math.max(r.top,0));
        if (ix*iy < r.width*r.height*0.25) continue;
        let a=el.parentElement, tf=false;
        while(a && a!==document.body){ const as=getComputedStyle(a);
          if (as.transform!=='none' || as.perspective!=='none' || as.filter!=='none'){tf=true;break} a=a.parentElement }
        if (tf) continue;
        const hasText=[...el.childNodes].some(x=>x.nodeType===3 && x.textContent.trim());
        const isCtl=/^(INPUT|BUTTON|TEXTAREA|SELECT|IMG|CANVAS)$/i.test(el.tagName) || el.tagName.toLowerCase()==='svg';
        const bg=s.backgroundColor;
        const hasBg=bg && bg!=='rgba(0, 0, 0, 0)' && bg!=='transparent';
        if(!hasText && !isCtl && !hasBg) continue;
        const px=v=>parseFloat(v)||0;
        const ct=r.top+px(s.borderTopWidth)+px(s.paddingTop), cb=r.bottom-px(s.borderBottomWidth)-px(s.paddingBottom);
        const cl=r.left+px(s.borderLeftWidth)+px(s.paddingLeft), cr=r.right-px(s.borderRightWidth)-px(s.paddingRight);
        if (cb-ct<1 || cr-cl<1) continue;
        const v=[];
        if(ct < T-0.5) v.push('上'+Math.round(ct)+'<'+T);
        if(cb > H-B+0.5) v.push('下'+Math.round(cb)+'>'+(H-B));
        if(cl < L-0.5) v.push('左'+Math.round(cl)+'<'+L);
        if(cr > W-R+0.5) v.push('右'+Math.round(cr)+'>'+(W-R));
        if(!v.length) continue;
        out.push({ sel: el.tagName.toLowerCase()
            + (el.getAttribute('data-node-id')?'[node]':'')
            + (el.getAttribute('data-tool')?'[tool='+el.getAttribute('data-tool')+']':'')
            + (el.getAttribute('data-more-item')?'[more='+el.getAttribute('data-more-item')+']':'')
            + (el.getAttribute('data-menu-item')?'[menu='+el.getAttribute('data-menu-item')+']':'')
            + (el.className && el.className.toString ? '.'+el.className.toString().split(' ').slice(0,2).join('.') : ''),
          text:(el.textContent||'').trim().slice(0,16), rect:[Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)], why:v.join(' ') });
      }
      return {T,B,L,R,W,H,out};
    })()`)
    if (!res.out.length) { console.log(`  ✓ ${tag}：无内容压到系统栏（安全区 T${res.T}/B${res.B}/L${res.L}/R${res.R}）`); return }
    console.log(`  ✗ ${tag}：${res.out.length} 处`)
    const seen = new Set()
    for (const o of res.out) {
      const key = o.sel + o.why
      if (seen.has(key)) continue
      seen.add(key)
      console.log(`      ⚠ ${o.why.padEnd(22)} ${o.sel} 「${o.text}」 rect=[${o.rect}]`)
    }
  }

  await setViewport(PHONE)
  await reload(NOTCH_P)
  await sweep('D1 基础画布')
  await clickSel('[data-mobile-menu-btn]'); await sleep(600)
  await sweep('D2 手机抽屉（大纲）')
  await reload(NOTCH_P)
  // 本轮新增：右上角「文档标签」面板（用户要求把左侧大纲和顶部标签拆开）
  await clickSel('[data-mobile-tabs-btn]'); await sleep(700)
  await sweep('D2b 手机文档标签面板')
  await reload(NOTCH_P)
  await clickSel('[data-tool="more"]'); await sleep(500)
  await sweep('D3 更多面板')
  await reload(NOTCH_P)
  await clickSel('[data-tool="more"]'); await sleep(400)
  await clickSel('[data-more-item="历史版本"]'); await sleep(500)
  await sweep('D4 历史版本面板')
  await reload(NOTCH_P)
  await clickSel('[data-tool="more"]'); await sleep(400)
  await clickSel('[data-more-item="回收站"]'); await sleep(500)
  await sweep('D5 回收站面板')
  await reload(NOTCH_P)
  await clickSel('[data-tool="more"]'); await sleep(400)
  await clickSel('[data-more-item="卡片复习"]'); await sleep(700)
  await sweep('D6 卡片复习')
  await reload(NOTCH_P)
  await clickSel('[data-tool="radar"]'); await sleep(900)
  await sweep('D7 雷达复习')
  await reload(NOTCH_P)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}))`)
  await sleep(700)
  await sweep('D8 搜索框')
  await reload(NOTCH_P)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}))`)
  await sleep(600)
  await evaluate(`(()=>{const i=document.querySelector('input[type="search"],input[placeholder*="搜索"],input[placeholder*="查找"]'); if(i){i.value='z';i.dispatchEvent(new Event('input',{bubbles:true}))} return true})()`)
  await sleep(700)
  await sweep('D9 搜索框（有结果列表）')
  await reload(NOTCH_P)
  await contextAction('add-fold')
  const bg2 = await evaluate(`(()=>{const b=[...document.querySelectorAll('[data-fold-badge]')].map(e=>{const r=e.getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}});return b})()`)
  if (bg2.length) { await press(bg2[0].l + bg2[0].w / 2, bg2[0].t + bg2[0].h / 2); await sleep(1300) }
  await sweep('D10 折角弹窗')

  console.log('\n========== E 横屏 844×390，安全区 0/21/34/34 ==========')
  await setViewport(LANDSCAPE)
  await reload(NOTCH_L)
  await sweep('E1 基础画布（横屏）')
  await reload(NOTCH_L)
  await clickSel('[data-tool="history"]'); await sleep(500)
  await sweep('E2 历史版本面板（横屏）')
  await reload(NOTCH_L)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}))`)
  await sleep(700)
  await sweep('E3 搜索框（横屏）')

  console.log('\n探针结束。')
  cdp.close()
  proc.kill()
  process.exit(0)
}

main().catch((e) => { console.error('探针失败：', e); process.exit(1) })
