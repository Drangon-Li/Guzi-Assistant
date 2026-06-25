// 桌宠窗口 preload —— 移植/精简自 openpets pet-preload.cjs（MIT，见 src/main/pet/THIRD_PARTY_NOTICES.md）。
// 保留：点击穿透 hit-test、手动拖拽、点击桌宠、气泡内容替换、文件拖放到桌宠。
// 去掉：动画 reaction/motion 状态、音频、TTS、override、插件气泡 action/input、hover/dblclick。
const { ipcRenderer, webUtils } = require('electron')

let lastInteractiveHit = null
let dragging = false
let suppressClickUntil = 0

const applyWhenReady = (fn) => {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true })
  else fn()
}

// 点击桌宠的一次性放大回弹：remove+回流+add 让连点也能重新触发动画。
// 类残留无害（动画停在 scale(1)），且每次新消息会整体重渲染 .pet-shell 抹掉它。
const playClickPop = () => {
  const shell = document.querySelector('.pet-shell')
  if (!shell) return
  shell.classList.remove('is-clicked')
  void shell.offsetWidth
  shell.classList.add('is-clicked')
}

// 内容整体替换（含气泡）：主进程重生成 bodyHtml，这里换 innerHTML。
ipcRenderer.on('openpets:pet-content-state', (_event, state) => {
  if (!state || typeof state.bodyHtml !== 'string' || state.bodyHtml.length > 64 * 1024) return
  applyWhenReady(() => {
    document.body.innerHTML = state.bodyHtml
  })
})

// 扫描/解析中：切 pet-scanning 类触发 Siri 式光环（不重渲染，平滑）。
ipcRenderer.on('openpets:pet-scanning', (_event, on) => {
  applyWhenReady(() => {
    document.documentElement.classList.toggle('pet-scanning', !!on)
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
    playClickPop()
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

  // 文件从 Finder 拖到桌宠上：拖拽期间让窗口可接收 drop（非穿透）+ 高亮反馈，drop 后把路径交给主进程。
  const onDragOver = (event) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    document.documentElement.classList.add('pet-drag-over')
    setInteractiveHit(true, 'drag')
  }
  document.addEventListener('dragenter', onDragOver)
  document.addEventListener('dragover', onDragOver)
  document.addEventListener('dragleave', (event) => {
    if (event.relatedTarget) return // 仍在窗口内子元素间移动，不算离开
    document.documentElement.classList.remove('pet-drag-over')
    setInteractiveHit(false, 'drag')
  })
  document.addEventListener('drop', (event) => {
    event.preventDefault()
    document.documentElement.classList.remove('pet-drag-over')
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || [])
    const paths = files
      .map((f) => {
        try {
          return webUtils.getPathForFile(f)
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    if (paths.length) ipcRenderer.send('openpets:pet-drop-files', paths)
    setInteractiveHit(false, 'drag')
  })

  setInteractiveHit(false, 'ready')
  ipcRenderer.send('openpets:pet-ready')
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installMouseInterop, { once: true })
} else {
  installMouseInterop()
}
