import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { api } from './api'
import { platform } from './platform'
import './styles.css'
import './theme.css'

document.documentElement.dataset.platform = platform

// 深浅色由主进程驱动（设置 + nativeTheme）：启动拉取一次 + 订阅广播切 <html>.dark，theme.css 据此覆盖 token。
// 主动广播而非靠 matchMedia——运行时改 themeSource 不会可靠触发已打开窗口的 matchMedia change。所有渲染窗口共用此入口。
const applyDark = (dark: boolean): void => {
  document.documentElement.classList.toggle('dark', dark)
}
void api.themeGet().then((d) => applyDark(!!d))
api.on('guzi-assistant:theme', (p) => applyDark(!!(p as { dark?: boolean })?.dark))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
