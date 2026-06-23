const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const multer = require('multer');
const https = require('https');
const http = require('http');
const os = require('os');
const chokidar = require('chokidar');
const child_process = require('child_process');

const router = express.Router();

const upload = multer({
  dest: config.OUTPUT_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }
});

const tasks = [];
const results = new Map();
const waitingClients = [];

// ============================================================
// SSE 支持
// ============================================================
const sseClients = new Set();
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

function broadcastSSE(event, data) {
  for (const client of sseClients) {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// ============================================================
// 任务核心
// ============================================================
router.post('/task', (req, res) => {
  try {
    const payload = req.body;
    const taskId = `bridge-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const task = { id: taskId, timestamp: Date.now(), payload: payload };

    results.set(taskId, { payload: payload, status: 'queued', progress: '0%', urls: [], error: null });

    if (waitingClients.length > 0) {
      const client = waitingClients.shift();
      clearTimeout(client.timeout);
      client.res.json({ success: true, task });
    } else {
      tasks.push(task);
    }
    res.json({ success: true, taskId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/pull', (req, res) => {
  if (tasks.length > 0) {
    const task = tasks.shift();
    if (results.has(task.id)) {
      results.set(task.id, { ...results.get(task.id), status: 'running', progress: '5%' });
    }
    return res.json({ success: true, task });
  }

  const client = { res };
  client.timeout = setTimeout(() => {
    const index = waitingClients.indexOf(client);
    if (index !== -1) waitingClients.splice(index, 1);
    if (!res.headersSent) res.json({ success: true, task: null });
  }, 2000);
  waitingClients.push(client);
});

// ============================================================
// Push URL - 缩略图推�?
// ============================================================
router.post('/push-url', (req, res) => {
  const { taskId, url, status } = req.body;
  if (!taskId || !url) return res.status(400).json({ error: 'Missing params' });

  try {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    // 智能解析扩展名：防止视频被错误标记为 .png
    let ext = path.extname(parsedUrl.pathname);
    const taskRecord = results.get(taskId);
    if (!ext) {
      if (url.includes('video') || (taskRecord && taskRecord.payload?.model === 'video')) {
        ext = '.mp4';
      } else {
        ext = '.png';
      }
    }

    const filename = `bridge_media_${taskId}_${Date.now()}${ext}`;
    const filepath = path.join(config.OUTPUT_DIR, filename);

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://www.doubao.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    };

    client.get(url, options, (response) => {
      if (response.statusCode === 200) {
        const fileStream = fs.createWriteStream(filepath);
        response.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          const localUrl = `http://127.0.0.1:18766/output/${filename}`;
          const currentRecord = results.get(taskId) || { urls: [] };

          results.set(taskId, {
            ...currentRecord,
            status: status || 'completed',
            progress: '100%',
            urls: [localUrl] // 【关键修复】：这里只有 urls，没�?rawUrls！把 rawUrls 留给看门狗高清大图！
          });

          res.json({ success: true, url: localUrl });
        });
      } else {
        res.status(500).json({ error: 'Failed to fetch image: ' + response.statusCode });
      }
    }).on('error', (e) => {
      res.status(500).json({ error: e.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/push', (req, res) => {
  try {
    const { taskId, status, progress, base64Data, error, text, action } = req.body;

    if (action === 'download-alert') {
      triggerWatchdog(taskId);
      res.json({ success: true });
      return;
    }

    const currentRecord = results.get(taskId) || { urls: [] };
    const update = { 
      ...currentRecord, 
      status: status || currentRecord.status, 
      progress: progress || currentRecord.progress, 
      error: error || currentRecord.error,
      reply: text || currentRecord.reply 
    };

    if (base64Data && base64Data.startsWith('data:image/')) {
      const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const ext = matches[1].split('/')[1] === 'jpeg' ? 'jpg' : 'png';
        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `bridge_thumb_${taskId}.${ext}`;
        const filepath = path.join(config.OUTPUT_DIR, filename);
        fs.writeFileSync(filepath, buffer);
        update.urls = [`http://127.0.0.1:18766/output/${filename}?t=${Date.now()}`];
      }
    } else if (base64Data && typeof base64Data === 'string') {
      update.urls = [base64Data];
    }
    results.set(taskId, update);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/push-media', upload.single('media'), (req, res) => {
  try {
    const { taskId, status } = req.body;
    const file = req.file;
    if (!taskId || !file) return res.status(400).json({ error: 'Missing' });

    const ext = file.originalname ? path.extname(file.originalname) : '.mp4';
    const filename = `bridge_media_${taskId}${ext}`;
    const filepath = path.join(config.OUTPUT_DIR, filename);
    fs.copyFileSync(file.path, filepath);
    fs.unlinkSync(file.path);

    const currentRecord = results.get(taskId) || { urls: [] };
    const localUrl = `http://127.0.0.1:18766/output/${filename}?t=${Date.now()}`;

    results.set(taskId, { ...currentRecord, status: status || 'completed', progress: '100%', urls: [localUrl] });
    broadcastSSE('rawUrls', { taskId, rawUrls: [localUrl] });
    res.json({ success: true, url: localUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/log', (req, res) => {
  const { level, message } = req.body;
  const prefix = '\x1b[36m[Tampermonkey]\x1b[0m';
  if (level === 'error') console.error(`${prefix} \x1b[31m${message}\x1b[0m`);
  else if (level === 'warn') console.warn(`${prefix} \x1b[33m${message}\x1b[0m`);
  else console.log(`${prefix} ${message}`);
  res.json({ success: true });
});

router.get('/inbox/:taskId', (req, res) => {
  const { taskId } = req.params;
  const record = results.get(taskId);
  if (!record) return res.status(404).json({ success: false, error: 'Task not found' });
  res.json({ success: true, status: record.status, progress: record.progress, error: record.error, urls: record.urls, rawUrls: record.rawUrls, reply: record.reply });
});

// ============================================================
// Watchdog 看门狗与迟滞匹配
// ============================================================
const claimPool = new Map();
const unclaimedFiles = new Map();

function triggerWatchdog(taskId) {
  console.log(`[Tampermonkey] 收到大图下载预警，启动看门狗锁定 taskId: ${taskId}`);

  const now = Date.now();
  let matchedFile = null;
  const taskRecord = results.get(taskId);
  const isTaskVideo = taskRecord?.payload?.model === 'video';
  for (const [filePath, timestamp] of unclaimedFiles.entries()) {
    if (now - timestamp <= 30 * 1000) {
      const ext = path.extname(filePath).toLowerCase();
      const isVideoFile = ['.mp4', '.webm'].includes(ext);
      if ((isTaskVideo && isVideoFile) || (!isTaskVideo && !isVideoFile)) {
        matchedFile = filePath;
        break;
      }
    } else {
      unclaimedFiles.delete(filePath);
    }
  }

  if (matchedFile) {
    console.log(`[Watchdog] 迟滞匹配成功！为任务 ${taskId} 打捞到早前落盘的大图: ${path.basename(matchedFile)}`);
    processDownloadedFile(matchedFile, taskId);
    unclaimedFiles.delete(matchedFile);
  } else {
    const exts = isTaskVideo ? ['.mp4', '.webm'] : ['.png', '.jpg', '.jpeg', '.webp'];
    const scanResult = scanDownloadsForRecentMedia(watchPaths, exts, 30 * 1000);
    if (scanResult) {
      console.log(`[Watchdog] 主动扫描兜底成功！为任务 ${taskId} 找到大图: ${path.basename(scanResult)}`);
      processDownloadedFile(scanResult, taskId);
    } else {
      claimPool.set(taskId, now);
      console.log(`[Watchdog] 暂未发现匹配文件，taskId ${taskId} 已进入待认领池.`);
    }
  }

  for (const [key, timestamp] of claimPool.entries()) {
    if (now - timestamp > 10 * 60 * 1000) claimPool.delete(key);
  }
}

router.post('/download-alert', (req, res) => {
  try {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: 'Missing taskId' });
    triggerWatchdog(taskId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function getRealDownloadsPath() {
  let defaultPath = path.join(os.homedir(), 'Downloads');
  if (os.platform() === 'win32') {
    try {
      const stdout = child_process.execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" /v "{374DE290-123F-4565-9164-39C4925E467B}"', { encoding: 'utf8' });
      const match = stdout.match(/REG_EXPAND_SZ\s+([^\r\n]+)/);
      if (match && match[1]) {
        let regPath = match[1].trim().replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
        if (fs.existsSync(regPath)) return regPath;
      }
    } catch (e) { }
  }
  return defaultPath;
}

const realDownloadsPath = getRealDownloadsPath();
const outputDirPath = config.OUTPUT_DIR;
// 看门狗必须同时监控两个目录：
// 1. OUTPUT_DIR —— 后端 push-url/push-media 主动下载的缩略图落盘目录
// 2. 浏览器真实 Downloads —— downloadBtn.click() 原生下载的大图落盘目录
const watchPaths = [outputDirPath];
if (realDownloadsPath !== outputDirPath && fs.existsSync(realDownloadsPath)) {
  watchPaths.push(realDownloadsPath);
}
console.log(`[Watchdog] 启动看门狗，全天候监控: ${watchPaths.join(' + ')}`);

const processedScanFiles = new Set();
function scanDownloadsForRecentMedia(dirPaths, exts, withinMs) {
  // 支持同时扫描多个目录（output + Downloads）
  const dirs = Array.isArray(dirPaths) ? dirPaths : [dirPaths];
  try {
    const now = Date.now();
    let bestMatch = null;
    let bestTime = 0;
    for (const dirPath of dirs) {
      if (!fs.existsSync(dirPath)) continue;
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (!exts.includes(ext)) continue;
        const fullPath = path.join(dirPath, file);
        if (processedScanFiles.has(fullPath)) continue;
        try {
          const mtime = fs.statSync(fullPath).mtimeMs;
          if (now - mtime <= withinMs && mtime > bestTime) {
            bestMatch = fullPath;
            bestTime = mtime;
          }
        } catch (e) { }
      }
    }
    if (bestMatch) {
      processedScanFiles.add(bestMatch);
      if (processedScanFiles.size > 200) processedScanFiles.clear();
    }
    return bestMatch;
  } catch (e) { return null; }
}

async function processDownloadedFile(filePath, taskId) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    const currentRecord = results.get(taskId);
    let finalUrl = "";
    const ts = Date.now();

    // 满足用户意愿：同一个任务的id永远只有一张图，直接硬覆写同一个物理文件！
    const filename = `bridge_media_${taskId}${ext}`;
    const targetPath = path.join(config.OUTPUT_DIR, filename);

    // 使用带重试的重命名（移动），确保 output 目录里只留下唯一一份文件
    await renameFileWithRetry(filePath, targetPath);
    console.log(`[Watchdog] 遵循指令：强制物理覆盖生成最终高清大图 ${filename}`);

    // 加上时间戳，强制前端连带缩略图一起重新加载，打破缓存死锁
    finalUrl = `http://127.0.0.1:18766/output/${filename}?t=${ts}`;

    // 满足用户意愿：不需要保留浏览器原生下载的原文件，重命名后原文件自动消失
    console.log(`[Watchdog] 遵循指令：原文件已通过重命名(剪切)处理，不再保留原始物理文件: ${filePath}`);

    // 满足用户意愿：同一个任务的id永远只有一张图
    const rawUrls = [finalUrl];

    if (currentRecord) {
      results.set(taskId, {
        ...currentRecord,
        rawUrls: rawUrls,
        urls: rawUrls,
        status: 'completed',
        progress: '100%'
      });
      console.log(`[Watchdog] 取证闭环完成！任�?${taskId} 强制结案并挂载无损原�?`);
    } else {
      console.log(`[Watchdog] (幽灵任务) 后端已无记录，强行推�?`);
    }

    broadcastSSE('rawUrls', { taskId, rawUrls });
    console.log(`[SSE] 已推�?rawUrls(含破缓存时间�? 到前端`);
    claimPool.delete(taskId);
  } catch (err) {
    console.error("[Watchdog] 报错:", err);
  }
}

const watcher = chokidar.watch(watchPaths, {
  ignored: /(^|[\/\\])\../, persistent: true, ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 }
});

watcher.on('ready', () => {
  console.log('[Watchdog] chokidar ready, watching: ' + watchPaths.join(' + '));
});

// 诊断日志：记录所有文件事件，排查 chokidar 是否收到浏览器下载
watcher.on('all', (event, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (['.png','.jpg','.jpeg','.mp4','.webm','.webp','.crdownload','.tmp'].includes(ext) || claimPool.size > 0) {
    console.log('[Watchdog:FS] ' + event + ' -> ' + path.basename(filePath) + ' (claimPool: ' + claimPool.size + ')');
  }
});

// 核心匹配逻辑：add 和 change 共用
function handleFileDetected(filePath, eventType) {
  const filename = path.basename(filePath);
  if (filename.startsWith('bridge_')) return;
  const ext = path.extname(filePath).toLowerCase();
  if (['.png','.jpg','.jpeg','.mp4','.webm','.webp'].includes(ext)) {
    console.log('[Watchdog] media ' + eventType + ': ' + filename + ' (claimPool=' + claimPool.size + ')');
    const isVideoFile = ['.mp4','.webm'].includes(ext);
    if (claimPool.size > 0) {
      const entries = Array.from(claimPool.entries());
      entries.sort((a, b) => b[1] - a[1]);
      let matchedTaskId = null;
      for (const [taskId, _] of entries) {
        const taskRecord = results.get(taskId);
        const isTaskVideo = taskRecord?.payload?.model === 'video';
        if ((isVideoFile && isTaskVideo) || (!isVideoFile && !isTaskVideo)) { matchedTaskId = taskId; break; }
      }
      if (matchedTaskId) {
        console.log('[Watchdog] MATCHED! ' + filename + ' => ' + matchedTaskId);
        processDownloadedFile(filePath, matchedTaskId);
      } else {
        console.log('[Watchdog] type mismatch, no matching task: ' + filename);
        unclaimedFiles.set(filePath, Date.now());
      }
    } else {
      console.log('[Watchdog] file detected but no alert pending: ' + filename);
      unclaimedFiles.set(filePath, Date.now());
    }
  }
}

watcher.on('add', (filePath) => handleFileDetected(filePath, 'add'));
// 兜底：浏览器覆盖已有文件时 chokidar 触发 change 而非 add
watcher.on('change', (filePath) => handleFileDetected(filePath, 'change'));

async function renameFileWithRetry(src, dest, maxRetries = 10, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (!fs.existsSync(src)) {
        throw new Error("源文件尚未创建完成");
      }
      const stats = fs.statSync(src);
      if (stats.size === 0) {
        throw new Error("文件大小为 0，可能尚未完成下载");
      }
      // 遵循用户最新指令：不需要保留原文件，使用 rename 进行重命名（剪切），这样就不会产生两份文件
      fs.renameSync(src, dest);
      return true;
    } catch (err) {
      if (i === maxRetries - 1) {
        throw err;
      }
      console.log(`[Watchdog] 文件被占用或未写完，等待 ${delayMs}ms 重试 (${i + 1}/${maxRetries}): ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

module.exports = router;
