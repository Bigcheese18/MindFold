/**
 * 「三个视图的滚轮步长必须是同一个数」—— 结构不变式测试
 * ======================================================
 *
 * 【为什么需要这个文件】
 * 用户上一轮的反馈是：「滚轮键是放大和缩小……两个视图都是这样的，
 * **但思维导图不是这样的**。」
 *
 * 根因不是谁写错了代码，而是**同一个数字被抄了三份**（主画布 / 折角预览 /
 * 打印预览）。三份各自都「对」，改一份另两份不会有任何提示 —— 这类问题
 * 光靠「行为测试」挡不住：行为测试只能证明**当下**三个视图碰巧一致，
 * 挡不住下一个人只改其中一处。
 *
 * 所以这里不测行为，测**结构**：步长只能有一个来源，
 * 且三个作用面都必须从那里取。
 *
 * 与之配套、但**故意不共享**的东西：缩放下限。三个场景各有各的合理取值
 * （主画布 0.15 看全局 / 折角预览 0.2 / 打印预览 0.35 看细线），
 * 所以最后几节反过来钉「下限**不许**被统一」—— 否则有人为了「一致」
 * 把三个不同用途的数硬凑成一个，会同时弄坏至少两个场景。
 *
 * 跑法：node src/lib/zoomSteps.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  WHEEL_STEP,
  TRACKPAD_WHEEL_STEP,
} from './zoomSteps.js'
import * as previewConfig from '../features/fold/previewConfig.js'
import * as printLayout from './printLayout.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (m) => console.log(`  · ${m}`)
const eq = (a, b) => Object.is(a, b)

/* ------------------------------------------------------------------ */
console.log('\n[1] src/lib/zoomSteps.js 是唯一来源，取值符合推导')

check('WHEEL_STEP = 0.0015（鼠标滚轮一格 deltaY≈100 → 每格 +16.2%）',
  eq(WHEEL_STEP, 0.0015), String(WHEEL_STEP))
check('TRACKPAD_WHEEL_STEP = 0.01（触控板捏合一帧 deltaY≈4 → 每帧 +4.1%）',
  eq(TRACKPAD_WHEEL_STEP, 0.01), String(TRACKPAD_WHEEL_STEP))

check('两个步长都是有限正数（写错成 0 / 负数会让缩放直接失灵）',
  Number.isFinite(WHEEL_STEP) && WHEEL_STEP > 0
  && Number.isFinite(TRACKPAD_WHEEL_STEP) && TRACKPAD_WHEEL_STEP > 0,
  `${WHEEL_STEP} / ${TRACKPAD_WHEEL_STEP}`)

/*
 * 「触控板每事件变化率严格小于鼠标」是这两个数唯一要维持的关系。
 * 注意不能直接比 step —— 触控板的 step 反而**更大**（0.01 > 0.0015），
 * 因为它的 deltaY 小一个数量级。要比的是 exp(deltaY × step)。
 */
const mousePer = Math.exp(100 * WHEEL_STEP)
const trackpadPer = Math.exp(4 * TRACKPAD_WHEEL_STEP)
note(`每事件变化率：鼠标 exp(100×${WHEEL_STEP}) = ${mousePer.toFixed(4)}（+${((mousePer - 1) * 100).toFixed(1)}%）`)
note(`                触控板 exp(4×${TRACKPAD_WHEEL_STEP}) = ${trackpadPer.toFixed(4)}（+${((trackpadPer - 1) * 100).toFixed(1)}%）`)
check('★ 触控板每事件变化率**严格小于**鼠标（否则捏合会又快又跳）',
  trackpadPer < mousePer,
  `${trackpadPer.toFixed(4)} vs ${mousePer.toFixed(4)}`)
check('鼠标每格 ≈ +16.2%（和 README / 打印页注释里写的实测数字对得上）',
  Math.abs((mousePer - 1) * 100 - 16.2) < 0.1,
  `${((mousePer - 1) * 100).toFixed(2)}%`)

/* ------------------------------------------------------------------ */
console.log('\n[2] 折角弹窗预览（previewConfig.js）从唯一来源转出')

check('★ previewConfig.WHEEL_STEP 与 zoomSteps 同一个值',
  eq(previewConfig.WHEEL_STEP, WHEEL_STEP),
  `${previewConfig.WHEEL_STEP} vs ${WHEEL_STEP}`)
check('★ previewConfig.TRACKPAD_WHEEL_STEP 与 zoomSteps 同一个值',
  eq(previewConfig.TRACKPAD_WHEEL_STEP, TRACKPAD_WHEEL_STEP),
  `${previewConfig.TRACKPAD_WHEEL_STEP} vs ${TRACKPAD_WHEEL_STEP}`)

const pcSrc = readFileSync(join(ROOT, 'src/features/fold/previewConfig.js'), 'utf8')
check('previewConfig.js 里**没有**再写一份步长字面量（只能是 re-export）',
  !/export\s+const\s+(WHEEL_STEP|TRACKPAD_WHEEL_STEP)\s*=/.test(pcSrc))
check('previewConfig.js 确实从 lib/zoomSteps 转出（import/export … from）',
  /from\s+'\.\.\/\.\.\/lib\/zoomSteps\.js'/.test(pcSrc))

/* ------------------------------------------------------------------ */
console.log('\n[3] 打印预览页（printLayout.js）从唯一来源转出')

check('★ printLayout.WHEEL_STEP 与 zoomSteps 同一个值（同一份数字，不是抄的）',
  eq(printLayout.WHEEL_STEP, WHEEL_STEP),
  `${printLayout.WHEEL_STEP} vs ${WHEEL_STEP}`)
check('★ printLayout.TRACKPAD_WHEEL_STEP 与 zoomSteps 同一个值',
  eq(printLayout.TRACKPAD_WHEEL_STEP, TRACKPAD_WHEEL_STEP),
  `${printLayout.TRACKPAD_WHEEL_STEP} vs ${TRACKPAD_WHEEL_STEP}`)

const plSrc = readFileSync(join(ROOT, 'src/lib/printLayout.js'), 'utf8')
check('printLayout.js 里**没有**再写一份步长字面量（只能是 re-export）',
  !/export\s+const\s+(WHEEL_STEP|TRACKPAD_WHEEL_STEP)\s*=/.test(plSrc))
check('printLayout.js 确实从 ./zoomSteps 转出（同级 lib，不产生反向依赖）',
  /from\s+'\.\/zoomSteps\.js'/.test(plSrc))
check('printLayout.js 没有把 features 层拽进来（生成打印页必须保持自包含）',
  !/from\s+'[^']*features\//.test(plSrc))

/* ------------------------------------------------------------------ */
console.log('\n[4] 主画布（Canvas.jsx）必须 import，不能自己写数字')

const canvasSrc = readFileSync(join(ROOT, 'src/features/canvas/Canvas.jsx'), 'utf8')
check('★ Canvas.jsx 从 previewConfig 引入两个步长常量',
  /import\s*\{[^}]*WHEEL_STEP[^}]*TRACKPAD_WHEEL_STEP[^}]*\}\s*from\s*'\.\.\/fold\/previewConfig'/.test(canvasSrc)
  || /import\s*\{[^}]*WHEEL_STEP[^}]*TRACKPAD_WHEEL_STEP[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/zoomSteps'/.test(canvasSrc))
check('★ Canvas.jsx 的滚轮分支里没有硬编码的步长字面量',
  !/Math\.exp\([^)]*0\.00\d+/.test(canvasSrc),
  (canvasSrc.match(/Math\.exp\([^)]*0\.00\d+/) || [''])[0])
check('Canvas.jsx 里用的是引入的常量（step = …WHEEL_STEP）',
  /const\s+step\s*=[^\n]*(TRACKPAD_WHEEL_STEP|WHEEL_STEP)/.test(canvasSrc))

/* ------------------------------------------------------------------ */
console.log('\n[5] 反向断言：缩放下限**故意不共享**，不许有人「统一」它们')

/*
 * 这一节是给未来的自己/别人看的护栏。
 * 「一致」只适用于手势语义和步长；上下限是**场景参数**：
 *   主画布 0.15（要把整张导图看全）／折角预览 0.2（节点文字不能糊）
 *   / 打印预览 0.35（纸面 10.5pt 的字再小就看不清）
 * 把它们合成一个数，必然同时弄坏至少一个场景。
 */
const canvasMin = Number((canvasSrc.match(/Math\.max\((\d+(?:\.\d+)?),\s*z\)/) || [])[1])
note(`三个下限：主画布 ${canvasMin} / 折角预览 ${previewConfig.MIN_PREVIEW_SCALE} / 打印预览 ${printLayout.MIN_ZOOM}`)
check('主画布下限能从 clampZoom 里读出来（不是 0、也不是共享来的）',
  Number.isFinite(canvasMin) && canvasMin > 0, String(canvasMin))
check('★ 三个下限互不相同（各自是场景参数，不该被统一）',
  new Set([canvasMin, previewConfig.MIN_PREVIEW_SCALE, printLayout.MIN_ZOOM]).size === 3,
  `${canvasMin} / ${previewConfig.MIN_PREVIEW_SCALE} / ${printLayout.MIN_ZOOM}`)
check('主画布下限最小（看全局的需求最激进）',
  canvasMin < previewConfig.MIN_PREVIEW_SCALE
  && previewConfig.MIN_PREVIEW_SCALE < printLayout.MIN_ZOOM,
  `${canvasMin} < ${previewConfig.MIN_PREVIEW_SCALE} < ${printLayout.MIN_ZOOM}`)

/* ------------------------------------------------------------------ */
console.log(`\n滚轮步长单一来源 ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
