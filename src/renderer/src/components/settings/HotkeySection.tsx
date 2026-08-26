// 设置页「快捷键」分区。状态仍由 pages/Settings.tsx 持有，这里只负责这一段的渲染与保存。
import type { Dispatch, SetStateAction } from 'react'
import type { AppSettings } from '@shared/types'
import { formatHotkey } from '../../labels'
import { Section } from '../ui'
import { HOTKEY_ROWS, type HotkeyField } from './shared'

interface Props {
  settings: AppSettings
  recordingKey: HotkeyField | null
  setRecordingKey: Dispatch<SetStateAction<HotkeyField | null>>
}

export default function HotkeySection({
  settings, recordingKey, setRecordingKey
}: Props): React.JSX.Element {
  return (
    <>
      <Section title="快捷键">
        <div className="flex flex-col gap-3 text-sm">
          {HOTKEY_ROWS.map((row) => (
            <div key={row.key} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-slate-500">{row.label}</span>
              <button
                onClick={() => setRecordingKey(recordingKey === row.key ? null : row.key)}
                className={`min-w-44 rounded-lg border px-4 py-2 font-medium ${
                  recordingKey === row.key
                    ? 'animate-pulse border-slate-400 bg-elevated text-slate-700'
                    : 'border-slate-300 hover:border-slate-400'
                }`}
              >
                {recordingKey === row.key ? '按下新组合键…' : formatHotkey(settings[row.key])}
              </button>
              {recordingKey === row.key && <span className="text-xs text-slate-400">Esc 取消</span>}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-400">
          点击按键框后直接按下想要的组合：需包含至少一个修饰键（⌘ ⌥ ⌃ ⇧），F1–F12
          可单独使用。注册失败说明该组合被系统或其他应用占用。「整屏感知扫描」需先在「屏幕感知」里开启本地智能检测才会生效。「快捷提问框」在任意应用里唤起：回车问助手，⌘回车直接记日程。
        </p>
      </Section>
    </>
  )
}
