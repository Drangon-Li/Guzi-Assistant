const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('captureOverlay', {
  initialize: () => ipcRenderer.invoke('guzi:capture:init'),
  action: (action) => ipcRenderer.send('guzi:capture:action', action),
  onSelection: (listener) => ipcRenderer.on('guzi:capture:selection', (_event, rect) => listener(rect))
})
