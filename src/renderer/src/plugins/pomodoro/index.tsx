import { lazy } from 'react'
import { IconPomodoro } from '../../components/nav-icons'
import type { PluginRendererModule } from '../types'

const pomodoro: PluginRendererModule = {
  id: 'pomodoro',
  Icon: IconPomodoro,
  Page: lazy(() => import('./Page')),
  Settings: lazy(() => import('./Settings')),
  homeCards: {
    'pomodoro-today': lazy(() => import('./TodayCard'))
  }
}

export default pomodoro
