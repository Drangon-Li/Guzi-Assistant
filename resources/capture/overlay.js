const image = document.getElementById('screen')
const shade = document.getElementById('shade')
const selection = document.getElementById('selection')
window.captureOverlay.onSelection((rect) => {
  shade.style.display = 'none'
  selection.style.display = 'block'
  selection.style.left = `${rect.x}px`
  selection.style.top = `${rect.y}px`
  selection.style.width = `${rect.width}px`
  selection.style.height = `${rect.height}px`
})
window.captureOverlay.initialize().then(async (dataUrl) => {
  image.src = dataUrl
  await image.decode()
  window.captureOverlay.action('ready')
}).catch(() => window.captureOverlay.action('cancel'))
window.addEventListener('pointerdown', (event) => {
  if (event.button === 0) {
    document.body.setPointerCapture(event.pointerId)
    window.captureOverlay.action('start')
  }
  if (event.button === 2) window.captureOverlay.action('cancel')
})
window.addEventListener('pointerup', (event) => {
  if (event.button === 0) window.captureOverlay.action('finish')
})
window.addEventListener('pointercancel', () => window.captureOverlay.action('cancel'))
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.captureOverlay.action('cancel')
})
window.addEventListener('contextmenu', (event) => event.preventDefault())
