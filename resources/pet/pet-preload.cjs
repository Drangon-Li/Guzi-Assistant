// 桌宠窗口 preload —— 移植/精简自 openpets pet-preload.cjs（MIT，见 src/main/pet/THIRD_PARTY_NOTICES.md）。
// 保留：点击穿透 hit-test、手动拖拽、点击桌宠、reaction/motion/内容状态切换。
// 去掉：音频、TTS、sprite/scale override、插件气泡 action/input、文件拖放、hover/dblclick。
const { ipcRenderer } = require('electron')

const allowedMotionStates = new Set(['idle', 'run-left', 'run-right'])
const allowedReactionStates = new Set([
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review'
])

let lastInteractiveHit = null
let dragging = false
let suppressClickUntil = 0

const applyWhenReady = (fn) => {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true })
  else fn()
}

ipcRenderer.on('openpets:pet-motion', (_event, state) => {
  if (!allowedMotionStates.has(state)) return
  applyWhenReady(() => {
    document.documentElement.dataset.motionState = state
  })
})

ipcRenderer.on('openpets:pet-reaction-state', (_event, state) => {
  if (!allowedReactionStates.has(state)) return
  applyWhenReady(() => {
    document.documentElement.dataset.reactionState = state
  })
})

// 内容整体替换（含气泡）：主进程重生成 bodyHtml，这里换 innerHTML + reaction 态。
ipcRenderer.on('openpets:pet-content-state', (_event, state) => {
  if (!state || typeof state.bodyHtml !== 'string' || state.bodyHtml.length > 64 * 1024) return
  if (!allowedReactionStates.has(state.reactionState)) return
  applyWhenReady(() => {
    document.documentElement.dataset.reactionState = state.reactionState
    document.body.innerHTML = state.bodyHtml
  })
})

const getInteractiveTarget = (event) => {
  const target = document.elementFromPoint(event.clientX, event.clientY)
  return target && target.closest('.pet-hitbox, .pet-shell, .bubble')
}

const reportInteractiveHit = (interactive, source, force = false) => {
  if (!force && lastInteractiveHit === interactive) return
  lastInteractiveHit = interactive
  ipcRenderer.send('openpets:pet-hit-test', interactive, source)
}
const setInteractiveHit = (interactive, source = 'mouse') => {
  if (lastInteractiveHit === interactive) return
  reportInteractiveHit(interactive, source)
}
const updateInteractiveHit = (event) => {
  setInteractiveHit(Boolean(getInteractiveTarget(event)) || dragging)
}

const installMouseInterop = () => {
  lastInteractiveHit = null
  dragging = false
  let dragStartPoint = null

  // 点击桌宠 → 打开助手（拖拽后 300ms 内的 click 抑制掉）。
  document.addEventListener('click', (event) => {
    if (event.button !== 0) return
    const target = event.target
    if (!(target instanceof Element) || !target.closest('.pet-hitbox, .pet-shell')) return
    if (Date.now() < suppressClickUntil) return
    ipcRenderer.send('openpets:pet-clicked')
  })

  document.addEventListener(
    'mousemove',
    (event) => {
      updateInteractiveHit(event)
      if (dragging) ipcRenderer.send('openpets:pet-drag-move', { screenX: event.screenX, screenY: event.screenY })
    },
    { passive: true }
  )

  document.addEventListener('mousedown', (event) => {
    const target = getInteractiveTarget(event)
    setInteractiveHit(Boolean(target))
    if (event.button !== 0 || !target || !target.closest('.pet-hitbox, .pet-shell')) return
    event.preventDefault()
    dragging = true
    dragStartPoint = { screenX: event.screenX, screenY: event.screenY }
    setInteractiveHit(true)
    ipcRenderer.send('openpets:pet-drag-start', { screenX: event.screenX, screenY: event.screenY })
  })

  document.addEventListener('mouseup', (event) => {
    if (!dragging) return
    dragging = false
    if (dragStartPoint && Math.hypot(event.screenX - dragStartPoint.screenX, event.screenY - dragStartPoint.screenY) > 4) {
      suppressClickUntil = Date.now() + 300
    }
    dragStartPoint = null
    ipcRenderer.send('openpets:pet-drag-end')
  })

  document.addEventListener(
    'mouseleave',
    () => {
      if (!dragging) setInteractiveHit(false)
    },
    { passive: true }
  )

  setInteractiveHit(false, 'ready')
  ipcRenderer.send('openpets:pet-ready')
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installMouseInterop, { once: true })
} else {
  installMouseInterop()
}
