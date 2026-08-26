// 设置页「数据」分区。状态仍由 pages/Settings.tsx 持有，这里只负责这一段的渲染与保存。
import type { Dispatch, SetStateAction } from 'react'
import { api } from '../../api'
import { Section } from '../ui'

interface Props {
  exportFrom: string
  setExportFrom: Dispatch<SetStateAction<string>>
  exportTo: string
  setExportTo: Dispatch<SetStateAction<string>>
  flash: (msg: string) => void
  wipe: () => Promise<void>
  wipeMemory: () => Promise<void>
}

export default function DataSection({
  exportFrom, setExportFrom, exportTo, setExportTo, flash, wipe, wipeMemory
}: Props): React.JSX.Element {
  return (
    <>
      <Section title="数据导出">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          导出指定时间范围内的工作记录、日报、应用使用时长与屏幕识别历史为 JSON 文件。
        </p>
        <div className="flex items-center gap-2 text-sm">
          <input
            type="date"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
            value={exportFrom}
            onChange={(e) => setExportFrom(e.target.value)}
          />
          <span className="text-slate-400">至</span>
          <input
            type="date"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
            value={exportTo}
            onChange={(e) => setExportTo(e.target.value)}
          />
          <button
            className="rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-50"
            disabled={!exportFrom || !exportTo || exportFrom > exportTo}
            onClick={async () => {
              const ok = await api.exportRange(exportFrom, exportTo)
              if (ok) flash('已导出')
            }}
          >
            导出 JSON
          </button>
        </div>
      </Section>
      <Section title="数据管理">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          所有数据仅保存在本机（用户目录下的 SQLite 数据库），不会自动上传。提交解析时，所选内容会发送至 谷子助手 云端解析服务。
        </p>
        <div className="flex gap-2">
          <button
            className="rounded-lg border border-slate-300 px-4 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            onClick={() => void wipeMemory()}
          >
            清空所有记忆
          </button>
          <button
            className="rounded-lg border border-red-200 px-4 py-1.5 text-xs text-red-600 hover:bg-red-50"
            onClick={() => void wipe()}
          >
            清除全部数据
          </button>
        </div>
      </Section>
    </>
  )
}
