import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { collectFolds, foldColor, FOLD_COLORS, FOLD_LABELS, foldLevel } from '../../lib/model'
import { renderMermaid, applyTheme } from '../../lib/mermaid'

/**
 * 卡片复习模式
 * ============
 * 隐藏主图，逐张显示带折角的文字卡片；点一下翻面看流程图。
 * 这是「认知折叠」最纯粹的形态：只复习你标记过的东西。
 */
export function CardReview({ doc, onExit, onOpenFold, theme }) {
  const folds = useMemo(() => collectFolds(doc.root), [doc])
  const [i, setI] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [svg, setSvg] = useState('')

  const total = folds.length
  // 夹紧索引：文档内容变化后 i 可能越界，cur 变成 undefined 会让整个卡片崩掉
  const safeI = total ? Math.min(i, total - 1) : 0
  const cur = folds[safeI]

  // 渲染当前卡片的流程图

  useEffect(() => {
    let alive = true
    setFlipped(false)
    setSvg('')
    if (!cur?.node?.fold?.mermaid) return
    applyTheme(theme)
    renderMermaid(cur.node.fold.mermaid).then((r) => {
      if (alive && r.ok) setSvg(r.svg)
    })
    return () => { alive = false }
  }, [cur?.node?.id, theme])

  const next = useCallback(() => setI((v) => Math.min(total - 1, v + 1)), [total])
  const prev = useCallback(() => setI((v) => Math.max(0, v - 1)), [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onExit()
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next() }
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'Enter') setFlipped((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev, onExit])

  if (!total) {
    return (
      <Overlay onExit={onExit}>
        <div className="text-center" style={{ color: 'var(--mf-muted)' }}>
          <div className="text-[15px] mb-1">还没有任何折角</div>
          <div className="text-[12px]">在节点上右键 → 「打上折角」，就会出现在这里</div>
        </div>
      </Overlay>
    )
  }

  const color = foldColor(cur.node.fold?.openCount ?? 0)

  return (
    <Overlay onExit={onExit}>
      <div className="w-full max-w-[560px] px-6">
        {/* 进度 */}
        <div className="flex items-center gap-3 mb-4 text-[11.5px]" style={{ color: 'var(--mf-muted)' }}>
          <span>{i + 1} / {total}</span>
          <div className="flex-1 h-[3px] rounded-full overflow-hidden" style={{ background: 'var(--mf-hairline)' }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${((i + 1) / total) * 100}%`, background: color }} />
          </div>
          <span>← → 切换 · 空格翻面 · Esc 退出</span>
        </div>

        {/* 卡片 */}
        <div className="mf-card-flip" style={{ height: 340 }}>
          <div
            className={`mf-card-inner w-full h-full ${flipped ? 'flipped' : ''}`}
            onClick={() => setFlipped((v) => !v)}
            style={{ cursor: 'pointer' }}
          >
            {/* 正面：文字 */}
            <div
              className="mf-card-face w-full h-full rounded-2xl border shadow-card flex flex-col items-center justify-center px-8 text-center"
              style={{ background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)' }}
            >
              <div className="absolute top-0 right-0 w-0 h-0" />
              <div
                className="absolute top-3 right-3 w-3 h-3"
                style={{ background: color, clipPath: 'polygon(100% 0, 100% 100%, 0 0)' }}
              />
              <div className="text-[19px] leading-relaxed font-medium" style={{ color: 'var(--mf-ink)', wordBreak: 'break-word' }}>
                {cur.node.text}
              </div>
              <div className="mt-5 text-[11.5px]" style={{ color: 'var(--mf-muted)' }}>
                {FOLD_LABELS[foldLevel(cur.node.fold?.openCount ?? 0)]} · 点击卡片翻面
              </div>
              {cur.node.fold?.corner && (
                <button
                  onClick={(e) => { e.stopPropagation(); onOpenFold(cur.node.id) }}
                  className="mt-3 text-[11.5px] underline underline-offset-2"
                  style={{ color: 'var(--mf-accent)' }}
                >
                  直接在编辑器中打开
                </button>
              )}
            </div>

            {/* 背面：流程图 */}
            <div
              className="mf-card-face mf-card-back rounded-2xl border shadow-card flex flex-col items-center justify-center overflow-hidden p-4"
              style={{ background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)' }}
            >
              {svg ? (
                <div
                  className="w-full h-full flex items-center justify-center overflow-auto mf-scroll"
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              ) : (
                <div className="text-center text-[12px]" style={{ color: 'var(--mf-muted)' }}>
                  {cur.node.fold?.corner ? '流程图加载中…' : '这是一个空心折角：还没有流程图'}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 切换 */}
        <div className="flex items-center justify-center gap-2 mt-5">
          <button
            onClick={prev}
            disabled={i === 0}
            className="px-4 py-1.5 rounded-lg border text-[12.5px] disabled:opacity-35"
            style={{ borderColor: 'var(--mf-hairline)', color: 'var(--mf-ink)' }}
          >
            上一个
          </button>
          <button
            onClick={next}
            disabled={i === total - 1}
            className="px-4 py-1.5 rounded-lg border text-[12.5px] disabled:opacity-35"
            style={{ borderColor: 'var(--mf-hairline)', color: 'var(--mf-ink)' }}
          >
            下一个
          </button>
        </div>
      </div>
    </Overlay>
  )
}

/**
 * 雷达复习模式提示条
 * 画布本身变暗的高亮逻辑在 Canvas 里（.mf-radar），这里只提供 HUD。
 */
export function RadarHud({ doc, onExit, onNext, compact = false }) {
  const folds = useMemo(() => collectFolds(doc.root), [doc])
  const counts = [0, 1, 2, 3].map((lv) => folds.filter((f) => foldLevel(f.node.fold?.openCount ?? 0) === lv).length)

  return (
    <div
      /*
       * 【这里原来写坏了】同一元素上写了**两个** style 属性 ——
       * JSX 里后面的整块会覆盖前面的，于是 `bottom: calc(24px + 安全区)`
       * 从来没生效过，只剩下面那一份（没有 bottom）。
       * 固定定位缺 top/bottom 时用的是「静态位置」，提示条会挂在
       * 布局流里那个位置 —— 手机上正好压在手势条 / 底部工具栏上。
       *
       * 合成一个 style 之后还要分两端：手机端底栏是**整行铺满**的
       * （left-3 right-3 + justify-between），底部居中的提示条必然压住它 ——
       * 实测 390×844（安全区下 34）：提示条 664..786，工具栏 758..798，
       * 重叠 28px，正好盖住「撤销/重做/雷达/更多」那几颗。
       * 所以手机端抬到「底栏高度(40) + 16 间隙」之上，和提示条(toast)同一套算法
       * （同一个 --mf-bottom-gap，两者一起动，不会再错开）。
       * 桌面端底栏是左下角一小段、提示条居中，本来就不重叠 ——
       * 保持原来的 24px，桌面视觉零变化。
       */
      className="fixed left-1/2 -translate-x-1/2 z-[65] flex items-center gap-4 px-4 py-2.5 rounded-2xl border shadow-pop mf-fade"
      style={{
        bottom: compact
          ? 'calc(var(--mf-bottom-gap) + 56px)'
          : 'calc(24px + var(--mf-safe-b))',
        maxWidth: 'calc(100vw - 24px)',
        background: 'var(--mf-panel)',
        borderColor: 'var(--mf-hairline)',
      }}
    >
      <span className="text-[12px] font-medium" style={{ color: 'var(--mf-ink)' }}>雷达复习</span>
      <div className="flex items-center gap-3 text-[11.5px]" style={{ color: 'var(--mf-muted)' }}>
        {FOLD_LABELS.map((label, lv) => (
          <span key={label} className="flex items-center gap-1">
            {/* 用每级的代表色：第 0 级灰，往后取该级的代表次数 */}
            <span className="w-2 h-2 rounded-full" style={{ background: FOLD_COLORS[lv] }} />
            {label} {counts[lv]}
          </span>
        ))}
      </div>
      <button
        onClick={onNext}
        className="px-3 py-1 rounded-lg border text-[12px]"
        style={{ borderColor: 'var(--mf-hairline)', color: 'var(--mf-ink)' }}
        title="跳到下一个折角 (N)"
      >
        下一个折角
      </button>
      <button onClick={onExit} className="text-[12px] px-2" style={{ color: 'var(--mf-muted)' }}>
        退出 (Esc)
      </button>
    </div>
  )
}

function Overlay({ children, onExit }) {
  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center mf-fade"
      style={{ background: 'var(--mf-canvas)' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        onClick={onExit}
        className="absolute right-5 text-[12px] px-3 py-1.5 rounded-lg border"
        /* 全屏复习层从 y=0 铺起，「退出复习」原来固定在 top-4，被状态栏盖住 */
        style={{ top: 'calc(16px + var(--mf-safe-t))', borderColor: 'var(--mf-hairline)', color: 'var(--mf-muted)' }}
      >
        退出复习
      </button>
      {children}
    </div>
  )
}