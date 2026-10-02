import React from 'react'
import { UndoIcon, RedoIcon } from '../../components/icons'

/* ==================================================================== */
/* 分段切换控件（预览/编辑、缩进列表/代码 共用同一份实现）                  */
/* ==================================================================== */

/**
 * 「N 选一」的分段控件。
 *
 * 【为什么必须抽成组件，而不是写两遍（这是本轮踩的坑）】
 * 原先「预览 / 编辑」和「缩进列表 / Mermaid 代码」是两段各写一遍的 JSX，
 * 两段都**忘了写 `shrink-0` + `whitespace-nowrap`**。在 390px 的手机上，
 * 顶栏是一个不换行的 flex 行，超出宽度时唯一没有 `shrink-0` 的弹性项
 * 就会被压窄：
 *
 *   · 「预览 / 编辑」被压到 76px（各 38px）→ 两个字各占一行，
 *     变成一个 48px 高的「竖排」按钮（用户原话：「按钮竟然是竖着的」）
 *   · 「缩进列表 / Mermaid 代码」被压到 116px → 每个选项折成 3 行，
 *     整块撑到 84px 高，顶栏才 48px → 文字溢出栏外
 *   · 顶栏 scrollWidth 479 > clientWidth 390 → ↺（x=412）和 ✕（x=451）
 *     被顶到屏幕外，**手机上根本点不到关闭按钮**
 *
 * 抽成一份之后，「不许收缩、不许换行」这两条只存在一个地方，
 * 将来谁再加一个分段控件都不可能再漏。测试里另有一条**结构断言**
 * 钉住这两个类名（见 scripts/browser/mobilefold.mjs）。
 *
 * compact 档位是手机端专用的字号/内边距（11.5px / px-2.5），
 * 桌面端传 false 时字号内边距与改前逐字节一致。
 */
export function SegTabs({ tabAttr, containerAttrs = {}, value, options, onPick, compact = false }) {
  return (
    <div
      {...containerAttrs}
      className={`flex items-center rounded-lg p-0.5 shrink-0 ${compact ? 'text-[11.5px]' : 'text-[12px]'}`}
      style={{ background: 'var(--mf-faint)' }}
    >
      {options.map(([k, label]) => (
        <button
          key={k}
          {...{ [tabAttr]: k }}
          onClick={() => onPick(k)}
          className={`rounded-md transition-colors whitespace-nowrap shrink-0 ${compact ? 'px-2.5 py-1' : 'px-3 py-1'}`}
          style={{
            background: value === k ? 'var(--mf-panel)' : 'transparent',
            color: value === k ? 'var(--mf-ink)' : 'var(--mf-muted)',
            boxShadow: value === k ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/* ==================================================================== */
/* 撤销 / 重做 按钮                                                       */
/* ==================================================================== */
/*
 * 图标来自 `../../components/icons`（内联 Lucide 几何，没有引入 lucide-react）——
 * 和左下角画布工具栏用的是**同一份**定义。同语义的图标在应用里
 * 只能有一份几何，否则改一处漏一处。
 */

/* ==================================================================== */
/* 右下角缩放面板的按钮                                                   */
/* ==================================================================== */

/**
 * 预览区右下角的一颗缩放按钮。
 *
 * 三个硬性要求（需求三·2）：
 *   · 热区 **44×44**（用内联宽高写死，不靠 padding 凑 —— 44 是 WCAG 的
 *     触摸目标建议值，用 w-11 h-11 也行，但写死数字在测试里更好断言）
 *   · 按下有微小反馈 `active:scale-95`
 *   · 不能穿透点击到底层画布 —— 面板是 TransformWrapper 的**兄弟节点**，
 *     不在它的 DOM 子树里，库的平移监听自然收不到这里的事件
 */
export function ZoomBtn({ tool, title, onClick, children }) {
  return (
    <button
      type="button"
      data-zoom-btn={tool}
      title={title}
      aria-label={title}
      onClick={onClick}
      className="grid place-items-center rounded-xl border transition-transform active:scale-95"
      style={{
        width: 44,
        height: 44,
        background: 'var(--mf-panel)',
        borderColor: 'var(--mf-hairline)',
        color: 'var(--mf-ink)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

/* ==================================================================== */
/**
 * 撤销 / 重做按钮。
 * 三处（桌面左工具栏、桌面右悬浮、手机底部操作条）共用同一个组件、
 * 同一个 handler、同一份历史栈。
 * 颜色全部走 CSS 变量，白 / 米黄 / 深灰三种主题自动适配。
 *
 * 【为什么有 `big` 且它是 44×44】
 * 手机端底部操作条把「撤销 / 重做 / 回到中点」并排放进同一个圆角盒子里，
 * 而 ZoomBtn 热区是 44×44（WCAG 触摸目标建议值）。撤销按钮若沿用桌面的
 * 36px 圆形，同一行里就会一大一小、按下还会互相错位。
 * `big` 是**手机端专用档位**：44×44、圆角方形（不是圆形）、不投自己的阴影
 * （阴影归外层盒子）。桌面端两个档位一字未改。
 */
export function UndoButton({ disabled, onClick, floating = false, redo = false, big = false }) {
  const label = redo ? '重做 (Ctrl+Shift+Z)' : '撤销 (Ctrl+Z)'
  const Icon = redo ? RedoIcon : UndoIcon
  return (
    <button
      type="button"
      data-undo-button={big ? 'bottom' : floating ? 'floating' : 'toolbar'}
      data-undo-kind={redo ? 'redo' : 'undo'}
      data-disabled={disabled ? 'true' : undefined}
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={[
        'grid place-items-center transition-colors shrink-0',
        big ? 'h-11 w-11 rounded-xl border' : floating ? 'h-9 w-9 rounded-full border shadow-pop' : 'h-6 w-6 rounded-md border',
      ].join(' ')}
      style={{
        color: disabled ? 'var(--mf-muted)' : 'var(--mf-ink)',
        background: floating || big ? 'var(--mf-panel)' : 'transparent',
        borderColor: 'var(--mf-hairline)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <Icon size={big ? 18 : floating ? 16 : 14} />
    </button>
  )
}
