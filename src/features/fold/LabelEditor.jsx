import React, { useLayoutEffect, useRef } from 'react'
import { useCommitOnOutsidePointerDown, safeInsets } from '../../lib/hooks'

/* ==================================================================== */
/* 改字用的悬浮输入框                                                     */
/*   centered=false（双击改字）→ 贴着鼠标出现                             */
/*   centered=true （合并后）  → 盖在新节点正中间                          */
/* ==================================================================== */

const LABEL_EDITOR_W = 220
const LABEL_EDITOR_H = 34

/**
 * 改字框的落点计算。
 *
 * 抽成模块级函数是必须的：这个框现在有两个位置来源 ——
 *   1. 打开时按节点位置算一次（组件内渲染）
 *   2. 图被平移 / 缩放 / 自动适应时，跟着节点走（DOM 直写）
 * 两处如果各算一遍，迟早会出现「跟随时不夹取边缘」这种不一致，
 * 框会有一半跑到屏幕外。所以夹取规则只能有一份。
 *
 * 夹取走 safeInsets()：下限是「安全区 + 8px」而不是 8px。
 * 横屏侧边安全区 34px 时，贴左边缘的节点算出来 left=8 → 会压进刘海；
 * 桌面端安全区全是 0px，表示与结果逐像素不变。
 *
 * 【为什么这里没有直接用 clampToSafeViewport】
 * 两个分支原来的下边界不一样（居中版是「高 + 8」=42，贴鼠标版写死 44），
 * 公共函数的形状对不上；而 44 这个值是上一版特意留的，改掉就是桌面端 2px 位移。
 * 所以这里只把**下限**换成安全区，上下界表达式原样保留。
 */
export function labelEditorPlacement(x, y, centered) {
  const W = LABEL_EDITOR_W
  const s = safeInsets()
  const minLeft = s.l + 8
  const maxLeft = Math.max(minLeft, window.innerWidth - s.r - 8 - W)
  const rawLeft = centered ? x - W / 2 : x - 12
  const left = Math.min(Math.max(minLeft, rawLeft), maxLeft)

  const minTop = s.t + 8
  const maxTop = centered
    ? Math.max(minTop, window.innerHeight - s.b - 8 - LABEL_EDITOR_H)
    : Math.max(minTop, window.innerHeight - s.b - 44)
  const rawTop = centered ? y - LABEL_EDITOR_H / 2 : y + 8
  const top = Math.min(Math.max(minTop, rawTop), maxTop)

  return { left, top, W }
}

export default function FloatingLabelEditor({ x, y, value, onCommit, onCancel, composingRef, centered = false, posRef = null }) {
  const ref = useRef(null)
  const rootRef = useRef(null)
  const done = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()   // 默认全选，直接打字就替换
  }, [])

  const commit = (v) => {
    if (done.current) return
    done.current = true
    onCommit(v)
  }
  const cancel = () => {
    if (done.current) return
    done.current = true
    onCancel()
  }

  /*
   * 点到框外面 = 确认（和 Enter 同一个动作）。
   *
   * 只靠下面 input 的 onBlur 是不够的：右侧预览区用了
   * react-zoom-pan-pinch，它在 mousedown 上 preventDefault（防止拖画布时
   * 顺带选中文字），焦点因此**不会**离开输入框，blur 永远不触发 ——
   * 实测「双击改完字，点一下图里的空白，输入框还在那儿、字也没生效」。
   * 这里改在 document 捕获阶段按指针位置判断，绕开焦点这条路。
   *
   * 提交的是 input 的**实时值**而不是闭包里的 value：用户可能刚打完字。
   */
  useCommitOnOutsidePointerDown(true, rootRef, () => {
    if (ref.current) commit(ref.current.value)
  })

  const { left, top, W } = labelEditorPlacement(x, y, centered)

  return (
    <div
      ref={(el) => {
        rootRef.current = el
        // posRef 是外层「跟着图走」用的锚点，两个 ref 指向同一个元素
        if (posRef) posRef.current = el
      }}
      data-label-editor
      data-editor-kind={centered ? 'merge' : 'rename'}
      className="fixed z-[130] rounded-lg border shadow-pop"
      style={{ left, top, width: W, background: 'var(--mf-panel)', borderColor: 'var(--mf-accent)' }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={ref}
        data-label-input
        defaultValue={value}
        spellCheck={false}
        className="w-full rounded-lg bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none"
        style={{ color: 'var(--mf-ink)' }}
        // 中文输入法：组字期间置位，回车提交前必须检查
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            // 组字中按回车是「选词」，绝不能当成提交
            if (composingRef.current || e.nativeEvent?.isComposing) return
            e.preventDefault()
            commit(e.currentTarget.value)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
        onBlur={(e) => commit(e.target.value)}
      />
    </div>
  )
}
