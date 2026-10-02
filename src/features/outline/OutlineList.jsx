import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  textToRows, rowsToText, computeParents, visibleRows, groupTints,
  insertAfter, changeDepth, mergeWithPrev, deleteRow, toggleCollapsed, pasteRows,
} from '../../lib/outlineOps'

/**
 * 缩进列表编辑器（块状行编辑器）
 * ==============================
 * 不用 textarea：textarea 无法逐行做缩进参考线、折叠三角、行悬停联动。
 * 这里把每一行渲染成一个真实的 <input>，从而：
 *   · 天然支持中文输入法（IME）—— 自绘 caret 的方案做不到
 *   · 每行可以独立加参考线 / 折叠按钮 / 悬停高亮
 *
 * 内部状态是「行数组」而不是文本，这样按 Enter 产生的空行也能立刻渲染出来
 * （如果状态是文本，空行会被解析器丢掉，用户就没法接着打字了）。
 * 每次变更都序列化成规范的 `'  '.repeat(depth) + label` 回传给父组件。
 *
 * 行的增删改逻辑都在 lib/outlineOps.js 里（纯函数、可在 Node 里测）。
 */

const INDENT = 18        // 每一级缩进的像素宽度
const FOLD_W = 16        // 折叠三角占位宽度

export default function OutlineList({ value, onChange, onHoverNode, highlightIndex = null }) {
  const [rows, setRows] = useState(() => textToRows(value))
  const [collapsed, setCollapsed] = useState(() => new Set())   // 存行 key，编辑文本时不会错位
  const [focusReq, setFocusReq] = useState(null)                // { key, caret }
  const [hoverKey, setHoverKey] = useState(null)

  const inputRefs = useRef(new Map())
  const rowRefs = useRef(new Map())
  // 记录「自己最后吐出去的文本」，用来区分「外部改动」和「自己改的」
  const lastEmitted = useRef(value)

  /**
   * 外部改动（右侧流程图上的改字 / 新增 / 删除）要同步进编辑器。
   * 判据是「传入的 value 和我最后吐出去的不一样」—— 否则自己 onChange
   * 冒泡回来的那次会被当成外部改动，把光标和折叠状态冲掉。
   */
  useEffect(() => {
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    setRows(textToRows(value))
  }, [value])

  const { childCount } = useMemo(() => computeParents(rows), [rows])
  const visible = useMemo(() => visibleRows(rows, collapsed), [rows, collapsed])
  const tints = useMemo(() => groupTints(rows), [rows])
  // 多个 0 级行 = 图上会有多棵互不相连的树。这不是 bug（缩进列表就是这么写的），
  // 但用户容易误以为「多了个孤立节点」，所以显式提示一下。
  const rootCount = useMemo(() => rows.filter((r) => r.depth === 0).length, [rows])

  /* ---------- 变更入口：统一序列化回传 ---------- */
  const apply = useCallback((result, nextCollapsed) => {
    if (!result.changed) return
    setRows(result.rows)
    if (nextCollapsed) setCollapsed(nextCollapsed)
    const text = rowsToText(result.rows)
    lastEmitted.current = text
    onChange?.(text)
    if (result.focusKey) setFocusReq({ key: result.focusKey, caret: result.caret ?? 'end' })
  }, [onChange])

  /**
   * 右侧流程图点了某个节点 → 这里高亮对应行并滚动到可见位置。
   * 如果那一行被折叠在某个祖先里，先把祖先展开，否则用户看不到它。
   */
  useEffect(() => {
    if (highlightIndex == null || !rows[highlightIndex]) return
    const { parent } = computeParents(rows)
    const chain = []
    for (let p = parent[highlightIndex]; p != null && p >= 0; p = parent[p]) chain.push(rows[p].key)
    if (chain.length) {
      setCollapsed((prev) => {
        if (!chain.some((k) => prev.has(k))) return prev
        const next = new Set(prev)
        for (const k of chain) next.delete(k)
        return next
      })
    }
    const el = rowRefs.current.get(rows[highlightIndex].key)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [highlightIndex, rows])

  /* ---------- 焦点与光标 ---------- */
  useLayoutEffect(() => {
    if (!focusReq) return
    const el = inputRefs.current.get(focusReq.key)
    if (el) {
      el.focus()
      const pos = focusReq.caret === 'end' ? el.value.length : (focusReq.caret ?? el.value.length)
      try { el.setSelectionRange(pos, pos) } catch { /* 某些情况下不支持，忽略 */ }
    }
    setFocusReq(null)
  }, [focusReq])

  /* ---------- 行级操作 ---------- */
  const updateLabel = (i, label) => {
    const next = rows.slice()
    next[i] = { ...next[i], label }
    setRows(next)
    const text = rowsToText(next)
    lastEmitted.current = text
    onChange?.(text)
  }

  const onKeyDown = (i, e) => {
    const el = e.currentTarget
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length

    if (e.key === 'Enter') {
      e.preventDefault()
      apply(insertAfter(rows, i, rows[i].depth))
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      apply(changeDepth(rows, i, e.shiftKey ? -1 : +1))
      return
    }
    if (e.key === 'Backspace' && atStart) {
      e.preventDefault()
      if (rows[i].label === '') apply(deleteRow(rows, i))
      else apply(mergeWithPrev(rows, i))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveFocus(i, -1)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveFocus(i, 1)
      return
    }
    // 其余按键（含中文输入法）交给浏览器
    void atEnd
  }

  const moveFocus = (i, dir) => {
    const at = visible.findIndex((v) => v.index === i)
    const target = visible[at + dir]
    if (target) setFocusReq({ key: rows[target.index].key, caret: 'end' })
  }

  const handlePaste = (i, e) => {
    const text = e.clipboardData?.getData('text')
    const result = pasteRows(rows, i, text)
    if (result.changed) { e.preventDefault(); apply(result) }
  }

  /* ---------- 渲染 ---------- */
  return (
    <div
      className="absolute inset-0 overflow-auto mf-scroll py-2"
      onMouseLeave={() => { setHoverKey(null); onHoverNode?.(null) }}
    >
      {rows.length === 0 && (
        <div className="px-4 py-3 text-[12px]" style={{ color: 'var(--mf-muted)' }}>
          写第一行作为根节点，Tab 缩进生成子节点
        </div>
      )}

      {rootCount > 1 && (
        <div
          data-multi-root-hint
          className="mx-3 mb-2 rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed"
          style={{ background: 'var(--mf-faint)', color: 'var(--mf-muted)' }}
        >
          有 {rootCount} 行没有缩进，右侧会渲染成 {rootCount} 棵互不相连的树。
          想让它们连起来，就把后面的行 Tab 缩进一级。
        </div>
      )}

      {visible.map(({ index, depth, collapsed: isCollapsed, hasChildren }) => {
        const row = rows[index]
        const hovered = hoverKey === row.key
        const highlighted = highlightIndex === index
        return (
          <div
            key={row.key}
            ref={(el) => { if (el) rowRefs.current.set(row.key, el); else rowRefs.current.delete(row.key) }}
            data-outline-row={index}
            data-depth={depth}
            data-highlighted={highlighted ? 'true' : undefined}
            className="relative flex items-center"
            style={{
              height: 28,
              paddingLeft: depth * INDENT,
              // 优先级：右侧选中的高亮 > 鼠标悬停 > 同级分组底色
              background: highlighted
                ? 'var(--mf-hover)'
                : (hovered ? 'var(--mf-hover)' : (tints[index] === 0 ? 'var(--mf-band)' : 'transparent')),
              // 选中的行左侧加一条蓝色竖条，和右侧高亮呼应
              boxShadow: highlighted ? 'inset 3px 0 0 var(--mf-accent)' : 'none',
            }}
            onMouseEnter={() => { setHoverKey(row.key); onHoverNode?.('n' + index) }}
          >
            {/* 缩进参考线：每一级一条 1px 极浅虚线 */}
            {Array.from({ length: depth }).map((_, k) => (
              <span
                key={k}
                aria-hidden
                data-guide={k}
                className="pointer-events-none absolute top-0 bottom-0"
                style={{ left: k * INDENT + 8, width: 0, borderLeft: '1px dashed var(--mf-guide)' }}
              />
            ))}

            {/* 折叠三角（只有带子节点的行才有） */}
            <span className="flex shrink-0 items-center justify-center" style={{ width: FOLD_W }}>
              {hasChildren ? (
                <button
                  type="button"
                  data-fold-toggle={isCollapsed ? 'closed' : 'open'}
                  title={isCollapsed ? '展开子节点' : '折叠子节点'}
                  onClick={(e) => { e.stopPropagation(); setCollapsed(toggleCollapsed(collapsed, row.key)) }}
                  className="grid h-4 w-4 place-items-center rounded text-[9px] leading-none transition-colors"
                  style={{ color: 'var(--mf-muted)' }}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
              ) : null}
            </span>

            {/* 行内容 */}
            <input
              ref={(el) => { if (el) inputRefs.current.set(row.key, el); else inputRefs.current.delete(row.key) }}
              data-outline-input={index}
              value={row.label}
              spellCheck={false}
              onChange={(e) => updateLabel(index, e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); onKeyDown(index, e) }}
              onPaste={(e) => handlePaste(index, e)}
              onFocus={() => { setHoverKey(row.key); onHoverNode?.('n' + index) }}
              placeholder={index === 0 ? '根节点' : ''}
              className="min-w-0 flex-1 border-0 bg-transparent py-1 pr-3 text-[13px] leading-none outline-none"
              style={{
                color: 'var(--mf-ink)',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              }}
            />
          </div>
        )
      })}
    </div>
  )
}
