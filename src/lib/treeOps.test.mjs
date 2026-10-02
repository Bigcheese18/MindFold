/**
 * 「指向同一结果」（多对一汇聚）纯函数测试
 * ==========================================
 * 这个功能一次改两个东西：**树上多一个节点** + **relations 里多两条虚线**。
 * 所以每个用例都要同时断言这两半 —— 只测一半的话，
 * 「节点建了但虚线没建」这种半截状态能一路绿灯过去。
 *
 * 覆盖需求逐条：
 *   一·1  公共父节点 = LCA（含父子关系的边界）
 *   一·2  在公共父节点下新建子节点，默认文字「新结果节点」
 *   一·3  追加在最后一个子节点之后，不打乱原有顺序
 *   一·4  relations 里推入两条记录
 *   一·5  公共父节点折叠时自动展开
 *   三·1  A 和 B 是同一个节点 → 忽略
 *   三·2  A 和 B 是父子关系 → 正常生成且不破坏树
 *   三·3  同一节点对重复操作 → 不重复生成
 *   三·4  删除联动清理；汇聚节点本身不跟着消失
 *   五·2  relations 超过 50 条时默认隐藏（阈值常量）
 *
 * 纯函数测试，不需要浏览器。
 */
import { makeNode, normalizeRelations, cloneTree, findNode, findParent, walkTree } from './model.js'
import {
  lowestCommonAncestor, pathToRoot, buildParentMap, planConvergence,
  convergeToNewNode, findSharedTarget, hasRelation, pruneRelations,
  subtreeIds, relationsOf, moveNode, DEFAULT_RESULT_LABEL, RELATION_HIDE_THRESHOLD,
} from './treeOps.js'
import {
  emptyCanvasHistory, recordCanvasSnapshot, undoCanvas, redoCanvas,
  sameRelations,
} from './canvasHistory.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
const note = (m) => console.log(`  · ${m}`)

/* ------------------------------------------------------------------ */
/* 固定夹具                                                            */
/* ------------------------------------------------------------------ */
/*
 *        n0 根
 *         ├── n1 甲
 *         │    └── n2 甲子
 *         ├── n3 乙
 *         │    └── n4 乙子
 *         └── n5 丙
 */
function fixture() {
  const n0 = makeNode('根'); n0.id = 'n0'
  const n1 = makeNode('甲'); n1.id = 'n1'
  const n2 = makeNode('甲子'); n2.id = 'n2'
  const n3 = makeNode('乙'); n3.id = 'n3'
  const n4 = makeNode('乙子'); n4.id = 'n4'
  const n5 = makeNode('丙'); n5.id = 'n5'
  n1.children.push(n2)
  n3.children.push(n4)
  n0.children.push(n1, n3, n5)
  return n0
}

/** 树上所有节点的 id（用于断言「结构没被破坏」） */
const allIds = (root) => { const o = []; walkTree(root, (n) => o.push(n.id)); return o }
/**
 * 每个节点的父子关系快照（用于断言树边一条没变）。
 * 返回**排序后的数组**而不是拼成字符串 —— 排序会打乱拼接顺序，
 * 用字符串比较会被「新边插在中间」这种正常情况误判成失败。
 */
const treeShape = (root) => {
  const o = []
  walkTree(root, (n, p) => o.push(`${p ? p.id : '-'}>${n.id}`))
  return o.sort()
}
/** 数组形式的树边比较 */
const sameEdges = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

/* ================================================================== */
console.log('\n[1] 最近公共祖先（LCA）')
/* ================================================================== */

{
  const root = fixture()
  check('同分支两代：LCA(n2, n3) = 根',
    lowestCommonAncestor(root, 'n2', 'n3') === 'n0', lowestCommonAncestor(root, 'n2', 'n3'))
  check('★ 父子关系：LCA(n1, n2) = n1（不是根）',
    lowestCommonAncestor(root, 'n1', 'n2') === 'n1', lowestCommonAncestor(root, 'n1', 'n2'))
  check('★ 父子关系反序：LCA(n2, n1) = n1（与参数顺序无关）',
    lowestCommonAncestor(root, 'n2', 'n1') === 'n1', lowestCommonAncestor(root, 'n2', 'n1'))
  check('跨分支深层：LCA(n2, n4) = 根',
    lowestCommonAncestor(root, 'n2', 'n4') === 'n0', lowestCommonAncestor(root, 'n2', 'n4'))
  check('兄弟：LCA(n1, n3) = 根',
    lowestCommonAncestor(root, 'n1', 'n3') === 'n0', lowestCommonAncestor(root, 'n1', 'n3'))
  check('自己和自己：LCA(n3, n3) = n3',
    lowestCommonAncestor(root, 'n3', 'n3') === 'n3', lowestCommonAncestor(root, 'n3', 'n3'))
  check('节点不存在时返回 null',
    lowestCommonAncestor(root, 'n1', 'zzz') === null)

  // 深层三级：验证「最近」而不是「最高」
  const deep = makeNode('r'); deep.id = 'd0'
  const a = makeNode('a'); a.id = 'd1'
  const b = makeNode('b'); b.id = 'd2'
  const c = makeNode('c'); c.id = 'd3'
  a.children.push(b); b.children.push(c); deep.children.push(a)
  check('★ 三级链路：LCA(d1, d3) = d1',
    lowestCommonAncestor(deep, 'd1', 'd3') === 'd1', lowestCommonAncestor(deep, 'd1', 'd3'))
  check('三级链路：LCA(d3, d2) = d2',
    lowestCommonAncestor(deep, 'd3', 'd2') === 'd2', lowestCommonAncestor(deep, 'd3', 'd2'))
}

/* ================================================================== */
console.log('\n[2] 路径与父映射')
/* ================================================================== */

{
  const root = fixture()
  const pm = buildParentMap(root)
  check('pathToRoot 从根到自己是正序',
    pathToRoot(root, 'n2', pm).join('>') === 'n0>n1>n2', pathToRoot(root, 'n2', pm).join('>'))
  check('根节点的路径只有自己',
    pathToRoot(root, 'n0', pm).join('>') === 'n0')
  check('不存在的节点返回空路径',
    pathToRoot(root, 'zzz', pm).length === 0)
  check('父映射里根的父亲是 null',
    pm.get('n0') === null && pm.get('n2') === 'n1')
}

/* ================================================================== */
console.log('\n[3] 汇聚方案：公共父节点与插入位置')
/* ================================================================== */

{
  const root = fixture()
  const before = treeShape(root)
  const r = convergeToNewNode(root, [], 'n2', 'n4')
  check('跨分支汇聚成功', r.ok === true, JSON.stringify(r))
  check('★ 新节点挂在公共父节点（根）下', r.parentId === 'n0', String(r.parentId))
  check('默认文字是「新结果节点」',
    findNode(root, r.newNodeId).text === DEFAULT_RESULT_LABEL,
    findNode(root, r.newNodeId).text)
  check('★ 追加在最后一个子节点之后（不打乱原有顺序）',
    root.children[root.children.length - 1].id === r.newNodeId,
    root.children.map((c) => c.id).join())
  check('原有三个子节点的相对顺序没变',
    root.children.slice(0, 3).map((c) => c.id).join() === 'n1,n3,n5',
    root.children.map((c) => c.id).join())
  check('★ 树边一条没变，只多了一条 n0 → 新节点',
    sameEdges(treeShape(root), [...before, `n0>${r.newNodeId}`].sort()),
    treeShape(root).join(','))
  check('原节点都还在（没有被摘走当子节点）',
    ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'].every((id) => !!findNode(root, id)))
  check('★ A、B 没有被变成新节点的子节点（新节点是叶子）',
    findNode(root, r.newNodeId).children.length === 0)
}

/* ================================================================== */
console.log('\n[4] relations 两条记录')
/* ================================================================== */

{
  const root = fixture()
  const r = convergeToNewNode(root, [], 'n2', 'n4')
  check('★ relations 里推入了两条', r.relations.length === 2, String(r.relations.length))
  check('A → 新节点', hasRelation(r.relations, 'n2', r.newNodeId))
  check('B → 新节点', hasRelation(r.relations, 'n4', r.newNodeId))
  check('两条都指向同一个新节点',
    r.relations.every((x) => x.to === r.newNodeId))
  check('不修改传入的原数组（纯函数）', (() => {
    const src = []
    convergeToNewNode(fixture(), src, 'n2', 'n4')
    return src.length === 0
  })())
}

/* ================================================================== */
console.log('\n[5] 父子关系的边界（三·2）')
/* ================================================================== */

{
  // n1 是 n2 的父亲
  const root = fixture()
  const before = treeShape(root)
  const r = convergeToNewNode(root, [], 'n1', 'n2')
  check('★ A、B 是父子时仍然正常生成', r.ok === true, JSON.stringify(r))
  check('★ 公共父节点就是 A 自己（不是 A 的父亲）', r.parentId === 'n1', String(r.parentId))
  check('新节点成为 A 的另一个子节点',
    findNode(root, 'n1').children.some((c) => c.id === r.newNodeId))
  check('原有子树没被破坏（n2 还是 n1 的子节点）',
    findParent(root, 'n2').id === 'n1')
  check('★ 原有树边完全没变，只多了一条 n1 → 新节点',
    sameEdges(treeShape(root), [...before, `n1>${r.newNodeId}`].sort()),
    treeShape(root).join(','))
  check('两条 relations 分别是 A 和 B',
    hasRelation(r.relations, 'n1', r.newNodeId) && hasRelation(r.relations, 'n2', r.newNodeId))

  // 反序：B 是 A 的父亲，结果必须一致
  const root2 = fixture()
  const r2 = convergeToNewNode(root2, [], 'n2', 'n1')
  check('反序（B 是 A 的父亲）得到同样的公共父节点',
    r2.ok === true && r2.parentId === 'n1', JSON.stringify(r2))
}

/* ================================================================== */
console.log('\n[6] 同一个节点 / 重复操作（三·1、三·3）')
/* ================================================================== */

{
  const root = fixture()
  const before = treeShape(root)
  const r = convergeToNewNode(root, [], 'n3', 'n3')
  check('★ A 和 B 是同一个节点 → 拒绝', r.ok === false && r.reason === 'self', JSON.stringify(r))
  check('★ 拒绝时不改动树（一个节点都没多）',
    sameEdges(treeShape(root), before), treeShape(root).join(','))

  const ok = convergeToNewNode(root, [], 'n1', 'n3')
  check('前置：第一次汇聚成功', ok.ok === true)

  const dup = convergeToNewNode(root, ok.relations, 'n1', 'n3')
  check('★ 同一节点对重复操作 → 拒绝', dup.ok === false && dup.reason === 'duplicate', JSON.stringify(dup))
  check('★ 拒绝时返回已存在的汇聚节点 id', dup.existing === ok.newNodeId, String(dup.existing))
  check('★ 拒绝时不再多建节点',
    root.children.filter((c) => c.text === DEFAULT_RESULT_LABEL).length === 1,
    String(root.children.length))

  // 参数顺序反过来也算重复
  const dup2 = convergeToNewNode(root, ok.relations, 'n3', 'n1')
  check('★ 反序操作也算重复（A/B 对称）',
    dup2.ok === false && dup2.reason === 'duplicate', JSON.stringify(dup2))

  // findSharedTarget 直测
  check('findSharedTarget 找到共同目标',
    findSharedTarget(ok.relations, 'n1', 'n3') === ok.newNodeId)
  check('findSharedTarget 对无关节点返回 null',
    findSharedTarget(ok.relations, 'n1', 'n5') === null)
  check('findSharedTarget 容忍空输入',
    findSharedTarget(null, 'a', 'b') === null && findSharedTarget([], 'a', 'b') === null)

  // 只指向一半不算重复
  const half = [{ from: 'n1', to: 'X' }]
  check('只有 A 指向某节点时不算重复',
    findSharedTarget(half, 'n1', 'n3') === null)
}

/* ================================================================== */
console.log('\n[7] 折叠的公共父节点要自动展开（一·5）')
/* ================================================================== */

{
  const root = fixture()
  root.collapsed = true
  const r = convergeToNewNode(root, [], 'n1', 'n3')
  check('★ 公共父节点原来是折叠的 → 已展开', root.collapsed === false)
  check('仍然成功生成', r.ok === true && r.expanded === true)

  // 折叠的是别的节点，不该被动展开
  const root2 = fixture()
  root2.children[0].collapsed = true   // n1 折叠
  convergeToNewNode(root2, [], 'n3', 'n5')
  check('只展开公共父节点，不动无关节点的折叠态',
    root2.children[0].collapsed === true)
}

/* ================================================================== */
console.log('\n[8] 删除联动（三·4）')
/* ================================================================== */

{
  const root = fixture()
  const r = convergeToNewNode(root, [], 'n1', 'n3')
  const relations = r.relations
  const newNodeId = r.newNodeId

  // 删掉 A（n1，连带子树 n2）
  const aNode = findNode(root, 'n1')
  const gone = subtreeIds(aNode)
  check('subtreeIds 收集到整棵子树', gone.join() === 'n1,n2', gone.join())
  check('★ 汇聚节点不在被删子树的 id 里（它是独立子树）',
    !gone.includes(newNodeId), gone.join())

  const kept = pruneRelations(relations, gone)
  check('★ 删掉 A 后，A 那条 relations 被剪掉', !hasRelation(kept, 'n1', newNodeId))
  check('★ B 那条 relations 保留', hasRelation(kept, 'n3', newNodeId))
  check('剪枝后只剩一条', kept.length === 1, String(kept.length))

  // 真的从树上摘掉 A
  const p = findParent(root, 'n1')
  p.children = p.children.filter((c) => c.id !== 'n1')
  check('★ 汇聚节点本身还在树上（不随 A 消失）', !!findNode(root, newNodeId))
  check('★ 汇聚节点仍是独立节点，没有变成孤儿悬挂（父节点还在）',
    !!findParent(root, newNodeId) && findParent(root, newNodeId).id === 'n0')

  // 再删掉 B → 两条都没了，汇聚节点仍在
  const gone2 = subtreeIds(findNode(root, 'n3'))
  const kept2 = pruneRelations(kept, gone2)
  check('★ 删掉 B 后所有 relations 都没了', kept2.length === 0, String(kept2.length))
  check('★ 汇聚节点依然还在树上', !!findNode(root, newNodeId))

  check('pruneRelations 不改传入数组', (() => {
    const src = [{ from: 'a', to: 'b' }]
    pruneRelations(src, ['a'])
    return src.length === 1
  })())
  check('pruneRelations 接受 Set', pruneRelations(relations, new Set(['n1'])).length === 1)
  check('pruneRelations 空输入返回新空数组',
    pruneRelations(null, ['x']).length === 0 && pruneRelations([], []).length === 0)
  check('删掉的是 to 端也要剪', pruneRelations([{ from: 'a', to: 'b' }], ['b']).length === 0)
}

/* ================================================================== */
console.log('\n[9] 悬停相关线与阈值（五·2）')
/* ================================================================== */

{
  const rels = [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }, { from: 'x', to: 'y' }]
  check('relationsOf 取出与该节点相关的线（出发）',
    relationsOf(rels, 'a').length === 1 && relationsOf(rels, 'a')[0].to === 'c')
  check('relationsOf 取出与该节点相关的线（到达）',
    relationsOf(rels, 'c').length === 2, String(relationsOf(rels, 'c').length))
  check('relationsOf 对无关节点返回空', relationsOf(rels, 'zzz').length === 0)
  check('阈值常量是 50', RELATION_HIDE_THRESHOLD === 50, String(RELATION_HIDE_THRESHOLD))
  note(`relations 数量 > ${RELATION_HIDE_THRESHOLD} 时画布默认只画悬停相关的线`)
}

/* ================================================================== */
console.log('\n[10] 撤销：树和 relations 必须同进同退（四·1）')
/* ================================================================== */

{
  const root = fixture()
  const beforeShape = treeShape(root)

  // 模拟 App 的写入：先记快照（变更前的树 + 变更前的 relations），再改
  let hist = recordCanvasSnapshot(emptyCanvasHistory(), cloneTree(root, true), true, [])
  const r = convergeToNewNode(root, [], 'n1', 'n3')
  check('前置：生成成功', r.ok === true)

  const afterShape = treeShape(root)
  check('前置：树真的变了', !sameEdges(afterShape, beforeShape))
  check('前置：真的多了一个节点', allIds(root).length === 7, String(allIds(root).length))

  const u = undoCanvas(hist, root, r.relations)
  check('★ 撤销返回变更前的树', u && sameEdges(treeShape(u.tree), beforeShape),
    u && treeShape(u.tree).join(','))
  check('★ 撤销同时把 relations 退回空', u.relations.length === 0, String(u.relations.length))
  check('★ 撤销后汇聚节点消失', !findNode(u.tree, r.newNodeId))

  // 重做要把两边都装回来
  const re = redoCanvas(u.history, u.tree, u.relations)
  check('★ 重做后 relations 回来两条', re.relations.length === 2, String(re.relations.length))
  check('★ 重做后汇聚节点回来', !!findNode(re.tree, r.newNodeId))
  check('重做后树形与撤销前一致', sameEdges(treeShape(re.tree), afterShape))

  // 老式调用（不传 relations）不能崩 —— 兼容性
  const legacy = recordCanvasSnapshot(emptyCanvasHistory(), cloneTree(root, true), true)
  check('不传 relations 时快照里是空数组', legacy.past[0].relations.length === 0)
  const lu = undoCanvas(legacy, root)
  check('undoCanvas 不传 relations 也能工作', lu && Array.isArray(lu.relations))
  check('redoCanvas 不传 relations 也能工作',
    Array.isArray(redoCanvas(lu.history, lu.tree)?.relations))

  // sameRelations 语义
  check('sameRelations 忽略顺序',
    sameRelations([{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }],
      [{ from: 'b', to: 'c' }, { from: 'a', to: 'c' }]) === true)
  check('sameRelations 数量不同 → false',
    sameRelations([{ from: 'a', to: 'c' }], []) === false)
  check('sameRelations 内容不同 → false',
    sameRelations([{ from: 'a', to: 'c' }], [{ from: 'a', to: 'd' }]) === false)
  check('sameRelations 两边都空 → true', sameRelations([], []) === true)
  check('sameRelations 容忍 null', sameRelations(null, []) === true)
}

/* ================================================================== */
console.log('\n[11] 数据校验（本地存储 / 备份是用户可改的）')
/* ================================================================== */

{
  check('normalizeRelations 丢掉缺字段的',
    normalizeRelations([{ from: 'a' }, { to: 'b' }, {}]).length === 0)
  check('normalizeRelations 丢掉自环',
    normalizeRelations([{ from: 'a', to: 'a' }]).length === 0)
  check('normalizeRelations 去重',
    normalizeRelations([{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }]).length === 1)
  check('normalizeRelations 保留合法项',
    normalizeRelations([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]).length === 2)
  check('normalizeRelations 非数组返回空',
    normalizeRelations(null).length === 0 && normalizeRelations('x').length === 0)
  check('normalizeRelations 不修改原数组', (() => {
    const src = [{ from: 'a', to: 'a' }]
    normalizeRelations(src)
    return src.length === 1
  })())
}

/* ================================================================== */
console.log('\n[12] 反例：确认这些「不做」是对的')
/* ================================================================== */

{
  // 不存在的节点
  const root = fixture()
  const before = treeShape(root)
  check('节点不在树里 → 拒绝',
    convergeToNewNode(root, [], 'n1', 'ghost').reason === 'missing')
  check('拒绝时树没被动过', sameEdges(treeShape(root), before))

  // planConvergence 直测
  check('planConvergence 对同节点返回 self',
    planConvergence(fixture(), 'n1', 'n1').reason === 'self')
  const plan = planConvergence(fixture(), 'n2', 'n4')
  check('planConvergence 成功时给出 parentId',
    plan.ok === true && plan.parentId === 'n0', JSON.stringify(plan))

  // 单节点树：根自己跟自己
  const solo = makeNode('独苗'); solo.id = 's0'
  check('单节点树上汇聚被拒（自己和自己）',
    convergeToNewNode(solo, [], 's0', 's0').reason === 'self')
}

/* ================================================================== */
console.log('\n[13] 随机操作体检：连做 40 次增删移汇聚，树和 relations 都不许坏')

{
  /*
   * 上面每个用例都是「一次操作 + 断言」的定点检查。真正会出数据损坏的是
   * **连续操作**：拖到自己的子树里、删掉一个带汇聚关系的节点、汇聚出一个
   * 已经被删掉的父节点…… 单看每一步都合法，串起来才出环 / 丢节点 / 悬空引用。
   *
   * 这里用固定种子的伪随机操作串，每做一步就把三条不变量全查一遍：
   *   1. 树：id 不重复、无环、每个节点从根都恰好能走到一次
   *   2. relations：两端都在树里、无自环、无重复（normalizeRelations 之后）
   *   3. 删除后 relations 不留悬空引用（pruneRelations 的职责）
   *
   * 种子固定 ⇒ 失败能精确复现。
   */
  const rng = (seed) => {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  }

  /** 从根走一遍：返回 { ids, dup, cyclic } */
  const walkReport = (root) => {
    const seen = new Set([root.id])
    const dup = []
    let cyclic = false
    const onStack = new Set([root.id])
    const visit = (n) => {
      for (const c of n.children || []) {
        if (onStack.has(c.id)) cyclic = true
        if (seen.has(c.id)) dup.push(c.id)
        seen.add(c.id)
        onStack.add(c.id)
        visit(c)
        onStack.delete(c.id)
      }
    }
    visit(root)
    return { ids: [...seen], dup, cyclic }
  }

  const bad = { tree: [], rel: [], prune: [] }
  let ops = 0
  let converged = 0

  for (let seed = 1; seed <= 40; seed++) {
    const rnd = rng(seed * 40503 + 7)
    const root = makeNode('根')
    root.id = 'r0'
    const seq = { n: 1 }
    // 自己维护一份「应该还活着的 id」——只有这样才抓得住「节点还在、但从根走不到」
    const alive = new Set(['r0'])
    const mk = () => { const n = makeNode('x' + seq.n); n.id = 'r' + seq.n++; alive.add(n.id); return n }
    for (let i = 0; i < 6; i++) root.children.push(mk())
    let relations = []
    const tag = `seed=${seed}`

    for (let step = 0; step < 40; step++) {
      const ids = walkReport(root).ids
      const pick = () => ids[Math.floor(rnd() * ids.length)]
      const r = rnd()
      ops++

      if (r < 0.3) {
        // 移动：拖到任意目标、任意位置（含「拖进自己的子树」这种非法情形）
        moveNode(root, pick(), pick(), ['child', 'before', 'after'][Math.floor(rnd() * 3)])
      } else if (r < 0.55) {
        // 汇聚：随机挑两个不同节点
        const a = pick()
        const b = pick()
        if (a !== b) {
          const res = convergeToNewNode(root, relations, a, b)
          if (res.ok) { relations = res.relations; alive.add(res.newNodeId); converged++ }
        }
      } else if (r < 0.75) {
        // 新增节点
        const parent = findNode(root, pick())
        if (parent) parent.children.push(mk())
      } else {
        // 删除：连带清理 relations（App.jsx 里就是这两步）
        const id = pick()
        const target = findNode(root, id)
        const parent = findParent(root, id)
        if (target && parent) {
          const gone = subtreeIds(target)
          parent.children = parent.children.filter((c) => c.id !== id)
          for (const g of gone) alive.delete(g)
          relations = pruneRelations(relations, new Set(gone))
        }
      }

      // ---- 不变量 1：树（无环 / 无重复 id / 没有从根走不到的孤儿） ----
      const rep = walkReport(root)
      if (rep.cyclic) bad.tree.push(`${tag} step${step} 出现环`)
      if (rep.dup.length) bad.tree.push(`${tag} step${step} id 重复：${rep.dup.slice(0, 2)}`)
      const reached = new Set(rep.ids)
      for (const id of alive) {
        if (!reached.has(id)) { bad.tree.push(`${tag} step${step} 从根走不到 ${id}`); break }
      }
      if (reached.size !== alive.size) bad.tree.push(`${tag} step${step} 走到了不该存在的节点`)

      // ---- 不变量 2：relations 两端都在树里、无自环无重复 ----
      const norm = normalizeRelations(relations)
      for (const rel of norm) {
        if (!reached.has(rel.from) || !reached.has(rel.to)) {
          bad.rel.push(`${tag} step${step} 悬空：${rel.from}→${rel.to}`)
          break
        }
      }
      if (norm.length !== relations.length) bad.rel.push(`${tag} step${step} 有重复/自环没被 normalize 掉`)

      // ---- 不变量 3：pruneRelations 不碰无关的边 ----
      const pruned = pruneRelations(relations, ['r999'])
      if (pruned.length !== relations.length) bad.prune.push(`${tag} step${step} 剪掉了不存在的 id`)

      if (bad.tree.length || bad.rel.length || bad.prune.length) break
    }
    if (bad.tree.length || bad.rel.length || bad.prune.length) break
  }

  const brief = (arr) => arr.slice(0, 3).join(' | ')
  // 先确认这次体检真的跑到了汇聚（否则就是空跑）
  check(`随机操作覆盖到汇聚（${converged} 次成功汇聚 / 共 ${ops} 次操作）`, converged >= 40, `${converged}`)
  check('随机操作：树永远无环、无重复 id、节点不丢', bad.tree.length === 0, brief(bad.tree))
  check('随机操作：relations 两端永远在树里、无自环无重复', bad.rel.length === 0, brief(bad.rel))
  check('随机操作：pruneRelations 只剪该剪的', bad.prune.length === 0, brief(bad.prune))
}

/* ================================================================== */
console.log('\n==============================================')
console.log(`  汇聚关系 relate  通过 ${pass} / 失败 ${fail}`)
console.log('==============================================')
if (fail) process.exit(1)
