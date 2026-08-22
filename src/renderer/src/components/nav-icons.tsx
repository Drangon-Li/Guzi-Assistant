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

/** History：带回溯指针的时钟 */
export function IconHistory(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={cls} {...base}>
      <path d="M4.5 7.5V4.5h3" />
      <path d="M4.8 8.2A8 8 0 1 1 5 15" />
      <path d="M12 8v4l2.8 1.7" />
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
