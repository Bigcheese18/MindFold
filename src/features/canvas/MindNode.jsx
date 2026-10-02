import React, { useRef, useState, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import FoldCorner from '../../components/FoldCorner'
import { clampToViewport, useCommitOnOutsidePointerDown } from '../../lib/hooks'

/**
 * 导图节点
 * ========
 * 长文本处理（PRD 要求）：
 *   - 超过 2 行 → 显示省略号（-webkit-line-clamp: 2）
 *   - hover 时弹出「圆角带阴影卡片」显示全文
 *   - 气泡必须智能避让屏幕边缘（用 clampToViewport 做真实测量后 clamp）
 */
export default function MindNode({
  item,
  selected,
  isEditing,
  onSelect,
  onToggleCollapse,
  onOpenFold,
  onStartEdit,
  onCommitEdit,
  onContextMenu,
  onPointerDownNode,
  onHover,
  zoom = 1,
  isDragging = false,
  dropHighlight = false,
  linkSource = false,
  linkCandidate = false,
}) {
  const { node, x, y, w, h, hiddenFold } = item
  const ref = useRef(null)
  const bubbleRef = useRef(null)
  const [hover, setHover] = useState(false)
  // tip: null = 不显示；{ measuring:true } = 先离屏渲染用于量尺寸；否则是最终坐标
  const [tip, setTip] = useState(null)
  const [draft, setDraft] = useState(node.text)

  // 是否真的被截断（只有被截断才需要气泡，短文本弹气泡是噪音）
  const isTruncated = () => {
    const el = ref.current?.querySelector('[data-text]')
    if (!el) return false
    return el.scrollHeight > el.clientHeight + 1
  }

  /** 第一步：悬停到被截断的节点时，先让气泡以「隐藏」状态渲染出来 */
  useLayoutEffect(() => {
    if (!hover || isEditing || !isTruncated()) { setTip(null); return }
    setTip({ measuring: true })
  }, [hover, isEditing, node.text])

  /**
   * 第二步：量出气泡的**真实**尺寸再做边缘避让。
   *
   * 早先版本是按字数估算高度，长文本会估得比实际小，clamp 之后照样溢出屏幕。
   * 这里用两趟布局：第一趟隐藏渲染拿真实宽高，第二趟给出最终坐标。
   * useLayoutEffect 在浏览器绘制前执行，所以用户看不到中间态。
   */
  useLayoutEffect(() => {
    if (!tip?.measuring) return
    const nodeEl = ref.current
    const bubbleEl = bubbleRef.current
    if (!nodeEl || !bubbleEl) return
    const a = nodeEl.getBoundingClientRect()
    const b = bubbleEl.getBoundingClientRect()
    const pos = clampToViewport(
      { left: a.left, top: a.top, width: a.width, height: a.height, bottom: a.bottom },
      { width: b.width, height: b.height }
    )
    setTip({ left: pos.left, top: pos.top })
  }, [tip])

  const hasFold = !!node.fold
  const hidden = hiddenFold > 0

  /*
   * 双击改完字，点到节点外面 = 确认（和 Enter 同一个动作）。
   *
   * 主画布这边 onBlur 本来是能工作的（画布没在 mousedown 上 preventDefault），
   * 但「点旁边确认」是用户的明确要求，而 onBlur 依赖浏览器真的移动了焦点 ——
   * 任何一处 preventDefault 都会让它静默失效（折角弹窗就是这么坏的）。
   * 这里补一条不依赖焦点的路径，两处行为从此一致；重复提交由 App 的
   * updateTree「没变就不入历史」兜底，不会多出一格撤销。
   */
  useCommitOnOutsidePointerDown(isEditing, ref, () => onCommitEdit?.(node.id, draft))

  return (
    <>
      <div
        ref={ref}
        data-node-id={node.id}
        data-dragging={isDragging ? 'true' : undefined}
        data-drop-highlight={dropHighlight ? 'child' : undefined}
        data-link-source={linkSource ? 'true' : undefined}
        data-link-candidate={linkCandidate ? 'true' : undefined}
        className={[
          'mf-node absolute flex items-center rounded-lg border transition-colors',
          hasFold ? 'has-fold' : '',
        ].join(' ')}
        style={{
          left: x,
          top: y,
          width: w,
          height: h,
          // 折角节点不再铺一层底色：识别折角靠右上角的圆形角标，
          // 铺底色会让节点看起来像套了个方框，也容易和选中态混淆。
          background: dropHighlight ? 'var(--mf-hover)' : 'transparent',
          /*
           * 边框优先级：连线模式 > 拖拽落点 > 选中 > 普通。
           *
           * 连线模式必须压过一切 —— 它是个**模态**操作，用户此刻唯一该关心的
           * 就是「点哪个」。源节点用实线蓝框（我是起点），其余节点用淡蓝虚线框
           * （都可点），两种一眼可分。
           */
          borderColor: linkSource
            ? '#3b82f6'
            : linkCandidate
              ? 'rgba(59, 130, 246, .45)'
              : dropHighlight
                ? 'var(--mf-accent)'
                : (selected ? 'var(--mf-accent)' : 'var(--mf-hairline)'),
          borderStyle: linkCandidate && !linkSource ? 'dashed' : 'solid',
          // 选中 = 柔和光晕；拖拽落点（将成为子节点）= 更实的浅色高亮边框
          boxShadow: linkSource
            ? '0 0 0 3px rgba(59, 130, 246, .28)'
            : dropHighlight
              ? '0 0 0 3px color-mix(in srgb, var(--mf-accent) 22%, transparent)'
              : (selected ? '0 0 0 3px rgba(59, 130, 246, .16)' : 'none'),
          fontWeight: node.bold ? 600 : 400,
          fontStyle: node.italic ? 'italic' : 'normal',
          zIndex: selected || linkSource ? 10 : 1,
          // 悬停时是张开的小手，提示「这里可以按住拖」
          // 连线模式下一律十字准星，和画布保持一致
          cursor: linkCandidate || linkSource ? 'crosshair' : (isEditing ? 'text' : 'grab'),
          // 被拖走的是幽灵，原位留一个淡淡的影子表示「它从这里来」
          opacity: isDragging ? 0.28 : 1,
        }}
        onPointerDown={(e) => onPointerDownNode?.(e, node)}
        onClick={(e) => { e.stopPropagation(); onSelect?.(node.id) }}
        onDoubleClick={(e) => { e.stopPropagation(); onStartEdit?.(node.id) }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e, node) }}
        onMouseEnter={() => { setHover(true); onHover?.(node.id) }}
        onMouseLeave={() => { setHover(false); onHover?.(null) }}
      >
        {isEditing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onCommitEdit?.(node.id, draft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onCommitEdit?.(node.id, draft) }
              if (e.key === 'Escape') { setDraft(node.text); onCommitEdit?.(node.id, node.text) }
              e.stopPropagation()
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-transparent outline-none px-3 text-[14px] leading-tight"
            style={{ color: 'var(--mf-ink)' }}
          />
        ) : (
          <div
            data-text
            className="px-3 text-[14px] leading-[18px] overflow-hidden"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              wordBreak: 'break-word',
              color: 'var(--mf-ink)',
              // 根节点稍粗，形成视觉层级
              fontSize: item.depth === 0 ? 15 : 14,
            }}
          >
            {node.text}
          </div>
        )}

        {/* 折叠按钮：有子节点才出现 */}
        {node.children.length > 0 && (
          <button
            className="absolute -right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full border text-[10px] leading-none flex items-center justify-center transition-opacity"
            style={{
              background: 'var(--mf-canvas)',
              borderColor: 'var(--mf-hairline)',
              color: 'var(--mf-muted)',
              opacity: hover || node.collapsed ? 1 : 0,
              pointerEvents: hover || node.collapsed ? 'auto' : 'none',
            }}
            title={node.collapsed ? `展开 ${node.children.length} 个子节点` : '折叠'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(node.id) }}
          >
            {node.collapsed ? node.children.length : '−'}
          </button>
        )}

        {/* 折角：自身折角 or 折叠后透传的浅色折角 */}
        {hasFold && (
          <FoldCorner
            fold={node.fold}
            nodeId={node.id}
            hovered={hover}
            zoom={zoom}
            onOpen={onOpenFold}
          />
        )}
        {!hasFold && hidden && (
          // 折叠遮挡了深层折角 → 透传一个浅色折角，提示「后面有东西」
          <FoldCorner
            fold={{ corner: true, openCount: 0 }}
            ghost
            nodeId={node.id}
            zoom={zoom}
            onOpen={(id) => onToggleCollapse?.(id)}
          />
        )}
      </div>

      {/*
        全文气泡必须 portal 到 body。
        节点渲染在画布的 transform 层里，而「transform 的祖先会成为
        position:fixed 后代的包含块」—— 如果留在原地，clamp 算出来的视口
        坐标会被当成相对画布的坐标，气泡直接飞到屏幕外。
      */}
      {tip && !isEditing && createPortal(
        <div
          ref={bubbleRef}
          className="fixed z-50 rounded-xl px-3 py-2 text-[13px] leading-relaxed shadow-card border pointer-events-none mf-fade"
          style={{
            left: tip.measuring ? 0 : tip.left,
            top: tip.measuring ? 0 : tip.top,
            // 量尺寸那一趟必须不可见，否则会在左上角闪一下
            visibility: tip.measuring ? 'hidden' : 'visible',
            maxWidth: 360,
            maxHeight: Math.max(120, window.innerHeight - 40),
            overflow: 'hidden',
            background: 'var(--mf-panel)',
            borderColor: 'var(--mf-hairline)',
            color: 'var(--mf-ink)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {node.text}
          {hidden && (
            <div className="mt-1 text-[11px]" style={{ color: 'var(--mf-muted)' }}>
              折叠中还有 {hiddenFold} 个折角
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  )
}