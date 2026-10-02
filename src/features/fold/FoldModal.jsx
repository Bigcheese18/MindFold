import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import {
  outlineToMermaid, parseOutline, mermaidToOutlineEx, foldColor, stripRefs, scanRefs, formatRef,
  SHAPES, isShape, shapeAtOutlineRow, setShapeInOutline,
} from '../../lib/model'
import {
  setRowLabelText, insertSiblingText, insertChildText, deleteRowText,
} from '../../lib/outlineOps'
import {
  setNodeLabelInCode, getNodeLabelInCode,
  insertNodeInCode, deleteNodeInCode, DEFAULT_MERGE_LABEL,
  setShapeInCode,
} from '../../lib/codeOps'
import { renderMermaid, syntaxTip } from '../../lib/mermaid'
import { initHistory } from '../../lib/history'
import { useDebouncedCallback } from '../../lib/hooks'
import { capturePointer } from '../../lib/dom'
import OutlineList from '../outline/OutlineList'
import {
  /*
   * LinkIcon / GitMergeIcon 随手机端底部「指向」操作栏一起删掉了 ——
   * 那两颗按钮的图标现在只在 NodeContextMenu 里用，那边自带一份。
   */
  AlertIcon,
  ZoomInIcon, ZoomOutIcon, FitScreenIcon,
} from '../../components/icons'

import { parseDirection, sameOutlineShape, withDirection } from './foldCode'
import {
  MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE, ZOOM_BTN_STEP,
  MIN_PREVIEW_H, MERMAID_NODE_CLASS,
} from './previewConfig'
import { useFoldHistory } from './useFoldHistory'
import { useFoldMove } from './useFoldMove'
import { useFoldHighlight } from './useFoldHighlight'
import { useFoldPreview } from './useFoldPreview'
import { useFoldLinking } from './useFoldLinking'
import FloatingLabelEditor from './LabelEditor'
import PreviewBridge from './PreviewBridge'
import NodeContextMenu from './NodeContextMenu'
import CodeEditor from './CodeEditor'
import { ZoomBtn, SegTabs, UndoButton } from './FoldButtons'

/**
 * 全屏折角弹窗 —— 流程图预览 & 编辑
 * ==================================
 * PRD 关键点逐条落地：
 *   · 从折角位置「放大铺满」，0.2s（CSS .mf-unfold + transform-origin 定位到折角）
 *   · 电脑左右分栏 / 手机上下分栏
 *   · 傻瓜模式：左侧写树状缩进列表 → 自动编译 Mermaid → 右侧实时渲染
 *   · 语法报错：出错的整行标红波浪线，右侧保留上一版正确的图（绝不消失），行尾小问号气泡
 *   · 预览区：滚轮缩放、右键拖拽平移、横向滚动（长图不缩字号）
 *   · 自动保存：停笔 1 秒后静默写入
 *
 * 【这个文件现在只负责三件事】
 *   1. 编排：把下面几个 Hook 串起来，管好「谁先谁后」
 *   2. 文本层：缩进列表 ⇄ Mermaid 源码的双向同步
 *   3. 布局：分栏 / 窄屏单面板 / 顶栏底栏的 JSX
 * 具体能力都拆到了同目录的模块里：
 *   useFoldHistory  撤销重做   useFoldHighlight 双向高亮联动
 *   useFoldPreview  缩放平移   useFoldMove      代码顺序换位
 *   useFoldLinking  指向/汇聚   CodeEditor / NodeContextMenu / LabelEditor …
 */
export default function FoldModal({
  node,
  origin,              // { x, y } 折角在屏幕上的坐标，用于 transform-origin
  onClose,
  onSave,              // (mermaid, outline) => void
  onResetFamiliarity,
}) {
  const [mode, setMode] = useState('outline')      // 'outline' | 'code'
  const [outline, setOutline] = useState(node.fold?.outline || '')
  const [code, setCode] = useState('')
  const [direction, setDirection] = useState('TD')
  const [svg, setSvg] = useState('')               // 当前显示的图（永远是「上一版正确的」）
  const [error, setError] = useState(null)         // { message, line, tip }
  const [rendering, setRendering] = useState(false)
  const [saved, setSaved] = useState(false)
  const [flash, setFlash] = useState(false)

  /* ---- 双轨制：两侧的同步状态 ---- */
  // 行下标 → mermaid 节点 id。点图定位行、悬停联动都靠它。
  // 缩进模式下 id 恒为 n<下标>；代码模式下是用户自己写的 id（A/B/C…），
  // 这时只有反推出来的映射才能把「图上的节点」对到「左边的行」。
  const [rowIds, setRowIds] = useState([])
  // mermaidToOutlineEx 的结果：警告 / 复杂度 / 是否建议代码模式
  const [codeInfo, setCodeInfo] = useState(null)
  // 代码没法反推成缩进列表（用户写了缩进列表表达不了的东西）
  const [outlineStale, setOutlineStale] = useState(false)

  /* ---- 右侧流程图 ↔ 左侧缩进列表 的双向联动 ---- */
  // 选中状态用 **mermaid 节点 id** 而不是行下标（理由见 useFoldHighlight）
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  const [labelEditor, setLabelEditor] = useState(null)   // 悬浮改字框
  const [nodeMenu, setNodeMenu] = useState(null)         // 右键菜单：{ idx, id, x, y }

  /* ---- 布局 ---- */
  const [leftRatio, setLeftRatio] = useState(0.5)
  const [stacked, setStacked] = useState(false)          // 窄屏：单面板模式
  /*
   * 手机端当前显示哪个面板。
   *
   * 【为什么手机端必须是「二选一」而不是上下分栏】
   * 上下分栏在手机上必然崩：键盘弹起时可视高度只剩一半，
   * 两个面板各分到 1/4，编辑器只剩几行，预览区几乎为零；
   * 而且分栏的高度是 flex 平分的，键盘一弹两个面板同时重排，抖动非常明显。
   * 改成一次只显示一个面板：预览时看全图，编辑时全屏写代码，互不干扰。
   *
   * 默认 'preview' —— 打开折角的第一诉求是「看这张图」。
   */
  const [mobilePane, setMobilePane] = useState('preview')
  const [bodyWidth, setBodyWidth] = useState(0)
  /*
   * 桌面端「收起左侧编辑区」。
   *
   * 【为什么要有它】
   * 用户的原话是「可以把左边的编辑区域关闭，只留右边的区域，然后右边的区域
   * 放大到全屏，像思维导图一样。需要的时候再打开，变成双屏」。桌面双栏下
   * 预览只拿到一半宽度，看一张宽图要么缩得很小、要么左右拖着看；收起之后
   * 预览独占整个弹窗宽度，就是思维导图那种全屏观感。
   *
   * 【为什么这个 state 在手机端不参与任何判断】
   * 手机端（stacked）本来就只有一块面板，靠顶部的「预览 / 编辑」二选一；
   * 再叠一层「收起」等于把编辑区彻底锁死，用户找不到入口。
   * 所以下面所有用到它的地方都先判 `!stacked` —— 手机端的行为一个像素都不变。
   *
   * 【为什么不持久化】
   * 这是一次会话内的临场视图偏好（「我现在只想看图」），不是文档属性；
   * 关掉弹窗再打开时回到双栏，用户不会遇到「我的编辑区怎么不见了」。
   */
  const [editCollapsed, setEditCollapsed] = useState(false)

  /* ---- 实例引用 ---- */
  const renderSeq = useRef(0)
  const previewRef = useRef(null)      // SVG 宿主：所有 g.node 查询都从这里进
  const viewRef = useRef(null)         // 外层容器（也是键盘焦点锚点）
  const bodyRef = useRef(null)
  const composingRef = useRef(false)   // 中文输入法组字中
  /*
   * 手机端长按节点的定时器 { x, y, timer }。
   * 参数（500ms / 10px 容差）和主画布 Canvas.jsx 完全一致 ——
   * 见下面 LONG_PRESS_* 常量的注释。
   */
  const longPressRef = useRef(null)

  const MIN_LEFT = 200
  const MIN_RIGHT = 300
  const SPLITTER_W = 4

  /*
   * 长按判据：按住不动 500ms 算长按，移动超过 10px 就取消。
   * 这两个数字**必须**和 Canvas.jsx 里那两个同名常量逐字相同 ——
   * 同一个手势在两个视图里给出不同手感，用户只会觉得「长按时灵时不灵」。
   * 没有共享常量文件是因为两处的实现（mouse 事件 vs pointer 事件）不同，
   * 但判据值一致；测试里有一条断言钉住它们相等。
   */
  const LONG_PRESS_MS = 500
  const LONG_PRESS_MOVE_TOLERANCE = 10

  /**
   * isSyncing 锁 —— 防止「右侧改字 → 左侧代码改 → 右侧重绘」引发死循环。
   *
   * 图上的结构化改动会连锁触发：改代码 → mermaid 重绘 → svg 变化 →
   * 联动 effect（反推缩进列表 / 自动弹改字框）。如果没有锁，
   * 「重绘 → 又改一次代码」就会无限循环。
   *
   * 语义：一次图上改动期间锁住，期间的联动跳过；同步处理是同步的，
   * 所以锁只在当前事件处理内持有，不会把正常流程卡住。
   */
  const isSyncingRef = useRef(false)
  const syncLock = useCallback((fn) => {
    if (isSyncingRef.current) return null
    isSyncingRef.current = true
    try { return fn() } finally { isSyncingRef.current = false }
  }, [])

  /*
   * code / outline 的「最新值镜像」。
   * 防抖提交和 applyCode 的兜底分支都要读当前值，而它们可能在
   * 事件处理器里被调用 —— 闭包里的 state 可能还没更新。
   * 渲染期直接赋值给 ref 是这里最稳的写法（只读不写，幂等）。
   */
  const codeRef = useRef(code)
  const outlineRef = useRef(outline)
  codeRef.current = code
  outlineRef.current = outline

  /*
   * 改字框的「当前值」镜像。
   * 跟着图走的回调是在库的事件里跑的，闭包里的 state 可能已经过期
   * （和 codeRef / outlineRef 同一个套路），所以渲染期同步一份。
   */
  const labelEditorRef = useRef(labelEditor)
  labelEditorRef.current = labelEditor

  /* ------------------------------------------------------------------ */
  /* 核心：编译 + 渲染，带错误兜底                                          */
  /* ------------------------------------------------------------------ */
  const doRender = useCallback(async (src) => {
    const seq = ++renderSeq.current
    setRendering(true)
    const res = await renderMermaid(src)
    // 竞态保护：只接受最后一次请求的结果
    if (seq !== renderSeq.current) return
    setRendering(false)

    if (res.ok) {
      setSvg(res.svg)                 // 只有成功才替换 → 失败时旧图自然保留
      setError(null)
    } else {
      setError({ message: res.error, line: res.line, tip: syntaxTip(res.error) })
    }
  }, [])

  /* ------------------------------------------------------------------ */
  /* 自动保存：停笔 1 秒                                                        */
  /* ------------------------------------------------------------------ */
  const autoSave = useDebouncedCallback((payload) => {
    onSave?.(payload)
    setSaved(true)
    setTimeout(() => setSaved(false), 1400)
  }, 1000)

  // 关闭前必须把未落盘的改动冲出去
  useEffect(() => () => autoSave.flush?.(), [autoSave])

  /* ------------------------------------------------------------------ */
  /* 撤销 / 重做（只作用于本弹窗内的 Mermaid 源码）                          */
  /* ------------------------------------------------------------------ */
  const {
    historyRef, histState, syncHistState, scheduleCommit, handleUndo, handleRedo,
  } = useFoldHistory({
    doRender,
    autoSave,
    syncLock,
    viewRef,
    // 快照恢复：三个要点见 useFoldHistory 的注释
    onRestore: (snap) => {
      setCode(snap.code)
      setOutline(snap.outline)
      setRowIds(snap.rowIds || [])
      setCodeInfo(mermaidToOutlineEx(snap.code))
      setOutlineStale(false)
    },
  })

  /* ------------------------------------------------------------------ */
  /* 初始化：从已有折角数据恢复                                            */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const f = node.fold
    if (!f) return
    if (f.mermaid) {
      setCode(f.mermaid)
      setDirection(parseDirection(f.mermaid))
      const ex = mermaidToOutlineEx(f.mermaid)
      // 优先用存下来的 outline；没有就从 mermaid 反推，保证「傻瓜模式」永远可用
      const savedOutline = f.outline || ''
      const shown = savedOutline || ex?.outline || ''
      setOutline(shown)
      setCodeInfo(ex)
      setOutlineStale(!savedOutline && !ex)
      /*
       * rowIds 必须是「行下标 → 图上真实节点 id」。
       * 存下来的 mermaid 完全可能是手写的（id 是 A/B/C 而不是 n0/n1）——
       * 这时按行号硬推 `n<行号>` 会全部对不上，点图定位行、悬停联动就都失效了。
       * 所以：outline 和 mermaid 反推结果结构一致时，用 mermaid 的真实 rowIds；
       * 不一致（用户在缩进模式里加了引用，结构被重排过）时，
       * 那份 mermaid 本来就是由这份 outline 编译出来的，行号推 n<行号> 才对。
       */
      const ids = ex && sameOutlineShape(shown, ex.outline)
        ? ex.rowIds
        : parseOutline(shown).map((n) => n.id)
      setRowIds(ids)
      doRender(f.mermaid)
      // 打开弹窗 = 重开一段历史（用户明确允许清空）
      historyRef.current = initHistory({ code: f.mermaid, outline: shown, rowIds: ids })
      syncHistState()
    } else {
      // 空心折角：给一个有结构的起始骨架，而不是空白。
      // 用户第一次点开折角时看到的就是这个，直接改字比从零写友好得多。
      const seed = `${node.text}\n  第一步\n  第二步`
      setOutline(seed)
      const src = outlineToMermaid(seed, 'TD')
      setCode(src)
      setDirection('TD')
      setCodeInfo(null)
      setOutlineStale(false)
      const ids = parseOutline(seed).map((n) => n.id)
      setRowIds(ids)
      doRender(src)
      historyRef.current = initHistory({ code: src, outline: seed, rowIds: ids })
      syncHistState()
    }
  }, [node.id])

  /**
   * 缩进列表 → 代码。缩进列表是这一侧的「事实来源」。
   * 同时把行→节点 id 的映射算出来，供点图定位行使用。
   *
   * @param commit 'soon' 打字（停笔 1 秒后入栈）| 'now' 结构性操作（立刻入栈）| 'skip'
   */
  const applyOutline = useCallback((text, dir = direction, commit = 'soon') => {
    const src = outlineToMermaid(text, dir)
    const ids = parseOutline(text).map((n) => n.id)
    setRowIds(ids)
    setCodeInfo(null)
    setOutlineStale(false)
    setCode(src)
    if (src) doRender(src)
    else { setSvg(''); setError(null) }
    scheduleCommit(commit, { code: src, outline: text, rowIds: ids })
    return src
  }, [direction, doRender, scheduleCommit])

  /**
   * 代码 → 缩进列表。代码是这一侧的「事实来源」。
   *
   * 这是「双轨制切换数据不丢失」的关键：用户在代码模式写的
   * A --> C / B --> C 会被反推成 (-> C) 引用写回缩进列表，
   * 所以随时切回缩进模式都不会丢边。
   * 反推不出来（语法不完整）时保留上一次的缩进列表，并标记 outlineStale。
   */
  const applyCode = useCallback((text, commit = 'soon') => {
    setCode(text)
    /*
     * 方向也要跟着代码走。
     *
     * 代码模式下「事实来源」是代码本身，用户完全可能直接手写
     * `flowchart LR` 把布局换掉。早先这里不更新 direction，于是：
     *   · 顶部的方向下拉框还显示「↓ 上下」，和实际渲染出来的图对不上；
     *   · 「移动位置」菜单按 direction 决定左右/上下文案，
     *     在 LR 图里会**指错方向**（写「左移一位」，节点却在屏幕上往下跳）。
     * 两处都是「界面在骗人」，所以必须在这里同步。
     */
    setDirection(parseDirection(text))
    doRender(text)
    const ex = mermaidToOutlineEx(text)
    if (ex) {
      setOutline(ex.outline)
      setRowIds(ex.rowIds)
      setCodeInfo(ex)
      setOutlineStale(false)
    } else {
      setCodeInfo(null)
      setOutlineStale(true)
    }
    scheduleCommit(commit, {
      code: text,
      outline: ex ? ex.outline : outlineRef.current,
      rowIds: ex ? ex.rowIds : [],
    })
    return ex
  }, [doRender, scheduleCommit])

  /* ------------------------------------------------------------------ */
  /* 代码顺序换位（Move Node）                                            */
  /* ------------------------------------------------------------------ */
  const {
    toast, showToast, flashNodeId, moveNode, menuMoveState, swapHoriz,
  } = useFoldMove({
    code, applyCode, autoSave, outline, syncLock,
    selectedNodeId, direction, nodeMenu,
    setSelectedNodeId, setNodeMenu,
  })

  /* ------------------------------------------------------------------ */
  /* 右侧流程图 ↔ 左侧列表：事件委托 + 高亮联动                            */
  /* ------------------------------------------------------------------ */
  const {
    lineIndex,
    hoverIdx, setHoverIdx,
    hoverNodeId, setHoverNodeId,
    hoverCodeLine, setHoverCodeLine,
    caretNodeIds, setCaretNodeIds,
    scrollReq, setScrollReq, requestScroll,
    idOfNodeEl, indexOfNodeEl, findNodeElById,
    onSvgMouseMove, onSvgMouseLeave, onCodeCaret,
  } = useFoldHighlight({
    code, svg, mode, rowIds, selectedNodeId, flashNodeId, previewRef,
  })

  /* ------------------------------------------------------------------ */
  /* 预览区：缩放 / 平移                                                   */
  /* ------------------------------------------------------------------ */
  const {
    zoomApiRef, zoomLabelRef, editorPosRef,
    fitView, onTransformTick,
  } = useFoldPreview({
    svg, mode, stacked, mobilePane, previewRef, viewRef, labelEditorRef, findNodeElById,
  })

  /* ------------------------------------------------------------------ */
  /* 连线模式：A → B（指向） / A + B → 新建结果节点（指向同一结果）           */
  /* ------------------------------------------------------------------ */
  const {
    linkingMode, linkFromId,
    pendingLabelNode, setPendingLabelNode,
    startLinking, stopLinking, pickLinkTarget, cancelLinking,
  } = useFoldLinking({
    code, applyCode, autoSave, outline, syncLock,
    showToast, setError, setSelectedNodeId, setNodeMenu, viewRef,
  })

  /* ------------------------------------------------------------------ */
  /* 文本编辑入口                                                          */
  /* ------------------------------------------------------------------ */
  const handleOutlineChange = (text) => {
    setOutline(text)
    // 打字 → 停笔 1 秒后才算一个历史点
    const src = applyOutline(text, direction, 'soon')
    autoSave({ outline: text, mermaid: src })
  }

  const handleCodeChange = (text) => {
    const ex = applyCode(text, 'soon')
    // 反推成功就用新的缩进列表落盘，失败就沿用旧的 —— 绝不写一个对不上的空值
    autoSave({ outline: ex ? ex.outline : outline, mermaid: text })
  }

  /**
   * 切方向。代码模式改的是代码里的 `flowchart XX`，
   * 不能从缩进列表重新编译 —— 那会把用户手写的多对一/交叉边全部冲掉。
   * 改方向是一次明确的结构性操作，立刻入栈。
   */
  const switchDirection = (dir) => {
    setDirection(dir)
    if (mode === 'code') {
      const next = withDirection(code, dir)
      const ex = applyCode(next, 'now')
      autoSave({ outline: ex ? ex.outline : outline, mermaid: next })
    } else {
      const src = applyOutline(outline, dir, 'now')
      autoSave({ outline, mermaid: src })
    }
  }

  /**
   * 切换模式：**什么都不重新编译**。
   * 两侧在编辑时就已经互相同步了，这里再编译一次只会把
   * 反推出的规范化缩进列表覆盖掉用户的原始排版。
   * 顺便清掉「连线待选」状态和浮层，避免状态跨模式残留。
   */
  /**
   * 改选中节点的**外形**。
   *
   * 两条路径，和切方向同理（见 switchDirection 的注释）：
   *   · 缩进列表模式 → 改缩进列表文本里的行尾标记 `{判断}`，再整体重编译。
   *     这是唯一「形状真正被存下来」的路径，形状跟着文档走。
   *   · 代码模式 → 只把那一行的括号对换掉，**其余一个字不动**。
   *     不能从缩进列表重编译 —— 那会把用户手写的多对一/交叉边全部冲掉。
   */
  const switchShape = (key) => {
    if (!selectedNodeId) { showToast('请先点选一个节点，再改外形'); return }
    if (!isShape(key)) return

    if (mode === 'code') {
      const next = setShapeInCode(code, selectedNodeId, key)
      if (!next) { showToast('这个节点在代码里找不到定义，先给它补一行'); return }
      const ex = applyCode(next, 'now')
      autoSave({ outline: ex ? ex.outline : outline, mermaid: next })
      return
    }

    const i = rowIds.indexOf(selectedNodeId)
    if (i < 0) { showToast('没找到这个节点所在的行'); return }
    const next = setShapeInOutline(outline, i, key)
    if (next === outline) { showToast('这一行改不动（可能只剩引用标记）'); return }
    /**
     * 必须同时 setOutline —— 它才是编辑器里那堆输入框的 value 来源。
     * 只调 applyOutline 的话图会变成新形状，而左侧文本还写着旧形状，
     * 两边立刻不一致（这条是**实测抓到的 bug**，不是理论洁癖）。
     * 参考 handleOutlineChange：它也是先 setOutline 再 applyOutline。
     */
    setOutline(next)
    const src = applyOutline(next, direction, 'now')
    autoSave({ outline: next, mermaid: src })
  }

  /** 选中节点当前的外形；没选中就返回 null（下拉框显示占位） */
  const selectedShape = useMemo(() => {
    if (!selectedNodeId) return null
    const i = rowIds.indexOf(selectedNodeId)
    if (i < 0) return null
    return shapeAtOutlineRow(outline, i)
  }, [selectedNodeId, rowIds, outline])

  const switchMode = (k) => {
    setMode(k)
    stopLinking()
    setNodeMenu(null)
    setLabelEditor(null)
    // 联动状态不跨模式残留（缩进模式下这些高亮没有意义）
    setHoverNodeId(null)
    setHoverCodeLine(null)
    setCaretNodeIds([])
    setScrollReq(null)
  }

  /* ------------------------------------------------------------------ */
  /* 缩进列表里的引用检查（写错目标名要立刻看得见）                          */
  /* ------------------------------------------------------------------ */
  const refIssues = useMemo(() => {
    const ns = parseOutline(outline)
    const unresolved = []
    let ambiguous = 0
    let refCount = 0
    for (const n of ns) {
      for (const r of n.refs) {
        refCount++
        if (!r.resolved) unresolved.push({ row: n.label, target: r.target })
        else if (r.ambiguous) ambiguous++
      }
    }
    return { unresolved, ambiguous, refCount }
  }, [outline])

  /* ------------------------------------------------------------------ */
  /* 右侧流程图上的操作 → 一律回到左侧文本上改，再重新编译出图               */
  /* ------------------------------------------------------------------ */
  /*
   * 关键约定：**缩进文本是唯一的事实来源**。
   * 在图上直接改 DOM 会立刻被下一次 mermaid 重绘冲掉，而且两边状态会打架。
   * 所以「改字 / 新增同级 / 新增子节点 / 删除」都翻译成文本操作。
   */
  const applyOutlineEdit = useCallback((nextText) => {
    if (nextText == null) return false
    setOutline(nextText)
    const src = applyOutline(nextText, direction, 'now')
    autoSave({ outline: nextText, mermaid: src })
    return true
  }, [applyOutline, autoSave, direction])

  /**
   * 双击改字：把图上节点的新文字写回对应的缩进行。
   *
   * 必须**保住这一行的引用标记**：用户改的是节点显示文字，
   * 不能顺手把 `(-> 断开连接)` 抹掉 —— 那等于悄悄删掉一条连线。
   * 所以编辑框里只放纯文字，提交时再把原来的引用拼回去。
   */
  const renameRow = useCallback((idx, label) => {
    const trimmed = String(label ?? '').trim()
    if (!trimmed) return
    const rows = outline.split('\n').filter((l) => l.trim())
    const raw = (rows[idx] || '').trim().replace(/^([-*+]|\d+[.)])\s+/, '')
    const { refs } = scanRefs(raw)
    const withRefs = refs.length ? `${trimmed} ${refs.map(formatRef).join(' ')}` : trimmed
    applyOutlineEdit(setRowLabelText(outline, idx, withRefs))
  }, [outline, applyOutlineEdit])

  /**
   * 改字框的统一提交入口。两种来源：
   *   kind:'row'  → 双击图上节点，改的是缩进列表那一行
   *   kind:'code' → 合并生成的新节点，改的是代码里的 `n9["…"]`
   *
   * 提交后都会触发重绘；isSyncing 锁保证这次改动不会反过来再触发一次联动。
   */
  const commitLabelEdit = useCallback((value) => {
    const ed = labelEditor
    setLabelEditor(null)
    if (!ed) return
    const trimmed = String(value ?? '').trim()

    if (ed.kind === 'code') {
      // 空标签就保留默认的「新结果节点」，不把节点名清空
      if (!trimmed) return
      const next = setNodeLabelInCode(code, ed.nodeId, trimmed)
      if (next == null) {
        setError({ message: `代码里找不到节点 ${ed.nodeId} 的定义`, line: null, tip: '代码未被修改。' })
        return
      }
      syncLock(() => {
        const ex = applyCode(next, 'now')
        autoSave({ outline: ex ? ex.outline : outline, mermaid: next })
      })
      return
    }

    if (!trimmed) return
    renameRow(ed.idx, trimmed)
  }, [labelEditor, code, applyCode, autoSave, outline, renameRow, syncLock])

  /**
   * 右键菜单的每个动作。
   *
   * 【前半段与模式无关：连线 / 移动位置】
   * 「指向」「指向同一结果」「移动位置」这四个动作的实现全部落在 **Mermaid 代码**上
   * （linkNodesInCode / mergeToNewNode / moveSiblingOrder …），和左侧显示的是
   * 缩进列表还是代码无关 —— 缩进列表本来也只是同一份图的另一种写法。
   *
   * 早先它们被关在 `mode === 'code'` 分支里，理由是「缩进模式没有节点 id 的概念」，
   * 但那个理由不成立：`menu.id` 来自渲染出来的 SVG（`idOfNodeEl`），
   * 缩进模式下 id 恒为 `n<行号>`，一样是合法且稳定的 mermaid id。
   * 结果是用户必须切到代码模式才能用到这几个功能 —— 纯属人为限制。
   * 现在两者共用同一条路径，不存在「代码模式改了、缩进模式忘了改」的分叉。
   *
   * 【后半段才分模式】新增 / 删除在两种模式下改的是**不同的东西**：
   *   代码模式 → 直接改 Mermaid 源码（保住手写的多对一 / 环 / 边标签）
   *   缩进模式 → 改左侧缩进文本（缩进列表是这一侧的事实来源）
   */
  const nodeMenuAction = useCallback((action, menu) => {
    setNodeMenu(null)

    /* ---------- 与模式无关：连线 / 移动位置 ---------- */
    // 「指向」/「指向同一结果」都不立刻改代码，先进入「待选目标」状态
    if (action === 'direct') {
      startLinking('direct', menu.id)
      return
    }
    if (action === 'merge') {
      startLinking('merge', menu.id)
      return
    }
    // 移动位置：交给 moveNode（内部统一做 syncLock + 越界提示 + 闪烁）
    if (action === 'up' || action === 'down' || action === 'promote' || action === 'demote') {
      moveNode(action, menu.id)
      return
    }

    /* ---------- 纯代码模式：直接改 Mermaid 源码 ---------- */
    /*
     * 代码模式下**不能**再走 applyOutlineEdit —— 那会用缩进列表重新编译，
     * 把用户手写的多对一 / 环 / 边标签全部冲掉。
     * 所以这些操作都直接改代码，改完再反推缩进列表。
     */
    if (mode === 'code') {
      const res = action === 'sibling' ? insertNodeInCode(code, menu.id, 'sibling')
        : action === 'child' ? insertNodeInCode(code, menu.id, 'child')
          : action === 'delete' ? deleteNodeInCode(code, menu.id)
            : null
      if (!res) return
      if (!res.ok) {
        // 原子性：校验没过就一个字都不改
        setError({ message: res.error, line: null, tip: '代码未被修改。' })
        return
      }
      syncLock(() => {
        const ex = applyCode(res.code, 'now')
        autoSave({ outline: ex ? ex.outline : outline, mermaid: res.code })
        // 新增出来的节点立刻让用户改字，省掉「生成完还要自己找它」这一步
        if (res.newId) setPendingLabelNode(res.newId)
      })
      if (action === 'delete') setSelectedNodeId(null)
      return
    }

    /* ---------- 缩进模式：改左侧缩进文本 ---------- */
    if (action === 'sibling') applyOutlineEdit(insertSiblingText(outline, menu.idx, '新节点'))
    else if (action === 'child') applyOutlineEdit(insertChildText(outline, menu.idx, '新节点'))
    else if (action === 'delete') applyOutlineEdit(deleteRowText(outline, menu.idx))
    if (action === 'delete') setSelectedNodeId(null)
  }, [mode, code, outline, applyCode, applyOutlineEdit, autoSave, syncLock, moveNode,
      startLinking, setPendingLabelNode])

  /* ---------- 事件委托：mermaid 重绘会换掉 DOM，不能绑在节点上 ---------- */
  const onSvgClick = useCallback((e) => {
    const g = e.target?.closest?.('g.node')

    /*
     * 连线模式下：点节点 = 选目标，点空白 = 取消。
     *
     * 两种模式（'direct' / 'merge'）在这里**完全同一条路径**，
     * 差别全部收敛在 pickLinkTarget 里 —— 这样就不会出现
     * 「指向改了逻辑、指向同一结果忘了改」这种分叉。
     */
    if (linkingMode) {
      if (!g) { cancelLinking(); return }
      pickLinkTarget(idOfNodeEl(g))
      return
    }

    // 点空白处：旧的高亮全部取消（需求：「再次点击其他节点或空白处，旧的高亮取消」）
    if (!g) {
      setSelectedNodeId(null)
      setScrollReq(null)
      return
    }

    // 单击只做选中，不弹输入框（改字走双击）
    const id = idOfNodeEl(g)
    setSelectedNodeId(id)

    /*
     * 图 → 代码（单击联动）：把这一行滚到视野中间。
     * 行号不缓存、滚动只发生一次的理由见 useFoldHighlight.requestScroll。
     */
    if (mode === 'code') requestScroll(lineIndex.lineMap[id])
  }, [linkingMode, cancelLinking, pickLinkTarget, idOfNodeEl, mode, lineIndex, requestScroll, setScrollReq])

  /** 左侧缩进列表的高亮行：由选中的节点 id 反查行下标 */
  const selectedIdx = useMemo(() => {
    if (!selectedNodeId) return null
    const i = rowIds.indexOf(selectedNodeId)
    return i >= 0 ? i : null
  }, [selectedNodeId, rowIds])

  /**
   * 左侧代码编辑器里要高亮（选中态）的行号。
   *
   * 同样**从节点 id 现算**，不缓存行号：用户选中某个节点后又在上方插入几行，
   * 缓存的行号就指到别的节点上去了。按 id 算则永远跟着节点走。
   */
  const selCodeLine = useMemo(() => {
    if (mode !== 'code' || !selectedNodeId) return null
    return lineIndex.lineMap[selectedNodeId] ?? null
  }, [mode, selectedNodeId, lineIndex])

  const onSvgDoubleClick = useCallback((e) => {
    const g = e.target?.closest?.('g.node')
    if (!g) return
    const idx = indexOfNodeEl(g)
    if (idx == null) return
    e.preventDefault()
    const rows = outline.split('\n').filter((l) => l.trim())
    const raw = (rows[idx] || '').trim().replace(/^([-*+]|\d+[.)])\s+/, '')
    // 编辑框里只放节点文字，引用标记 (-> ...) 不进输入框（提交时再拼回去）
    setSelectedNodeId(idOfNodeEl(g))
    setLabelEditor({ kind: 'row', idx, x: e.clientX, y: e.clientY, value: stripRefs(raw) })
  }, [indexOfNodeEl, idOfNodeEl, outline])

  /**
   * 「打开节点菜单」的**唯一实现**：右键和长按共用。
   *
   * 抽出来是必须的：手机端删掉了底部「指向 / 指向同一结果」操作栏之后，
   * 触屏用户唯一的入口就是长按。如果长按这里另抄一份取 id / idx 的逻辑，
   * 「右键能改结构、长按点了没反应」这种分叉迟早出现
   * （README 坑 110：跨视图/跨入口的一致性要落在结构上，不能靠约定）。
   */
  const openNodeMenuFor = useCallback((g, x, y) => {
    // 连线待选状态下的菜单：先取消，避免状态残留
    if (linkingMode) { cancelLinking(); return }
    const idx = indexOfNodeEl(g)
    /*
     * id 是「指向 / 指向同一结果 / 移动位置」唯一需要的坐标（它们都只认 mermaid id）。
     * 正常路径下 idOfNodeEl 总能从 SVG 的 id 属性里取到；万一取不到（mermaid 换了
     * id 格式），退回 rowIds（行下标 → 真实 id 的映射）——
     * 这条兜底是必须的：菜单是**两个模式共用**的，取不到 id 就等于整块功能消失。
     */
    const id = idOfNodeEl(g) || (idx != null ? (rowIds[idx] || null) : null)
    if (idx == null && !id) return
    if (id) setSelectedNodeId(id)
    setNodeMenu({ idx, id, x, y })
  }, [indexOfNodeEl, idOfNodeEl, rowIds, linkingMode, cancelLinking])

  const onSvgContextMenu = useCallback((e) => {
    const g = e.target?.closest?.('g.node')
    if (!g) return   // 空白处保留原来的行为
    e.preventDefault()
    e.stopPropagation()
    openNodeMenuFor(g, e.clientX, e.clientY)
  }, [openNodeMenuFor])

  /* ------------------------------------------------------------------ */
  /* 手机端：长按节点 = 桌面右键                                             */
  /* ------------------------------------------------------------------ */
  /*
   * 【为什么必须有它】
   * 这一轮按用户要求删掉了底部那条「指向 / 指向同一结果」操作栏。那条栏在
   * 旧实现里的存在理由写在注释里：「手机上没有可靠的右键菜单（长按在部分
   * 浏览器里根本不发 contextmenu）」。删掉之后如果不补长按，触屏用户就
   * **彻底没有**建立连线的入口了。
   *
   * 【为什么用 pointer 事件而不是 touch 事件】
   * 主画布（Canvas.jsx）已经有一套一模一样的长按实现，用的是
   * mouse/pointer 那一套 + 500ms + 10px 容差。这里照抄同一组常量与判据，
   * 不引入第二套手势参数（坑 110）。
   *
   * 【为什么不响应鼠标】
   * 鼠标有右键，长按是触屏的替代品。如果鼠标也走长按，按住左键 500ms
   * 会莫名弹出菜单，和「左键拖拽平移」直接打架。
   */
  const clearLongPress = useCallback(() => {
    if (longPressRef.current) clearTimeout(longPressRef.current.timer)
    longPressRef.current = null
  }, [])

  const onPreviewPointerDown = useCallback((e) => {
    if (e.pointerType === 'mouse') return
    const g = e.target?.closest?.('g.node')
    if (!g) return
    clearLongPress()
    const x = e.clientX
    const y = e.clientY
    const timer = setTimeout(() => {
      longPressRef.current = null
      openNodeMenuFor(g, x, y)
    }, LONG_PRESS_MS)
    longPressRef.current = { x, y, timer }
  }, [openNodeMenuFor, clearLongPress])

  const onPreviewPointerMove = useCallback((e) => {
    const lp = longPressRef.current
    if (!lp) return
    // 手指动了（在平移画布）就不算长按 —— 容差和主画布一致
    if (Math.hypot(e.clientX - lp.x, e.clientY - lp.y) <= LONG_PRESS_MOVE_TOLERANCE) return
    clearLongPress()
  }, [clearLongPress])

  // 卸载时清掉定时器：组件已经没了、定时器到点还会 setNodeMenu
  useEffect(() => clearLongPress, [clearLongPress])

  /* ------------------------------------------------------------------ */
  /* 合并后自动弹出改字框（覆盖在新节点上）                                  */
  /* ------------------------------------------------------------------ */
  /*
   * 时序：合并 → setCode → doRender（异步）→ setSvg → 本 effect 触发。
   * 此时 SVG 里才有新节点，才能量出它的位置。
   * pendingLabelNode 是一次性令牌：消费后立刻清空，保证只弹一次。
   */
  useEffect(() => {
    if (!pendingLabelNode) return
    const host = previewRef.current
    if (!host) return
    const el = findNodeElById(host, pendingLabelNode)
    if (!el) return                       // 图还没渲染出这个节点，等下一次 svg 变化
    if (isSyncingRef.current) return      // 同步中不抢焦点，等下一轮

    const id = pendingLabelNode
    setPendingLabelNode(null)
    const r = el.getBoundingClientRect()
    setLabelEditor({
      kind: 'code',
      nodeId: id,
      centered: true,                     // 覆盖在节点正中，而不是贴着鼠标
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      value: getNodeLabelInCode(code, id) || DEFAULT_MERGE_LABEL,
    })
  }, [svg, pendingLabelNode, findNodeElById, code, setPendingLabelNode])

  /* ------------------------------------------------------------------ */
  /* 重绘后把焦点交还图表容器                                              */
  /* ------------------------------------------------------------------ */
  /*
   * 容器设了 tabIndex={0}，重绘后重新聚焦，右键 / 快捷键才不会被
   * 「mermaid 换掉整棵 SVG」搞失效。
   *
   * 但**不能无条件抢焦点**：代码编辑器每敲一个字都会触发重绘，
   * 无条件聚焦容器会让用户根本没法打字。所以正在输入框里打字时跳过。
   */
  useEffect(() => {
    if (!svg) return
    if (labelEditor || pendingLabelNode) return   // 改字框优先，别抢它的焦点
    const ae = typeof document !== 'undefined' ? document.activeElement : null
    const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
    if (typing) return
    viewRef.current?.focus?.({ preventScroll: true })
  }, [svg, labelEditor, pendingLabelNode])

  /* ------------------------------------------------------------------ */
  /* 键盘：Esc 关闭                                                       */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      /*
       * Esc 的优先级：先收掉浮层，最后才关整个弹窗。
       * 这个监听器在 window 的**捕获**阶段，比 React 的 onKeyDown 先跑，
       * 所以必须在这里判掉浮层 —— 否则用户在改字框里按 Esc 想取消改字，
       * 整个弹窗会被关掉。
       *
       * 注意这里**绝对不能**调 e.stopPropagation()：
       * 捕获阶段的 stopPropagation 会掐断整条事件路径，input 上的原生监听器
       * 都收不到（实测 nativeSaw=0），于是缩进列表的 Enter / Tab / 退格、
       * 改字框的 Enter / Esc 全部失效。
       * 不需要它来挡全局快捷键 —— App.jsx 的 onKey 里已经有
       * `if (inField || foldModal) return`，弹窗打开时本来就不会响应。
       */
      if (linkingMode) { cancelLinking(); return }
      if (labelEditor) { setLabelEditor(null); return }
      if (nodeMenu) { setNodeMenu(null); return }
      autoSave.flush?.(); onClose?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, autoSave, linkingMode, cancelLinking, labelEditor, nodeMenu])

  const close = () => { autoSave.flush?.(); onClose?.() }

  /* ------------------------------------------------------------------ */
  /* 左右分栏：拖拽调节宽度                                                */
  /* ------------------------------------------------------------------ */
  /**
   * 左栏到底渲不渲染 —— 布局只有这一个判据，避免两处条件各写一遍后走偏。
   *
   *   · 手机端：沿用原来的「预览 / 编辑」二选一（stacked 时 mobilePane 说了算）
   *   · 桌面端：收起后**整块不渲染**，不是 `width: 0` 或 `display:none`。
   *     左栏身上带着 `shrink-0` + `minWidth: MIN_LEFT`（200px），把 width 写成 0
   *     也压不下去（minWidth 会顶住），真想藏只能 display:none；而 display:none
   *     的元素照样会被 querySelectorAll 数到，「左栏到底还在不在」就有了两种说法，
   *     测试和用户看到的状态会对不上。不渲染是唯一没有歧义的写法。
   *     代价是 OutlineList / CodeEditor 会被卸载，展开后光标位置回到开头 ——
   *     文本内容本身在 FoldModal 的 state 里，一个字都不会丢。
   */
  const showEditPane = stacked ? mobilePane === 'edit' : !editCollapsed

  // 容器的实际可用宽度（减去分割线）；窄屏时上下分栏，不做拖拽
  const leftPx = useMemo(() => {
    if (stacked) return null
    const total = Math.max(0, bodyWidth - SPLITTER_W)
    if (total <= 0) return null
    const raw = leftRatio * total
    // 防呆：两边都有最小宽度。若容器本身装不下两个最小值，就退化成对半
    if (total < MIN_LEFT + MIN_RIGHT) return total / 2
    return Math.min(Math.max(raw, MIN_LEFT), total - MIN_RIGHT)
  }, [stacked, bodyWidth, leftRatio])

  const onSplitterDown = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startRatio = leftRatio
    const total = Math.max(1, bodyWidth - SPLITTER_W)
    const el = e.currentTarget
    capturePointer(el, e.pointerId)

    const onMove = (ev) => {
      const dx = ev.clientX - startX
      let next = (startRatio * total + dx) / total
      // 实时夹紧，保证任何时候都不会拖出界
      if (total >= MIN_LEFT + MIN_RIGHT) {
        next = Math.min(Math.max(next, MIN_LEFT / total), (total - MIN_RIGHT) / total)
      }
      setLeftRatio(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [leftRatio, bodyWidth])

  /** 尺寸变化：决定上下/左右分栏 */
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      setBodyWidth(w)
      setStacked(w < 768)
    })
    ro.observe(el)
    setBodyWidth(el.clientWidth)
    setStacked(el.clientWidth < 768)
    return () => ro.disconnect()
  }, [])

  /**
   * 收起 / 展开编辑区之后，让预览**重新适应一次**。
   *
   * 【为什么这里必须 fit，而 useFoldPreview 里那个容器 observer 什么都不做】
   * 那一处的「什么都不做」针对的是**被动**尺寸变化（拖分割线、内容重绘）：
   * 库自己只会把越界的位移挪回边界，从不改缩放，用户的视角不会被冲掉。
   * 但收起/展开是**用户明确要求的重新布局**，两种情况下旧视图都是错的：
   *   · 收起：左栏让出的 ~718px 全给了预览（1440 宽实测 718 → 1440），
   *     图若还按收起前的 scale 贴在左边，右半屏会是空的 —— 那就不是
   *     「放大到全屏」，只是「右边多了一块白」。
   *   · 展开：容器骤窄 ~50%，原来的 scale + 位移会把图的右/下半截顶到视口外，
   *     表现为「一切回双栏图就被裁了」。
   * 所以这一次按「用户点了一下重置视图」处理：fitView(contain)，
   * 语义和右下角「适应屏幕」完全一致，不引入第二套视图规则。
   *
   * 【为什么是 useLayoutEffect + animationTime = 0】
   * fitToView 靠量 wrapper 的**实际尺寸**：必须等 DOM 上的新宽度已经落地
   * （layout 阶段）再量，useEffect 会晚一帧、量到的可能还是旧宽度。
   * 传 false 关掉 200ms 缓动：面板宽度是瞬间变的（没有 CSS transition），
   * 图再慢慢滑过去只会先闪一帧旧位置，不如和布局同时到位。
   *
   * 首帧（弹窗刚打开、svg 还没渲染出来）也会跑一次，但 fitView 内部
   * 对 zoomApiRef.current 为空直接 return（见 useFoldPreview），不会误触发；
   * stacked 故意不进依赖：跨过 768px 断点时容器本身换了挂载方式，
   * 那边由 useFoldPreview 的「贴回上次视图」负责，这里不抢。
   */
  useLayoutEffect(() => {
    if (stacked) return
    fitView(false)
  }, [editCollapsed, fitView])

  /* ------------------------------------------------------------------ */
  /* 编辑器行渲染（带错误行高亮 + 波浪线 + 问号气泡）                        */
  /* ------------------------------------------------------------------ */
  const codeLines = useMemo(() => code.split('\n'), [code])

  const resetFamiliarity = () => {
    onResetFamiliarity?.(node.id)
    setFlash(true)
    setTimeout(() => setFlash(false), 1100)
  }

  const originStyle = origin
    ? { '--mf-origin-x': `${origin.x}px`, '--mf-origin-y': `${origin.y}px` }
    : undefined

  return (
    <div className="fixed inset-0 z-[100] mf-fade" style={{ background: 'rgba(0,0,0,.28)' }}>
      <div
        data-fold-modal
        className="absolute inset-0 mf-unfold flex flex-col"
        style={{
          ...originStyle,
          background: 'var(--mf-panel)',
          /*
           * 手机端用 100dvh（动态视口高度）而不是 inset-0 / 100vh。
           *
           * 100vh 在手机上量的是「地址栏收起时」的高度，地址栏一出来
           * 底部就会被切掉一截（工具栏被顶飞）；而 100dvh 跟着实际可视高度走。
           * 桌面端保持 inset-0 —— 那边没有动态地址栏，改了反而多一次重排。
           *
           * 注意 dvh 只在手机端用：`stacked` 是按弹窗宽度算的，
           * 和「是不是手机」不完全等价，但这里要的正是「窄 → 用动态高度」。
           */
          ...(stacked ? { inset: 'auto', top: 0, left: 0, right: 0, height: '100dvh' } : null),
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* ---------------- 顶栏 ---------------- */}
        <header
          /*
           * paddingTop 走安全区：手机端状态栏悬浮在页面上，
           * 弹窗是从屏幕最顶上铺下来的（stacked 时 top:0 + 100dvh），
           * 不加这一条标题、次数、方向选择全在状态栏底下。
           * 桌面端 --mf-safe-t 是 0px，视觉零变化。
           */
          className={`flex items-center h-12 shrink-0 border-b ${stacked ? 'gap-1.5 px-2 overflow-x-auto mf-scroll' : 'gap-3 px-4'}`}
          style={{ borderColor: 'var(--mf-hairline)', paddingTop: 'var(--mf-safe-t)', height: 'calc(48px + var(--mf-safe-t))' }}
        >
          {/*
            标题块（折角名 + 打开次数）。
            手机端**不渲染**：加了「外形」下拉框之后这一行装不下 6 个控件，
            而它是唯一的弹性项，本来就被压成 0 宽（实测 w=0，完全看不见），
            却仍然占着一份 gap。显式去掉比留一个 0 宽的隐形块更诚实，
            也正好把关闭按钮从「右边缘 391 > 屏宽 390」拉回来。
            桌面端 ample room，一个字都不变。
          */}
          {!stacked && (
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: foldColor(node.fold?.openCount ?? 0) }} />
            <h2 className="text-[14px] font-medium truncate" style={{ color: 'var(--mf-ink)' }}>
              {node.text}
            </h2>
            <span className="text-[11px] shrink-0" style={{ color: 'var(--mf-muted)' }}>
              已打开 {node.fold?.openCount ?? 0} 次
            </span>
          </div>
          )}

          <div className="flex-1" />

          {/*
            手机端：面板切换（预览 / 编辑）。
            桌面端不出现 —— 桌面是左右并排，两个面板同时在，没有「切」的概念。
          */}
          {/*
            手机端顶栏为什么改成 compact 一档 + 为什么不带「缩进列表 / 代码」：
            见 FoldButtons.jsx 里 SegTabs 的注释（390px 下被压成竖排柱子、
            ↺ 与 ✕ 被顶出屏幕的那次事故）。

            为什么这里还留着 `overflow-x-auto`：
            实测 390 / 375 / 360 三档纳总宽度 347px，都装得下；但更窄的
            （320px 的老 SE）会差 27px。留一条横向滚动兜底，最坏情况是
            「要滑一下才看到 ✕」，而不是「✕ 永远在屏幕外、点不到」。
            不换行 + 不收缩仍然由 SegTabs / shrink-0 保证。
          */}
          {stacked && (
            <SegTabs
              compact
              tabAttr="data-pane-tab"
              containerAttrs={{ 'data-pane-switch': true }}
              value={mobilePane}
              options={[['preview', '预览'], ['edit', '编辑']]}
              onPick={setMobilePane}
            />
          )}

          {/*
            模式切换：手机端只在「编辑」面板里有意义，预览时藏起来减少噪音。
            ★ 手机端**挪进编辑面板自己的工具栏行**（见下面 data-pane-section="edit"）：
              顶栏只剩 390px，再塞进这个 155px 的分段控件就会溢出。
          */}
          {!stacked && (
            <SegTabs
              tabAttr="data-mode-tab"
              value={mode}
              options={[['outline', '缩进列表'], ['code', 'Mermaid 代码']]}
              onPick={switchMode}
            />
          )}

          <select
            value={direction}
            onChange={(e) => switchDirection(e.target.value)}
            className={`text-[12px] rounded-lg outline-none border shrink-0 ${stacked ? 'px-1.5 py-1' : 'px-2 py-1'}`}
            style={{ background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)', color: 'var(--mf-ink)' }}
            title="流程图方向"
          >
            <option value="TD">↓ 上下</option>
            <option value="LR">→ 左右</option>
            <option value="BT">↑ 逆向</option>
            <option value="RL">← 逆向</option>
          </select>

          <select
            data-shape-picker
            value={selectedShape || 'rect'}
            onChange={(e) => switchShape(e.target.value)}
            disabled={!selectedNodeId}
            className={`text-[12px] rounded-lg outline-none border disabled:opacity-40 shrink-0 ${stacked ? 'px-1.5 py-1' : 'px-2 py-1'}`}
            style={{ background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)', color: 'var(--mf-ink)' }}
            title={selectedNodeId ? '改选中节点的外形' : '先在图上点选一个节点，再改外形'}
          >
            {SHAPES.map((s) => (
              <option key={s.key} value={s.key}>{s.glyph} {s.label}</option>
            ))}
          </select>

          {/*
            收起 / 展开左侧编辑区（**仅桌面端**）。
            ★ 位置：顶栏右上角，夹在外形下拉框和「重置熟悉度」之间，✕ 仍然是最后一个 ——
              用户确认过开关放右上角，而 ✕ 留在最右边是肌肉记忆，不该被挤走。
            ★ shrink-0 + whitespace-nowrap：和「重置熟悉度」踩过的坑同一个
              （README 坑 109）：没有固定宽度的中文按钮进满行 flex 会被压窄，
              中文换行后变成一根高出顶栏的柱子。实测两种文案都是 70×28px
              （「收起编辑」/「展开编辑」各 4 个字，宽度一致，不跳宽）。
            ★ 手机端不渲染：stacked 下本来就用 data-pane-switch 二选一，
              再挂一个「收起编辑」会把编辑面板锁死。手机端零改动的做法就是
              连按钮都不进 DOM —— 这也是测试断言「390 宽下没有 data-edit-collapse」的原因。
            ★ aria-pressed 如实反映收起状态：按钮是双态开关，读屏和测试都不该靠猜文案。
          */}
          {!stacked && (
            <button
              data-edit-collapse
              aria-pressed={editCollapsed}
              onClick={() => setEditCollapsed((v) => !v)}
              className="text-[12px] px-2.5 py-1 rounded-lg border transition-colors shrink-0 whitespace-nowrap"
              style={{ borderColor: 'var(--mf-hairline)', color: 'var(--mf-muted)' }}
              title={editCollapsed ? '展开左侧编辑区，回到左右双栏' : '收起左侧编辑区，预览独占全宽'}
            >
              {editCollapsed ? '展开编辑' : '收起编辑'}
            </button>
          )}

          {/*
            重置熟悉度。
            ★ 必须 shrink-0 + whitespace-nowrap：它没有固定宽度，flex 会把它压窄，
              而中文会**换行**，于是手机上变成一根 34px 宽、100px 高的柱子
              （顶栏只有 48px，直接戳出栏外）。实测过，不是推测。
            手机端（stacked）只留一个 ↺ 图标省地方，桌面端文字一字不变。
          */}
          <button
            data-reset-familiarity
            onClick={resetFamiliarity}
            className={`text-[12px] px-2.5 py-1 rounded-lg border transition-colors shrink-0 whitespace-nowrap ${flash ? 'mf-flash' : ''}`}
            style={{ borderColor: 'var(--mf-hairline)', color: 'var(--mf-muted)' }}
            title="把打开次数清零，折角变回灰色"
          >
            {stacked ? '↺' : '重置熟悉度'}
          </button>

          <button
            onClick={close}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[16px] leading-none transition-colors shrink-0"
            style={{ color: 'var(--mf-muted)' }}
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </header>

        {/* ---------------- 主体 ----------------
            桌面：左右并排（可拖拽调宽）
            手机：**只渲染一个面板**，由顶部的「预览 / 编辑」切换。
                  绝不做上下分栏 —— 键盘弹起时两个面板会被压成两条细缝。 */}
        <div
          ref={bodyRef}
          data-modal-body
          data-pane={stacked ? mobilePane : undefined}
          className="flex-1 min-h-0 flex flex-row"
        >
          {/* ============ 左：编辑区（桌面常驻且未收起 / 手机仅在「编辑」面板） ============ */}
          {showEditPane && (
          <section
            data-pane-section="edit"
            className={`min-h-0 flex flex-col ${stacked ? 'flex-1' : 'shrink-0'}`}
            style={{
              borderColor: 'var(--mf-hairline)',
              // 非窄屏时用像素宽度（由分割线拖拽决定）；窄屏时独占整个主体
              width: stacked ? undefined : (leftPx ?? undefined),
              flexBasis: stacked ? 0 : undefined,
              minWidth: stacked ? undefined : MIN_LEFT,
            }}
          >
            <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] shrink-0 min-w-0" style={{ color: 'var(--mf-muted)' }}>
              {/*
                手机端：模式切换在这里，不在顶栏（见顶栏注释）。
                预览面板不渲染它 —— 和改前的行为一致（减少噪音）。
              */}
              {stacked && (
                <SegTabs
                  compact
                  tabAttr="data-mode-tab"
                  value={mode}
                  options={[['outline', '缩进列表'], ['code', 'Mermaid 代码']]}
                  onPick={switchMode}
                />
              )}
              {/*
                提示文案。手机端只留一句最短的（顶栏和这一行都要挤进 390px），
                并且 `truncate min-w-0` —— 宁可省略号，也不许把这一行顶出屏幕。
                桌面端三句一字不变。
              */}
              {mode === 'outline' ? (
                stacked ? (
                  <span
                    data-shape-hint
                    className="truncate min-w-0"
                    title={`行尾加形状，图和代码都会跟着变：${SHAPES.map((s) => `{${s.label}}`).join(' ')}`}
                  >
                    Tab 缩进 · 行尾 <code>{'{判断}'}</code> 改外形
                  </span>
                ) : (
                <>
                  <span>Tab / 2 空格缩进分层</span>
                  <span className="opacity-40">·</span>
                  <span title="写法：(-> 目标节点名)">多对一用 (→ 目标)</span>
                  <span className="opacity-40">·</span>
                  <span
                    data-shape-hint
                    title={`行尾加形状，图和代码都会跟着变：${SHAPES.map((s) => `{${s.label}}`).join(' ')}`}
                  >
                    外形用行尾 <code>{'{判断}'}</code>
                  </span>
                </>
                )
              ) : (
                stacked ? (
                  <span className="truncate min-w-0">直接写 Mermaid，支持多对一 / 环</span>
                ) : (
                <>
                  <span>直接写 Mermaid，支持多对一 / 环</span>
                  <span className="opacity-40">·</span>
                  <span>切回缩进列表不会丢边</span>
                </>
                )
              )}
              <div className="flex-1" />
              {saved && <span className="mf-fade shrink-0" style={{ color: 'var(--mf-accent)' }}>已自动保存</span>}
              {/*
                撤销 / 重做（左工具栏右上角）。
                ★ 手机端**不在这里** —— 用户要求「撤销和回到中点放在下面」，
                  已经挪到 data-mobile-bottom-bar 里，和「回到中点」并排。
                  留在这一行的话，390px 下会把这个提示行也顶出去。
              */}
              {!stacked && (
                <div className="flex items-center gap-1 shrink-0" data-toolbar-history>
                  <UndoButton disabled={!histState.canUndo} onClick={handleUndo} />
                  <UndoButton disabled={!histState.canRedo} onClick={handleRedo} redo />
                </div>
              )}
            </div>

            {/* ---- 双轨制提示条 ---- */}
            {mode === 'outline' && refIssues.unresolved.length > 0 && (
              <div
                data-ref-unresolved
                className="shrink-0 flex items-start gap-2 px-3 py-2 text-[11.5px] border-t"
                style={{ borderColor: 'var(--mf-hairline)', background: 'rgba(234,88,12,.07)', color: '#ea580c' }}
              >
                <span className="mt-[2px] shrink-0"><AlertIcon size={13} /></span>
                <div className="min-w-0">
                  <div>
                    有 {refIssues.unresolved.length} 个 (→ …) 找不到目标节点，这些连线不会生成
                  </div>
                  <div className="opacity-80 mt-0.5 truncate">
                    {refIssues.unresolved.slice(0, 3).map((u) => `「${u.target}」`).join('、')}
                    {refIssues.unresolved.length > 3 ? ' 等' : ''}
                    {' — '}检查名字是否和某一行完全一致
                  </div>
                </div>
              </div>
            )}

            {/* 代码里有缩进列表表达不了的东西 → 如实告知，并引导去代码模式 */}
            {mode === 'outline' && codeInfo?.suggestCodeMode && (
              <div
                data-suggest-code
                className="shrink-0 flex items-start gap-2 px-3 py-2 text-[11.5px] border-t"
                style={{ borderColor: 'var(--mf-hairline)', background: 'var(--mf-faint)', color: 'var(--mf-muted)' }}
              >
                <span className="mt-[1px]">◆</span>
                <div className="min-w-0 flex-1">
                  <div style={{ color: 'var(--mf-ink)' }}>
                    这张图有 {codeInfo.stats.refEdges} 条交叉/回环连线，用缩进列表读起来会吃力
                  </div>
                  <div className="opacity-80 mt-0.5">
                    建议切到代码模式直接写 A --&gt; C。连线不会丢，随时可以切回来。
                  </div>
                </div>
                <button
                  onClick={() => setMode('code')}
                  className="shrink-0 self-center rounded-md border px-2 py-0.5 text-[11px] transition-colors"
                  style={{ borderColor: 'var(--mf-hairline)', color: 'var(--mf-accent)' }}
                >
                  去代码模式
                </button>
              </div>
            )}

            {/* 代码反推不出缩进列表 */}
            {mode === 'code' && outlineStale && (
              <div
                data-outline-stale
                className="shrink-0 flex items-start gap-2 px-3 py-2 text-[11.5px] border-t"
                style={{ borderColor: 'var(--mf-hairline)', background: 'var(--mf-faint)', color: 'var(--mf-muted)' }}
              >
                <span className="mt-[1px]">◇</span>
                <div>
                  这段代码暂时反推不出缩进列表，已保留上一次的内容。
                  修好语法后会自动同步，切回缩进列表也不会丢边。
                </div>
              </div>
            )}

            <div className="flex-1 min-h-0 relative">
              {mode === 'outline' ? (
                // key=node.id：换一个折角就整体重挂载，编辑器内部的行状态不会串
                <OutlineList
                  key={node.id}
                  value={outline}
                  onChange={handleOutlineChange}
                  // 手机端不接悬停联动：触屏的 mouseenter 没有配对的 mouseleave，
                  // 高亮会黏在最后摸过的那一行上
                  onHoverNode={stacked ? undefined : (nid) => setHoverIdx(nid == null ? null : Number(String(nid).replace(/^n/, '')))}
                  highlightIndex={selectedIdx}
                />
              ) : (
                <CodeEditor
                  value={code}
                  onChange={handleCodeChange}
                  errorLine={error?.line}
                  lines={codeLines}
                  hoverLine={hoverCodeLine}
                  selectedLine={selCodeLine}
                  scrollReq={scrollReq}
                  onCaret={onCodeCaret}
                />
              )}
            </div>

            {/* 错误提示条：行尾小问号气泡的常驻版本 */}
            {error && (
              <div
                className="shrink-0 flex items-start gap-2 px-3 py-2 text-[11.5px] border-t"
                style={{ borderColor: 'var(--mf-hairline)', background: 'rgba(239,68,68,.06)', color: '#ef4444' }}
              >
                <span className="mt-[2px] shrink-0"><AlertIcon size={13} /></span>
                <div className="min-w-0">
                  <div className="truncate">
                    {/* 行号只在代码模式下显示：缩进列表模式下报错行指向编译产物，对不上 */}
                    {mode === 'code' && error.line ? `第 ${error.line} 行：` : ''}{error.message}
                  </div>
                  <div className="opacity-80 mt-0.5" style={{ color: 'var(--mf-muted)' }}>
                    提示：{error.tip}
                  </div>
                </div>
                <div className="flex-1" />
                <span className="opacity-70 shrink-0">右侧仍显示上一次正确的图</span>
              </div>
            )}
          </section>
          )}

          {/* ============ 分割线：拖拽调节左右宽度（**仅桌面端，且左栏在时**） ============ */}
          {/*
            收起时分割线必须一起消失：它没有可拖的两个面板，
            留着一条 4px 的竖线既没有语义，也会让预览白白少 4px 宽。
          */}
          {!stacked && !editCollapsed && (
            <div
              data-splitter
              role="separator"
              aria-orientation="vertical"
              title="拖拽调节左右宽度"
              onPointerDown={onSplitterDown}
              className="group relative shrink-0 cursor-col-resize select-none"
              style={{ width: SPLITTER_W, background: 'var(--mf-hairline)' }}
            >
              {/* 视觉只有 4px，但热区左右各外扩 3px，更好抓 */}
              <span className="absolute inset-y-0 -left-[3px] -right-[3px]" />
              <span
                className="absolute inset-y-0 left-0 w-full opacity-0 transition-opacity group-hover:opacity-100"
                style={{ background: 'var(--mf-accent)' }}
              />
            </div>
          )}

          {/* ============ 右：Mermaid 预览区（桌面常驻 / 手机仅在「预览」面板） ============ */}
          {(!stacked || mobilePane === 'preview') && (
          <section
            data-pane-section="preview"
            className="relative min-h-0 flex flex-col"
            style={{
              flex: 1,
              minWidth: stacked ? undefined : MIN_RIGHT,
              background: 'var(--mf-canvas)',
            }}
          >
            <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] shrink-0 min-w-0" style={{ color: 'var(--mf-muted)' }}>
              {linkingMode ? (
                <span data-link-hint data-link-mode={linkingMode} className={stacked ? 'truncate min-w-0' : undefined} style={{ color: 'var(--mf-accent)' }}>
                  {linkingMode === 'merge'
                    ? <>点击另一个节点，让它和「{linkFromId}」指向同一个新结果节点 · 点空白或 Esc 取消</>
                    : <>点击要指向的目标节点（从「{linkFromId}」出发） · 点空白或 Esc 取消</>}
                </span>
              ) : stacked ? (
                /*
                 * 手机端文案：没有右键（触屏的 contextmenu 在部分浏览器里根本不发），
                 * 改结构走**长按**（见 onPreviewPointerDown）。所以这句必须如实写，
                 * 否则用户会一直去右键而以为功能坏了。
                 */
                <span data-touch-hint className="truncate min-w-0">单击选中 · 双击改字 · 长按改结构</span>
              ) : (
                <span>单击选中 · 双击改字 · 右键改结构</span>
              )}
              <div className="flex-1" />
              {rendering && <span className="mf-fade shrink-0" style={{ color: 'var(--mf-accent)' }}>渲染中…</span>}
              <span ref={zoomLabelRef} data-zoom-label className="tabular-nums shrink-0">100%</span>
              {/*
                「重置视图」= 回到适应屏幕。
                ★ 手机端不在这里 —— 用户要求「回到中点放在下面」，
                  它已经挪进 data-mobile-bottom-bar（和撤销并排）。
                  桌面端一字不变。
              */}
              {!stacked && (
                <button
                  data-reset-view
                  onClick={() => fitView()}
                  className="underline underline-offset-2 hover:opacity-70 shrink-0"
                  title="回到适应屏幕（与右下角「适应屏幕」同一个动作）"
                >
                  重置视图
                </button>
              )}
            </div>

            <div
              ref={viewRef}
              data-graph-viewport
              tabIndex={0}
              /*
               * overflow-hidden 而不是 auto：内容的移动完全由库的 transform
               * 负责，这里再留一个滚动盒子只会和它抢滚轮事件。
               *
               * 【滚轮的作用域隔离】
               * 滚轮缩放只绑在这个容器上（useFoldPreview 把监听挂到 viewRef）。
               * 左侧代码编辑器是**它的兄弟节点**，滚动事件不会冒泡到这里，
               * 所以左边照常是正常的文本上下滚动，不受缩放影响。
               */
              className="flex-1 min-h-0 overflow-hidden outline-none"
              style={{
                overscrollBehavior: 'contain',
                /*
                 * 明确的 min-height：库要靠量容器的实际尺寸来算 fitToView，
                 * 高度为 0 时它会算出 scale=0（图直接消失）。
                 * flex 布局里 min-h-0 允许被压到 0，所以这里补一个下限兜底。
                 */
                minHeight: MIN_PREVIEW_H,
                // 连线模式（指向 / 指向同一结果）：整个画布容器变十字准星
                cursor: linkingMode ? 'crosshair' : undefined,
              }}
              onClick={onSvgClick}
              onDoubleClick={onSvgDoubleClick}
              onContextMenu={onSvgContextMenu}
              /*
               * 手机端长按 = 桌面右键（改结构 / 指向 / 指向同一结果 / 移动位置）。
               * 只在 stacked 时绑：桌面端多这三个监听器纯属噪音，
               * 而且桌面有右键，长按弹菜单是**多余且会打架**的手势
               * （按住左键拖画布 500ms 就会弹菜单）。
               */
              onPointerDown={stacked ? onPreviewPointerDown : undefined}
              onPointerMove={stacked ? onPreviewPointerMove : undefined}
              onPointerUp={stacked ? clearLongPress : undefined}
              onPointerCancel={stacked ? clearLongPress : undefined}
              onPointerLeave={stacked ? clearLongPress : undefined}
              /*
               * 悬停联动**只在桌面端绑定**。
               *
               * 触屏没有 hover：点一下会合成出 mouseenter，却永远不会有
               * mouseleave（手指抬起来不产生这个事件）。于是那个节点会一直
               * 停在「悬停高亮」状态，用户再点别的节点时两个都亮着 ——
               * 看起来就像高亮坏了。
               * 手机端改走**点击**：点右侧节点 → 左侧代码滚到对应行并高亮；
               * 点左侧代码行 → 右侧节点高亮（这两条本来就都是 onClick 驱动的，
               * 和悬停无关，所以关掉 hover 不会丢功能）。
               */
              onMouseMove={stacked ? undefined : onSvgMouseMove}
              onMouseLeave={stacked ? undefined : onSvgMouseLeave}
            >
              {svg ? (
                <TransformWrapper
                  minScale={MIN_PREVIEW_SCALE}
                  maxScale={MAX_PREVIEW_SCALE}
                  initialScale={1}
                  centerOnInit
                  /*
                   * fitOnInit 负责「首帧就整张图装进视口」——这正是需求一·4
                   * 要的「Mermaid 渲染完成后再 fitView 居中」。
                   * 它比「先 initialScale=1 再手动 fit」稳：库会在内容量到尺寸
                   * （以及后续内容尺寸变化）时自己重算，不需要我们猜时机。
                   */
                  fitOnInit="contain"
                  limitToBounds
                  /*
                   * 滚轮缩放**关掉库自己的实现**，全部交给 useFoldPreview 里的
                   * 那个非 passive 监听器。
                   *
                   * 为什么必须关：库内部监听是 passive 且不认 activationKeys 之外的
                   * 条件，两个监听器同时生效会**一次滚动缩放两遍**（缩放量平方）。
                   * 我们自己的监听器还要负责 preventDefault 掉「Ctrl+滚轮缩放页面」，
                   * 这是只能由一个地方做的事。留 `disabled: true` 是明确的意图声明：
                   * 滚轮归我们管，库只管按钮和捏合。
                   */
                  wheel={{ disabled: true }}
                  /*
                   * 平移（二·2）：
                   *   allowLeftClickPan  左键拖空白 = 平移（老实现只认右键，手感很怪）
                   *   allowRightClickPan **关掉** —— 否则右键会被平移吞掉，
                   *                      节点上的右键菜单就弹不出来了（需求四·2）
                   *   excluded: ['node'] 按在 mermaid 节点上时不启动平移，
                   *                      否则「点节点」会被当成「拖画布」（二·2）
                   */
                  panning={{
                    allowLeftClickPan: true,
                    allowMiddleClickPan: true,
                    allowRightClickPan: false,
                    excluded: [MERMAID_NODE_CLASS],
                  }}
                  /*
                   * 双击**必须禁用缩放**（需求四·1）。
                   * 库默认 doubleClick.mode = 'zoomIn'，会和「双击节点改字」直接冲突：
                   * 用户想改字，图却放大了一档。
                   */
                  doubleClick={{ disabled: true }}
                  pinch={{ step: 5 }}
                >
                  {/*
                    桥接组件：取 controls + 每次 transform 回调。
                    它渲染 null，只占一个 Context 位置，不影响布局和测量。
                  */}
                  <PreviewBridge apiRef={zoomApiRef} onTick={onTransformTick} />
                  <TransformComponent
                    wrapperStyle={{ width: '100%', height: '100%' }}
                  >
                    {/*
                      尺寸由**库自己的样式**保证：TransformComponent 的内容盒是
                      `display: flex; width: fit-content`，所以这个 div 作为 flex item
                      会被收缩成 SVG 的实际大小 —— 库正是靠量它来算 fitToView 的。
                      （`inline-block` 在 flex item 上会被 blockify 成 block，
                       留着只是为了语义清晰，真正起作用的是库的 fit-content。）
                      老实现里的 `minWidth: 100%` 已删除：那是在给「手动缩放」
                      打补丁，现在由库统一负责，留着反而会干扰 fit 的测量。
                    */}
                    <div
                      ref={previewRef}
                      data-graph-canvas
                      className="inline-block p-6"
                      dangerouslySetInnerHTML={{ __html: svg }}
                    />
                  </TransformComponent>
                </TransformWrapper>
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-[12px]" style={{ color: 'var(--mf-muted)' }}>
                  <div className="text-[28px] opacity-25">◇</div>
                  <div>左侧写几行缩进列表，这里立刻出图</div>
                  <div className="opacity-60">例如：根节点 → 缩进一层写子节点</div>
                </div>
              )}
            </div>

            {/*
              【这里原来有一条手机端底部「指向 / 指向同一结果」操作栏，已删除】
              用户原话：「底部指向和指向同一结果删了 …… 完全用不上」。

              那两颗按钮是 200px 宽，横在图的左下角，正好压在流程图最下面
              几个节点上；而同一个功能在两个模式下都能从**节点菜单**里点到
              （桌面右键 / 手机长按，见 onPreviewPointerDown），
              底栏那颗并不比菜单方便 —— 菜单是「对着哪个节点操作」就有哪个
              节点的入口，底栏还得先选中一个。

              ★ 能力没有丢：手机端长按节点会打开**同一个 NodeContextMenu**
                （startLinking 及其后的 pickLinkTarget 全部是桌面端那一条代码
                路径），这条已经是主画布的既有手势，不是为它新加的机制。
            */}

            {/*
              右下角悬浮控制区（**仅桌面端**）。
              半透明 + 背景模糊：它压在图上面，不透明会挡住节点。
              `data-zoom-panel` 是**画布之外**的兄弟节点（不是 TransformWrapper 的
              后代），所以点它不会触发库的平移，也就不会「穿透」到底层画布 ——
              这正是需求三·2 要的那条。

              ★ 手机端不渲染这一块（连放大 / 缩小两颗一起）：
                用户原话「放大镜和放小删了 完全用不上」——
                滚轮/捏合已经能缩放，而 390px 的屏幕上这条竖排浮层有 152px 高，
                正好糊在图右下角。手机端只剩 data-mobile-bottom-bar 里的
                「撤销 / 重做 / 回到中点」，挂在弹窗层级上（两个面板都在），
                见下面。桌面端这一块一个像素都没动。
            */}
            {svg && !stacked && (
              <div
                data-zoom-panel
                className="absolute right-3 z-30 flex flex-col items-center gap-1.5"
                style={{ bottom: 'calc(12px + var(--mf-safe-b))' }}
              >
                <div
                  className="flex flex-col gap-1.5 rounded-2xl border p-1.5"
                  style={{
                    background: 'color-mix(in srgb, var(--mf-panel) 78%, transparent)',
                    borderColor: 'var(--mf-hairline)',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                    boxShadow: '0 6px 20px -8px rgba(0,0,0,.28)',
                  }}
                >
                  <ZoomBtn tool="zoom-in" title="放大" onClick={() => zoomApiRef.current?.zoomIn(ZOOM_BTN_STEP)}>
                    <ZoomInIcon size={18} />
                  </ZoomBtn>
                  <ZoomBtn tool="zoom-out" title="缩小" onClick={() => zoomApiRef.current?.zoomOut(ZOOM_BTN_STEP)}>
                    <ZoomOutIcon size={18} />
                  </ZoomBtn>
                  <ZoomBtn tool="zoom-fit" title="适应屏幕" onClick={() => fitView()}>
                    <FitScreenIcon size={18} />
                  </ZoomBtn>
                </div>
                {/* 撤销：和缩放面板同一条竖列，避免两块浮层叠在一起 */}
                <UndoButton disabled={!histState.canUndo} onClick={handleUndo} floating />
              </div>
            )}
          </section>
          )}
        </div>

        {/* ---------------- 手机端底部操作条：撤销 / 重做 / 回到中点 ----------------
            用户原话：「撤销和回到中点放在下面」。

            ★ 为什么挂在**弹窗层级**而不是预览面板里：
              它必须两个面板都在（编辑面板里也要能撤销）。挂在预览 section
              里的话，切到「编辑」它就整块消失了 —— 编辑的时候恰恰最需要撤销。

            ★ 为什么是一横排而不是原来那条 152px 高的竖列：
              竖列会糊住图的右下角；横排只有 56px 高，而且拇指够得到。
              撤销 / 重做用 44×44 的 big 档位，和「回到中点」的 ZoomBtn 同高，
              同一行里不会一大一小。

            ★ 「回到中点」只在预览面板出现：编辑面板里没有图可居中。
          */}
        {stacked && (
          <div
            data-mobile-bottom-bar
            className="absolute right-3 z-30 flex items-center gap-1.5"
            style={{ bottom: 'calc(12px + var(--mf-safe-b))' }}
          >
            <div
              className="flex flex-row items-center gap-1.5 rounded-2xl border p-1.5"
              style={{
                background: 'color-mix(in srgb, var(--mf-panel) 78%, transparent)',
                borderColor: 'var(--mf-hairline)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                boxShadow: '0 6px 20px -8px rgba(0,0,0,.28)',
              }}
            >
              <UndoButton big disabled={!histState.canUndo} onClick={handleUndo} />
              <UndoButton big redo disabled={!histState.canRedo} onClick={handleRedo} />
              {svg && mobilePane === 'preview' && (
                <ZoomBtn tool="zoom-fit" title="回到中点（适应屏幕）" onClick={() => fitView()}>
                  <FitScreenIcon size={18} />
                </ZoomBtn>
              )}
            </div>
          </div>
        )}

        {/* ---------- 改字：悬浮输入框（双击改字 / 合并后自动弹出） ---------- */}
        {labelEditor && (
          <FloatingLabelEditor
            x={labelEditor.x}
            y={labelEditor.y}
            centered={labelEditor.centered}
            value={labelEditor.value}
            posRef={editorPosRef}
            onCommit={commitLabelEdit}
            onCancel={() => setLabelEditor(null)}
            composingRef={composingRef}
          />
        )}

        {/* ---------- 右键菜单：改结构（两个模式都是同一套完整功能） ---------- */}
        {nodeMenu && (
          <NodeContextMenu
            x={nodeMenu.x}
            y={nodeMenu.y}
            /*
             * 两者恒为 true：连线 / 移动位置都只改 Mermaid 代码，
             * 缩进模式下一样成立（缩进列表只是同一份图的另一种写法）。
             * 早先按 mode 关掉，用户必须先切到代码模式才能用 —— 见 nodeMenuAction 的注释。
             */
            showLink
            showMove
            /*
             * 触屏端行高 44px（见 NodeContextMenu.TOUCH_ROW）：
             * 手机端底部那条操作栏删掉之后，长按菜单是触屏唯一的入口，
             * 33px 的行高拇指点不准。桌面端 touch=false，行距一个像素没变。
             */
            touch={stacked}
            moveState={menuMoveState}
            swapHoriz={swapHoriz}
            onClose={() => setNodeMenu(null)}
            onPick={(action) => nodeMenuAction(action, nodeMenu)}
          />
        )}

        {/* ---------- 轻量提示：越界 / 拒绝执行 ---------- */}
        {/*
          位置跟着安全区走：`bottom-8`（32px）在刘海屏/手势条机型上会被系统
          手势条压住一截。`--mf-bottom-gap` 桌面端正好等于 12px，加 20px 还是
          原来的 32px —— 桌面端一个像素都没动，手机端自动抬到手势条之上。
          窄屏还要夹一下宽度，长提示不能把视口撑出横向滚动。
        */}
        {toast && (
          <div
            data-toast
            className="fixed left-1/2 z-[140] -translate-x-1/2 rounded-lg px-3.5 py-2 text-[12px] text-center shadow-pop mf-fade"
            style={{
              bottom: 'calc(var(--mf-bottom-gap) + 20px)',
              maxWidth: 'calc(100vw - 24px)',
              background: 'var(--mf-panel)',
              border: '1px solid var(--mf-hairline)',
              color: 'var(--mf-ink)',
            }}
          >
            {toast}
          </div>
        )}
      </div>
    </div>
  )
}
