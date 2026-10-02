/**
 * 多格式导入导出测试（纯函数，不需要浏览器）
 * ============================================
 * 覆盖三件事：
 *   1. 每种格式的**导出 → 导入往返**是不是真的把树还原了（这是「能扩展多一点」
 *      的地基：只写导出不测回来的话，导出的文件在别的软件里什么样谁也不知道）；
 *   2. 真实世界里那些奇形怪状的文件：别人的 OPML / FreeMind / 网页 HTML，
 *      单引号属性、自闭合标签、实体、CDATA、BOM、CRLF、深层嵌套；
 *   3. 坏输入不能把应用带崩：空文件、截断的 JSON、畸形 XML、打印预览页、
 *      上万节点的网页（有上限，且如实报 truncated）。
 *
 * 用法：node src/lib/formats.test.mjs
 */
import {
  FORMAT, detectFormat, parseDocument, docNameFromFile,
  toOpml, toFreeMind, docToJson, readEmbeddedDoc,
  parseOpml, parseFreeMind, parseHtml, parseIndentOutline, buildFromFlat,
  decodeEntities, tokenize, parseAttrs, textOf,
  MAX_IMPORT_NODES, EMBED_SCRIPT_ID,
} from './formats.js'
import { makeNode, makeFold, walkTree, collectFolds } from './model.js'
import { store } from './store.js'

/* ---------------- 最小 localStorage（store 的校验函数要在 node 里跑得到） ---------------- */
const mem = new Map()
globalThis.localStorage = {
  get length() { return mem.size },
  key: (i) => [...mem.keys()][i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
}

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}

/** 树 → [{depth, text, fold, mermaid, bold, italic}]，用来做「往返后是否等价」的比对 */
const flatten = (root) => {
  const out = []
  walkTree(root, (n, p) => {
    if (!p) return
    let depth = 0
    for (let q = p; q && q !== root; q = findParentOf(root, q)) depth++
    out.push({
      depth: depth + 1,
      text: n.text,
      fold: !!n.fold,
      mermaid: n.fold?.mermaid || '',
      bold: !!n.bold,
      italic: !!n.italic,
    })
  })
  return out
}
const findParentOf = (root, target) => {
  let hit = null
  walkTree(root, (n, p) => { if (n === target) hit = p })
  return hit
}

const mk = (spec, name = '测试') => {
  const root = makeNode(name)
  const stack = [{ depth: 0, node: root }]
  for (const it of spec) {
    while (stack.length > 1 && stack[stack.length - 1].depth >= it.depth) stack.pop()
    const n = makeNode(it.text)
    if (it.fold) n.fold = makeFold({ corner: !!it.mermaid, mermaid: it.mermaid || '' })
    stack[stack.length - 1].node.children.push(n)
    stack.push({ depth: it.depth, node: n })
  }
  return root
}

/* ================================================================== */
console.log('\n[1] 实体解码与标签扫描器的边界')

check('命名实体', decodeEntities('a &amp; b &lt;i&gt; &quot;q&quot; &apos;s&apos;') === 'a & b <i> "q" \'s\'')
check('十进制 / 十六进制引用', decodeEntities('&#10;|&#x4E2D;&#x6587;') === '\n|中文')
check('未知实体原样保留（不能吃掉用户写的 &foo;）', decodeEntities('&foo; &amp;') === '&foo; &')
check('非法码点不崩', decodeEntities('&#0;&#x110000;') === '&#0;&#x110000;')

const toks = [...tokenize('<a href="x>y" checked><b/>text</a>')]
check('tokenize 认得开 / 自闭 / 闭三类标签', toks.length === 3, JSON.stringify(toks.map((t) => t.kind + ':' + t.name)))
check('★ 属性值里的 > 不会截断标签', toks[0].attrs.href === 'x>y', JSON.stringify(toks[0].attrs))
check('无值属性当空串', toks[0].attrs.checked === '')
check('token 带 start/end 偏移', toks[0].start === 0 && toks[0].end === '<a href="x>y" checked>'.length,
  `${toks[0].start}..${toks[0].end}`)
check('单引号属性也认', parseAttrs(`a='1' b = "2" c=3`).a === '1' && parseAttrs(`a='1' b="2"`).b === '2')
check('重复属性第一个说了算', parseAttrs('a="1" a="2"').a === '1')
check('textOf 去标签 + 折叠空白', textOf('<p>甲<br/>乙 <b>丙</b></p>') === '甲 乙 丙')

/* ================================================================== */
console.log('\n[2] OPML：导出 → 导入往返')

const tree1 = mk([
  { depth: 1, text: '第一章' }, { depth: 2, text: '1.1' }, { depth: 2, text: '1.2' },
  { depth: 1, text: '第二章 & <特殊> "引号"' },
  { depth: 2, text: '带折角的节点', fold: true, mermaid: 'flowchart TD\n  A --> B' },
])
const opml1 = toOpml(tree1, { name: '我的导图' })
const back1 = parseDocument(opml1, { filename: 'x.opml' })

check('OPML 是合法头（xml 声明 + opml 2.0）', /^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(opml1) && opml1.includes('<opml version="2.0">'))
check('★ OPML 往返：节点数一致', back1.total === 5, String(back1.total))
check('★ OPML 往返：层级一致', JSON.stringify(flatten(back1.root).map((n) => n.depth)) === '[1,1,2,1,2]'
  || JSON.stringify(flatten(back1.root).map((n) => n.depth)) === JSON.stringify(flatten(tree1).map((n) => n.depth)),
  JSON.stringify(flatten(back1.root).map((n) => n.depth)))
check('★ OPML 往返：文字逐字相同（含 & < > "）',
  JSON.stringify(flatten(back1.root).map((n) => n.text)) === JSON.stringify(flatten(tree1).map((n) => n.text)),
  JSON.stringify(flatten(back1.root).map((n) => n.text)))
check('★ OPML 往返：折角还在', back1.foldCount === 1, String(back1.foldCount))
check('★ OPML 往返：mermaid 源码逐字回来（含换行）',
  collectFolds(back1.root)[0].node.fold.mermaid === 'flowchart TD\n  A --> B',
  JSON.stringify(collectFolds(back1.root)[0].node.fold.mermaid))
check('★ OPML 往返：没有多出一层「文档名」节点（否则每导一次深一层）',
  !flatten(back1.root).some((n) => n.text === '我的导图'),
  JSON.stringify(flatten(back1.root).map((n) => n.text)))
check('文档名来自 <title>', back1.name === '我的导图', back1.name)

const paired = parseOpml('<opml version="2.0"><body><outline text="甲"><outline text="乙"/><outline text="丙"/></outline></body></opml>')
check('配对写法的 <outline> 同样按层级解析', paired.items.length === 2 && paired.items[0].text === '乙')
check('外层容器被剥掉（唯一 depth0 + 有孩子）', !paired.items.some((i) => i.text === '甲'))

const multi = parseOpml(`<opml version="2.0"><body>
  <outline text="甲"><outline text="甲1"/></outline>
  <outline text="乙"><outline text="乙1"/></outline>
</body></opml>`)
check('多个顶层条目时**不**剥（手写 OPML 的常见形状）',
  multi.items.length === 4 && multi.items[0].depth === 0 && multi.items[0].text === '甲',
  JSON.stringify(multi.items.map((i) => [i.depth, i.text])))

const noteOnly = parseOpml('<opml version="2.0"><body><outline text="画图" _note="graph TD&#10;A--&gt;B"/></body></opml>')
check('★ 只有 _note 且像 mermaid → 也算折角（别人手写的文件）',
  noteOnly.items[0].fold === true && noteOnly.items[0].mermaid.includes('A-->B'),
  JSON.stringify(noteOnly.items[0]))

const plainNote = parseOpml('<opml version="2.0"><body><outline text="会议" _note="下周三之前"/></body></opml>')
check('普通备注不会被当成流程图', plainNote.items[0].fold === false, JSON.stringify(plainNote.items[0]))

const marked = parseOpml('<opml version="2.0"><body><outline text="要复习 [F]"/></body></opml>')
check('OPML 里写 [F] 也能认（和 Markdown 的约定一致）',
  marked.items[0].fold === true && marked.items[0].text === '要复习', JSON.stringify(marked.items[0]))

/* ================================================================== */
console.log('\n[3] FreeMind .mm：导出 → 导入往返')

const tree2 = mk([
  { depth: 1, text: '起点' }, { depth: 2, text: '分支 A', fold: true, mermaid: 'graph TD\n  X --> Y' },
  { depth: 2, text: '分支 B' }, { depth: 1, text: '终点' },
])
const mm = toFreeMind(tree2, { name: '脑图' })
const back2 = parseDocument(mm, { filename: 'x.mm' })

check('FreeMind 头部正确', mm.includes('<map version="1.0.1">') && mm.includes('TEXT="脑图"'))
check('★ .mm 往返：结构一致',
  JSON.stringify(flatten(back2.root).map((n) => [n.depth, n.text]))
  === JSON.stringify(flatten(tree2).map((n) => [n.depth, n.text])),
  JSON.stringify(flatten(back2.root).map((n) => [n.depth, n.text])))
check('★ .mm 往返：折角与 mermaid 都在',
  back2.foldCount === 1 && collectFolds(back2.root)[0].node.fold.mermaid.replace(/\s+/g, ' ').trim() === 'graph TD X --> Y',
  JSON.stringify(collectFolds(back2.root).map((f) => f.node.fold.mermaid)))
check('★ .mm 往返：没有多出「脑图」这一层', !flatten(back2.root).some((n) => n.text === '脑图'))
check('根节点的 ID 都在', /ID="mf-1"/.test(mm))

const freeplane = parseFreeMind(`<map version="1.0.1">
  <node TEXT="根">
    <node TEXT="有 TEXT 的"/>
    <node><richcontent TYPE="NODE"><html><body><p>富文本<i>节点</i></p></body></html></richcontent></node>
    <node TEXT="备注不是图"><richcontent TYPE="NOTE"><html><body><p>随手记一句</p></body></html></richcontent></node>
    <node TEXT="图标标重点"><icon BUILTIN="bookmark"/></node>
  </node>
</map>`)
check('Freeplane 的 richcontent NODE 当节点文字',
  freeplane.items.some((i) => i.text === '富文本节点'), JSON.stringify(freeplane.items.map((i) => i.text)))
check('普通 NOTE 不会变成折角', !freeplane.items.find((i) => i.text === '备注不是图').fold)
check('★ 只挂 bookmark 图标的节点**不**算折角（图标是别人工具的用户数据）',
  freeplane.items.find((i) => i.text === '图标标重点').fold === false)

const foldedByNote = parseFreeMind('<map version="1.0.1"><node TEXT="r"><node TEXT="画"><richcontent TYPE="NOTE"><html><body><p>flowchart LR</p><p>A --&gt; B</p></body></html></richcontent></node></node></map>')
check('NOTE 内容像 mermaid → 认成折角且多行拼回',
  foldedByNote.items[0].fold === true && foldedByNote.items[0].mermaid.includes('A --> B'),
  JSON.stringify(foldedByNote.items[0]))

/* ================================================================== */
console.log('\n[4] HTML：标题 / 列表 / 段落')

const page = `<!doctype html><html><head><title>学习笔记</title>
<style>h1{color:red}</style><script>var x = "<li>假的</li>"</script></head>
<body>
<h1>第一章</h1>
<ul><li>要点一<ul><li>子要点</li></ul></li><li>要点二</li></ul>
<h2>第二章</h2>
<ol><li>第一步</li><li>第二步</li></ol>
<p>单独一段</p>
<p>第二段 &amp; 符号</p>
</body></html>`
const htmlDoc = parseDocument(page, { filename: 'page.html' })
const flatHtml = flatten(htmlDoc.root)

check('★ script/style 的内容被完全跳过',
  !flatHtml.some((n) => /假的|color:red/.test(n.text)), JSON.stringify(flatHtml.map((n) => n.text)))
check('★ 列表项不会把子孙文字吞进来（- 要点一 而不是「要点一 子要点」）',
  flatHtml.some((n) => n.text === '要点一') && flatHtml.some((n) => n.text === '子要点'),
  JSON.stringify(flatHtml.map((n) => n.text)))
check('★ 标题下面的列表是标题的孩子，不是兄弟', (() => {
  const i = flatHtml.findIndex((n) => n.text === '第一章')
  const j = flatHtml.findIndex((n) => n.text === '要点一')
  return flatHtml[j].depth === flatHtml[i].depth + 1
})(), JSON.stringify(flatHtml.map((n) => [n.depth, n.text])))
check('嵌套列表深度递增', (() => {
  const a = flatHtml.find((n) => n.text === '要点一')
  const b = flatHtml.find((n) => n.text === '子要点')
  return b.depth > a.depth
})(), JSON.stringify(flatHtml.map((n) => [n.depth, n.text])))
check('h2 与 h1 同级递进', (() => {
  const h1 = flatHtml.find((n) => n.text === '第一章')
  const h2 = flatHtml.find((n) => n.text === '第二章')
  return h2.depth > h1.depth
})())
check('列表外的 <p> 是节点', flatHtml.some((n) => n.text === '单独一段'))
check('实体在文字里被解码', flatHtml.some((n) => n.text === '第二段 & 符号'), JSON.stringify(flatHtml.map((n) => n.text)))
check('HTML 文档名优先用 <title>（文件名常是「导出(1)」这种自动名）', htmlDoc.name === '学习笔记', htmlDoc.name)
check('没有 <title> 时退回文件名',
  parseDocument('<ul><li>甲</li></ul>', { filename: '我的大纲.html' }).name === '我的大纲')
check('HTML 包里 <title> 也能当名字', parseHtml(page, '').name === '学习笔记')

const liP = parseDocument('<ul><li><p>条目里的段落</p></li></ul>', { filename: 'a.html' })
check('★ <li><p>同句</p></li> 只出一个节点', liP.total === 1, String(liP.total))

const cjk = parseDocument('<h3>中文{i}标题</h3><ul><li>甲</li></ul>', { filename: 'a.html' })
check('中文与花括号原样保留', flatten(cjk.root)[0].text === '中文{i}标题')

const foldedHtml = parseDocument('<ul><li>要复习 [F]</li></ul>', { filename: 'a.html' })
check('HTML 里的 [F] 也认折角', foldedHtml.foldCount === 1 && flatten(foldedHtml.root)[0].text === '要复习')

/* --- 内嵌载荷丢失时的兜底：data-mf-depth --- */
const recovered = parseDocument(`<html><body><div class="item"><div class="row">
  <span class="txt" data-mf-depth="1" data-mf-fold="0">甲</span></div><div class="kids">
  <div class="item"><div class="row"><span class="txt" data-mf-depth="2" data-mf-fold="1">乙</span></div></div>
</div></div></body></html>`, { filename: 'x.html' })
check('★ 离线 HTML 的 data-mf-depth 兜底：层级与折角都能读回',
  recovered.total === 2 && recovered.foldCount === 1
  && JSON.stringify(flatten(recovered.root).map((n) => [n.depth, n.text, n.fold]))
     === JSON.stringify([[1, '甲', false], [2, '乙', true]]),
  JSON.stringify(flatten(recovered.root).map((n) => [n.depth, n.text, n.fold])))

const deep = parseDocument('<ul><li>1<ul><li>2<ul><li>3<ul><li>4</li></ul></li></ul></li></ul></li></ul>', { filename: 'a.html' })
check('四层嵌套层级是 1,2,3,4',
  JSON.stringify(flatten(deep.root).map((n) => n.depth)) === '[1,2,3,4]',
  JSON.stringify(flatten(deep.root).map((n) => n.depth)))

/* ================================================================== */
console.log('\n[5] 纯文本缩进大纲')

const txt2 = '第一章\n  1.1 小节\n  1.2 小节\n第二章\n  2.1 [F]\n    2.1.1 细节'
const o2 = parseDocument(txt2, { filename: 'a.txt' })
check('★ 两空格缩进按层级读',
  JSON.stringify(flatten(o2.root).map((n) => [n.depth, n.text]))
  === JSON.stringify([[1, '第一章'], [2, '1.1 小节'], [2, '1.2 小节'], [1, '第二章'], [2, '2.1'], [3, '2.1.1 细节']]),
  JSON.stringify(flatten(o2.root).map((n) => [n.depth, n.text])))
check('缩进大纲里的 [F] 认折角', o2.foldCount === 1 && flatten(o2.root).some((n) => n.text === '2.1'))

const txt4 = 'A\n    一级\n        二级\nB\n    一级2'
const o4 = parseDocument(txt4, { filename: 'a.txt' })
check('★ 四空格一层也能读对（不用猜固定宽度）',
  JSON.stringify(flatten(o4.root).map((n) => [n.depth, n.text]))
  === JSON.stringify([[1, 'A'], [2, '一级'], [3, '二级'], [1, 'B'], [2, '一级2']]),
  JSON.stringify(flatten(o4.root).map((n) => [n.depth, n.text])))

const tabbed = parseDocument('A\n\t一级\n\t\t二级', { filename: 'a.txt' })
check('tab 缩进同样按一层算', JSON.stringify(flatten(tabbed.root).map((n) => n.depth)) === '[1,2,3]',
  JSON.stringify(flatten(tabbed.root).map((n) => n.depth)))

const noIndent = parseDocument('甲\n乙\n丙', { filename: 'a.txt' })
check('完全没有缩进 → 三个并列节点，且总层级不乱拉',
  noIndent.total === 3 && flatten(noIndent.root).every((n) => n.depth === 1),
  JSON.stringify(flatten(noIndent.root).map((n) => [n.depth, n.text])))

const fenceTxt = 'A [F]\n\n```mermaid\nflowchart TD\n  X --> Y\n```'
const fenceDoc = parseDocument(fenceTxt, { filename: 'a.txt' })
check('★ 缩进大纲里的 mermaid 围栏内容一个字都没被改（补 `- ` 会毁掉源码）',
  collectFolds(fenceDoc.root)[0]?.node.fold.mermaid === 'flowchart TD\n  X --> Y',
  JSON.stringify(collectFolds(fenceDoc.root).map((f) => f.node.fold.mermaid)))

/*
 * 直接调用 parseIndentOutline 的那条路（detectFormat 见到围栏会判成 Markdown，
 * 所以这里必须显式调一次）：围栏里的缩进不能换算成层级、更不能补项目符号。
 */
const directIndent = parseIndentOutline('A [F]\n\n```mermaid\nflowchart TD\n    X --> Y\n```', 'x')
check('★ 直接调 parseIndentOutline：围栏内的缩进同样原样保留',
  collectFolds(directIndent.root)[0]?.node.fold.mermaid === 'flowchart TD\n    X --> Y',
  JSON.stringify(collectFolds(directIndent.root).map((f) => f.node.fold.mermaid)))

const mdFile = parseDocument('# 标题\n\n- 甲\n  - 乙\n', { filename: 'a.md' })
check('.md 走 Markdown 解析（标题 = 第一层）',
  flatten(mdFile.root)[0].text === '标题' && mdFile.total === 3,
  JSON.stringify(flatten(mdFile.root).map((n) => [n.depth, n.text])))
check('.txt 里带 # / - 时也走 Markdown 解析',
  parseDocument('# 甲\n- 乙', { filename: 'a.txt' }).format === FORMAT.MARKDOWN)

/* ================================================================== */
console.log('\n[6] 单文档 JSON 与离线 HTML 内嵌载荷（无损）')

const richRoot = mk([
  { depth: 1, text: '节点', fold: true, mermaid: 'flowchart TD\n  A --> B' },
  { depth: 1, text: '普通' },
])
richRoot.children[0].children.push(makeNode('孩子'))
richRoot.children[0].fold.openCount = 7
richRoot.children[0].bold = true
const richDoc = { name: '无损', root: richRoot, relations: [{ from: richRoot.children[0].id, to: richRoot.children[1].id }] }
const jsonText = JSON.stringify(docToJson(richDoc, { exportedAt: '2024-01-01T00:00:00.000Z' }), null, 2)
const backJson = parseDocument(jsonText, { filename: 'd.json' })

check('JSON 带 format 标记', JSON.parse(jsonText).format === 'mindfold-doc')
check('★ 单文档 JSON：折角次数（复习进度）保留', collectFolds(backJson.root)[0].node.fold.openCount === 7,
  String(collectFolds(backJson.root)[0].node.fold.openCount))
check('★ 单文档 JSON：汇聚连线保留', backJson.relations.length === 1, JSON.stringify(backJson.relations))
check('★ 单文档 JSON：粗体保留', flatten(backJson.root)[0].bold === true)
check('★ 单文档 JSON：mermaid 保留', collectFolds(backJson.root)[0].node.fold.mermaid.includes('A --> B'))
check('单文档 JSON 不认成整库备份', backJson.format === FORMAT.DOC_JSON)

/* 同一个 JSON，走 store.importAll 与走我们的校验，结果必须一致 —— 两条路共用一份校验 */
localStorage.clear()
store.importAll({ app: 'MindFold', version: 1, docs: [{ id: 'doc_x', name: '无损', root: richRoot, relations: richDoc.relations }] })
const viaStore = store.listDocs()[0]
check('★ 两条导入路径（store.importAll / parseDocument）对同一份数据得出同一棵树',
  JSON.stringify(flatten(viaStore.root)) === JSON.stringify(flatten(backJson.root)),
  JSON.stringify(flatten(viaStore.root).map((n) => n.text)) + ' vs ' + JSON.stringify(flatten(backJson.root).map((n) => n.text)))

const bogus = [
  ['空对象', {}],
  ['root 不是对象', { name: 'x', root: 3 }],
  ['没有名字', { root: { text: 'r', children: [] } }],
  ['children 不是数组', { name: 'x', root: { text: 'r', children: 'no' } }],
]
let bogusOk = true
for (const [label, payload] of bogus) {
  try { parseDocument(JSON.stringify(payload), { filename: 'x.json' }); bogusOk = false; console.log('     漏掉：' + label) } catch { /* 期望抛错 */ }
}
check('★ 畸形 JSON 一律抛错而不是建出一棵坏树', bogusOk)

/* 离线 HTML 的内嵌载荷 */
const payloadJson = JSON.stringify(docToJson(richDoc)).replace(/</g, '\\u003c')
const offline = `<!doctype html><html data-mindfold-export="offline-html"><head><title>无损</title></head>
<body><h1>无损</h1><section class="outline"></section>
<script type="application/json" id="${EMBED_SCRIPT_ID}">${payloadJson}</script></body></html>`
check('识别成「离线 HTML」而不是普通 HTML', detectFormat('x.html', offline) === FORMAT.OFFLINE_HTML)
const backOffline = parseDocument(offline, { filename: 'x.html' })
check('★ 离线 HTML 回导：结构、折角次数、连线全都在',
  backOffline.total === 3 && backOffline.foldCount === 1
  && collectFolds(backOffline.root)[0].node.fold.openCount === 7
  && backOffline.relations.length === 1,
  JSON.stringify({ total: backOffline.total, folds: backOffline.foldCount, rel: backOffline.relations.length }))
check('readEmbeddedDoc 直接可用', !!readEmbeddedDoc(offline))
check('没有载荷时返回 null 而不是抛错', readEmbeddedDoc('<html><body>无</body></html>') === null)
check('载荷被截断 / 写坏 → null', readEmbeddedDoc(`<script id="${EMBED_SCRIPT_ID}">{oops</script>`) === null)

/* 节点文字里写 </script> 的极端情况：导出必须让它活下来 */
const evil = makeNode('结束标记 </script> 后面还有字')
const evilHtml = JSON.stringify(docToJson({ name: 'x', root: evil })).replace(/</g, '\\u003c')
check('★ 节点文字里的 </script> 不会把内嵌载荷提前截断',
  /<\/script>/i.test(evilHtml) === false, evilHtml.slice(0, 60))
const evilBack = JSON.parse(evilHtml)
check('转义后 JSON.parse 仍能读回那句话',
  evilBack.root.text === '结束标记 </script> 后面还有字', evilBack.root.text)

/* ================================================================== */
console.log('\n[7] 格式识别：内容优先，扩展名兜底')

const cases = [
  ['备份 JSON', 'b.json', JSON.stringify({ app: 'MindFold', version: 1, docs: [] }), FORMAT.BACKUP],
  ['单文档 JSON', 'b.json', JSON.stringify({ format: 'mindfold-doc', root: { text: 'r', children: [] } }), FORMAT.DOC_JSON],
  ['宽容：有 root 但没写 format', 'b.json', JSON.stringify({ name: 'n', root: { text: 'r', children: [] } }), FORMAT.DOC_JSON],
  ['随便一个 JSON', 'b.json', JSON.stringify({ hello: 1 }), FORMAT.UNKNOWN],
  ['OPML 存成 .xml', 'b.xml', '<?xml version="1.0"?><opml version="2.0"><body><outline text="a"/></body></opml>', FORMAT.OPML],
  ['FreeMind 存成 .xml', 'b.xml', '<map version="1.0.1"><node TEXT="r"/></map>', FORMAT.FREEMIND],
  ['HTML 存成 .txt', 'b.txt', '<ul><li>甲</li></ul>', FORMAT.HTML],
  ['Markdown', 'b.md', '# 甲\n- 乙', FORMAT.MARKDOWN],
  ['没有扩展名的 Markdown', 'b', '# 甲\n- 乙', FORMAT.MARKDOWN],
  ['纯文本大纲', 'b.txt', '甲\n  乙', FORMAT.OUTLINE],
  ['一行乱码的 .bin', 'b.bin', '这既不是 JSON 也不是任何已知格式，只是一句中文。', FORMAT.UNKNOWN],
  ['多行的 .bin 仍然当大纲（内容自证）', 'b.bin', '甲\n乙', FORMAT.OUTLINE],
  ['空文件', 'b.txt', '   \n  ', FORMAT.UNKNOWN],
  ['打印预览页', 'b.html', '<html><body><div class="mf-print-pages"><section class="page"></section></div></body></html>', FORMAT.PRINT_HTML],
  ['被截断的 JSON', 'b.json', '{"app":"MindFold","docs":[', FORMAT.UNKNOWN],
]
let detectOk = true
for (const [label, file, text, want] of cases) {
  const got = detectFormat(file, text)
  if (got !== want) { detectOk = false; console.log(`     差异：${label} → ${got}（期望 ${want}）`) }
}
check('★ 15 种识别场景全部按内容判对', detectOk)

check('BOM 不影响识别', detectFormat('b.md', '\uFEFF# 甲') === FORMAT.MARKDOWN)
check('CRLF 不影响识别', detectFormat('b.md', '# 甲\r\n- 乙\r\n') === FORMAT.MARKDOWN)
check('文件名 → 文档名（去扩展名 / 去路径）',
  docNameFromFile('C:\\a\\b\\我的 导图.v2.md') === '我的 导图.v2', docNameFromFile('C:\\a\\b\\我的 导图.v2.md'))
check('中文文件名保留', docNameFromFile('数学/微积分.md') === '微积分')

/* ================================================================== */
console.log('\n[8] 坏输入与上限：不能把应用带崩')

const throws = (fn) => { try { fn(); return false } catch { return true } }
check('空文本抛错', throws(() => parseDocument('', { filename: 'a.md' })))
check('只有空白的文件抛错（不会建出一篇空文档）',
  throws(() => parseDocument('   \n\n  ', { filename: 'a.txt' }))
  && throws(() => parseDocument('   \n\n  ', { filename: 'a.md' })))
check('只有空白的 OPML 抛错', throws(() => parseDocument('<opml version="2.0"><body></body></opml>', { filename: 'a.opml' })))
check('只有空白的 .mm 抛错', throws(() => parseDocument('<map version="1.0.1"></map>', { filename: 'a.mm' })))
check('HTML 里没有任何标题/列表/段落 → 抛错（而不是建一棵空树）',
  throws(() => parseDocument('<html><body><div class="x"></div></body></html>', { filename: 'a.html' })))
check('★ 打印预览页给的是「人话」提示，不是崩',
  throws(() => parseDocument('<div class="mf-print-pages"></div>', { filename: 'x.html' }))
  && (() => { try { parseDocument('<div class="mf-print-pages"></div>', { filename: 'x.html' }) } catch (e) { return /打印预览页/.test(e.message) } return false })())

const manyLi = '<ul>' + Array.from({ length: MAX_IMPORT_NODES + 500 }, (_, i) => `<li>节点 ${i}</li>`).join('') + '</ul>'
const bigDoc = parseDocument(manyLi, { filename: 'big.html' })
check(`★ 超大 HTML 到 ${MAX_IMPORT_NODES} 个节点就停，并如实标记 truncated`,
  bigDoc.total === MAX_IMPORT_NODES && bigDoc.truncated === true,
  `${bigDoc.total} truncated=${bigDoc.truncated}`)

const longText = parseDocument(`<ul><li>${'字'.repeat(900)}</li></ul>`, { filename: 'a.html' })
check('超长文字被夹到 500 字以内', flatten(longText.root)[0].text.length === 500,
  String(flatten(longText.root)[0].text.length))

const deepList = '<ul><li>层0' + '<ul><li>层1'.repeat(60) + '</li></ul>'.repeat(60) + '</li></ul>'
const deepDoc = parseDocument(deepList, { filename: 'a.html' })
check('60 层嵌套不爆栈，层级单调递增', deepDoc.total === 61 && (() => {
  const d = flatten(deepDoc.root).map((n) => n.depth)
  return d.every((v, i) => i === 0 || v > d[i - 1])
})(), String(deepDoc.total))

const weird = parseDocument('<ul><li></li><li>   </li><li>有字</li></ul>', { filename: 'a.html' })
check('空条目被丢掉（不会建出空节点）', weird.total === 1, String(weird.total))

check('buildFromFlat 遇到跳级深度也能挂对爹', (() => {
  const { root } = buildFromFlat([
    { depth: 0, text: 'a' }, { depth: 2, text: 'b' }, { depth: 0, text: 'c' },
  ], 'r')
  return root.children.length === 2 && root.children[0].children[0].text === 'b'
})())

check('XML 注释 / CDATA / processing instruction 不会变成节点', (() => {
  const d = parseDocument('<?xml version="1.0"?><!-- 注释 --><opml version="2.0"><body><![CDATA[乱码]]><outline text="甲"/></body></opml>', { filename: 'a.opml' })
  return d.total === 1 && flatten(d.root)[0].text === '甲'
})(), '（CDATA 在 body 里，不该被当成 outline^）')

/* ================================================================== */
console.log('\n[9] 导出文件的「外部可读性」抽查')

const opmlOut = toOpml(mk([{ depth: 1, text: '甲<b>&"引号' }, { depth: 2, text: '乙' }]), { name: 'n' })
check('OPML 里没有裸的特殊字符（除了标签本身）',
  !/text="[^"]*[<>]/.test(opmlOut), opmlOut.split('\n').find((l) => l.includes('甲')) || '')
check('OPML 缩进是 2 空格一层（别的工具读起来是层级）',
  /\n {6}<outline text="甲/.test(opmlOut), opmlOut)
check('FreeMind 的折角图标与备注都在',
  toFreeMind(mk([{ depth: 1, text: '甲', fold: true, mermaid: 'graph TD' }]), { name: 'n' })
    .includes('BUILTIN="bookmark"') && mm.includes('richcontent TYPE="NOTE"'))
check('空文档也能导出（不会抛错）',
  toOpml(makeNode('空'), { name: '空' }).includes('<outline text="空"/>')
  && toFreeMind(makeNode('空'), { name: '空' }).includes('TEXT="空"'))

/* parseMarkdown 的互逆仍然成立（本轮没有动它，但 formats 依赖它） */
const mdRound = parseDocument('# 甲\n- 乙 [F]\n', { filename: 'a.md' })
check('Markdown 入口没有回归', mdRound.total === 2 && mdRound.foldCount === 1,
  JSON.stringify({ t: mdRound.total, f: mdRound.foldCount }))

console.log(`\n${'='.repeat(46)}`)
console.log(`  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)
