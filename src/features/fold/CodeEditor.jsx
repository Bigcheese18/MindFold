import React, { useEffect, useRef, useState } from 'react'

/* ==================================================================== */
/* 代码编辑器 —— 出错行标红波浪线 + 行尾小问号气泡 + 双向联动行高亮          */
/* ==================================================================== */
/*
 * 【行高亮为什么不能直接给「那一行」加背景】
 * textarea 里的行不是 DOM 元素，没有可以着色的节点。
 * 所以用一层绝对定位的高亮带铺在**文字下面**（textarea 背景透明，带子透出来），
 * 位置按 `PAD_Y + (行号-1) * LINE_H` 算 —— 和 textarea 的
 * `py-3`（12px）+ `leading-[22px]` 严格对齐。
 *
 * 【textarea 必须 wrap="off"】
 * 一旦软换行，一个逻辑行会占多个视觉行，后面的行全部错位，
 * 高亮带会整体漂移。关掉软换行后「逻辑行 == 视觉行」，
 * 上面那个公式才成立。超长行走 textarea 自己的横向滚动条。
 */
const LINE_H = 22
const PAD_Y = 12

export default function CodeEditor({
  value, onChange, errorLine, lines,
  hoverLine = null,      // 图 → 代码：悬停高亮行（150ms 防抖后）
  selectedLine = null,   // 图 → 代码：单击选中高亮行
  scrollReq = null,      // { line, seq } 一次性滚动请求
  onCaret,               // 代码 → 图：光标行变化（外面负责 200ms 防抖）
}) {
  const [tipOpen, setTipOpen] = useState(false)
  const bandRefs = useRef(new Map())

  /*
   * 单击图上的节点 → 把对应代码行滚到视野中间。
   * 滚的是高亮带元素（它是真实 DOM，位置就等于那一行的位置）。
   * 依赖 scrollReq 的**对象身份**：每次点击都换一个新对象，所以
   * 「重复点同一个节点」也会重新滚动；而普通重渲染不会触发。
   */
  useEffect(() => {
    if (!scrollReq) return
    const el = bandRefs.current.get(scrollReq.line)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [scrollReq])

  /**
   * 光标在第几行 —— 数光标前面有几个换行符。
   * 1-based，和左侧行号栏、以及 mermaid 的 error.line 口径一致。
   */
  const reportCaret = (e) => {
    const el = e.currentTarget
    const head = el.value.slice(0, el.selectionStart ?? 0)
    let line = 1
    for (let i = 0; i < head.length; i++) if (head.charCodeAt(i) === 10) line++
    onCaret?.(line)
  }

  /** 这一行的高亮状态：选中优先于悬停 */
  const stateOf = (n) => (n === selectedLine ? 'sel' : (n === hoverLine ? 'hover' : null))

  return (
    <div data-code-editor className="absolute inset-0 overflow-auto mf-scroll">
      {/* ---- 行高亮带：铺在文字下面（textarea 背景透明） ---- */}
      <div
        data-code-highlights
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0"
      >
        {lines.map((_, i) => {
          const n = i + 1
          const st = stateOf(n)
          return (
            <div
              key={n}
              ref={(el) => { if (el) bandRefs.current.set(n, el); else bandRefs.current.delete(n) }}
              data-code-line={n}
              data-line-state={st || undefined}
              className={[
                'mf-code-line absolute left-0 right-0',
                st === 'sel' ? 'mf-code-line-sel' : st === 'hover' ? 'mf-code-line-hover' : '',
              ].join(' ')}
              style={{ top: PAD_Y + i * LINE_H, height: LINE_H }}
            />
          )
        })}
      </div>

      <div className="relative z-[1] flex min-h-full">
        {/* 行号列 */}
        <div
          className="shrink-0 select-none text-right pr-2 pl-3 py-3 text-[12px] leading-[22px] tabular-nums border-r"
          style={{ color: 'var(--mf-muted)', borderColor: 'var(--mf-hairline)', background: 'var(--mf-faint)' }}
        >
          {lines.map((_, i) => {
            const n = i + 1
            const st = stateOf(n)
            const isErr = errorLine === n
            return (
              <div
                key={i}
                data-gutter-line={n}
                data-line-state={st || undefined}
                className={[isErr ? 'font-semibold' : '', st ? 'mf-code-gutter-hl' : ''].join(' ')}
                style={isErr ? { color: '#ef4444' } : undefined}
              >
                {n}
              </div>
            )
          })}
        </div>

        <textarea
          data-code-input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          // 关掉软换行：逻辑行必须和视觉行一一对应，否则高亮带会错位
          wrap="off"
          className="flex-1 resize-none bg-transparent outline-none px-3 py-3 text-[12.5px] leading-[22px]"
          style={{ color: 'var(--mf-ink)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', minHeight: '100%' }}
          onKeyDown={(e) => e.stopPropagation()}
          // 光标移动的四个入口，任意一个都能触发反向联动
          onSelect={reportCaret}
          onKeyUp={reportCaret}
          onClick={reportCaret}
          onFocus={reportCaret}
        />
      </div>

      {/* 错误行的可视化覆盖层（textarea 无法直接画波浪线，故用覆盖条示意） */}
      {errorLine > 0 && (
        <div
          className="absolute left-0 right-0 pointer-events-none mf-line-error z-[2]"
          style={{ top: PAD_Y + (errorLine - 1) * LINE_H, height: LINE_H }}
        />
      )}

      {/*
        行尾小问号气泡。
        `z-[2]` 不能省：上面那层代码内容带了 `z-[1]`（为了让高亮带压在文字下面），
        不抬高层级的话这个按钮会被拉伸到整块高度的 textarea 盖住，
        点击永远落在 textarea 上，按钮就成了摆设。
      */}
      <div className="absolute right-3 z-[2]" data-tip-bubble style={{ bottom: 'calc(12px + var(--mf-safe-b))' }}>
        <button
          data-tip-toggle
          onClick={() => setTipOpen((v) => !v)}
          className="w-6 h-6 rounded-full border text-[11px] flex items-center justify-center transition-colors"
          style={{ borderColor: 'var(--mf-hairline)', background: 'var(--mf-panel)', color: 'var(--mf-muted)' }}
          title="Mermaid 语法速查"
        >
          ?
        </button>
        {tipOpen && (
          <div
            className="absolute bottom-8 right-0 w-72 rounded-xl border shadow-card p-3 text-[11.5px] leading-relaxed mf-fade"
            style={{ background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)', color: 'var(--mf-ink)' }}
          >
            <div className="font-medium mb-1.5">Mermaid 语法速查</div>
            <ul className="space-y-1" style={{ color: 'var(--mf-muted)' }}>
              <li>· 首行：<code>flowchart TD</code>（TD/LR/BT/RL）</li>
              <li>· 节点：<code>A["显示文字"]</code></li>
              <li>· 连线：<code>A --&gt; B</code></li>
              <li>· 带标签：<code>A --&gt;|说明| B</code></li>
              <li>· 判定：<code>A&#123;条件?&#125;</code></li>
              <li>· 外形：<code>[方框] (圆角) &#123;菱形&#125; ([(圆柱)])</code></li>
              <li>· 文字含空格或标点，务必加双引号</li>
              <li>· 注释用 <code>%%</code> 开头</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
