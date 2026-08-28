import { lazy } from 'react'
import { IconTimeblock } from '../../components/nav-icons'
import type { PluginRendererModule } from '../types'

const timeblock: PluginRendererModule = {
  id: 'timeblock',
  Icon: IconTimeblock,
  Page: lazy(() => import('./Page')),
  homeCards: {
    'timeblock-today': lazy(() => import('./TodayCard'))
  }
}

export default timeblock
