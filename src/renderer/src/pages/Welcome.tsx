import { useState } from 'react'
import brandMark from '../assets/agent-avatar.png'
import { hasBackend } from '../supabase'

interface Props {
  onDone: () => void
}

const FEATURES = [
  {
    title: '捕获待办',
    desc: '从屏幕、剪贴板、文件和飞书消息里自动拎出待办，并判断「哪些事是你的事」，确认后才进日程。'
  },
  {
    title: '工作日报',
    desc: '静默记录工作轨迹和应用使用时长，一键生成当日工作日报，还能把完成的待办写进去。'
  },
  {
    title: '悬浮球陪伴',
    desc: '桌面悬浮球常驻：单击对话、双击开主窗，拖文件给它即可解析，扫描时有光环反馈。'
  }
]

const PIPELINE = ['定时截图', '本地 OCR', '只上传文字', 'AI 检测待办 + 记工作', '原图立即删除']

/** 首次运行引导：三步介绍产品是什么、屏幕感知如何工作、怎么上手；之后进入档案设置。 */
export default function Welcome({ onDone }: Props): React.JSX.Element {
  const [step, setStep] = useState(0)

  return (
    <div className="flex h-full items-center justify-center bg-slate-100">
      <div className="w-[560px] rounded-2xl border border-slate-200 bg-surface p-8 shadow-sm">
        <div className="flex items-center gap-3">
          <img src={brandMark} alt="" className="size-10 rounded-xl border border-slate-200 p-1.5" />
          <div>
            <div className="text-xl font-semibold">谷子助手</div>
            <div className="text-xs text-slate-400">把每天的忙碌，攒成看得见的收获</div>
          </div>
          <button
            className="ml-auto rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-100"
            onClick={onDone}
          >
            跳过引导
          </button>
        </div>

        <div className="mt-4 flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-brand' : 'bg-slate-200'}`} />
          ))}
        </div>

        <div key={step} className="animate-page mt-6 flex min-h-[280px] flex-col gap-4">
          {step === 0 && (
            <>
              <div className="text-sm text-slate-500">它帮你做三件事：</div>
              {FEATURES.map((f) => (
                <div key={f.title} className="rounded-xl border border-slate-200 px-4 py-3">
                  <div className="text-sm font-medium">{f.title}</div>
                  <div className="mt-0.5 text-xs leading-5 text-slate-400">{f.desc}</div>
                </div>
              ))}
            </>
          )}

          {step === 1 && (
            <>
              <div className="text-sm text-slate-500">屏幕感知是怎么工作的：</div>
              <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-slate-50 px-4 py-3.5 text-xs text-slate-600">
                {PIPELINE.map((p, i) => (
                  <span key={p} className="flex items-center gap-1.5">
                    <span className="rounded-md border border-slate-200 bg-surface px-2 py-1">{p}</span>
                    {i < PIPELINE.length - 1 && <span className="text-slate-300">→</span>}
                  </span>
                ))}
              </div>
              <ul className="flex flex-col gap-2 text-sm leading-6 text-slate-600">
                <li>
                  · 截图只在你的电脑上做 OCR，默认<strong>只有文字</strong>会发给 AI；截图本身不上传（除非你在设置里主动开启「日程深度确认」）
                </li>
                <li>· 屏幕没变化、人不在电脑前、指定应用在前台时，连截图都不做</li>
                <li>· 所有数据存在本机，设置页可一键清除</li>
              </ul>
              <p className="text-xs leading-5 text-slate-400">
                {hasBackend
                  ? '屏幕感知默认关闭（检测走云端、消耗积分）。'
                  : '屏幕感知默认关闭（检测会调用你配置的模型 API）。'}
                稍后可在「设置 → 屏幕感知」里开启。
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <div className="text-sm text-slate-500">三步上手：</div>
              <ol className="flex flex-col gap-3 text-sm leading-6 text-slate-600">
                <li className="rounded-xl border border-slate-200 px-4 py-3">
                  <span className="font-medium">1. 完成档案</span>
                  <span className="ml-2 text-xs text-slate-400">
                    约 2 分钟，让 AI 知道「你是谁」，判断任务归属才准
                  </span>
                </li>
                {hasBackend ? (
                  <li className="rounded-xl border border-slate-200 px-4 py-3">
                    <span className="font-medium">2. 登录账号</span>
                    <span className="ml-2 text-xs text-slate-400">
                      在「个人」页注册登录，注册即送 7 天全功能试用
                    </span>
                  </li>
                ) : (
                  <li className="rounded-xl border border-slate-200 px-4 py-3">
                    <span className="font-medium">2. 配置模型</span>
                    <span className="ml-2 text-xs text-slate-400">
                      在「设置 → 助手 → 模型」填你自己的模型 API（OpenAI 兼容或 Anthropic），解析和对话都用它；数据只存在本机
                    </span>
                  </li>
                )}
                <li className="rounded-xl border border-slate-200 px-4 py-3">
                  <span className="font-medium">3. 日常使用</span>
                  <span className="ml-2 text-xs text-slate-400">
                    复制内容按快捷键秒提交；开屏幕感知后待办和日报全自动
                  </span>
                </li>
              </ol>
            </>
          )}
        </div>

        <div className="mt-6 flex justify-between">
          <button
            className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-100 disabled:invisible"
            disabled={step === 0}
            onClick={() => setStep(step - 1)}
          >
            上一步
          </button>
          {step < 2 ? (
            <button
              className="rounded-lg bg-brand px-5 py-2 text-sm text-white hover:bg-brand-dark"
              onClick={() => setStep(step + 1)}
            >
              下一步
            </button>
          ) : (
            <button className="rounded-lg bg-brand px-5 py-2 text-sm text-white hover:bg-brand-dark" onClick={onDone}>
              开始设置档案
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
