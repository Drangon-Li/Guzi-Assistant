// 设置页「关于」分区。状态仍由 pages/Settings.tsx 持有，这里只负责这一段的渲染与保存。
import type { Dispatch, SetStateAction } from 'react'
import { api } from '../../api'
import FeedbackSection from '../FeedbackSection'
import { Section } from '../ui'

interface Props {
  appVersion: string
  checkingUpdate: boolean
  setCheckingUpdate: Dispatch<SetStateAction<boolean>>
}

export default function AboutSection({
  appVersion, checkingUpdate, setCheckingUpdate
}: Props): React.JSX.Element {
  return (
    <>
      <Section title="版本">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-500">当前版本 {appVersion || '…'}</span>
          <button
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            disabled={checkingUpdate}
            onClick={async () => {
              setCheckingUpdate(true)
              try {
                await api.checkUpdate() // 结果由系统对话框反馈
              } finally {
                setCheckingUpdate(false)
              }
            }}
          >
            {checkingUpdate ? '检查中…' : '检查更新'}
          </button>
        </div>
      </Section>
      <FeedbackSection />
    </>
  )
}
