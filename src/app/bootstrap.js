import { parseMarkdown, makeNode, makeFold, uid } from '../lib/model'
import { store } from '../lib/store'
import { SAMPLE_MD, SAMPLE_MD_2 } from '../lib/sample'

/* ------------------------------------------------------------------ */
/* 启动引导：首次运行写入示例文档                                        */
/* ------------------------------------------------------------------ */

export function newDocFromMd(md, name) {
  const { root } = parseMarkdown(md, name)
  return {
    id: uid('doc'),
    name,
    path: name,
    root,
    relations: [],
    view: { x: 80, y: 60, zoom: 1 },
    updatedAt: Date.now(),
  }
}

export function newBlankDoc(name = '未命名导图') {
  const root = makeNode(name)
  root.children.push(makeNode('双击我可以改字'))
  root.children.push(makeNode('Tab 生成子节点 / Enter 生成同级'))
  const hint = makeNode('右键我 → 打上折角 [F]')
  hint.fold = makeFold({ corner: false })
  root.children.push(hint)
  return { id: uid('doc'), name, path: name, root, relations: [], view: { x: 80, y: 60, zoom: 1 }, updatedAt: Date.now() }
}

export function bootstrap() {
  let tabs = store.getTabs()
  if (!tabs.length) {
    const d1 = newDocFromMd(SAMPLE_MD, '计算机网络 · 期末复习')
    const d2 = newDocFromMd(SAMPLE_MD_2, '线性代数 · 核心概念')
    store.saveDoc(d1)
    store.saveDoc(d2)
    tabs = [d1.id, d2.id]
    store.setTabs(tabs)
    store.setActive(d1.id)
  }
  return tabs
}
