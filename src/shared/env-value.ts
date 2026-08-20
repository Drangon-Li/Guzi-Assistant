export function firstNonBlank(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (value?.trim()) return value.trim()
  }
  return ''
}
