import React, { useEffect } from 'react'

/**
 * 确认弹窗 —— 用于「取消折角（会删掉流程图数据）」和「删除文档」这类不可逆操作。
 * 破坏性操作用红色主按钮，回车确认、Esc 取消。
 */
export default function Confirm({ title, body, danger, onOk, onCancel }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk() }
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onOk, onCancel])

  return (
    <div
      data-confirm
      className="fixed inset-0 z-[120] grid place-items-center mf-fade"
      /*
       * 居中对话框看起来「本来就不会碰到状态栏」，但横屏矮视口下对话框
       * 高度接近可视高度时就会顶到状态栏 / 手势条，点不到按钮。
       * 加一圈安全区内边距，桌面端两个变量都是 0px，视觉零变化。
       */
      style={{
        background: 'rgba(0,0,0,.3)',
        padding: 'calc(12px + var(--mf-safe-t)) 12px calc(12px + var(--mf-safe-b))',
      }}
      onClick={onCancel}
    >
      <div
        className="w-[380px] max-w-[92vw] rounded-2xl border shadow-pop p-5 mf-fade"
        style={{ background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[14px] font-medium mb-2" style={{ color: 'var(--mf-ink)' }}>{title}</h3>
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--mf-muted)' }}>{body}</p>

        <div className="flex justify-end gap-2 mt-5">
          <button
            data-confirm-cancel
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded-lg border text-[12.5px]"
            style={{ borderColor: 'var(--mf-hairline)', color: 'var(--mf-muted)' }}
          >
            取消
          </button>
          <button
            data-confirm-ok
            autoFocus
            onClick={onOk}
            className="px-3.5 py-1.5 rounded-lg text-[12.5px] text-white"
            style={{ background: danger ? '#ef4444' : 'var(--mf-accent)' }}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}