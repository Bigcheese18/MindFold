import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cloneTree, uid, normalizeRelations } from '../lib/model'
import { store, fingerprint } from '../lib/store'
import { applyLargeImportDefault } from '../lib/treeOps'
import { bootstrap, newDocFromMd, newBlankDoc } from './bootstrap'

/**
 * 文档层：标签页 / 当前文档 / 防抖落盘 / 历史版本 / 回收站 / 文件夹 / 导入。
 *
 * 这是 App 里最大的一块逻辑，而且和「画布怎么画」完全无关，
 * 所以整体搬进一个 Hook —— App 只负责把它接到 UI 上。
 *
 * 【唯一的文档写入口是 updateDoc】
 * 持久化不能在 setDocs 的 updater 里做 —— React 严格模式会把 updater
 * 调用两次，副作用会跟着重复执行。所以这里在 updater 外面先算出新文档，
 * 再用 ref 同步推进，保证连续多次调用时都能拿到最新值。
 */
export function useDocuments({ say, setConfirm, requestFit, setSelectedId, setLinkMode, setRenameTarget }) {
  const [docs, setDocsState] = useState(() => [])
  const [tabIds, setTabIds] = useState(() => [])
  const [activeId, setActiveId] = useState(null)
  const [trash, setTrash] = useState([])
  const [folders, setFolders] = useState([])
  const [history, setHistory] = useState([])

  // docs 的同步镜像 + 统一写入口。
  //
  // 为什么 ref 不能只靠 useEffect 同步：effect 的执行顺序是「子先父后」，
  // Canvas 的 fitView 副作用会在父组件的同步 effect 之前调用 updateDoc，
  // 那时 docsRef 还停留在上一轮的旧值 —— updateDoc 会拿它算出 next 再写回，
  // 把刚恢复/导入出来的文档列表整个覆盖掉（表现为「恢复后画布空白」）。
  // 所以 ref 必须和 state 在同一个函数里同步写入，所有写入都走 applyDocs。
  const docsRef = useRef(docs)
  const applyDocs = useCallback((next) => {
    docsRef.current = next
    setDocsState(next)
  }, [])
  // 兜底：万一有绕过 applyDocs 的写入，也让 ref 跟上已提交的 state
  useEffect(() => { docsRef.current = docs }, [docs])
  // activeId 的同步镜像：flushPending 在定时器里执行，闭包里的 activeId 可能已过期
  const activeIdRef = useRef(activeId)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  const booted = useRef(false)

  const doc = useMemo(() => docs.find((d) => d.id === activeId) || null, [docs, activeId])

  /* ---------------- 启动 ---------------- */
  useEffect(() => {
    // bootstrap 是幂等的：已有标签页就直接返回，不会重复写入示例文档。
    // 严格模式下 effect 会跑两次，这里用 ref 再兜一层，避免无谓的重复读取。
    if (booted.current) return
    booted.current = true
    const ids = bootstrap()
    setTabIds(ids)
    applyDocs(store.listDocs())
    setActiveId(store.getActive() || ids[0])
    setTrash(store.getTrash())
    setFolders(store.getFolders())
  }, [applyDocs])

  useEffect(() => { if (activeId) setHistory(store.getHistory(activeId)) }, [activeId])

  /* ---------------- 文档变更 + 防抖持久化 + 历史版本 ---------------- */

  /**
   * 按文档 id 排队落盘。
   *
   * 不能直接用一个「只记住最后一次参数」的普通防抖：那样用户在 900ms 内
   * 先改文档 A、再切到文档 B 改一笔，A 的修改会被 B 覆盖掉，静默丢数据。
   * 这里用 Map 按 id 分别排队，定时器到点后一次性把所有待写文档都写下去。
   */
  const pendingSaves = useRef(new Map())
  const saveTimer = useRef(null)

  const flushPending = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    const queue = pendingSaves.current
    if (!queue.size) return
    const docsToSave = [...queue.values()]
    queue.clear()
    let latestHistory = null
    for (const d of docsToSave) {
      store.saveDoc(d)
      // 只把「当前正在看的文档」的历史刷进面板，避免切页时历史列表跳变
      const h = store.pushHistory(d.id, {
        at: Date.now(),
        fingerprint: fingerprint(d.root),
        root: cloneTree(d.root, true),
        name: d.name,
      })
      if (d.id === activeIdRef.current) latestHistory = h
    }
    if (latestHistory) setHistory(latestHistory)
  }, [])

  /** 排入待写队列（同一个文档连续改动会被后一次覆盖，这是期望行为） */
  const persist = useCallback((d) => {
    pendingSaves.current.set(d.id, d)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushPending, 900)
  }, [flushPending])

  // 卸载前把没落盘的改动冲出去
  useEffect(() => () => flushPending(), [flushPending])

  /**
   * 唯一的文档写入口。
   * 持久化策略见本 Hook 顶部的注释。
   */
  const updateDoc = useCallback((updater, { persistNow = false } = {}) => {
    const prev = docsRef.current
    const next = prev.map((d) => {
      if (d.id !== activeId) return d
      return typeof updater === 'function' ? updater(d) : { ...d, ...updater }
    })
    docsRef.current = next
    applyDocs(next)

    const patched = next.find((d) => d.id === activeId)
    if (patched) {
      if (persistNow) {
        // 立即写盘：先把这个文档从待写队列摘掉，避免稍后重复写一遍
        pendingSaves.current.delete(patched.id)
        store.saveDoc(patched)
        setHistory(store.pushHistory(patched.id, {
          at: Date.now(),
          fingerprint: fingerprint(patched.root),
          root: cloneTree(patched.root, true),
          name: patched.name,
        }))
      } else {
        persist(patched)
      }
    }
  }, [activeId, persist, applyDocs])

  /* ================================================================ */
  /* 标签页 / 文档                                                     */
  /* ================================================================ */

  const openDoc = useCallback((id) => {
    setActiveId(id)
    store.setActive(id)
    setSelectedId(null)
    /*
     * 切换文档必须把连线模式和改名框收掉。
     * 它们记的是**上一个文档**的节点 id，留着的话新文档里会出现
     * 「源节点找不到」的待选状态，或者一个指向不存在节点的输入框。
     */
    setLinkMode(null)
    setRenameTarget(null)
    /*
     * 【这里**不再**自动 fitView】
     *
     * 原来每打开一个文档都 requestFit()，于是「切走再切回来」会把用户
     * 自己调好的缩放和位置整个丢掉，重新按整图铺满算一个 —— 用户的原话是
     * 「进行操作时不要改变缩放大小」，切标签页就是最常见的操作之一。
     * 实测：某文档缩放到 1.6198 → 切到别的标签 → 切回来变成 0.6910。
     *
     * 而 view 本来就是**按文档存在磁盘上**的（store.saveDoc 里带 view，
     * 见 store.js 的 normalizeDoc）—— 也就是说「记住每个文档看到哪儿」
     * 早就实现了，是这次无条件 fit 把它作废了。去掉之后切回来就是原样。
     *
     * 真正「需要重新铺满」的是**刚建出来 / 刚导入 / 刚恢复**的文档：
     * 它们的 view 是占位值 {x:80,y:60,zoom:1}，内容大小完全没量过。
     * 那三处各自 requestFit()，见下面的 createDoc / importMd / restoreTrash。
     */
  }, [setSelectedId, setLinkMode, setRenameTarget])

  const createDoc = useCallback((md, name) => {
    const d = md ? newDocFromMd(md, name) : newBlankDoc(name)
    store.saveDoc(d)
    const ids = [...store.getTabs(), d.id]
    store.setTabs(ids)
    setTabIds(ids)
    applyDocs(store.listDocs())
    openDoc(d.id)
    requestFit()   // 新文档的 view 是占位值，必须按真实内容铺满一次
    return d
  }, [openDoc, applyDocs, requestFit])

  const closeDoc = useCallback((id) => {
    const ids = store.removeDoc(id)
    setTabIds(ids)
    const rest = store.listDocs()
    applyDocs(rest)
    if (activeId === id) {
      const next = ids[0] || null
      setActiveId(next)
      if (next) store.setActive(next)
    }
  }, [activeId, applyDocs])

  const renameDoc = useCallback((id, name) => {
    const next = docsRef.current.map((d) => {
      if (d.id !== id) return d
      // 文档名同时同步到根节点文字（仅当根节点还是旧名字，避免覆盖用户改过的标题）
      return {
        ...d,
        name,
        path: name,
        root: { ...d.root, text: d.root.text === d.name ? name : d.root.text },
      }
    })
    docsRef.current = next
    applyDocs(next)
    const patched = next.find((d) => d.id === id)
    if (patched) store.saveDoc(patched)
  }, [applyDocs])

  const deleteDoc = useCallback((id) => {
    setConfirm({
      title: '删除文档',
      body: `「${docs.find((d) => d.id === id)?.name || ''}」将被移入回收站，之后还能恢复。确定继续？`,
      danger: true,
      onOk: () => { closeDoc(id); setTrash(store.getTrash()); say('已移入回收站') },
    })
  }, [docs, closeDoc, say, setConfirm])

  /* ---------------- 回收站 ---------------- */
  const restoreTrash = useCallback((index) => {
    const d = store.restoreFromTrash(index)
    if (!d) return
    setTrash(store.getTrash())
    setTabIds(store.getTabs())
    applyDocs(store.listDocs())
    openDoc(d.id)
    requestFit()   // 恢复出来的文档可能已经很久没看过，铺满一次更稳妥
    say(`已恢复「${d.name}」`)
  }, [openDoc, requestFit, say, applyDocs])

  /* ---------------- 导入（Markdown / OPML / FreeMind / HTML / JSON 都走这里） ---------------- */
  /**
   * 把 formats.parseDocument 解析好的树插成新文档。
   *
   * 【为什么导入不收口在这里的解析上，而是接收解析结果】
   * 「认格式、解析成树」是纯逻辑（src/lib/formats.js，有 100+ 项纯函数测试），
   * 而「插文档 / 落盘 / 开标签 / 重新铺满」是本 Hook 的职责。分开之后，
   * 手机上导入 OPML 和桌面上导入 HTML 走的是同一条插入路径 —— 不会出现
   * 「某种格式导进来忘了 fitView，看到一片空白」。
   *
   * @param parsed { root, name, relations, total, foldCount, formatLabel, truncated }
   */
  const importDoc = useCallback((parsed) => {
    const {
      root, name, relations = [], total = 0, foldCount = 0, formatLabel = '', truncated = false,
    } = parsed
    applyLargeImportDefault(root, total)
    const d = {
      id: uid('doc'), name, path: name, root,
      relations: normalizeRelations(relations),
      view: { x: 80, y: 60, zoom: 1 }, updatedAt: Date.now(),
    }
    store.saveDoc(d)
    const ids = [...store.getTabs(), d.id]
    store.setTabs(ids)
    setTabIds(ids)
    applyDocs(store.listDocs())
    openDoc(d.id)
    requestFit()   // 刚导入的文档：view 是占位值，按真实节点数量铺满一次
    const head = formatLabel ? `已按「${formatLabel}」导入 ` : '已导入 '
    say(head + `${total} 个节点`
      + (foldCount ? `，识别到 ${foldCount} 个折角` : '')
      + (truncated ? ' · 文件太大，只读了前一部分' : '')
      + (total > 50 ? ' · 已自动收起深层节点' : ''))
  }, [openDoc, requestFit, say, applyDocs])

  /* ---------------- 整库备份恢复 ---------------- */
  /**
   * 从备份 JSON 恢复整库。
   *
   * 必须把 tabIds / trash / folders 一起刷新 —— 它们都是 store 的独立分片，
   * 只更新 docs 会让标签栏和回收站停留在恢复前的状态。
   */
  const importBackup = useCallback((raw) => {
    const { ids, skipped } = store.importAll(raw)
    setTabIds(ids)
    applyDocs(store.listDocs())
    setTrash(store.getTrash())
    setFolders(store.getFolders())
    if (ids[0]) openDoc(ids[0])
    return { ids, skipped }
  }, [applyDocs, openDoc])

  /* ================================================================ */
  /* 文件夹（大纲面板里的单层分组）                                     */
  /* ================================================================ */

  const createFolder = useCallback((name = '新建文件夹') => {
    const f = store.createFolder(name)
    setFolders(store.getFolders())
    say(`已创建文件夹「${f.name}」`)
    return f
  }, [say])

  const renameFolder = useCallback((id, name) => {
    setFolders(store.renameFolder(id, name))
  }, [])

  const deleteFolder = useCallback((id) => {
    const f = folders.find((x) => x.id === id)
    const count = docs.filter((d) => d.folderId === id).length
    setConfirm({
      title: '删除文件夹',
      body: count
        ? `「${f?.name || ''}」里有 ${count} 个文档，删除文件夹后它们会退回「未分类」，不会被删除。确定继续？`
        : `确定删除文件夹「${f?.name || ''}」？`,
      danger: true,
      onOk: () => {
        setFolders(store.deleteFolder(id))
        applyDocs(store.listDocs())
        say('文件夹已删除，文档已退回未分类')
      },
    })
  }, [folders, docs, say, setConfirm, applyDocs])

  const moveDoc = useCallback((docId, folderId) => {
    store.moveDoc(docId, folderId)
    applyDocs(store.listDocs())
    const target = folders.find((f) => f.id === folderId)
    say(folderId ? `已移动到「${target?.name || ''}」` : '已移出文件夹')
  }, [folders, say, applyDocs])

  return {
    docs, tabIds, activeId, setActiveId, setTabIds, doc, docsRef, applyDocs, updateDoc,
    flushPending, trash, setTrash, folders, history, setHistory,
    openDoc, createDoc, closeDoc, renameDoc, deleteDoc, restoreTrash, importDoc, importBackup,
    createFolder, renameFolder, deleteFolder, moveDoc,
  }
}
