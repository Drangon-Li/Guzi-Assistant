// SQLite 数据层的统一出口。实现按表的领域拆到 ./db/ 下，这里只做 re-export，
// 让主进程各处的 `from './db'` 保持不变。新增数据函数请加到对应领域模块，不要写在这里。

export { localNow } from '@shared/parsing'
export * from './db/connection.ts'
export * from './db/settings.ts'
export * from './db/sources.ts'
export * from './db/tasks.ts'
export * from './db/detections.ts'
export * from './db/work-records.ts'
export * from './db/app-usage.ts'
export * from './db/activity.ts'
export * from './db/reports.ts'
export * from './db/chat.ts'
export * from './db/memory.ts'
export * from './db/maintenance.ts'
