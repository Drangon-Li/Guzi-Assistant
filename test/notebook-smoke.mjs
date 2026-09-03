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
  clampFontScale,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  normalizePrefs,
  normalizeTags,
  noteTimeOf,
  sortNotes,
  titleFromContent,
  visibleToAssistant
} from '../src/shared/notebook.ts'
import {
  collectHeadings,
  colorToken,
  markdownBlockRule,
  renderNoteHTML
} from '../src/renderer/src/plugins/notebook/markdown.ts'

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

// ---------- 偏好与「谷子能看到哪些」 ----------
// 这组决定哪些内容会进对话提示词，漏一条就是把用户不想给的东西给出去了。
check('默认显示最后修改', normalizePrefs(null).timeField === 'updated')
check('认得创建时间', normalizePrefs({ timeField: 'created' }).timeField === 'created')
check('非法口径落回默认', normalizePrefs({ timeField: '乱填' }).timeField === 'updated')
check('排除列表只收字符串', eq(normalizePrefs({ hiddenNotes: ['a', 3, null] }).hiddenNotes, ['a']))
check('字号默认 1 倍', normalizePrefs(null).fontScale === 1)
check('字号夹到上限', normalizePrefs({ fontScale: 99 }).fontScale === FONT_SCALE_MAX)
check('字号夹到下限', normalizePrefs({ fontScale: 0.1 }).fontScale === FONT_SCALE_MIN)
check('字号 NaN 落回 1', normalizePrefs({ fontScale: NaN }).fontScale === 1)
check('字号字符串落回 1', normalizePrefs({ fontScale: '大' }).fontScale === 1)
check('字号对齐到步进', clampFontScale(1.23) === 1.2)
check('沉浸模式默认关', normalizePrefs(null).immersive === false)
check('沉浸模式只认 true', normalizePrefs({ immersive: 'yes' }).immersive === false)
check('沉浸模式认 true', normalizePrefs({ immersive: true }).immersive === true)
check('缺字段补空数组', eq(normalizePrefs({}).hiddenFolders, []))

const VIS_FOLDERS = [folder('f1', '公开'), folder('f2', '私密'), folder('f3', '私密子', 'f2')]
const VIS_NOTES = [
  note('open', { folderId: 'f1' }),
  note('secret', { folderId: 'f2' }),
  note('deep', { folderId: 'f3' }),
  note('loose', { folderId: null }),
  note('single', { folderId: 'f1' })
]
const visIds = (prefs) => visibleToAssistant(VIS_NOTES, VIS_FOLDERS, normalizePrefs(prefs)).map((n) => n.id)

check('默认全部可见', eq(visIds({}), ['open', 'secret', 'deep', 'loose', 'single']))
check('排除分类后整批不给', !visIds({ hiddenFolders: ['f2'] }).includes('secret'))
check('子分类跟着父分类一起藏', !visIds({ hiddenFolders: ['f2'] }).includes('deep'))
check('没被排除的分类不受影响', visIds({ hiddenFolders: ['f2'] }).includes('open'))
check('未分类可单独排除', !visIds({ hiddenFolders: ['__none__'] }).includes('loose'))
check('排除未分类不影响有分类的', visIds({ hiddenFolders: ['__none__'] }).includes('open'))
check('单篇排除生效', !visIds({ hiddenNotes: ['single'] }).includes('single'))
check('单篇排除不牵连同分类的', visIds({ hiddenNotes: ['single'] }).includes('open'))
check('分类与单篇同时排除', eq(visIds({ hiddenFolders: ['f2', '__none__'], hiddenNotes: ['single'] }), ['open']))
check('全排除得到空', visIds({ hiddenFolders: ['f1', 'f2', '__none__'] }).length === 0)

check('时间口径取创建', noteTimeOf(note('x', { createdAt: 'C', updatedAt: 'U' }), normalizePrefs({ timeField: 'created' })) === 'C')
check('时间口径取修改', noteTimeOf(note('x', { createdAt: 'C', updatedAt: 'U' }), normalizePrefs({})) === 'U')

// ---------- 图片引用 ----------
// 正文只存文件名，图片本体在 userData 下。这条正则同时是白名单：
// 不合形状的一律不当图片，挡住 ../ 和外部 URL。
const SHA = 'a'.repeat(64)
check('asset 图片还原成 img', html(`![猫](asset:${SHA}.png)`).includes(`<img data-asset="${SHA}.png" alt="猫">`))
check('jpg/webp/gif 也认', html(`![](asset:${SHA}.webp)`).includes('<img data-asset='))
check('空 alt 不报错', html(`![](asset:${SHA}.png)`).includes('alt=""'))
check('路径穿越不成图', !html('![x](asset:../../etc/passwd)').includes('<img'))
check('外部图片地址不成图', !html('![x](https://evil.com/a.png)').includes('<img'))
check('哈希长度不对不成图', !html('![x](asset:abc.png)').includes('<img'))
check('扩展名不在白名单不成图', !html(`![x](asset:${SHA}.svg)`).includes('<img'))
// ---- 公式（KaTeX）----
check('行内公式渲染成原子节点', html('质能 $E=mc^2$ 方程').includes('note-math-inline'))
check('块级公式独占一块', html('$$x^2$$').includes('class="note-math"'))
check('KaTeX 真的渲染了', html('$E=mc^2$').includes('katex'))
check('源码留在 data-tex 上供还原', /data-tex="E=mc\^2"/.test(html('$E=mc^2$')))
check('公式内容不被转义规则啃掉', /data-tex="a_1 \+ b_2"/.test(html('$a_1 + b_2$')))
check(
  '公式外的强调照常生效',
  html('$x$ 和 **粗体**').includes('note-math-inline') && html('$x$ 和 **粗体**').includes('<strong>')
)
check('单个 $ 不触发公式', !html('价格是 $5 元').includes('note-math'))
check(
  '公式里的反斜杠命令保留',
  /data-tex="\\frac{a}{b}"/.test(html('$$\\frac{a}{b}$$'))
)
check('语法错误不炸整篇', html('$\\bogus{}$').length > 0)

check(
  '图片排在链接之前解析',
  html(`![图](asset:${SHA}.png)`).includes('<img') && !html(`![图](asset:${SHA}.png)`).includes('<a ')
)

// ---- Markdown 输入规则（块首打前缀 + 空格就地变块）----
check('# → 一级标题', markdownBlockRule('#') === 'h1')
check('## → 二级标题', markdownBlockRule('##') === 'h2')
check('### → 三级标题', markdownBlockRule('###') === 'h3')
check('#### 不是规则（只到三级）', markdownBlockRule('####') === null)
check('> → 引用', markdownBlockRule('>') === 'quote')
check('- → 项目列表', markdownBlockRule('-') === 'ul')
check('* → 项目列表', markdownBlockRule('*') === 'ul')
check('1. → 编号列表', markdownBlockRule('1.') === 'ol')
check('中文顿号编号也认', markdownBlockRule('12、') === 'ol')
check('[] → 待办', markdownBlockRule('[]') === 'todo')
check('[x] → 待办', markdownBlockRule('[x]') === 'todo')
check('``` → 代码块', markdownBlockRule('```') === 'code')
check('--- → 分隔线', markdownBlockRule('---') === 'divider')
check('普通文字不触发', markdownBlockRule('标题') === null)
check('空串不触发', markdownBlockRule('') === null)
check('前缀前有空格 → 不触发（不在块首）', markdownBlockRule(' #') === null)
check('前缀后已有文字 → 不触发', markdownBlockRule('# 标题') === null)
check('正文中间的 # 不触发', markdownBlockRule('见 #') === null)

// ---- 右侧目录：从渲染后的 DOM 抽标题 ----
// collectHeadings 要真实 DOM，用一个最小的假实现顶上（只需要 querySelectorAll + textContent + tagName）
function fakeEditor(items) {
  return {
    querySelectorAll: (sel) => {
      if (!/h1/.test(sel)) return []
      const arr = items.map((it) => ({ tagName: `H${it.level}`, textContent: it.text }))
      arr.forEach = Array.prototype.forEach.bind(arr)
      return arr
    }
  }
}
const toc = collectHeadings(fakeEditor([
  { level: 1, text: '第一章' },
  { level: 2, text: '小节 A' },
  { level: 3, text: '细节' },
  { level: 1, text: '第二章' }
]))
check('抽出全部标题', toc.length === 4)
check('层级解析正确', toc.map((h) => h.level).join(',') === '1,2,3,1')
check('文字保留', toc[1].text === '小节 A')
check('下标按文档顺序', toc.map((h) => h.index).join(',') === '0,1,2,3')
check('没有标题时目录为空', collectHeadings(fakeEditor([])).length === 0)
const withEmpty = collectHeadings(fakeEditor([
  { level: 1, text: '有内容' },
  { level: 2, text: '   ' },
  { level: 2, text: '后一条' }
]))
check('空标题不进目录', withEmpty.length === 2)
check(
  '空标题仍占下标（否则点击会跳错行）',
  withEmpty[1].index === 2
)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
