// 法定节假日与调休补班日。
//
// 调休推不出来：国庆前的周日要补班，春节当中的周三却是假期。只能按国务院每年发布的
// 安排逐日录入——所以这里是一张手工维护的表，不是算法。
//
// 未收录的年份一律退回自然周（周六周日算周末，其余算工作日）。宁可退化，也不外推：
// 猜错的假期会让模板在错误的日子弹出来，比不提示更糟。

/** 一个具体日期的性质。三者互斥且穷尽。 */
export type DayType = 'workday' | 'weekend' | 'holiday'

export const ALL_DAY_TYPES: readonly DayType[] = ['workday', 'weekend', 'holiday']

export const DAY_TYPE_LABELS: Record<DayType, string> = {
  workday: '工作日',
  weekend: '周末',
  holiday: '节假日'
}

interface YearCalendar {
  /** 放假的日子（MM-DD），含落在周末的那几天——它们是节假日，不是普通周末 */
  off: readonly string[]
  /** 调休补班的日子（MM-DD），都在周末 */
  work: readonly string[]
}

// 数据来源：国务院办公厅《关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号，
// 2025-11-04 发布）。新一年的安排通常在前一年 11 月发布，届时在这里补一年。
const CALENDARS: Record<string, YearCalendar> = {
  '2026': {
    off: [
      '01-01', '01-02', '01-03',
      '02-15', '02-16', '02-17', '02-18', '02-19', '02-20', '02-21', '02-22', '02-23',
      '04-04', '04-05', '04-06',
      '05-01', '05-02', '05-03', '05-04', '05-05',
      '06-19', '06-20', '06-21',
      '09-25', '09-26', '09-27',
      '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07'
    ],
    work: ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10']
  }
}

/** 这一年的节假日安排是否已录入。没录入不是错误，只是会退回自然周。 */
export function hasCalendar(year: string): boolean {
  return year in CALENDARS
}

/** 已录入安排的年份，升序。 */
export function coveredYears(): string[] {
  return Object.keys(CALENDARS).sort()
}

/**
 * 某一天算什么日子。
 *
 * 日期非法时 getDay() 得到 NaN，两个相等判断都不成立，自然落到 'workday'——
 * 调用方都传 dayKey() 的产物，不值得为此多写一个分支。
 */
export function dayTypeOf(date: string): DayType {
  const cal = CALENDARS[date.slice(0, 4)]
  if (cal) {
    const md = date.slice(5)
    if (cal.off.includes(md)) return 'holiday'
    if (cal.work.includes(md)) return 'workday'
  }
  const weekday = new Date(`${date}T12:00:00`).getDay()
  return weekday === 0 || weekday === 6 ? 'weekend' : 'workday'
}

/** 归一：丢掉不认识的值、去重并按固定顺序排列。 */
export function normalizeDayTypes(input: unknown): DayType[] {
  if (!Array.isArray(input)) return [...ALL_DAY_TYPES]
  const kept = ALL_DAY_TYPES.filter((t) => input.includes(t))
  return kept
}
