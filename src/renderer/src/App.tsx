// 渲染层入口路由：每个窗口加载同一份 index.html，靠 hash 决定渲染哪个界面。
//
// 主界面（全部页面、插件、Supabase 登录客户端、录音）按需加载。桌宠对话、快捷提问、
// 预览卡、提醒卡是各自独立的渲染进程，以前也会把主界面整套求值一遍——
// 各自多背一份内存，还各开一个会自动刷新 token 的登录客户端。
//
// 小窗本身刻意保持同步加载：主进程在 did-finish-load 后立刻推第一条消息（预览卡是首次使用时才建窗），
// 组件要是还在等分块，订阅没挂上，那条消息就丢了（reminder-window.ts 的预建注释讲的是同一个竞态）。
// 主窗口没有这种「加载完就推」的消息，首帧本来就是加载圈，晚几毫秒挂载没有区别。
import { lazy, Suspense } from 'react'
import PreviewCard from './pages/PreviewCard'
import ReminderCard from './pages/ReminderCard'
import Debug from './pages/Debug'
import PetChat from './pages/PetChat'
import QuickBar from './pages/QuickBar'

const MainApp = lazy(() => import('./MainApp'))

export default function App(): React.JSX.Element {
  if (window.location.hash.includes('/preview')) return <PreviewCard />
  if (window.location.hash.includes('/reminder')) return <ReminderCard />
  if (window.location.hash.includes('/debug')) return <Debug />
  if (window.location.hash.includes('/petchat')) return <PetChat />
  if (window.location.hash.includes('/quickbar')) return <QuickBar />
  return (
    <Suspense fallback={null}>
      <MainApp />
    </Suspense>
  )
}
