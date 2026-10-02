/**
 * 撤销/重做历史栈测试
 * ====================
 * 重点：
 *   · 上限 20，超出丢最旧的
 *   · 无实质变化不入栈，且不清空 future
 *   · undo/redo 严格互逆
 *   · 新分支（撤销后又编辑）必须清空 future
 *   · 全纯函数，入参不被改动
 */
import {
  HISTORY_LIMIT, sameSnapshot, emptyHistory, initHistory,
  commitSnapshot, undoSnapshot, redoSnapshot, canUndo, canRedo,
} from './history.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}

const snap = (n) => ({ code: `code-${n}`, outline: `outline-${n}`, rowIds: [`n${n}`] })

/* ================================================================== */
console.log('\n[1] 基本语义')
/* ================================================================== */

check('空历史不能撤销也不能重做',
  !canUndo(emptyHistory()) && !canRedo(emptyHistory()))

let h = initHistory(snap(0))
check('初始状态不能撤销（还没有「变化前」）', !canUndo(h), JSON.stringify({ past: h.past.length }))
check('初始 current 就是传入的快照', h.current.code === 'code-0')

h = commitSnapshot(h, snap(1))
check('提交一次后可以撤销', canUndo(h) && h.past.length === 1, JSON.stringify(h.past.length))
check('入栈的是**变化前**的状态', h.past[0].code === 'code-0', h.past[0].code)
check('current 跟着更新', h.current.code === 'code-1')

h = commitSnapshot(h, snap(2))
check('再提交一次，栈深 2', h.past.length === 2, String(h.past.length))

const u1 = undoSnapshot(h)
check('撤销返回上一步', u1 && u1.current.code === 'code-1', JSON.stringify(u1?.current))
check('撤销后 future 里是刚离开的状态', u1.future.length === 1 && u1.future[0].code === 'code-2')
check('撤销后 past 少一个', u1.past.length === 1)

const r1 = redoSnapshot(u1)
check('重做回到 code-2', r1 && r1.current.code === 'code-2', JSON.stringify(r1?.current))
check('重做后 future 空', r1.future.length === 0)
check('重做后 past 恢复', r1.past.length === 2)

/* ================================================================== */
console.log('\n[2] 无实质变化不入栈')
/* ================================================================== */

let h2 = initHistory(snap(0))
h2 = commitSnapshot(h2, snap(1))
const before = h2.past.length
const same = commitSnapshot(h2, snap(1))
check('内容没变 → 不入栈', same.past.length === before && same.pushed === false)
check('内容没变 → current 不变', same.current.code === 'code-1')

// 只有 rowIds 变了（派生数据）不算实质变化
const onlyRows = commitSnapshot(h2, { code: 'code-1', outline: 'outline-1', rowIds: ['zzz'] })
check('只有 rowIds 变化 → 不算实质变化', onlyRows.pushed === false, JSON.stringify(onlyRows.pushed))

// 无变化时不能清空 future（否则撤销后随便点一下就丢了重做链）
let h3 = initHistory(snap(0))
h3 = commitSnapshot(h3, snap(1))
h3 = undoSnapshot(h3)
check('撤销后 future 有 1 项', h3.future.length === 1)
const noop = commitSnapshot(h3, snap(0))
check('无变化提交不会清空 future（重做链保住）',
  noop.future.length === 1, JSON.stringify(noop.future.length))

/* ================================================================== */
console.log('\n[3] 新分支清空 future')
/* ================================================================== */

let h4 = initHistory(snap(0))
h4 = commitSnapshot(h4, snap(1))
h4 = commitSnapshot(h4, snap(2))
h4 = undoSnapshot(h4)          // 回到 1，future 有 2
check('撤销后 future 有内容', h4.future.length === 1)
h4 = commitSnapshot(h4, snap(99))   // 走了新分支
check('撤销后再编辑 → future 被清空', h4.future.length === 0, JSON.stringify(h4.future.length))
check('新分支的 current 是新状态', h4.current.code === 'code-99')
check('新分支后不能再重做', !canRedo(h4))

/* ================================================================== */
console.log('\n[4] 上限 20')
/* ================================================================== */

let h5 = initHistory(snap(0))
for (let i = 1; i <= 30; i++) h5 = commitSnapshot(h5, snap(i))
check(`栈深被夹到 ${HISTORY_LIMIT}`, h5.past.length === HISTORY_LIMIT, String(h5.past.length))
check('丢掉的是最旧的（栈底是 code-10）',
  h5.past[0].code === 'code-10', h5.past[0].code)
check('最新的是 code-29', h5.past[h5.past.length - 1].code === 'code-29',
  h5.past[h5.past.length - 1].code)

// 连续撤销到底
let cur = h5
let steps = 0
while (canUndo(cur)) { cur = undoSnapshot(cur); steps++ }
check(`最多能撤销 ${HISTORY_LIMIT} 步`, steps === HISTORY_LIMIT, String(steps))
check('撤到底后回到 code-10', cur.current.code === 'code-10', cur.current.code)
check('撤到底后不能继续撤销', undoSnapshot(cur) === null)

// future 也有上限
let h6 = initHistory(snap(0))
for (let i = 1; i <= 30; i++) h6 = commitSnapshot(h6, snap(i))
let fsteps = 0
while (canUndo(h6)) { h6 = undoSnapshot(h6); fsteps++ }
check('future 也被夹到上限', h6.future.length <= HISTORY_LIMIT, String(h6.future.length))

/* ================================================================== */
console.log('\n[5] 纯函数：入参不被改动')
/* ================================================================== */

const base = initHistory(snap(0))
const basePastLen = base.past.length
const committed = commitSnapshot(base, snap(1))
check('commitSnapshot 不改动入参', base.past.length === basePastLen && base.current.code === 'code-0')
check('commitSnapshot 返回新对象', committed !== base)

const undone = undoSnapshot(committed)
check('undoSnapshot 不改动入参',
  committed.past.length === 1 && committed.current.code === 'code-1')
check('undoSnapshot 返回新对象', undone !== committed)

const redone = redoSnapshot(undone)
check('redoSnapshot 不改动入参', undone.future.length === 1)
check('redoSnapshot 返回新对象', redone !== undone)

/* ================================================================== */
console.log('\n[6] 边界')
/* ================================================================== */

check('对空历史撤销返回 null', undoSnapshot(emptyHistory()) === null)
check('对空历史重做返回 null', redoSnapshot(emptyHistory()) === null)
check('current 为 null 时不崩',
  undoSnapshot({ past: [snap(0)], future: [], current: null }) === null)
check('sameSnapshot 对 null 返回 false',
  sameSnapshot(null, snap(1)) === false && sameSnapshot(snap(1), null) === false)
check('sameSnapshot 忽略 rowIds 差异',
  sameSnapshot({ code: 'a', outline: 'b', rowIds: [1] }, { code: 'a', outline: 'b', rowIds: [2] }) === true)

// 反复 undo/redo 应该稳定回到同一个状态
let ping = initHistory(snap(0))
ping = commitSnapshot(ping, snap(1))
ping = commitSnapshot(ping, snap(2))
for (let i = 0; i < 5; i++) {
  ping = undoSnapshot(ping)
  ping = redoSnapshot(ping)
}
check('反复 undo/redo 后状态稳定', ping.current.code === 'code-2', ping.current.code)
check('反复 undo/redo 后栈深稳定', ping.past.length === 2 && ping.future.length === 0,
  `${ping.past.length}/${ping.future.length}`)

/* ================================================================== */
console.log(`\n${'='.repeat(46)}`)
console.log(`  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)
