import React from 'react'

/**
 * 内联图标集（几何取自 Lucide，24×24 / stroke 2 / 圆角端点）
 * ==========================================================
 * 【为什么内联而不是装 lucide-react】
 * 项目定位是「纯本地、离线可用、要打包成 Tauri」，运行时依赖只有
 * mermaid + react。为了几个图标拉进一个上千组件的包不划算 ——
 * 打包体积、依赖面、离线可审计性都不划算。这里只把用到的几个 path 抄下来。
 *
 * 【一处定义，两处使用】
 * 撤销/重做图标同时用在「左下角画布工具栏」和「折角弹窗工具栏」，
 * 之前弹窗里是内联的私有副本。现在统一收到这里：
 * 同一个语义的图标在整个应用里只能有一份几何，否则改一处漏一处。
 *
 * 全部 `aria-hidden` + `focusable="false"`：图标是装饰，
 * 无障碍名称由外层按钮的 `title` / `aria-label` 提供。
 */

/** 统一的外层 svg 属性，避免每个图标重复一遍 */
function Icon({ size = 14, children, strokeWidth = 2, fill = 'none' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/**
 * Lucide `undo` —— 掉头往回走的箭头。
 * 注意和 `undo-2` 的区别：那个是直尾巴，这个是圆尾巴。
 * 需求点名要 `Undo` / `Redo`，所以用这一版。
 */
export function UndoIcon({ size = 14 }) {
  return (
    <Icon size={size}>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9a9 9 0 0 0-6 2.3L3 13" />
    </Icon>
  )
}

/** Lucide `redo` —— UndoIcon 的镜像 */
export function RedoIcon({ size = 14 }) {
  return (
    <Icon size={size}>
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 9-9a9 9 0 0 1 6 2.3L21 13" />
    </Icon>
  )
}

/** Lucide `arrow-up` —— 层级上移（真正改变树的垂直层级） */
export function ArrowUpIcon({ size = 14 }) {
  return (
    <Icon size={size}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </Icon>
  )
}

/** Lucide `arrow-down` —— 层级下移 */
export function ArrowDownIcon({ size = 14 }) {
  return (
    <Icon size={size}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </Icon>
  )
}

/** Lucide `arrow-left` —— 同级换位（只换代码顺序，不改父子关系） */
export function ArrowLeftIcon({ size = 14 }) {
  return (
    <Icon size={size}>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </Icon>
  )
}

/** Lucide `arrow-right` —— 同级换位 */
export function ArrowRightIcon({ size = 14 }) {
  return (
    <Icon size={size}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Icon>
  )
}

/**
 * Lucide `git-merge` —— 两条分支汇入一个点。
 *
 * 语义上是「多对一汇聚」的图形原型：两条线从上方下来，合到一个节点。
 * 需求点名了 git-merge / combine，这里取 git-merge —— 它画出来的
 * 正是「两条来源 → 同一个结果」，和「指向同一结果」一字不差。
 */
export function GitMergeIcon({ size = 14 }) {
  return (
    <Icon size={size}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </Icon>
  )
}

/** Lucide `git-branch` —— 一条线分叉成两条（「指向」的目标选择态用） */
export function GitBranchIcon({ size = 14 }) {
  return (
    <Icon size={size}>
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Icon>
  )
}

/**
 * Lucide `link` —— 一截链条。
 *
 * 「指向」是**单对单连线**：给两个已经存在的节点之间接上一根线。
 * 链条正好表达「把两个东西连起来」，和 `git-merge`（两条汇成一条）
 * 是同一族但语义清晰可分的两个图形 —— 两者在菜单和移动端底栏里并排出现，
 * 必须一眼能分开。
 */
export function LinkIcon({ size = 14 }) {
  return (
    <Icon size={size}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Icon>
  )
}

/* ------------------------------------------------------------------ */
/* 右侧预览区：缩放 / 平移控制条                                         */
/* ------------------------------------------------------------------ */
/*
 * 三个图标都取自 Lucide，几何一模一样。`zoom-in` / `zoom-out` 是同一个
 * 放大镜，区别只在镜内多不多一根竖线 —— 并排放的时候只能靠这一点区分，
 * 所以两个一起定义、一起用，不允许只改其中一个。
 */

/** Lucide `zoom-in` —— 放大镜 + 镜内的加号 */
export function ZoomInIcon({ size = 18 }) {
  return (
    <Icon size={size} strokeWidth={1.8}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" x2="16.65" y1="21" y2="16.65" />
      <line x1="11" x2="11" y1="8" y2="14" />
      <line x1="8" x2="14" y1="11" y2="11" />
    </Icon>
  )
}

/** Lucide `zoom-out` —— 同一个放大镜，镜内只有一根横线 */
export function ZoomOutIcon({ size = 18 }) {
  return (
    <Icon size={size} strokeWidth={1.8}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" x2="16.65" y1="21" y2="16.65" />
      <line x1="8" x2="14" y1="11" y2="11" />
    </Icon>
  )
}

/**
 * Lucide `maximize` —— 四个向外的拐角。
 *
 * 「适应屏幕」用的是它，而不是放大镜类图标：这个动作**不改缩放级别本身**，
 * 而是把整张图重新装进视口。四角外扩正好表达「撑满可视区域」，
 * 和放大 / 缩小在图形上完全不冲突。
 */
export function FitScreenIcon({ size = 18 }) {
  return (
    <Icon size={size} strokeWidth={1.8}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </Icon>
  )
}

/* ------------------------------------------------------------------ */
/* 手机端 UI 用图标（替代 Emoji）                                        */
/* ------------------------------------------------------------------ */
/*
 * 【为什么手机端要专门把 Emoji 换掉】
 * Emoji 在不同 Android 厂商 ROM 里的字形差别极大（三星、小米、华为各一套），
 * 同一个 🗑 在一台机器上是灰色垃圾桶、另一台是彩色带盖的，
 * 和「极简、克制」的整体视觉完全冲突；而且 Emoji 是彩色位图，
 * 没法跟随 `currentColor` 变主题（深色主题下尤其突兀）。
 * SVG 图标统一 stroke="currentColor"，三种主题自动适配。
 *
 * 默认 size 给 24、strokeWidth 1.5 —— 这是手机端工具栏的统一规格
 * （需求里点名的就是这两个值）。桌面端如果要用，可以自己传 size 覆盖。
 *
 * **只替换 UI 图标，不动用户数据里的 Emoji** —— 节点文字、文档名里
 * 用户自己写的 Emoji 是他内容的一部分，一个字都不能碰。
 */

/** Lucide `menu` —— 汉堡菜单 */
export function MenuIcon({ size = 24, strokeWidth = 1.5 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <line x1="4" x2="20" y1="6" y2="6" />
      <line x1="4" x2="20" y1="12" y2="12" />
      <line x1="4" x2="20" y1="18" y2="18" />
    </Icon>
  )
}

/** Lucide `plus` —— 新建 */
export function PlusIcon({ size = 24, strokeWidth = 1.5 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Icon>
  )
}

/** Lucide `x` —— 关闭（替代 ✕ 文本字符，保证基线一致） */
export function CloseIcon({ size = 24, strokeWidth = 1.5 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  )
}

/** Lucide `minus` —— 缩小 */
export function MinusIcon({ size = 24, strokeWidth = 1.5 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <path d="M5 12h14" />
    </Icon>
  )
}

/** Lucide `more-horizontal` —— 「更多」 */
export function MoreHorizontalIcon({ size = 24, strokeWidth = 1.5 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </Icon>
  )
}

/** Lucide `crosshair` —— 一键居中 */
export function CrosshairIcon({ size = 24, strokeWidth = 1.5 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="10" />
      <line x1="22" x2="18" y1="12" y2="12" />
      <line x1="6" x2="2" y1="12" y2="12" />
      <line x1="12" x2="12" y1="6" y2="2" />
      <line x1="12" x2="12" y1="22" y2="18" />
    </Icon>
  )
}

/** Lucide `radar` —— 雷达复习模式 */
export function RadarIcon({ size = 24, strokeWidth = 1.5 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <path d="M19.07 4.93A10 10 0 0 0 6.99 3.34" />
      <path d="M4 6h.01" />
      <path d="M2.29 9.62a10 10 0 1 0 19.02-1.27" />
      <path d="M16.24 7.76a6 6 0 1 0-8.01 8.91" />
      <path d="M12 18h.01" />
      <path d="M17.99 11.66a6 6 0 0 1-2.22 5.01" />
      <circle cx="12" cy="12" r="2" />
      <path d="m13.41 10.59 5.66-5.66" />
    </Icon>
  )
}

/** Lucide `folder` —— 文件夹（替代 📁 Emoji） */
export function FolderIcon({ size = 24, strokeWidth = 1.5 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Icon>
  )
}

/** Lucide `search` —— 搜索（替代 ⌕ 字符） */
export function SearchIcon({ size = 24, strokeWidth = 1.5 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Icon>
  )
}

/**
 * Lucide `layers` —— 文档标签。
 *
 * 【为什么手机端需要一个「文档标签」图标】
 * 手机端原来把「文档标签」和「大纲树」塞在同一个抽屉里，用户明确要求
 * 「拆成两个独立入口，像电脑端一样」。拆开之后顶栏右侧那颗入口按钮
 * 得一眼看出是「切换文档」而不是「打开大纲」，所以用 layers（叠起来的
 * 卡片）而不是 menu（三条横线）—— 后者正是左侧大纲那颗的图标，
 * 两颗按钮长得一样就等于没拆开。
 */
export function LayersIcon({ size = 24, strokeWidth = 1.5 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 12.18-9.17 4.16a2 2 0 0 1-1.66 0L2 12.18" />
      <path d="m22 17.18-9.17 4.16a2 2 0 0 1-1.66 0L2 17.18" />
    </Icon>
  )
}

/** Lucide `chevron-down` —— 「可以展开」的指示箭头 */
export function ChevronDownIcon({ size = 24, strokeWidth = 1.5 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  )
}

/* ------------------------------------------------------------------ */
/* 桌面端工具栏：把 Emoji 换掉                                           */
/* ------------------------------------------------------------------ */
/*
 * 【为什么桌面端也要换】
 * 需求里明确了「不要 Emoji，要 SVG」。理由和手机端那批完全一样（见上）：
 *   · Emoji 是**彩色位图**，跟不了 `currentColor` —— 深色主题下那个彩色
 *     📌 / 🗑 和整条工具栏的灰蓝极简风格直接打架；
 *   · 各平台字形差别极大（Windows 是一套、macOS 另一套、各家 Android ROM
 *     又是各自的），同一个按钮在不同机器上长得完全不一样；
 *   · Emoji 的基线和字框和旁边的字符（⊙ ＋ − ◎）对不齐，一排按钮会歪。
 * SVG 走 `stroke="currentColor"`，三种主题自动适配，且和其他图标共用
 * 同一套 24×24 / stroke 的几何规格。
 *
 * **只换 UI 图标，不动用户数据里的 Emoji** —— 节点文字、文档名里用户
 * 自己写的 Emoji 是他内容的一部分，一个字都不能碰。
 */

/**
 * Lucide `pin` —— 图钉（「常显标签栏」/「常显大纲」）。
 *
 * `filled` 区分两种状态，对应原来 📌（实心，已钉住）/ 📍（空心，未钉住）：
 *   filled=true  → 实心填充，配合强调色 → 「钉住了，一直在」
 *   filled=false → 只描边，配合弱化色 → 「点一下可以钉住」
 * 用同一个几何的两个填充态，而不是两个形状：钉住与否是**状态**，
 * 换个形状会让人以为是两个不同的功能。
 */
export function PinIcon({ size = 14, strokeWidth = 1.8, filled = false }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Icon>
  )
}

/** Lucide `trash-2` —— 回收站（替代 🗑 Emoji）；桶身的两道竖线表示「里面有东西」 */
export function TrashIcon({ size = 14, strokeWidth = 1.8 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </Icon>
  )
}

/**
 * Lucide `triangle-alert` —— 警示三角（替代 ⚠ 字符）。
 *
 * ⚠（U+26A0）在 Unicode 里是 **Extended_Pictographic**：Windows 上会被
 * 系统 Emoji 字体接管，渲染成一个彩色感叹号三角，和旁边的红/橙小字完全不是一个调。
 * 换成描边 SVG 之后 `stroke="currentColor"` 直接继承那一行的颜色
 * （报错行是红的、引用未解析行是橙的），也顺带解决了 ⚠ 的基线偏高问题
 * ——原来要靠 `mt-[1px]` 手动补偿。
 */
export function AlertIcon({ size = 13, strokeWidth = 2 }) {
  return (
    <Icon size={size} strokeWidth={strokeWidth}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  )
}
