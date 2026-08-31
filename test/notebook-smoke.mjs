// 纯函数单测：记事本插件的分类树、标签、筛选与 Markdown 渲染。运行：npm run test notebook
//
// 重点卡三件事：
//  1. **分类树不能因为脏数据塌掉**——父级不存在要挂回顶层，成环不能让建树递归爆栈
//  2. **删分类不删笔记**的前提是移动分类时挡住「把父级拖进自己的子孙」，靠 descendantIds
//  3. **颜色是白名单**：只有七个 token 的精确标签能变成真 HTML，别的一律保持转义
import {
  buildFolderTree,
  collectTags,
  descendantIds,
  excerptOf,
  filterNotes,
  normalizeTags,
  sortNotes,
  titleFromContent
} from '../src/shared/notebook.ts'
import { colorToken, renderNoteHTML } from '../src/renderer/src/plugins/notebook/markdown.ts'

let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const folder = (id, name, parentId = null, sortOrder = 0) => ({
  id,
  name,
  parentId,
  sortOrder,
  createdAt: '2026-08-31T10:00:00'
})
const note = (id, over = {}) => ({
  id,
  folderId: null,
  title: id,
  excerpt: '',
  tags: [],
  pinned: false,
  source: null,
  createdAt: '2026-08-31T10:00:00',
  updatedAt: '2026-08-31T10:00:00',
  ...over
})

// ---------- 摘要 ----------
check('去掉标题符号', excerptOf('# 标题') === '标题')
check('去掉加粗与行内代码', excerptOf('这是 **粗** 和 `码`') === '这是 粗 和 码')
check('去掉高亮标签只留文字', excerptOf('看 <mark data-color="yellow">这里</mark>') === '看 这里')
check('去掉颜色标签只留文字', excerptOf('看 <span data-color="red">这里</span>') === '看 这里')
check('整段代码块丢掉', excerptOf('说明\n```js\nlet a = 1\n```').trim() === '说明')
check('列表符号去掉', excerptOf('- 一\n- 二') === '一 二')
check('待办框去掉', excerptOf('- [x] 做完了') === '做完了')
check('链接只留文字', excerptOf('见 [文档](https://a.com)') === '见 文档')
check('超长截断带省略号', excerptOf('a'.repeat(200)).endsWith('…'))
check('空正文得到空串', excerptOf('') === '')

// ---------- 分类树 ----------
const FOLDERS = [
  folder('a', '甲'),
  folder('b', '乙', 'a'),
  folder('c', '丙', 'b'),
  folder('d', '丁')
]
const tree = buildFolderTree(FOLDERS, [{ folderId: 'b' }, { folderId: 'b' }, { folderId: 'd' }])
const at = (list, id) => list.find((n) => n.id === id)
check('顶层只有两个', tree.length === 2)
check('嵌套挂对了', at(tree, 'a').children[0].id === 'b' && at(tree, 'a').children[0].children[0].id === 'c')
check('只数直属笔记', at(tree, 'a').children[0].noteCount === 2)
check('父分类不把子分类的笔记算进来', at(tree, 'a').noteCount === 0)
check('顶层分类自己的笔记也数得到', at(tree, 'd').noteCount === 1)

const orphan = buildFolderTree([folder('x', '孤儿', '不存在的爹')])
check('父级不存在时挂回顶层', orphan.length === 1 && orphan[0].id === 'x')

const cyclic = buildFolderTree([folder('p', '甲', 'q'), folder('q', '乙', 'p')])
check('成环不爆栈也不凭空多出根', Array.isArray(cyclic) && cyclic.length === 0)

const sorted = buildFolderTree([folder('m', '乙', null, 2), folder('n', '甲', null, 1)])
check('按 sortOrder 排', sorted[0].id === 'n')

// ---------- 子孙判定（挡住把父级拖进自己的子级） ----------
check('含自己', descendantIds(FOLDERS, 'a').includes('a'))
check('含孙子', descendantIds(FOLDERS, 'a').includes('c'))
check('不含兄弟', !descendantIds(FOLDERS, 'a').includes('d'))
check('叶子只有自己', eq(descendantIds(FOLDERS, 'c'), ['c']))
check('成环时能停下来', descendantIds([folder('p', '甲', 'q'), folder('q', '乙', 'p')], 'p').length === 2)

// ---------- 标签 ----------
const NOTES = [
  note('n1', { tags: ['论文', '想法'], folderId: 'a', title: '读了一篇', excerpt: '关于注意力' }),
  note('n2', { tags: ['论文'], folderId: null, title: '随手记' }),
  note('n3', { tags: ['想法', '论文'], folderId: 'b', pinned: true, updatedAt: '2026-08-30T10:00:00' })
]
check('按用量排序', eq(collectTags(NOTES).map((t) => t.tag), ['论文', '想法']))
check('用量数对', collectTags(NOTES)[0].count === 3)
check('无标签得到空数组', eq(collectTags([note('x')]), []))

check('去空白去重', eq(normalizeTags([' 甲 ', '甲', '乙']), ['甲', '乙']))
check('丢掉空串和非字符串', eq(normalizeTags(['', null, 3, '甲']), ['甲']))
check('单个标签截断到 24 字', normalizeTags(['x'.repeat(50)])[0].length === 24)
check('最多 20 个', normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length === 20)

// ---------- 筛选 ----------
check('全部', filterNotes(NOTES, { folderId: 'all' }).length === 3)
check('按分类', eq(filterNotes(NOTES, { folderId: 'a' }).map((n) => n.id), ['n1']))
check('未分类', eq(filterNotes(NOTES, { folderId: 'none' }).map((n) => n.id), ['n2']))
check('按标签', filterNotes(NOTES, { tag: '想法' }).length === 2)
check('关键词匹标题', eq(filterNotes(NOTES, { query: '随手' }).map((n) => n.id), ['n2']))
check('关键词匹预览', eq(filterNotes(NOTES, { query: '注意力' }).map((n) => n.id), ['n1']))
check('关键词匹标签', filterNotes(NOTES, { query: '论文' }).length === 3)
check('条件同时生效', filterNotes(NOTES, { folderId: 'a', tag: '想法' }).length === 1)
check('条件互斥时为空', filterNotes(NOTES, { folderId: 'a', tag: '不存在' }).length === 0)

// ---------- 排序 ----------
const ordered = sortNotes(NOTES)
check('置顶的排最前', ordered[0].id === 'n3')
check('其余按最近改动', ordered[1].updatedAt >= ordered[2].updatedAt)

// ---------- 标题推导 ----------
check('取首行', titleFromContent('# 我的笔记\n正文') === '我的笔记')
check('跳过空行', titleFromContent('\n\n正文在这') === '正文在这')
check('全空用兜底', titleFromContent('   ', '未命名') === '未命名')

// ---------- 颜色 token ----------
check('认识的颜色', colorToken('yellow') === 'yellow')
check('大小写归一', colorToken('  RED  ') === 'red')
check('不认识的落到兜底', colorToken('#ff0000', 'yellow') === 'yellow')
check('没有兜底时返回空串', colorToken('浅蓝') === '')

// ---------- Markdown → HTML ----------
const html = (md) => renderNoteHTML(md)
check('标题', html('# 甲').includes('<h1>甲</h1>'))
check('加粗', html('**粗**').includes('<strong>粗</strong>'))
check('斜体', html('*斜*').includes('<em>斜</em>'))
check('删除线', html('~~删~~').includes('<del>删</del>'))
check('行内代码', html('`码`').includes('<code>码</code>'))
check('无序列表', html('- 一\n- 二').includes('<ul><li>一</li><li>二</li></ul>'))
check('有序列表', html('1. 一').includes('<ol><li>一</li></ol>'))
check('待办已勾', html('- [x] 做完').includes('data-checked="true"'))
check('待办未勾', html('- [ ] 没做').includes('data-checked="false"'))
check('引用', html('> 引').includes('<blockquote>引</blockquote>'))
check('分隔线', html('---').includes('<hr>'))
check('代码块保留语言', html('```js\nlet a\n```').includes('class="language-js"'))
check('代码块内容不被当标记', html('```\n**不粗**\n```').includes('**不粗**'))
check('链接只认 http(s)', html('[x](https://a.com)').includes('href="https://a.com"'))
check('javascript 协议不成链接', !html('[x](javascript:alert(1))').includes('<a '))
check('空正文给一个空段落', html('') === '<p><br></p>')

// 白名单：只有七个 token 的精确标签能还原成真 HTML
check('高亮标签还原', html('<mark data-color="yellow">黄</mark>').includes('<mark class="note-mark note-mark-yellow"'))
check('颜色标签还原', html('<span data-color="red">红</span>').includes('<span class="note-color note-color-red"'))
check(
  '不认识的颜色保持转义',
  html('<mark data-color="chartreuse">x</mark>').includes('&lt;mark') &&
    !html('<mark data-color="chartreuse">x</mark>').includes('<mark ')
)
check('script 标签保持转义', !html('<script>alert(1)</script>').includes('<script'))
check('img onerror 保持转义', !html('<img src=x onerror=alert(1)>').includes('<img'))
check('带别的属性的 mark 不还原', !html('<mark data-color="red" onclick="x()">y</mark>').includes('<mark class'))
check('高亮里的加粗照常解析', html('<mark data-color="blue">**粗**</mark>').includes('<strong>粗</strong>'))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
