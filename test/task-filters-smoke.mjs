// 纯函数单测：isFinishedEvent（#9 已结束的纯开始时间任务）。运行：npm run test:filters
import { isFinishedEvent } from '../src/shared/task-filters.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const NOW = new Date(2026, 5, 14, 12, 0) // 2026-06-14 12:00
function mk(o) {
  return {
    id: 'x', sourceId: null, title: 't', itemType: 'meeting', belongsToUser: 'yes',
    belongingReason: '', userRole: 'owner', startTime: null, dueTime: null, location: null,
    priority: 'unknown', confidence: 0.9, suggestedAction: 'confirm', evidence: [], notes: [],
    duplicateOf: null, status: 'scheduled', feedback: null, createdAt: '', updatedAt: '', ...o
  }
}

check('过去的纯开始时间任务 → 已结束', isFinishedEvent(mk({ startTime: '2026-06-14T09:00' }), NOW))
check('更早几天的纯开始任务 → 已结束', isFinishedEvent(mk({ startTime: '2026-06-10T15:00' }), NOW))
check('未来开始时间 → 不算', !isFinishedEvent(mk({ startTime: '2026-06-14T18:00' }), NOW))
check('有截止时间 → 不算（归 overdue 体系）', !isFinishedEvent(mk({ startTime: '2026-06-14T09:00', dueTime: '2026-06-14T10:00' }), NOW))
check('无开始时间 → 不算', !isFinishedEvent(mk({}), NOW))
check('已完成 → 不算', !isFinishedEvent(mk({ startTime: '2026-06-14T09:00', status: 'done' }), NOW))
check('已忽略 → 不算', !isFinishedEvent(mk({ startTime: '2026-06-14T09:00', status: 'ignored' }), NOW))
check('overdue → 不算', !isFinishedEvent(mk({ startTime: '2026-06-14T09:00', status: 'overdue' }), NOW))
check('进行中且过去 → 算', isFinishedEvent(mk({ startTime: '2026-06-14T08:00', status: 'in_progress' }), NOW))
check('非法时间 → 不算', !isFinishedEvent(mk({ startTime: '不是时间' }), NOW))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
