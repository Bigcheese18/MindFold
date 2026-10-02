import { useEffect, useRef, useCallback } from 'react'

/**
 * 防抖 —— 用于「停笔 1 秒后静默写入」的自动保存。
 * 返回的函数带 .flush()，关弹窗时可以立刻落盘，防止最后 1 秒的修改丢失。
 */
export function useDebouncedCallback(fn, delay = 1000) {
  const timer = useRef(null)
  const fnRef = useRef(fn)
  const pending = useRef(null)

  useEffect(() => { fnRef.current = fn }, [fn])

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (pending.current) {
      const args = pending.current
      pending.current = null
      fnRef.current(...args)
    }
  }, [])

  const debounced = useCallback((...args) => {
    pending.current = args
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      const a = pending.current
      pending.current = null
      if (a) fnRef.current(...a)
    }, delay)
  }, [delay])

  // 组件卸载时把未落盘的修改冲出去
  useEffect(() => () => flush(), [flush])

  debounced.flush = flush
  debounced.cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    pending.current = null
  }, [])

  return debounced
}

/**
 * 读四个系统安全区（状态栏 / 手势条 / 侧边刘海）的像素值。
 *
 * 【为什么读 CSS 变量而不是 env()】
 * `--mf-safe-t/-b/-l/-r` 在 index.css 的 `:root` 里**只定义一次**（值就是
 * env(...)）。JS 这边如果再写一遍 env()，就多出一份会分叉的定义 ——
 * 而且 env() 在 JS 里根本读不到。读变量则天然跟着那唯一一份走。
 *
 * 桌面端四个值都是 0px，所以「按安全区夹取」在桌面端退化成「按视口夹取」，
 * 和改之前逐像素一致。
 */
export function safeInsets() {
  // node 里跑纯函数测试时没有 document —— 当作桌面（全 0）处理
  if (typeof document === 'undefined') return { t: 0, b: 0, l: 0, r: 0 }
  const cs = getComputedStyle(document.documentElement)
  const n = (k) => parseFloat(cs.getPropertyValue(k)) || 0
  return { t: n('--mf-safe-t'), b: n('--mf-safe-b'), l: n('--mf-safe-l'), r: n('--mf-safe-r') }
}

/**
 * 把一个「宽 W 高 H 的浮层」夹进**可用视口**（视口减去系统安全区）。
 *
 * 【为什么要有这一份】
 * 菜单气泡这类浮层的夹取下限原来一律是 `margin`（8px）—— 那是相对**物理**
 * 视口边算的。真机上那圈边不属于可用区域：状态栏 47px（竖屏）、手势条 34px、
 * 横屏侧边刘海 34px。于是：
 *   · 竖屏刘海屏：长按菜单高 341px，被夹到 844-341-8=495，下缘 836 —— 越过
 *     可用底 810 共 **26px**，最后一项「删除节点」落进手势区（量到 798..831）。
 *   · 横屏：侧边安全区 34px 时任何贴着左边缘弹出的浮层都会被夹到 left=8，
 *     也就是**压进刘海 26px** —— 这个下限只要浮层从左边缘弹出就会命中。
 * 所以下限改成「安全区 + margin」，上限改成「视口 - 安全区 - margin」。
 *
 * 桌面端四个安全区都是 0px → 退化成原来的 `max(margin, min(x, 视口 - 尺寸 - margin))`，
 * 逐像素不变（有反向断言钉住）。
 */
export function clampToSafeViewport(left, top, W, H, margin = 8) {
  const s = safeInsets()
  const minLeft = s.l + margin
  const minTop = s.t + margin
  // 用 max 兜底：可用视口比浮层还小时，至少贴住「安全区 + margin」这一边
  const maxLeft = Math.max(minLeft, window.innerWidth - s.r - margin - W)
  const maxTop = Math.max(minTop, window.innerHeight - s.b - margin - H)
  return {
    left: Math.min(Math.max(minLeft, left), maxLeft),
    top: Math.min(Math.max(minTop, top), maxTop),
  }
}

/**
 * 气泡智能避让屏幕边缘。
 * 传入锚点矩形和气泡尺寸，返回 clamp 后的 { left, top, placement }。
 *
 * 两个轴最后都要**无条件**夹到视口内。只在「下方放不下」时才处理纵向是错的：
 * 画布可以平移，锚点节点完全可能被滚到视口上方（anchor.top 为负），
 * 这时上面两个分支都不会触发，气泡会直接渲染到屏幕外。
 */
export function clampToViewport(anchor, tip, margin = 8) {
  const vw = window.innerWidth
  const vh = window.innerHeight

  let placement = 'bottom'
  let top = anchor.bottom + 10

  // 下方放得下就放下面；放不下且上方有空间就翻到上面
  if (top + tip.height > vh - margin && anchor.top - tip.height - 10 >= margin) {
    top = anchor.top - tip.height - 10
    placement = 'top'
  }

  const maxTop = Math.max(margin, vh - tip.height - margin)
  top = Math.min(Math.max(margin, top), maxTop)

  let left = anchor.left + anchor.width / 2 - tip.width / 2
  const maxLeft = Math.max(margin, vw - tip.width - margin)
  left = Math.min(Math.max(margin, left), maxLeft)

  return { left, top, placement }
}

/**
 * 「点到编辑框外面 = 确认」。
 *
 * 【为什么不能只靠 onBlur】
 * 浏览器只在 mousedown 的**默认行为**真的发生了才移动焦点。任何在
 * mousedown 上 `preventDefault()` 的库都会把焦点留在原地，于是
 * `onBlur` 永远不触发 —— 用户点了旁边，输入框还在、内容也没提交。
 * 折角弹窗右侧预览就是这样：react-zoom-pan-pinch 的 onPanningStart
 * 为了不让拖画布顺带选中文字，对 mousedown 调了 preventDefault。
 *
 * 所以这里不依赖焦点，改成在 **document 捕获阶段**监听指针按下：
 *   · 捕获阶段比 blur 更早，也比库挂在根容器上的 React 合成事件更早；
 *   · 点在编辑框内部（`ref` 的子树里）直接放过，不影响选词、拖选、点按钮；
 *   · 回调每次渲染都刷新到 ref 里，不会拿到过期的闭包。
 *
 * `mousedown` 和 `touchstart` 都要听：触屏上合成 mousedown 之前
 * 焦点就已经可能被抢走。重复触发由调用方自己的 done 锁兜底。
 *
 * @param active 是否处于编辑态（false 时不挂监听）
 * @param ref    编辑框根元素；它的子树内部算「里面」
 * @param commit 点到外面时调用
 */
export function useCommitOnOutsidePointerDown(active, ref, commit) {
  const cb = useRef(commit)
  useEffect(() => { cb.current = commit }, [commit])

  useEffect(() => {
    if (!active) return undefined
    const onDown = (e) => {
      const el = ref.current
      // 拿不到根元素时宁可不提交，也不要误提交
      if (!el) return
      if (e.target && typeof e.target === 'object' && el.contains(e.target)) return
      cb.current?.()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
    }
  }, [active, ref])
}

/* ================================================================== */
/* 手机端物理返回键：拦截浮层                                          */
/* ================================================================== */

/** 浮层优先级：数字越大越先被返回键关掉 */
export const BACK_PRIORITY = {
  /** 右键菜单：最轻量，返回键第一下就该关它 */
  MENU: 3,
  /** 全屏折角弹窗 */
  MODAL: 2,
  /** 左侧抽屉 */
  DRAWER: 1,
}

/** 手机端断点。和 App / Canvas / FoldModal 三处保持一致 */
export const MOBILE_BREAKPOINT = 768

export const isMobileViewport = () =>
  typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT

/**
 * 是否跑在**原生壳**里（安卓 Capacitor / iOS WKWebView），而不是普通浏览器。
 *
 * 【为什么需要这个判断】
 * 原生壳里的 WebView 和浏览器不是一回事，有两件事它做不到，而界面必须知道：
 *
 *   1. **不能下载文件**。Capacitor 的安卓侧（8.5.2）从头到尾没有注册
 *      `DownloadListener`，`Bridge.launchIntent()` 里对 `data:` / `blob:`
 *      两个 scheme 明确 `return false`（交回 WebView 自己加载）—— 而 Chromium
 *      WebView 本身没有下载管理器。所以 `<a download>` + `URL.createObjectURL`
 *      这一套在手机上点了等于没点（既不报错也不落文件）。
 *   2. **没有打印接口**。`window.print()` 在安卓 WebView 里是空实现，
 *      而 `window.open()` 因为没开 `setSupportMultipleWindows` 直接返回 null。
 *
 * 判据用的是 Capacitor 自己注入的桥：安卓有 `window.androidBridge`，
 * iOS 有 `webkit.messageHandlers.bridge`（和 @capacitor/core 里
 * `getPlatformId()` 的判据一致，这样不会出现「它认为是原生、我们认为不是」）。
 * 普通浏览器两者都没有 —— 桌面浏览器、手机浏览器都不会被误判。
 */
export const isNativeShell = () => {
  if (typeof window === 'undefined') return false
  const cap = window.Capacitor
  if (cap && typeof cap.isNativePlatform === 'function') {
    try {
      if (cap.isNativePlatform() === true) return true
    } catch { /* 桥坏了就退回下面的判据 */ }
  }
  return !!(window.androidBridge || window.webkit?.messageHandlers?.bridge)
}

/**
 * 所有注册中的浮层（模块级单例）。
 *
 * 【为什么必须共享一份，而不是每个 Hook 自己监听 popstate】
 * 若三个浮层各挂一个 popstate 监听，用户按一次返回键，三个监听器**同时**收到事件，
 * 于是三个浮层一起关掉 —— 而需求要的是「按优先级一次只关一个」。
 * 把注册表收在一处，由唯一一个 popstate 监听器挑出优先级最高的那个关掉，
 * 才能做到「绝不一按全关」。
 */
const backLayers = new Map()   // id -> { priority, close }
let backSeq = 0
let backListenerBound = false
/** 我们自己压栈、且**还没被消费**的条数 */
let pushedDepth = 0
/** 由返回键关掉的那个浮层 id（它的清理阶段不能再 back 一次） */
let closedByPopId = null
/**
 * 「我们自己主动调了 history.back()」的待消费次数。
 *
 * 【为什么必须有它】
 * 用户点 UI 关闭按钮时，清理阶段要补一次 history.back() 把死记录抹掉。
 * 但 history.back() **本身会再触发一次 popstate** —— 如果不加区分，
 * 那次 popstate 会被当成「用户按了返回键」，顺手把**下一个**浮层也关掉。
 * 于是「关掉右键菜单」会连带把弹窗也关了，正是需求里说的「一按全关」的变体。
 * 所以自己触发的 back 先登记一笔，popstate 里优先消费它、直接返回。
 */
let expectingPop = 0

/**
 * 「等上一次自己 back() 的余波结算完再压栈」的那一层。
 *
 * 【为什么必须有它 —— 实测踩到的坑】
 * 手机端「更多」面板里的「导出…/历史版本/回收站」这些行，会在**同一次点击**里
 * 关掉面板再打开另一个浮层。于是同一个 commit 里发生两件事：
 *   · 旧浮层的清理 → `history.back()`（**异步**的，浏览器排队稍后才走）
 *   · 新浮层挂载   → `history.pushState()`（同步，当场生效）
 * 实测（探针打印每一步的 history.length / state，390×844）：
 *   起点            len=2  state=null      ← 应用自己的那条记录
 *   打开「更多」    len=3  state={mfLayer:1}
 *   打开导出面板    len=3  state=**null**  ← 当前记录被那次 back() 退到了应用自己那条
 * 也就是说新浮层的记录还留在**前向历史**里，而当前记录退了一格。接着用户按 Esc /
 * 点关闭关掉新浮层，它又会 back() 一次 —— 这一次直接退到 about:blank，
 * **整个应用被退走**（CDP 报 `Inspected target navigated or closed`）。
 *
 * 修法：有自己触发的 back() 还没结算时，先别压栈，等那条 popstate 来了再压
 * （此时前向历史正好被清掉，压上去的记录就是当前记录）。多等一个 popstate，
 * 换「绝不会把应用退走」。
 *
 * 【兜底定时器为什么不能省】
 * 万一那次 popstate 因任何原因没来，记录就永远压不上 —— 那时按返回键弹的是
 * 应用自己的记录，**直接退出应用**，比多一条死记录严重得多。
 */
let pendingPushId = null
let pendingPushTimer = null

function pushEntry(id) {
  pushedDepth++
  try { window.history.pushState({ mfLayer: id }, '') } catch { /* 隐私模式，忽略 */ }
}

function pushEntryWhenSettled(id) {
  if (expectingPop <= 0) { pushEntry(id); return }
  pendingPushId = id
  if (pendingPushTimer) clearTimeout(pendingPushTimer)
  pendingPushTimer = setTimeout(() => {
    if (pendingPushId === id) { pendingPushId = null; pendingPushTimer = null; pushEntry(id) }
  }, 260)
}

function cancelPendingPush(id) {
  if (pendingPushId !== id) return
  pendingPushId = null
  if (pendingPushTimer) { clearTimeout(pendingPushTimer); pendingPushTimer = null }
}

function bindBackListener() {
  if (backListenerBound || typeof window === 'undefined') return
  backListenerBound = true
  window.addEventListener('popstate', () => {
    // 这一条是我们自己 back() 出来的清理，不关任何浮层
    if (expectingPop > 0) {
      expectingPop--
      if (pendingPushId !== null) {
        const id = pendingPushId
        pendingPushId = null
        if (pendingPushTimer) { clearTimeout(pendingPushTimer); pendingPushTimer = null }
        pushEntry(id)
      }
      return
    }

    /*
     * 用户按了物理返回键。这里**不能再调 history.back()**（会多退一层，
     * 把用户真正想离开的页面也退掉）—— 只关优先级最高的那一个浮层。
     */
    if (pushedDepth > 0) pushedDepth--
    const top = pickTopLayer()
    if (top) {
      closedByPopId = top.id
      top.close()
    }
  })
}

/** 挑出优先级最高（同优先级取最后注册）的浮层 */
function pickTopLayer() {
  let best = null
  for (const [id, layer] of backLayers) {
    if (!best || layer.priority >= best.priority) best = { id, ...layer }
  }
  return best
}

/**
 * 关掉优先级最高的那个浮层。返回 true = 确实关掉了一个。
 *
 * 【为什么单独抽出来给安卓硬件返回键用】
 * 下面 useMobileBack 走的是浏览器的 `popstate`（history 真栈）。但**安卓
 * 应用里的返回键根本不产生 popstate** —— 证据在 Capacitor 8.5.2 的源码里：
 *
 *   · `com.getcapacitor.BridgeActivity extends AppCompatActivity`，
 *     全文**没有重写 onBackPressed**（也没有 handleBackButton / canGoBack
 *     之类的钩子，整个 @capacitor/android 只有 cordova 的 Mock 里出现过
 *     canGoBack 这个名字）；
 *   · 因此硬件返回键直接落到 AppCompatActivity 的默认实现 → `finish()`
 *     → 应用当场退出。**任何浮层开着也一样**，这就是「返回键是摆设」。
 *
 * 所以原生侧由 MainActivity 重写 onBackPressed，把这一下转交给本函数
 * （经 `window.__mfHardwareBack`），能不能吃掉由 UI 自己决定：
 * 关掉了浮层 → 吃掉；什么都没开 → 交回给系统退出应用。
 */
export function handleHardwareBack() {
  const top = pickTopLayer()
  if (!top) return false
  closedByPopId = top.id
  top.close()
  return true
}

/**
 * 浮层要不要参与返回键拦截。
 *
 * 手机浏览器：只有窄屏（≤768）才拦 —— 桌面浏览器上按返回键是「回上一页」，
 * 应用不该把它吃掉。
 *
 * 原生壳（安卓）里放宽到**不看宽度**：手机横屏时视口宽度可能是 852 / 915px，
 * 照旧是手机、照旧只有一个返回键，被宽度判据挡掉的话横屏下返回键又变摆设。
 * `isNativeShell()` 在普通浏览器里恒为 false，所以桌面浏览器不受影响。
 */
export const shouldHandleBack = () => isMobileViewport() || isNativeShell()

/**
 * 手机端返回键拦截。
 *
 * @param visible  浮层当前是否可见
 * @param onClose  关闭回调（返回键触发时调用）
 * @param priority BACK_PRIORITY.*
 *
 * 【三大防坑】
 *   1. **闭包过期**：onClose 存在 ref 里、每次渲染更新，
 *      注册表里拿到的永远是最新的那个回调
 *   2. **死循环**：`isClosing` 锁保证一次关闭流程只走一遍
 *   3. **一按全关**：所有浮层共享一个注册表 + 一个 popstate 监听，
 *      每次只关优先级最高的那一个
 *
 * 只有 `shouldHandleBack()` 为真时才压栈 —— 桌面浏览器按返回键
 * 不应该被这个应用吃掉；原生壳里则必须压栈，因为那时返回键是**硬件**返回键，
 * 不压栈的话安卓会直接退出应用（见 handleHardwareBack 的注释）。
 */
export function useMobileBack(visible, onClose, priority = BACK_PRIORITY.MODAL) {
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  const isClosing = useRef(false)

  useEffect(() => {
    if (!visible || !shouldHandleBack()) return undefined
    bindBackListener()

    const id = ++backSeq
    backLayers.set(id, {
      id,
      priority,
      close: () => {
        if (isClosing.current) return       // 防死循环
        isClosing.current = true
        try { closeRef.current?.() } finally {
          queueMicrotask(() => { isClosing.current = false })
        }
      },
    })

    pushEntryWhenSettled(id)

    return () => {
      backLayers.delete(id)

      /*
       * 卸载 = 浮层已经不可见了，要把刚才压入的那条历史记录清掉，
       * 否则用户点 UI 关闭按钮后历史里会留一条死记录，
       * 之后每按一次返回键都要先「吃掉」它 —— 表现为「返回键点了没反应」。
       */
      if (closedByPopId === id) {
        // 它正是被返回键关掉的，那条记录浏览器已经弹掉了，不能再 back
        closedByPopId = null
        cancelPendingPush(id)   // 记录都还没压上（在等余波），更不用 back
        return
      }
      if (pendingPushId === id) {
        /*
         * 还没压栈就被关掉了：没有任何记录要清，而且**必须撤销那次待压栈**，
         * 否则稍后它会凭空压出一条「没有任何浮层认领」的死记录。
         */
        cancelPendingPush(id)
        return
      }
      if (pushedDepth > 0) {
        pushedDepth--
        expectingPop++
        try { window.history.back() } catch { expectingPop-- }
      }
    }
  }, [visible, priority])
}