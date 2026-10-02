import React from 'react'
import { UndoIcon, RedoIcon } from '../components/icons'

/* ------------------------------------------------------------------ */
/* 画布底栏的两个通用按钮                                                */
/* ------------------------------------------------------------------ */

export function FlatBtn({ children, onClick, title, active, big = false, ...rest }) {
  return (
    <button
      {...rest}
      onClick={onClick}
      title={title}
      className={[
        'border flex items-center justify-center transition-colors',
        /*
         * 桌面端 34×34（原来是 28×28）。
         * 需求「底下的工具放大一点」：28px 在 1080p / 2K 屏上确实偏小，
         * 图标和文字都挤在一起。34 是「明显变大但一排 11 颗仍然塞得下」的值 ——
         * 11×34 + 10×6 间距 + 两条分隔线 ≈ 440px，1366 宽屏还剩一半空白。
         * 再往上（36/40）在 1280 屏幕上就会和右下角那条信息贴住了。
         *
         * 手机上仍然是 40px：触摸热区另有一套标准（见下），两者不要互相看齐。
         */
        big ? 'w-10 h-10 rounded-xl text-[15px]' : 'w-[34px] h-[34px] rounded-lg text-[14px]',
      ].join(' ')}
      style={{
        background: active ? 'var(--mf-accent)' : 'var(--mf-panel)',
        color: active ? '#fff' : 'var(--mf-muted)',
        borderColor: active ? 'var(--mf-accent)' : 'var(--mf-hairline)',
      }}
    >
      {children}
    </button>
  )
}

/**
 * 画布工具栏上的撤销 / 重做按钮。
 *
 * 和 FlatBtn 同款外观（同尺寸、同边框、同底色），但：
 *   · 内容是 SVG 图标而不是字符 —— 撤销/重做没有公认的等宽字符，
 *     用 `↶`/`↷` 这类字符在不同字体下粗细、基线都不一样，一排按钮会歪。
 *   · 带 disabled 置灰（无历史时）。
 *   · `data-disabled` 便于测试和无障碍查询（disabled 属性本身读起来更绕）。
 */
export function HistoryBtn({ onClick, disabled, title, redo = false, big = false, ...rest }) {
  const Icon = redo ? RedoIcon : UndoIcon
  return (
    <button
      {...rest}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      data-disabled={disabled ? 'true' : undefined}
      className={[
        'border flex items-center justify-center transition-colors disabled:cursor-not-allowed',
        // 和 FlatBtn 同一个尺寸档位（桌面 34、手机 40），一排按钮才不会歪
        big ? 'w-10 h-10 rounded-xl' : 'w-[34px] h-[34px] rounded-lg',
      ].join(' ')}
      style={{
        background: 'var(--mf-panel)',
        color: 'var(--mf-muted)',
        borderColor: 'var(--mf-hairline)',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Icon size={big ? 19 : 17} />
    </button>
  )
}
