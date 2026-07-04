import { Fragment } from 'react'

/** 行内格式：**加粗**、`行内代码`。日报是自家模型生成的受限 Markdown，不做完整语法。 */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>
    if (p.startsWith('`') && p.endsWith('`'))
      return (
        <code key={i} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em]">
          {p.slice(1, -1)}
        </code>
      )
    return <Fragment key={i}>{p}</Fragment>
  })
}

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'p'; lines: string[] }

function parse(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()
    if (!t) {
      i++
      continue
    }
    if (t.startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++])
      i++ // 收尾 ```
      blocks.push({ kind: 'code', lines: code })
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t)
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length, text: h[2] })
      i++
      continue
    }
    if (/^([-*—]{3,})$/.test(t)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }
    if (/^[-*•]\s+/.test(t)) {
      const items: string[] = []
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) items.push(lines[i++].trim().replace(/^[-*•]\s+/, ''))
      blocks.push({ kind: 'ul', items })
      continue
    }
    if (/^\d+[.、)]\s*/.test(t)) {
      const items: string[] = []
      while (i < lines.length && /^\d+[.、)]\s*/.test(lines[i].trim()))
        items.push(lines[i++].trim().replace(/^\d+[.、)]\s*/, ''))
      blocks.push({ kind: 'ol', items })
      continue
    }
    if (t.startsWith('>')) {
      const quote: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) quote.push(lines[i++].trim().replace(/^>\s?/, ''))
      blocks.push({ kind: 'quote', lines: quote })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*•]\s|\d+[.、)]\s*|>|```)/.test(lines[i].trim()))
      para.push(lines[i++].trim())
    blocks.push({ kind: 'p', lines: para })
  }
  return blocks
}

const H_CLASS: Record<number, string> = {
  1: 'text-base font-semibold',
  2: 'text-[15px] font-semibold',
  3: 'text-sm font-semibold',
  4: 'text-sm font-medium'
}

/** 轻量 Markdown 展示（日报等模型输出）：标题/列表/引用/代码块/分隔线/加粗/行内代码。
 *  正文类内容——整块可选中复制（全局 body 已禁选，这里是白名单）。 */
export default function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex select-text flex-col gap-2.5 text-sm leading-6 text-slate-700">
      {parse(text).map((b, i) => {
        if (b.kind === 'h')
          return (
            <div key={i} className={`${H_CLASS[b.level]} ${i > 0 ? 'mt-2' : ''} text-slate-800`}>
              {inline(b.text)}
            </div>
          )
        if (b.kind === 'ul')
          return (
            <ul key={i} className="flex list-disc flex-col gap-1 pl-5 marker:text-slate-300">
              {b.items.map((it, j) => (
                <li key={j}>{inline(it)}</li>
              ))}
            </ul>
          )
        if (b.kind === 'ol')
          return (
            <ol key={i} className="flex list-decimal flex-col gap-1 pl-5 marker:text-slate-400">
              {b.items.map((it, j) => (
                <li key={j}>{inline(it)}</li>
              ))}
            </ol>
          )
        if (b.kind === 'quote')
          return (
            <blockquote key={i} className="border-l-2 border-slate-200 pl-3 text-slate-500">
              {b.lines.map((l, j) => (
                <p key={j}>{inline(l)}</p>
              ))}
            </blockquote>
          )
        if (b.kind === 'code')
          return (
            <pre key={i} className="overflow-x-auto rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs leading-5">
              {b.lines.join('\n')}
            </pre>
          )
        if (b.kind === 'hr') return <hr key={i} className="my-1 border-slate-100" />
        return (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
