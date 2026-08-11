// Hr招聘工作台 —— 真实邮箱收取模块（桌面版专用）
// 通过 IMAP 连接用户邮箱，拉取最近 N 天的简历邮件，下载附件并提取文本
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

// 根据邮箱域名推断 IMAP 服务器
function inferImap(addr) {
  const domain = (addr.split('@')[1] || '').toLowerCase();
  if (domain === 'qq.com') return { host: 'imap.qq.com', port: 993, secure: true };
  if (domain === '163.com' || domain === '126.com' || domain === 'yeah.net') return { host: 'imap.' + domain, port: 993, secure: true };
  if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com' || domain === 'office365.com') return { host: 'outlook.office365.com', port: 993, secure: true };
  if (domain === 'gmail.com') return { host: 'imap.gmail.com', port: 993, secure: true };
  if (domain === '139.com') return { host: 'imap.139.com', port: 993, secure: true };
  if (domain === 'sina.com' || domain === 'sina.cn') return { host: 'imap.sina.com', port: 993, secure: true };
  if (domain === 'aliyun.com') return { host: 'imap.aliyun.com', port: 993, secure: true };
  return { host: 'imap.' + domain, port: 993, secure: true };
}

// 识别简历邮件所属招聘平台
function detectPlatform(subject) {
  if (/BOSS|Boss|boss/.test(subject)) return 'BOSS直聘';
  if (/猎聘/.test(subject)) return '猎聘';
  if (/智联/.test(subject)) return '智联招聘';
  if (/拉勾/.test(subject)) return '拉勾网';
  if (/前程无忧|51job/i.test(subject)) return '前程无忧';
  if (/58同城/.test(subject)) return '58同城';
  return '邮件简历';
}

// 从主题提取姓名：如【BOSS直聘】张伟-5年ToB销售 → 张伟
function nameFromSubject(subject) {
  const m = subject.match(/[【\[]([^】\]]*)[】\]]/);
  if (m) {
    const inner = m[1].replace(/(BOSS直聘|猎聘|智联招聘|拉勾|前程无忧|58同城)/g, '');
    const n = inner.trim();
    if (n && n.length <= 12 && !/^\d/.test(n)) return n;
  }
  // 通用：取 "名字-职位" 模式
  const m2 = subject.match(/([\u4e00-\u9fa5]{2,4})[-\s|]/);
  if (m2 && !/简历|招聘|推荐|投递/.test(m2[1])) return m2[1];
  return '';
}

// 从附件文件名提取姓名：张伟-简历.pdf → 张伟
function nameFromFile(filename) {
  const base = (filename || '').replace(/\.[^.]+$/, '');
  const m = base.match(/([\u4e00-\u9fa5]{2,4})/);
  if (m && !/简历|应聘|求职/.test(m[1])) return m[1];
  return '';
}

// 提取简历文本
async function extractText(filePath, filename) {
  try {
    const buf = fs.readFileSync(filePath);
    if (/\.pdf$/i.test(filename)) {
      const u8 = new Uint8Array(buf);   // 拷贝构造，兼容池化 Buffer
      const d = await new PDFParse(u8).getText();
      let text = '';
      if (typeof d === 'string') text = d;
      else if (d && typeof d.text === 'string') text = d.text;
      return text.replace(/\s+/g, ' ').trim().slice(0, 6000);
    }
    if (/\.docx$/i.test(filename)) {
      const d = await mammoth.extractRawText({ buffer: buf });
      return (d.value || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
    }
  } catch (e) { /* 解析失败不影响，原件已保存 */ }
  return '';
}

// 主入口：拉取最近 rangeDays 天的简历邮件
async function fetchResumeMails({ addr, pwd, rangeDays = 7, seenKeys = [], resumeDir }) {
  const cfg = inferImap(addr);
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: addr, pass: pwd },
    logger: false,
    connectionTimeout: 30000
  });
  try {
    await client.connect();
  } catch (e) {
    throw new Error('无法连接邮箱服务器 ' + cfg.host + '：' + e.message);
  }
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - rangeDays * 86400000);
      const seq = await client.search({ since });
      const results = [];
      let skipped = 0, noResume = 0;
      for await (const msg of client.fetch(seq, { uid: true, envelope: true, source: true })) {
        const key = 'mail:' + msg.uid;
        if (seenKeys.includes(key)) { skipped++; continue; }
        let parsed;
        try { parsed = await simpleParser(msg.source); }
        catch (e) { skipped++; continue; }
        const subject = parsed.subject || '';
        const attach = (parsed.attachments || []).find(a =>
          /\.(pdf|doc|docx)$/i.test(a.filename || '') ||
          /pdf|msword|officedocument/.test(a.contentType || '')
        );
        if (!attach) { noResume++; continue; }   // 无简历附件的邮件跳过
        const safeName = attach.filename || ('resume_' + msg.uid + '.pdf');
        const dir = path.join(resumeDir, 'mail_' + msg.uid);
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, safeName);
        fs.writeFileSync(filePath, attach.content);
        const text = await extractText(filePath, safeName);
        const name = nameFromSubject(subject) || nameFromFile(safeName);
        results.push({
          key,
          subject,
          platform: detectPlatform(subject),
          name,
          attachment: { path: filePath, name: safeName, type: attach.contentType || '' },
          text
        });
      }
      return { ok: true, results, skipped, noResume, host: cfg.host };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

module.exports = { fetchResumeMails, inferImap, extractText };
