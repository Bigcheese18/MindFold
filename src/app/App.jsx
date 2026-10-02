import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TopTabs from './TopTabs'
import OutlineTree from '../features/outline/OutlineTree'
import Canvas from '../features/canvas/Canvas'
import ContextMenu from '../features/canvas/ContextMenu'
import FoldModal from '../features/fold/FoldModal'
import { CardReview, RadarHud } from '../features/review/Review'
import Confirm from '../components/Confirm'
import ThemeCubes from '../components/ThemeCubes'
import {
  makeNode, makeFold, findNode, findParent, walkTree, cloneTree, uid, collectFolds,
  normalizeRelations,
} from '../lib/model'
import { store, fingerprint, HISTORY_LIMIT } from '../lib/store'
import {
  moveNode, convergeToNewNode, pruneRelations, subtreeIds,
} from '../lib/treeOps'
import {
  emptyCanvasHistory, recordCanvasSnapshot, undoCanvas, redoCanvas,
  canCanvasUndo, canCanvasRedo, mergeFoldContent, sameCanvasTree, sameRelations,
} from '../lib/canvasHistory'
import {
  MenuIcon, PlusIcon, MinusIcon,
  MoreHorizontalIcon, CrosshairIcon, RadarIcon, TrashIcon,
  CloseIcon, LayersIcon, ChevronDownIcon,
} from '../components/icons'
import { useMobileBack, handleHardwareBack, isNativeShell, BACK_PRIORITY } from '../lib/hooks'
import {
  exportDocAs, DOC_EXPORT_FORMATS, exportFormatOf, exportBackup,
} from '../lib/exporters'
import { parseDocument, FORMAT, IMPORT_EXTENSIONS, IMPORT_MIME } from '../lib/formats'
import { applyTheme } from '../lib/mermaid'
import { FlatBtn, HistoryBtn } from './AppButtons'
import ExportSheet from './ExportSheet'
import FloatingRename from './FloatingRename'
import { useDocuments } from './useDocuments'
import { useEdgeSense } from './useEdgeSense'
import { useGlobalKeys } from './useGlobalKeys'

/**
 * 应用外壳。
 *
 * 【职责】
 *   · 选中 / 编辑 / 浮层这些「UI 状态」
 *   · 主画布的节点树操作（新增 / 删除 / 折叠 / 拖拽换位 / 折角）
 *   · 渲染
 *
 * 【已经搬出去的部分】
 *   文档层（标签页 / 落盘 / 历史版本 / 回收站 / 文件夹 / 导入）→ useDocuments
 *   桌面端边缘感应 + 图钉                                  → useEdgeSense
 *   全局快捷键                                             → useGlobalKeys
 *   底栏按钮 / 悬浮改名框 / 启动引导                        → AppButtons / FloatingRename / bootstrap
 */
export default function App() {
  const [selectedId, setSelectedId] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [ctxMenu, setCtxMenu] = useState(null)
  const [foldModal, setFoldModal] = useState(null)   // { nodeId, origin }
  const [confirm, setConfirm] = useState(null)       // { title, body, onOk, danger }
  const [toast, setToast] = useState(null)

  /*
   * 连线模式（「指向」/「指向同一结果」共用的一套待选状态）。
   *
   * 只有一个状态而不是两个布尔量：两个功能都是「先记住源节点，再点一个目标」，
   * 区别只在点击之后干什么。合成一个状态就天然保证了互斥 ——
   * 不可能出现「指向」和「指向同一结果」同时待选。
   *
   *   { kind: 'point', fromId }  → 点到的目标用来建立「指向」关系
   *   { kind: 'merge', fromId }  → 点到的目标用来生成汇聚节点
   */
  const [linkMode, setLinkMode] = useState(null)
  // 新生成的汇聚节点：渲染完成后要立刻弹悬浮输入框改名
  const [renameTarget, setRenameTarget] = useState(null)

  const [radar, setRadar] = useState(false)
  const [cards, setCards] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [theme, setTheme] = useState(() => store.getTheme())
  // 递增这个值即可让画布重新 fitView（切换文档 / 导入 / 新建时用）
  const [fitToken, setFitToken] = useState(0)
  const requestFit = useCallback(() => setFitToken((v) => v + 1), [])

  const [searchOpen, setSearchOpen] = useState(false)

  /*
   * 手机（窄屏）布局开关。
   *
   * 断点 768 和另外两处保持一致：Canvas 的缩放下限、FoldModal 的上下堆叠。
   * 三处用同一个阈值，用户不会看到「弹窗已经是手机版了、工具栏还是桌面版」
   * 这种半截状态。
   */
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 768
  )
  // 手机端「更多」面板
  const [moreOpen, setMoreOpen] = useState(false)
  /*
   * 导出格式面板（桌面 / 手机共用）。
   * 格式从 3 个扩到 6 个之后，工具栏再摆一排按钮就没法看了 —— 收进一个面板：
   * 一处列出全部出口，每行写清「导出来能干什么」。
   */
  const [exportOpen, setExportOpen] = useState(false)
  /*
   * 手机端左侧抽屉（取代原来的「左边缘滑动滑出大纲」）。
   * 桌面端不用它 —— 桌面端仍然是边缘感应 + 图钉，逻辑一个字没动。
   */
  const [drawerOpen, setDrawerOpen] = useState(false)

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  const canvasApi = useRef(null)
  const searchRef = useRef(null)
  /* 导入文件用的 <input type="file">（桌面端 / 手机端共用同一个节点） */
  const importInputRef = useRef(null)

  /* ---------------- 提示 ---------------- */
  const toastTimer = useRef(null)
  const say = useCallback((msg, kind = 'info') => {
    setToast({ msg, kind })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2200)
  }, [])
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  /* ---------------- 文档层 ---------------- */
  const {
    docs, activeId, doc, docsRef, applyDocs, updateDoc, flushPending,
    trash, setTrash, folders, history, setHistory,
    openDoc, createDoc, closeDoc, renameDoc, deleteDoc, restoreTrash, importDoc, importBackup,
    createFolder, renameFolder, deleteFolder, moveDoc,
  } = useDocuments({ say, setConfirm, requestFit, setSelectedId, setLinkMode, setRenameTarget })

  /* ---------------- 主画布的撤销 / 重做 ---------------- */
  /*
   * 三套历史互相独立，这里管的是**第三套**（主画布的节点树）：
   *   · 本模块        → 拖拽换位 / 改文字 / 打·取消折角 / 删除节点
   *   · FoldModal     → 弹窗里的 Mermaid 源码（src/lib/history.js）
   *   · 时钟按钮      → 文档历史版本（store.js 的 hist:<id>，落盘的）
   *
   * 栈放在 ref 里而不是 state：入栈/出栈必须**同步**读到最新值，
   * 用 state 的话连续两次操作会拿到闭包里的旧栈，丢步。
   * 只有「能不能撤销/重做」这两个布尔量需要驱动 UI，单独放 state。
   */
  const canvasHistRef = useRef(emptyCanvasHistory())
  const [canvasHist, setCanvasHist] = useState({ canUndo: false, canRedo: false })
  const syncCanvasHist = useCallback(() => {
    setCanvasHist({
      canUndo: canCanvasUndo(canvasHistRef.current),
      canRedo: canCanvasRedo(canvasHistRef.current),
    })
  }, [])

  /**
   * 只改树、不动其他字段的便捷写法。
   *
   * 【画布历史的唯一记录点就在这里】
   * 画布上所有会改树的动作（拖拽换位 / 改文字 / 打·取消折角 / 删除节点 /
   * 新增节点 / 折叠 / 粗斜体）都走这个函数，所以只需要在这一个地方入栈，
   * 不必去每个 handler 里各写一遍 —— 那种写法迟早会漏掉一个。
   *
   * 入栈时机是「变更**前**」：先把旧树记下来，再写新树，这样 undo 才知道回哪儿。
   *
   * `record:false` 给两类**不属于画布**的变更用：
   *   · 弹窗保存折角内容（saveFoldContent）—— 那是弹窗的历史
   *   · 将来若有别的旁路写入
   * 至于「点开折角 openCount+1」不需要这个标记：sameCanvasTree 本来就不比
   * openCount，判定为「没变」，自然不入栈。
   */
  const updateTree = useCallback((mutator, opts = {}) => {
    const { record = true, ...docOpts } = opts
    const cur = docsRef.current.find((d) => d.id === activeId)
    if (!cur) return
    const nextRoot = cloneTree(cur.root, true)
    const prevRelations = normalizeRelations(cur.relations)
    // relations 也放在同一个 mutator 里改，才能和树共享一次「变了没有」的判定。
    // 拆成两次写入的话，一次「指向同一结果」会占掉两格历史。
    const nextRelations = normalizeRelations(cur.relations)
    mutator(nextRoot, nextRelations)

    if (record) {
      // 只有真的变了才入栈：原样提交文字、越界移动都不该占一格历史。
      // relations 也是内容的一部分，必须一起比 —— 否则撤销会因为
      // 「树没变」而被判定为无事发生，虚线却已经被加上了。
      const changed = !sameCanvasTree(cur.root, nextRoot) || !sameRelations(cur.relations, nextRelations)
      canvasHistRef.current = recordCanvasSnapshot(canvasHistRef.current, cur.root, changed, prevRelations)
      if (changed) syncCanvasHist()
    }

    updateDoc({ root: nextRoot, relations: nextRelations }, docOpts)
  }, [activeId, updateDoc, syncCanvasHist, docsRef])

  /* ================================================================ */
  /* 节点操作                                                          */
  /* ================================================================ */

  const addChild = useCallback((id) => {
    const nid = uid()
    updateTree((root) => {
      const n = findNode(root, id)
      if (!n) return
      n.children.push({ ...makeNode('新节点'), id: nid })
      n.collapsed = false
    })
    setSelectedId(nid)
    setEditingId(nid)
  }, [updateTree])

  const addSibling = useCallback((id) => {
    const nid = uid()
    updateTree((root) => {
      const p = findParent(root, id)
      if (!p) return
      const idx = p.children.findIndex((c) => c.id === id)
      p.children.splice(idx + 1, 0, { ...makeNode('新节点'), id: nid })
    })
    setSelectedId(nid)
    setEditingId(nid)
  }, [updateTree])

  /**
   * 删除节点。
   *
   * 【必须联动清理 relations】
   * 删掉一个节点会连带删掉它的整棵子树，这些 id 一旦留在 relations 里
   * 就成了悬空引用 —— 渲染层会画出「从空气到空气」的虚线。
   * 所以先把子树的**全部** id 收集出来，再从 relations 里剪掉所有
   * 以它们为端点（无论出发还是到达）的记录。
   *
   * 【汇聚节点不跟着消失】
   * 新生成的汇聚节点已经是一个挂在公共父节点下的**独立节点**，
   * 它和 A、B 之间只有虚线的数据关系。删掉 A 只是剪掉 A 那条虚线，
   * 汇聚节点自己（以及 B 到它的虚线）原样保留 —— 这是需求明确要求的。
   */
  const removeNode = useCallback((id) => {
    updateTree((root, relations) => {
      const target = findNode(root, id)
      const p = findParent(root, id)
      if (!p || !target) return
      // 先收集 id 再动手 —— 从树上摘下去之后就找不到子树了
      const gone = subtreeIds(target)
      p.children = p.children.filter((c) => c.id !== id)
      const kept = pruneRelations(relations, gone)
      relations.length = 0
      relations.push(...kept)
    })
    setSelectedId(null)
    // 正在改的节点被删了，把悬浮输入框收掉，否则会飘在一个不存在的节点上
    setRenameTarget((t) => (t && t.id === id ? null : t))
  }, [updateTree])

  const commitEdit = useCallback((id, text) => {
    updateTree((root) => {
      const n = findNode(root, id)
      if (n) n.text = text.trim() || n.text
    })
    setEditingId(null)
  }, [updateTree])

  /**
   * 汇聚节点的悬浮输入框：确认改名。
   *
   * 和 commitEdit 分开是因为它有额外的收尾动作（关掉 renameTarget），
   * 而且它改的那个节点此刻正被高亮选中 —— 复用 commitEdit 会让
   * 「谁在编辑」和「谁要改名」两个状态纠缠在一起。
   *
   * 空文字**保留原名**而不是清空：节点文字为空时节点框会变成一个空壳，
   * 用户还得再找到它删掉。与 commitEdit 的兜底行为保持一致。
   */
  const commitRename = useCallback((text) => {
    const t = renameTarget
    if (!t) return
    const next = String(text ?? '').trim()
    if (next) {
      updateTree((root) => {
        const n = findNode(root, t.id)
        if (n) n.text = next
      })
    }
    setRenameTarget(null)
  }, [renameTarget, updateTree])

  const cancelRename = useCallback(() => setRenameTarget(null), [])

  const toggleCollapse = useCallback((id) => {
    updateTree((root) => {
      const n = findNode(root, id)
      if (n) n.collapsed = !n.collapsed
    })
  }, [updateTree])

  const toggleBold = useCallback((id) => {
    updateTree((root) => {
      const n = findNode(root, id)
      if (n) n.bold = !n.bold
    })
  }, [updateTree])

  const toggleItalic = useCallback((id) => {
    updateTree((root) => {
      const n = findNode(root, id)
      if (n) n.italic = !n.italic
    })
  }, [updateTree])

  /**
   * 拖拽改变层级。
   * @param position 'child' 成为目标的子节点
   *                 'before' 插到目标前面（成为它的上一个兄弟）
   *                 'after'  插到目标后面（成为它的下一个兄弟）
   */
  const dropNode = useCallback((dragId, targetId, position = 'child') => {
    let result = { moved: false }
    updateTree((root) => {
      result = moveNode(root, dragId, targetId, position)
    })
    if (!result.moved) return
    if (result.reason === 'cycle') { say('不能把节点拖进它自己的子树', 'error'); return }
    say(position === 'child' ? '已成为子节点' : '已调整顺序')
  }, [updateTree, say])

  /* ================================================================ */
  /* 指向 / 指向同一结果                                                */
  /* ================================================================ */

  /**
   * 进入连线模式。
   *
   * 「指向」和「指向同一结果」共用它，只是 kind 不同 —— 见 linkMode 的注释。
   * 直接 setState 覆盖，不做「如果已经开着就先关掉」的花活：
   * 覆盖天然就是互斥的。
   */
  const startLink = useCallback((fromId, kind = 'point') => {
    setCtxMenu(null)
    setLinkMode({ kind, fromId })
    say(kind === 'merge' ? '请点击要汇聚的另一个节点' : '请点击要指向的节点')
  }, [say])

  const cancelLink = useCallback(() => setLinkMode(null), [])

  /**
   * 连线模式下点中了目标节点。
   *
   * 两个分支做完都必须退出连线模式 —— 包括失败的情况。
   * 失败还赖在待选状态里的话，用户点一次没反应、点第二次还是没反应，
   * 只能靠 Esc 逃出去，很容易被当成卡死。
   */
  const pickLinkTarget = useCallback((targetId) => {
    const mode = linkMode
    if (!mode) return
    setLinkMode(null)

    // ---- 分支一：「指向」—— 只加一条虚线，不动树 ----
    if (mode.kind === 'point') {
      if (targetId === mode.fromId) return
      let added = false
      updateTree((root, relations) => {
        const from = findNode(root, mode.fromId)
        const to = findNode(root, targetId)
        if (!from || !to) return
        if (relations.some((r) => r.from === mode.fromId && r.to === targetId)) return
        relations.push({ from: mode.fromId, to: targetId })
        added = true
      })
      if (added) say('已建立指向关系')
      else say('这条指向已经存在了', 'error')
      return
    }

    // ---- 分支二：「指向同一结果」—— 建汇聚节点 + 两条虚线 ----
    /*
     * 先把要算的东西在一个临时树上试跑，拿到结果再一次性写回。
     *
     * 为什么不直接在 updateTree 的 mutator 里做：
     * mutator 拿到的 nextRoot 是**已经克隆好的新树**，它改完就会生效，
     * 而 convergeToNewNode 失败时（同节点 / 重复）不该产生任何写入。
     * 在 mutator 里改一半再放弃，就会留下一个已经改过的 nextRoot。
     * 所以这里先在一份**临时克隆**上算出结果，成功才真正写。
     */
    const cur = docsRef.current.find((d) => d.id === activeId)
    if (!cur) return
    const probeRoot = cloneTree(cur.root, true)
    const probe = convergeToNewNode(probeRoot, normalizeRelations(cur.relations), mode.fromId, targetId)

    if (!probe.ok) {
      if (probe.reason === 'duplicate') say('已存在汇聚关系', 'error')
      else if (probe.reason === 'self') say('不能指向自己', 'error')
      else say('找不到节点，操作已取消', 'error')
      return
    }

    // 成功：按 probe 算出来的结构正式写一次
    updateTree((root, relations) => {
      const parent = findNode(root, probe.parentId)
      if (!parent) return
      const fresh = makeNode(probe.label)
      // 用 probe 已经定下来的 id，保证后面弹输入框时找得到这个节点
      fresh.id = probe.newNodeId
      parent.children.push(fresh)
      parent.collapsed = false
      relations.push(...probe.relations.filter((r) => !relations.some((x) => x.from === r.from && x.to === r.to)))
    })

    setSelectedId(probe.newNodeId)
    // 渲染完成后立刻弹悬浮输入框改名（需求 A 方案：默认全选「新结果节点」）
    setRenameTarget({ id: probe.newNodeId, text: probe.label })
    say('已生成汇聚节点，可直接改名')
  }, [linkMode, updateTree, say, activeId, docsRef])

  /* ================================================================ */
  /* 折角机制（产品灵魂）                                               */
  /* ================================================================ */

  const addFold = useCallback((id) => {
    updateTree((root) => {
      const n = findNode(root, id)
      // 已有折角就不重复打，避免把熟悉度清零
      if (n && !n.fold) n.fold = makeFold({ corner: false })
    })
    say('已打上折角 · 点击右上角折角编辑流程图')
  }, [updateTree, say])

  const removeFold = useCallback((id) => {
    setConfirm({
      title: '取消折角',
      body: '取消后，内部的流程图数据将被一并删除，是否继续？',
      danger: true,
      onOk: () => {
        updateTree((root) => {
          const n = findNode(root, id)
          if (n) n.fold = null
        })
        say('已取消折角')
      },
    })
  }, [updateTree, say])

  const resetFamiliarity = useCallback((id) => {
    updateTree((root) => {
      const n = findNode(root, id)
      if (n?.fold) n.fold.openCount = 0
    })
    say('熟悉度已重置')
  }, [updateTree, say])

  /** 点击折角 → 打开全屏弹窗（带折角屏幕坐标，用于放大动画的 origin） */
  const openFold = useCallback((nodeId, e) => {
    const node = doc ? findNode(doc.root, nodeId) : null
    if (!node) return

    let origin = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const el = document.querySelector(`[data-node-id="${nodeId}"]`)
    if (el) {
      const r = el.getBoundingClientRect()
      origin = { x: r.right - 6, y: r.top + 4 }
    } else if (e?.clientX !== undefined) {
      origin = { x: e.clientX, y: e.clientY }
    }

    // 打开次数 +1 → 驱动颜色分级
    updateTree((root) => {
      const n = findNode(root, nodeId)
      if (!n?.fold) return
      n.fold.openCount = (n.fold.openCount || 0) + 1
    }, { persistNow: true })

    setFoldModal({ nodeId, origin })
  }, [doc, updateTree])

  const saveFoldContent = useCallback((payload) => {
    // 不要写成 setFoldModal(m => { updateTree(...); return m })：
    // 在状态 updater 里触发另一个 setState 属于副作用，严格模式下会重复执行。
    if (!foldModal) return
    const { nodeId } = foldModal
    /*
     * record:false —— 折角内容属于**弹窗**的历史，不能占主画布的历史格。
     *
     * 不排除的话有个很隐蔽的事故：第一次保存时 fold.corner 会从 false 变 true，
     * 这在 sameCanvasTree 眼里是「结构变了」，于是画布栈里多出一格。
     * 用户随后在画布上按一次撤销，就会把这个折角整个撤掉（连带流程图）。
     */
    updateTree((root) => {
      const n = findNode(root, nodeId)
      if (!n?.fold) return
      n.fold.outline = payload.outline
      n.fold.mermaid = payload.mermaid
      n.fold.corner = !!payload.mermaid          // 有代码 = 实心折角
      n.fold.updatedAt = Date.now()
    }, { record: false })
  }, [foldModal, updateTree])

  /* ================================================================ */
  /* 主画布：撤销 / 重做                                                */
  /* ================================================================ */

  /**
   * 撤销一步。
   *
   * 两个要点：
   *   1. 当前树是**现取**的（从 docsRef 读），不是从历史里记的 current ——
   *      中间夹着多少次「不记录历史」的变更都不会错位。
   *   2. 写回去之前必须过一遍 mergeFoldContent：折角里的流程图是弹窗写的，
   *      画布的撤销绝不能把它冲掉（详见 canvasHistory.js 的注释）。
   */
  const handleCanvasUndo = useCallback(() => {
    const cur = docsRef.current.find((d) => d.id === activeId)
    if (!cur) return
    const r = undoCanvas(canvasHistRef.current, cur.root, cur.relations)
    if (!r) return
    canvasHistRef.current = r.history
    syncCanvasHist()
    // 撤销后正在改的那一行可能已经不存在了，把行内编辑态收掉
    setEditingId(null)
    setRenameTarget(null)
    setLinkMode(null)
    // relations 必须跟着树一起回退，否则「指向同一结果」撤销后会剩两条悬空虚线
    updateDoc({ root: mergeFoldContent(r.tree, cur.root), relations: r.relations })
  }, [activeId, syncCanvasHist, updateDoc, docsRef])

  const handleCanvasRedo = useCallback(() => {
    const cur = docsRef.current.find((d) => d.id === activeId)
    if (!cur) return
    const r = redoCanvas(canvasHistRef.current, cur.root, cur.relations)
    if (!r) return
    canvasHistRef.current = r.history
    syncCanvasHist()
    setEditingId(null)
    setRenameTarget(null)
    setLinkMode(null)
    updateDoc({ root: mergeFoldContent(r.tree, cur.root), relations: r.relations })
  }, [activeId, syncCanvasHist, updateDoc, docsRef])

  /* ================================================================ */
  /* 搜索 / 历史版本                                                   */
  /* ================================================================ */

  const [quickFind, setQuickFind] = useState('')
  const findMatches = useMemo(() => {
    if (!doc || !quickFind.trim()) return []
    const q = quickFind.toLowerCase()
    const out = []
    walkTree(doc.root, (n) => { if (n.text.toLowerCase().includes(q)) out.push(n) })
    return out
  }, [doc, quickFind])

  /**
   * 把某个节点挪到视口中央。
   *
   * 【绝不改变缩放】—— 用户原话：「进行操作时不要改变缩放大小」。
   *
   * 原来是 `Math.max(0.6, Math.min(1.2, doc?.view?.zoom ?? 1))`，也就是把
   * 用户当前的缩放硬夹到 [0.6, 1.2]。后果用探针实测过（1440×900，先 Ctrl+滚轮
   * 缩放到 1.6995 再进雷达模式）：
   *
   *     zoom 1.6995 → 1.2000   （一次 React commit 直接改写 transform）
   *
   * 而这个函数有七个调用方，全都会被顺手改掉缩放：
   *   · 进入雷达模式时定位到第一个折角（App 里的 effect）
   *   · 雷达模式按 N / 点「下一个折角」
   *   · 搜索结果点击 / 回车
   *   · 桌面端左侧大纲的「定位」、手机端抽屉的「定位」「搜索跳转」
   * 用户只是想「跳到那个节点」，结果整张图的缩放级别被改掉了，
   * 而且缩放到 1.2 以下时（大图很常见）是**放大**，视野一下被推近。
   *
   * 定位的语义就是「把视口挪过去」，缩放是用户自己用 ＋/－、捏合、
   * Ctrl+滚轮决定的，任何时候都不该被顺手改。
   */
  const jumpTo = useCallback((nodeId) => {
    setSelectedId(nodeId)
    setSearchOpen(false)
    setQuickFind('')
    // 把命中节点滚到视口中央
    requestAnimationFrame(() => {
      const item = canvasApi.current?.getById(nodeId)
      if (!item) return
      const zoom = doc?.view?.zoom ?? 1     // 原样沿用，不夹取、不重算
      updateDoc({
        view: {
          zoom,
          x: window.innerWidth / 2 - (item.x + item.w / 2) * zoom,
          y: window.innerHeight / 2 - (item.y + item.h / 2) * zoom,
        },
      })
    })
  }, [updateDoc, doc])

  /* ================================================================ */
  /* 全局快捷键                                                        */
  /* ================================================================ */
  useGlobalKeys({
    doc, selectedId, editingId, foldModal, cards, radar, searchOpen, linkMode, renameTarget,
    canvasApi, searchRef,
    setSelectedId, setEditingId, setSearchOpen, setLinkMode, setRenameTarget, setCards, setRadar,
    addChild, addSibling, removeNode, toggleBold, toggleItalic, jumpTo,
    say, flushPending, handleCanvasUndo, handleCanvasRedo,
  })

  /* ================================================================ */
  /* 隐藏式 UI 的边缘感应（仅桌面端）+ 手机端布局开关                    */
  /* ================================================================ */
  const {
    tabsOpen, setTabsOpen, tabsPinned, setTabsPinned,
    treeOpen, setTreeOpen, treePinned, setTreePinned,
  } = useEdgeSense(compact)

  useEffect(() => {
    const onResize = () => {
      const next = window.innerWidth < 768
      setCompact(next)
      // 转回宽屏时把手机专属的浮层收掉，否则它会飘在一个不该存在的位置
      if (!next) {
        setMoreOpen(false)
        setDrawerOpen(false)
      }
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    onResize()
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  /**
   * 手机端：滑动即关菜单（黄金标准）。
   *
   * 菜单是按屏幕像素 fixed 定位的，画布一动它就指向空气了；
   * 而且手指在屏幕上滑动时的意图明确是「看别处」。
   * 所以只要出现 touchmove，无条件关掉 —— 不做位移阈值判断，
   * 因为阈值会让「慢慢滑」的那一小段里菜单仍然挂着，看起来像没反应。
   *
   * passive: true —— 我们只是「读一下有没有滑动」，不阻止默认行为，
   * 否则会打断画布自己的平移手势。
   */
  useEffect(() => {
    if (!compact || !ctxMenu) return undefined
    const onTouchMove = () => setCtxMenu(null)
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => window.removeEventListener('touchmove', onTouchMove)
  }, [compact, ctxMenu])

  /**
   * 手机端长按节点 → 弹右键菜单（手机没有右键）。
   * 长按的判定与防误触都在 Canvas 里（500ms / 10px），这里只负责开菜单。
   */
  const openNodeMenuAt = useCallback((x, y, node) => {
    setCtxMenu({ x, y, node })
  }, [])

  /**
   * 画布开始平移/缩放 → 立刻关掉右键菜单。
   * 覆盖「拖动/捏合/滚轮缩放」三种，比等 view 提交更及时。
   */
  const closeCanvasMenu = useCallback(() => {
    setCtxMenu((m) => (m ? null : m))
  }, [])

  /* ---- 手机端「更多」面板：点外面 / 按 Esc 关掉 ---- */
  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e) => {
      if (e.target?.closest?.('[data-more-sheet]')) return
      if (e.target?.closest?.('[data-tool="more"]')) return
      setMoreOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setMoreOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  /* ---- 手机端「文档标签」面板：点外面 / 按 Esc 关掉 ---- */
  /*
   * 面板是从屏幕顶上滑下来的一条，下面就是画布。没有遮罩（遮住画布反而
   * 让「换个文档接着看图」变麻烦），所以必须显式处理「点空白处关掉」，
   * 否则用户只能去找右上角那个 ✕。
   */
  useEffect(() => {
    if (!compact || !tabsOpen) return undefined
    const onDown = (e) => {
      if (e.target?.closest?.('[data-mobile-tabs-sheet]')) return
      if (e.target?.closest?.('[data-mobile-tabs-btn]')) return
      setTabsOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setTabsOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [compact, tabsOpen])

  /**
   * 手机端返回键：按优先级依次关闭浮层。
   *
   * 两条来源走的是同一份注册表（`src/lib/hooks.js` 里的 backLayers）：
   *   · 手机浏览器的返回键 → `popstate`
   *   · **安卓应用里的硬件返回键** → MainActivity.onBackPressed 转交
   *     `window.__mfHardwareBack`（下面的 effect 负责挂上）
   * 第二条件是必须的：Capacitor 的 BridgeActivity **没有重写 onBackPressed**，
   * 不接这一下，安卓的返回键就是「直接退出应用」，任何浮层开着也一样。
   *
   * 浮层只有在 `shouldHandleBack()` 为真时才压栈：手机浏览器看宽度（≤768），
   * 原生壳不看宽度（横屏 852px 也照样是手机）。桌面浏览器两者都不满足，
   * 所以桌面按浏览器返回键不会被应用吃掉。
   *
   * 优先级：右键菜单(3) > 全屏浮层(2) > 底部抽屉/面板(1)。
   * 共享一份注册表，按一次返回键**只关一个** —— 绝不一按全关。
   */
  useMobileBack(!!ctxMenu, () => setCtxMenu(null), BACK_PRIORITY.MENU)
  useMobileBack(!!confirm, () => setConfirm(null), BACK_PRIORITY.MENU)
  useMobileBack(!!renameTarget, () => setRenameTarget(null), BACK_PRIORITY.MENU)
  useMobileBack(!!foldModal, () => setFoldModal(null), BACK_PRIORITY.MODAL)
  useMobileBack(cards, () => setCards(false), BACK_PRIORITY.MODAL)
  useMobileBack(searchOpen, () => setSearchOpen(false), BACK_PRIORITY.MODAL)
  useMobileBack(radar, () => setRadar(false), BACK_PRIORITY.MODAL)
  useMobileBack(drawerOpen, closeDrawer, BACK_PRIORITY.DRAWER)
  /*
   * 手机端「文档标签」面板：和抽屉同一优先级。
   * 只在手机端（compact）注册 —— 桌面端 tabsOpen 是「鼠标贴到屏幕顶边」的
   * 瞬时状态，如果也压栈，桌面用户按浏览器返回键会先被吃掉一次。
   */
  useMobileBack(compact && tabsOpen, () => setTabsOpen(false), BACK_PRIORITY.DRAWER)
  useMobileBack(moreOpen, () => setMoreOpen(false), BACK_PRIORITY.DRAWER)
  useMobileBack(showHistory, () => setShowHistory(false), BACK_PRIORITY.DRAWER)
  useMobileBack(showTrash, () => setShowTrash(false), BACK_PRIORITY.DRAWER)

  /**
   * 把「关掉最上面那个浮层」暴露给原生壳。
   *
   * MainActivity.onBackPressed 会执行 `window.__mfHardwareBack()`：
   * 返回 true（关掉了东西）→ 吃掉这次返回；返回 false → 交回系统退出应用。
   * 返回的是布尔值，evaluateJavascript 拿到的是 `"true"` / `"false"` 字符串。
   *
   * 普通浏览器里没人调它，挂着也没有副作用；写成一个 effect 而不是模块级
   * 副作用，是为了让它在 App 生命周期内存在、卸载时干净地撤掉。
   */
  useEffect(() => {
    if (!isNativeShell()) return undefined
    window.__mfHardwareBack = handleHardwareBack
    return () => { delete window.__mfHardwareBack }
  }, [])

  /**
   * 进入雷达模式时，把视口对到第一个折角上。
   * 否则折角可能正好在屏幕外，用户只会看到一片变暗的空白画布。
   */  useEffect(() => {
    if (!radar || !doc) return
    const folds = collectFolds(doc.root)
    if (!folds.length) return
    jumpTo(folds[0].node.id)
    // 只在「进入雷达模式」这一刻定位，之后由 HUD 的「下一个折角」驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radar])

  /* ---- 主题 ---- */
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    store.setTheme(theme)
    applyTheme(theme)
  }, [theme])

  /* ================================================================ */
  /* 导出                                                              */
  /* ================================================================ */
  /*
   * 原生壳（安卓 Capacitor / iOS WKWebView）里**没有文件下载通道**，
   * 也没有打印接口 —— 判据和来龙去脉见 hooks.isNativeShell 的注释。
   * 这四个导出动作在手机上点了既不报错也不落文件，用户只会以为应用坏了。
   * 所以先问一句平台，能存就直接存，不能存就当场说清楚去哪儿做。
   * 返回 true = 已经给过提示，调用方直接 return。
   */
  const blockedOnNative = (msg) => {
    if (!isNativeShell()) return false
    say(msg, 'error')
    return true
  }

  /**
   * 按格式导出的**唯一**实现。
   *
   * 工具栏那颗 ⇩（离线 HTML）、⎙（PDF）、右下角的「导出 MD」、以及导出面板里的
   * 六行，全都走这一个函数。理由：提示条文案、原生壳拦截、异常兜底三件事
   * 只要有一处各写一遍，就会出现「说了导出 PDF、实际落下来是 HTML」这种
   * 最难查的不一致 —— 用户看到的和发生的对不上。
   *
   * 返回的 message 由 exporters.exportDocAs 给，本函数只负责「先问平台、
   * 再干活、再原样转述」。
   */
  const runExport = useCallback(async (key) => {
    if (!doc) return
    const meta = exportFormatOf(key)
    if (!meta) return
    if (meta.native === 'print') {
      if (blockedOnNative('应用内不能打印：系统 WebView 没有打印接口 · 请在电脑版导出 PDF')) return
    } else if (blockedOnNative(`应用内不能保存文件：系统 WebView 没有下载通道 · 请在电脑版导出${meta.label}`)) return

    setExportOpen(false)
    // 两个慢动作先报一声，否则点了以后界面几秒没反应（要渲染全部流程图）
    if (key === 'html') say('正在内联渲染流程图…')
    if (key === 'pdf') say('正在生成打印视图（导图 + 流程图，强制纯白主题）…')
    try {
      const r = await exportDocAs(key, doc, { theme })
      say(r.message, r.kind === 'error' ? 'error' : 'info')
    } catch (err) {
      say('导出失败：' + err.message, 'error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, theme, say])

  const doExportHtml = () => runExport('html')

  const doExportPdf = () => runExport('pdf')

  const doExportMd = () => runExport('md')

  const doBackup = () => {
    if (blockedOnNative('应用内不能保存文件：系统 WebView 没有下载通道 · 请在电脑版备份')) return
    exportBackup(store.exportAll())
    say('已导出整库备份 JSON')
  }

  /**
   * 导入文件。
   *
   * 【不再看扩展名分支，改成让 formats.js 按内容认格式】
   * 用户原话：「加一个导入的格式 html 不止 markdown 可以扩展多一点 导入也是」。
   * 现在认：Markdown / 纯文本缩进大纲 / OPML / FreeMind(.mm) / HTML /
   * 单文档 JSON / 整库备份 JSON —— 而且**扩展名只做兜底**：从网页另存下来的
   * 大纲叫 .html 但内容是纯列表、mermaid 笔记存成 .txt，都照样读得出来。
   * 认不出的情况会抛一句人话（比如「这是打印预览页，没法当数据导入」），
   * 直接念给用户听，而不是静默什么都不发生。
   */
  const doImportFile = (file) => {
    const reader = new FileReader()
    reader.onerror = () => say('这个文件读不出来（可能是二进制文件，或者被别处占用了）', 'error')
    reader.onload = () => {
      const text = String(reader.result || '')
      let parsed
      try {
        parsed = parseDocument(text, { filename: file.name })
      } catch (err) {
        say(err.message, 'error')
        return
      }
      // 整库备份要走 store.importAll：它还要动标签栏 / 回收站 / 文件夹
      if (parsed.format === FORMAT.BACKUP) {
        try {
          const { ids, skipped } = importBackup(parsed.backup)
          say(skipped
            ? `已恢复 ${ids.length} 个文档，跳过 ${skipped} 个损坏条目`
            : `已从备份恢复 ${ids.length} 个文档`)
        } catch (err) { say(err.message, 'error') }
        return
      }
      importDoc(parsed)
    }
    reader.readAsText(file, 'utf-8')
  }

  const restoreHistory = (snap) => {
    if (!doc) return
    setConfirm({
      title: '恢复历史版本',
      body: `将用 ${new Date(snap.at).toLocaleString()} 的版本覆盖当前内容，是否继续？`,
      onOk: () => {
        updateDoc({ root: cloneTree(snap.root, true) }, { persistNow: true })
        store.pushHistory(doc.id, { at: Date.now(), fingerprint: fingerprint(snap.root), root: cloneTree(snap.root, true), name: doc.name })
        setShowHistory(false)
        say('已恢复该版本')
      },
    })
  }

  /* ================================================================ */
  /* 渲染                                                              */
  /* ================================================================ */

  if (!doc) {
    return (
      <div className="h-full grid place-items-center text-[13px]" style={{ color: 'var(--mf-muted)' }}>
        正在加载…
      </div>
    )
  }

  const foldsTotal = collectFolds(doc.root).length
  const modalNode = foldModal ? findNode(doc.root, foldModal.nodeId) : null

  return (
    <div className="h-full relative">
      {/* ---------- 隐藏式顶部标签栏 ---------- */}
      {/*
        主题（纯白/护眼/夜间）**不在这条里**：第八轮按用户要求搬到了左侧栏，
        并按用户指定的落点并进侧栏头部、紧挨「固定按钮」（图钉/✕）左边
        ——桌面见下方 `OutlineTree` 头部、手机见上面那条抽屉头，两处都用
        `components/ThemeCubes.jsx`。「主题」不是「文档标签」这一族的东西，
        挂在这里只会把标签挤去横滑。这条只剩文档标签相关的东西。
      */}
      <TopTabs
        open={tabsOpen || tabsPinned}
        tabs={docs}
        activeId={activeId}
        pinned={tabsPinned}
        onSwitch={openDoc}
        onClose={closeDoc}
        onNew={() => createDoc(null, `未命名导图 ${docs.length + 1}`)}
        onPin={() => { setTabsPinned((v) => !v); }}
        mobile={compact}
        onDismiss={() => setTabsOpen(false)}
      />

      {/* ---------- 手机端：左上角汉堡菜单（取代边缘手势） ---------- */}
      {/*
        桌面端是「鼠标贴到左边缘滑出大纲」，手机上那套完全不能用
        （没有鼠标，mousemove 只由点击合成 → 点左边缘会莫名滑出）。
        所以手机端给一个**显式的 44×44 按钮**，位置避开刘海/状态栏。
      */}
      {compact && (
        <button
          data-mobile-menu-btn
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="打开大纲"
          title="打开大纲"
          className="fixed z-[60] grid place-items-center rounded-xl border shadow-card mf-fixed-top mf-fixed-left"
          style={{
            width: 44,
            height: 44,
            background: 'var(--mf-panel)',
            borderColor: 'var(--mf-hairline)',
            color: 'var(--mf-ink)',
          }}
        >
          <MenuIcon size={24} strokeWidth={1.5} />
        </button>
      )}

      {/* ---------- 手机端：右上角「文档标签」入口 ---------- */}
      {/*
        「顶部」在手机上的落点。
        为什么要显示**当前文档名**：拆成两个入口之后，顶部这一颗必须能自己
        说明「这是文档」，否则和左边的汉堡（大纲）长得一样，用户还得试。
        图标用 layers（叠起来的卡片）—— 左边那颗是 menu（三条横线）。

        为什么宽度夹在 46vw：文档名可能是任意长的一句话，不夹住的话这颗
        按钮会一路顶到屏幕左边、把左边的大纲按钮盖住。
        aria-expanded 如实反映展开状态，读屏和测试都不靠猜。
      */}
      {compact && !tabsOpen && !tabsPinned && (
        <button
          data-mobile-tabs-btn
          type="button"
          onClick={() => setTabsOpen((v) => !v)}
          aria-expanded={!!(tabsOpen || tabsPinned)}
          aria-label="文档标签"
          title="文档标签"
          className="fixed z-[60] flex items-center gap-1.5 rounded-xl border shadow-card mf-fixed-top mf-fixed-right"
          style={{
            height: 44,
            maxWidth: '46vw',
            paddingLeft: 10,
            paddingRight: 8,
            background: 'var(--mf-panel)',
            borderColor: 'var(--mf-hairline)',
            color: 'var(--mf-ink)',
          }}
        >
          <LayersIcon size={18} strokeWidth={1.5} />
          <span className="truncate text-[12.5px]">{doc.name}</span>
          <span className="shrink-0 opacity-60"><ChevronDownIcon size={16} strokeWidth={1.6} /></span>
        </button>
      )}

      {/* ---------- 手机端：左侧抽屉（80% 宽 + 半透明遮罩） ---------- */}
      {compact && drawerOpen && (
        <>
          <div
            data-drawer-mask
            onClick={closeDrawer}
            className="fixed inset-0 z-[79] mf-fade"
            style={{ background: 'rgba(0,0,0,.38)' }}
          />
          <aside
            data-mobile-drawer
            className="fixed inset-y-0 left-0 z-[80] flex flex-col mf-fade"
            style={{
              width: '80%',
              maxWidth: 420,
              background: 'var(--mf-panel)',
              borderRight: '1px solid var(--mf-hairline)',
              paddingLeft: 'var(--mf-safe-l)',
              paddingTop: 'var(--mf-safe-t)',
              paddingBottom: 'var(--mf-safe-b)',
            }}
          >
            {/*
              ★ 这里原来是一条 50px 高的横向「文档标签」长条（data-drawer-tabs）。
                用户要求「左侧和顶部分开，像电脑端一样但是适配手机端」，所以
                标签已经搬到右上角 data-mobile-tabs-btn 那颗入口里，抽屉里
                只留大纲 —— 两处都能换文档就是两套状态，迟早分叉。
                换成一行「大纲 + ✕」标题：44px 热区的显式关闭，比只能点遮罩好。
            */}
            {/*
              ★ 第八轮：主题三色块就在「关闭大纲」这颗**固定按钮的左边**。
              用户原话：「放到左侧栏里面的固定按钮左边就行 移动端也是」。
              抽屉里没有图钉（手机端没有边缘感应，钉住没意义），所以这一行
              右侧那颗 44×36 的 ✕ 就是「固定按钮」，色块贴在它左边、
              和它**同一行**（不是另起一行，也不再挂在抽屉最底部）。
              宽度核对（最窄的 320px 手机 → 抽屉 80% = 256，减去 px-3 的 24 = 232）：
              「大纲」≈28 + 间隙 8 + 三颗 40（gap 4×2 = 8）= 128 + 间隙 8 + ✕ 44 = 216 ≤ 232。
              这里**不写「主题」两个字**：就是被省下来的那 32px 让最窄机型也放得下；
              名字没丢——每颗色块的 aria-label / title 仍是「主题：纯白 / 护眼 / 夜间」，
              而且色块本身就把主题颜色画出来了（白底黑字 / 米底棕字 / 深底白字）。
              桌面侧栏有空间，那边仍然写着「主题」两个字（见 features/outline/OutlineTree.jsx）。
            */}
            <div
              className="flex items-center gap-2 px-3 shrink-0 border-b"
              style={{ height: 48, borderColor: 'var(--mf-hairline)' }}
            >
              <span className="text-[13.5px] font-medium shrink-0" style={{ color: 'var(--mf-ink)' }}>大纲</span>
              <div className="flex-1 min-w-0" />
              <div data-theme-row data-embedded="true" data-placement="header" className="flex items-center shrink-0">
                <ThemeCubes theme={theme} onTheme={setTheme} embedded />
              </div>
              <button
                data-drawer-close
                type="button"
                onClick={closeDrawer}
                aria-label="关闭大纲"
                title="关闭大纲"
                className="grid place-items-center rounded-xl border shrink-0"
                style={{ width: 44, height: 36, background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)', color: 'var(--mf-ink)' }}
              >
                <CloseIcon size={18} strokeWidth={1.6} />
              </button>
            </div>

            {/* 下方：常规文件夹大纲树（复用同一个组件，embedded 模式）
                `theme`/`onTheme` 仍然传：色块由上面这条抽屉头渲染（手机端的左侧栏头），
                组件本身在 embedded 下不再重复画一遍 —— 「搬过去」不是「复制一份」。 */}
            <div className="flex-1 min-h-0">
              <OutlineTree
                embedded
                open
                pinned={false}
                theme={theme}
                onTheme={setTheme}
                doc={doc}
                docs={docs}
                folders={folders}
                activeDocId={activeId}
                onOpenDoc={(id) => { openDoc(id); closeDrawer() }}
                onNewDoc={() => createDoc(null, `未命名导图 ${docs.length + 1}`)}
                onRenameDoc={renameDoc}
                onDeleteDoc={deleteDoc}
                onSelectNode={(id) => { setSelectedId(id); closeDrawer() }}
                onLocateNode={(id) => { jumpTo(id); closeDrawer() }}
                onSearchJump={(id) => { jumpTo(id); closeDrawer() }}
                onPin={() => {}}
                onCreateFolder={createFolder}
                onRenameFolder={renameFolder}
                onDeleteFolder={deleteFolder}
                onMoveDoc={moveDoc}
              />
            </div>
          </aside>
        </>
      )}

      {/* ---------- 隐藏式左侧大纲（桌面端边缘感应，手机端不渲染） ---------- */}
      {/* 主题切换（第八轮）就在这条侧栏头部的图钉左边：
          `theme` / `onTheme` 照旧传下去，色块由 OutlineTree 头部渲染（`!embedded`）。 */}
      {!compact && (
        <OutlineTree
          open={treeOpen || treePinned}
          pinned={treePinned}
          theme={theme}
          onTheme={setTheme}
          doc={doc}
          docs={docs}
          folders={folders}
          activeDocId={activeId}
          onOpenDoc={openDoc}
          onNewDoc={() => createDoc(null, `未命名导图 ${docs.length + 1}`)}
          onRenameDoc={renameDoc}
          onDeleteDoc={deleteDoc}
          onSelectNode={setSelectedId}
          onLocateNode={jumpTo}
          onSearchJump={jumpTo}
          onPin={() => { setTreePinned((v) => !v); }}
          onCreateFolder={createFolder}
          onRenameFolder={renameFolder}
          onDeleteFolder={deleteFolder}
          onMoveDoc={moveDoc}
        />
      )}

      {/* ---------- 画布 ---------- */}
      <Canvas
        root={doc.root}
        selectedId={selectedId}
        editingId={editingId}
        radarMode={radar}
        view={doc.view}
        onViewChange={(v) => updateDoc({ view: v })}
        onSelect={setSelectedId}
        onToggleCollapse={toggleCollapse}
        onOpenFold={openFold}
        onStartEdit={setEditingId}
        onCommitEdit={commitEdit}
        onContextMenu={(e, node) => setCtxMenu({ x: e.clientX, y: e.clientY, node })}
        onDropNode={dropNode}
        canvasApiRef={canvasApi}
        fitToken={fitToken}
        relations={doc.relations || []}
        linkMode={linkMode}
        onLinkPick={pickLinkTarget}
        onLinkCancel={cancelLink}
        mobile={compact}
        onLongPress={openNodeMenuAt}
        onViewGestureStart={closeCanvasMenu}
      />

      {/* ---------- 左下角悬浮控制条（极简，不抢留白） ---------- */}
      {/*
        手机端必须换一套排布，否则真的会用不了：
        11 颗 28px 的按钮排成一行是 389px 宽，右边界到 401px ——
        iPhone SE(375) 溢出 26px、iPhone 14 Pro(393) 溢出 8px，
        最后一颗「导出 PDF」整个跑到屏幕外；
        而且它会和右下角那条「N 个折角 · 导入 · 导出 MD · 备份」直接叠在一起
        （两条都是 fixed + bottom-3，右组更靠后所以画在上面）。
        这是**本来就存在**的问题，只是加了撤销/重做之后更明显。

        手机端的解法：
          · 主行铺满宽度（left-3 right-3 + justify-between），7 颗按钮分到全宽
          · 按钮放大到 40px —— 触摸热区 28px 太小了（WCAG 建议 44px）
          · 次要动作（卡片/历史/回收站/导出×3/备份/导入）收进「更多」面板
          · 右下角那条信息整条隐藏，它的内容（折角数）挪进面板顶部
      */}
      <div
        data-bottom-toolbar
        data-compact={compact ? 'true' : undefined}
        className={[
          'fixed z-[55] flex items-center mf-fixed-bottom mf-fixed-left',
          compact ? 'right-3 justify-between' : 'gap-1.5',
        ].join(' ')}
      >
        {/*
          手机端图标统一走 Lucide SVG（size 24 / strokeWidth 1.5）。
          桌面端保持原来的字符（⊙ ＋ − ◎ …）—— 那边有鼠标、字号也小，
          字符排版更紧凑，改成 SVG 反而会让 28px 的按钮显得空。
          所以下面每一处都用 `compact ?` 分支，桌面端 markup 一个字没变。
        */}
        <FlatBtn data-tool="center" big={compact} onClick={() => canvasApi.current?.center()} title="一键居中 (Ctrl+0)">
          {compact ? <CrosshairIcon size={24} strokeWidth={1.5} /> : '⊙'}
        </FlatBtn>
        <FlatBtn data-tool="zoom-in" big={compact} onClick={() => canvasApi.current?.zoomBy(1.2)} title="放大">
          {compact ? <PlusIcon size={24} strokeWidth={1.5} /> : '＋'}
        </FlatBtn>
        <FlatBtn data-tool="zoom-out" big={compact} onClick={() => canvasApi.current?.zoomBy(1 / 1.2)} title="缩小">
          {compact ? <MinusIcon size={24} strokeWidth={1.5} /> : '−'}
        </FlatBtn>
        {!compact && <span className="w-px h-5" style={{ background: 'var(--mf-hairline)' }} />}
        {/* 主画布专属的撤销 / 重做：和弹窗里那套互不干扰 */}
        <HistoryBtn data-tool="undo" big={compact} onClick={handleCanvasUndo} disabled={!canvasHist.canUndo} title="撤销 (Ctrl+Z)" />
        <HistoryBtn data-tool="redo" big={compact} onClick={handleCanvasRedo} disabled={!canvasHist.canRedo} title="重做 (Ctrl+Shift+Z)" redo />
        {!compact && <span className="w-px h-5" style={{ background: 'var(--mf-hairline)' }} />}
        <FlatBtn data-tool="radar" big={compact} onClick={() => setRadar((v) => !v)} active={radar} title="雷达复习模式">
          {compact ? <RadarIcon size={24} strokeWidth={1.5} /> : '◎'}
        </FlatBtn>
        {/*
          【这里原来有一颗「指向同一结果」按钮，已删除】
          用户原话：「无论是电脑端还是手机端 底部的指向同一结果去掉 太多余了」。

          它是多余的：同一个功能在**两端的右键/长按菜单里都有**
          （ContextMenu.tsx 的 `data-menu-item="point-merge"`，手机长按节点
          也会弹出它）。底栏那一颗既不比菜单方便（菜单是「对着哪个节点操作」
          就有哪个节点的入口，底栏还得先选中一个），又白占一颗常驻按钮的宽度
          —— 手机端底栏本来就只有 390px 可用。

          「指向」本身没有底栏入口（桌面走右键、手机走长按），
          所以删掉这颗按钮不会让任何一端失去能力。
        */}
        {!compact && <FlatBtn data-tool="cards" onClick={() => setCards(true)} title={`卡片复习 (${foldsTotal} 个折角)`}>▤</FlatBtn>}
        {!compact && <span className="w-px h-5" style={{ background: 'var(--mf-hairline)' }} />}
        {!compact && <FlatBtn data-tool="history" onClick={() => setShowHistory((v) => !v)} title={`历史版本（最近 ${HISTORY_LIMIT} 个）`}>↺</FlatBtn>}
        {!compact && <FlatBtn data-tool="trash" onClick={() => { setTrash(store.getTrash()); setShowTrash((v) => !v) }} title="回收站"><TrashIcon size={16} /></FlatBtn>}
        {!compact && <FlatBtn data-tool="export-html" onClick={doExportHtml} title="导出离线单文件 HTML">⇩</FlatBtn>}
        {!compact && <FlatBtn data-tool="export-pdf" onClick={doExportPdf} title="导出 PDF（导图 + 流程图，纯白）">⎙</FlatBtn>}
        {compact && (
          <FlatBtn
            data-tool="more"
            big
            active={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
            title="更多"
          >
            <MoreHorizontalIcon size={24} strokeWidth={1.5} />
          </FlatBtn>
        )}

        {/* ---------- 手机端「更多」面板（向上展开） ---------- */}
        {compact && moreOpen && (
          <div
            data-more-sheet
            className="absolute bottom-full left-0 right-0 mb-2 mf-more-sheet rounded-2xl border shadow-pop mf-fade"
            style={{ background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)' }}
          >
            {/* 这一行原来是右下角那条信息里的内容，手机上挪进来 */}
            <div
              className="border-b px-4 py-2 text-[11.5px]"
              style={{ borderColor: 'var(--mf-hairline)', color: 'var(--mf-muted)' }}
            >
              {foldsTotal} 个折角
            </div>
            <div className="p-1.5">
              {/*
                【为什么「导出」从三行变成一行】
                这里原来是「导出离线 HTML / 导出 PDF / 导出 Markdown」三行。
                格式扩到六个之后再照这个写法摊开就是八行，手机上一个面板占掉
                大半屏。现在收成一行「导出…」，点开是 ExportSheet（六个格式
                各有说明），面板本身从 8 行缩回 6 行。

                【为什么每行多了一句小字说明】
                用户原话「顶部标签页有点太乱了」，同一轮里把面板做得更清楚：
                「卡片复习」到底复习什么、「导出…」到底能导出什么，写一句
                10 个字的说明比让用户点进去试一遍便宜得多。
              */}
              {[
                ['卡片复习', '按折角翻卡自测', () => setCards(true)],
                ['历史版本', `最近 ${HISTORY_LIMIT} 个自动快照`, () => setShowHistory((v) => !v)],
                ['回收站', '删除的文档还能恢复', () => { setTrash(store.getTrash()); setShowTrash((v) => !v) }],
                ['导出', 'Markdown / HTML / OPML / FreeMind / JSON / PDF', () => setExportOpen(true)],
                ['整库备份', '把全部文档导出成一个 JSON', doBackup],
              ].map(([label, hint, fn]) => (
                <button
                  key={label}
                  data-more-item={label}
                  onClick={() => { setMoreOpen(false); fn() }}
                  className="flex w-full items-center rounded-xl px-3 text-left transition-colors"
                  style={{ minHeight: 52, color: 'var(--mf-ink)' }}
                  onTouchStart={(e) => { e.currentTarget.style.background = 'var(--mf-faint)' }}
                  onTouchEnd={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-[13.5px]">{label}</span>
                    <span className="block truncate text-[11px] mt-0.5" style={{ color: 'var(--mf-muted)' }}>{hint}</span>
                  </span>
                </button>
              ))}
              {/*
                【导入为什么不用 <label for>，而是按钮 + input.click()】
                原来是 `<label htmlFor="mf-import-file" onClick={() => setMoreOpen(false)}>`。
                实测（探针在隐藏 input 上挂 click 计数器）：
                  手机端点「导入 Markdown / 备份」→ input 收到 click **0 次**
                  桌面端点右下角那个 label（**没有** onClick）→ input 收到 click 1 次
                差别就在那个 onClick：label 的转发是**默认行为**，发生在事件派发
                结束之后；而 React 在 onClick 里 setMoreOpen(false) 会当场把整个
                「更多」面板连这个 label 一起卸载。label 一旦脱离文档，
                `label.control` 就查不到目标了（它按 for 在自己的树里找），
                转发随之取消 —— 于是手机端导入点了完全没反应。
                桌面端能导入，只是因为它走的是另一个 label（右下角那条，没有 onClick）。
                改成按钮 + 直接调 input.click()：不依赖 label 语义、不依赖卸载时序，
                隐藏 input 本身在面板**外面**（见下面），不会被卸载。
              */}
              <button
                type="button"
                data-more-item="导入"
                onClick={() => { setMoreOpen(false); importInputRef.current?.click() }}
                className="flex w-full items-center rounded-xl px-3 text-left transition-colors"
                style={{ minHeight: 52, color: 'var(--mf-ink)' }}
                onTouchStart={(e) => { e.currentTarget.style.background = 'var(--mf-faint)' }}
                onTouchEnd={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-[13.5px]">导入</span>
                  <span className="block truncate text-[11px] mt-0.5" style={{ color: 'var(--mf-muted)' }}>
                    Markdown / 大纲 / OPML / FreeMind / HTML / JSON
                  </span>
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ---------- 折角计数 + 导入（宽屏才显示；手机上内容已挪进「更多」面板） ---------- */}
      {!compact && (
        <div className="fixed right-4 z-[55] flex items-center gap-2 text-[11.5px] mf-fixed-bottom" style={{ color: 'var(--mf-muted)' }}>
          <span>{foldsTotal} 个折角</span>
          <span className="opacity-40">·</span>
          {/*
            桌面端这一颗原来也是 <label for>，能工作（这里没有 onClick 去卸载它），
            但改成和手机端同一套「按钮 + input.click()」：两端共用一条代码路径，
            将来谁再给这个元素加个 onClick 都不会又把它点死。
          */}
          <button
            className="hover:opacity-70"
            data-import-trigger="desktop"
            title="导入 Markdown / 纯文本大纲 / OPML / FreeMind / HTML / JSON"
            onClick={() => importInputRef.current?.click()}
          >
            导入
          </button>
          <span className="opacity-40">·</span>
          <button className="hover:opacity-70" onClick={doExportMd} title="导出 Markdown">导出 MD</button>
          <span className="opacity-40">·</span>
          {/*
            多格式导出的入口。**这是本轮唯一新增的桌面端元素** —— 不把原来那几颗
            按钮改语义（⇩ 仍然一键导离线 HTML、⎙ 仍然一键开打印视图、
            「导出 MD」仍然一键落 .md），只是多一个「其余格式都在这儿」的入口。
            这样「习惯了的操作手感」和「新格式」不是二选一。
          */}
          <button
            className="hover:opacity-70"
            data-export-open="desktop"
            title="导出其他格式（OPML / FreeMind / JSON / PDF…）"
            onClick={() => setExportOpen(true)}
          >
            导出…
          </button>
          <span className="opacity-40">·</span>
          <button className="hover:opacity-70" onClick={doBackup} title="整库备份">备份</button>
        </div>
      )}

      {/*
        导入用的文件输入：桌面端和手机端共用同一个，提到「更多」面板外面 ——
        面板一关就会卸载子树，input 留在里面的话点击时序稍有变化就又失效。
        用 ref 直接 click()，不再依赖 label 的转发。

        accept 里为什么除了扩展名还要写 MIME 类型？
        ------------------------------------------------
        Capacitor 8.5.2 的 BridgeWebChromeClient.showFilePicker / getValidTypes
        （node_modules/@capacitor/android/.../BridgeWebChromeClient.java:375-424）
        会把 `accept` 原样交给安卓：
          · 扩展名走 `MimeTypeMap.getMimeTypeFromExtension()` 转 MIME，
            转不出来的**直接丢掉** —— 而安卓的 MimeTypeMap 不认识 md / markdown，
            只认出 .txt→text/plain、.json→application/json；
          · 于是 EXTRA_MIME_TYPES 只剩 [text/plain, application/json]，
            而 .md 文件在安卓上的 MIME 是 text/markdown（API 29+）或
            application/octet-stream —— 系统文件选择器按 MIME 过滤时
            **把 .md 整个置灰/隐藏**，用户根本选不中，导入自然「不行」。
        所以显式把 text/markdown、text/x-markdown 也列进来，让它们原样进入
        EXTRA_MIME_TYPES（该分支对非「.」开头的字符串是直接收录的）。
        桌面浏览器按扩展名过滤，多出来的 MIME 类型不影响行为。

        【本轮扩展格式后同样要补 MIME】
        新加的 .opml / .xml / .mm / .html 在安卓的 MimeTypeMap 里同样认不全
        （`.mm` 根本不认识、`.opml` 也不认识），只写扩展名 = 这几个格式在手机上
        再次「选不中」。所以 MIME 一并列出来，清单统一放在 formats.js 里
        （IMPORT_EXTENSIONS / IMPORT_MIME）—— 加格式时只改一处。
      */}
      <input
        ref={importInputRef}
        id="mf-import-file"
        type="file"
        accept={[...IMPORT_EXTENSIONS, ...IMPORT_MIME].join(',')}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) doImportFile(f); e.target.value = '' }}
      />

      {/* ---------- 搜索浮层 (Ctrl+F) ---------- */}
      {searchOpen && (
        <div className="fixed left-1/2 -translate-x-1/2 z-[75] w-[420px] max-w-[92vw] mf-fixed-top">
          <div
            className="rounded-2xl border shadow-pop overflow-hidden mf-fade"
            style={{ background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)' }}
          >
            <div className="flex items-center gap-2 px-3 h-10">
              <span style={{ color: 'var(--mf-muted)' }}>⌕</span>
              <input
                ref={searchRef}
                value={quickFind}
                onChange={(e) => setQuickFind(e.target.value)}
                placeholder="搜索节点文字…"
                className="flex-1 bg-transparent outline-none text-[13px]"
                style={{ color: 'var(--mf-ink)' }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter' && findMatches[0]) jumpTo(findMatches[0].id)
                  if (e.key === 'Escape') setSearchOpen(false)
                }}
              />
              <span className="text-[11px]" style={{ color: 'var(--mf-muted)' }}>{findMatches.length} 个结果</span>
            </div>
            {findMatches.length > 0 && (
              <div className="max-h-[280px] overflow-auto mf-scroll border-t" style={{ borderColor: 'var(--mf-hairline)' }}>
                {findMatches.slice(0, 40).map((n) => (
                  <button
                    key={n.id}
                    onClick={() => jumpTo(n.id)}
                    className="w-full text-left px-3 py-2 text-[12.5px] flex items-center gap-2 transition-colors"
                    style={{ color: 'var(--mf-ink)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mf-faint)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <span className="truncate flex-1">{n.text}</span>
                    {n.fold && <span className="text-[10px] shrink-0" style={{ color: 'var(--mf-accent)' }}>折角</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------- 历史版本面板 ---------- */}
      {/*
        【位置为什么不能写死 left-3 / bottom-14】
        实测（探针把安全区置成刘海屏量级 47/34，竖屏 390×844）：
          · 底栏容器上缘在 758，而面板底边固定在 H-56 = 788
            → **与底栏重叠 300×30px**，面板最下面一条被底栏压住。
            原因：底栏是 `12px + 安全区` 起算的，安全区 34px 时它整体上移，
            而面板还钉在 56px 这个「按桌面端算出来的」位置。
          · 横屏侧边安全区 34px 时，left-3（12px）→ 面板左边压进刘海 22px。
        所以两边都跟着同一份变量走：底边 = 底栏底边 + 底栏高 40px + 间隙 4px，
        左侧 = 12px + 侧边安全区。桌面端安全区全是 0 → 仍是 12px / 56px，
        和改之前逐像素一致。
      */}
      {showHistory && (
        <div
          className="fixed z-[75] w-[300px] rounded-2xl border shadow-pop overflow-hidden mf-fade"
          style={{
            left: 'calc(12px + var(--mf-safe-l))',
            bottom: 'calc(var(--mf-bottom-gap) + 44px)',
            background: 'var(--mf-panel)',
            borderColor: 'var(--mf-hairline)',
          }}
        >
          <div className="flex items-center px-3 h-9 border-b text-[12px]" style={{ borderColor: 'var(--mf-hairline)', color: 'var(--mf-muted)' }}>
            <span>历史版本</span>
            <div className="flex-1" />
            <button onClick={() => setShowHistory(false)}>✕</button>
          </div>
          <div className="max-h-[260px] overflow-auto mf-scroll p-1.5">
            {history.length === 0 && (
              <div className="px-2 py-4 text-[11.5px] text-center" style={{ color: 'var(--mf-muted)' }}>
                还没有历史版本
              </div>
            )}
            {history.map((h, i) => (
              <button
                key={h.at + '' + i}
                onClick={() => restoreHistory(h)}
                className="w-full text-left px-2.5 py-2 rounded-lg text-[12px] flex items-center gap-2"
                style={{ color: 'var(--mf-ink)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mf-faint)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <span className="flex-1">{new Date(h.at).toLocaleString()}</span>
                <span className="text-[10px]" style={{ color: 'var(--mf-muted)' }}>{i === 0 ? '最新' : `-${i}`}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ---------- 回收站面板（位置规则同历史版本，见上面的注释） ---------- */}
      {showTrash && (
        <div
          className="fixed z-[75] w-[300px] rounded-2xl border shadow-pop overflow-hidden mf-fade"
          style={{
            left: 'calc(12px + var(--mf-safe-l))',
            bottom: 'calc(var(--mf-bottom-gap) + 44px)',
            background: 'var(--mf-panel)',
            borderColor: 'var(--mf-hairline)',
          }}
        >
          <div className="flex items-center px-3 h-9 border-b text-[12px]" style={{ borderColor: 'var(--mf-hairline)', color: 'var(--mf-muted)' }}>
            <span>回收站</span>
            <span className="ml-1 opacity-60">{trash.length}</span>
            <div className="flex-1" />
            {trash.length > 0 && (
              <button
                className="mr-2 hover:opacity-70"
                onClick={() => {
                  setConfirm({
                    title: '清空回收站',
                    body: `将永久删除 ${trash.length} 份文档，无法恢复。确定继续？`,
                    danger: true,
                    onOk: () => { store.emptyTrash(); setTrash([]); say('回收站已清空') },
                  })
                }}
              >
                清空
              </button>
            )}
            <button onClick={() => setShowTrash(false)}>✕</button>
          </div>
          <div className="max-h-[260px] overflow-auto mf-scroll p-1.5">
            {trash.length === 0 && (
              <div className="px-2 py-4 text-[11.5px] text-center" style={{ color: 'var(--mf-muted)' }}>
                回收站是空的
              </div>
            )}
            {trash.map((t, i) => (
              <div
                key={t.doc.id + '' + t.deletedAt}
                className="px-2.5 py-2 rounded-lg text-[12px] flex items-center gap-2"
                style={{ color: 'var(--mf-ink)' }}
              >
                <span className="truncate flex-1">{t.doc.name}</span>
                <span className="text-[10px] shrink-0" style={{ color: 'var(--mf-muted)' }}>
                  {new Date(t.deletedAt).toLocaleDateString()}
                </span>
                <button
                  onClick={() => restoreTrash(i)}
                  className="text-[11px] shrink-0 hover:opacity-70"
                  style={{ color: 'var(--mf-accent)' }}
                >
                  恢复
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------- 雷达模式 HUD ---------- */}
      {radar && (
        <RadarHud
          doc={doc}
          compact={compact}
          onExit={() => setRadar(false)}
          onNext={() => {
            const folds = collectFolds(doc.root)
            if (!folds.length) return
            const idx = folds.findIndex((f) => f.node.id === selectedId)
            jumpTo(folds[(idx + 1) % folds.length].node.id)
          }}
        />
      )}

      {/* ---------- 卡片复习模式 ---------- */}
      {cards && (
        <CardReview
          doc={doc}
          theme={theme}
          onExit={() => setCards(false)}
          onOpenFold={(id) => { setCards(false); openFold(id) }}
        />
      )}

      {/*
        汇聚节点的悬浮改名框。
        放在画布之上、右键菜单之下：它是个轻量的即时输入，
        不该盖住用户主动唤起的菜单。
      */}
      {renameTarget && (
        <FloatingRename
          target={renameTarget}
          canvasApi={canvasApi}
          view={doc.view}
          onCommit={commitRename}
          onCancel={cancelRename}
        />
      )}

      {/* ---------- 右键菜单 ---------- */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          node={ctxMenu.node}
          onClose={() => setCtxMenu(null)}
          actions={{
            isRoot: !findParent(doc.root, ctxMenu.node.id),
            addChild, addSibling, remove: removeNode,
            addFold, removeFold, openFold,
            toggleBold, toggleItalic,
            rename: (id) => setEditingId(id),
            // 两个连线入口共用同一套待选状态，只有 kind 不同
            startLink: (id) => startLink(id, 'point'),
            startMerge: (id) => startLink(id, 'merge'),
          }}
          linkDisabled={!!linkMode}
        />
      )}

      {/* ---------- 全屏折角弹窗 ---------- */}
      {foldModal && modalNode && (
        <FoldModal
          node={modalNode}
          origin={foldModal.origin}
          onClose={() => {
            // 弹窗里的自动保存是 1s 防抖，关闭时必须先冲出去，否则最后一句改动会丢
            flushPending()
            setFoldModal(null)
          }}
          onSave={saveFoldContent}
          onResetFamiliarity={resetFamiliarity}
        />
      )}

      {/* ---------- 导出格式面板（桌面居中卡片 / 手机底部面板，同一个组件） ---------- */}
      {exportOpen && (
        <ExportSheet
          compact={compact}
          name={doc.name}
          formats={DOC_EXPORT_FORMATS}
          onPick={runExport}
          onClose={() => setExportOpen(false)}
        />
      )}

      {/* ---------- 确认弹窗 ---------- */}
      {confirm && (
        <Confirm
          {...confirm}
          onCancel={() => setConfirm(null)}
          onOk={() => { confirm.onOk?.(); setConfirm(null) }}
        />
      )}

      {/* ---------- Toast ---------- */}
      {/*
        提示条的位置必须避开两样东西：系统手势条（安全区）和手机端底部工具栏。
        原来是写死的 `bottom-16`（64px）—— 桌面端刚好，但手机上底栏是
        `12px + 安全区` 起算的：刘海屏（安全区 34px）下底栏顶边在 H-86，
        而提示条底边固定在 H-64，**压住底栏上半截 22px**。
        改成跟着同一个变量走：底栏高 40px + 留 16px 间隙。
        另外手机端要夹一下最大宽度，否则一句长提示（比如「安卓应用内无法
        保存文件…」）会把 375px 的视口撑出横向滚动。
      */}
      {toast && (
        <div
          data-app-toast
          className="fixed left-1/2 -translate-x-1/2 z-[110] px-4 py-2 rounded-xl border shadow-card text-[12.5px] text-center mf-fade"
          style={{
            bottom: 'calc(var(--mf-bottom-gap) + 56px)',
            maxWidth: 'min(560px, calc(100vw - 24px))',
            background: 'var(--mf-panel)',
            borderColor: toast.kind === 'error' ? '#ef4444' : 'var(--mf-hairline)',
            color: toast.kind === 'error' ? '#ef4444' : 'var(--mf-ink)',
          }}
        >
          {toast.msg}
        </div>
      )}

      {/* 顶部边缘感应条：鼠标贴上来就滑出标签栏 */}
      <div className="fixed top-0 left-0 right-0 h-[5px] z-[59]" />
    </div>
  )
}
