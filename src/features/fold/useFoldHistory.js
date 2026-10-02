import { useCallback, useEffect, useRef, useState } from 'react'
import {
  emptyHistory, commitSnapshot, undoSnapshot, redoSnapshot,
  canUndo, canRedo,
} from '../../lib/history'
import { useDebouncedCallback } from '../../lib/hooks'

/**
 * 折角弹窗内的撤销 / 重做（只作用于本弹窗的 Mermaid 源码）。
 *
 * 【和另外两套历史严格隔离】
 *   · 本 Hook        → 弹窗里的 Mermaid 源码 / 缩进列表
 *   · 主画布          → 节点树（src/lib/canvasHistory.js）
 *   · 文档历史版本    → store.js 的 hist:<id>（落盘的）
 * 三套栈互不消费。
 *
 * 【历史栈为什么放 ref 而不是 state】
 * 入栈/出栈需要**同步**读到最新值，用 state 的话事件处理器拿到的是闭包里的旧值，
 * 连续操作会丢步。只有「能不能撤销/重做」这两个布尔量需要驱动 UI，单独放 state。
 *
 * @param doRender   重绘入口（快照恢复后要重画）
 * @param autoSave   落盘入口
 * @param syncLock   防死循环锁（和「改代码 → 重绘 → 联动」共用一把）
 * @param viewRef    图表容器，恢复后把焦点交还它
 * @param onRestore  把快照里的 code/outline/rowIds 写回组件 state
 */
export function useFoldHistory({ doRender, autoSave, syncLock, viewRef, onRestore }) {
  const historyRef = useRef(emptyHistory())
  const [histState, setHistState] = useState({ canUndo: false, canRedo: false })

  const syncHistState = useCallback(() => {
    setHistState({
      canUndo: canUndo(historyRef.current),
      canRedo: canRedo(historyRef.current),
    })
  }, [])

  /*
   * 撤销/重做本身会改 code —— 那是「恢复历史」，绝不能再入一次栈，
   * 否则撤销会自己制造新的历史，永远退不回去。
   * 这个标记只在恢复期间置位。
   */
  const historySuppressRef = useRef(false)

  /** 打字类改动：停笔 1 秒后才算一次历史点 */
  const commitTyping = useDebouncedCallback((next) => {
    if (historySuppressRef.current) return
    historyRef.current = commitSnapshot(historyRef.current, next)
    syncHistState()
  }, 1000)

  /**
   * 安排一次历史入栈。
   *   'now'  结构性操作（新增/删除/合并/移动/改方向）—— 立刻入栈
   *   'soon' 打字 —— 停笔 1 秒后入栈，避免每个字符都占一格历史
   *   'skip' 不记录
   */
  const scheduleCommit = useCallback((mode, next) => {
    if (mode === 'skip' || historySuppressRef.current) return
    if (mode === 'now') {
      commitTyping.cancel?.()          // 立刻入栈时，挂起的打字提交作废
      historyRef.current = commitSnapshot(historyRef.current, next)
      syncHistState()
      return
    }
    commitTyping(next)
  }, [commitTyping, syncHistState])

  /**
   * 把一份历史快照恢复出来。
   *
   * 三个要点：
   *   1. code 和 outline **一起**写回，不能只写 code ——
   *      outline 是用户手写的排版，从 code 反推会被规范化重排。
   *   2. 恢复期间置 historySuppressRef，否则这次改动会被当成新变化再入栈，
   *      撤销就永远退不回去（撤销自己制造新历史）。
   *   3. 用 syncLock 包住，和「改代码 → 重绘 → 联动」那条链路共用同一把锁，
   *      防止重绘反过来又触发一次入栈。
   */
  const restoreSnapshot = useCallback((snap) => {
    if (!snap) return
    historySuppressRef.current = true
    syncLock(() => {
      onRestore(snap)
      doRender(snap.code)
      autoSave({ outline: snap.outline, mermaid: snap.code })
    })
    historySuppressRef.current = false
    // 焦点交还图表容器，否则紧接着按 Ctrl+Z / Alt+方向键会失效
    window.requestAnimationFrame(() => viewRef.current?.focus?.({ preventScroll: true }))
  }, [syncLock, onRestore, doRender, autoSave, viewRef])

  const handleUndo = useCallback(() => {
    /*
     * 先把挂起的打字提交**落地**，再撤销 —— 不能 cancel。
     *
     * 如果用户打完字 1 秒内就按 Ctrl+Z：
     *   cancel 的话这次改动根本没成为历史点，撤销会跳过它、退到更早的状态，
     *   用户会觉得「我刚打的字没了，而且还多退了一步」。
     *   flush 的话它先成为一个历史点，撤销正好回到打字之前 —— 符合直觉。
     */
    commitTyping.flush?.()
    const next = undoSnapshot(historyRef.current)
    if (!next) return
    historyRef.current = next
    syncHistState()
    restoreSnapshot(next.current)
  }, [commitTyping, syncHistState, restoreSnapshot])

  const handleRedo = useCallback(() => {
    /*
     * 重做同样先 flush：
     *   · 没有挂起改动时它是空操作，不影响重做；
     *   · 有挂起改动（撤销后又编辑了）时，flush 会走新分支并清空 future，
     *     于是重做自然变成空操作 —— 这正是正确的语义。
     */
    commitTyping.flush?.()
    const next = redoSnapshot(historyRef.current)
    if (!next) return
    historyRef.current = next
    syncHistState()
    restoreSnapshot(next.current)
  }, [commitTyping, syncHistState, restoreSnapshot])

  /* ---- 快捷键：Ctrl/⌘ + Z 撤销，Ctrl/⌘ + Shift + Z 重做 ---- */
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.key.toLowerCase() !== 'z') return
      /*
       * 焦点在输入框/文本域里时**绝不拦截**：
       * 代码编辑器有自己的文本撤销，抢过来会让用户没法撤销打错的字。
       * 只有焦点在图表区域（或用户直接点了按钮）才走我们的历史栈。
       */
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return
      e.preventDefault()
      if (e.shiftKey) handleRedo()
      else handleUndo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleUndo, handleRedo])

  return {
    historyRef, histState, syncHistState,
    commitTyping, scheduleCommit, restoreSnapshot, handleUndo, handleRedo,
  }
}
