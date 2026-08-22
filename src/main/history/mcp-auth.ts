import { timingSafeEqual } from 'node:crypto'

/** Validate the loopback MCP Authorization header without exposing token data. */
export function bearerTokenMatches(authorization: unknown, expected: unknown): boolean {
  if (typeof expected !== 'string' || expected.length === 0) return false
  if (typeof authorization !== 'string') return false
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const received = Buffer.from(match[1])
  const required = Buffer.from(expected)
  return received.length === required.length && timingSafeEqual(received, required)
}
