import { useEffect } from 'react'
import { findParent, collectFolds } from '../lib/model'
import { store } from '../lib/store'

/**
 * 全局快捷键。
 *
 * 拆成独立 Hook 是因为它是 App 里最长的一个 effect（约 100 行），
 * 而且它的依赖几乎覆盖了所有节点操作 —— 留在 App 里会让主组件难以阅读。
 *
 * 【两套历史严格隔离的落点】
 * 主画布的 Ctrl+Z 放在 `inField || foldModal` 这道闸门**之后**，一次拿到两道保护：
 *   · 焦点在输入框里 → 不拦截，保留编辑器自带的文本撤销
 *   · 弹窗开着       → 交给弹窗，它管的是 Mermaid 源码那一份历史
 */
export function useGlobalKeys({
  doc, selectedId, editingId, foldModal, cards, radar, searchOpen, linkMode, renameTarget,
  canvasApi, searchRef,
  setSelectedId, setEditingId, setSearchOpen, setLinkMode, setRenameTarget, setCards, setRadar,
  addChild, addSibling, removeNode, toggleBold, toggleItalic, jumpTo,
  say, flushPending, handleCanvasUndo, handleCanvasRedo,
}) {
  useEffect(() => {
    const onKey = async (e) => {
      const mod = e.ctrlKey || e.metaKey
      /*
       * 「用户正在打字吗」——两个来源都要看：
       *   · `e.target`          —— 真实按键的目标元素
       *   · `document.activeElement` —— 焦点实际在哪
       *
       * 只看 e.target 是不够的：合成事件、浏览器扩展、以及从 window 上派发的
       * 事件，target 都是 window，`e.target.tagName` 是 undefined，
       * 于是一个「焦点明明在输入框里」的 Ctrl+Z 会被我们抢走，
       * 用户就没法撤销刚打错的字了（实测踩过）。
       * 折叠弹窗那边一直用的是 activeElement，这里对齐。
       */
      const isField = (el) => !!el && (/^(INPUT|TEXTAREA)$/.test(el.tagName || '') || !!el.isContentEditable)
      const inField = isField(e.target) || isField(document.activeElement)

      // Ctrl+S / Ctrl+F / Ctrl+0 在输入框里也要生效（用户预期如此）
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        // 先把待写队列落盘，再确保当前文档一定是最新的
        flushPending()
        if (doc) store.saveDoc(doc)
        say('已保存到本地')
        return
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => searchRef.current?.focus())
        return
      }
      /*
       * Ctrl+0 一键居中。
       *
       * 【弹窗打开时必须让给弹窗】
       * 折角弹窗打开后，主画布被整个盖住 —— 这时还去 center() 主画布，
       * 用户按了 Ctrl+0 却看不到任何变化（居中的是一张看不见的图）。
       * 所以弹窗开着时这里直接 return（**不 preventDefault**），
       * 把这次按键留给 FoldModal 自己的 Ctrl+0（居中预览区）。
       * 两边都 preventDefault 会让后注册的那个收不到。
       */
      if (mod && e.key === '0') {
        if (foldModal) return
        e.preventDefault()
        canvasApi.current?.center()
        return
      }
      if (inField || foldModal) return

      /*
       * 主画布的撤销 / 重做（两套历史隔离，理由见 Hook 顶部注释）。
       */
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) handleCanvasRedo()
        else handleCanvasUndo()
        return
      }

      if (mod && e.key.toLowerCase() === 'b' && selectedId) {
        e.preventDefault(); toggleBold(selectedId); return
      }
      if (mod && e.key.toLowerCase() === 'i' && selectedId) {
        e.preventDefault(); toggleItalic(selectedId); return
      }

      if (e.key === 'Tab' && selectedId) {
        e.preventDefault(); addChild(selectedId); return
      }
      if (e.key === 'Enter' && selectedId && !editingId) {
        e.preventDefault()
        // 根节点上按 Enter 没有意义，给根加子节点更符合直觉
        if (!findParent(doc.root, selectedId)) addChild(selectedId)
        else addSibling(selectedId)
        return
      }
      if (e.key === 'F2' && selectedId) { e.preventDefault(); setEditingId(selectedId); return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && findParent(doc?.root, selectedId)) {
        e.preventDefault(); removeNode(selectedId); return
      }
      if (e.key === 'Escape') {
        /*
         * 连线模式必须最先退出。
         *
         * 它是**模态**状态：此刻点任何节点都会被解释成「选目标」。
         * 如果 Esc 先去清 selectedId，用户会觉得「按了 Esc 但还在连线」，
         * 再点一下就意外建了个汇聚节点。
         */
        if (linkMode) setLinkMode(null)
        else if (renameTarget) setRenameTarget(null)
        else if (cards) setCards(false)
        else if (radar) setRadar(false)
        else if (searchOpen) setSearchOpen(false)
        else setSelectedId(null)
      }
      // 雷达模式下 N 跳下一个折角
      if ((e.key === 'n' || e.key === 'N') && radar && doc) {
        const folds = collectFolds(doc.root)
        if (!folds.length) return
        const idx = folds.findIndex((f) => f.node.id === selectedId)
        const next = folds[(idx + 1) % folds.length]
        jumpTo(next.node.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    selectedId, editingId, doc, foldModal, cards, radar, searchOpen, linkMode, renameTarget,
    addChild, addSibling, removeNode, toggleBold, toggleItalic, jumpTo, say, flushPending,
    handleCanvasUndo, handleCanvasRedo, canvasApi, searchRef,
    setSelectedId, setEditingId, setSearchOpen, setLinkMode, setRenameTarget, setCards, setRadar,
  ])
}
