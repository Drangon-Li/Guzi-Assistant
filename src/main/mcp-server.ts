// 谷子助手对外 MCP 服务 —— 把任务/工作记录/日报能力暴露成 MCP 工具，供用户自己的
// AI 客户端（Claude Desktop / Cursor / Claude Code 等）接入操控谷子。
// 最小 Streamable HTTP 实现：单端点 POST JSON-RPC，即请求即响应（不提供 SSE 流，GET 返回 405）。
// 安全边界：只绑 127.0.0.1；Bearer token 鉴权（settings.mcpToken，设置页生成/重置，常数时间比较）。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { getSettings, getTask, listReports, listTasks, listWorkRecords, updateTask } from './db'
import { assistantAdd } from './assistant'
import { broadcast, debugEvent } from './windows'
import type { TaskStatus } from '@shared/types'
import type { ParsedItem } from '@shared/parsing'

const STATUSES: TaskStatus[] = ['not_started', 'scheduled', 'in_progress', 'done', 'overdue', 'ignored']

let server: Server | null = null
let boundPort = 0

interface RpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

// ---------- 工具定义与实现 ----------

const TOOLS = [
  {
    name: 'list_tasks',
    description: '列出谷子助手中的任务/日程。默认只返回进行中的（未完成且未忽略）。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'all', ...STATUSES],
          description: 'open=未完成且未忽略（默认）；all=全部；或指定具体状态'
        }
      }
    }
  },
  {
    name: 'add_task',
    description: '往谷子助手添加一条任务/日程。与已有任务疑似重复时不会重复添加并返回提示。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题（必填）' },
        start_time: { type: 'string', description: '开始时间 YYYY-MM-DDTHH:mm，可省略' },
        due_time: { type: 'string', description: '截止时间 YYYY-MM-DDTHH:mm，可省略' },
        location: { type: 'string', description: '地点，可省略' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'], description: '优先级，可省略' }
      },
      required: ['title']
    }
  },
  {
    name: 'set_task_status',
    description: '修改某条任务的状态（如标记完成 done、忽略 ignored）。id 来自 list_tasks。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        status: { type: 'string', enum: STATUSES, description: '目标状态' }
      },
      required: ['id', 'status']
    }
  },
  {
    name: 'list_work_records',
    description: '列出某天的工作记录时间线（屏幕感知自动记录的「在做什么」）。',
    inputSchema: {
      type: 'object',
      properties: { day: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' } }
    }
  },
  {
    name: 'get_daily_report',
    description: '获取某天已生成的工作日报全文（Markdown）。',
    inputSchema: {
      type: 'object',
      properties: { day: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' } }
    }
  }
] as const

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function callTool(name: string, args: Record<string, unknown>): unknown {
  if (name === 'list_tasks') {
    const filter = typeof args.status === 'string' ? args.status : 'open'
    return listTasks()
      .filter((t) =>
        filter === 'all' ? true : filter === 'open' ? t.status !== 'done' && t.status !== 'ignored' : t.status === filter
      )
      .slice(0, 120)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        start_time: t.startTime,
        due_time: t.dueTime,
        location: t.location,
        priority: t.priority
      }))
  }
  if (name === 'add_task') {
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (!title) throw new Error('title 不能为空')
    const item: ParsedItem = {
      title: title.slice(0, 120),
      item_type: 'other',
      belongs_to_user: 'yes',
      belonging_reason: '用户通过 MCP 客户端主动添加',
      user_role: 'owner',
      start_time: typeof args.start_time === 'string' ? args.start_time : null,
      due_time: typeof args.due_time === 'string' ? args.due_time : null,
      location: typeof args.location === 'string' ? args.location : null,
      priority: args.priority === 'high' || args.priority === 'medium' || args.priority === 'low' ? args.priority : 'unknown',
      confidence: 1,
      suggested_action: 'add',
      evidence: [],
      notes: [],
      duplicate_of: null
    }
    const info = assistantAdd({ sourceText: `MCP 添加：${title}`, item })
    return info.duplicate
      ? { added: false, reason: `与已有任务「${info.title}」疑似重复，未添加` }
      : { added: true, title: info.title, time: info.time }
  }
  if (name === 'set_task_status') {
    const id = typeof args.id === 'string' ? args.id : ''
    const status = args.status as TaskStatus
    if (!STATUSES.includes(status)) throw new Error(`status 必须是 ${STATUSES.join('/')}`)
    const task = getTask(id)
    if (!task) throw new Error(`找不到 id 为 ${id} 的任务，请先用 list_tasks 查询`)
    updateTask(id, { status })
    broadcast('guzi-assistant:tasks-updated')
    return { title: task.title, status }
  }
  if (name === 'list_work_records') {
    const day = typeof args.day === 'string' && args.day ? args.day : todayKey()
    return listWorkRecords(day).map((r) => ({ time: r.createdAt.slice(11, 16), content: r.content, app: r.app, task: r.task }))
  }
  if (name === 'get_daily_report') {
    const day = typeof args.day === 'string' && args.day ? args.day : todayKey()
    const reports = listReports().filter((r) => r.day === day)
    if (!reports.length) return { day, report: null, note: '这一天还没有生成日报' }
    return { day, title: reports[0].title, report: reports[0].content }
  }
  throw new Error(`未知工具：${name}`)
}

// ---------- JSON-RPC / HTTP ----------

function rpcResult(id: RpcRequest['id'], result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result })
}

function rpcError(id: RpcRequest['id'], code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

function handleRpc(req: RpcRequest): { status: number; body: string | null } {
  const method = req.method ?? ''
  if (method.startsWith('notifications/')) return { status: 202, body: null }
  if (method === 'initialize') {
    return {
      status: 200,
      body: rpcResult(req.id, {
        protocolVersion:
          typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'guzi-assistant', title: '谷子助手', version: app.getVersion() }
      })
    }
  }
  if (method === 'ping') return { status: 200, body: rpcResult(req.id, {}) }
  if (method === 'tools/list') return { status: 200, body: rpcResult(req.id, { tools: TOOLS }) }
  if (method === 'tools/call') {
    const name = typeof req.params?.name === 'string' ? req.params.name : ''
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>
    try {
      const out = callTool(name, args)
      return {
        status: 200,
        body: rpcResult(req.id, { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] })
      }
    } catch (e) {
      // 工具执行失败按 MCP 约定回 isError 内容，而不是 JSON-RPC 错误
      return {
        status: 200,
        body: rpcResult(req.id, {
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
          isError: true
        })
      }
    }
  }
  return { status: 200, body: rpcError(req.id, -32601, `不支持的方法：${method}`) }
}

function tokenOk(req: IncomingMessage): boolean {
  const expect = getSettings().mcpToken
  if (!expect) return false
  const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(got)
  const b = Buffer.from(expect)
  return a.length === b.length && timingSafeEqual(a, b)
}

function onRequest(req: IncomingMessage, res: ServerResponse): void {
  if (!tokenOk(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(rpcError(null, -32000, '未授权：请携带正确的 Bearer token'))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' })
    res.end()
    return
  }
  let body = ''
  req.on('data', (c) => {
    body += c
    if (body.length > 256 * 1024) req.destroy() // 防撑爆：MCP 请求不该这么大
  })
  req.on('end', () => {
    let parsed: RpcRequest
    try {
      parsed = JSON.parse(body) as RpcRequest
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(rpcError(null, -32700, '请求不是合法 JSON'))
      return
    }
    const { status, body: out } = handleRpc(parsed)
    if (out === null) {
      res.writeHead(status)
      res.end()
    } else {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(out)
    }
  })
}

/** 按设置启停/重启 MCP 服务（开关、端口、token 变化时由 settings:save 调用）。 */
export function applyMcpSettings(): void {
  const { mcpEnabled, mcpPort, mcpToken } = getSettings()
  const wantPort = Number.isInteger(mcpPort) && mcpPort > 0 && mcpPort < 65536 ? mcpPort : 38999
  const shouldRun = mcpEnabled && !!mcpToken
  if (server && (!shouldRun || boundPort !== wantPort)) {
    server.close()
    server = null
    boundPort = 0
    debugEvent('mcp', '服务已停止')
  }
  if (!shouldRun || server) return
  const s = createServer(onRequest)
  s.on('error', (e) => {
    debugEvent('mcp', `启动失败：${e instanceof Error ? e.message : String(e)}（端口被占用？可在设置里换端口）`)
    if (server === s) {
      server = null
      boundPort = 0
    }
  })
  s.listen(wantPort, '127.0.0.1', () => {
    debugEvent('mcp', `服务已启动：http://127.0.0.1:${wantPort}/mcp`)
  })
  server = s
  boundPort = wantPort
}

export function stopMcpServer(): void {
  if (server) {
    server.close()
    server = null
    boundPort = 0
  }
}
