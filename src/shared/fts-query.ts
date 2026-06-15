/**
 * FTS5 查询构建（#52 可搜索记忆底座）：把用户输入安全转成 FTS5 MATCH 串。
 * 索引用 trigram tokenizer（支持中文子串）。每个词作短语：双引号包裹 + 内部双引号转义，
 * 防止用户输入里的 FTS5 特殊算子（AND、OR、NEAR、星号、双引号 等）被当语法。多词以 AND 连接。
 * 返回 '' 表示无可用词（调用方据此走 LIKE 兜底或返回空）。
 */
export function buildFtsQuery(input: string): string {
  const terms = (input ?? '')
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (!terms.length) return ''
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ')
}
