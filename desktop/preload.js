// Hr招聘工作台 preload —— 安全桥接：把主进程能力暴露给页面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appBridge', {
  // ---- 更新 ----
  checkForUpdates: () => ipcRenderer.send('check-updates'),
  quitAndInstall: () => ipcRenderer.send('quit-and-install'),
  onUpdateEvent: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('update-event', handler);
    return () => ipcRenderer.removeListener('update-event', handler);
  },

  // ---- 真实邮箱收取 ----
  fetchMails: (opts) => ipcRenderer.invoke('mail:fetch', opts),
  saveMailConfig: (cfg) => ipcRenderer.send('mail:config', cfg),
  getMailConfig: () => ipcRenderer.invoke('mail:config-get'),
  onMailResult: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('mail:result', handler);
    return () => ipcRenderer.removeListener('mail:result', handler);
  },

  // ---- 简历原件 ----
  saveResumeFile: (payload) => ipcRenderer.invoke('resume:save', payload),
  readResumeFile: (filePath) => ipcRenderer.invoke('resume:read', filePath)
});
