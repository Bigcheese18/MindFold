/**
 * 通用 DOM 小工具。
 */

/** 安全地捕获指针（无效 pointerId 会抛错，拖拽本身不依赖它） */
export function capturePointer(el, pointerId) {
  if (!el?.setPointerCapture || pointerId === undefined) return
  try { el.setPointerCapture(pointerId) } catch { /* ignore */ }
}
