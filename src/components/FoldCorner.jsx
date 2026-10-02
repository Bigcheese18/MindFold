import React from 'react'
import { foldColor, foldLevel, FOLD_LABELS } from '../lib/model'

/**
 * 折角角标（Badge）
 * =================
 * 类似微信未读消息的小圆点 / 数字角标，绝对定位贴在节点右上角，
 * 悬浮在节点框线之上，不占用内部文字空间。
 *
 * 三种形态：
 *   · 有内容、未读过（openCount = 0）→ 8px 浅灰小圆点，不显示数字
 *   · 有内容、读过         → 16px 实色小圆圈 + 10px 白色数字
 *   · 空折角（没有流程图）→ 12px 空心小圆圈（描边），表示「已标记但未写内容」
 *
 * 颜色随打开次数分级：灰 → 蓝 → 橙 → 深红。
 *
 * 位置：角标自身的盒子落在 `-6px / -6px`（相对节点右上角），
 * 也就是刚好骑在角上；外层按钮是 24×24 的热区，以角标中心为中心。
 */

const HIT = 24       // 点击热区（屏幕像素）
const DOT = 8        // 未读：极小圆点
const BADGE_H = 16   // 有数字：圆圈直径（同时也是最小宽度）
const RING = 12      // 空折角：空心圆圈直径

export default function FoldCorner({
  fold,
  ghost = false,
  onOpen,
  nodeId,
  zoom = 1,
}) {
  if (!fold) return null

  const level = foldLevel(fold.openCount)
  const color = foldColor(fold.openCount)
  const count = fold.openCount || 0
  const isEmpty = !fold.corner          // 没有 mermaid 代码 = 空折角
  const showNumber = !isEmpty && count > 0

  /**
   * 角标是「屏幕尺寸」的概念：它是贴纸，不是图的一部分。
   * 画布缩放到 0.7 倍时，10px 的数字只剩 7px，直接糊掉 —— 所以按 zoom 反向补偿，
   * 让角标在屏幕上始终接近设计尺寸。系数夹在 [1, 1.8]：
   * 缩得特别小时不再继续放大，避免角标盖住整个节点。
   */
  const k = Math.min(1.8, Math.max(1, 1 / (zoom || 1)))

  // 用画布底色描一圈，角标就像「浮」在节点框线之上，而不是被线穿过
  const float = { boxShadow: '0 0 0 2px var(--mf-canvas)' }

  const label = isEmpty
    ? `空折角（尚未写流程图）· 已打开 ${count} 次`
    : `折角流程图 · ${FOLD_LABELS[level]} · 已打开 ${count} 次`

  return (
    <button
      type="button"
      data-fold-badge
      data-level={level}
      data-fold-kind={isEmpty ? 'ring' : showNumber ? 'num' : 'dot'}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        onOpen?.(nodeId, e)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      // 24×24 热区，绝对定位；-10px 的偏移让内部角标正好落在 -6px/-6px
      className="absolute -right-2.5 -top-2.5 z-10 grid cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0"
      style={{
        width: HIT,
        height: HIT,
        transform: `scale(${k})`,
        opacity: ghost ? 0.45 : 1,
      }}
    >
      {isEmpty ? (
        /* 空折角：空心小圆圈 —— 已标记但没写内容 */
        <span
          className="block rounded-full"
          style={{
            width: RING,
            height: RING,
            background: 'var(--mf-canvas)',
            border: `2px solid ${color}`,
            ...float,
          }}
        />
      ) : showNumber ? (
        /* 有数字：微信式数字角标，1 位是正圆，2 位自动拉成胶囊 */
        <span
          className="grid place-items-center rounded-full font-semibold leading-none tabular-nums text-white"
          style={{
            height: BADGE_H,
            minWidth: BADGE_H,
            padding: count > 9 ? '0 4px' : 0,
            fontSize: 10,
            background: color,
            ...float,
          }}
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : (
        /* 有内容但没读过：极小的浅灰圆点 */
        <span
          className="block rounded-full"
          style={{ width: DOT, height: DOT, background: color, ...float }}
        />
      )}
    </button>
  )
}

/**
 * 熟悉度指示点 —— 用于大纲树 / 卡片复习的角标（列表里的小圆点）
 */
export function FoldDot({ fold }) {
  if (!fold) return null
  const color = foldColor(fold.openCount)
  const level = foldLevel(fold.openCount)
  return (
    <span
      title={`折角 · 已打开 ${fold.openCount} 次`}
      style={{ background: color }}
      className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
      data-level={level}
    />
  )
}
