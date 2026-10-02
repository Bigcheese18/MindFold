import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import MindNode from './MindNode'
import { layoutTree, edgePath, fitView } from '../../lib/layout'
import { RELATION_HIDE_THRESHOLD, relationsOf } from '../../lib/treeOps'
/*
 * 滚轮步长**刻意**和折角预览共用同一份常量（而不是各写一个数字）。
 *
 * 本轮用户的原话是「两个视图都是这样的，但思维导图不是这样的」—— 抱怨的
 * 正是不同视图手感/行为不一致。复制一份常量就等于给「以后再次跑偏」留了口子：
 * 谁改了折角那边的数字，思维导图这边不会有任何提示。共用同一个来源之后，
 * 两边每格滚轮的倍率在结构上永远相同。
 *
 * 注意只共用**步长**，不共用缩放下限：主画布的下限是 0.15（要看全局），
 * 折角预览是 0.2，这是两个场景各自的合理取值，见各自的 clampZoom。
 */
import { WHEEL_STEP, TRACKPAD_WHEEL_STEP } from '../fold/previewConfig'

/**
 * 导图画布
 * ========
 * 交互（PRD 第四章）：
 *   - 空白处拖拽 → 平移画布
 *   - 节点拖拽 → 改变层级（带防误触：位移 > 8px 且按住 220ms 才进入拖拽）
 *   - 滚轮 → 直接缩放（不按 Ctrl）；平移用空白处拖拽（见 onWheel 的注释）
 *   - Ctrl+0 / 打开文档 → 自动 fitView（居中 + 缩放，四周留 20% 边距）
 *
 * 「指向 / 指向同一结果」的连线模式：
 *   - 进入后鼠标变十字准星，顶部出现提示条
 *   - 点任意节点作为目标；点空白或按 Esc 取消
 *   - 模式下**禁用平移和节点拖拽**，否则「点击选目标」会被拖拽手势吃掉
 */
export default function Canvas({
  root,
  selectedId,
  editingId,
  radarMode,
  view,
  onViewChange,
  onSelect,
  onToggleCollapse,
  onOpenFold,
  onStartEdit,
  onCommitEdit,
  onContextMenu,
  onDropNode,       // (dragId, targetId|null) => void
  canvasApiRef,
  fitToken,         // 数值变化 → 重新 fitView（切换文档 / 导入 / 新建时由 App 递增）
  relations = [],   // [{ from, to }] 汇聚虚线
  linkMode = null,  // { kind:'point'|'merge', fromId } | null
  onLinkPick,       // (targetNodeId) => void
  onLinkCancel,     // () => void
  mobile = false,   // 手机端：禁拖拽改层级，改成长按弹菜单
  onLongPress,      // (clientX, clientY, node) => void
  onViewGestureStart, // 画布开始平移/缩放 → 外面据此关掉右键菜单
}) {
  const wrapRef = useRef(null)
  // 初值给 0：表示「还没量到真实尺寸」，fitView 会等到量到为止，
  // 避免用默认尺寸算出一个错误的视口再被真实尺寸覆盖。
  const [size, setSize] = useState({ w: 0, h: 0 })
  const drag = useRef(null)
  // 拖拽中的节点 id（进入拖拽态时 set 一次，结束时清掉）
  const [draggingId, setDraggingId] = useState(null)
  // 落点：{ targetId, position: 'before'|'after'|'child' }；用 state 驱动引导线渲染
  const [drop, setDrop] = useState(null)
  const dropRef = useRef(null)     // onPointerUp 里读它，避免闭包拿到旧 state
  const ghostRef = useRef(null)    // 幽灵：直接改 transform，不走 re-render
  // 手机端长按弹菜单的待触发状态 { nodeId, x, y, timer }
  const longPress = useRef(null)

  /*
   * 卸载时把挂起的长按定时器清掉。
   * 不清的话，组件已经没了、定时器到点还会调 onLongPress，
   * 那就是对已卸载组件所在的父级 setState。
   */
  useEffect(() => () => {
    if (longPress.current) clearTimeout(longPress.current.timer)
    longPress.current = null
  }, [])

  /* ---------- 布局（记忆化：树结构或汇聚关系变了才重算） ---------- */
  /*
   * relations 必须进依赖：布局的第三趟要按汇聚边把结果节点挪到源节点中间
   * （见 layout.js 的 applyConvergenceLayout）。
   * 漏掉它的话，新建汇聚关系时布局不会重算，节点仍停在原来的位置上。
   */
  const layout = useMemo(
    () => layoutTree(root, { includeRoot: true, relations }),
    [root, relations],
  )
  const { nodes, edges, byId } = layout

  /* ---------- 容器尺寸 ---------- */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      setSize({ w: e.contentRect.width, h: e.contentRect.height })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  /* ---------- 自动适配视口（居中 + 缩放，四周留白 20%） ---------- */
  const fit = useCallback((animate = true) => {
    if (!nodes.length || !size.w || !size.h) return
    // 窄屏（手机）抬高缩放下限：否则整张图会缩到 0.2 左右，
    // 文字糊、折角角标热区只剩 9px 点不中。宁可让用户横向平移。
    const minZoom = size.w < 768 ? 0.75 : 0.15
    onViewChange(fitView(nodes, size.w, size.h, undefined, { minZoom }), animate)
  }, [nodes, size.w, size.h, onViewChange])

  // 首次拿到真实尺寸时自动适配一次
  const didInitFit = useRef(false)
  useEffect(() => {
    if (didInitFit.current) return
    if (!size.w || !size.h || !nodes.length) return
    didInitFit.current = true
    fit(false)
  }, [size.w, size.h, nodes.length, fit])

  // 切换文档 / 导入 / 新建：重新适配
  const lastFitToken = useRef(fitToken)
  useEffect(() => {
    if (fitToken === lastFitToken.current) return
    lastFitToken.current = fitToken
    didInitFit.current = true
    fit(false)
  }, [fitToken, fit])

  // 暴露给父组件（工具栏 / Ctrl+0）
  useEffect(() => {
    if (canvasApiRef) {
      canvasApiRef.current = {
        fit,
        center: fit,
        zoomBy: (f) => onViewChange({ ...view, zoom: clampZoom(view.zoom * f) }, true),
        getNodes: () => nodes,
        getById: (id) => byId.get(id),
      }
    }
  })

  /* ---------- 视口变换：手势期间绕过 React ---------- */
  /*
   * 【为什么不能每帧走 setState】
   * 原来平移/捏合每一帧都调 `onViewChange` → `updateDoc` → setState，
   * 于是**整棵画布重新渲染一遍**。实测（Pixel 7 视口 + 4 倍 CPU 降速）：
   *
   *     29 节点：60fps，0 掉帧
   *    300 节点：60fps，0 掉帧
   *    800 节点：40fps，p95 50ms，掉帧 40/119，longtask 最长 88ms
   *
   * 而且 40 帧手势里 DOM 只改了 80 次（正好 2 次/帧 = 两层 transform），
   * 说明「改 DOM」本身极便宜，**贵的是那 800 个 MindNode 组件的 diff**。
   *
   * 所以手势期间只做两件事：改两个 transform 属性、把最新值记在 ref 里；
   * 手势结束才提交一次 state。这样每帧成本与节点数**无关**。
   */
  const worldSvgRef = useRef(null)     // <g> 图层（连线）
  const worldNodeRef = useRef(null)    // 节点图层
  const liveViewRef = useRef(null)     // 手势进行中的权威 view（非 null 表示手势中）

  /** 直接把 view 画到 DOM 上，不触发任何 React 渲染 */
  const paintView = useCallback((v) => {
    const nodeT = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`
    if (worldNodeRef.current) worldNodeRef.current.style.transform = nodeT
    if (worldSvgRef.current) {
      worldSvgRef.current.setAttribute('transform', `translate(${v.x}, ${v.y}) scale(${v.zoom})`)
    }
  }, [])

  /*
   * 【千万别在这里加 will-change: transform】
   * 直觉上「给正在做 transform 动画的层加 will-change，让它上合成层」是对的，
   * 但这里**实测是反的**（800 节点 + 2.6x dpr + 4 倍 CPU 降速）：
   *
   *     加 will-change：平移 48fps / p95 33ms / 掉帧 18
   *     不加：          平移 55fps / p95 17ms / 掉帧  1
   *                     捏合 57fps / p95 17ms / 掉帧  2
   *
   * 原因：这一层是「800 个节点铺在一大片世界坐标上」，提升成合成层意味着
   * 要一次性栅格化整块巨幅纹理；而**不**提升时 Chromium 会把它切块，
   * 每帧只重画视口覆盖到的那几块 —— 对于这种「层很大、视口很小」的场景，
   * 分块局部重绘远比整层合成便宜。
   * 结论：p95 从 50ms 降到 17ms，掉帧从 40 降到 1。
   */
  const beginGesture = useCallback(() => {
    /*
     * 画布一开始平移/缩放，就通知外面把右键菜单收掉。
     *
     * 菜单是按**屏幕像素**定位的（fixed），它不知道画布动了 ——
     * 只要画布一移动，菜单就指向空气了。而且用户滑动画布时的意图
     * 明确是「看别处」，菜单留着只会挡住视线。
     * 必须在这里（手势起点）通知，不能等手势结束提交 view 时再通知 ——
     * 那样拖动全程菜单都还挂在那儿。
     */
    onViewGestureStart?.()
    if (liveViewRef.current) return
    liveViewRef.current = { ...view }
  }, [view, onViewGestureStart])

  const endGesture = useCallback(() => {
    const v = liveViewRef.current
    liveViewRef.current = null
    if (v) onViewChange(v)      // 手势结束才提交一次 state
  }, [onViewChange])

  /*
   * 手势进行中，任何一次 React 重渲染之后都要把「实时 view」重新贴回去。
   * 不加这一步的话，别的状态变化（比如选中节点、拖拽落点变化）会让
   * React 用手势开始前的旧 view 覆盖掉我们刚画的 transform —— 画面会跳回去。
   * 没有依赖数组 = 每次渲染都跑，成本只有两次属性写入。
   */
  useLayoutEffect(() => {
    if (liveViewRef.current) paintView(liveViewRef.current)
  })

  /* ---------- 滚轮缩放 / 平移 ---------- */
  /*
   * 【滚轮直接缩放，不按 Ctrl】
   *
   * 这里改过两轮，最后定在「滚轮 = 缩放」，理由如下。
   *
   * 第一轮：判据是 `e.ctrlKey || e.metaKey || Math.abs(deltaY) > Math.abs(deltaX)`。
   * 后半个条件让任何以纵向为主的滚轮都走缩放分支 —— 鼠标滚轮和触控板两指纵向
   * 滑动几乎全是 deltaX≈0、deltaY≠0，于是「滚动」=「缩放」，用户原话是
   * 「进行操作时不要改变缩放大小」，要求改掉。
   *
   * 第二轮（就是上一版）：改成只有 Ctrl/⌘+滚轮才缩放，普通滚轮平移。
   * 但这和折角预览（useFoldPreview）、打印预览的滚轮行为**不一致**，用户本轮
   * 明确要求「滚轮键是放大和缩小，如果要滑动直接用鼠标滑就行了，两个视图都是
   * 这样的，但思维导图不是这样的」——「两个视图」指折角预览和打印预览，
   * 它们是滚轮即缩放；思维导图必须跟上。
   *
   * 所以现在三个视图统一：**滚轮即缩放，平移用拖拽**。
   * 缩放入口一个都没少：滚轮、双指捏合（浏览器把捏合伪装成 ctrlKey=true，
   * 见下面 onTouchStart 之外的那条注释）、左下角 ＋ / − 按钮。
   * 平移入口：空白处拖拽（本文件顶部第 10 行那条交互），一步都没丢。
   *
   * 锚点仍然是光标：缩放前后「光标下的那个点」屏幕位置不动。
   */
  const onWheel = useCallback((e) => {
    e.preventDefault()
    const rect = wrapRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top

    /*
     * 触控板捏合伪装成 ctrlKey=true 的 wheel，deltaY 只有 1~10（一帧），
     * 而鼠标滚轮一格 deltaY≈100。用同一个系数的话捏合会快得没法用，
     * 所以捏合走更细的步长 —— 两个常量都来自 previewConfig.js，与折角预览同源。
     */
    const step = e.ctrlKey || e.metaKey ? TRACKPAD_WHEEL_STEP : WHEEL_STEP
    const factor = Math.exp(-e.deltaY * step)
    const nz = clampZoom(view.zoom * factor)
    if (nz === view.zoom) return   // 已经顶到上下限，不再触发无意义的重渲染
    const k = nz / view.zoom
    onViewChange({
      x: px - (px - view.x) * k,
      y: py - (py - view.y) * k,
      zoom: nz,
    })
  }, [view, onViewChange])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // 触摸板双指捏合（移动端 / Mac 触控板）
  const pinch = useRef(null)
  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches
      const rect = wrapRef.current.getBoundingClientRect()
      const mx = (a.clientX + b.clientX) / 2
      const my = (a.clientY + b.clientY) / 2
      /*
       * 捏合要**以双指中点为锚点**，否则内容会从手指底下溜走。
       * 做法：手势开始时把「中点按住的那个世界坐标」算出来，之后每一帧
       * 都让这个点重新落回当前中点 —— 这样同时得到了「锚点缩放」和
       * 「双指拖动平移」两件事。
       *
       * 原来只改 zoom、不动 x/y，等于永远绕视口左上角缩放，
       * 手机上捏合时内容会往一角跑，是明显的手感问题。
       */
      pinch.current = {
        d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        zoom: view.zoom,
        rectLeft: rect.left,
        rectTop: rect.top,
        wx: (mx - rect.left - view.x) / view.zoom,
        wy: (my - rect.top - view.y) / view.zoom,
      }
      beginGesture()
    }
  }
  const onTouchMove = (e) => {
    const p = pinch.current
    if (e.touches.length === 2 && p) {
      e.preventDefault()
      const [a, b] = e.touches
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const nz = clampZoom(p.zoom * (d / p.d))
      const mx = (a.clientX + b.clientX) / 2 - p.rectLeft
      const my = (a.clientY + b.clientY) / 2 - p.rectTop
      const v = { x: mx - p.wx * nz, y: my - p.wy * nz, zoom: nz }
      liveViewRef.current = v
      paintView(v)
    }
  }
  const onTouchEnd = () => {
    if (pinch.current) { pinch.current = null; endGesture() }
  }

  /* ---------- 平移 / 节点拖拽 ---------- */
  const onBackgroundPointerDown = (e) => {
    /*
     * 点在节点上 → 一律放行，交给节点自己的 handler。
     *
     * 【这个判断必须在 linkMode 之前】
     * 事件是从节点冒泡上来的，所以「点节点」也会走到这里。
     * 早先把 linkMode 的取消放在最前面，于是连线模式下点目标节点时：
     *   pointerdown 冒泡到这里 → 判定为「点了空白」→ 取消连线模式
     *   click 再到达节点        → 此时 linkMode 已是 null → 只选中，不汇聚
     * 结果是「点了一下，提示条消失，什么都没生成」—— 功能整个失效。
     * 两个事件之间 React 会提交 state，所以 click 看到的确实是新值。
     */
    if (e.target?.closest?.('[data-node-id]')) return

    // 连线模式下，点真正的空白 = 取消，而不是开始平移
    if (linkMode) {
      if (e.button !== 0) return
      onLinkCancel?.()
      return
    }

    if (e.button !== 0 && e.button !== 1) return

    // 中键或左键空白 → 平移
    drag.current = {
      mode: 'pan',
      startX: e.clientX,
      startY: e.clientY,
      viewX: view.x,
      viewY: view.y,
    }
    beginGesture()
    capturePointer(wrapRef.current, e.pointerId)
  }

  const onNodePointerDown = (e, node) => {
    if (e.button !== 0) return
    /*
     * 连线模式下点节点 = 选定目标，绝不能让拖拽逻辑接手。
     *
     * 走到这里说明节点自己的 onPointerDown 先跑了（它挂在节点上），
     * 所以这里必须直接 return —— 不设 drag.current，后续的
     * onPointerMove / onPointerUp 拿不到状态，就不会触发拖拽。
     * 真正的「选中目标」在 onClick 里做（见 MindNode 的 onClick）。
     */
    if (linkMode) return

    /*
     * 手机端：**严禁拖拽节点改层级**，改成长按弹菜单。
     *
     * 三个理由：
     *   1. 手指按在节点上到底是想拖、想滚画布、还是想弹菜单，本来就分不清；
     *   2. 拖拽改层级是「不可逆的破坏性操作」，误触代价太大（层级被改了很难发现）；
     *   3. 手机上没有右键，菜单需要一个入口 —— 长按是移动端的通用语言。
     *
     * 防误触：500ms 内手指移动超过 10px 就立刻取消长按（见 onPointerMove）。
     * 这条是必须的 —— 用户想平移画布时手指经常正好落在节点上，
     * 没有位移阈值的话每拖一次画布都会弹出一个菜单。
     */
    if (mobile) {
      const timer = setTimeout(() => {
        longPress.current = null
        onLongPress?.(e.clientX, e.clientY, node)
      }, LONG_PRESS_MS)
      longPress.current = { nodeId: node.id, x: e.clientX, y: e.clientY, timer }
      return
    }

    // 防误触：先记录候选，必须满足「位移 > 6px」或「按住 > 180ms」才真正进入拖拽
    drag.current = {
      mode: 'pending',
      nodeId: node.id,
      startX: e.clientX,
      startY: e.clientY,
      at: Date.now(),
    }
    capturePointer(e.currentTarget, e.pointerId)
  }

  /** 判断 id 是否是 ancestorId 的后代（防止把父节点拖进自己的子树形成环） */
  const isDescendantOf = useCallback((ancestorId, id) => {
    let cur = byId.get(id)
    while (cur?.parentId) {
      if (cur.parentId === ancestorId) return true
      cur = byId.get(cur.parentId)
    }
    return false
  }, [byId])

  /**
   * 根据指针在目标节点里的相对高度，判断松手后是插到它前面 / 后面 / 还是成为它的子节点。
   *   · 上 30%  → before（成为上一个兄弟）
   *   · 下 30%  → after （成为下一个兄弟）
   *   · 中间 40% → child （成为子节点，在横向树里就是往右缩进一层）
   *
   * 注意 rel 允许超出 [0,1]：命中的是「最近的节点」而不是严格落在框内的节点，
   * 所以指针在节点上方的间隙里时 rel < 0，自然判为 before。
   */
  const dropPositionAt = (target, wy) => {
    // 根节点没有兄弟，插前插后都无处可放 → 一律当作「成为子节点」
    if (!target.parentId) return 'child'
    const rel = (wy - target.y) / target.h
    if (rel < 0.3) return 'before'
    if (rel > 0.7) return 'after'
    return 'child'
  }

  /**
   * 找落点：取**最近的**节点，而不是要求指针严格落在节点框内。
   *
   * 这是「无法插到上面」的根因：兄弟节点之间有 GAP_Y(22px) 的间隙，
   * 而 fitView 之后 zoom 常只有 0.7 —— 上 30% 区域在屏幕上只有 7px 高，
   * 想插到上面几乎点不中，稍微偏一点还会完全找不到落点。
   * 改成按距离吸附后，节点上方/下方的间隙都算作 before / after 区域。
   */
  const findDropTarget = useCallback((wx, wy, dragId) => {
    let best = null
    let bestDist = Infinity
    for (const n of nodes) {
      if (n.id === dragId) continue
      if (isDescendantOf(dragId, n.id)) continue
      // 点到矩形的最短距离
      const dx = Math.max(n.x - wx, 0, wx - (n.x + n.w))
      const dy = Math.max(n.y - wy, 0, wy - (n.y + n.h))
      const dist = Math.hypot(dx, dy)
      if (dist < bestDist) { bestDist = dist; best = n }
    }
    // 离得太远就不吸附（避免把节点扔到空白处也硬塞给某个节点）
    return best && bestDist <= SNAP_RADIUS ? best : null
  }, [nodes, isDescendantOf])

  const onPointerMove = (e) => {
    /*
     * 长按防误触闸门：手指一动就取消长按。
     * 放在最前面 —— 它和下面的 drag.current 是两套独立的状态
     * （手机端走长按、桌面端走拖拽，同一个时刻只会有其中一个）。
     */
    const lp = longPress.current
    if (lp) {
      if (Math.hypot(e.clientX - lp.x, e.clientY - lp.y) <= LONG_PRESS_MOVE_TOLERANCE) return
      /*
       * 超过阈值 = 用户想拖，不是想长按。
       *
       * 【这里必须把手势「交接」给画布平移，而不是简单 return】
       * 手机端的节点上没有 drag.current（拖拽改层级已被禁用），
       * 如果只是取消长按就返回，那用户从节点上开始拖画布会**完全没有反应** ——
       * 手指在节点上时画布不动、在空白处才动，这个不一致会被当成「卡了」。
       * 所以把起点接过来当成一次平移：手指压着节点也能拖动画布。
       */
      clearTimeout(lp.timer)
      longPress.current = null
      drag.current = {
        mode: 'pan',
        startX: lp.x,
        startY: lp.y,
        viewX: view.x,
        viewY: view.y,
      }
      beginGesture()
      // 刻意不 return：下面同一帧就把这段位移画出去，手感没有延迟
    }

    const d = drag.current
    if (!d) return

    if (d.mode === 'pan') {
      // 手势中：只写 DOM，不 setState（每帧成本与节点数无关）
      const v = { x: d.viewX + (e.clientX - d.startX), y: d.viewY + (e.clientY - d.startY), zoom: view.zoom }
      liveViewRef.current = v
      paintView(v)
      return
    }

    if (d.mode === 'pending' || d.mode === 'dragging') {
      const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY)
      if (d.mode === 'pending') {
        // 防误触闸门：位移够大 或 按住够久
        if (dist < 6 && Date.now() - d.at < 180) return
        d.mode = 'dragging'
        setDraggingId(d.nodeId)   // 只在这里 setState 一次，进入拖拽态
      }

      // 幽灵跟随鼠标：直接改 DOM，避免每帧 re-render 整个画布
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`
      }

      const rect = wrapRef.current.getBoundingClientRect()
      // 用实时 view（平移手势可能刚改过它），而不是闭包里的旧 view
      const v = liveViewRef.current || view
      const wx = (e.clientX - rect.left - v.x) / v.zoom
      const wy = (e.clientY - rect.top - v.y) / v.zoom

      const hit = findDropTarget(wx, wy, d.nodeId)
      const next = hit ? { targetId: hit.id, position: dropPositionAt(hit, wy) } : null

      // 只有落点真的变了才 setState（拖动时绝大多数帧都不变）
      const prev = dropRef.current
      if (prev?.targetId !== next?.targetId || prev?.position !== next?.position) {
        dropRef.current = next
        setDrop(next)
      }
    }
  }

  const onPointerUp = () => {
    // 松手时若长按还没触发，取消它（短按 = 选中，不是弹菜单）
    const lp = longPress.current
    if (lp) {
      clearTimeout(lp.timer)
      longPress.current = null
    }

    const d = drag.current
    drag.current = null
    if (!d) return

    if (d.mode === 'pan') {
      // 手势结束 → 提交一次 state（整个手势只有这一次 React 渲染）
      endGesture()
      return
    }

    if (d.mode === 'dragging') {
      const target = dropRef.current
      if (target) onDropNode?.(d.nodeId, target.targetId, target.position)
      dropRef.current = null
      setDrop(null)
      setDraggingId(null)
    } else if (d.mode === 'pending') {
      /*
       * 没达到拖拽阈值 → 视为点击选中。
       *
       * 连线模式下**这里什么都不做**：选目标统一由 click 事件处理
       * （见 handleNodeClick）。两处都做的话，pointerup 先选一次、
       * click 再选一次 —— 第二次的闭包里 linkMode 还是旧值，
       * 会对着同一个目标重复发起一次汇聚，用户看到的是「已存在汇聚关系」。
       */
      if (!linkMode) onSelect?.(d.nodeId)
    }
  }

  /* ---------- 放置引导线（2px 蓝色实线，不用虚线框） ---------- */
  // 中间区域（成为子节点）用「目标节点整体高亮」表示，
  // 上/下区域用一条横线表示插入位置 —— 三种语义一眼可分。
  const dropIndicator = (() => {
    if (!drop || drop.position === 'child') return null
    const t = byId.get(drop.targetId)
    if (!t) return null
    const GAP = 5
    const y = drop.position === 'before' ? t.y - GAP : t.y + t.h + GAP
    return { x1: t.x, y1: y, x2: t.x + t.w, y2: y }
  })()

  const draggedItem = draggingId ? byId.get(draggingId) : null

  /* ---------- 汇聚虚线（指向同一结果） ---------- */

  /**
   * 悬停的节点 id。虚线超过阈值时用它做「只显示相关线」的过滤。
   *
   * 不用 `selectedId` 而用一个独立的 hover：用户在看一堆线的时候，
   * 鼠标划过哪个节点就该亮哪几条，比「先选中再看」少一步。
   */
  const [hoverId, setHoverId] = useState(null)

  /**
   * 节点点击。
   *
   * 【这里必须抢在 onSelect 前面】
   * 连线模式下点节点表达的是「选它当目标」，不是「选中它」。
   * 两者都改状态，必须先判连线模式再分流，否则会出现
   * 「目标选好了，同时那个节点也被选 blue 了」的双重心智。
   */
  const handleNodeClick = useCallback((id) => {
    if (linkMode) {
      if (id === linkMode.fromId) return   // 点自己无效，保持待选状态
      onLinkPick?.(id)
      return
    }
    onSelect?.(id)
  }, [linkMode, onLinkPick, onSelect])

  /**
   * 节点右键：连线模式下不允许再开菜单。
   *
   * 否则用户可以在待选目标时右键另起一个「指向同一结果」，
   * 两个待选状态叠在一起，之后点的那个节点该算谁的完全说不清。
   */
  const handleNodeContextMenu = useCallback((e, node) => {
    if (linkMode) { e.preventDefault(); return }
    onContextMenu?.(e, node)
  }, [linkMode, onContextMenu])

  /**
   * 虚线是否进入「按需显示」模式。
   *
   * 全量虚线在节点图上很贵：每条都要 join 两个布局节点、算贝塞尔、
   * 生成一个 <path>。50 条以上时它们会和节点连线抢绘制预算，
   * 平移/捏合就会掉帧。此时默认只画「和当前悬停节点相关」的那几条。
   *
   * 阈值判断放在这里而不是调用方：调用方只管存数据，
   * 「多到什么程度才需要省」是纯渲染决策。
   */
  const relationCount = relations.length
  const hideAllRelations = relationCount > RELATION_HIDE_THRESHOLD && !linkMode

  /**
   * 真正要画的虚线。
   *
   * 三重过滤，缺一不可：
   *   1. 两端节点都必须在布局里（折叠起来的子树不在 nodes 里 → 查不到）
   *   2. 按需模式下只留与悬停节点相关的
   *   3. 自环直接丢掉（A→A 没有意义，画出来是个点）
   */
  const relationEdges = useMemo(() => {
    if (!relationCount) return []
    /*
     * 超过阈值时默认一条都不画，只有悬停到某个节点才画与它相关的那几条。
     * 这里用 relationsOf 直接**取出子集**，而不是「全量扫描 + 过滤」：
     * 除了省掉无谓的遍历，更重要的是「什么算和某节点相关」只在
     * treeOps.relationsOf 里定义一次，渲染层不再自己判一遍。
     */
    let list = relations
    if (hideAllRelations) {
      if (!hoverId) return []
      list = relationsOf(relations, hoverId)
    }
    const out = []
    for (const r of list) {
      if (!r || r.from === r.to) continue
      const a = byId.get(r.from)
      const b = byId.get(r.to)
      // 端点被折叠隐藏时跳过：布局里没有它，画不出来
      if (!a || !b) continue
      out.push({
        key: `${r.from}\u0000${r.to}`,
        a,
        b,
        // 悬停相关时加粗一点，在一堆线里才分得清哪条是被唤起的
        hot: !!hoverId && (hoverId === r.from || hoverId === r.to),
      })
    }
    return out
  }, [relations, relationCount, byId, hideAllRelations, hoverId])

  /** 连线模式下的「源节点」高亮 */
  const linkFromId = linkMode?.fromId ?? null

  /**
   * 汇聚结果节点 → 要不要**藏掉它的树边**。
   *
   * 【问题】
   * 「指向同一结果」生成的新节点 C 是挂在 LCA(A,B) 底下的一个真实树节点
   * （见 treeOps.convergeToNewNode）。所以画面上会出现三条指向 C 的线：
   *
   *     A ─┐
   *     B ─┼─→ C      ← A→C、B→C 是 relations 画的
   *     P ─┘          ← P→C 是树自己那条边（P = A、B 的公共父节点）
   *
   * 用户看到的就是「多出来一条线，而且是从更高一层来的」——
   * 那条线没有表达任何用户没说过的东西：C 在树里必须有个位置，
   * 但它和 P 之间并不存在用户想要的父子关系，P→C 纯粹是「为了放下它」。
   *
   * 【判据】
   * 一个节点只要有 **≥2 条 relations 指向它**，它就是汇聚结果：
   * 它的入边由那两条（或更多）关系完整表达，树边是冗余的。
   * 用「≥2」而不是「是不是汇聚生成的」是有意的：
   *   · 不需要在数据模型里加标记，纯渲染决策；
   *   · 万一其中一条关系后来被剪掉（删了源节点），只剩一条入边时
   *     树边会自动重新出现 —— 节点不会变成没人指向的孤岛。
   *
   * 【为什么基于 relationEdges 而不是 relations 全量】
   * relationEdges 是**真正画出来的**那批（已经滤掉悬空端点、自环、
   * 以及「线太多时按需显示」被隐藏的）。藏树边必须和画关系边同步：
   * 否则线多的时候关系边被隐藏、树边又被我们藏掉，C 就成了孤岛。
   */
  const convergenceTargets = useMemo(() => {
    const count = new Map()
    for (const r of relationEdges) {
      const to = r.b.id
      count.set(to, (count.get(to) || 0) + 1)
    }
    const out = new Set()
    for (const [to, n] of count) if (n >= 2) out.add(to)
    return out
  }, [relationEdges])

  /** 连线模式下，鼠标所在节点是不是可选的合法目标 */
  const linkTargetOk = (id) => !!linkMode && id !== linkFromId

  return (
    <div
      ref={wrapRef}
      data-canvas-wrap
      // 当前落点：测试和排查「拖到哪儿去了」时唯一可靠的来源
      data-drop-target={drop?.targetId || undefined}
      data-drop-pos={drop?.position || undefined}
      className={`absolute inset-0 overflow-hidden ${radarMode ? 'mf-radar' : ''}`}
      style={{
        background: 'var(--mf-canvas)',
        touchAction: 'none',
        // 悬停节点时是张开的小手，按住拖拽时是攥紧的小手
        // 连线模式下一律是十字准星 —— 这是「请点一个目标」最通用的视觉语言
        cursor: linkMode ? 'crosshair' : (draggingId ? 'grabbing' : 'default'),
      }}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <svg className="absolute inset-0 pointer-events-none" width="100%" height="100%">
        <defs>
          <marker id="mf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--mf-edge)" />
          </marker>
          {/*
            汇聚连线复用了上面这个 mf-arrow。
            原来这里还有一个独立的 mf-rel-arrow（蓝色箭头），
            改成实线统一之后它已无引用，删掉 —— 留着的话
            每个主题都会多渲染一个永远用不上的 marker。
          */}
        </defs>
        <g
          ref={worldSvgRef}
          transform={`translate(${view.x}, ${view.y}) scale(${view.zoom})`}
        >
          {/*
            连接线：极浅灰柔和曲线；米黄主题下自动变暖褐（由 CSS 变量接管）。

            汇聚结果节点的那条树边会被跳过：它的入边已经由 relations 画了出来，
            树边只会让用户看到「凭空多出一条、还是从更高一层来的线」。
            判据见上面的 convergenceTargets。
          */}
          {edges.map((e) => {
            if (convergenceTargets.has(e.to)) return null
            const a = byId.get(e.from)
            const b = byId.get(e.to)
            if (!a || !b) return null
            return (
              <path
                key={`${e.from}-${e.to}`}
                className="mf-edge"
                d={edgePath(a, b)}
                fill="none"
                stroke="var(--mf-edge)"
                strokeWidth={1.6}
                strokeLinecap="round"
              />
            )
          })}

          {/*
            汇聚连线（「指向同一结果」）。
            画在树边之后、放置引导线之前：它属于「结构性」的连线，
            该压在引导线之下；但要在树边之上，才能看清谁汇聚到谁。

            【已改为与普通树边完全一致的实线】
            原来是「蓝色 #3b82f6 + 5,5 虚线 + 独立箭头」。虚线在视觉上
            表达的是「不确定 / 弱关系」，而多对一汇聚其实和普通父子边一样
            是**确定的**结构关系 —— 用虚线反而让人以为它随时会消失。
            现在统一成实线：同样的 var(--mf-edge) 颜色、同样的 1.6 线宽、
            同样的 edgePath 贝塞尔曲线和 mf-arrow 箭头，
            接在树边后面画出来，看上去就是普通连线，不做任何特殊区分。
          */}
          {relationEdges.map((r) => (
            <path
              key={`rel-${r.key}`}
              data-relation-edge={r.key}
              d={edgePath(r.a, r.b)}
              fill="none"
              stroke="var(--mf-edge)"
              strokeWidth={1.6}
              strokeLinecap="round"
              markerEnd="url(#mf-arrow)"
              // 悬停相关时略作强调，在「按需显示」模式下才分得清哪条是被唤起的
              opacity={r.hot ? 1 : 0.85}
            />
          ))}

          {/* 放置引导线：2px 蓝色实线 + 两端小圆点，克制、只表达「会插在哪一行」 */}
          {dropIndicator && (
            <g className="mf-drop-line">
              <line
                x1={dropIndicator.x1}
                y1={dropIndicator.y1}
                x2={dropIndicator.x2}
                y2={dropIndicator.y2}
                stroke="var(--mf-accent)"
                strokeWidth={2}
                strokeLinecap="round"
              />
              <circle cx={dropIndicator.x1} cy={dropIndicator.y1} r={2.5} fill="var(--mf-accent)" />
              <circle cx={dropIndicator.x2} cy={dropIndicator.y2} r={2.5} fill="var(--mf-accent)" />
            </g>
          )}
        </g>
      </svg>

      {/* 节点层：用 transform 保持与 SVG 完全一致的坐标系 */}
      <div
        ref={worldNodeRef}
        className="absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      >
        {nodes.map((item) => (
          <MindNode
            key={item.id}
            item={item}
            selected={selectedId === item.id}
            isEditing={editingId === item.id}
            isDragging={draggingId === item.id}
            // 中间区域 = 成为子节点 → 给目标节点整体加高亮边框
            dropHighlight={drop?.position === 'child' && drop.targetId === item.id}
            // 连线模式：源节点实心高亮，其他节点淡淡地「可点」
            linkSource={linkFromId === item.id}
            linkCandidate={linkTargetOk(item.id)}
            zoom={view.zoom}
            onSelect={handleNodeClick}
            onToggleCollapse={onToggleCollapse}
            onOpenFold={onOpenFold}
            onStartEdit={onStartEdit}
            onCommitEdit={onCommitEdit}
            onContextMenu={handleNodeContextMenu}
            onPointerDownNode={onNodePointerDown}
            onHover={setHoverId}
          />
        ))}
      </div>

      {/*
        连线模式提示条。
        固定在画布顶部居中，不参与 world 变换 —— 它是「操作状态指示」，
        跟着画布缩放/平移跑掉的话，用户一拖就找不到自己在干什么了。
        pointer-events-none：不能挡住下面节点的点击。
      */}
      {linkMode && (
        <div
          data-link-hint
          data-link-kind={linkMode.kind}
          className="pointer-events-none absolute left-1/2 z-40 -translate-x-1/2 rounded-full border px-4 py-1.5 text-[12.5px] shadow-card mf-fade whitespace-nowrap"
          style={{
            /* 画布铺满全屏，top-3（12px）正好落在手机状态栏里 —— 走安全区 */
            top: 'var(--mf-top-gap)',
            maxWidth: 'calc(100vw - 24px)',
            background: 'var(--mf-panel)',
            borderColor: '#3b82f6',
            color: 'var(--mf-ink)',
          }}
        >
          {linkMode.kind === 'merge' ? '请点击要汇聚的目标节点' : '请点击要指向的节点'}
          <span className="ml-2" style={{ color: 'var(--mf-muted)' }}>· 点空白或 Esc 取消</span>
        </div>
      )}

      {/*
        拖拽幽灵：跟着鼠标飘的半透明副本。
        放在画布根节点下（不在被 transform 的图层里），所以 fixed 定位就是屏幕坐标。
        位置直接改 style.transform，不触发 re-render。
      */}
      {draggedItem && (
        <div
          ref={ghostRef}
          data-drag-ghost
          className="pointer-events-none fixed left-0 top-0 z-30"
          style={{ transform: 'translate(-9999px, -9999px)' }}
        >
          <div
            className="rounded-lg border px-3 py-1.5 text-[14px] leading-tight"
            style={{
              maxWidth: 240,
              // 半透明 + 浅阴影 = 「飘起来」而不是实心框跟着跑
              opacity: 0.5,
              background: 'var(--mf-panel)',
              borderColor: 'var(--mf-accent)',
              color: 'var(--mf-ink)',
              boxShadow: '0 8px 24px -6px rgba(0,0,0,.22)',
              // 让指针落在幽灵的中心偏左，视觉上更像「抓着它」
              transform: 'translate(-16px, -50%)',
            }}
          >
            <span className="line-clamp-2">{draggedItem.node.text}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function clampZoom(z) {
  return Math.min(2.5, Math.max(0.15, z))
}

/**
 * 落点吸附半径（画布坐标）。
 * 指针离任何节点都在这个距离之外就不认落点，避免把节点丢到空白处也硬塞给某个节点。
 * 取 56 大约是「一个节点高度 + 一个间隙」，够宽松也够克制。
 */
const SNAP_RADIUS = 56

/**
 * 手机端长按弹菜单的时长。
 * 500ms 是移动端的通行值（iOS 是 500ms，Android 是 400~500ms）——
 * 比这短会误触，比这长用户会以为「按了没反应」。
 */
const LONG_PRESS_MS = 500

/**
 * 长按期间允许的抖动。
 * 超过 10px 就认定「用户是想滑动，不是想长按」，立刻取消。
 * 手指按住不动时天然会有 1~3px 的抖动，所以不能是 0。
 */
const LONG_PRESS_MOVE_TOLERANCE = 10

/**
 * 安全地捕获指针。
 * setPointerCapture 在指针已释放、pointerId 无效等情况下会抛
 * NotFoundError / InvalidStateError；拖拽本身不依赖捕获也能工作，
 * 所以这里吞掉异常，不让它冒成未捕获错误。
 */
function capturePointer(el, pointerId) {
  if (!el?.setPointerCapture || pointerId === undefined) return
  try { el.setPointerCapture(pointerId) } catch { /* 忽略：不影响拖拽逻辑 */ }
}