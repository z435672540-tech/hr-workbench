// Hr招聘工作台 preload —— 安全桥接：把主进程的更新能力暴露给页面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appBridge', {
  // 触发一次更新检测（主进程 autoUpdater.checkForUpdates）
  checkForUpdates: () => ipcRenderer.send('check-updates'),
  // 下载完成后立即重启安装
  quitAndInstall: () => ipcRenderer.send('quit-and-install'),
  // 订阅主进程推送的更新事件（available/not-available/downloaded/error/checking）
  onUpdateEvent: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('update-event', handler);
    return () => ipcRenderer.removeListener('update-event', handler);
  }
});
