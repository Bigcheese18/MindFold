import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  moveSiblingOrder, promoteNode, demoteNode,
  siblingsOf, parentsOf, childrenOf,
} from '../../lib/codeOps'

/**
 * 代码顺序换位（Move Node）—— 只改代码顺序，不做画布拖拽。
 *
 * 【为什么不做画布拖拽】
 * 这张图的坐标完全由 dagre 算出来，手动拖一个节点只会在下次重绘时被弹回去，
 * 还会让用户以为布局坏了。所以「移动」统一表达成**改代码里的书写顺序** ——
 * dagre 按边被加入的顺序决定同层左右次序，顺序一换位置就换。
 *
 * 还负责两件配套的小事：
 *   · 越界 / 拒绝执行的轻量提示（toast，2 秒自动消失）
 *   · 「移动位置」四个菜单项的可用性（到边界直接灰掉，比点了再报错体验好）
 */
export function useFoldMove({
  code, applyCode, autoSave, outline, syncLock,
  selectedNodeId, direction, nodeMenu,
  setSelectedNodeId, setNodeMenu,
}) {
  // 刚被移动的节点：重绘后闪一下，让用户明确感知到位置变了
  const [flashNodeId, setFlashNodeId] = useState(null)
  // 轻量提示（越界 / 拒绝执行），2 秒后自动消失
  const [toast, setToast] = useState(null)

  /** 轻量提示，2 秒后自动消失 */
  const showToast = useCallback((text) => {
    setToast(text)
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 2000)
  }, [])

  /**
   * 执行一次移动。
   * @param action 'up' | 'down' | 'promote' | 'demote'
   */
  const moveNode = useCallback((action, id) => {
    if (!id) return
    setNodeMenu(null)

    syncLock(() => {
      const dir = action === 'up' ? -1 : action === 'down' ? 1 : 0
      const res = (action === 'up' || action === 'down')
        ? moveSiblingOrder(code, id, dir)
        : action === 'promote' ? promoteNode(code, id) : demoteNode(code, id)

      if (!res.ok) {
        // 越界 → 什么都不做，只提示；拒绝执行 → 说清楚原因
        showToast(res.error || '无法移动')
        return
      }

      const ex = applyCode(res.code, 'now')
      autoSave({ outline: ex ? ex.outline : outline, mermaid: res.code })
      // 高亮保持在**同一个节点**上（selectedNodeId 不受行下标平移影响）
      setSelectedNodeId(id)
      setFlashNodeId(id)
      window.setTimeout(() => setFlashNodeId((f) => (f === id ? null : f)), 700)
    })
  }, [code, applyCode, autoSave, outline, syncLock, showToast, setSelectedNodeId, setNodeMenu])

  /*
   * 同级节点在屏幕上到底是「左右排开」还是「上下排开」——
   * 整个「移动位置」菜单的文案、图标、快捷键都从这一个判断派生，
   * 不允许各处各写一遍（写两遍就会有一处忘记跟着方向变）。
   *
   * dagre 的分层方向：
   *   TD / BT → rank 是纵向的，同一层（同级）节点**水平**排开 → 换位 = 左右
   *   LR / RL → rank 是横向的，同一层（同级）节点**垂直**排开 → 换位 = 上下
   */
  const swapHoriz = direction === 'TD' || direction === 'BT'

  /*
   * 方向键的两组含义，跟着图的物理方向走：
   *
   *   同级换位（只换代码顺序，不改父子关系）
   *   层级移动（真正改变节点在树里的层级）
   *
   * TD/BT（同级节点水平排开）：左右 = 换位，上下 = 改层级
   * LR/RL（同级节点上下排开）：上下 = 换位，左右 = 改层级
   *
   * 不做成「左右永远换位」是因为那样在 LR 布局下会**指错方向** ——
   * 菜单上写「左移一位」，节点却在屏幕上往下跳。
   */
  const swapByArrow = {
    ArrowLeft: 'up', ArrowRight: 'down', ArrowUp: 'promote', ArrowDown: 'demote',
  }
  const swapByArrowVertical = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'promote', ArrowRight: 'demote',
  }

  useEffect(() => {
    /*
     * 两种编辑模式都要挂：缩进列表和 Mermaid 代码只是**同一份图**的两种写法，
     * 「移动位置」改的始终是代码里的书写顺序，在缩进模式下一样成立
     * （applyCode 会把改完的代码反推回缩进列表）。早先这里限定 mode === 'code'，
     * 结果缩进模式下 Alt+方向键完全没反应，用户以为快捷键坏了。
     */
    const onKey = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const map = swapHoriz ? swapByArrow : swapByArrowVertical
      const action = map[e.key]
      if (!action) return
      // 在输入框里打字时不抢快捷键（Alt+方向键在文本框里是「按词移动光标」）
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return
      if (!selectedNodeId) {
        showToast(swapHoriz ? '先点一个节点，再用 Alt+←/→ 换位、Alt+↑/↓ 改层级' : '先点一个节点，再用 Alt+↑/↓ 换位、Alt+←/→ 改层级')
        return
      }
      e.preventDefault()
      moveNode(action, selectedNodeId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedNodeId, moveNode, showToast, swapHoriz])

  /**
   * 右键菜单里「移动位置」四个选项的可用性。
   * 到了边界的项直接灰掉不可点 —— 比点了再弹「已到边界」体验好得多。
   * 判据是结构性的（有没有兄弟 / 有没有祖父 / 有没有子节点），
   * 环检测那种运行期才知的拒绝仍然走 toast 提示。
   *
   * 【canPromote 为什么要求「有祖父」而不只是「有父节点」】
   * 需求写的是「已经是根节点的，上移一级置灰」。但还有第二种上不去的情况：
   * 父节点本身就是根 —— 再提升会让这个节点变成第二个根，图会断成两块，
   * `promoteNode` 会明确拒绝。那种情况下如果菜单还亮着，
   * 用户点完只得到一句报错，菜单就**误导**了。
   * 所以判据取的是「真的能提升」的充要条件，比需求写的更严一档。
   */
  const menuMoveState = useMemo(() => {
    /*
     * 不再限定 mode === 'code'：缩进模式下菜单同样要给出这四个动作的可用性，
     * 否则它们会全部显示为「可点」，点了才发现到边界了 —— 菜单在骗人。
     * 判据完全来自代码（而缩进模式下代码是由缩进列表编译出来的），两边一致。
     */
    if (!nodeMenu?.id) return null
    const id = nodeMenu.id
    const sibs = siblingsOf(code, id)
    const i = sibs.indexOf(id)
    const parent = parentsOf(code, id)[0] || null
    const grand = parent ? (parentsOf(code, parent)[0] || null) : null
    return {
      // 同级换位：同级里最靠前的一位不能再往前，最靠后的一位不能再往后
      canUp: i > 0,
      canDown: i >= 0 && i < sibs.length - 1,
      // 层级移动：根节点（以及父节点是根的节点）不能再往上；没有子节点不能再往下
      canPromote: !!grand,
      canDemote: !!parent && childrenOf(code, id).length > 0,
    }
  }, [nodeMenu, code])

  return { toast, showToast, flashNodeId, moveNode, menuMoveState, swapHoriz }
}
