/**
 * 成就图标：自绘的谷穗系列，12 个语义名对应 shared/achievement.ts 的 AchievementIcon。
 *
 * 刻意不用第三方游戏素材——谷子助手是公开发行的安装包，带别人的美术资源有版权风险。
 * 造型上跟着现有的 GrainEar.tsx 品牌图形走：32 视窗、1.6 线宽、圆头圆角、
 * stroke=currentColor，未解锁时整体降透明度即可，不需要另做一套灰版。
 */
import type { AchievementIcon } from '@shared/achievement'

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

const PATHS: Record<AchievementIcon, React.ReactNode> = {
  // 种子：一粒
  seed: <path d="M16 9c3.4 1.8 5 4.7 5 8a5 5 0 0 1-10 0c0-3.3 1.6-6.2 5-8Z" />,
  // 芽：两片子叶
  sprout: (
    <>
      <path d="M16 25v-8" />
      <path d="M16 17c-3.6 0-6-2.3-6.5-6 3.9.3 6.5 2.6 6.5 6Z" />
      <path d="M16 17c3.6 0 6-2.3 6.5-6-3.9.3-6.5 2.6-6.5 6Z" />
    </>
  ),
  // 茎：抽高的秆
  stalk: (
    <>
      <path d="M16 27V7" />
      <path d="M16 14c-3 0-5-1.8-5.4-5 3.3.3 5.4 2 5.4 5Z" />
      <path d="M16 20c3 0 5-1.8 5.4-5-3.3.3-5.4 2-5.4 5Z" />
    </>
  ),
  // 谷穗：成对的粒
  ear: (
    <>
      <path d="M16 27V9" />
      <path d="M16 9c0-2.6 1.6-4.6 4-5.2.3 2.9-1.4 5.2-4 5.2Z" />
      <path d="M16 9c0-2.6-1.6-4.6-4-5.2-.3 2.9 1.4 5.2 4 5.2Z" />
      <path d="M16 15.5c0-2.4 1.5-4.3 3.7-4.9.3 2.7-1.3 4.9-3.7 4.9Z" />
      <path d="M16 15.5c0-2.4-1.5-4.3-3.7-4.9-.3 2.7 1.3 4.9 3.7 4.9Z" />
      <path d="M16 22c0-2.4 1.5-4.3 3.7-4.9.3 2.7-1.3 4.9-3.7 4.9Z" />
      <path d="M16 22c0-2.4-1.5-4.3-3.7-4.9-.3 2.7 1.3 4.9 3.7 4.9Z" />
    </>
  ),
  // 谷捆：束起来的一把
  bundle: (
    <>
      <path d="M11 5.5 9 26.5" />
      <path d="M16 5v21.5" />
      <path d="M21 5.5l2 21" />
      <path d="M7.5 16.5h17" />
      <path d="M7.5 20h17" />
    </>
  ),
  // 田：垄
  field: (
    <>
      <rect x="4.5" y="8.5" width="23" height="15" rx="2" />
      <path d="M4.5 13.5h23" />
      <path d="M4.5 18.5h23" />
      <path d="M12 8.5v15" />
      <path d="M20 8.5v15" />
    </>
  ),
  // 谷仓
  granary: (
    <>
      <path d="M6 27V13l10-6.5L26 13v14" />
      <path d="M6 27h20" />
      <path d="M12.5 27v-7.5h7V27" />
      <path d="M13.5 13h5" />
    </>
  ),
  // 日
  sun: (
    <>
      <circle cx="16" cy="16" r="5.5" />
      <path d="M16 4v3" />
      <path d="M16 25v3" />
      <path d="M4 16h3" />
      <path d="M25 16h3" />
      <path d="m7.8 7.8 2.1 2.1" />
      <path d="m22.1 22.1 2.1 2.1" />
      <path d="m24.2 7.8-2.1 2.1" />
      <path d="m9.9 22.1-2.1 2.1" />
    </>
  ),
  // 月
  moon: <path d="M24 19.5A9.5 9.5 0 0 1 12.5 8a9.5 9.5 0 1 0 11.5 11.5Z" />,
  // 雨
  rain: (
    <>
      <path d="M9.5 16a5.5 5.5 0 0 1 .8-10.9A6.5 6.5 0 0 1 23 6.5a4.8 4.8 0 0 1-.5 9.5Z" />
      <path d="M11.5 21v3.5" />
      <path d="M16 22v4.5" />
      <path d="M20.5 21v3.5" />
    </>
  ),
  // 镰
  scythe: (
    <>
      <path d="M25 6c-9.5.6-15 5.6-15 12" />
      <path d="M25 6c-.4 7.7-5.6 12-15 12" />
      <path d="m10 18-3 8" />
    </>
  ),
  // 麦冠
  crown: (
    <>
      <path d="M6 22h20" />
      <path d="M6 22 4.5 10l6 4.5L16 6l5.5 8.5 6-4.5L26 22" />
      <circle cx="16" cy="16.5" r="1.3" />
    </>
  )
}

export default function GrainIcon({
  name,
  className = 'size-8'
}: {
  name: AchievementIcon
  className?: string
}): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" className={className} {...base} aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}
