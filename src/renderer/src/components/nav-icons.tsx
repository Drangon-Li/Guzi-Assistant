/**
 * 侧边栏导航图标：手绘成套，统一 24 视窗 / 1.7 线宽 / 圆头圆角。
 * stroke=currentColor 跟随按钮文字色——未选中 slate、选中即品牌橙，不引入任何新颜色。
 */

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

const cls = 'size-4 shrink-0'

/** 今日：日出 */
export function IconToday(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <path d="M4 17h16" />
      <path d="M8 17a4 4 0 0 1 8 0" />
      <path d="M12 8.5V5.5" />
      <path d="M6.4 10.4 4.6 8.6" />
      <path d="M17.6 10.4l1.8-1.8" />
    </svg>
  )
}

/** 日程：日历 */
export function IconSchedule(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10.5h16" />
      <path d="M8.5 3.5v3" />
      <path d="M15.5 3.5v3" />
    </svg>
  )
}

/** 日报：带折角的文档 */
export function IconReport(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <path d="M6.5 5A1.5 1.5 0 0 1 8 3.5h6L17.5 7v12a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19Z" />
      <path d="M14 3.5V7h3.5" />
      <path d="M9.5 12.5h5" />
      <path d="M9.5 16h5" />
    </svg>
  )
}

/** 分析：基线上的三根柱 */
export function IconAnalysis(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <path d="M4 20h16" />
      <path d="M7.5 20v-5.5" />
      <path d="M12 20V6.5" />
      <path d="M16.5 20v-9" />
    </svg>
  )
}

/** 个人：人形 */
export function IconAccount(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 20c1-3.6 3.6-5.2 6.5-5.2s5.5 1.6 6.5 5.2" />
    </svg>
  )
}

/** 设置：调节滑杆 */
export function IconSettings(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <path d="M4.5 7.5h15" />
      <circle cx="14.5" cy="7.5" r="2.2" />
      <path d="M4.5 16.5h15" />
      <circle cx="9" cy="16.5" r="2.2" />
    </svg>
  )
}

/** 市场：货架上的箱子 */
export function IconMarket(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <path d="M4 8.5h16l-1.2 11a1.5 1.5 0 0 1-1.5 1.3H6.7a1.5 1.5 0 0 1-1.5-1.3Z" />
      <path d="M8.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5" />
      <path d="M10 13.5h4" />
    </svg>
  )
}

/** 作息：一天的时间轴，右侧是排好的块 */
export function IconTimeblock(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <path d="M6 3.5v17" />
      <rect x="9.5" y="5" width="10" height="4.5" rx="1.3" />
      <rect x="9.5" y="12" width="7" height="4.5" rx="1.3" />
      <path d="M6 7.2h3.5" />
      <path d="M6 14.2h3.5" />
    </svg>
  )
}

/** 专注：番茄钟的表盘 */
export function IconPomodoro(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 9.5v4l2.5 1.6" />
      <path d="M9.5 3.5h5" />
      <path d="M12 3.5V6" />
    </svg>
  )
}

/** 打卡：勾选框 */
export function IconHabit(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <rect x="4" y="5" width="16" height="15" rx="2.5" />
      <path d="M8.2 12.6l2.6 2.6 5-5.4" />
    </svg>
  )
}

/** 成就：一支谷穗 */
export function IconAchievement(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <path d="M12 20.5V8.5" />
      <path d="M12 8.5c0-2.2 1.4-4 3.4-4.5.3 2.4-1 4.5-3.4 4.5Z" />
      <path d="M12 8.5C12 6.3 10.6 4.5 8.6 4c-.3 2.4 1 4.5 3.4 4.5Z" />
      <path d="M12 14c0-2 1.3-3.6 3.1-4.1.3 2.2-.9 4.1-3.1 4.1Z" />
      <path d="M12 14c0-2-1.3-3.6-3.1-4.1-.3 2.2.9 4.1 3.1 4.1Z" />
    </svg>
  )
}
