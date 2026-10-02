/**
 * 折角弹窗「预览区」的缩放 / 平移参数。
 *
 * 单独放一个模块：这些数字同时被 hooks（配置库）和 parts（渲染按钮）读到，
 * 放在任何一边都会让另一边反向依赖。
 */

/*
 * 滚轮步长**不在这里定义**，而是从 src/lib/zoomSteps.js 转出去。
 *
 * 【为什么必须转出去而不是就近写两个数】
 * 主画布、折角预览、打印预览三个作用面的步长曾经各写一份，结果手感不一致，
 * 用户的反馈是「两个视图都是这样的，但思维导图不是这样的」。
 * 现在只有一个来源（src/lib/zoomSteps.js，那里有完整推导），
 * 这里保留 re-export 是为了让既有调用方（useFoldPreview / FoldModal /
 * Canvas.jsx）的 import 路径一字不改。
 *
 * 注意：**缩放下限不能跟着共享**。本文件下面的 MIN/MAX_PREVIEW_SCALE
 * 是折角预览专用的（0.2~3），主画布用 0.15~2.5、打印预览用 0.35~5，
 * 三个场景各有各的合理取值。
 */
export { WHEEL_STEP, TRACKPAD_WHEEL_STEP } from '../../lib/zoomSteps.js'

/** 缩放上下限（需求一·3）。低于 0.2 节点文字糊成一团，高于 3 就没有意义了 */
export const MIN_PREVIEW_SCALE = 0.2
export const MAX_PREVIEW_SCALE = 3

/** 右下角放大/缩小按钮每次的步长（需求三·2 指定 0.2） */
export const ZOOM_BTN_STEP = 0.2

/**
 * 预览区的最小高度（px）。
 * 库靠量容器尺寸算 fitToView，高度为 0 时 scale 会算成 0（图消失）。
 * 取 120 是「至少能看到两三个节点」的下限，正常布局远大于它，只是兜底。
 */
export const MIN_PREVIEW_H = 120

/**
 * 「按在节点上不启动平移」用的类名。
 *
 * 库内部把 excluded 拼成 `.{wrapperClass} .node` 这种选择器去匹配，
 * 所以这里给的是**类名本身**（不带点）。mermaid 给每个节点画的是
 * `<g class="node">`，它的子元素（rect / foreignObject / label）
 * 也一并被排除 —— 否则点在节点文字上照样会把画布拖走。
 */
export const MERMAID_NODE_CLASS = 'node'
