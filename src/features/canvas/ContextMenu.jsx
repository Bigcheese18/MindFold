import React, { useEffect, useRef } from 'react'
import { GitMergeIcon, GitBranchIcon } from '../../components/icons'
import { safeInsets } from '../../lib/hooks'

/**
 * 右键菜单
 * ========
 * 节点上 = 极简三件套（新建子节点 / 删除 / 打上折角）+ 基础样式（加粗 Ctrl+B、斜体 Ctrl+I）
 * 带折角时，「打上折角」原地变成「取消折角」
 *
 * 【「指向」与「指向同一结果」是一对，必须挨着放】
 *   · 指向          —— 从当前节点拉一条线出去，连到**已经存在**的节点上
 *   · 指向同一结果  —— 当前节点和另一个节点**共同**指向一个**新建**的节点
 * 两者共用同一套「进入连线模式 → 再点一个目标节点」的交互，所以：
 *   · 文案并排、图标同族（branch / merge），用户一眼能看出是同一类操作
 *   · 两个入口互斥：进入其中一个模式时另一个必然已经关闭（由父组件的
 *     linkMode 单一状态保证，不给它们各自维护一份状态的机会）
 *
 * 菜单本身要避免溢出屏幕边缘（和气泡同一套 clamp 逻辑）。
 *
 * 【为什么夹取要减掉系统安全区，而不是贴原始视口边】
 * 实测（探针把 --mf-safe-t/-b 置成真机刘海屏量级 47/34，竖屏 390×844）：
 * 菜单高 341px，原来 ny = 844 - 341 - 8 = 495，下缘落在 **836**，
 * 而底部工具栏上缘在 758、手势条可用底在 810 —— 也就是说最后一项
 * 「删除节点」整个压在底栏/手势区里（量到 t=798 b=831，越界 21px）。
 * 原因就是 margin=8 是相对**物理**视口边算的，而手机上那 34px 手势条
 * 和 47px 状态栏都不是可交互区域。
 * 现在夹取范围 = 视口 - 安全区，桌面端四个安全区都是 0 → 逐像素不变。
 */
export default function ContextMenu({ x, y, node, onClose, actions, linkDisabled = false }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 8
    const safe = safeInsets()
    const maxX = window.innerWidth - safe.r - margin
    const maxY = window.innerHeight - safe.b - margin
    const minX = safe.l + margin
    const minY = safe.t + margin
    let nx = x
    let ny = y
    if (nx + r.width > maxX) nx = maxX - r.width
    if (ny + r.height > maxY) ny = maxY - r.height
    el.style.left = `${Math.max(minX, nx)}px`
    el.style.top = `${Math.max(minY, ny)}px`
  }, [x, y])

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    // 用 capture：先于业务 handler 关闭，避免右键另开一个菜单时旧菜单残留
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const hasFold = !!node.fold
  const isRoot = actions.isRoot

  /**
   * 菜单项。
   *
   * `action` 是稳定的机器可读标识（`data-menu-item`），文案可以随便改 ——
   * 测试和无障碍查询都按它来，不去匹配中文文案。
   *
   * `opts.icon` 可选：给了就在左侧渲染一个内联图标。
   * 「指向」和「指向同一结果」靠它区分 —— 两个中文标签都以「指向」开头，
   * 光看字很容易看串行。
   */
  const item = (action, label, shortcut, onClick, opts = {}) => (
    <button
      key={action}
      data-menu-item={action}
      disabled={opts.disabled}
      onClick={() => { onClick(); onClose() }}
      className="w-full flex items-center gap-3 px-3 py-[7px] text-[12.5px] rounded-md transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
      style={{ color: opts.danger ? '#ef4444' : 'var(--mf-ink)' }}
      onMouseEnter={(e) => { if (!opts.disabled) e.currentTarget.style.background = 'var(--mf-faint)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {opts.icon
        ? <span data-menu-icon className="shrink-0" style={{ color: 'var(--mf-muted)' }}>{opts.icon}</span>
        : <span className="w-0 shrink-0" />}
      <span className="flex-1 text-left">{label}</span>
      {shortcut && <span className="text-[10.5px]" style={{ color: 'var(--mf-muted)' }}>{shortcut}</span>}
    </button>
  )

  const sep = <div className="my-1 h-px" style={{ background: 'var(--mf-hairline)' }} />

  return (
    <div
      ref={ref}
      data-canvas-menu
      className="fixed z-[80] min-w-[192px] rounded-xl border shadow-pop p-1 mf-fade"
      style={{ left: x, top: y, background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {item('add-child', '新建子节点', 'Tab', () => actions.addChild(node.id))}
      {item('add-sibling', '新建同级节点', 'Enter', () => actions.addSibling(node.id), { disabled: isRoot })}
      {sep}

      {/* 折角三件套的核心：打上 / 取消 */}
      {hasFold
        ? item('remove-fold', '取消折角', '', () => actions.removeFold(node.id), { danger: true })
        : item('add-fold', '打上折角', '', () => actions.addFold(node.id))}

      {hasFold && node.fold.corner && item('open-fold', '打开流程图', '', () => actions.openFold(node.id))}
      {sep}

      {item('bold', '加粗', 'Ctrl+B', () => actions.toggleBold(node.id))}
      {item('italic', '斜体', 'Ctrl+I', () => actions.toggleItalic(node.id))}
      {sep}

      {/*
        「指向」与「指向同一结果」—— 并列的一对，共用「再点一个节点」的交互。
        根节点上两个都置灰：根是全图的起点，让它去指向别人会把树读反。
        连线模式已经在进行中（linkDisabled）时也置灰，避免叠加两个待选状态。
      */}
      {item('point-to', '指向', '', () => actions.startLink(node.id), {
        icon: <GitBranchIcon size={13} />,
        disabled: isRoot || linkDisabled,
      })}
      {item('point-merge', '指向同一结果', '', () => actions.startMerge(node.id), {
        icon: <GitMergeIcon size={13} />,
        disabled: isRoot || linkDisabled,
      })}
      {sep}

      {item('rename', '重命名', '双击', () => actions.rename(node.id))}
      {item('remove', '删除节点', 'Del', () => actions.remove(node.id), { danger: true, disabled: isRoot })}
    </div>
  )
}