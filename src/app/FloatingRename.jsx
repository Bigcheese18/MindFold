import React, { useCallback, useRef, useState } from 'react'

/**
 * 汇聚节点的悬浮改名框（「指向同一结果」的 A 方案：立即改名）。
 *
 * 【为什么不复用节点自己的行内 input】
 * MindNode 的行内编辑要双击进入，而这里需求是「生成后**立刻**弹出、默认全选」。
 * 更重要的是节点渲染在画布的 transform 层里：它的 font-size 会跟着 zoom 一起
 * 缩放，zoom 很小时输入框会小到看不清、光标都定位不准。
 * 所以这个框画在画布**外面**（fixed 定位 + 屏幕坐标），字号恒为 14px。
 *
 * 定位：从 canvasApi 拿到节点在**画布坐标系**里的矩形，再用当前 view 变换
 * 换算到屏幕坐标。视口平移/缩放后组件会因为 view 变化而重算 ——
 * 所以用户改名的同时拖画布，框不会跟节点脱节。
 */
export default function FloatingRename({ target, canvasApi, view, onCommit, onCancel }) {
  const [draft, setDraft] = useState(target.text || '')
  // 是否正在输入法组字中（中文输入时 Enter 是「选字」不是「提交」）
  const composing = useRef(false)

  /*
   * 默认全选。
   *
   * 需求明确要求「默认全选新结果节点」，这样用户可以直接打字覆盖，
   * 不用先手动全选一遍。
   *
   * 【为什么用 callback ref 而不是 useEffect】
   * 这个组件**第一次渲染时可能返回 null**：新节点刚写进文档，
   * 而 canvasApi.current 里的 getById 还是上一帧闭包（它由 Canvas 的
   * 无依赖 effect 在渲染**之后**才更新），于是查不到布局节点。
   * 若用 useEffect([]) 去 focus，那次 effect 已经跑过了（此时 ref 还是 null），
   * 等真正渲染出 input 时 effect 不会再跑 —— 输入框永远拿不到焦点，
   * 用户打字全落空。
   * callback ref 在元素**真正挂载**时才被调用，天然覆盖这个先后顺序。
   */
  const focusRef = useCallback((el) => {
    if (!el) return
    requestAnimationFrame(() => { el.focus(); el.select() })
  }, [])

  // 节点在画布坐标系里的位置 → 屏幕坐标
  const item = canvasApi.current?.getById?.(target.id)
  if (!item) return null
  const zoom = view?.zoom ?? 1
  const screenX = (view?.x ?? 0) + (item.x + item.w / 2) * zoom
  const screenY = (view?.y ?? 0) + item.y * zoom

  return (
    <div
      data-floating-rename
      className="fixed z-[85] -translate-x-1/2 -translate-y-full mf-fade"
      style={{
        left: screenX,
        // 抬到节点上方 6px，避免和节点文字重叠
        top: screenY - 6,
        // 输入框不该跟着画布缩放 —— 见上面的注释
        minWidth: 160,
      }}
    >
      <input
        ref={focusRef}
        data-rename-input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onBlur={() => onCommit?.(draft)}
        onKeyDown={(e) => {
          // 组字期间的 Enter / Esc 属于输入法，不能当成提交 / 取消
          if (composing.current) { e.stopPropagation(); return }
          if (e.key === 'Enter') { e.preventDefault(); onCommit?.(draft); return }
          if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); return }
          // 不能让 Tab / Delete 之类的按键冒到全局快捷键去改树
          e.stopPropagation()
        }}
        className="w-full rounded-lg border px-2.5 py-1.5 text-[14px] outline-none shadow-pop"
        style={{
          background: 'var(--mf-panel)',
          borderColor: '#3b82f6',
          color: 'var(--mf-ink)',
          boxShadow: '0 0 0 3px rgba(59, 130, 246, .18)',
        }}
      />
      <div
        className="mt-1 text-center text-[10.5px]"
        style={{ color: 'var(--mf-muted)' }}
      >
        回车确认 · Esc 取消
      </div>
    </div>
  )
}
