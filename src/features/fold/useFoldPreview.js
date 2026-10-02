import { useCallback, useEffect, useRef } from 'react'
import { useDebouncedCallback } from '../../lib/hooks'
import { labelEditorPlacement } from './LabelEditor'
import {
  MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE, WHEEL_STEP, TRACKPAD_WHEEL_STEP,
} from './previewConfig'

/**
 * 预览区：缩放 / 平移（交给 react-zoom-pan-pinch）。
 *
 * 【为什么把原来手写的那套整个删掉】
 * 老实现是「pan/zoom 两个 React state + 自己算锚点缩放 + 右键拖拽平移」，
 * 有三个硬伤：
 *   1. 每次缩放都 setState → 整个弹窗重渲染，滚轮连滚时明显发涩；
 *   2. 只支持 Ctrl/Shift + 滚轮缩放，**没有双指捏合**，手机上等于不能用；
 *   3. 平移绑在右键上（左键让给原生滚动），和「右键弹菜单」抢事件。
 * 换成一个成熟库之后，这三件事都由它直接写 DOM transform 完成，
 * 不再经过 React 渲染，也不再有坐标换算的算术。
 *
 * 【库自己会做的事，我们不要重复做】
 *   · 滚轮缩放的**光标锚点**（老实现手算了 20 行，库内部就是标准做法）
 *   · 双指捏合（`pinch`，默认开启）
 *   · 平移的边界夹取（`limitToBounds`）
 * 我们只负责三件事：配好「什么时候允许缩放 / 什么时候允许平移」、
 * 把缩放百分比写到 DOM 上、以及一个统一的「回到适应屏幕」入口。
 *
 * @param viewRef      外层容器（也是键盘焦点锚点）；由组件持有，
 *                     因为撤销恢复后要聚焦它 —— 让两边共用同一个 ref
 * @param previewRef   SVG 宿主，用来按 id 找节点元素
 * @param labelEditorRef 改字框「当前值」的镜像（渲染期同步，回调里可能过期）
 */
export function useFoldPreview({
  svg, mode, stacked, mobilePane, previewRef, viewRef, labelEditorRef, findNodeElById,
}) {
  const zoomApiRef = useRef(null)      // 库的 controls：fitToView / zoomIn / zoomOut / panBy …
  const zoomLabelRef = useRef(null)    // 顶栏那个百分比，直接写 textContent
  const editorPosRef = useRef(null)    // 改字框的根元素，跟着图走时直接改它的 style

  /**
   * 当前缩放倍率的镜像。
   *
   * 【为什么不直接读库的 state】
   * 库把倍率藏在 `instance.transformState` / `state.scale` 这类内部结构里，
   * 名字和层级在版本之间改过。我们本来就已经通过 onTransformTick 每帧拿到
   * 权威的 scale（同一个值还写给了百分比标签），所以自己记一份 ——
   * 滚轮算目标倍率时用它，不依赖任何内部字段名。
   */
  const scaleRef = useRef(1)

  /**
   * 持续记录当前视图（translate + zoom），供「内容重绘后原样恢复」使用。
   * 记录点在 onTransformTick：每次 transform 变化时顺手记一份，
   * 用户的手怎么摆，重绘后就还是怎么摆。
   */
  const savedViewRef = useRef(null)

  /**
   * 恢复视图期间置位。
   *
   * 恢复本身会触发库的 change 回调（transform 变了）。不加这个锁的话，
   * 回调会去覆写 savedViewRef，形成「恢复 → 记录恢复中的中间态 → 再恢复」的
   * 自我污染，视图可能越恢复越偏。
   */
  const isRestoringView = useRef(false)

  /**
   * 缩放百分比**不走 state**。
   *
   * 滚轮连滚时 onZoom 每帧都会触发；如果每帧 setState，就会把整个弹窗
   * （含左侧编辑器、右键菜单、所有 effect）重渲染一遍 —— 正是老实现发涩的原因。
   * 百分比只是一个数字，直接写 DOM 成本可以忽略。
   */
  const paintZoom = useCallback((scale) => {
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(scale * 100)}%`
  }, [])

  /**
   * 「回到适应屏幕」——顶部「重置视图」和右下角「适应屏幕」共用这一个入口。
   *
   * 用 `fitToView({ mode: 'contain' })` 而不是 `resetTransform()`：
   * 后者的语义是「回到 initialScale = 1」，对一张很宽的流程图来说
   * 回到 1 倍只是把它放到原始大小，右边照样看不全；
   * `fitToView` 才是真正的「整张图装进视口」，也正是需求里
   * 「回到居中适应状态」这句话的意思。
   */
  const fitView = useCallback((animate = true) => {
    const api = zoomApiRef.current
    if (!api?.fitToView) return
    api.fitToView({ mode: 'contain', animationTime: animate ? 200 : 0 })
  }, [])

  /** 图变了 → 重新装一次。防抖：连续重绘时不至于一直跳 */
  const fitViewSoon = useDebouncedCallback(() => fitView(true), 180)

  /**
   * 把记录下来的视图原样贴回去（瞬时，无动画）。
   *
   * 【为什么「恢复」和「适应屏幕」是两个动作，且恢复才是常态】
   * 「适应屏幕」会**改缩放**，那是一次明确的用户意图（点按钮 / Ctrl+0）。
   * 除此之外的任何重绘 —— 改一个字、拖一下左右分割线、切一下代码/缩进标签 ——
   * 都不该动用户的缩放和位置。所以这些路径统一走恢复，不走 fit。
   *
   * @returns {number|null} 解锁定时器 id（调用方负责 clear）
   */
  const applySavedView = useCallback(() => {
    const api = zoomApiRef.current
    const saved = savedViewRef.current
    if (!api?.setTransform || !saved) return null
    isRestoringView.current = true
    api.setTransform(saved.x, saved.y, saved.zoom, 0)
    // 解锁放在下一帧：库的 change 回调是异步派发的，同步解锁等于没锁
    return setTimeout(() => { isRestoringView.current = false }, 0)
  }, [])

  /**
   * 【编辑时绝对冻结视图】
   *
   * 老实现是「svg 一变就 fitView」，于是每改一个字、每加一个节点，
   * 整个图都会重新缩放居中一次 —— 用户正在看的位置被强行拉走，
   * 改几笔就晕了。
   *
   * 现在把「重绘」和「用户明确要求适应屏幕」彻底分开：
   *   · 内容变化（svg 变了）   → **恢复**之前的 translate/zoom，绝不 fit
   *   · 容器尺寸变化           → 同样**什么也不做**（库自己只会把越界的
   *                              位置挪回边界，从不改缩放；我们再 fit 一次
   *                              就等于把用户刚摆好的视角冲掉）
   *   · 第一次拿到 svg         → fit（「第一次打开全屏弹窗」那一次）
   *   · 点「适应屏幕」/ Ctrl+0 → fit（用户明确要求）
   *
   * `firstSvgRef` 负责放行「第一次」：弹窗刚打开时图还没定位过，那一次必须 fit。
   */
  const firstSvgRef = useRef(true)

  useEffect(() => {
    if (!svg) return
    // 第一次拿到 SVG：这是「打开弹窗」那一次，必须 fit
    if (firstSvgRef.current) {
      firstSvgRef.current = false
      fitViewSoon()
      return
    }
    /*
     * 之后每次重绘：把编辑前的视图原样贴回去。
     *
     * 为什么用 setTransform 而不是什么都不做：mermaid 每次重绘都会输出一个
     * **全新的 SVG 元素**，库挂在旧内容上的尺寸测量随之失效，
     * 它会按新内容重新算一次初始位置 —— 结果就是「图自己跳了」。
     * 显式写回记录的 (x, y, scale) 才是真正的「像什么都没发生过」。
     */
    const t = applySavedView()
    return () => { if (t) clearTimeout(t) }
  }, [svg, fitViewSoon, applySavedView])

  /*
   * 容器尺寸变化 → **完全不动用户的视图**。
   *
   * 【为什么这里不能再 fitView】
   * 拖一下左右分割线就重新缩放居中，等于把用户刚摆好的视角冲掉。
   * 而且库内部已经有一个 ResizeObserver 在盯容器和内容尺寸了：它的
   * handleSizeChange 只做一件事 —— 把**越界的位置**平滑挪回边界内
   * （`setState(scale, x, y)`，缩放原样带回，从不改）。那正是我们想要的语义，
   * 我们再去 fit 一次纯属把用户视角冲掉。
   *
   * 【为什么依赖里没有 mode】
   * mode 只是「左侧编辑器显示缩进列表还是 Mermaid 代码」，它不影响右侧容器尺寸。
   * 早先把它写进依赖，于是**每切一次标签右侧图就重新 fit 一次** ——
   * 用户看到的就是「切一下代码，图就跳一下」。
   *
   * 【为什么仍然要挂这个 observer】
   * 手机端切回预览时预览 section 是**全新挂载**的（TransformWrapper 也是新的），
   * viewRef.current 换了一个节点。不重新挂 observer 的话它还在盯那个
   * 已经脱离文档的旧节点；同时新实例需要我们把上次的视图贴回去，
   * 否则它会停在 fitOnInit 的初始 fit 上（表现为「切回来图跑偏了」）。
   */
  useEffect(() => {
    const el = viewRef.current
    if (!el) return
    let lastW = el.clientWidth
    let lastH = el.clientHeight
    /*
     * 【只认容器物理尺寸的变化，且什么都不做】
     * 取整再比对，拦住「内容重绘导致的亚像素抖动也算尺寸变了」；
     * observer 只 observe viewRef 这一个容器 —— 代码编辑器在它外面，
     * 改代码不会惊动它。尺寸真的变了也**不调整视图**（见上面的长注释）。
     */
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width)
      const h = Math.round(entry.contentRect.height)
      if (w === lastW && h === lastH) return
      lastW = w
      lastH = h
    })
    ro.observe(el)
    // 新挂载的实例：把上次的视图贴回去（切回预览面板时容器是全新的）
    const t = applySavedView()
    return () => { ro.disconnect(); if (t) clearTimeout(t) }
  }, [applySavedView, stacked, mobilePane, viewRef])

  /*
   * 手机虚拟键盘弹起适配（需求四·3）。
   *
   * 键盘弹起时**布局视口（innerHeight）通常不变**，变的是 visualViewport
   * 的高度和 offsetTop —— 只监听 window.resize 在 Android/iOS 上都可能收不到，
   * 于是图还按「键盘没弹起」的尺寸居中，实际可见区域只剩一半，图就跑到屏幕外了。
   * 所以必须单独盯 visualViewport 的 resize。
   */
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return
    const onViewportResize = () => fitViewSoon()
    vv.addEventListener('resize', onViewportResize)
    // scroll 也要听：键盘弹起/收起时 offsetTop 会变，而 resize 不一定触发
    vv.addEventListener('scroll', onViewportResize)
    return () => {
      vv.removeEventListener('resize', onViewportResize)
      vv.removeEventListener('scroll', onViewportResize)
    }
  }, [fitViewSoon])

  /**
   * Ctrl/Cmd + 0 → 一键居中预览区（需求「保留完整的手动视图控制入口」）。
   *
   * 【为什么必须由弹窗自己处理】
   * 全局快捷键（useGlobalKeys）里的 Ctrl+0 是给**主画布**用的。弹窗打开后
   * 主画布被整个盖住，那个 center() 用户根本看不见 —— 按了没反应。
   * useGlobalKeys 在弹窗打开时会主动让出这次按键（不 preventDefault），
   * 于是这里接住它，居中用户真正在看的那张图。
   *
   * 挂在 document 上而不是 viewRef：用户可能刚点过左侧编辑器或某个按钮，
   * 焦点不在预览区里，挂在容器上会收不到按键。
   */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault()
        fitView()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [fitView])

  /**
   * 滚轮缩放：**不需要按 Ctrl**，滚轮直接缩放，以鼠标指针为锚点。
   *
   * 【为什么不再用库的 wheel.activationKeys】
   * 老实现把滚轮交给库，并且要求 Ctrl/Cmd 才缩放（不按就是上下平移）。
   * 结果是最常见的动作 —— 「鼠标放在图上直接滚一下想放大」—— 毫无反应，
   * 用户只能去点右下角的按钮。现在改成滚轮默认缩放，平移用拖拽。
   *
   * 缩放锚点由 zoomToPoint 负责：库内部会保证「指针下的那个点在缩放前后
   * 屏幕位置不动」，这正是需求里最关键的 Zoom to Pointer。
   *
   * 【触控板捏合】
   * 浏览器会把触控板的捏合手势伪装成 `ctrlKey === true` 的 wheel 事件
   * （这是底层的约定，Mac 上尤其明显）。这种事件 deltaY 通常很小、
   * 触发极密，用和鼠标一样的步长会显得又钝又跳，所以单独给更细的步长。
   * 注意：能把页面缩放拦下来的也正是这个判断 —— 必须 preventDefault。
   *
   * 【为什么必须显式传 animationTime = 0】
   * 库的 `zoomToPoint(scale, x, y, animationTime = 300, type = 'easeOut')`
   * 默认带 **300ms 缓动动画**。滚轮一格只来一次事件、几十毫秒后下一格又来，
   * 于是每次都在「上一段动画还没走完」时另起一段动画，实际落点只是目标的一小截 ——
   * 第一节提到实测「每格只涨了 30% 左右的应有幅度」，手感就是**很钝**。
   * 主画布那边是直接改 transform、没有任何动画，两边速度必须一致；
   * 传 0 之后库内部走 `animate()` 的 `animationTime === 0` 分支，
   * 同步 `setState`，一次事件 = 一次位移，和主画布完全同速。
   */
  useEffect(() => {
    const el = viewRef.current
    if (!el) return
    const onWheel = (e) => {
      const api = zoomApiRef.current
      // 拦掉浏览器默认行为：Ctrl+滚轮 = 缩放整个页面（会把应用界面放大）
      if (e.cancelable) e.preventDefault()
      if (!api?.zoomToPoint && !api?.zoom) return

      // 触控板捏合（伪装成 ctrlKey）用精细步长，普通鼠标滚轮用标准步长
      const step = e.ctrlKey || e.metaKey ? TRACKPAD_WHEEL_STEP : WHEEL_STEP
      const factor = Math.exp(-e.deltaY * step)

      /*
       * zoomToPoint 收的是**视口坐标**（库内部自己减 wrapper 的 rect.left），
       * 所以必须原样传 clientX/clientY，不能先减容器的 left/top ——
       * 那样会变成「相对容器的坐标」，锚点会整体偏移一个容器的位置。
       */
      if (api.zoomToPoint) {
        const cur = scaleRef.current
        // 先算出目标缩放值，再交给库 —— zoomToPoint 收的是**目标倍率**而非增量
        const next = Math.min(MAX_PREVIEW_SCALE, Math.max(MIN_PREVIEW_SCALE, cur * factor))
        if (next === cur) return   // 已经顶到上下限，不再触发无意义的 transform
        // 最后一个 0 = animationTime：瞬时生效，和主画布同速（见上面的长注释）
        api.zoomToPoint(next, e.clientX, e.clientY, 0)
      } else {
        api.zoom(factor)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [viewRef])

  /**
   * 让「居中态」的改字框钉在它的节点上。
   *
   * 【为什么必须有这个】
   * 合并之后我们会自动弹改字框，同时又会因为 svg 变化触发一次「自动适应屏幕」。
   * 那个适应是**带动画**的（200ms），于是：
   *   量节点位置（框摆好）→ 200ms 后图重新居中 → 节点跑掉了，框留在原地
   * 实测偏离 116px，看起来就是「输入框飘在节点上方老远」。
   *
   * 顺带把另一个场景也一起解决了：用户一边改字一边拖动画布 / 捏合缩放时，
   * 框会跟着节点走，不会和节点脱节。
   *
   * 实现上刻意**直写 DOM** 而不是 setState —— 拖动过程中每帧 setState
   * 会把整个弹窗重渲染，手感立刻变差。这里一次只改两个 style 属性。
   */
  const syncEditorPos = useCallback(() => {
    const ed = labelEditorRef.current
    const el = editorPosRef.current
    const host = previewRef.current
    // 只有「居中态」才跟：贴鼠标那种（双击改字）本来就该留在鼠标那儿
    if (!ed?.centered || !ed.nodeId || !el || !host) return
    const nodeEl = findNodeElById(host, ed.nodeId)
    if (!nodeEl) return
    const r = nodeEl.getBoundingClientRect()
    const pos = labelEditorPlacement(r.left + r.width / 2, r.top + r.height / 2, true)
    el.style.left = `${pos.left}px`
    el.style.top = `${pos.top}px`
  }, [findNodeElById, labelEditorRef, previewRef])

  /** 库每次改 transform 都回调这里：记视图 + 同步百分比 + 把改字框钉回节点 */
  const onTransformTick = useCallback((scale, positionX, positionY) => {
    scaleRef.current = scale          // 滚轮算目标倍率的依据，见 scaleRef 注释
    /*
     * 记录视图，供「重绘后原样恢复」使用。
     * 恢复期间跳过记录：那一刻的 transform 是我们自己写回去的，
     * 记它没有意义，反而可能把中间态存下来。
     */
    if (!isRestoringView.current && typeof positionX === 'number') {
      savedViewRef.current = { x: positionX, y: positionY, zoom: scale }
    }
    paintZoom(scale)
    syncEditorPos()
  }, [paintZoom, syncEditorPos])

  return {
    zoomApiRef, zoomLabelRef, editorPosRef,
    paintZoom, fitView, onTransformTick,
  }
}
