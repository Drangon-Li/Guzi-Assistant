import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { bearerTokenMatches } from '../src/main/history/mcp-auth.ts'

const source = readFileSync(new URL('../src/main/mcp-server.ts', import.meta.url), 'utf8')
const authSource = readFileSync(new URL('../src/main/history/mcp-auth.ts', import.meta.url), 'utf8')
const names = [
  'history_status',
  'history_recent',
  'history_search',
  'history_summarize',
  'history_pause',
  'history_resume',
  'history_clear',
  'history_delete_range'
]
let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed += 1
}

check('all History MCP tools are declared', names.every((name) => source.includes(`name: '${name}'`)))
check('History MCP dispatches every declared tool', names.every((name) => source.includes(`name === '${name}'`)))
check('MCP waits for async History operations', /async function callTool/.test(source) && /await callTool\(name, args\)/.test(source))
check('MCP remains loopback-only', /listen\(wantPort, '127\.0\.0\.1'/.test(source))
check('MCP keeps Bearer token and constant-time comparison', /authorization/.test(source) && /bearerTokenMatches/.test(source) && /timingSafeEqual/.test(authSource))
check('History tool descriptions prohibit raw sensitive output', /不返回敏感原文/.test(source) && /不返回原始事件文本/.test(source))
check('Bearer auth accepts only the exact token', bearerTokenMatches('Bearer test-token', 'test-token') && !bearerTokenMatches('Bearer wrong', 'test-token'))
check('Bearer auth rejects missing or malformed headers', !bearerTokenMatches(undefined, 'test-token') && !bearerTokenMatches('Basic test-token', 'test-token'))

assert.equal(failed, 0, `${failed} MCP checks failed`)
console.log('\nMCP History checks passed')
