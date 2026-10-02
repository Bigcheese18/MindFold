/**
 * 存储层测试
 * ==========
 * store.js 依赖 localStorage，这里注入一个最小实现后在 Node 里直接跑。
 * 覆盖：读写、回收站、历史去重、备份导入的结构校验。
 */
import { store, fingerprint, HISTORY_LIMIT } from './store.js'
import { parseMarkdown, makeNode, makeFold } from './model.js'

/* ---------------- 最小 localStorage 实现 ---------------- */
const mem = new Map()
globalThis.localStorage = {
  get length() { return mem.size },
  key: (i) => [...mem.keys()][i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
}

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}

const mkDoc = (name) => {
  const { root } = parseMarkdown('- A [F]\n  - a1\n- B', name)
  return { id: 'doc_' + name, name, path: name, root, view: { x: 0, y: 0, zoom: 1 }, updatedAt: Date.now() }
}

/* ---------------- 1. 基本读写 ---------------- */
console.log('\n[1] 基本读写')
const d1 = mkDoc('甲')
store.saveDoc(d1)
store.setTabs([d1.id])
store.setActive(d1.id)

check('listDocs 读回文档', store.listDocs().length === 1)
check('读回的文档名正确', store.listDocs()[0].name === '甲')
check('getTabs / getActive 正确', store.getTabs()[0] === d1.id && store.getActive() === d1.id)
check('saveDoc 会刷新 updatedAt', store.listDocs()[0].updatedAt >= d1.updatedAt)

/* ---------------- 2. 损坏数据不应让应用崩掉 ---------------- */
console.log('\n[2] 损坏数据的容错')
const d2 = mkDoc('乙')
store.saveDoc(d2)
store.setTabs([d1.id, d2.id, 'doc_不存在'])
// 手工写入一条结构损坏的记录
localStorage.setItem('mf:doc:doc_坏', JSON.stringify({ id: 'doc_坏', name: '坏' }))
store.setTabs([d1.id, 'doc_坏', d2.id, 'doc_不存在'])

const docs = store.listDocs()
check('跳过缺 root 的损坏文档', !docs.some((d) => d.name === '坏'), JSON.stringify(docs.map((d) => d.name)))
check('跳过不存在的 id', docs.length === 2, `得到 ${docs.length}`)
check('正常文档不受影响', docs.map((d) => d.name).sort().join() === '乙,甲')

/* ---------------- 3. 回收站 ---------------- */
console.log('\n[3] 回收站')
store.setTabs([d1.id, d2.id])
const tabsAfterRemove = store.removeDoc(d2.id)
check('删除后标签页少一个', tabsAfterRemove.length === 1 && tabsAfterRemove[0] === d1.id)
check('原 doc: 键已移除', localStorage.getItem('mf:doc:' + d2.id) === null)
check('回收站里有一条', store.getTrash().length === 1)
check('回收站保留了名称', store.getTrash()[0].doc.name === '乙')
check('回收站保留了树结构', Array.isArray(store.getTrash()[0].doc.root.children))

const restored = store.restoreFromTrash(0)
check('恢复返回文档', restored && restored.name === '乙')
check('恢复后回收站清空', store.getTrash().length === 0)
check('恢复后重新写回 doc:', localStorage.getItem('mf:doc:' + d2.id) !== null)
check('恢复后回到标签页', store.getTabs().includes(d2.id))

// id 冲突时应换新 id，而不是覆盖现有文档
store.removeDoc(d2.id)
store.saveDoc(d2) // 制造冲突：同 id 已存在
const conflict = store.restoreFromTrash(0)
check('id 冲突时分配新 id', conflict && conflict.id !== d2.id, conflict && conflict.id)

/* ---------------- 4. 历史版本去重 ---------------- */
console.log('\n[4] 历史版本')
localStorage.removeItem('mf:hist:' + d1.id)
const fp = fingerprint(d1.root)
store.pushHistory(d1.id, { at: 1, fingerprint: fp, root: d1.root, name: '甲' })
store.pushHistory(d1.id, { at: 2, fingerprint: fp, root: d1.root, name: '甲' })
check('相同指纹不会重复入栈', store.getHistory(d1.id).length === 1, `得到 ${store.getHistory(d1.id).length}`)

// 上限
for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
  store.pushHistory(d1.id, { at: 100 + i, fingerprint: 'fp' + i, root: d1.root, name: '甲' })
}
check(`历史最多保留 ${HISTORY_LIMIT} 个`, store.getHistory(d1.id).length === HISTORY_LIMIT,
  `得到 ${store.getHistory(d1.id).length}`)

/* ---------------- 5. 指纹应忽略 openCount ---------------- */
console.log('\n[5] 指纹语义')
const a = makeNode('节点')
const b = makeNode('节点')
b.id = a.id
check('同内容同结构指纹相同', fingerprint(a) === fingerprint(b))

const withFold1 = makeNode('x')
withFold1.fold = makeFold({ corner: true, mermaid: 'flowchart TD\n A-->B' })
withFold1.fold.openCount = 0
const withFold2 = makeNode('x')
withFold2.id = withFold1.id
withFold2.fold = { ...withFold1.fold, openCount: 99 }
check('openCount 变化不改变指纹（打开折角不算新版本）',
  fingerprint(withFold1) === fingerprint(withFold2))

const changed = makeNode('y')
changed.id = withFold1.id
check('文字变化会改变指纹', fingerprint(changed) !== fingerprint(withFold1))

/* ---------------- 6. 备份导入的结构校验 ---------------- */
console.log('\n[6] 备份导入校验')
const good = store.exportAll()
check('exportAll 带应用标识', good.app === 'MindFold' && Array.isArray(good.docs))

localStorage.clear()
const result = store.importAll(good)
check('导入返回 ids 与跳过数', Array.isArray(result.ids) && typeof result.skipped === 'number',
  JSON.stringify(result))
check('正常备份不跳过任何文档', result.skipped === 0 && result.ids.length > 0)

localStorage.clear()
const messy = store.importAll({
  app: 'MindFold',
  docs: [
    mkDoc('好的'),
    null,
    { name: '没有 root' },
    { root: { children: [] } },                 // 没有 name
    { name: '  ' },                              // name 全空格
    { name: '深层缺 id', root: { text: 'r', children: [{ text: 'c' }] } },
  ],
})
check('跳过 null / 缺 name / 缺 root 的条目', messy.skipped === 4, `skipped=${messy.skipped}`)
check('仍导入可用条目', messy.ids.length === 2, `ids=${messy.ids.length}`)
check('缺 id 的节点被补上 id',
  store.listDocs().every((d) => d.root.id && d.root.children.every((c) => c.id)))

let threw = null
try { store.importAll({ app: '别的应用', docs: [] }) } catch (e) { threw = e.message }
check('非 MindFold 备份被拒绝', threw === '不是有效的 MindFold 备份文件', threw)

let threw2 = null
try { store.importAll({ app: 'MindFold', docs: [null, null] }) } catch (e) { threw2 = e.message }
check('全部条目都损坏时报错而不是静默清空', threw2 === '备份里没有可用的文档', threw2)

/* ---------------- 7. 文件夹 ---------------- */
console.log('\n[7] 文件夹')
localStorage.clear()

const fA = store.createFolder('计算机网络')
const fB = store.createFolder('数学')
check('createFolder 返回带 id 的文件夹', !!fA.id && fA.name === '计算机网络')
check('getFolders 能读回', store.getFolders().length === 2)

const fd1 = mkDoc('TCP')
const fd2 = mkDoc('线性代数')
store.saveDoc(fd1)
store.saveDoc(fd2)
store.setTabs([fd1.id, fd2.id])

store.moveDoc(fd1.id, fA.id)
check('moveDoc 写入 folderId', store.listDocs().find((d) => d.id === fd1.id).folderId === fA.id)
store.moveDoc(fd2.id, fB.id)
check('不同文档可放不同文件夹',
  store.listDocs().find((d) => d.id === fd2.id).folderId === fB.id)

store.renameFolder(fA.id, '网络原理')
check('renameFolder 生效', store.getFolders().find((f) => f.id === fA.id).name === '网络原理')

// 删除文件夹不应删掉里面的文档
store.deleteFolder(fA.id)
check('删除文件夹后文件夹消失', store.getFolders().length === 1)
check('文件夹里的文档没有被删掉', store.listDocs().some((d) => d.id === fd1.id))
check('文档退回未分类（folderId 清空）',
  store.listDocs().find((d) => d.id === fd1.id).folderId === null)

/* ---------------- 8. 备份要带上文件夹 ---------------- */
console.log('\n[8] 备份包含文件夹')
const backup = store.exportAll()
check('exportAll 含 folders', Array.isArray(backup.folders) && backup.folders.length === 1,
  JSON.stringify(backup.folders))
check('文档带 folderId', backup.docs.some((d) => d.folderId === fB.id))

localStorage.clear()
store.importAll(backup)
check('导入后文件夹恢复', store.getFolders().length === 1 && store.getFolders()[0].name === '数学')
check('导入后文档的 folderId 保留',
  store.listDocs().find((d) => d.id === fd2.id)?.folderId === fB.id,
  JSON.stringify(store.listDocs().map((d) => [d.name, d.folderId])))

// 损坏的 folders 字段不应让导入失败
localStorage.clear()
const messy2 = store.importAll({ ...backup, folders: [null, { name: '没有 id' }, { id: 'ok', name: '好的' }] })
check('跳过损坏的文件夹条目', store.getFolders().length === 1 && store.getFolders()[0].id === 'ok',
  JSON.stringify(store.getFolders()))
check('损坏的 folders 不影响文档导入', messy2.ids.length === backup.docs.length)

console.log(`\n${'='.repeat(46)}`)
console.log(`  通过 ${pass} / 失败 ${fail}`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)