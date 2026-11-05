import type * as Lark from '@larksuiteoapi/node-sdk'
import { nativeImage } from 'electron'
import { getSettings } from './db'
import { submitFeishu, toJpegDataUrl } from './capture'
import type { FeishuStatus, ParseSummary } from '@shared/types'
import { flattenPost, restoreMentions, type FeishuMention } from '@shared/feishu-message'
import { captureContentEpoch, isContentEpochCurrent, isContentResetting } from './content-lifecycle'

let state: FeishuStatus = { status: 'disabled', detail: '' }
let startedWith: string | null = null
let client: Lark.Client | null = null
const seenMessages = new Set<string>()

interface FeishuMessage {
  message_id: string
  chat_id: string
  chat_type: string
  message_type: string
  content: string
  /** 正文里 @_user_N 占位符对应的真名 */
  mentions?: FeishuMention[]
}

export function feishuStatus(): FeishuStatus {
  return state
}

/** 配置齐全且未启动时启动长连接；SDK 不支持热重连，改配置需重启应用 */
export function ensureFeishu(): void {
  const { feishuAppId, feishuAppSecret } = getSettings()
  if (!feishuAppId || !feishuAppSecret) {
    state = startedWith
      ? { status: 'restart_required', detail: '配置已清除，重启应用后生效' }
      : { status: 'disabled', detail: '' }
    return
  }
  const key = `${feishuAppId}:${feishuAppSecret}`
  if (startedWith) {
    if (startedWith !== key) {
      state = { status: 'restart_required', detail: '配置已修改，重启应用后生效' }
    }
    return
  }
  startedWith = key
  void start(feishuAppId, feishuAppSecret)
}

async function start(appId: string, appSecret: string): Promise<void> {
  state = { status: 'connecting', detail: '' }
  // SDK 连带 axios、protobuf 等一整套依赖，加载一次约 15MB 堆、100ms。
  // 绝大多数用户没配飞书机器人，配了才加载，别让每个人启动时都背着它。
  const sdk = await import('@larksuiteoapi/node-sdk')
  client = new sdk.Client({ appId, appSecret })

  // 先校验凭证，否则 WSClient 只会在内部静默重试
  try {
    await client.auth.v3.tenantAccessToken.internal({
      data: { app_id: appId, app_secret: appSecret }
    })
  } catch (e) {
    state = {
      status: 'error',
      detail: `凭证校验失败：${e instanceof Error ? e.message : String(e)}`
    }
    startedWith = null // 允许改对配置后重试
    return
  }

  const dispatcher = new sdk.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      try {
        await handleMessage((data as { message?: FeishuMessage }).message)
      } catch (e) {
        console.warn('[feishu] 处理消息失败：', e instanceof Error ? e.message : e)
      }
    }
  })

  try {
    const ws = new sdk.WSClient({ appId, appSecret, loggerLevel: sdk.LoggerLevel.error })
    ws.start({ eventDispatcher: dispatcher })
    state = { status: 'connected', detail: '长连接已建立，私聊机器人即可转发消息' }
  } catch (e) {
    state = { status: 'error', detail: e instanceof Error ? e.message : String(e) }
    startedWith = null
  }
}

async function handleMessage(msg: FeishuMessage | undefined): Promise<void> {
  if (isContentResetting()) return
  const epoch = captureContentEpoch()
  if (!msg || seenMessages.has(msg.message_id)) return
  seenMessages.add(msg.message_id)
  // LRU 淘汰：超限只删最旧的一批，保留近 200 条去重窗口（整批 clear 会让重投消息漏去重）
  if (seenMessages.size > 300) {
    for (const id of [...seenMessages].slice(0, seenMessages.size - 200)) seenMessages.delete(id)
  }
  if (msg.chat_type !== 'p2p') return // 原型只处理私聊，群聊不打扰

  let text: string | undefined
  let imageDataUrl: string | undefined
  if (msg.message_type === 'text') {
    const content = JSON.parse(msg.content) as { text?: string }
    text = restoreMentions(content.text ?? '', msg.mentions).trim()
  } else if (msg.message_type === 'post') {
    text = flattenPost(JSON.parse(msg.content), msg.mentions)
  } else if (msg.message_type === 'image') {
    const content = JSON.parse(msg.content) as { image_key?: string }
    if (content.image_key) imageDataUrl = await downloadImage(msg.message_id, content.image_key)
  } else {
    await reply(msg.chat_id, '暂不支持这种消息类型，请发送文本、富文本或图片（截图）。')
    return
  }
  if (!isContentEpochCurrent(epoch) || (!text && !imageDataUrl)) return

  const summary = await submitFeishu({ text, imageDataUrl })
  if (!isContentEpochCurrent(epoch)) return
  await reply(msg.chat_id, summaryText(summary))
}

async function downloadImage(messageId: string, fileKey: string): Promise<string> {
  const resp = await client!.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: 'image' }
  })
  const stream = await resp.getReadableStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  // 与剪切板/截图路径一致压成 JPEG，避免 PNG base64 让 DB 膨胀一个量级
  return toJpegDataUrl(nativeImage.createFromBuffer(Buffer.concat(chunks)), 1600)
}

function summaryText(s: ParseSummary): string {
  if (s.error) return `解析失败：${s.error}`
  if (!s.related) {
    return s.duplicates
      ? `这条内容和已有任务重复，已跳过 ${s.duplicates} 个，没有重复添加。`
      : '没有发现与你相关的事项。'
  }
  return `发现 ${s.related} 个可能与你有关的事项${
    s.autoAdded ? `，其中 ${s.autoAdded} 个已自动加入日程` : '，已进入 谷子助手 待确认列表，请到桌面端「助手」里确认'
  }${s.duplicates ? `；另有 ${s.duplicates} 个与已有任务重复，已跳过` : ''}。`
}

async function reply(chatId: string, text: string): Promise<void> {
  try {
    await client!.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }
    })
  } catch (e) {
    console.warn('[feishu] 回复失败：', e instanceof Error ? e.message : e)
  }
}
