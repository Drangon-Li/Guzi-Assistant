/**
 * 在光标处插一个换行。
 *
 * ⌘⏎ 在 textarea 里不会自己产生换行——浏览器只对 ⇧⏎ 这么做，所以必须手动插。
 * 插完 React 会拿新 value 重渲染，光标默认落到末尾；要在下一帧把它放回换行符后面，
 * 否则在中间插一行会把光标甩到最后。
 */
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
