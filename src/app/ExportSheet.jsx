import React, { useEffect } from 'react'
import { CloseIcon } from '../components/icons'
import { useMobileBack, BACK_PRIORITY } from '../lib/hooks'

/**
 * 导出格式面板
 * ==============
 * 用户原话：「加一个导入的格式 html 不止 markdown 可以扩展多一点 导入也是」。
 * 格式从 3 个扩到 6 个之后，再往工具栏上摆一排按钮就没法看了 —— 所以收进
 * 这一个面板：**一处列出全部出口，每行写清「导出来能干什么」**。
 *
 * 【两端同一份组件、两套排布】
 *   · 手机：从底部工具栏上方向上展开的面板（和「更多」面板同一套位置逻辑，
 *     底边跟着 --mf-bottom-gap 走，刘海屏手势条不会压住最后一行）；
 *   · 桌面：居中卡片。
 * 两边的 markup 是同一段，只换外层定位 —— 于是「手机上少一个格式」这种差异
 * 不可能悄悄出现。
 *
 * 【返回键 / Esc / 点外面三种关闭方式都要有】
 * 手机上返回键是主要出路（用户按不到右上角的 ✕ 时它就是唯一出路），
 * 桌面端靠 Esc 和点遮罩。三者都走同一份 onClose，不各写一套状态。
 */
export default function ExportSheet({ compact = false, formats = [], name = '', onPick, onClose }) {
  // 手机端：把返回键接到「关掉这一层」（优先级当作轻量浮层，和右键菜单同级）
  useMobileBack(!!compact, onClose, BACK_PRIORITY.MENU)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const rows = (
    <div className="p-1.5">
      {formats.map((f) => (
        <button
          key={f.key}
          type="button"
          data-export-format={f.key}
          onClick={() => onPick(f.key)}
          className="flex w-full items-center gap-3 rounded-xl px-3 text-left transition-colors"
          style={{ minHeight: compact ? 52 : 46, color: 'var(--mf-ink)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mf-faint)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          onTouchStart={(e) => { e.currentTarget.style.background = 'var(--mf-faint)' }}
          onTouchEnd={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          <span className="flex-1 min-w-0">
            <span className="block truncate text-[13.5px]">{f.label}</span>
            <span className="block truncate text-[11px] mt-0.5" style={{ color: 'var(--mf-muted)' }}>{f.hint}</span>
          </span>
          <span className="shrink-0 text-[11px]" style={{ color: 'var(--mf-muted)' }}>.{f.ext}</span>
        </button>
      ))}
    </div>
  )

  const header = (
    <div
      className="flex items-center gap-2 px-3 border-b shrink-0"
      style={{ height: 44, borderColor: 'var(--mf-hairline)' }}
    >
      <span className="text-[13px] font-medium shrink-0" style={{ color: 'var(--mf-ink)' }}>导出</span>
      <span className="truncate text-[11.5px] flex-1" style={{ color: 'var(--mf-muted)' }}>{name}</span>
      <button
        data-export-close
        type="button"
        onClick={onClose}
        aria-label="关闭导出面板"
        title="关闭"
        className="grid place-items-center rounded-xl border shrink-0"
        style={{ width: 44, height: 36, background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)', color: 'var(--mf-ink)' }}
      >
        <CloseIcon size={18} strokeWidth={1.6} />
      </button>
    </div>
  )

  const panelStyle = {
    background: 'var(--mf-panel)',
    borderColor: 'var(--mf-hairline)',
  }

  return (
    <>
      <div
        data-export-mask
        onClick={onClose}
        className="fixed inset-0 z-[69] mf-fade"
        style={{ background: 'rgba(0,0,0,.34)' }}
      />
      {compact ? (
        <div
          data-export-sheet
          className="fixed left-2 right-2 z-[70] rounded-2xl border shadow-pop overflow-hidden mf-fade"
          style={{ ...panelStyle, bottom: 'calc(var(--mf-bottom-gap) + 56px)', maxHeight: 'calc(100vh - 160px)' }}
        >
          {header}
          <div className="overflow-auto mf-scroll" style={{ maxHeight: 'calc(100vh - 210px)' }}>{rows}</div>
        </div>
      ) : (
        <div className="fixed inset-0 z-[70] grid place-items-center p-3 pointer-events-none">
          <div
            data-export-sheet
            className="w-[420px] max-w-[92vw] rounded-2xl border shadow-pop overflow-hidden mf-fade pointer-events-auto"
            style={panelStyle}
          >
            {header}
            {rows}
          </div>
        </div>
      )}
    </>
  )
}
