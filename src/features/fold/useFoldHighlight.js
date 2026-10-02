import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseCodeLineIndex } from '../../lib/codeLineMap'
import { useDebouncedCallback } from '../../lib/hooks'

/**
 * 右侧流程图 ↔ 左侧编辑器 的双向高亮联动 + 事件委托。
 *
 * 【为什么所有交互都委托到容器上】
 * mermaid 每次重绘都会把整棵 SVG 换掉，绑在节点上的监听器会一起消失，
 * 所以统一通过 `e.target.closest('g.node')` 找节点。
 *
 * 【选中状态为什么用 mermaid 节点 id 而不是行下标】
 * 行下标是「行在缩进列表里的位置」，代码一改（换位、新增、删除）
 * 所有下标都会平移 —— 用行下标记选中，换位之后高亮会跳到别的节点上，
 * 用户按快捷键就失去了目标。用 id 记就天然稳定。
 */
export function useFoldHighlight({
  code, svg, mode, rowIds, selectedNodeId, flashNodeId, previewRef,
}) {
  // 悬停的节点（行下标）
  const [hoverIdx, setHoverIdx] = useState(null)
  // 图上鼠标悬停的节点 id（立即生效，用于节点自身的高亮）
  const [hoverNodeId, setHoverNodeId] = useState(null)
  // 悬停落到代码行的**防抖结果**（150ms）—— 快速划过时不闪
  const [hoverCodeLine, setHoverCodeLine] = useState(null)
  // 左侧光标所在行的节点（200ms 防抖后）→ 反向高亮右侧
  const [caretNodeIds, setCaretNodeIds] = useState([])
  // 一次性滚动请求 { line, seq }：点图上节点 → 代码滚到视野中间
  const [scrollReq, setScrollReq] = useState(null)
  const scrollSeqRef = useRef(0)

  /*
   * 这张表是整条链路的地基：mermaid 节点 id → 它写在源码的第几行。
   *
   * 【为什么挂在 code 上重算，而不是等「重绘成功」之后】
   * 需求写的是「触发 Mermaid 重绘后刷新」。但语法错的时候 mermaid 会保留
   * 上一版正确的图 —— 若跟着「重绘成功」走，用户打字打到一半（几乎永远是
   * 错的）映射就停止更新了，联动直接失效。挂在 code 上等于**每次文本变化
   * 都刷新**，只会比「重绘后」更新，永远不会落后于用户看到的内容。
   * 而且 parseCodeLineIndex 是逐行解析、坏行只丢自己，不会整体失败。
   */
  const lineIndex = useMemo(() => parseCodeLineIndex(code), [code])

  /**
   * 联动专用同步锁。
   *
   * 为什么不复用主流程那把 syncLock：那把锁是给「改代码」用的，持锁期间
   * syncLock 会**直接跳过**函数体。两件事共用一把锁的话，用户在改代码的
   * 同时划一下鼠标，高亮就会被静默丢掉（反过来也一样）。
   *
   * 真正的防死循环靠的是**结构**而不是锁：高亮只做 classList 增删，
   * 一个字节都不写 code / outline / rowIds，所以它不可能触发重绘；
   * 重绘也不会重置高亮状态（状态在 React 里，不在 SVG 上），
   * effect 每次重绘后按状态重新贴 class 即可。
   * 这把锁只是再加一道重入保险。
   */
  const linkSyncingRef = useRef(false)
  const linkSync = useCallback((fn) => {
    if (linkSyncingRef.current) return null
    linkSyncingRef.current = true
    try { return fn() } finally { linkSyncingRef.current = false }
  }, [])

  /**
   * 图 → 代码：150ms 防抖。
   * 需求明确要求防抖，否则鼠标快速划过一排节点时左侧代码会疯狂闪烁。
   */
  const hoverLineSoon = useDebouncedCallback((id) => {
    if (mode !== 'code') { setHoverCodeLine(null); return }
    setHoverCodeLine(id ? (lineIndex.lineMap[id] ?? null) : null)
  }, 150)

  /**
   * 代码 → 图：200ms 防抖。
   * 取「光标所在行包含的节点 id」—— 一行上可能有多个（`n0 --> n1` 两端都算）。
   */
  const caretSoon = useDebouncedCallback((lineNo) => {
    if (mode !== 'code') { setCaretNodeIds([]); return }
    setCaretNodeIds(lineIndex.byLine[lineNo] || [])
  }, 200)

  /** 从 <g class="node"> 取出 mermaid 节点 id（mf-mmd-1-flowchart-A-0 → A） */
  const idOfNodeEl = useCallback((gEl) => {
    if (!gEl) return null
    const m = (gEl.getAttribute('id') || '').match(/flowchart-(.+?)-\d+$/)
    return m ? m[1] : null
  }, [])

  /**
   * 从 <g class="node"> 反推行下标。
   *
   * 先按 mermaid id 查 rowIds（代码模式下 id 是用户写的 A/B/C，
   * 和行下标没有任何关系，只能靠反推出来的映射）；
   * 查不到再退回按 DOM 顺序对应，保证最坏情况下也能联动。
   */
  const indexOfNodeEl = useCallback((gEl) => {
    const host = previewRef.current
    if (!gEl || !host) return null
    const id = idOfNodeEl(gEl)
    if (id) {
      const i = rowIds.indexOf(id)
      if (i >= 0) return i
    }
    const all = [...host.querySelectorAll('g.node')]
    const i = all.indexOf(gEl)
    return i >= 0 ? i : null
  }, [idOfNodeEl, rowIds, previewRef])

  /** 行下标 → mermaid 节点 id（悬停左侧行时定位右侧连线要用） */
  const idOfRow = useCallback((idx) => {
    if (idx == null) return null
    return rowIds[idx] ?? `n${idx}`
  }, [rowIds])

  /** 按 mermaid id 找 <g class="node"> 元素（自动弹改字框要定位它） */
  const findNodeElById = useCallback((host, id) => {
    if (!host || !id) return null
    for (const el of host.querySelectorAll('g.node')) {
      if (idOfNodeEl(el) === id) return el
    }
    return null
  }, [idOfNodeEl])

  /**
   * 请求把某一行滚到视野中间。
   *
   * 行号**不缓存**，每次都用当前映射现算 —— 用户完全可能在选中之后
   * 又改了上面的代码，缓存行号会让高亮停在错的那一行上。
   * 滚动则相反：它是一次性的副作用，只在点击这一刻发生，
   * 否则每敲一个字都会把编辑器滚一下，根本没法打字。
   * seq 用来让「重复点同一个节点」也能重新触发滚动。
   */
  const requestScroll = useCallback((line) => {
    if (line == null) return
    setScrollReq({ line, seq: ++scrollSeqRef.current })
  }, [])

  /**
   * 把高亮/悬停状态画到 SVG 上。
   * 依赖 svg 一起重跑：mermaid 重绘会把整棵 SVG 换掉、class 全没了，必须重新贴。
   * 这也是需求里「图重绘后必须重新应用高亮样式」那一条的落点。
   */
  useEffect(() => {
    const host = previewRef.current
    if (!host) return
    linkSync(() => {
      for (const el of host.querySelectorAll(
        '.mf-node-sel, .mf-node-hover, .mf-edge-hl, .mf-node-flash, .mf-node-code-hl'
      )) {
        el.classList.remove('mf-node-sel', 'mf-node-hover', 'mf-edge-hl', 'mf-node-flash', 'mf-node-code-hl')
      }

      const nodes = [...host.querySelectorAll('g.node')]
      // 按 mermaid id 找节点，而不是按 DOM 顺序 ——
      // 代码模式下 DOM 顺序和行下标对不上，按顺序贴会高亮错人
      const elById = new Map()
      for (const el of nodes) {
        const id = idOfNodeEl(el)
        if (id) elById.set(id, el)
      }

      // 选中/闪烁都直接按 id 找；悬停来自左侧列表时给的是行下标
      const selEl = selectedNodeId ? elById.get(selectedNodeId) : null
      if (selEl) selEl.classList.add('mf-node-sel')

      /*
       * 悬停来源有两路：
       *   · 图上划过（代码模式）→ hoverNodeId 已经是 mermaid id
       *   · 左侧缩进列表划过    → 给的是行下标，要用 rowIds 换成 id
       * 前者优先，因为它更精确（不依赖反推出来的映射）。
       */
      const hoverId = hoverNodeId ?? (hoverIdx != null ? idOfRow(hoverIdx) : null)
      const hovEl = hoverId ? elById.get(hoverId) : null
      if (hovEl) hovEl.classList.add('mf-node-hover')

      // 换位后闪一下，让用户明确感知到「位置变了」
      const flashEl = flashNodeId ? elById.get(flashNodeId) : null
      if (flashEl) flashEl.classList.add('mf-node-flash')

      /*
       * 反向联动：左侧代码光标停在 `n1 --> n2` 这一行时，
       * 右侧把 n1、n2 都描蓝。一行有几个节点就高亮几个 ——
       * 需求要的就是「光标所在行**包含**的节点 id」。
       */
      if (mode === 'code' && caretNodeIds.length) {
        for (const id of caretNodeIds) {
          const el = elById.get(id)
          if (el) el.classList.add('mf-node-code-hl')
        }
      }

      /**
       * 悬停/选中时把连着这个节点的线加粗：**入边和出边都要**。
       * 连线 id 形如 mf-mmd-1-L_A_B_0 —— 两端各有一个下划线包围的节点 id，
       * 所以用 _X_ 匹配能同时命中「X 出发的边」和「指向 X 的边」。
       * 这正是 PRD 要的「一眼看清逻辑流向」。
       */
      const activeId = hoverId ?? selectedNodeId
      if (activeId) {
        const needle = `_${activeId}_`
        for (const p of host.querySelectorAll('path.flowchart-link')) {
          if ((p.getAttribute('id') || '').includes(needle)) p.classList.add('mf-edge-hl')
        }
      }
    })
  }, [
    selectedNodeId, hoverIdx, hoverNodeId, flashNodeId, svg,
    idOfNodeEl, idOfRow, caretNodeIds, mode, linkSync, previewRef,
  ])

  const onSvgMouseMove = useCallback((e) => {
    const g = e.target?.closest?.('g.node')
    const id = g ? idOfNodeEl(g) : null
    const idx = g ? indexOfNodeEl(g) : null
    setHoverIdx((prev) => (prev === idx ? prev : idx))
    // 节点自身的悬停高亮要**立即**跟上鼠标，不能等防抖
    setHoverNodeId((prev) => (prev === id ? prev : id))
    // 左侧代码行的高亮走 150ms 防抖（快速划过一排节点时不闪）
    hoverLineSoon(id)
  }, [indexOfNodeEl, idOfNodeEl, hoverLineSoon])

  const onSvgMouseLeave = useCallback(() => {
    setHoverIdx(null)
    setHoverNodeId(null)
    // 鼠标移开 → 高亮立刻消失（不必等防抖，否则会「黏」在屏幕上）
    hoverLineSoon.cancel?.()
    setHoverCodeLine(null)
  }, [hoverLineSoon])

  /**
   * 代码光标移动 → 反查「这一行有哪些节点」。
   *
   * 用光标事件（select / keyup / click / focus）而不是 onMouseMove：
   * 需求给的是「光标移动事件（或 onMouseMove）」二选一。
   * 光标事件更准 —— 鼠标在编辑器里划过时并不代表用户在看那一行，
   * 而且 mousemove 触发频率高得多，防抖窗口内会被反复重置。
   */
  const onCodeCaret = useCallback((lineNo) => {
    if (mode !== 'code') return
    if (linkSyncingRef.current) return      // 联动进行中不重入
    caretSoon(lineNo)
  }, [mode, caretSoon])

  return {
    lineIndex,
    hoverIdx, setHoverIdx,
    hoverNodeId, setHoverNodeId,
    hoverCodeLine, setHoverCodeLine,
    caretNodeIds, setCaretNodeIds,
    scrollReq, setScrollReq, requestScroll,
    idOfNodeEl, indexOfNodeEl, idOfRow, findNodeElById,
    onSvgMouseMove, onSvgMouseLeave, onCodeCaret,
  }
}
