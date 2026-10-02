import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clampToSafeViewport } from '../../lib/hooks'
import {
  ArrowUpIcon, ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon,
} from '../../components/icons'

/* ==================================================================== */
/* 右侧流程图节点的右键菜单                                                */
/* ==================================================================== */
/*
 * 【为什么用 Portal 挂到 document.body】
 * 画布外层有 `transform: scale(zoom)` 和 `overflow: hidden`。
 * transform 会给 fixed 后代造一个新的包含块 —— 菜单的「视口坐标」会被
 * 当成相对画布的坐标，直接飞走或被裁掉。挂到 body 上彻底脱离这一层。
 *
 * 【为什么子菜单是「点击展开」而不是 hover】
 * 之前用 onMouseEnter/onMouseLeave 触发，鼠标从父项移到子菜单必须穿过
 * 一条缝，穿过的一瞬间父项触发 mouseleave → 子菜单消失，根本点不到。
 * 改成点击展开后不存在这个时序问题。
 *
 * 【为什么子菜单要跟父菜单重叠 2px】
 * 即使改成点击展开，鼠标移动路径仍然可能擦过边界。
 * 让子菜单左边缘压住父菜单右边缘 2px，两者物理相连，
 * 指针永远落在其中之一上。
 *
 * 【为什么关闭判定要同时看 menuRef 和 subRef】
 * 子菜单是主菜单的**兄弟节点**（不是子节点），所以
 * `menuRef.contains(target)` 对子菜单里的点击是 false ——
 * 只看 menuRef 的话，点子菜单会被当成「点了外面」而先关掉菜单，
 * 导致 click 根本落不到按钮上。这是上一版最致命的 bug。
 */
const MENU_MARGIN = 8
const SUBMENU_OVERLAP = 2

/**
 * 触屏端的菜单行高度。
 *
 * 【为什么要有这个档位】
 * 折角弹窗里手机端原来底部有一条「指向 / 指向同一结果」操作栏，本轮按用户
 * 要求删掉了 —— 于是**长按节点菜单成了触屏唯一的入口**。而菜单行本来是按
 * 鼠标做的：`py-[7px]` + 12.5px 字 ≈ **33px 高**（实测），拇指点 33px 很吃力
 * （WCAG 触摸目标建议 44px）。既然入口只剩它一个，它就必须是可点的尺寸。
 * 44px + 13.5px 字号 + 稍宽的内边距。
 *
 * 桌面端（右侧面板外的右键菜单）走 `touch=false`，仍然是 `py-[7px]` /
 * 12.5px —— 那边有鼠标，行距收紧反而更好扫。
 */
const TOUCH_ROW = { minHeight: 44, paddingTop: 9, paddingBottom: 9 }

export default function NodeContextMenu({ x, y, onClose, onPick, showLink = false, showMove = false, moveState = null, swapHoriz = true, touch = false }) {
  const menuRef = useRef(null)
  const subRef = useRef(null)
  const moveItemRef = useRef(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [pos, setPos] = useState(null)       // 主菜单位置（夹到视口内后）
  const [subPos, setSubPos] = useState(null) // 子菜单位置

  /* ---- 跟着光标走的小快捷键气泡 ---- */
  /*
   * 需求：把子菜单底部那两行常驻的快捷键说明去掉，改成悬停「上移」/「下移」
   * 时在光标旁弹一个极小的气泡。
   *
   * 实现上刻意分成两半：
   *   · `tipText` 是 state —— 只在「出现 / 消失」时变一次，触发渲染
   *   · 位置走 ref + 直接写 style —— 鼠标移动时**不触发渲染**
   * 如果位置也放 state，鼠标在菜单上滑动会以每秒上百次的频率重渲染整个菜单，
   * 而这里要的只是挪一个 20px 的小方块。
   */
  const tipRef = useRef(null)
  const tipAnchor = useRef({ x: 0, y: 0 })
  const [tipText, setTipText] = useState(null)

  /** 把气泡摆到锚点右下；右边/下边放不下就翻到左侧/上方，并夹进**可用视口** */
  const placeTip = useCallback((el, x, y) => {
    if (!el) return
    const W = el.offsetWidth
    const H = el.offsetHeight
    const M = 8
    let left = x + 14
    let top = y + 14
    if (left + W > window.innerWidth - M) left = x - W - 14
    if (top + H > window.innerHeight - M) top = y - H - 14
    const p = clampToSafeViewport(left, top, W, H, M)
    el.style.left = `${p.left}px`
    el.style.top = `${p.top}px`
  }, [])

  // 气泡刚挂上去时量不到尺寸，所以定位放在 layout effect 里（首帧之前就摆好）
  useLayoutEffect(() => {
    if (!tipText) return
    placeTip(tipRef.current, tipAnchor.current.x, tipAnchor.current.y)
  }, [tipText, placeTip])

  /**
   * 只有「真的有鼠标」的设备才弹快捷键气泡。
   *
   * 手机上（`hover: none` + `pointer: coarse`）：
   *   · 根本没有键盘，`Alt + ←/↑` 是纯噪音；
   *   · 触屏没有 hover —— 点一下会合成出 mouseenter 却没有 mouseleave，
   *     气泡会「黏」在屏幕上不走。
   * 所以这里按指针能力判断，而不是按屏幕宽度猜设备。
   */
  const hasHoverPointer = () =>
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: hover)').matches

  const showTip = (text, e) => {
    if (!text || !hasHoverPointer()) return
    tipAnchor.current = { x: e.clientX, y: e.clientY }
    setTipText(text)
  }
  const moveTip = (e) => {
    if (!tipText) return
    tipAnchor.current = { x: e.clientX, y: e.clientY }
    placeTip(tipRef.current, e.clientX, e.clientY)
  }
  const hideTip = () => { if (tipText) setTipText(null) }

  /** 主菜单定位：用鼠标的 clientX/clientY，并夹进可用视口（见 clampToSafeViewport 注释） */
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const p = clampToSafeViewport(x, y, r.width, r.height, MENU_MARGIN)
    setPos({ left: p.left, top: p.top })
  }, [x, y])

  /**
   * 子菜单定位：
   *   · 左边缘 = 父菜单右边缘 - 2px（故意重叠，鼠标滑过去时永远在两者之上）
   *   · 顶部与「移动位置」这一项对齐（不是和整个菜单顶部对齐）
   *   · 右边放不下就向左翻转，翻转时同样保留重叠
   * 依赖 pos：主菜单夹到视口内之后要重算一次。
   */
  useLayoutEffect(() => {
    if (!moveOpen) { setSubPos(null); return }
    const menu = menuRef.current
    const item = moveItemRef.current
    const sub = subRef.current
    if (!menu || !item || !sub) return
    const mr = menu.getBoundingClientRect()
    const ir = item.getBoundingClientRect()
    const sr = sub.getBoundingClientRect()

    let left = mr.right - SUBMENU_OVERLAP
    if (left + sr.width > window.innerWidth - MENU_MARGIN) {
      left = mr.left - sr.width + SUBMENU_OVERLAP   // 向左翻转
    }
    const p = clampToSafeViewport(left, ir.top, sr.width, sr.height, MENU_MARGIN)
    setSubPos(p)
  }, [moveOpen, pos])

  /*
   * 全局 mousedown：只有点在菜单**外面**才关闭。
   * 子菜单要一起判（它是兄弟节点，不在 menuRef 里）。
   *
   * 【为什么刚打开的前 350ms 不响应外部关闭】
   * 手机端长按节点的流程是：
   *   pointerdown → （500ms 后）菜单打开 → 手指抬起 → pointerup
   *   → **Chrome 补发一套兼容鼠标事件：mousedown / mouseup / click**
   * 那记补发的 mousedown 的 target 是**被长按的那个节点**，当然不在菜单里，
   * 于是下面这条「点外面就关」会立刻把刚弹出的菜单关掉 ——
   * 实测（CDP 打事件时间戳）：菜单在 t=44438 打开，t=44713 被这记 mousedown 关闭，
   * 用户看到的是「长按一下，菜单闪一下就没了」。
   *
   * 350ms 是量出来的：mouseup/click 都紧跟在 mousedown 之后 1~2ms，
   * 而真人从「看到菜单」到「去点别处」最快也要 150ms 以上。
   * 桌面右键不受影响：mousedown(右键) 发生在 contextmenu **之前**，
   * 菜单那时还没挂载，这条守卫根本不会介入。
   */
  const OPEN_GRACE_MS = 350
  const openedAt = useRef(typeof performance !== 'undefined' ? performance.now() : Date.now())
  useEffect(() => {
    const onDown = (e) => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      if (now - openedAt.current < OPEN_GRACE_MS) return
      const inMenu = menuRef.current?.contains(e.target)
      const inSub = subRef.current?.contains(e.target)
      if (!inMenu && !inSub) onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [onClose])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const items = [
    /*
     * 连线两项：**两种编辑模式都出现**。
     *
     * 它们要往 Mermaid 源码里写东西，而缩进列表编译出来的就是 Mermaid 源码、
     * 缩进模式下的节点 id 恒为 `n<行号>`，一样是合法的 mermaid id ——
     * 所以「缩进模式表达不了多对一」这个早先的理由不成立，纯属人为限制。
     * 现在由调用方恒传 showLink，见 FoldModal.nodeMenuAction 的注释。
     *
     * 顺序是「单对单 → 多对一」：先给最常用的那条，再给更强的那个。
     * 「指向」在上方是需求明确要求的。
     */
    ...(showLink ? [['指向', 'direct'], ['指向同一结果', 'merge']] : []),
    ['新增同级节点', 'sibling'],
    ['新增子节点', 'child'],
    ['删除该节点', 'delete', true],
  ]

  /**
   * 移动项：`[图标, 文字, action, 是否可用, 快捷键提示]`
   *
   * 【命名必须和物理效果一致 —— 这是这个菜单唯一重要的事】
   * 「移动位置」底下其实是**两类完全不同**的操作，之前的命名把它们混在一起了：
   *
   *   ① 同级换位：只交换同层代码行的先后，**父子关系一个字都不动**。
   *      dagre 按「边被加入的顺序」决定同层左右次序，所以换行序就等于换位置。
   *      在 TD 布局里同层是水平排开的 → 这是**左右**方向的移动。
   *   ② 层级移动：真正改拓扑。提升一级 = 挂到祖父下、变成父节点的兄弟；
   *      下沉一级 = 挂到父节点下、和原来的子节点成为兄弟。
   *      这必然是**上下**方向的移动（TD 下）。
   *
   * 所以文案、图标、快捷键全部按「屏幕上到底往哪走」来定，
   * 而不是按「代码行往前还是往后」。LR 布局下同层是上下排开的，
   * 两个方向会对调 —— 由 `swapHoriz` 统一决定，见上面那段注释。
   *
   * 四个动作现在都有快捷键，所以四个都有气泡提示（之前只有两个有）。
   */
  const A_LEFT = swapHoriz ? ArrowLeftIcon : ArrowUpIcon
  const A_RIGHT = swapHoriz ? ArrowRightIcon : ArrowDownIcon
  const A_UP = swapHoriz ? ArrowUpIcon : ArrowLeftIcon
  const A_DOWN = swapHoriz ? ArrowDownIcon : ArrowRightIcon
  const K_SWAP_A = swapHoriz ? 'Alt + ←' : 'Alt + ↑'
  const K_SWAP_B = swapHoriz ? 'Alt + →' : 'Alt + ↓'
  const K_LVL_A = swapHoriz ? 'Alt + ↑' : 'Alt + ←'
  const K_LVL_B = swapHoriz ? 'Alt + ↓' : 'Alt + →'

  const moveItems = [
    // ① 同级换位：只换代码顺序
    [A_LEFT, swapHoriz ? '左移一位' : '上移一位', 'up', moveState ? moveState.canUp : true, K_SWAP_A],
    [A_RIGHT, swapHoriz ? '右移一位' : '下移一位', 'down', moveState ? moveState.canDown : true, K_SWAP_B],
    // ② 层级移动：真正改树的层级
    [A_UP, swapHoriz ? '上移一级' : '左移一级', 'promote', moveState ? moveState.canPromote : true, K_LVL_A],
    [A_DOWN, swapHoriz ? '下移一级' : '右移一级', 'demote', moveState ? moveState.canDemote : true, K_LVL_B],
  ]

  /** 底部那行极小字号说明：把两类操作的区别一次讲清（跟着方向变，不会指错） */
  const moveHint = swapHoriz
    ? '左右移动只换顺序，上下移动会改变层级'
    : '上下移动只换顺序，左右移动会改变层级'

  const rowStyle = (danger) => ({ color: danger ? '#ef4444' : 'var(--mf-ink)' })
  const hoverIn = (e) => { e.currentTarget.style.background = 'var(--mf-faint)' }
  const hoverOut = (e) => { e.currentTarget.style.background = 'transparent' }

  const menu = (
    <>
      <div
        ref={menuRef}
        data-node-menu
        /*
         * 宽度必须是**确定值**，不能只给 min-width。
         * 里面的按钮是 w-full（width:100%），而 position:fixed 的收缩包裹
         * 在解析百分比宽度子元素时会退化 —— 实测菜单被撑到 381px，
         * 白白占了半个屏幕还更容易触发向左翻转。
         */
        className="fixed z-[9999] w-[200px] rounded-xl border p-1 shadow-pop mf-fade"
        style={{
          left: pos?.left ?? x,
          top: pos?.top ?? y,
          background: 'var(--mf-panel)',
          borderColor: 'var(--mf-hairline)',
          visibility: pos ? 'visible' : 'hidden',
        }}
        // 阻止冒泡：Portal 里的 React 事件仍会沿 React 树往上冒，
        // 不拦住的话点菜单会顺带触发弹窗/画布上的处理逻辑
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
      >
        {items.map(([label, action, danger]) => (
          <button
            key={action}
            data-menu-item={action}
            onClick={() => onPick(action)}
            className={`w-full rounded-md px-3 text-left transition-colors ${touch ? 'text-[13.5px]' : 'py-[7px] text-[12.5px]'}`}
            style={{ ...rowStyle(danger), ...(touch ? TOUCH_ROW : null) }}
            onMouseEnter={hoverIn}
            onMouseLeave={hoverOut}
          >
            {label}
          </button>
        ))}

        {/* 「移动位置」：**只**用点击展开，没有任何 hover 触发逻辑 */}
        {showMove && (
          <div
            ref={moveItemRef}
            data-menu-item="move"
            data-submenu-open={moveOpen ? 'true' : undefined}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={moveOpen}
            tabIndex={0}
            className={`flex w-full cursor-pointer items-center rounded-md px-3 text-left transition-colors ${touch ? 'text-[13.5px]' : 'py-[7px] text-[12.5px]'}`}
            style={{ ...rowStyle(false), ...(touch ? TOUCH_ROW : null) }}
            onClick={(e) => { e.stopPropagation(); setMoveOpen((v) => !v) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMoveOpen((v) => !v) }
            }}
          >
            移动位置
            <span className="flex-1" />
            <span className="opacity-50">{moveOpen ? '▾' : '▸'}</span>
          </div>
        )}

        <div
          className="px-3 pt-1 pb-0.5 text-[10.5px] leading-relaxed"
          style={{ color: 'var(--mf-muted)' }}
        >
          {showMove ? '移动只改代码顺序，不会破坏自动布局'
            : showLink ? '「指向」连两个已有节点，「指向同一结果」会新建汇聚节点'
              : '删除时子节点会上移一级，不会丢内容'}
        </div>
      </div>

      {showMove && moveOpen && (
        <div
          ref={subRef}
          data-move-submenu
          role="menu"
          /*
           * 极简排版三件事：
           *   · `flex-col gap-1` —— 用间隙拉开选项，而不是把每项的内边距撑大
           *     （内边距撑大会让鼠标热区互相贴住，视觉上仍然是一坨）
           *   · 图标固定 16px 宽并和文字左对齐，四行文字因此排成一条竖线
           *   · 高度只在「出现/消失」时变，不会因为 hover 抖动
           */
          className="fixed z-[9999] flex w-[200px] flex-col gap-1 rounded-xl border p-1.5 shadow-pop"
          style={{
            left: subPos?.left ?? -9999,
            top: subPos?.top ?? -9999,
            background: 'var(--mf-panel)',
            borderColor: 'var(--mf-hairline)',
            visibility: subPos ? 'visible' : 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseLeave={hideTip}
        >
          {moveItems.map(([Icon, label, action, enabled, shortcut]) => (
            <button
              key={action}
              data-move-item={action}
              data-shortcut={shortcut || undefined}
              data-disabled={enabled ? undefined : 'true'}
              disabled={!enabled}
              title={enabled ? undefined : '已经到边界了'}
              onClick={() => { if (enabled) onPick(action) }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[12.5px] transition-colors disabled:cursor-not-allowed"
              style={enabled ? rowStyle(false) : { color: 'var(--mf-muted)', opacity: 0.45 }}
              onMouseEnter={(e) => {
                if (enabled) {
                  hoverIn(e)
                  showTip(shortcut, e)
                }
              }}
              onMouseMove={moveTip}
              onMouseLeave={(e) => { hoverOut(e); hideTip() }}
            >
              <span className="shrink-0 opacity-70" data-move-icon>
                <Icon size={14} />
              </span>
              <span className="flex-1">{label}</span>
            </button>
          ))}

          {/*
            底部一行极小字号说明：这两类操作的区别必须一眼可见，
            否则「左移一位」和「上移一级」在用户眼里就是四个方向箭头，
            点错了才发现层级被改了 —— 那是不可逆的困惑。
            文案跟着 swapHoriz 变，不会在 LR 布局下指错方向。
          */}
          <div
            data-move-hint
            className="px-2.5 pb-0.5 pt-1 text-[10px] leading-snug"
            style={{ color: 'var(--mf-muted)' }}
          >
            {moveHint}
          </div>
        </div>
      )}

      {/*
        跟着光标的快捷键小气泡。
        `pointer-events-none` 是必须的：气泡就贴在指针旁边，若能接收事件，
        它会立刻把 mouseleave 从按钮上抢走，形成「显示→消失→显示」的闪烁。
      */}
      {tipText && (
        <div
          ref={tipRef}
          data-move-tip
          role="tooltip"
          className="pointer-events-none fixed z-[10000] rounded-md border px-1.5 py-0.5 text-[10.5px] leading-tight whitespace-nowrap"
          style={{
            left: -9999,
            top: -9999,
            background: 'var(--mf-panel)',
            borderColor: 'var(--mf-hairline)',
            color: 'var(--mf-muted)',
            boxShadow: '0 2px 8px -2px rgba(0,0,0,.18)',
          }}
        >
          {tipText}
        </div>
      )}
    </>
  )

  return createPortal(menu, document.body)
}
