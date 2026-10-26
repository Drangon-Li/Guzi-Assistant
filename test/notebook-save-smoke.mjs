import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as notebook from '../src/shared/notebook.ts'

const source = readFileSync(new URL('../src/renderer/src/plugins/notebook/Page.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true
  }
}).outputText
const clone = (value) => structuredClone(value)
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function harness() {
  const rows = new Map(['a', 'b'].map((id) => [id, {
    id, title: id === 'a' ? 'Alpha' : 'Beta', content: `old-${id}`, tags: [`tag-${id}`],
    excerpt: `old-${id}`, folderId: id === 'b' ? 'work' : null, pinned: false, source: null,
    createdAt: '2026-10-24T10:00:00', updatedAt: '2026-10-24T10:00:00'
  }]))
  const hooks = []
  const timers = new Map()
  const effects = []
  const calls = []
  const participants = new Map()
  let updateFailure = false
  let delayUpdate = null
  let hookIndex = 0
  let timerId = 0
  let tree
  let delayGet = null
  const delayedSearches = new Map()
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i])
  const react = {
    useState(initial) {
      const index = hookIndex++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
    },
    useRef(initial) {
      const index = hookIndex++
      return hooks[index] ??= { current: initial }
    },
    useMemo(fn, deps) {
      const index = hookIndex++
      if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { value: fn(), deps }
      return hooks[index].value
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps) },
    useEffect(fn, deps) {
      const index = hookIndex++
      if (sameDeps(hooks[index]?.deps, deps)) return
      effects.push(() => {
        hooks[index]?.cleanup?.()
        hooks[index] = { deps, cleanup: fn() }
      })
    }
  }
  const plugin = async (_plugin, action, ...args) => {
    calls.push(action)
    if (action === 'list') return [...rows.values()].map(clone)
    if (action === 'folders') return [{ id: 'work', name: '工作', parentId: null, sortOrder: 0 }]
    if (action === 'prefs') return notebook.DEFAULT_NOTEBOOK_PREFS
    if (action === 'search') {
      const q = args[0].trim().toLowerCase()
      const ids = [...rows.values()].filter((row) =>
        [row.title, row.content, ...row.tags].some((value) => value.toLowerCase().includes(q))
      ).map((row) => row.id)
      if (delayedSearches.has(q)) {
        const waiting = delayedSearches.get(q)
        delayedSearches.delete(q)
        await waiting.promise
      }
      return ids
    }
    if (action === 'get') {
      const snapshot = clone(rows.get(args[0]) ?? null)
      if (delayGet?.id === args[0]) {
        const waiting = delayGet
        delayGet = null
        await waiting.promise
      }
      return snapshot
    }
    if (action === 'update') {
      if (delayUpdate) { const gate = delayUpdate; delayUpdate = null; await gate.promise }
      if (updateFailure) throw new Error('note disk full')
      const [id, patch] = args
      const normalized = { ...patch }
      if ('title' in patch) normalized.title = patch.title.trim().slice(0, 200) || '未命名'
      if ('tags' in patch) normalized.tags = notebook.normalizeTags(patch.tags)
      Object.assign(rows.get(id), normalized)
      rows.get(id).excerpt = notebook.excerptOf(rows.get(id).content)
      return true
    }
    if (action === 'create') {
      rows.set('new', { ...clone(rows.get('a')), ...args[0], id: 'new', title: '未命名', tags: [] })
      return { id: 'new' }
    }
    throw new Error(`Unexpected action: ${action}`)
  }
  const exports = {}
  const jsx = (type, props, key) => ({ type, props, key })
  vm.runInNewContext(compiled, {
    exports,
    require(id) {
      if (id === 'react') return react
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      if (id === '@shared/notebook') return notebook
      if (id === '../../api') return { api: { plugin } }
      if (id === '../../exit-lifecycle') return { useExitParticipant(p) { participants.set(p.id, p) }, registerExitParticipant(p) { participants.set(p.id, p); return () => participants.delete(p.id) }, clearExitSaveError() {}, trackExitSave: (promise) => promise }
      return { __esModule: true, default: id }
    },
    window: {
      setTimeout(fn) { timers.set(++timerId, fn); return timerId },
      clearTimeout(id) { timers.delete(id) },
      addEventListener() {}, removeEventListener() {}, confirm: () => true
    }
  })
  const nodes = (node) => !node || typeof node !== 'object' ? [] : Array.isArray(node)
    ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
  const text = (node) => node == null ? '' : typeof node !== 'object' ? String(node)
    : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children)
  const render = () => {
    hookIndex = 0
    tree = exports.default()
    while (effects.length) effects.shift()()
  }
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve))
    render()
  }
  const editor = () => nodes(tree).find((n) => n.type === './NoteEditor')?.props
  const open = async (title) => {
    const row = nodes(tree).find((n) => n.type === 'div' && n.props.className?.includes('cursor-default rounded-xl') && text(n).includes(title))
    assert.ok(row, `Missing note ${title}`)
    const request = row.props.onClick()
    await settle()
    return request
  }
  render()
  return {
    rows, calls, settle, open, editor,
    inspectExit: () => participants.get('notebook').isDirty(),
    prepareExit: () => participants.get('notebook').prepare('save'),
    failUpdate: (value) => { updateFailure = value },
    holdNextUpdate: () => { const gate = deferred(); delayUpdate = gate; return gate.resolve },
    visibleIds: () => nodes(tree).filter((n) => n.type === 'li' &&
      n.props.children?.props?.className?.includes('cursor-default rounded-xl')).map((n) => n.key),
    async query(value) {
      nodes(tree).find((n) => n.type === 'input' && n.props.placeholder === '搜索标题、正文或标签')
        .props.onChange({ target: { value } })
      render()
      await settle()
    },
    async folder(id) {
      nodes(tree).find((n) => n.type?.name === 'FolderRow').props.onSelect(id)
      render()
      await settle()
    },
    async tag(value) {
      nodes(tree).find((n) => n.type === 'button' && text(n).startsWith(value)).props.onClick()
      render()
      await settle()
    },
    async refresh() {
      nodes(tree).find((n) => n.type === 'button' && n.props.title === '记事本设置').props.onClick()
      render()
      nodes(tree).find((n) => n.type === './Settings').props.onClose()
      await settle()
    },
    async edit(patch) { editor().onChange(patch); render(); await settle() },
    async tick() {
      const pending = [...timers.values()]
      timers.clear()
      pending.forEach((fn) => fn())
      await settle()
    },
    async create() {
      nodes(tree).find((n) => n.type === 'button' && text(n) === '新建').props.onClick()
      await settle()
    },
    async unmount() {
      hooks.forEach((hook) => hook?.cleanup?.())
      await settle()
    },
    delayNextGet(id) { const gate = deferred(); delayGet = { id, ...gate }; return gate.resolve },
    delayNextSearch(query) { const gate = deferred(); delayedSearches.set(query.toLowerCase(), gate); return gate.resolve }
  }
}

async function run(name, test) {
  try { await test(); console.log(`✓ ${name}`) }
  catch (error) { console.error(`✗ ${name}: ${error.message}`); process.exitCode = 1 }
}
const setup = async () => { const h = harness(); await h.settle(); await h.open('Alpha'); return h }

await run('600ms 内不同字段合并保存，服务端规范化回写', async () => {
  const h = await setup()
  const initialCalls = h.calls.length
  await h.edit({ content: 'new-body' })
  await h.edit({ title: '  new-title  ' })
  await h.edit({ tags: ['#标签', '标签'] })
  await h.tick()
  assert.equal(h.rows.get('a').content, 'new-body')
  assert.equal(h.rows.get('a').title, 'new-title')
  assert.equal(h.editor().note.title, 'new-title')
  assert.deepEqual(h.editor().note.tags, notebook.normalizeTags(['#标签', '标签']))
  assert.equal(h.calls.filter((action) => action === 'update').length, 1)
  assert.deepEqual(h.calls.slice(initialCalls), ['update', 'get'])
})
await run('切换笔记立即提交上一篇，不被下一篇输入取消', async () => {
  const h = await setup()
  await h.edit({ content: 'saved-before-switch' })
  await h.open('Beta')
  assert.equal(h.rows.get('a').content, 'saved-before-switch')
  await h.edit({ content: 'new-b' })
  await h.tick()
  assert.equal(h.rows.get('a').content, 'saved-before-switch')
  assert.equal(h.rows.get('b').content, 'new-b')
})
await run('新建笔记前立即保存原笔记', async () => {
  const h = await setup()
  await h.edit({ content: 'saved-before-create' })
  await h.create()
  assert.equal(h.rows.get('a').content, 'saved-before-create')
  assert.equal(h.editor().note.id, 'new')
})
await run('离开页面立即保存，而非等待防抖', async () => {
  const h = await setup()
  await h.edit({ content: 'saved-before-unmount' })
  await h.unmount()
  assert.equal(h.rows.get('a').content, 'saved-before-unmount')
})
await run('旧保存响应不会切回旧笔记或覆盖新输入', async () => {
  const h = await setup()
  await h.edit({ title: '  first  ' })
  const release = h.delayNextGet('a')
  await h.tick()
  await h.edit({ title: 'second' })
  release()
  await h.settle()
  assert.equal(h.editor().note.title, 'second')
  await h.tick()
  const releaseAgain = h.delayNextGet('a')
  await h.edit({ title: 'third' })
  await h.tick()
  await h.open('Beta')
  releaseAgain()
  await h.settle()
  assert.equal(h.editor().note.id, 'b')
})
await run('切换笔记的读取响应乱序时只显示最后选择', async () => {
  const h = await setup()
  const release = h.delayNextGet('b')
  await h.open('Beta')
  await h.open('Alpha')
  release()
  await h.settle()
  assert.equal(h.editor().note.id, 'a')
})
await run('搜索防抖只请求最终关键词，旧响应不会覆盖新词', async () => {
  const h = await setup()
  await h.query('Al')
  await h.query('Alpha')
  assert.equal(h.calls.filter((action) => action === 'search').length, 0)
  const release = h.delayNextSearch('Alpha')
  await h.tick()
  await h.query('Beta')
  await h.tick()
  assert.deepEqual(h.visibleIds(), ['b'])
  release()
  await h.settle()
  assert.deepEqual(h.visibleIds(), ['b'])
  assert.equal(h.calls.filter((action) => action === 'search').length, 2)
})
await run('清空关键词立即恢复全部笔记，迟到的响应不再筛选', async () => {
  const h = await setup()
  const release = h.delayNextSearch('Alpha')
  await h.query('Alpha')
  await h.tick()
  await h.query('   ')
  assert.deepEqual(h.visibleIds().sort(), ['a', 'b'])
  release()
  await h.settle()
  assert.deepEqual(h.visibleIds().sort(), ['a', 'b'])
})
await run('全文命中与分类标签取交集，改变分类标签不重扫全文', async () => {
  const h = await setup()
  h.rows.get('a').content = '甲'.repeat(100) + 'shared phrase'
  h.rows.get('b').content = '```ts\nshared phrase\n```'
  await h.query('shared phrase')
  await h.tick()
  assert.deepEqual(h.visibleIds().sort(), ['a', 'b'])
  await h.folder('work')
  assert.deepEqual(h.visibleIds(), ['b'])
  await h.tag('tag-a')
  assert.deepEqual(h.visibleIds(), [])
  await h.folder('all')
  assert.deepEqual(h.visibleIds(), ['a'])
  assert.equal(h.calls.filter((action) => action === 'search').length, 1)
})
await run('保留原预览的Markdown去标记与换行合并短语匹配', async () => {
  const h = await setup()
  h.rows.get('a').content = '**line**\nbreak'
  h.rows.get('a').excerpt = notebook.excerptOf(h.rows.get('a').content)
  await h.refresh()
  await h.query('line break')
  await h.tick()
  assert.deepEqual(h.visibleIds(), ['a'])
})
await run('连续编辑不按每字符重扫全文，保存后刷新搜索命中', async () => {
  const h = await setup()
  await h.query('needle')
  await h.tick()
  assert.deepEqual(h.visibleIds(), [])
  await h.edit({ content: 'needle' })
  await h.edit({ content: 'needle new' })
  await h.edit({ content: 'needle new body' })
  assert.equal(h.calls.filter((action) => action === 'search').length, 1)
  await h.tick()
  await h.tick()
  assert.equal(h.calls.filter((action) => action === 'search').length, 2)
  assert.deepEqual(h.visibleIds(), ['a'])
})
await run('旧搜索命中已删除笔记时不将其重新加入列表', async () => {
  const h = await setup()
  const release = h.delayNextSearch('Alpha')
  await h.query('Alpha')
  await h.tick()
  h.rows.delete('a')
  await h.refresh()
  release()
  await h.settle()
  await h.tick()
  assert.deepEqual(h.visibleIds(), [])
})

await run('600ms防抖结束前退出仍保存最新笔记，失败保留补丁可重试', async () => {
  const h = await setup()
  await h.edit({ content: 'latest before debounce' })
  assert.equal(h.rows.get('a').content, 'old-a')
  assert.equal(h.inspectExit(), true)
  h.failUpdate(true)
  await assert.rejects(h.prepareExit(), /note disk full/)
  assert.equal(h.inspectExit(), true)
  h.failUpdate(false)
  await h.prepareExit()
  assert.equal(h.rows.get('a').content, 'latest before debounce')
  assert.equal(h.inspectExit(), false)
})
await run('退出等待已经发出的笔记写入，并继续保存期间产生的最后补丁', async () => {
  const h = await setup()
  const release = h.holdNextUpdate()
  await h.edit({ title: 'first pending' })
  const first = h.prepareExit()
  await h.settle()
  await h.edit({ content: 'final pending body' })
  let finished = false
  const last = h.prepareExit().then(() => { finished = true })
  await h.settle()
  assert.equal(finished, false)
  release()
  await Promise.all([first, last])
  assert.equal(h.rows.get('a').title, 'first pending')
  assert.equal(h.rows.get('a').content, 'final pending body')
})
