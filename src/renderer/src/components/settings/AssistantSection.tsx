// 设置页「助手」分区。状态仍由 pages/Settings.tsx 持有，这里只负责这一段的渲染与保存。
import type { Dispatch, SetStateAction } from 'react'
import type { AppSettings } from '@shared/types'
import { api } from '../../api'
import CustomModelSettings from '../CustomModelSettings'
import PetSettings from '../PetSettings'
import { Section } from '../ui'

interface Props {
  settings: AppSettings
  setSettings: Dispatch<SetStateAction<AppSettings | null>>
  flash: (msg: string) => void
}

export default function AssistantSection({
  settings, setSettings, flash
}: Props): React.JSX.Element {
  return (
    <>
      <Section title="悬浮助手">
        <label className="flex items-center gap-3 text-sm">
          <span className="text-slate-500">闲置自动收起</span>
          <input
            type="number"
            min={0}
            max={600}
            className="w-20 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
            value={settings.assistantAutoCloseSec}
            onChange={(e) =>
              setSettings({ ...settings, assistantAutoCloseSec: Number(e.target.value) })
            }
            onBlur={async (e) => {
              const v = Math.min(600, Math.max(0, Number(e.target.value) || 0))
              setSettings({ ...settings, assistantAutoCloseSec: v })
              await api.saveSettings({ assistantAutoCloseSec: v })
              flash(v ? `闲置 ${v} 秒自动收起助手` : '已关闭自动收起')
            }}
          />
          <span className="text-xs text-slate-400">秒，0 = 不自动收起</span>
        </label>
      </Section>

      <Section title="自定义模型" desc="用自己的 API 驱动谷子助手的解析与对话，替代内置托管服务。">
        <CustomModelSettings />
      </Section>

      <Section title="桌宠">
        <PetSettings />
      </Section>
    </>
  )
}
