import React, { useMemo, useState, useRef, useEffect } from 'react'
import { FoldDot } from '../../components/FoldCorner'
import { FolderIcon, SearchIcon, CloseIcon, PinIcon } from '../../components/icons'
import ThemeCubes from '../../components/ThemeCubes'
import { collectFolds, countTree } from '../../lib/model'
import { clampToSafeViewport } from '../../lib/hooks'

/**
 * 左侧大纲树（隐藏式）
 * ====================
 * · 默认隐藏，鼠标滑到屏幕最左侧边缘滑出（**仅桌面端**）
 * · 「小图钉」按钮锁定后常显
 * · 右键菜单：新建文件 / 新建文件夹 / 重命名
 * · 顶部搜索框：过滤节点，命中折角优先
 *
 * `embedded`（手机端抽屉里用）：
 *   · 不再自己 fixed + 滑入，改成撑满父容器 —— 位置由抽屉决定
 *   · 隐藏「图钉」（手机端没有边缘感应，钉住没有意义）
 *   · 隐藏自带文档列表 —— 抽屉顶部已经有一条 50px 的多标签切换区，
 *     两份文档列表在 80% 宽的抽屉里既挤又容易点错
 * 默认 false，**桌面端行为完全不变**。
 *
 * 【主题切换为什么在这里（第八轮：从顶部标签栏搬进左侧栏头部）】
 * 用户原话：「改变主题的图案很大 能不能换到左侧栏里面 这样就有空间了」，
 * 接着又给了落点：「放到左侧栏里面的固定按钮左边就行 移动端也是」。
 * 那三颗色块原来占着顶部标签栏的右半截，标签一多就被挤到横向滚动；
 * 搬进侧栏之后，顶部那条只剩「标签 + ＋ + 图钉/✕」，标签能多显好几颗。
 * 第八轮它没有单占侧栏底部一整行，而是横着并进头部那一行、紧挨图钉左边：
 * 桌面侧栏和手机抽屉是**同一个组件的同一套语义**（手机抽屉头在 app/App.jsx，
 * 色块同样在「固定按钮」（那颗 ✕）左边）—— 两边一次到位，测试各钉一遍。
 */
export default function OutlineTree({
  open,
  pinned,
  doc,
  docs,
  activeDocId,
  folders,
  onOpenDoc,
  onNewDoc,
  onRenameDoc,
  onDeleteDoc,
  onSelectNode,
  onLocateNode,
  onPin,
  onSearchJump,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveDoc,
  theme,
  onTheme,
  embedded = false,
}) {
  const [q, setQ] = useState('')
  const [ctx, setCtx] = useState(null)   // { x, y, kind, id }
  const [renaming, setRenaming] = useState(null)      // 正在重命名的 docId
  const [renamingFolder, setRenamingFolder] = useState(null)
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set())
  const [filter, setFilter] = useState('all') // all | fold

  /** 按 folderId 分组：文件夹在前，未分类殿后 */
  const grouped = useMemo(() => {
    const byFolder = new Map(folders.map((f) => [f.id, []]))
    const loose = []
    for (const d of docs) {
      if (d.folderId && byFolder.has(d.folderId)) byFolder.get(d.folderId).push(d)
      else loose.push(d)
    }
    return { byFolder, loose }
  }, [docs, folders])

  const toggleFolder = (id) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  /* ---------- 搜索 ---------- */
  const results = useMemo(() => {
    if (!doc) return []
    const out = []
    const walk = (n, depth, path) => {
      const hit = !q || n.text.toLowerCase().includes(q.toLowerCase())
      if (hit) out.push({ node: n, depth, path })
      for (const c of n.children) walk(c, depth + 1, [...path, n.text])
    }
    walk(doc.root, 0, [])
    return out
  }, [doc, q])

  const folds = useMemo(() => (doc ? collectFolds(doc.root) : []), [doc])

  const shown = useMemo(() => {
    if (filter === 'fold') {
      const ids = new Set(folds.map((f) => f.node.id))
      return results.filter((r) => ids.has(r.node.id))
    }
    return results
  }, [results, filter, folds])

  return (
    <aside
      data-outline-tree
      data-embedded={embedded ? 'true' : undefined}
      className={embedded
        ? 'flex h-full w-full flex-col'
        : `mf-slide-left mf-safe-top fixed top-0 bottom-0 left-0 z-[70] w-[268px] flex flex-col ${open ? 'open' : ''}`}
      style={embedded
        ? { background: 'var(--mf-panel)' }
        : { background: 'var(--mf-panel)', borderRight: '1px solid var(--mf-hairline)' }}
    >
      {/* ---------- 头部 ---------- */}
      {/*
        ★ 第八轮：主题三色块就在这一行的**图钉左边**。
        用户原话：「改变主题的图案很大 能不能换到左侧栏里面 这样就有空间了」，
        随后又明确落点：「放到左侧栏里面的固定按钮左边就行 移动端也是」。
        所以它没有在侧栏底部另立一行（那会白吃掉 36/52px 的树高），
        而是横着并进这条 36px 头部：…「MindFold」 [主题 ▢▢▢] [图钉]。
        宽度核对：侧栏 268 − 左右各 12 = 244；左段 Logo16+gap8+「MindFold」≈62 = 86，
        右段「主题」≈25+gap6+三颗 24（gap 4×2=8）+gap6+图钉 24 = 93 ⇒ 86+93 = 179 < 244 有富余。
      */}
      <div className="flex items-center gap-2 px-3 h-9 shrink-0 border-b" style={{ borderColor: 'var(--mf-hairline)' }}>
        <Logo size={16} />
        <span className="text-[12.5px] font-medium">MindFold</span>
        <div className="flex-1 min-w-0" />
        {/* 手机端（embedded）不在这里渲染：它的左侧栏是 App 那条抽屉头，
            「固定按钮」是那颗 ✕ —— 色块在那里、同样在它左边，见 app/App.jsx。 */}
        {!embedded && (
          <div data-theme-row data-placement="header" className="flex items-center gap-1.5 shrink-0">
            <span className="text-[11.5px] shrink-0" style={{ color: 'var(--mf-muted)' }}>主题</span>
            <ThemeCubes theme={theme} onTheme={onTheme} />
          </div>
        )}
        {/* 图钉只在桌面端有意义：手机端已经改成显式汉堡按钮 */}
        {!embedded && (
          <button
            onClick={onPin}
            data-pin-tree
            data-pinned={pinned ? 'true' : undefined}
            className="w-6 h-6 rounded flex items-center justify-center shrink-0"
            style={{ color: pinned ? 'var(--mf-accent)' : 'var(--mf-muted)' }}
            title={pinned ? '取消常显' : '常显大纲'}
            aria-label={pinned ? '取消常显大纲' : '常显大纲'}
          >
            {/* 实心 = 已钉住，空心 = 未钉住（替代原来的 📌 / 📍） */}
            <PinIcon size={13} filled={pinned} />
          </button>
        )}
      </div>

      {/* ---------- 搜索 ---------- */}
      <div className="px-3 py-2 shrink-0">
        <div
          className="flex items-center gap-2 px-2 h-7 rounded-lg border"
          style={{ borderColor: 'var(--mf-hairline)', background: 'var(--mf-faint)' }}
        >
          <SearchIcon size={14} strokeWidth={1.8} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索节点  (Ctrl+F)"
            className="flex-1 bg-transparent outline-none text-[12px]"
            style={{ color: 'var(--mf-ink)' }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && shown[0]) onSearchJump?.(shown[0].node.id)
            }}
          />
          {q && (
            <button onClick={() => setQ('')} style={{ color: 'var(--mf-muted)' }} aria-label="清空搜索"><CloseIcon size={13} strokeWidth={1.8} /></button>
          )}
        </div>

        {/* 过滤器 */}
        <div className="flex items-center gap-1 mt-2">
          {[['all', '全部'], ['fold', `仅折角 ${folds.length}`]].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className="px-2 py-0.5 rounded-md text-[11px] transition-colors"
              style={{
                background: filter === k ? 'var(--mf-faint)' : 'transparent',
                color: filter === k ? 'var(--mf-ink)' : 'var(--mf-muted)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ---------- 节点树 ---------- */}
      <div className="flex-1 min-h-0 overflow-auto mf-scroll px-1.5 pb-2">
        {shown.length === 0 && (
          <div className="px-3 py-6 text-[11.5px] text-center" style={{ color: 'var(--mf-muted)' }}>
            {q ? '没有匹配的节点' : '这个文档还没有节点'}
          </div>
        )}
        {shown.map(({ node, depth }) => (
          <div
            key={node.id}
            onClick={() => onSelectNode?.(node.id)}
            onDoubleClick={() => onLocateNode?.(node.id)}
            className="flex items-center gap-1.5 px-2 py-[5px] rounded-md text-[12px] cursor-pointer transition-colors group"
            style={{ paddingLeft: 8 + Math.min(depth, 8) * 11, color: 'var(--mf-ink)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mf-faint)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            title="双击定位到画布"
          >
            <span className="truncate flex-1" style={{ fontWeight: node.bold ? 600 : 400, fontStyle: node.italic ? 'italic' : 'normal' }}>
              {node.text}
            </span>
            {node.fold && <FoldDot fold={node.fold} />}
            {node.fold && (
              <span className="text-[9.5px] tabular-nums shrink-0" style={{ color: 'var(--mf-muted)' }}>
                {node.fold.openCount}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* ---------- 文档列表（按文件夹分组）----------
          手机端抽屉里隐藏：抽屉顶部那条 50px 多标签切换区已经承担了「换文档」，
          再放一份分组列表在 80% 宽的抽屉里既挤又容易点错。 */}
      {!embedded && (
      <div className="shrink-0 border-t" style={{ borderColor: 'var(--mf-hairline)' }}>
        <div
          className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
          style={{ color: 'var(--mf-muted)' }}
          onContextMenu={(e) => {
            e.preventDefault()
            setCtx({ x: e.clientX, y: e.clientY, kind: 'blank', id: null })
          }}
        >
          <span>文档</span>
          <span className="opacity-60">{docs.length}</span>
          <div className="flex-1" />
          <button onClick={() => onNewDoc?.()} className="hover:opacity-70" title="新建文档">+ 新建</button>
        </div>

        <div className="max-h-[200px] overflow-auto mf-scroll px-1.5 pb-2">
          {/* 文件夹分组 */}
          {folders.map((f) => {
            const items = grouped.byFolder.get(f.id) || []
            const collapsed = collapsedFolders.has(f.id)
            const hasActive = items.some((d) => d.id === activeDocId)
            return (
              <div key={f.id}>
                <div
                  data-folder-id={f.id}
                  onClick={() => toggleFolder(f.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setCtx({ x: e.clientX, y: e.clientY, kind: 'folder', id: f.id })
                  }}
                  className="flex items-center gap-1.5 px-2 py-[5px] rounded-md text-[12px] cursor-pointer"
                  style={{ color: hasActive ? 'var(--mf-ink)' : 'var(--mf-muted)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mf-faint)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  <span className="text-[9px] w-2 shrink-0">{collapsed ? '▸' : '▾'}</span>
                  <span className="shrink-0" style={{ color: 'var(--mf-muted)' }}><FolderIcon size={14} strokeWidth={1.8} /></span>
                  {renamingFolder === f.id ? (
                    <input
                      autoFocus
                      defaultValue={f.name}
                      onClick={(e) => e.stopPropagation()}
                      // Enter 直接提交，不依赖 blur：
                      // blur 只在元素真的失焦时才触发，某些环境（如无焦点窗口）不可靠，
                      // 而「按回车确认」是用户明确的意图，应该直接落实。
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          onRenameFolder?.(f.id, e.currentTarget.value.trim() || f.name)
                          setRenamingFolder(null)
                        }
                        if (e.key === 'Escape') setRenamingFolder(null)
                      }}
                      // 点击别处时也提交
                      onBlur={(e) => {
                        onRenameFolder?.(f.id, e.target.value.trim() || f.name)
                        setRenamingFolder(null)
                      }}
                      className="flex-1 min-w-0 bg-transparent outline-none border-b text-[12px]"
                      style={{ borderColor: 'var(--mf-accent)', color: 'var(--mf-ink)' }}
                    />
                  ) : (
                    <>
                      <span className="truncate flex-1">{f.name}</span>
                      <span className="text-[10px] tabular-nums opacity-60">{items.length}</span>
                    </>
                  )}
                </div>
                {!collapsed && items.map((d) => renderDocRow(d, 1))}
              </div>
            )
          })}

          {/* 未分类 */}
          {grouped.loose.map((d) => renderDocRow(d, folders.length ? 1 : 0))}

          {docs.length === 0 && (
            <div className="px-2 py-3 text-[11.5px] text-center" style={{ color: 'var(--mf-muted)' }}>
              还没有文档
            </div>
          )}
        </div>
      </div>
      )}

      {/*
        主题切换现在在**上面头部那一行**（图钉左边），这里不再有底部横条 ——
        它一开始就并进了头部（没有「先生成一条底栏再搬走」这一步）：
        用户点名的是「固定按钮左边」，那样既不另占高度，也和大纲/图钉同属一族。
      */}

      {ctx && (
        <ContextMenuForTree
          ctx={ctx}
          folders={folders}
          docs={docs}
          onClose={() => setCtx(null)}
          actions={{
            newDoc: () => onNewDoc?.(),
            newFolder: () => { const f = onCreateFolder?.(); if (f) setRenamingFolder(f.id) },
            renameDoc: (id) => setRenaming(id),
            renameFolder: (id) => setRenamingFolder(id),
            deleteDoc: (id) => onDeleteDoc?.(id),
            deleteFolder: (id) => onDeleteFolder?.(id),
            moveDoc: (docId, folderId) => onMoveDoc?.(docId, folderId),
          }}
        />
      )}
    </aside>
  )

  /** 渲染一行文档；indent 为缩进层级（放进文件夹时缩进一格） */
  function renderDocRow(d, indent) {
    const active = d.id === activeDocId
    return (
      <div
        key={d.id}
        data-doc-id={d.id}
        onClick={() => onOpenDoc(d.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setCtx({ x: e.clientX, y: e.clientY, kind: 'doc', id: d.id })
        }}
        className="flex items-center gap-2 px-2 py-[5px] rounded-md text-[12px] cursor-pointer"
        style={{
          marginLeft: indent * 12,
          background: active ? 'var(--mf-faint)' : 'transparent',
          color: active ? 'var(--mf-ink)' : 'var(--mf-muted)',
        }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--mf-faint)' }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
      >
        {renaming === d.id ? (
          <input
            autoFocus
            defaultValue={d.name}
            onClick={(e) => e.stopPropagation()}
            // 同文件夹重命名：Enter 直接提交，不依赖 blur
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                onRenameDoc?.(d.id, e.currentTarget.value.trim() || d.name)
                setRenaming(null)
              }
              if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={(e) => {
              onRenameDoc?.(d.id, e.target.value.trim() || d.name)
              setRenaming(null)
            }}
            className="flex-1 min-w-0 bg-transparent outline-none border-b text-[12px]"
            style={{ borderColor: 'var(--mf-accent)', color: 'var(--mf-ink)' }}
          />
        ) : (
          <>
            <span className="truncate flex-1">{d.name}</span>
            <span className="text-[10px] tabular-nums opacity-60">{countTree(d.root) - 1}</span>
          </>
        )}
      </div>
    )
  }
}

/**
 * 大纲树里的右键菜单。
 * 三种上下文：空白处（新建文档/文件夹）、文件夹（重命名/删除/放入）、文档（重命名/移动/删除）。
 */
function ContextMenuForTree({ ctx, folders, docs, onClose, actions }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // 夹进可用视口：横屏侧边安全区 34px 时，贴左边缘弹出的菜单也压不进刘海
    const p = clampToSafeViewport(ctx.x, ctx.y, r.width, r.height, 8)
    el.style.left = `${p.left}px`
    el.style.top = `${p.top}px`
  }, [ctx])

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const row = (label, fn, opts = {}) => (
    <button
      key={label}
      disabled={opts.disabled}
      onClick={() => { fn(); onClose() }}
      className="w-full text-left px-3 py-[7px] rounded-md text-[12.5px] transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
      style={{ color: opts.danger ? '#ef4444' : 'var(--mf-ink)' }}
      onMouseEnter={(e) => { if (!opts.disabled) e.currentTarget.style.background = 'var(--mf-faint)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {label}
    </button>
  )
  const sep = <div className="my-1 h-px" style={{ background: 'var(--mf-hairline)' }} />

  const doc = ctx.kind === 'doc' ? docs.find((d) => d.id === ctx.id) : null

  return (
    <div
      ref={ref}
      className="fixed z-[90] min-w-[168px] rounded-xl border shadow-pop p-1 mf-fade"
      style={{ left: ctx.x, top: ctx.y, background: 'var(--mf-panel)', borderColor: 'var(--mf-hairline)' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {ctx.kind === 'blank' && (
        <>
          {row('新建文档', () => actions.newDoc())}
          {row('新建文件夹', () => actions.newFolder())}
        </>
      )}

      {ctx.kind === 'folder' && (
        <>
          {row('在此新建文档', () => actions.newDoc())}
          {row('重命名文件夹', () => actions.renameFolder(ctx.id))}
          {sep}
          {row('删除文件夹', () => actions.deleteFolder(ctx.id), { danger: true })}
        </>
      )}

      {ctx.kind === 'doc' && (
        <>
          {row('重命名', () => actions.renameDoc(ctx.id))}
          {folders.length > 0 && sep}
          {folders.length > 0 && (
            <div className="px-3 pt-1 pb-0.5 text-[10.5px]" style={{ color: 'var(--mf-muted)' }}>
              移动到
            </div>
          )}
          {folders.map((f) => row(
            (doc?.folderId === f.id ? '· ' : '') + f.name,
            () => actions.moveDoc(ctx.id, f.id),
            { disabled: doc?.folderId === f.id }
          ))}
          {doc?.folderId && row('移出文件夹', () => actions.moveDoc(ctx.id, null))}
          {sep}
          {row('删除文档', () => actions.deleteDoc(ctx.id), { danger: true })}
        </>
      )}
    </div>
  )
}

/**
 * Logo：字母 M，右上角是纸张折角
 */
export function Logo({ size = 22, onClick }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      {/* 纸张主体 */}
      <path
        d="M4 3 h11 l5 5 v13 a1 1 0 0 1 -1 1 H5 a1 1 0 0 1 -1 -1 V4 a1 1 0 0 1 1 -1 z"
        fill="none"
        stroke="var(--mf-ink)"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      {/* 右上角折角：纸张被折下来的样子 */}
      <path d="M15 3 v5 h5" fill="var(--mf-faint)" stroke="var(--mf-ink)" strokeWidth="1.7" strokeLinejoin="round" />
      {/* 字母 M */}
      <path
        d="M8 16.5 V10 l2.6 3.4 L13 10 v6.5"
        fill="none"
        stroke="var(--mf-ink)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
