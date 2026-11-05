// 飞书消息正文还原：@ 占位符按 mentions 换回真名，归属判断才知道点了谁。
// Run: node test/feishu-message-smoke.mjs
import assert from 'node:assert/strict'
import { flattenPost, restoreMentions } from '../src/shared/feishu-message.ts'

const lin = { key: '@_user_1', name: '林小谷' }
const wang = { key: '@_user_2', name: '王磊' }

assert.equal(restoreMentions('@_user_1 明天下午两点来3楼会议室', [lin]), '@林小谷 明天下午两点来3楼会议室')
assert.equal(restoreMentions('@_user_1 写接口，@_user_2 做压测', [lin, wang]), '@林小谷 写接口，@王磊 做压测')
console.log('✓ 文本消息：@ 占位符换回真名，多人各归各位')

assert.equal(restoreMentions('@_all 周五前交周报', []), '@所有人 周五前交周报')
console.log('✓ @_all → @所有人（归属规则据此判待确认）')

assert.equal(restoreMentions('@_user_10 和 @_user_1', [lin, { key: '@_user_10', name: '陈晨' }]), '@陈晨 和 @林小谷')
console.log('✓ @_user_1 与 @_user_10 不会互相吞')

assert.equal(restoreMentions('@_user_3 你好', [lin]).trim(), '你好')
assert.equal(restoreMentions('@_user_1 你好', [{ key: '@_user_1', name: '  ' }]).trim(), '你好')
assert.equal(restoreMentions('@_user_1 你好', undefined).trim(), '你好')
console.log('✓ 对不上名字的占位符照旧删掉，不留乱码')

assert.equal(restoreMentions('邮件抄送 a@_user_name.com 不动', [lin]), '邮件抄送 a@_user_name.com 不动')
assert.equal(restoreMentions('普通文本 @林小谷 不变', [lin]), '普通文本 @林小谷 不变')
console.log('✓ 不是占位符的 @ 原样保留')

const post = {
  title: '周四发版安排',
  content: [
    [{ tag: 'text', text: '前端：' }, { tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: ' 负责灰度开关' }],
    [{ tag: 'text', text: '后端：' }, { tag: 'at', user_id: '@_user_9', user_name: '陈晨' }, { tag: 'text', text: ' 负责数据迁移' }],
    [{ tag: 'at', user_id: 'all' }, { tag: 'text', text: ' 发版群见 ' }, { tag: 'a', href: 'https://example.com/plan', text: '方案' }],
    [{ tag: 'at', user_id: '@_user_8' }, { tag: 'text', text: ' 抄送' }]
  ]
}
assert.equal(
  flattenPost(post, [lin]),
  '周四发版安排\n前端：@林小谷 负责灰度开关\n后端：@陈晨 负责数据迁移\n@所有人 发版群见 方案\n 抄送'
)
assert.equal(flattenPost({ content: [[{ tag: 'a', href: 'https://example.com' }]] }), 'https://example.com')
console.log('✓ 富文本：at 节点还原（mentions 优先，其次 user_name），标题与链接保留')

console.log('\nAll feishu-message tests passed')
