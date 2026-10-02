import { useCallback, useState } from 'react'
import {
  mergeToNewNode, linkNodesInCode, DEFAULT_MERGE_LABEL,
} from '../../lib/codeOps'

/**
 * 连线模式：A → B（指向） / A + B → 新建结果节点（指向同一结果）。
 *
 * 【为什么是一个状态而不是两个布尔量】
 * 两个功能的前半段完全相同：右键节点 A → 进入待选 → 点节点 B。
 * 区别只在「点到 B 之后往代码里写什么」。用一个 linkingMode 表达，
 * 就天然保证了互斥 —— 不可能出现「指向」和「指向同一结果」同时待选
 * （两个布尔量一定能构造出 `true && true` 这个非法组合）。
 *
 *   null      未连线
 *   'direct'  指向         → 往代码里加一条 `A --> B`
 *   'merge'   指向同一结果  → 新建 n9 + `A --> n9` + `B --> n9`
 *
 * linkingMode 非 null 时 linkFromId 一定有值；两者必须同进同退，
 * 所以只通过 startLinking / stopLinking 两个口子改，不允许各处 setState。
 */
export function useFoldLinking({
  code, applyCode, autoSave, outline, syncLock,
  showToast, setError, setSelectedNodeId, setNodeMenu, viewRef,
}) {
  const [linkingMode, setLinkingMode] = useState(null)
  const [linkFromId, setLinkFromId] = useState(null)     // 节点 A 的 mermaid id
  // 新节点渲染出来后要立刻弹改字框，这里存它的 id（一次性令牌，消费后清空）
  const [pendingLabelNode, setPendingLabelNode] = useState(null)

  /**
   * 进入连线模式。
   *
   * 【节点 A 要保持选中高亮】
   * 需求明确要求。除了给用户「我选中了谁」的视觉确认，它还让
   * `selectedNodeId` 在待选期间始终有效 —— 万一用户按 Esc 退出，
   * 选区不会莫名其妙消失，可以直接继续用快捷键。
   *
   * 说明：右键打开菜单时 `onSvgContextMenu` 已经把该节点设成选中了，
   * 所以这一行在**当前**调用路径下是冗余的。之所以留着，是因为它把
   * 「进入连线模式 → 源节点必须是选中的」这条不变量**钉在模式入口**上：
   * 以后若多出别的入口（快捷键、底栏、未来的触摸手势），
   * 不会因为忘了先选中而出现「待选中却没有高亮」的半截状态。
   * 对应的回归测试断言的是「进入模式后选中项仍是 A」这个行为本身。
   */
  const startLinking = useCallback((mode, fromId) => {
    setNodeMenu(null)
    setLinkingMode(mode)
    setLinkFromId(fromId)
    setSelectedNodeId(fromId)
  }, [setNodeMenu, setSelectedNodeId])

  /**
   * 退出连线模式。
   * linkingMode 和 linkFromId 必须一起清 —— 只清一个会留下
   * 「模式已退出但源节点还在」的幽灵状态，下次进模式时串味。
   */
  const stopLinking = useCallback(() => {
    setLinkingMode(null)
    setLinkFromId(null)
  }, [])

  /**
   * 连线结束后把焦点还给右侧画布容器。
   *
   * 需求四·1 明确要求「点击节点 B 完成后，焦点应该回到右侧画布容器
   * （方便用户继续按快捷键）」。点节点时浏览器会把焦点移到 svg/body 上，
   * 而 Alt+方向键那套快捷键是挂在 window 上的，靠的是「不在输入框里」这个条件；
   * 主动聚焦容器能让后续的方向键、Esc 行为都落在一个明确的锚点上。
   */
  const focusGraph = useCallback(() => {
    window.requestAnimationFrame(() => viewRef.current?.focus?.({ preventScroll: true }))
  }, [viewRef])

  /**
   * 执行「指向」：往代码里加一条 `A --> B`。
   *
   * 原子性由 linkNodesInCode 保证（先算 → 重新解析校验 → 通过才返回），
   * 失败时返回 ok:false，代码一个字都不改。
   */
  const doDirectLink = useCallback((targetId) => {
    const from = linkFromId
    stopLinking()
    if (!from || !targetId) return

    syncLock(() => {
      const res = linkNodesInCode(code, from, targetId)
      if (!res.ok) {
        // 「该连线已存在」是用户操作层面的正常反馈，不该用红色报错框吓人
        if (res.error === '该连线已存在') showToast(res.error)
        else setError({ message: res.error, line: null, tip: '代码未被修改。' })
        focusGraph()
        return
      }
      const ex = applyCode(res.code, 'now')   // 'now' → 立刻压入弹窗撤销栈
      autoSave({ outline: ex ? ex.outline : outline, mermaid: res.code })
      // 高亮停在源节点上，用户能立刻看到新连线从它出发
      setSelectedNodeId(from)
      showToast(`已添加连线 ${from} → ${targetId}`)
      focusGraph()
    })
  }, [linkFromId, stopLinking, code, applyCode, autoSave, outline, syncLock,
      showToast, focusGraph, setError, setSelectedNodeId])

  /**
   * 执行合并。整个过程是原子的：
   * mergeToNewNode 先算好新代码并重新解析校验（节点数恰好 +1、两条边都在），
   * 校验不过就整体放弃，代码一个字都不动。
   */
  const doMerge = useCallback((targetId) => {
    const from = linkFromId
    stopLinking()
    if (!from || !targetId) return

    syncLock(() => {
      const res = mergeToNewNode(code, from, targetId, DEFAULT_MERGE_LABEL)
      if (!res.ok) {
        setError({ message: res.error, line: null, tip: '代码未被修改。' })
        focusGraph()
        return
      }
      const ex = applyCode(res.code, 'now')   // 'now' → 立刻压入弹窗撤销栈
      autoSave({ outline: ex ? ex.outline : outline, mermaid: res.code })
      // 渲染完成后自动弹出改字框（令牌在 svg 变化后被消费）
      setPendingLabelNode(res.newId)
      focusGraph()
    })
  }, [linkFromId, stopLinking, code, applyCode, autoSave, outline, syncLock, focusGraph, setError])

  /**
   * 连线模式下点中了某个节点。
   *
   * 两个分支共用「源节点」和「退出模式」这两件事，只有代码生成不同 ——
   * 这正是 linkingMode 存在的意义。
   */
  const pickLinkTarget = useCallback((targetId) => {
    if (!targetId) return
    // 点自己：忽略 + 极简提示（需求一·3）
    if (targetId === linkFromId) {
      showToast('不能指向自身')
      return
    }
    if (linkingMode === 'merge') doMerge(targetId)
    else doDirectLink(targetId)
  }, [linkFromId, linkingMode, doMerge, doDirectLink, showToast])

  /** 点空白 / Esc：退出连线模式（代码一个字不动） */
  const cancelLinking = useCallback(() => {
    if (!linkingMode) return
    stopLinking()
    focusGraph()
  }, [linkingMode, stopLinking, focusGraph])

  return {
    linkingMode, linkFromId,
    pendingLabelNode, setPendingLabelNode,
    startLinking, stopLinking, pickLinkTarget, cancelLinking,
  }
}
