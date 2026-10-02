import React from 'react'
import { PinIcon, CloseIcon, PlusIcon } from '../components/icons'

/**
 * 顶部多标签页（隐藏式）
 * ======================
 * 默认隐藏，鼠标移到屏幕最顶部边缘时滑出（类似浏览器的多标签）。
 *
 * 【手机端是完全另一套排布，不是同一套缩一缩】
 * 用户原话（第四轮）：「思维导图左侧和顶部好难受 手机端希望分开 像电脑端一样但是适配手机端」。
 * 改之前手机端的实情是：顶部这条标签栏**根本没入口** ——
 *   · `useEdgeSense` 在 compact 下把 tabsOpen 强制为 false，且不绑 mousemove
 *     （手机没有鼠标，边缘感应只会变成误触）；
 *   · 唯一的入口是左上角汉堡菜单打开的那个抽屉，而抽屉里上半截是标签栏、
 *     下半截是大纲树，「换文档」和「看大纲」两件事挤在一起，
 *     而且主题切换（只有这里才有）在手机上**根本点不到**。
 * 于是拆成两个独立入口：
 *   · 左侧汉堡（MenuIcon）→ **只有大纲树**的抽屉
 *   · 右上角那颗（LayersIcon + 当前文档名 + ▾）→ 本组件展开的顶部面板
 *
 * 【第五轮：面板本身被压成一行】
 * 用户原话：「手机版里面的思维导图顶部标签页有点太乱了 和电脑一样简到那一点就行」。
 * 第四轮那个面板有三行 —— ①「文档标签 · 共 N 个」标题行 + ✕、②44px 的标签行、
 * ③一整行带文字的主题按钮（纯白/护眼/夜间）。加起来约 150px，把画布顶端整片吃掉，
 * 而且三行里有两行是「说明」而不是「控件」。
 * 第五轮压成一行：标签（可横滑）· ＋ · 主题色块 · ✕，高度 52px。
 *
 * 【第八轮：主题色块搬去左侧栏头部，这一条只留文档相关的控件】
 * 用户原话：「改变主题的图案很大 能不能换到左侧栏里面 这样就有空间了」。
 * 主题不是「文档标签」这一族的东西，它只是**当初没别的地方放**才挂在这里；
 * 第八轮落点也定死了：「放到左侧栏里面的固定按钮左边就行 移动端也是」——
 * 桌面在 `features/outline/OutlineTree.jsx` 头部（图钉左边），
 * 手机在 `app/App.jsx` 那条抽屉头（✕ 左边），两处都用 `components/ThemeCubes.jsx`。
 * 于是这条面板/标签栏只剩：标签（可横滑）· ＋ · 图钉（桌面）/ ✕（手机）。
 * 让出来的宽度全部归标签 —— 桌面约 80px、手机约 128px。
 *
 * 【为什么主题色块在手机上不带文字（第四轮特意加过，现已随搬家一起走）】
 * 第四轮给它加文字是有道理的：那时主题切换**刚刚**被找回来，不写「纯白/护眼/夜间」
 * 用户不知道这三个 M 是什么。搬进侧栏头部后：桌面那三颗左边写着「主题」两个字；
 * 手机抽屉头为了在最窄的 320px 机型上也放得下，把「主题」两个字省掉，
 * 但每颗色块仍然把主题的颜色画出来了（白底黑字 / 米底棕字 / 深底白字），
 * 名字走 aria-label 与 title：读屏和鼠标悬停照样读得到「主题：护眼」。
 *
 * 【为什么标签行外面套一层 flex-1 min-w-0 的可滚动容器】
 * 不换行的 flex 行里，唯一「可以被压缩」的元素会被压到极限：中文随即逐字换行，
 * 一颗标签变成一根竖条（README 坑 116 就是这么来的）。所以可滚动的那块
 * 显式写 `min-w-0`，右边三个控件显式 `shrink-0` —— 谁缩谁不缩是写出来的，不是随缘的。
 */
export default function TopTabs({
  open, tabs, activeId, onSwitch, onClose, onNew, onPin, pinned,
  mobile = false, onDismiss,
}) {
  return (
    <div
      /*
       * mf-safe-top：手机端状态栏是悬浮在页面上的，不加这一条整行标签
       * 会被时间/电量盖住（实测安全区 47px 时 h-9 那一行完全在状态栏里）。
       * 只加 padding，面板背景仍然铺到 y=0，状态栏后面不会露出画布。
       */
      data-mobile-tabs-sheet={mobile ? '' : undefined}
      className={[
        'mf-slide-top mf-safe-top fixed top-0 left-0 right-0',
        mobile ? 'z-[62]' : 'z-[60]',
        open ? 'open' : '',
      ].join(' ')}
      style={{ background: 'var(--mf-panel)', borderBottom: '1px solid var(--mf-hairline)' }}
    >
      {mobile ? (
        /*
         * 一整行：标签（可横滑）· ＋ · 主题三色 · ✕。
         * 高度 52 = 44 的触摸热区 + 上下各 4px 内边距（44 是 WCAG 对触摸目标的建议值）。
         */
        <div className="flex items-center gap-1.5 px-2 py-1" style={{ minHeight: 52 }}>
          <div
            data-mobile-tabs-row
            className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto mf-scroll"
            style={{ height: 44 }}
          >
            {tabs.map((t) => {
              const active = t.id === activeId
              return (
                <div
                  key={t.id}
                  data-tab-id={t.id}
                  onClick={() => onSwitch(t.id)}
                  className="flex items-center gap-1.5 pl-3 pr-1 rounded-xl text-[12.5px] shrink-0 max-w-[52vw] transition-colors"
                  style={{
                    height: 44,
                    background: active ? 'var(--mf-faint)' : 'transparent',
                    color: active ? 'var(--mf-ink)' : 'var(--mf-muted)',
                    border: `1px solid ${active ? 'var(--mf-hairline)' : 'transparent'}`,
                  }}
                  title={t.path || t.name}
                >
                  <span className="truncate">{t.name}</span>
                  <button
                    data-mobile-tab-close={t.id}
                    onClick={(e) => { e.stopPropagation(); onClose(t.id) }}
                    className="grid place-items-center rounded-lg shrink-0"
                    style={{ width: 32, height: 32, color: 'var(--mf-muted)' }}
                    title="关闭标签页"
                    aria-label={`关闭 ${t.name}`}
                  >
                    <CloseIcon size={15} strokeWidth={1.6} />
                  </button>
                </div>
              )
            })}
            <button
              data-mobile-tabs-new
              type="button"
              onClick={onNew}
              className="grid place-items-center rounded-xl border shrink-0"
              style={{ width: 44, height: 44, background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)', color: 'var(--mf-muted)' }}
              title="新建文档"
              aria-label="新建文档"
            >
              <PlusIcon size={20} strokeWidth={1.6} />
            </button>
          </div>

          {/*
            主题切换**已经搬走**（第八轮：桌面在图钉左边、
            手机在抽屉头 ✕ 左边 —— 见 `features/outline/OutlineTree.jsx` 与 `app/App.jsx`）。
            用户原话：「改变主题的图案很大 能不能换到左侧栏里面 这样就有空间了」
            「放到左侧栏里面的固定按钮左边就行 移动端也是」。
            这条面板因此只剩：标签（可横滑）· ＋ · ✕ —— 右边让出来的 128px
            全部归标签，标签一多也不再先把主题色块挤到换行。
          */}
          <button
            data-mobile-tabs-close
            type="button"
            onClick={onDismiss}
            aria-label="收起文档标签"
            title="收起文档标签"
            className="grid place-items-center rounded-xl border shrink-0"
            style={{ width: 44, height: 40, background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)', color: 'var(--mf-ink)' }}
          >
            <CloseIcon size={18} strokeWidth={1.6} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1 px-3 h-9">
          {/* 顶部留一条 6px 的拖拽感知区，鼠标一进来就滑出 */}
          <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto mf-scroll">
            {tabs.map((t) => {
              const active = t.id === activeId
              return (
                <div
                  key={t.id}
                  data-tab-id={t.id}
                  onClick={() => onSwitch(t.id)}
                  className="group flex items-center gap-2 px-3 h-7 rounded-lg text-[12px] cursor-pointer shrink-0 max-w-[190px] transition-colors"
                  style={{
                    background: active ? 'var(--mf-faint)' : 'transparent',
                    color: active ? 'var(--mf-ink)' : 'var(--mf-muted)',
                    border: `1px solid ${active ? 'var(--mf-hairline)' : 'transparent'}`,
                  }}
                  title={t.path || t.name}
                >
                  <span className="truncate">{t.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); onClose(t.id) }}
                    className="w-4 h-4 rounded flex items-center justify-center text-[11px] opacity-0 group-hover:opacity-60 hover:!opacity-100 shrink-0"
                    title="关闭标签页"
                  >
                    ✕
                  </button>
                </div>
              )
            })}
            <button
              onClick={onNew}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[14px] shrink-0 transition-colors"
              style={{ color: 'var(--mf-muted)' }}
              title="新建文档"
            >
              +
            </button>
          </div>

          {/*
            主题切换已经搬到左侧栏、并进头部那一行（第六/七轮），这里只剩标签 + ＋ + 图钉 ——
            那三颗 24px 色块原来把标签的可用宽度吃掉约 80px。
          */}
          <button
            onClick={onPin}
            data-pin-tabs
            data-pinned={pinned ? 'true' : undefined}
            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors"
            style={{ color: pinned ? 'var(--mf-accent)' : 'var(--mf-muted)' }}
            title={pinned ? '取消常显' : '常显标签栏'}
            aria-label={pinned ? '取消常显标签栏' : '常显标签栏'}
          >
            {/* 实心 = 已钉住，空心 = 未钉住（替代原来的 📌 / 📍） */}
            <PinIcon size={14} filled={pinned} />
          </button>
        </div>
      )}
    </div>
  )
}
