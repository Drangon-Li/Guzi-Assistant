import { useEffect, useState } from 'react'
import { api } from '../api'

interface Props {
  /** 已授权（轮询到 granted）或用户选择跳过时调用，放行进入主界面 */
  onDone: () => void
}

/**
 * 首启屏幕录制授权引导（#屏幕感知默认开的必要配套）。
 * 屏幕感知默认开 → macOS 首次必须授予「屏幕录制」权限，否则被动采集静默失败、像「没生效」。
 * 这里说明用途 + 引导去系统设置，并轮询权限状态，授权后自动放行。
 */
export default function ScreenPermissionGate({ onDone }: Props): React.JSX.Element {
  const [status, setStatus] = useState<string>('')
  const [opened, setOpened] = useState(false)

  // 轮询权限状态：用户在系统设置里打开开关后，这里自动检测到 granted 并放行
  useEffect(() => {
    let alive = true
    const check = async (): Promise<void> => {
      const p = await api.permissions()
      if (!alive) return
      setStatus(p.screen)
      if (p.screen === 'granted') onDone()
    }
    void check()
    const t = window.setInterval(() => void check(), 2000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [onDone])

  const denied = status === 'denied'

  return (
    <div className="flex h-full items-center justify-center bg-slate-100">
      <div className="w-[520px] rounded-2xl border border-slate-200 bg-surface p-8 shadow-sm">
        <div className="text-xl font-semibold">开启屏幕感知</div>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          谷子助手 会持续感知你屏幕上的文字，自动把通知、聊天、邮件里「该你做的事」沉淀成待办——这是它的核心。
          为此需要 macOS 的「屏幕录制」权限。
        </p>
        <p className="mt-2 text-xs leading-5 text-slate-400">
          前台 App 与窗口变化只在本机做事件门控，不记录键盘正文；截图先在本机 OCR，默认只上传脱敏文字。
          <span className="text-slate-500">开启日程深度确认时才会上传裁剪截图</span>；敏感应用和私密浏览会跳过。
        </p>

        <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-7 text-slate-600">
          <div className="font-medium text-slate-700">三步开启</div>
          <div>1. 点下方「打开系统设置」</div>
          <div>
            2. 进「隐私与安全性 › 屏幕录制」，打开 <span className="font-medium">谷子助手</span>
          </div>
          <div>3. 授权后这里会自动继续（如未生效，重启 谷子助手 一次）</div>
        </div>

        {denied && (
          <p className="mt-3 text-xs leading-5 text-amber-600">
            当前是「已拒绝」状态——需要你在系统设置的列表里手动打开 谷子助手 的开关。
          </p>
        )}

        <div className="mt-6 flex items-center justify-between">
          <button className="text-sm text-slate-400 hover:text-slate-600" onClick={onDone}>
            暂时跳过
          </button>
          <button
            className="rounded-lg bg-brand px-5 py-2 text-sm text-white hover:bg-brand-dark"
            onClick={() => {
              void api.openScreenSettings()
              setOpened(true)
            }}
          >
            {opened ? '已打开设置 · 等待授权' : '打开系统设置'}
          </button>
        </div>
      </div>
    </div>
  )
}
