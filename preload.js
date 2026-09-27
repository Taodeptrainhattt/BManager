const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bmanager', {
  // store
  getStore: () => ipcRenderer.invoke('store:get'),
  setStore: (store) => ipcRenderer.invoke('store:set', store),

  // folders
  chooseAndScanFolder: () => ipcRenderer.invoke('folder:choose-and-scan'),
  addFilesToFolder: () => ipcRenderer.invoke('folder:add-files'),

  // process (run .js)
  runFile: (fileId, filePath) => ipcRenderer.invoke('process:run', { fileId, filePath }),
  stopFile: (fileId) => ipcRenderer.invoke('process:stop', { fileId }),
  sendInput: (fileId, text) => ipcRenderer.invoke('process:send-input', { fileId, text }),
  onProcessOutput: (cb) => ipcRenderer.on('process:output', (evt, payload) => cb(payload)),
  onProcessStatus: (cb) => ipcRenderer.on('process:status', (evt, payload) => cb(payload))
});
