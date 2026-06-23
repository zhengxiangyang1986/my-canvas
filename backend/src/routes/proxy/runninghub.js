const express = require('express');
const router = express.Router();
const config = require('../../config');
const {
  safeOutputExt,
  inferRemoteOutputExt,
  loadRawSettings
} = require('./_helpers');

router.post('/runninghub/submit', async (req, res) => {
  const settings = loadRawSettings();
  const { webappId, nodeInfoList, instanceType } = req.body || {};
  const apiKey = pickRhApiKey(settings);
  if (!apiKey) return res.status(400).json({ success: false, error: missingRhKeyError() });
  if (!webappId) return res.status(400).json({ success: false, error: 'webappId 必填' });
  try {
    const body = { apiKey, webappId, nodeInfoList: nodeInfoList || [] };
    if (instanceType) body.instanceType = instanceType;
    const r = await fetch(`${config.RH_BASE_URL}/task/openapi/ai-app/run`, {
      method: 'POST',
      headers: { Host: 'www.runninghub.cn', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.code === 0) {
      const taskId = data?.data?.taskId;
      return res.json({ success: true, data: { taskId, raw: data } });
    }
    return res.status(400).json({ success: false, error: data.msg || `RH 提交失败 code=${data.code}` });
  } catch (e) {
    console.error('proxy/rh/submit 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

router.get('/runninghub/query', async (req, res) => {
  const settings = loadRawSettings();
  const apiKey = pickRhApiKey(settings);
  if (!apiKey) return res.status(400).json({ success: false, error: missingRhKeyError() });
  const taskId = String(req.query.taskId || '').trim();
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId 必填' });
  try {
    const r = await fetch(`${config.RH_BASE_URL}/task/openapi/outputs`, {
      method: 'POST',
      headers: { Host: 'www.runninghub.cn', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, taskId }),
    });
    const data = await r.json();
    // code 0=成功 / 804=运行中 / 813=排队 / 805=失败
    let status = 'PENDING';
    let urls = [];
    if (data.code === 0) {
      status = 'SUCCESS';
      // RH outputs 返回结构兼容：
      //   ① data: [{fileUrl, fileType}, ...]                  // 常见 (AI 应用)
      //   ② data: { outputs: [...] }                            // 包一层的变体
      //   ③ data: { fileUrl, fileType }                         // 单产物对象
      //   ④ data: { results: [...] } / { files: [...] }         // 边缘变体
      let arr = [];
      const dd = data.data;
      if (Array.isArray(dd)) arr = dd;
      else if (dd && typeof dd === 'object') {
        if (Array.isArray(dd.outputs)) arr = dd.outputs;
        else if (Array.isArray(dd.results)) arr = dd.results;
        else if (Array.isArray(dd.files)) arr = dd.files;
        else if (dd.fileUrl || dd.url) arr = [dd];
      }
      console.log('[RH/query]', taskId, '产物数:', arr.length, '原始 code:', data.code);
      // 转存所有产物到本地
      for (const it of arr) {
        const remote = it?.fileUrl || it?.url;
        if (!remote) continue;
        try {
          const fr = await fetch(remote);
          if (fr.ok) {
            let buf = Buffer.from(await fr.arrayBuffer());
            let ext = inferRemoteOutputExt(remote, fr.headers.get('content-type'));
            const duck = await tryDecodeDuckPayload(buf);
            if (duck?.decoded && duck.buffer) {
              buf = duck.buffer;
              ext = safeOutputExt(duck.ext, ext);
              console.log(
                '[RH/query][duck] decoded',
                `bits=${duck.lsbBits}`,
                `${duck.originalExt} -> ${ext}`,
                `kind=${duck.kind}`,
                `bytes=${buf.length}`,
              );
            } else if (duck?.passwordProtected) {
              console.log('[RH/query][duck] password protected payload detected, keep original duck image');
            }
            const filename = `rh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
            fs.writeFileSync(path.join(config.OUTPUT_DIR, filename), buf);
            urls.push(`/files/output/${filename}`);
          } else {
            urls.push(remote);
          }
        } catch {
          urls.push(remote);
        }
      }
    } else if (data.code === 804) status = 'RUNNING';
    else if (data.code === 813) status = 'QUEUED';
    else if (data.code === 805) status = 'FAILED';
    else status = 'UNKNOWN';
    // failReason 序列化为字符串：ComfyUI 报错可能是 object（traceback/exception_message/...）
    // 前端直接用于 setError 会造成 React JSX 渲染 object 崩溃。
    let failReasonRaw = data?.data?.failedReason ?? data?.data?.failReason ?? null;
    let failReasonStr = null;
    if (failReasonRaw != null) {
      if (typeof failReasonRaw === 'string') {
        failReasonStr = failReasonRaw;
      } else if (typeof failReasonRaw === 'object') {
        failReasonStr = failReasonRaw.exception_message || failReasonRaw.message || JSON.stringify(failReasonRaw);
      } else {
        failReasonStr = String(failReasonRaw);
      }
    }
    res.json({
      success: true,
      data: {
        status,
        urls,
        failReason: failReasonStr,
        code: data.code,
        raw: data,
      },
    });
  } catch (e) {
    console.error('proxy/rh/query 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// ----------------------------------------------------------------
// POST /runninghub/upload-asset
// 通用素材→RH 上传转换：
//   入参 JSON: { url: '/files/output/xxx.png' | 'https://....' }
//   出参: { success, data: { fileName, fileType } }
// 用途: RhConfigNode 中 valueType=image|video|audio 的条目，
//       提交工作流前先把 url 转成 RH 内部 fileName，再写入 nodeInfoList.fieldValue。
// 协议: POST {RH}/task/openapi/upload  (multipart: apiKey, fileType=input, file)
// ----------------------------------------------------------------
router.post('/runninghub/upload-asset', express.json({ limit: '20mb' }), async (req, res) => {
  const settings = loadRawSettings();
  const apiKey = pickRhApiKey(settings);
  if (!apiKey) return res.status(400).json({ success: false, error: missingRhKeyError() });
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ success: false, error: 'url 必填' });
  try {
    // 1) 拿到 buffer + mime + filename
    let buf;
    let mime = 'application/octet-stream';
    let baseName = 'asset';
    if (url.startsWith('/files/output/') || url.startsWith('/output/')) {
      // 本地静态资源 - 输出目录
      const rel = url.replace(/^\/files\/output\//, '').replace(/^\/output\//, '');
      const full = path.join(config.OUTPUT_DIR, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ success: false, error: '本地文件不存在: ' + url });
      buf = fs.readFileSync(full);
      baseName = path.basename(full);
    } else if (url.startsWith('/files/input/') || url.startsWith('/input/')) {
      // 本地静态资源 - 上传目录（视频/音频/参考图上传节点的产物）
      const rel = url.replace(/^\/files\/input\//, '').replace(/^\/input\//, '');
      const full = path.join(config.INPUT_DIR, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ success: false, error: '本地文件不存在: ' + url });
      buf = fs.readFileSync(full);
      baseName = path.basename(full);
    } else if (/^https?:\/\//i.test(url)) {
      const fr = await fetch(url);
      if (!fr.ok) return res.status(400).json({ success: false, error: `下载素材失败 HTTP ${fr.status}` });
      buf = Buffer.from(await fr.arrayBuffer());
      mime = fr.headers.get('content-type') || mime;
      const tail = url.split(/[?#]/)[0];
      baseName = tail.split('/').pop() || baseName;
    } else {
      return res.status(400).json({ success: false, error: '不支持的 url: ' + url });
    }
    // 2) 根据扩展名校正 mime
    const extMatch = baseName.match(/\.([a-zA-Z0-9]+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    const mimeMap = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', mkv: 'video/x-matroska',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
    };
    if (mimeMap[ext]) mime = mimeMap[ext];
    if (!ext) baseName += '.bin';
    // 3) FormData 上传到 RH
    const fd = new FormData();
    fd.append('apiKey', apiKey);
    fd.append('fileType', 'input');
    const blob = new Blob([buf], { type: mime });
    fd.append('file', blob, baseName);
    const r = await fetch(`${config.RH_BASE_URL}/task/openapi/upload`, {
      method: 'POST',
      headers: { Host: 'www.runninghub.cn' },
      body: fd,
    });
    const data = await r.json();
    console.log('[RH/upload-asset]', baseName, mime, buf.length, '→', data?.code, data?.data?.fileName);
    if (data.code === 0 && data?.data?.fileName) {
      return res.json({ success: true, data: { fileName: data.data.fileName, fileType: data.data.fileType || mime } });
    }
    return res.status(400).json({ success: false, error: data.msg || `RH 上传失败 code=${data.code}` });
  } catch (e) {
    console.error('proxy/rh/upload-asset 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// 获取 AI 应用信息(nodeInfoList 等)
router.get('/runninghub/app-info', async (req, res) => {
  const settings = loadRawSettings();
  const apiKey = pickRhApiKey(settings);
  if (!apiKey) return res.status(400).json({ success: false, error: missingRhKeyError() });
  const webappId = String(req.query.webappId || '').trim();
  if (!webappId) return res.status(400).json({ success: false, error: 'webappId 必填' });
  try {
    const url = `${config.RH_BASE_URL}/api/webapp/apiCallDemo?apiKey=${encodeURIComponent(apiKey)}&webappId=${encodeURIComponent(webappId)}`;
    const r = await fetch(url, { method: 'GET', headers: { Host: 'www.runninghub.cn' } });
    const data = await r.json();
    if (data.code !== 0) return res.status(400).json({ success: false, error: data.msg || `RH 查询失败 code=${data.code}` });
    res.json({ success: true, data: data.data || {} });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

module.exports = router;
