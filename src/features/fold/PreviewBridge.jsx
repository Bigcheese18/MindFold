import { useLayoutEffect } from 'react'
import { useControls, useTransformEffect } from 'react-zoom-pan-pinch'

/**
 * 把 react-zoom-pan-pinch 的命令式 API 和「当前缩放值」桥接出来。
 *
 * 【为什么不用 `ref={zoomApiRef}`】
 * 库的 `TransformWrapper` 确实是 forwardRef，传 ref 也能拿到 controls，
 * 但实测会触发 React 的开发期警告：
 *   「Warning: `ref` is not a prop. ... at TransformComponent」
 * 整条链路都会被打上红字，而本项目的测试是「console 有 error 就算失败」。
 * v4 官方给的取用方式是 `useControls()`，它返回的正是同一份 controls 对象，
 * 且必须在 TransformWrapper **内部**调用（要读它的 Context）——
 * 所以这里放一个只渲染 null 的小桥接组件，兼做两件事：
 *   1. 把 controls 交给外面的 ref，供顶栏 / 右下角按钮调用
 *   2. 每次 transform（缩放 / 平移 / 自动适应）回调一次，用来同步
 *      缩放百分比和「跟着节点走的改字框」
 */
export default function PreviewBridge({ apiRef, onTick }) {
  const controls = useControls()
  // controls 每次渲染都是新对象（getControls 内部新建），所以不进依赖数组
  useLayoutEffect(() => {
    apiRef.current = controls
    onTick(controls.state.scale, controls.state.positionX, controls.state.positionY)
  })
  /*
   * 库每次改 transform 都会回调。
   * 把 positionX/positionY 一起传出去：变动重绘后要把视图原样恢复，
   * 光有 scale 是不够的（平移量丢了图照样会跳）。
   * 这里只做几次极便宜的 DOM 写入和 ref 赋值，不 setState。
   */
  useTransformEffect(({ state }) => { onTick(state.scale, state.positionX, state.positionY) })
  return null
}
