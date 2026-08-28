import { lazy } from 'react'
import { IconHabit } from '../../components/nav-icons'
import type { PluginRendererModule } from '../types'

const habit: PluginRendererModule = {
  id: 'habit',
  Icon: IconHabit,
  Page: lazy(() => import('./Page')),
  homeCards: {
    'habit-today': lazy(() => import('./TodayCard'))
  }
}

export default habit
