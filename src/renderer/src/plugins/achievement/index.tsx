import { lazy } from 'react'
import { IconAchievement } from '../../components/nav-icons'
import type { PluginRendererModule } from '../types'

const achievement: PluginRendererModule = {
  id: 'achievement',
  Icon: IconAchievement,
  Page: lazy(() => import('./Page'))
}

export default achievement
