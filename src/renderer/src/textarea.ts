/**
 * 在光标处插一个换行。
 *
 * ⌘⏎ 在 textarea 里不会自己产生换行——浏览器只对 ⇧⏎ 这么做，所以必须手动插。
 * 插完 React 会拿新 value 重渲染，光标默认落到末尾；要在下一帧把它放回换行符后面，
 * 否则在中间插一行会把光标甩到最后。
 */
/**
 * 让 textarea 的高度贴着实际内容，最多 maxPx。
 *
 * 不能按 '\n' 的个数算行数——一长串不带换行符的文字会软折成好几行，行数仍是 1，
 * 结果框子不长高、只能滚动。只有 scrollHeight 知道真实占了多高。
 * 先把 height 归零再读，否则 scrollHeight 被当前高度撑着，只增不减。
 */
export function autoGrow(el: HTMLTextAreaElement | null, maxPx: number): void {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`
}

export function insertNewline(
  el: HTMLTextAreaElement,
  value: string,
  setValue: (next: string) => void
): void {
  const start = el.selectionStart ?? value.length
  const end = el.selectionEnd ?? start
  setValue(`${value.slice(0, start)}\n${value.slice(end)}`)
  requestAnimationFrame(() => {
    el.selectionStart = start + 1
    el.selectionEnd = start + 1
  })
}
