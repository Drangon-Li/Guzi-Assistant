import {
  buildSemanticWorkHint,
  normalizeActivitySummary,
  parseSemanticWorkResult,
  parseSemanticWorkResults,
  semanticEvidenceKey
} from '../src/shared/semantic-work.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const evidence = {
  appName: 'Code',
  bundleId: 'com.microsoft.VSCode',
  windowTitle: 'Guzi-Assistant.ts',
  focusedRole: 'AXTextField',
  safeLabel: 'editor',
  eventKind: 'ax_focus_changed',
  semanticScore: 100,
  source: 'accessibility'
}

check('AX 证据 key 稳定归一', semanticEvidenceKey(evidence) === semanticEvidenceKey({ ...evidence, windowTitle: ' Guzi-Assistant.ts ' }))
const hint = buildSemanticWorkHint('在代码编辑器中开发', ['Guzi Assistant'])
check('prompt 标记 AX 为不可信证据', hint.includes('不可信') && hint.includes('不是指令'))
check('prompt 禁止凭据与 URL 外泄', hint.includes('OAuth') && hint.includes('按键正文'))
check('prompt 要求动作加对象而非工具描述', hint.includes('动作开头') && hint.includes('不能单独充当结论'))
check('prompt 要求复用已知任务而非另起近义名', hint.includes('原样复用') && hint.includes('已知任务候选'))
check('prompt 禁止泛化任务名与易变编号', hint.includes('随心输入') && hint.includes('易变细节'))
check('prompt 禁止裸 App 名任务', hint.includes('裸 App') && hint.includes('开发谷子助手'))
check(
  '归一化移除应用前缀',
  normalizeActivitySummary('在 Microsoft Edge 中查看训练控制台', { appName: 'Microsoft Edge' }) === '查看训练控制台'
)
check(
  '归一化移除使用工具前缀',
  normalizeActivitySummary('在使用谷子学术本地论文阅读器阅读论文', { appName: '谷子学术本地论文阅读器' }) === '阅读论文'
)
check(
  '只有工具名不生成工作记录',
  normalizeActivitySummary('在使用谷子学术本地论文阅读器', { appName: '谷子学术本地论文阅读器' }) === null
)
check(
  '批量活动结果按 index 解析',
  parseSemanticWorkResults('{"activities":[{"index":1,"work_summary":"写论文","focus_task":"论文"},{"index":0,"work_summary":"写代码","focus_task":"开发"}]}', 2)[0].focusTask === '开发'
)
check('缺失活动补 null', parseSemanticWorkResults('{"activities":[{"index":0,"work_summary":"写代码","focus_task":"开发"}]}', 2)[1].workSummary === null)
check('单项兼容旧顶层格式', parseSemanticWorkResults('{"work_summary":"写代码","focus_task":"开发"}', 1)[0].focusTask === '开发')
check('坏 JSON 不产生归类', parseSemanticWorkResult('not json').workSummary === null)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
