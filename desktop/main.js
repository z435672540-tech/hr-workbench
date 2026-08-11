// Hr招聘工作台 桌面版主进程
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { fetchResumeMails, extractText } = require('./mailer');

const APP_VERSION = app.getVersion();
const RESUMES_DIR = () => path.join(app.getPath('userData'), 'resumes');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Hr招聘工作台',
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

function sendAll(data) {
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) w.webContents.send('update-event', data);
  });
}
function sendMailResult(data) {
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) w.webContents.send('mail:result', data);
  });
}

// 校验路径必须位于 resumes 目录内（防越权读任意文件）
function safeInResumes(p) {
  const root = path.resolve(RESUMES_DIR());
  const target = path.resolve(p);
  return target.startsWith(root + path.sep) || target === root;
}

// 手动收取一封候选人邮件结果 → 候选人对象
function toCandidate(r) {
  return {
    name: r.name || '未识别姓名',
    emailTitle: r.subject || '',
    source: r.platform || '邮件简历',
    work: r.text || '（已保存简历原件，待查看）',
    attachment: r.attachment || null,
    extra: '邮件收取',
    fromMail: true
  };
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // ===== 自动更新 =====
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendAll({ type: 'checking' }));
  autoUpdater.on('update-available', info => sendAll({ type: 'available', version: info && info.version }));
  autoUpdater.on('update-not-available', () => sendAll({ type: 'not-available' }));
  autoUpdater.on('update-downloaded', () => sendAll({ type: 'downloaded' }));
  autoUpdater.on('error', err => sendAll({ type: 'error', msg: err ? err.message : '' }));
  ipcMain.on('check-updates', () => {
    autoUpdater.checkForUpdates().catch(() => sendAll({ type: 'error', msg: '无法连接更新源' }));
  });
  ipcMain.on('quit-and-install', () => { autoUpdater.quitAndInstall(); });
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);

  // ===== 真实邮箱收取 =====
  ipcMain.handle('mail:fetch', async (e, opts) => {
    const { addr, pwd, rangeDays, seenKeys } = opts || {};
    if (!addr || !pwd) return { ok: false, error: '缺少邮箱或授权码' };
    try {
      fs.mkdirSync(RESUMES_DIR(), { recursive: true });
      const r = await fetchResumeMails({
        addr, pwd,
        rangeDays: Number(rangeDays) || 7,
        seenKeys: seenKeys || [],
        resumeDir: RESUMES_DIR()
      });
      return { ok: true, results: r.results, skipped: r.skipped, noResume: r.noResume, host: r.host };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 保存手动上传的简历文件 + 提取文本
  ipcMain.handle('resume:save', async (e, { fileName, base64 }) => {
    if (!fileName || !base64) return { ok: false, error: '缺少文件数据' };
    try {
      const dir = path.join(RESUMES_DIR(), 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      const safeName = path.basename(fileName);
      const filePath = path.join(dir, Date.now() + '_' + safeName);
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      const text = await extractText(filePath, safeName);
      return { ok: true, path: filePath, text };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 读取简历原件（PDF 预览用），仅限 resumes 目录
  ipcMain.handle('resume:read', async (e, filePath) => {
    if (!filePath || !safeInResumes(filePath)) return { ok: false, error: '路径不允许' };
    try {
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const type = ext === '.pdf' ? 'application/pdf'
        : ext === '.doc' ? 'application/msword'
        : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/octet-stream';
      return { ok: true, base64: buf.toString('base64'), type };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 保存邮箱配置（供定时收取）
  ipcMain.on('mail:config', (e, cfg) => {
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), 'mail-config.json'), JSON.stringify(cfg || {}), 'utf8');
    } catch (err) { /* 忽略 */ }
  });
  ipcMain.handle('mail:config-get', () => {
    try {
      const raw = fs.readFileSync(path.join(app.getPath('userData'), 'mail-config.json'), 'utf8');
      return { ok: true, cfg: JSON.parse(raw) };
    } catch (e) { return { ok: true, cfg: null }; }
  });

  // 定时收取：每 60 分钟检查一次，按配置的间隔（12/24h）触发
  let lastAutoFetch = 0;
  setInterval(async () => {
    try {
      let cfg = null;
      try { cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'mail-config.json'), 'utf8')); } catch (e) {}
      if (!cfg || !cfg.bound || cfg.auto === 'off') return;
      const intervalH = Number(cfg.auto) || 24;
      if (Date.now() - lastAutoFetch < intervalH * 3600000) return;
      lastAutoFetch = Date.now();
      const r = await fetchResumeMails({
        addr: cfg.addr, pwd: cfg.pwd,
        rangeDays: Number(cfg.range) || 7,
        seenKeys: cfg.seenMails || [],
        resumeDir: RESUMES_DIR()
      });
      sendMailResult({ type: 'auto', ok: r.ok, results: r.results, skipped: r.skipped, host: r.host });
    } catch (err) { /* 定时收取静默失败 */ }
  }, 3600000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
