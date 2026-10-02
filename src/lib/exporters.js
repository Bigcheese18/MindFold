/**
 * 导出模块
 * ========
 * 两个导出目标，分别有不同的硬性约束：
 *
 * 1. 离线 HTML：单文件，必须内联全部 JS/CSS/Mermaid 库，断网双击可运行，
 *    并保留「点击折角」的交互。做法是把每张流程图预渲染成 SVG 内联进去，
 *    这样连 Mermaid 运行时都不需要 —— 文件更小，且 100% 不会因为版本问题挂掉。
 *
 * 2. PDF：**只印思维导图本体 + 它里面的流程图**，别的什么都不印。
 *    横向 A4（导图是横向生长的），强制「纯白主题」（无论当前什么主题），
 *    每个折角的流程图放在它所属节点那条分支的正下方、一条细引线连回去。
 *    用 window.print() + 打印样式实现，不引入 jsPDF 之类的重依赖，
 *    也避免中文在 canvas 里糊掉。排版逻辑在 printLayout.js（纯函数，可测）。
 */

import { collectFolds, foldColor, toMarkdown } from './model'
import { renderMermaid, applyTheme } from './mermaid'
import { printLayout, buildPrintHtml } from './printLayout'
import { docToJson, toOpml, toFreeMind, EMBED_SCRIPT_ID } from './formats'

/* ------------------------------------------------------------------ */
/* 1. 离线单文件 HTML                                                   */
/* ------------------------------------------------------------------ */

export async function exportOfflineHtml(doc, { theme = 'white' } = {}) {
  const folds = collectFolds(doc.root)

  // 预渲染所有流程图 → SVG 字符串
  const svgs = []
  for (const f of folds) {
    if (f.node.fold?.mermaid) {
      const r = await renderMermaid(f.node.fold.mermaid)
      svgs.push(r.ok ? r.svg : '')
    } else {
      svgs.push('')
    }
  }

  // 渲染整棵树的 HTML（含折叠交互）
  const treeHtml = renderTreeHtml(doc.root, folds, svgs)

  /*
   * 内嵌一份我们自己的 JSON 载荷。
   *
   * 【为什么要多塞一段看不见的 JSON】
   * 这一页导出去之后必须能**导回来** —— 用户会把导出的 HTML 当成自己的存档。
   * 而光看 HTML 结构，折角次数（复习进度）、mermaid 源码、汇聚连线全都会丢，
   * 再导进来就只剩一棵光秃秃的文字树。内嵌一份载荷，回导就是无损的。
   *
   * 为什么 `type` 不写 text/javascript：浏览器不会执行它，也不会显示它，
   * 断网双击打开这一页时它连解析都不需要（读它的只有 MindFold 的导入）。
   *
   * 为什么把 `<` 写成 `\u003c`：JSON 里一旦出现 `</script>`（节点文字里完全可能
   * 有人写这七个字符），HTML 解析器会在那里**提前结束脚本块**，整段载荷就废了，
   * 页面剩余部分还会被当成脚本内容。转义成 `\u003c` 后 JSON.parse 能原样读回。
   */
  const payload = JSON.stringify(docToJson(doc)).replace(/</g, '\\u003c')

  const html = `<!doctype html>
<html lang="zh-CN" data-mindfold-export="offline-html">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.name)} · MindFold</title>
<style>${INLINE_CSS}</style>
</head>
<body data-theme="${theme}">
<header class="hd">
  <div class="brand"><span class="logo">M</span><h1>${esc(doc.name)}</h1></div>
  <div class="meta">${folds.length} 个折角 · 导出自 MindFold</div>
</header>
<main class="wrap">
  <section class="outline">${treeHtml}</section>
  <div class="modal" id="modal" hidden>
    <div class="modal-box">
      <div class="modal-hd">
        <span id="modal-title"></span>
        <div class="spacer"></div>
        <button class="btn" onclick="closeModal()">关闭 (Esc)</button>
      </div>
      <div class="modal-bd" id="modal-body"></div>
    </div>
  </div>
</main>
<script type="application/json" id="${EMBED_SCRIPT_ID}">${payload}</script>
<script>${INLINE_JS}</script>
</body>
</html>`

  const file = `${safeName(doc.name)}.html`
  download(file, html, 'text/html;charset=utf-8')
  return { folds: folds.length, file, bytes: html.length }
}

/** 把节点树渲染成可交互的 HTML（折角点击 → 弹出内联 SVG） */
function renderTreeHtml(root, folds, svgs) {
  const svgById = new Map()
  folds.forEach((f, i) => svgById.set(f.node.id, svgs[i]))

  const walk = (node, depth) => {
    const hasFold = !!node.fold
    const svg = svgById.get(node.id)
    const hollow = hasFold && !node.fold.corner
    const count = node.fold?.openCount ?? 0
    const color = foldColor(count)

    // 与应用内一致：圆形角标（空折角 = 空心圆圈，未读 = 小圆点，读过 = 数字圆圈）
    let foldBtn = ''
    if (hasFold) {
      const inner = hollow
        ? `<span class="badge ring" style="--c:${color}"></span>`
        : count > 0
          ? `<span class="badge num" style="--c:${color}">${count > 99 ? '99+' : count}</span>`
          : `<span class="badge dot" style="--c:${color}"></span>`
      foldBtn = `<button class="fold" ${svg ? `onclick="openModal(this,'${node.id}')"` : 'disabled'}
           title="${svg ? '查看流程图' : '空折角（无流程图）'}"
           data-title="${escAttr(node.text)}">${inner}</button>`
    }

    const kids = node.children.length
      ? `<div class="kids">${node.children.map((c) => walk(c, depth + 1)).join('')}</div>`
      : ''

    if (depth === 0) return kids // 根节点只作为标题

    /*
     * `data-mf-depth` / `data-mf-fold` 是给**导入**看的兜底标记。
     * 正常情况下回导走的是内嵌 JSON（无损）；万一那一页被别的编辑器洗过、
     * 脚本标签没了，这两个属性还能让 formats.js 把层级和折角读回来，
     * 而不是给用户一句「这个 HTML 里没有找到可用的标题或列表」。
     */
    return `<div class="item">
      <div class="row">
        <span class="txt" data-mf-depth="${depth}" data-mf-fold="${hasFold ? '1' : '0'}"
              style="${node.bold ? 'font-weight:600' : ''}${node.italic ? 'font-style:italic' : ''}">${esc(node.text)}</span>
        ${foldBtn}
      </div>
      ${svg ? `<template id="tpl-${node.id}">${svg}</template>` : ''}
      ${kids}
    </div>`
  }

  return walk(root, 0)
}

const INLINE_CSS = `
:root{--bg:#fff;--ink:#1f2328;--muted:#6b7280;--line:#eceef1;--panel:#fff}
[data-theme=sepia]{--bg:#fdf9f0;--ink:#4a3b2a;--muted:#8a7a63;--line:#ece0c9;--panel:#fdfbf5}
[data-theme=dark]{--bg:#111318;--ink:#e5e7eb;--muted:#9aa3b2;--line:#262c37;--panel:#171a21}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 Inter,system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
.hd{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 28px;display:flex;align-items:center;gap:14px;z-index:10}
.brand{display:flex;align-items:center;gap:10px}
.logo{width:24px;height:24px;border:1.7px solid var(--ink);border-radius:4px;display:grid;place-items:center;font-weight:700;font-size:12px;position:relative}
.logo::after{content:"";position:absolute;top:-1.7px;right:-1.7px;width:9px;height:9px;background:linear-gradient(225deg,transparent 48%,var(--ink) 50%);}
h1{font-size:15px;margin:0;font-weight:600}
.meta{color:var(--muted);font-size:11.5px;margin-left:auto}
.wrap{max-width:1000px;margin:0 auto;padding:24px 28px 80px}
.item{margin:2px 0}
.row{display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:8px;position:relative;border:1px solid transparent}
.row:hover{background:var(--panel);border-color:var(--line)}
.txt{flex:1;min-width:0}
.kids{margin-left:20px;border-left:1px solid var(--line);padding-left:12px}
.fold{width:24px;height:24px;border:0;background:transparent;cursor:pointer;display:grid;place-items:center;border-radius:9999px;flex-shrink:0;padding:0}
.fold:disabled{cursor:default}
.fold:not(:disabled):hover .badge{transform:scale(1.15)}
/* 圆形角标：与应用内视觉一致 */
.badge{display:grid;place-items:center;border-radius:9999px;box-sizing:border-box;
  box-shadow:0 0 0 2px var(--bg);transition:transform .12s ease;font-weight:600;line-height:1}
.badge.dot{width:8px;height:8px;background:var(--c)}
.badge.num{height:16px;min-width:16px;padding:0 4px;font-size:10px;color:#fff;background:var(--c)}
.badge.ring{width:12px;height:12px;background:var(--bg);border:2px solid var(--c)}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.34);display:grid;place-items:center;z-index:100;padding:24px}
.modal[hidden]{display:none}
.modal-box{background:var(--bg);border:1px solid var(--line);border-radius:16px;width:min(880px,100%);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;animation:pop .2s ease}
@keyframes pop{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}
.modal-hd{display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px;font-weight:500}
.spacer{flex:1}
.btn{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer}
.btn:hover{color:var(--ink)}
.modal-bd{overflow:auto;padding:20px;display:grid;place-items:center}
.modal-bd svg{max-width:100%;height:auto}
@media print{
  .hd,.modal{display:none!important}
  body{background:#fff!important;color:#000!important}
  .row{break-inside:avoid}
}
`

const INLINE_JS = `
function openModal(btn,id){
  var t=document.getElementById('tpl-'+id);
  if(!t)return;
  document.getElementById('modal-title').textContent=btn.dataset.title||'';
  document.getElementById('modal-body').innerHTML=t.innerHTML;
  var m=document.getElementById('modal');m.hidden=false;
  m.onclick=function(e){if(e.target===m)closeModal()};
}
function closeModal(){document.getElementById('modal').hidden=true;
  document.getElementById('modal-body').innerHTML='';}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeModal()});
`

/* ------------------------------------------------------------------ */
/* 2. PDF（打印）—— 只有导图 + 流程图，纯白                              */
/* ------------------------------------------------------------------ */

/**
 * 导出 PDF（走浏览器打印）
 *
 * 只印两样东西：画布上那张导图（节点、树边、汇聚连线，和屏幕上一致），
 * 以及每个折角的流程图 —— 图放在它所属节点那条分支的正下方。
 * 页眉、页码、序号、「已打开 N 次」、「无流程图」占位、折角角标，一律不印。
 *
 * 关于「为什么是打开一个预览页，而不是直接下载 .pdf」：
 * 浏览器没有给网页「生成一个 PDF 文件」的接口，`window.print()` 是唯一的出口 ——
 * PDF 文件是在打印对话框里由用户选「另存为 PDF」产生的。不引入 jsPDF 之类
 * 是因为那要把整张图（含中文）先画进 canvas 再转图片：文字失去可选可搜索，
 * 体积膨胀几十倍，中文还得整包嵌字体。所以这里开一个只读的打印视图，
 * 由用户在视图里自己触发打印（右上角一颗只有图标的按钮）。**不再自动弹打印
 * 对话框** —— 一打开就抢焦点、盖住页面，用户根本没机会先看一眼印出来是什么样。
 *
 * PRD 要求「强制纯白主题，无论当前什么主题」。注意这不只是页面 CSS 的事：
 * mermaid 的 SVG 是**用当前主题渲染出来的**，夜间主题下会得到深色背景、
 * 浅色文字的图，贴到白底 PDF 上直接糊成一片。所以渲染前必须切到 white，
 * 渲染完再切回来，避免影响界面。
 */
export async function exportPdf(doc, { currentTheme = 'white' } = {}) {
  const folds = collectFolds(doc.root).filter((f) => f.node.fold?.mermaid)
  const charts = []

  applyTheme('white')
  try {
    for (const f of folds) {
      const r = await renderMermaid(f.node.fold.mermaid)
      // 渲染失败的折角直接跳过：宁可少一张图，也不要在导图上留一个空框
      if (r.ok && r.svg) charts.push({ id: f.node.id, svg: r.svg })
    }
  } finally {
    // 无论成功失败都要还原，否则界面上的图会一直停在白色主题
    applyTheme(currentTheme)
  }

  const layout = printLayout(doc.root, { relations: doc.relations || [], charts })
  // 显式关掉自动打印，理由见上面的注释
  const built = buildPrintHtml({ name: doc.name, layout, autoPrint: false })

  const w = window.open('', '_blank')
  if (!w) {
    /*
     * 新窗口开不出来 —— 两条路都会走到这里：
     *   · 浏览器弹窗拦截；
     *   · **桌面壳**：Tauri 的 lib.rs 没配 `on_new_window`，而 wry 的 WebView2
     *     后端在「没有 handler」时执行 `args.SetHandled(true)`（不建窗口），
     *     于是 `window.open` 返回 null。实测（CDP 连 WebView2）就是这条路。
     * 退化为下载文件，用户手动打开也能打印。把**文件名**一并返回给界面：
     * 光说「已改为下载文件」，用户还得自己去下载目录里找是哪一个。
     */
    const file = `${safeName(doc.name)}-导图.html`
    download(file, built.html, 'text/html;charset=utf-8')
    return { blocked: true, file, count: built.chartCount, pages: built.pageCount }
  }
  w.document.write(built.html)
  w.document.close()
  return { blocked: false, count: built.chartCount, pages: built.pageCount }
}

/* ------------------------------------------------------------------ */
/* 3. 导出格式清单 + 统一入口                                            */
/* ------------------------------------------------------------------ */

/**
 * 「导出」面板里列的就是这张表 —— 界面和实现共用一份，不各写一份。
 *
 * `native` 说明这个格式在原生壳里缺什么能力，用来生成那句「应用内不能…」：
 *   file  = 要落一个文件（安卓 WebView 没有下载通道）
 *   print = 要弹打印对话框（安卓 WebView 没有打印接口）
 *
 * 【为什么 Markdown 和 PDF 明明早就有按钮，还要列进来】
 * 这个面板是「导出到哪儿去」的**唯一**入口说明；少列两个反而会让人以为
 * 「Markdown 从这里导不出来」。入口多一个不碍事（原来那两颗按钮一个没动）。
 */
export const DOC_EXPORT_FORMATS = [
  { key: 'md', label: 'Markdown', ext: 'md', native: 'file', hint: '通用纯文本大纲，能再原样导入' },
  { key: 'html', label: '离线 HTML', ext: 'html', native: 'file', hint: '单个文件，断网双击可看，也能再导入' },
  { key: 'opml', label: 'OPML', ext: 'opml', native: 'file', hint: '幕布 / XMind / OmniOutliner 等大纲工具通用' },
  { key: 'mm', label: 'FreeMind 脑图', ext: 'mm', native: 'file', hint: 'FreeMind / Freeplane / XMind 直接打开' },
  { key: 'json', label: '单文档 JSON', ext: 'json', native: 'file', hint: '最完整：折角次数与连线都在，可原样导入' },
  { key: 'pdf', label: 'PDF 打印视图', ext: 'pdf', native: 'print', hint: '导图 + 流程图，强制纯白背景' },
]

export const exportFormatOf = (key) => DOC_EXPORT_FORMATS.find((f) => f.key === key) || null

/**
 * 按格式导出当前文档。
 *
 * 统一返回 `{ok, file?, message, kind?}`：提示条文案就是这里的 message，
 * 所以「说了什么」和「做了什么」不会分家（这类不一致是导出功能最常见的体感 bug：
 * 说导出了 Markdown，实际落下来的是 HTML）。
 */
export async function exportDocAs(key, doc, { theme = 'white' } = {}) {
  const meta = exportFormatOf(key)
  if (!meta || !doc) return { ok: false, message: '不认识的导出格式', kind: 'error' }
  const base = safeName(doc.name)

  if (key === 'html') {
    const r = await exportOfflineHtml(doc, { theme })
    return { ok: true, file: r.file, message: `已导出离线 HTML · 含 ${r.folds} 个折角` }
  }

  if (key === 'pdf') {
    const r = await exportPdf(doc, { currentTheme: theme })
    if (r.blocked) {
      return {
        ok: true, file: r.file, kind: 'error',
        message: `没能打开新窗口，已改为下载「${r.file}」· 打开后按 Ctrl+P 或点右上角按钮存成 PDF`,
      }
    }
    return { ok: true, message: `已打开打印视图 · 导图 + ${r.count} 张流程图 · ${r.pages} 页 · 点右上角的打印按钮存成 PDF` }
  }

  if (key === 'md') {
    const file = `${base}.md`
    download(file, toMarkdown(doc.root), 'text/markdown;charset=utf-8')
    return { ok: true, file, message: '已导出 Markdown 源文件' }
  }

  if (key === 'opml') {
    const file = `${base}.opml`
    download(file, toOpml(doc.root, { name: doc.name }), 'text/xml;charset=utf-8')
    return { ok: true, file, message: '已导出 OPML（折角里的流程图放在备注里 · 复习次数不随 OPML 走）' }
  }

  if (key === 'mm') {
    const file = `${base}.mm`
    download(file, toFreeMind(doc.root, { name: doc.name }), 'text/xml;charset=utf-8')
    return { ok: true, file, message: '已导出 FreeMind 脑图（.mm）' }
  }

  // json：最完整的那一份，保留折角次数与汇聚连线
  const file = `${base}.json`
  download(file, JSON.stringify(docToJson(doc), null, 2), 'application/json')
  return { ok: true, file, message: '已导出单文档 JSON（含折角次数与连线，可原样导入）' }
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}
const escAttr = esc
const safeName = (s) => String(s || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)

export function download(filename, content, mime = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 导出整库备份（对应 store.exportAll） */
export function exportBackup(payload) {
  download(`mindfold-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2), 'application/json')
}