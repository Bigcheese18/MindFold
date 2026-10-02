/**
 * 本地持久化层
 * ============
 * 设计目标：整个应用零后端。MVP 阶段用 LocalStorage 模拟「用户选择的本地文件夹」，
 * 后续接 Tauri 时，只需把 read/write/list 换成 @tauri-apps/plugin-fs 的实现，
 * 上层业务代码完全不用动 —— 因此这里刻意收口成 4 个原子函数。
 *
 * 存储布局（key 前缀 mf:）：
 *   mf:tabs          当前打开的标签页 id 列表
 *   mf:active        当前激活的文档 id
 *   mf:theme         全局主题
 *   mf:doc:<id>      文档主体 JSON
 *   mf:hist:<id>     文档历史版本数组（最多 10 个）
 */

import { normalizeRelations } from './model.js'

const P = 'mf:'
const HISTORY_LIMIT = 10

function safeGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(P + key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(P + key, JSON.stringify(value))
    return true
  } catch (e) {
    // 配额爆掉时至少要告知用户，不能静默丢数据
    console.warn('[MindFold] 本地存储写入失败：', e)
    return false
  }
}

export const store = {
  /* ---------- 文档 ---------- */
  /**
   * 读出所有打开的文档。
   * 顺带做一次浅校验：localStorage 是用户能直接改的，一条缺 root / children
   * 不是数组的脏数据就足以让整棵渲染树崩掉，这里直接跳过并告警。
   */
  listDocs() {
    const tabs = safeGet('tabs', [])
    const out = []
    for (const id of tabs) {
      const d = safeGet('doc:' + id)
      if (!d || typeof d !== 'object') continue
      if (!d.root || !Array.isArray(d.root.children)) {
        console.warn('[MindFold] 跳过结构损坏的文档：', id)
        continue
      }
      // 老文档没有 relations 字段，补成空数组；
      // 手工改坏的（缺 from/to、自环）在 normalizeRelations 里逐条丢掉。
      if (!Array.isArray(d.relations)) d.relations = []
      out.push(d)
    }
    return out
  },

  saveDoc(doc) {
    if (!doc?.id) return false
    doc.updatedAt = Date.now()
    return safeSet('doc:' + doc.id, doc)
  },

  /**
   * 删除文档 —— 软删除，进回收站。
   *
   * 不直接抹掉数据：产品定位是「数据完全由用户掌控」，误删应该是可恢复的。
   * 接 Tauri 后这里换成系统回收站 API（shell.trashItem），语义一致。
   */
  removeDoc(id) {
    const doc = safeGet('doc:' + id)
    if (doc) {
      const trash = safeGet('trash', [])
      trash.unshift({ doc, deletedAt: Date.now() })
      safeSet('trash', trash.slice(0, 50)) // 回收站最多留 50 份
    }
    try {
      localStorage.removeItem(P + 'doc:' + id)
      localStorage.removeItem(P + 'hist:' + id)
    } catch { /* ignore */ }
    const tabs = safeGet('tabs', []).filter((t) => t !== id)
    safeSet('tabs', tabs)
    return tabs
  },

  /* ---------- 回收站 ---------- */
  getTrash() { return safeGet('trash', []) },

  /** 从回收站恢复，返回恢复出来的文档（已写回 doc:），失败返回 null */
  restoreFromTrash(index) {
    const trash = safeGet('trash', [])
    const item = trash[index]
    if (!item?.doc) return null
    // id 冲突时重新分配，避免覆盖现有文档
    let doc = item.doc
    if (safeGet('doc:' + doc.id)) doc = { ...doc, id: 'doc_' + Date.now().toString(36) + '_r' }
    safeSet('doc:' + doc.id, doc)
    trash.splice(index, 1)
    safeSet('trash', trash)
    const tabs = safeGet('tabs', [])
    if (!tabs.includes(doc.id)) safeSet('tabs', [...tabs, doc.id])
    return doc
  },

  emptyTrash() { return safeSet('trash', []) },

  /* ---------- 文件夹（单层） ----------
   * 刻意只做一层：大纲面板宽 268px，嵌套目录在这里既看不清也点不准，
   * 而个人学习场景（「计算机网络」「数学」「英语」）单层完全够用。
   * 文档用 folderId 关联，null 表示未分类。
   */
  getFolders() {
    const list = safeGet('folders', [])
    return Array.isArray(list) ? list.filter((f) => f && typeof f.id === 'string') : []
  },

  setFolders(list) { return safeSet('folders', list) },

  createFolder(name) {
    const list = this.getFolders()
    const folder = { id: 'fd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(name || '新建文件夹').slice(0, 60) }
    list.push(folder)
    safeSet('folders', list)
    return folder
  },

  renameFolder(id, name) {
    const list = this.getFolders().map((f) => (f.id === id ? { ...f, name: String(name).slice(0, 60) } : f))
    safeSet('folders', list)
    return list
  },

  /** 删除文件夹：里面的文档不跟着删，退回「未分类」 */
  deleteFolder(id) {
    const list = this.getFolders().filter((f) => f.id !== id)
    safeSet('folders', list)
    for (const docId of safeGet('tabs', [])) {
      const d = safeGet('doc:' + docId)
      if (d && d.folderId === id) safeSet('doc:' + docId, { ...d, folderId: null })
    }
    return list
  },

  moveDoc(docId, folderId) {
    const d = safeGet('doc:' + docId)
    if (!d) return false
    return safeSet('doc:' + docId, { ...d, folderId: folderId || null })
  },

  /* ---------- 标签页 ---------- */
  getTabs() { return safeGet('tabs', []) },
  setTabs(ids) { return safeSet('tabs', ids) },
  getActive() { return safeGet('active', null) },
  setActive(id) { return safeSet('active', id) },

  /* ---------- 主题 ---------- */
  getTheme() { return safeGet('theme', 'white') },
  setTheme(t) { return safeSet('theme', t) },

  /* ---------- 历史版本（最多保留 10 个） ---------- */
  getHistory(id) { return safeGet('hist:' + id, []) },

  /**
   * 写入一个历史快照。
   * 防抖后的自动保存会频繁调用，这里做「内容去重」：
   * 与最近一版完全相同则跳过，避免 10 个槽位被同一份内容占满。
   */
  pushHistory(id, snapshot) {
    const hist = safeGet('hist:' + id, [])
    const last = hist[0]
    if (last && last.fingerprint === snapshot.fingerprint) return hist
    hist.unshift(snapshot)
    const trimmed = hist.slice(0, HISTORY_LIMIT)
    safeSet('hist:' + id, trimmed)
    return trimmed
  },

  /* ---------- 导入导出（整库备份） ---------- */
  exportAll() {
    const tabs = safeGet('tabs', [])
    return {
      app: 'MindFold',
      version: 1,
      exportedAt: new Date().toISOString(),
      theme: safeGet('theme', 'white'),
      folders: safeGet('folders', []),
      docs: tabs.map((id) => safeGet('doc:' + id)).filter(Boolean),
      history: Object.fromEntries(tabs.map((id) => [id, safeGet('hist:' + id, [])])),
    }
  },

  /**
   * 导入整库备份。
   *
   * 备份 JSON 是用户可以手改的文件，所以不能信任其结构：缺 root、
   * children 不是数组、节点没有 id，都会让渲染层直接崩掉。
   * 这里逐条校验并**跳过**坏文档（而不是整体失败），最后把跳过数量
   * 一起返回，让 UI 能如实告诉用户「导入了 N 个，跳过 M 个」。
   */
  importAll(payload) {
    if (!payload || payload.app !== 'MindFold' || !Array.isArray(payload.docs)) {
      throw new Error('不是有效的 MindFold 备份文件')
    }
    const ids = []
    let skipped = 0

    for (const raw of payload.docs) {
      const doc = normalizeDoc(raw)
      if (!doc) { skipped++; continue }
      safeSet('doc:' + doc.id, doc)
      ids.push(doc.id)
      const hist = payload.history?.[doc.id]
      if (Array.isArray(hist)) safeSet('hist:' + doc.id, hist)
    }

    if (!ids.length) throw new Error('备份里没有可用的文档')
    safeSet('tabs', ids)
    if (payload.theme) safeSet('theme', payload.theme)
    // 文件夹一并恢复；只保留结构合法的条目
    if (Array.isArray(payload.folders)) {
      safeSet('folders', payload.folders.filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string'))
    }
    return { ids, skipped }
  },
}

export { HISTORY_LIMIT }

/* ------------------------------------------------------------------ */
/* 导入数据的结构校验                                                   */
/* ------------------------------------------------------------------ */

/**
 * 把外部导入的文档整形成应用能安全渲染的形状；不可修复时返回 null。
 * 只做「不崩」所需的最小校验，不追求完备的 schema。
 *
 * 【为什么要把这个私有函数再开放一个 export】
 * 「导入的文档结构校验」必须有**且只有一个**实现。整库备份走 importAll，
 * 单文档 JSON / 离线 HTML 内嵌载荷走 formats.js 的 parseDocument —— 两条路
 * 各自抄一份校验，迟早一条收紧一条没跟，于是「备份导入是安全的、单文档导入
 * 能塞进畸形树把画布搞崩」。开放的是同一个函数，不是第二份实现。
 */
export function normalizeDocPayload(raw) {
  return normalizeDoc(raw)
}

function normalizeDoc(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null
  const root = normalizeNode(raw.root, 0)
  if (!root) return null
  // 汇聚虚线必须跟着文档一起备份/恢复，否则「指向同一结果」建出来的
  // 结构在还原后就只剩一个孤儿节点
  const relations = normalizeRelations(raw.relations)
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : 'doc_' + Math.random().toString(36).slice(2, 10),
    name: raw.name.slice(0, 200),
    path: typeof raw.path === 'string' ? raw.path : raw.name,
    folderId: typeof raw.folderId === 'string' && raw.folderId ? raw.folderId : null,
    root,
    relations,
    view: {
      x: Number.isFinite(raw.view?.x) ? raw.view.x : 80,
      y: Number.isFinite(raw.view?.y) ? raw.view.y : 60,
      zoom: Number.isFinite(raw.view?.zoom) ? raw.view.zoom : 1,
    },
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

/** 递归校验节点；深度上限防御畸形/自引用数据导致的爆栈 */
function normalizeNode(raw, depth) {
  if (!raw || typeof raw !== 'object' || depth > 200) return null
  const text = typeof raw.text === 'string' ? raw.text : ''
  const children = Array.isArray(raw.children)
    ? raw.children.map((c) => normalizeNode(c, depth + 1)).filter(Boolean)
    : []
  const fold = raw.fold && typeof raw.fold === 'object'
    ? {
        corner: !!raw.fold.corner,
        openCount: Number.isFinite(raw.fold.openCount) ? raw.fold.openCount : 0,
        mermaid: typeof raw.fold.mermaid === 'string' ? raw.fold.mermaid : '',
        outline: typeof raw.fold.outline === 'string' ? raw.fold.outline : '',
        updatedAt: Number.isFinite(raw.fold.updatedAt) ? raw.fold.updatedAt : Date.now(),
      }
    : null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : 'n_' + Math.random().toString(36).slice(2, 10),
    text,
    children,
    collapsed: !!raw.collapsed,
    bold: !!raw.bold,
    italic: !!raw.italic,
    fold,
  }
}

/**
 * 轻量指纹，用于历史去重 / 脏检查。
 * 只看结构关键字段，不用 JSON.stringify 整棵树（大树会卡）。
 *
 * 刻意**不包含 openCount**：熟悉度只是「看过几次」的计数，不是内容。
 * 若把它算进去，用户每点开一个折角就会产生一个「新版本」，
 * 10 个历史槽位很快被计数变化占满，真正的文字修改反而被挤掉。
 */
export function fingerprint(root) {
  let hash = 5381
  const feed = (s) => {
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
  }
  const walk = (n) => {
    feed(n.text)
    feed(n.fold ? `${n.fold.mermaid}|${n.fold.corner}` : '-')
    feed(n.bold ? 'b' : '')
    feed(n.italic ? 'i' : '')
    feed(n.collapsed ? 'c' : '')
    n.children.forEach(walk)
  }
  walk(root)
  return (hash >>> 0).toString(36)
}