import { lazy } from 'react'
import { IconNotebook } from '../../components/nav-icons'
import type { PluginRendererModule } from '../types'

const notebook: PluginRendererModule = {
  id: 'notebook',
  Icon: IconNotebook,
  Page: lazy(() => import('./Page'))
}

export default notebook
