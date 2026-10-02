/**
 * 主画布撤销/重做历史栈 纯函数测试
 * ==================================
 * 重点：
 *   · 栈语义：入栈的是「变更前」的状态；undo/redo 严格互逆
 *   · 上限 30，超出丢最旧的
 *   · 无实质变化不入栈，且**不清空 future**
 *   · sameCanvasTree 忽略折角内容与 openCount（否则「点开折角」会占一格历史）
 *   · ★ mergeFoldContent：画布撤销绝不能冲掉弹窗里写的流程图
 *   · 快照进栈后与外界隔离（调用方继续改树不影响它）
 *   · 全纯函数，入参不被改动
 */
import {
  CANVAS_HISTORY_LIMIT, emptyCanvasHistory, sameCanvasTree, recordCanvasSnapshot,
  undoCanvas, redoCanvas, canCanvasUndo, canCanvasRedo, mergeFoldContent,
} from './canvasHistory.js'
import { makeNode, makeFold } from './model.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** 造一棵小树：根 + n 个子节点（id 固定，便于断言） */
function tree(texts = ['根', 'A', 'B']) {
  const root = makeNode(texts[0])
  root.id = 'r'
  for (let i = 1; i < texts.length; i++) {
    const n = makeNode(texts[i])
    n.id = `c${i}`
    root.children.push(n)
  }
  return root
}

/** 深拷贝并改名（模拟一次「变更」） */
const rename = (root, id, text) => {
  const clone = JSON.parse(JSON.stringify(root))
  const walk = (n) => { if (n.id === id) n.text = text; n.children.forEach(walk) }
  walk(clone)
  return clone
}
const textsOf = (root) => {
  const out = []
  const walk = (n) => { out.push(n.text); n.children.forEach(walk) }
  walk(root)
  return out
}

/* ================================================================== */
console.log('\n[1] 栈语义')
/* ================================================================== */

check('空历史不能撤销也不能重做',
  !canCanvasUndo(emptyCanvasHistory()) && !canCanvasRedo(emptyCanvasHistory()))

const t0 = tree(['根', 'A'])
const t1 = rename(t0, 'c1', 'A2')

let h = recordCanvasSnapshot(emptyCanvasHistory(), t0, true)
check('记录一次后可以撤销', canCanvasUndo(h) && h.past.length === 1, JSON.stringify(h.past.length))
check('入栈的是**变更前**的那棵树', h.past[0].tree.children[0].text === 'A', h.past[0].tree.children[0].text)
check('记录后不能重做', !canCanvasRedo(h))

let u = undoCanvas(h, t1)
check('撤销返回变更前的树', u && u.tree.children[0].text === 'A', JSON.stringify(u?.children?.[0]?.text))
check('撤销后 future 里是刚离开的树', u.history.future.length === 1 && u.history.future[0].tree.children[0].text === 'A2')
check('撤销后 past 空', u.history.past.length === 0)
check('撤销后可以重做', canCanvasRedo(u.history))

let r = redoCanvas(u.history, u.tree)
check('重做回到 A2', r && r.tree.children[0].text === 'A2', JSON.stringify(r?.children?.[0]?.text))
check('重做后 future 空', r.history.future.length === 0)
check('重做后 past 恢复', r.history.past.length === 1)

check('没有可撤销时返回 null', undoCanvas(emptyCanvasHistory(), t0) === null)
check('没有可重做时返回 null', redoCanvas(emptyCanvasHistory(), t0) === null)

/* ================================================================== */
console.log('\n[2] 无实质变化不入栈，且不清空 future')
/* ================================================================== */

let h2 = recordCanvasSnapshot(emptyCanvasHistory(), t0, true)
const u2 = undoCanvas(h2, t1)          // 制造一个可重做的状态
check('前置：此时可以重做', canCanvasRedo(u2.history))

const noop = recordCanvasSnapshot(u2.history, t1, false)
check('changed=false 时原样返回（同一个对象引用）', noop === u2.history)
check('无变化操作不清空 future（重做链还在）', canCanvasRedo(noop) && noop.future.length === 1)

const noop2 = recordCanvasSnapshot(u2.history, null, true)
check('prevTree 为空时也不入栈', noop2 === u2.history)

// 真的变了 → 必须清空 future（新分支）
const real = recordCanvasSnapshot(u2.history, t1, true)
check('有实质变化时清空 future', real.future.length === 0 && real.past.length === 1)

/* ================================================================== */
console.log('\n[3] 上限')
/* ================================================================== */

let h3 = emptyCanvasHistory()
for (let i = 0; i < CANVAS_HISTORY_LIMIT + 12; i++) {
  h3 = recordCanvasSnapshot(h3, tree(['根', `v${i}`]), true)
}
check(`栈深被夹在 ${CANVAS_HISTORY_LIMIT}`, h3.past.length === CANVAS_HISTORY_LIMIT, String(h3.past.length))
check('丢的是**最旧**的（栈底是第 12 版）',
  h3.past[0].tree.children[0].text === 'v12', h3.past[0].tree.children[0].text)
check('栈顶是最新一版的前一版',
  h3.past[h3.past.length - 1].tree.children[0].text === `v${CANVAS_HISTORY_LIMIT + 11}`,
  h3.past[h3.past.length - 1].tree.children[0].text)

/* ================================================================== */
console.log('\n[4] sameCanvasTree：什么算「变了」')
/* ================================================================== */

check('同一棵树（同引用）→ 相同', sameCanvasTree(t0, t0))
check('内容相同的两棵树 → 相同', sameCanvasTree(t0, JSON.parse(JSON.stringify(t0))))
check('文字变了 → 不同', !sameCanvasTree(t0, rename(t0, 'c1', 'X')))
check('子节点顺序变了 → 不同', (() => {
  const a = tree(['根', 'A', 'B'])
  const b = tree(['根', 'A', 'B'])
  b.children.reverse()
  return !sameCanvasTree(a, b)
})())
check('子节点数量变了 → 不同', (() => {
  const a = tree(['根', 'A'])
  const b = tree(['根', 'A', 'B'])
  return !sameCanvasTree(a, b)
})())
check('collapsed 变了 → 不同', (() => {
  const a = tree(['根', 'A'])
  const b = JSON.parse(JSON.stringify(a))
  b.collapsed = true
  return !sameCanvasTree(a, b)
})())
check('bold 变了 → 不同', (() => {
  const a = tree(['根', 'A'])
  const b = JSON.parse(JSON.stringify(a))
  b.bold = true
  return !sameCanvasTree(a, b)
})())
check('italic 变了 → 不同', (() => {
  const a = tree(['根', 'A'])
  const b = JSON.parse(JSON.stringify(a))
  b.italic = true
  return !sameCanvasTree(a, b)
})())

// ★ 折角相关的忽略项
check('新增折角 → 不同', (() => {
  const a = tree(['根', 'A'])
  const b = JSON.parse(JSON.stringify(a))
  b.children[0].fold = makeFold({ corner: false })
  return !sameCanvasTree(a, b)
})())
check('★ 折角的 mermaid 内容变了 → **不算**变（那是弹窗的地盘）', (() => {
  const a = tree(['根', 'A'])
  a.children[0].fold = makeFold({ corner: true, mermaid: 'flowchart TD\n A' })
  const b = JSON.parse(JSON.stringify(a))
  b.children[0].fold.mermaid = 'flowchart TD\n A --> B'
  return sameCanvasTree(a, b)
})())
check('★ 折角的 outline 内容变了 → **不算**变', (() => {
  const a = tree(['根', 'A'])
  a.children[0].fold = makeFold({ corner: true, outline: 'x' })
  const b = JSON.parse(JSON.stringify(a))
  b.children[0].fold.outline = 'x\n  y'
  return sameCanvasTree(a, b)
})())
check('★ openCount 变了 → **不算**变（点开折角不该占一格历史）', (() => {
  const a = tree(['根', 'A'])
  a.children[0].fold = makeFold({ corner: true, openCount: 0 })
  const b = JSON.parse(JSON.stringify(a))
  b.children[0].fold.openCount = 7
  return sameCanvasTree(a, b)
})())
check('折角 corner 由 false 变 true → 算变（实心/空心折角是看得见的）', (() => {
  const a = tree(['根', 'A'])
  a.children[0].fold = makeFold({ corner: false })
  const b = JSON.parse(JSON.stringify(a))
  b.children[0].fold.corner = true
  return !sameCanvasTree(a, b)
})())
check('updatedAt 变了 → 不算变', (() => {
  const a = tree(['根', 'A'])
  a.children[0].fold = makeFold({ corner: true })
  const b = JSON.parse(JSON.stringify(a))
  b.children[0].fold.updatedAt = 999
  return sameCanvasTree(a, b)
})())
check('null / undefined 不崩', sameCanvasTree(null, null) === true && sameCanvasTree(null, t0) === false)

/* ================================================================== */
console.log('\n[5] ★ mergeFoldContent：画布撤销不能冲掉弹窗写的流程图')
/* ================================================================== */
/*
 * 这是「作用域严格隔离」最关键的一条。真实事故路径：
 *   拖一下节点 → 打开弹窗写流程图 → 关闭 → 画布按 Ctrl+Z
 * 若直接写回快照，流程图会被退回「拖拽之前」，用户刚写的东西凭空消失。
 */

// 场景：快照 = 拖拽前（折角内容为空）；当前 = 拖拽后 + 弹窗写了内容
const snapTree = tree(['根', 'A'])
snapTree.children[0].fold = makeFold({ corner: false, mermaid: '', outline: '' })
const liveTree = rename(snapTree, 'c1', 'A-拖过')
liveTree.children[0].fold.mermaid = 'flowchart TD\n  n0["弹窗里写的"]'
liveTree.children[0].fold.outline = '弹窗里写的'
liveTree.children[0].fold.corner = true
liveTree.children[0].fold.openCount = 3

const merged = mergeFoldContent(snapTree, liveTree)
check('结构听快照的（文字被撤销回 A）', merged.children[0].text === 'A', merged.children[0].text)
check('★ 折角内容听当前树的（流程图没被冲掉）',
  merged.children[0].fold.mermaid === 'flowchart TD\n  n0["弹窗里写的"]',
  JSON.stringify(merged.children[0].fold.mermaid))
check('★ outline 也没被冲掉', merged.children[0].fold.outline === '弹窗里写的')
check('熟悉度（openCount）保留当前值', merged.children[0].fold.openCount === 3,
  String(merged.children[0].fold.openCount))
check('corner 也保留当前值（实心折角没变回空心）', merged.children[0].fold.corner === true)

// 场景：撤销「取消折角」→ 快照里有折角（含内容），当前树里折角已被删掉
const withFold = tree(['根', 'A'])
withFold.children[0].fold = makeFold({ corner: true, mermaid: 'flowchart TD\n  n0["要还回来的"]', outline: '要还回来的' })
withFold.children[0].fold.openCount = 5
const foldRemoved = tree(['根', 'A'])      // 折角已被取消
const restored = mergeFoldContent(withFold, foldRemoved)
check('★ 撤销「取消折角」把折角连内容一起还回来',
  restored.children[0].fold?.mermaid === 'flowchart TD\n  n0["要还回来的"]',
  JSON.stringify(restored.children[0].fold))
check('还回来的 openCount 也来自快照', restored.children[0].fold.openCount === 5)

// 场景：撤销「打上折角」→ 快照里没有折角，当前树里有
const noFold = tree(['根', 'A'])
const foldAdded = tree(['根', 'A'])
foldAdded.children[0].fold = makeFold({ corner: true, mermaid: 'x' })
const backToNoFold = mergeFoldContent(noFold, foldAdded)
check('★ 撤销「打上折角」把折角去掉', backToNoFold.children[0].fold === null,
  JSON.stringify(backToNoFold.children[0].fold))

// 场景：撤销「删除节点」→ 快照里有那个节点及其折角，当前树里没有
const beforeDel = tree(['根', 'A', 'B'])
beforeDel.children[1].fold = makeFold({ corner: true, mermaid: 'flowchart TD\n  n0["B 的图"]' })
const afterDel = tree(['根', 'A'])
const backDel = mergeFoldContent(beforeDel, afterDel)
check('★ 撤销删除：节点回来了', backDel.children.length === 2, String(backDel.children.length))
check('★ 撤销删除：节点的折角内容也回来了',
  backDel.children[1].fold?.mermaid === 'flowchart TD\n  n0["B 的图"]',
  JSON.stringify(backDel.children[1].fold))

check('mergeFoldContent 不改动快照本身（否则重做就回不去了）',
  snapTree.children[0].fold.mermaid === '', JSON.stringify(snapTree.children[0].fold.mermaid))
check('mergeFoldContent 不改动当前树本身',
  liveTree.children[0].text === 'A-拖过', liveTree.children[0].text)
check('返回的是新对象（不是快照引用）', merged !== snapTree && merged.children[0] !== snapTree.children[0])

/* ================================================================== */
console.log('\n[6] 快照与外界隔离')
/* ================================================================== */

const src = tree(['根', 'A'])
let h6 = recordCanvasSnapshot(emptyCanvasHistory(), src, true)
// 调用方继续「原地」改这棵树
src.children[0].text = '被就地改了'
check('★ 快照不受调用方后续就地修改的影响',
  h6.past[0].tree.children[0].text === 'A', h6.past[0].tree.children[0].text)

// undo 压进 future 的那棵树也要隔离
const cur = tree(['根', 'CURRENT'])
const u6 = undoCanvas(h6, cur)
cur.children[0].text = '又改了'
check('★ future 里的当前树也被深拷贝隔离',
  u6.history.future[0].tree.children[0].text === 'CURRENT', u6.history.future[0].tree.children[0].text)

check('recordCanvasSnapshot 不修改传入的 history',
  (() => {
    const base = recordCanvasSnapshot(emptyCanvasHistory(), tree(['根']), true)
    const snapshotBefore = JSON.stringify(base.past)
    recordCanvasSnapshot(base, tree(['根', '新']), true)
    return JSON.stringify(base.past) === snapshotBefore
  })())

/* ================================================================== */
console.log('\n[7] 完整走一遍真实序列')
/* ================================================================== */

/*
 * 模拟：拖拽换位 → 改文字 → 打上折角 → 打开弹窗写流程图 → 取消折角
 * 然后一路撤销，检查每一步。
 *
 * 注意折角始终挂在 **c1** 上（按 id 找，不按 children 下标 ——
 * 中间换过位，下标会变，按下标写测试就是在测错节点）。
 */
const MODAL_CODE = 'flowchart TD\n  n0["弹窗写的"]'
const MODAL_OUT = '弹窗写的'

let live = tree(['根', 'A', 'B'])
let hist = emptyCanvasHistory()

const step = (next, changed = true) => {
  hist = recordCanvasSnapshot(hist, live, changed)
  live = next
}
/** 深拷贝 + 改某节点文字 */
const setText = (root, id, text) => {
  const t = JSON.parse(JSON.stringify(root))
  const walk = (n) => { if (n.id === id) n.text = text; n.children.forEach(walk) }
  walk(t)
  return t
}
/** 深拷贝 + 替换某节点的 fold */
const setFold = (root, id, fold) => {
  const t = JSON.parse(JSON.stringify(root))
  const walk = (n) => { if (n.id === id) n.fold = fold; n.children.forEach(walk) }
  walk(t)
  return t
}
const foldOf = (root, id) => {
  let found = null
  const walk = (n) => { if (n.id === id) found = n.fold; n.children.forEach(walk) }
  walk(root)
  return found
}

// 1. 拖拽换位：A、B 交换（子节点顺序反转）
step((() => { const t = JSON.parse(JSON.stringify(live)); t.children.reverse(); return t })())
// 2. 改文字：c1 改成「B改」
step(setText(live, 'c1', 'B改'))
// 3. 打上折角（给 c1）
step(setFold(live, 'c1', makeFold({ corner: false })))
// 4. 弹窗里写了流程图 —— **不记录历史**（弹窗的地盘）
live = setFold(live, 'c1', {
  corner: true, openCount: 1, mermaid: MODAL_CODE, outline: MODAL_OUT, updatedAt: 1,
})
// 5. 取消折角
step(setFold(live, 'c1', null))

check('撤了 4 步之后栈空', (() => {
  let n = 0
  let c = live
  let hh = hist
  while (true) {
    const x = undoCanvas(hh, c)
    if (!x) break
    hh = x.history; c = mergeFoldContent(x.tree, c); n++
  }
  return n === 4
})(), '应恰好 4 步（弹窗那次编辑不占历史格）')

// 逐步撤销，记录每一步的状态
let curT = live
let hh = hist
const seen = []
for (let i = 0; i < 4; i++) {
  const x = undoCanvas(hh, curT)
  hh = x.history
  curT = mergeFoldContent(x.tree, curT)
  seen.push({
    order: curT.children.map((c) => c.text).join(','),
    fold: !!foldOf(curT, 'c1'),
    mermaid: foldOf(curT, 'c1')?.mermaid ?? null,
    corner: foldOf(curT, 'c1')?.corner ?? null,
  })
}
console.log(`  · 撤销轨迹：${JSON.stringify(seen)}`)
check('第 1 步撤销：折角回来了（撤销「取消折角」）', seen[0].fold === true, JSON.stringify(seen[0]))
check('★ 还回来的折角带着弹窗写的流程图（快照里记的是删之前那一版）',
  seen[0].mermaid === MODAL_CODE, JSON.stringify(seen[0].mermaid))
check('★ 还回来的折角是实心的（corner 和内容一致，不会自相矛盾）',
  seen[0].corner === true, String(seen[0].corner))
check('第 2 步撤销：折角消失（撤销「打上折角」）', seen[1].fold === false, JSON.stringify(seen[1]))
check('第 3 步撤销：文字回到 B', seen[2].order === 'B,A', JSON.stringify(seen[2]))
check('第 4 步撤销：顺序回到 A,B', seen[3].order === 'A,B', JSON.stringify(seen[3]))

// 再一路重做回去：折角内容必须还是弹窗写的那份
let rT = curT
let rh = hh
let rsteps = 0
let sawModalContent = false
while (rsteps < 20) {
  const x = redoCanvas(rh, rT)
  if (!x) break
  rh = x.history; rT = mergeFoldContent(x.tree, rT); rsteps++
  const f = foldOf(rT, 'c1')
  if (f && f.mermaid === MODAL_CODE) sawModalContent = true
}
check('重做步数与撤销步数一致', rsteps === 4, String(rsteps))
check('★ 重做过程中折角内容始终是弹窗写的那份（画布历史没把它冲掉）',
  sawModalContent, JSON.stringify(rsteps))
check('重做到底后回到最新状态（折角已被取消）', foldOf(rT, 'c1') === null,
  JSON.stringify(foldOf(rT, 'c1')))

/* ================================================================== */
console.log(`\n${'='.repeat(46)}`)
console.log(`  canvasHistory  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)

