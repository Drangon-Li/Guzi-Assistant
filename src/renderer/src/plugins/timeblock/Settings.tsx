// 作息设置：模板的增删改，以及撤掉某天的套用结果。
//
// 页面顶部的下拉只负责「挑一个模板套上」，改内容是低频但需要铺开的操作，
// 塞进那个 288px 的下拉里没法用，所以单独开一个面板。
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  labelToMinutes,
  minutesToLabel,
  scopeLabel,
  sortBlocks,
  type TemplateBlock,
  type TimeBlock,
  type TimeTemplate
} from '@shared/timeblock'
import { ALL_DAY_TYPES, DAY_TYPE_LABELS, type DayType } from '@shared/holidays'
import { api } from '../../api'
import Modal from '../../components/Modal'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 编辑中的时间块用 HH:MM 字符串存，落库时才换算——中途允许出现半截的非法值。 */
interface DraftBlock {
  start: string
  end: string
  title: string
}

interface DayPayload {
  blocks: TimeBlock[]
  templates: TimeTemplate[]
  templateBlocks: TemplateBlock[]
}

export default function TimeblockSettings({
  day,
  initialId,
  onClose,
  onChanged
}: {
  day: string
  /** 从模板下拉的「编辑」进来时，直接展开这一个 */
  initialId?: string | null
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const [templates, setTemplates] = useState<TimeTemplate[]>([])
  const [tplBlocks, setTplBlocks] = useState<TemplateBlock[]>([])
  const [appliedCount, setAppliedCount] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [days, setDays] = useState<number[]>([])
  const [types, setTypes] = useState<DayType[]>([])
  const [blocks, setBlocks] = useState<DraftBlock[]>([])
  const [note, setNote] = useState('')

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 2600)
  }

  const load = useCallback(async () => {
    const res = await api.plugin<DayPayload>('timeblock', 'day', day)
    setTemplates(res.templates)
    setTplBlocks(res.templateBlocks)
    setAppliedCount(res.blocks.filter((b) => b.templateId).length)
  }, [day])

  useEffect(() => {
    void load()
  }, [load])

  const openTpl = (t: TimeTemplate): void => {
    setOpenId(t.id)
    setName(t.name)
    setDays([...t.weekdays])
    setTypes([...t.dayTypes])
    setBlocks(
      sortBlocks(tplBlocks.filter((b) => b.templateId === t.id)).map((b) => ({
        start: minutesToLabel(b.startMin),
        end: minutesToLabel(b.endMin),
        title: b.title
      }))
    )
  }

  // 从下拉的「编辑」进来时自动展开那一个。只做一次——否则用户点「收起」会立刻被弹开
  const expandedInitial = useRef(false)
  useEffect(() => {
    if (expandedInitial.current || !initialId) return
    const t = templates.find((x) => x.id === initialId)
    if (!t) return
    expandedInitial.current = true
    openTpl(t)
  })

  const patchBlock = (i: number, patch: Partial<DraftBlock>): void =>
    setBlocks((bs) => bs.map((b, j) => (i === j ? { ...b, ...patch } : b)))

  const save = async (): Promise<void> => {
    if (!openId) return
    if (!name.trim()) return flash('模板得有个名字')

    const parsed: Omit<TemplateBlock, 'id' | 'templateId'>[] = []
    let dropped = 0
    for (const b of blocks) {
      const startMin = labelToMinutes(b.start)
      const endMin = labelToMinutes(b.end)
      const title = b.title.trim()
      // 半截的行不静默丢掉——数出来告诉用户，否则他会以为存好了
      if (startMin === null || endMin === null || startMin >= endMin || !title) {
        dropped++
        continue
      }
      parsed.push({ startMin, endMin, title, tag: null })
    }
    if (dropped) return flash(`有 ${dropped} 段时间没填完整或起止颠倒，先改好再存`)
    if (!parsed.length) return flash('至少留一段时间')

    await api.plugin('timeblock', 'template-update', openId, {
      name: name.trim(),
      weekdays: days,
      dayTypes: types,
      blocks: parsed
    })
    setOpenId(null)
    await load()
    onChanged()
    flash('已保存')
  }

  const remove = async (t: TimeTemplate): Promise<void> => {
    if (!window.confirm(`删除模板「${t.name}」？已经排出去的时间块不受影响。`)) return
    await api.plugin('timeblock', 'template-delete', t.id)
    if (openId === t.id) setOpenId(null)
    await load()
    onChanged()
    flash('模板已删除')
  }

  const unapply = async (): Promise<void> => {
    const n = await api.plugin<number>('timeblock', 'template-unapply', day)
    await load()
    onChanged()
    flash(n ? `撤掉了 ${n} 个由模板排出的块` : '这天没有由模板排出的块')
  }

  return (
    <Modal
      panelClass="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl"
      onClose={onClose}
    >
      {(close) => (
        <>
          <header className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
            <div>
              <div className="text-base font-semibold">作息设置</div>
              <div className="mt-0.5 text-xs text-slate-400">只影响这个插件，不改其他功能</div>
            </div>
            <button
              aria-label="关闭"
              className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              onClick={close}
            >
              ✕
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="flex flex-col gap-6">
              <section>
                <div className="text-sm font-medium">这一天</div>
                <p className="mt-0.5 mb-3 text-xs leading-5 text-slate-400">
                  {day} 有 {appliedCount} 个块是模板排出来的。撤掉只清这些，手动加的块留着。
                </p>
                <button
                  disabled={!appliedCount}
                  onClick={() => void unapply()}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                >
                  取消套用模板
                </button>
              </section>

              <section>
                <div className="text-sm font-medium">模板</div>
                <p className="mt-0.5 mb-3 text-xs leading-5 text-slate-400">
                  改名字、适用范围，或直接编辑里面的时段。改动只影响以后套用，
                  已经排出去的块不会跟着变。
                </p>

                {templates.length === 0 ? (
                  <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-400">
                    还没有模板。先在作息页排好一天，再用「模板 ▾ → 把今天存为模板」存下来。
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {templates.map((t) => {
                      const open = openId === t.id
                      const count = tplBlocks.filter((b) => b.templateId === t.id).length
                      return (
                        <li
                          key={t.id}
                          className={`rounded-xl border ${open ? 'border-brand/40' : 'border-slate-200'}`}
                        >
                          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                            <div className="min-w-0">
                              <div className="truncate text-sm">{t.name}</div>
                              <div className="text-[11px] text-slate-400">
                                {count} 段 · {scopeLabel(t.weekdays, t.dayTypes)}
                              </div>
                            </div>
                            <div className="flex shrink-0 gap-2 text-xs">
                              <button
                                onClick={() => (open ? setOpenId(null) : openTpl(t))}
                                className="text-brand hover:underline"
                              >
                                {open ? '收起' : '编辑'}
                              </button>
                              <button
                                onClick={() => void remove(t)}
                                className="text-slate-300 hover:text-red-500"
                              >
                                删除
                              </button>
                            </div>
                          </div>

                          {open && (
                            <div className="flex flex-col gap-3 border-t border-slate-200 px-3 py-3">
                              <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="模板名"
                                className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-brand"
                              />

                              <div>
                                <div className="mb-1.5 text-[11px] text-slate-400">每周哪几天</div>
                                <div className="flex gap-1">
                                  {WEEKDAYS.map((label, i) => (
                                    <button
                                      key={i}
                                      onClick={() =>
                                        setDays((ds) =>
                                          ds.includes(i) ? ds.filter((d) => d !== i) : [...ds, i]
                                        )
                                      }
                                      className={`size-7 rounded-md border text-xs transition-colors ${
                                        days.includes(i)
                                          ? 'border-brand bg-brand-soft text-brand'
                                          : 'border-slate-200 text-slate-400'
                                      }`}
                                    >
                                      {label}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              <div>
                                <div className="mb-1.5 text-[11px] text-slate-400">还要是这类日子</div>
                                <div className="flex gap-1.5">
                                  {ALL_DAY_TYPES.map((k) => (
                                    <button
                                      key={k}
                                      onClick={() =>
                                        setTypes((ts) =>
                                          ts.includes(k) ? ts.filter((x) => x !== k) : [...ts, k]
                                        )
                                      }
                                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                                        types.includes(k)
                                          ? 'border-brand bg-brand-soft text-brand'
                                          : 'border-slate-200 text-slate-400'
                                      }`}
                                    >
                                      {DAY_TYPE_LABELS[k]}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              <div>
                                <div className="mb-1.5 flex items-center justify-between">
                                  <span className="text-[11px] text-slate-400">时段</span>
                                  <span className="text-[11px] text-slate-400">
                                    会在{scopeLabel(days, types)}提示套用
                                  </span>
                                </div>
                                <div className="flex flex-col gap-1.5">
                                  {blocks.map((b, i) => (
                                    <div key={i} className="flex items-center gap-1.5">
                                      {/* 文本框而非 type="time"：到当天结束是 24:00，
                                          原生时间控件不收这个值，会把整段显示成空白 */}
                                      <input
                                        value={b.start}
                                        onChange={(e) => patchBlock(i, { start: e.target.value })}
                                        placeholder="09:00"
                                        className="w-16 shrink-0 rounded-md border border-slate-200 px-1.5 py-1 text-center text-xs tabular-nums outline-none focus:border-brand"
                                      />
                                      <span className="text-xs text-slate-300">–</span>
                                      <input
                                        value={b.end}
                                        onChange={(e) => patchBlock(i, { end: e.target.value })}
                                        placeholder="10:00"
                                        className="w-16 shrink-0 rounded-md border border-slate-200 px-1.5 py-1 text-center text-xs tabular-nums outline-none focus:border-brand"
                                      />
                                      <input
                                        value={b.title}
                                        onChange={(e) => patchBlock(i, { title: e.target.value })}
                                        placeholder="做什么"
                                        className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-brand"
                                      />
                                      <button
                                        aria-label="删除这段"
                                        onClick={() => setBlocks((bs) => bs.filter((_, j) => j !== i))}
                                        className="shrink-0 rounded px-1.5 py-1 text-xs text-slate-300 hover:text-red-500"
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  ))}
                                </div>
                                <button
                                  onClick={() =>
                                    setBlocks((bs) => [...bs, { start: '09:00', end: '10:00', title: '' }])
                                  }
                                  className="mt-1.5 text-xs text-brand hover:underline"
                                >
                                  + 添加一段
                                </button>
                              </div>

                              <div className="flex justify-end gap-2">
                                <button
                                  onClick={() => setOpenId(null)}
                                  className="rounded-lg px-3 py-1.5 text-xs text-slate-500"
                                >
                                  取消
                                </button>
                                <button
                                  onClick={() => void save()}
                                  className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white"
                                >
                                  保存
                                </button>
                              </div>
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            </div>
          </div>

          {note && (
            <div className="shrink-0 border-t border-line px-6 py-2.5 text-xs text-slate-500">{note}</div>
          )}
        </>
      )}
    </Modal>
  )
}
