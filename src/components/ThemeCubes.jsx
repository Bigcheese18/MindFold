import React from 'react'

/**
 * 主题三色块（纯白 / 护眼 / 夜间）
 * ==============================
 * 【为什么单独抽成一个组件】
 * 这三颗色块原来只长在顶部标签栏（`app/TopTabs.jsx`）里，而且是**两套**写了两遍：
 * 桌面那一行写一次 24px、手机面板那一行再写一次 40px，连颜色数组都是复制的。
 * 第八轮它从顶部搬到左侧栏头部、紧挨「固定按钮」左边
 * （用户原话：「放到左侧栏里面的固定按钮左边就行 移动端也是」）——
 * 桌面是 `features/outline/OutlineTree.jsx` 头部（图钉左边，左边还写着「主题」），
 * 手机是 `app/App.jsx` 那条抽屉头（✕ 左边，为了最窄机型省掉「主题」二字）。
 * 谁复制第三遍谁就是下一个坑，所以颜色、尺寸、可达性属性都收到这里，
 * 调用方只传「当前主题 + 切换回调」。
 *
 * 【尺寸不是同一个档位：24 / 40】
 * · 桌面端 24px —— 鼠标点得准，和侧栏里其它行内控件（图钉 24、过滤器 chip）齐平；
 * · 手机端 40px —— 44 是 WCAG 对触摸目标的建议值，40 是抽屉头 48px 里塞得下的
 *   最大档（原来就是 40，本轮**没有**缩小，不能因为「搬家 / 并进头部」顺手改小）。
 *
 * 【为什么色块里写「M」而不是中文】
 * 每个色块本身就把主题的颜色画出来了（白底黑字 / 米底棕字 / 深底白字），
 * 中文标签一进去色块就得变宽高不一致。名字走 `title` + `aria-label`：
 * 鼠标悬停和读屏仍然读得到「主题：护眼」（手机端因为省掉「主题」二字，
 * 这条 aria-label 就是它唯一的名字，别再删）。
 */
export const THEME_OPTIONS = [
  ['white', '纯白', '#ffffff', '#1f2328'],
  ['sepia', '护眼', '#fdf9f0', '#4a3b2a'],
  ['dark', '夜间', '#111318', '#e5e7eb'],
]

/**
 * 渲染主题三色块。
 * @param props.theme - 当前主题 key（white | sepia | dark）。
 * @param props.onTheme - 点击某颗色块时回调，参数是该色块的 key。
 * @param props.embedded - 手机端抽屉里用（true）→ 40px 触摸档；桌面侧栏 → 24px。
 * @returns 三颗色块组成的行内组。
 */
export default function ThemeCubes({ theme, onTheme, embedded = false }) {
  const size = embedded ? 40 : 24
  return (
    <div className="flex items-center gap-1">
      {THEME_OPTIONS.map(([k, label, bg, fg]) => (
        <button
          key={k}
          data-theme-option={k}
          type="button"
          onClick={() => onTheme?.(k)}
          aria-pressed={theme === k}
          aria-label={`主题：${label}`}
          title={label}
          className="grid place-items-center rounded-md border text-[10px] font-medium shrink-0 transition-transform hover:scale-105"
          style={{
            width: size,
            height: size,
            background: bg,
            color: fg,
            borderColor: theme === k ? 'var(--mf-accent)' : 'var(--mf-hairline)',
            outline: theme === k ? '1.5px solid var(--mf-accent)' : 'none',
            outlineOffset: 1,
          }}
        >
          M
        </button>
      ))}
    </div>
  )
}
