import AccountSection from '../components/AccountSection'

/**
 * 账户页（#69/#71）：登录/注册 + 积分余额 + 充值，托管 AI 解析的入口。
 * 作为一级导航，未登录时侧栏有红点提示——把「注册登录即用」的账号入口摆到明面，不再深埋设置页。
 */
export default function Account(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-8 py-8 pb-16">
      <div>
        <h1 className="text-lg font-semibold">账户</h1>
        <p className="mt-1 text-sm leading-6 text-slate-500">
          登录后即可使用云端 AI 解析（截图 / 剪贴板 / 文件自动抽取待办）。按量计积分、失败不扣、用尽自动停，
          积分可充值或开通会员。
        </p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <AccountSection />
      </div>
    </div>
  )
}
