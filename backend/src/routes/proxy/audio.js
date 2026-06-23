const express = require('express');
const router = express.Router();
const config = require('../../config');
const {
  loadRawSettings,
  applyClassifiedKey,
  ensureKey,
  rememberTaskKey,
  recallTaskMeta,
  parseProviderParams,
  ensureKeyOrSelectedGroup,
  applyZhenzhenProviderContext,
  invalidateZhenzhenProviderKey,
  saveRemoteAudio,
  audioUpload
} = require('./_helpers');

router.post('/audio/submit', async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验 —— 先 applyClassifiedKey('suno') 再校验 effective key
  const { mode, prompt, title, tags, version, seed, continue_clip_id, continue_at, cover_clip_id, providerParams } = req.body || {};
  if (!ensureKeyOrSelectedGroup(settings, res, 'suno', 'Suno', providerParams)) return;
  const m = mode || 'generate';
  if (!prompt && m !== 'extend') {
    return res.status(400).json({ success: false, error: 'prompt 必填' });
  }
  const mv = resolveSunoMv(version);
  try {
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'audio/submit',
      kind: 'audio',
      model: `suno-${version || 'v5.5'}`,
      hint: 'suno',
      providerParams,
    });
    const apiKey = settings.zhenzhenApiKey;
    const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    if (m === 'generate') {
      const body = { prompt: prompt || '', tags: tags || '', mv, title: title || '' };
      if (seed && seed > 0) body.seed = seed;
      const r = await fetch(`${config.ZHENZHEN_BASE_URL}/suno/generate`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
      if (!r.ok) {
        const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
        await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
        return res.status(r.status).json({ success: false, error: errorText });
      }
      const taskId = data?.id;
      const clipIds = (data?.clips || []).map((c) => c.id).filter(Boolean);
      if (!taskId || clipIds.length < 1) return res.status(500).json({ success: false, error: '未获取到 task/clip: ' + text.slice(0, 200) });
      rememberTaskKey(taskId, apiKey, { model: `suno-${version || 'v5.5'}`, ...providerContext.taskMeta });
      for (const clipId of clipIds) rememberTaskKey(clipId, apiKey, { model: `suno-${version || 'v5.5'}`, taskId, ...providerContext.taskMeta });
      return res.json({ success: true, data: { taskId, clipIds, raw: data } });
    }
    if (m === 'extend') {
      if (!continue_clip_id) return res.status(400).json({ success: false, error: 'extend 模式需 continue_clip_id' });
      const body = { prompt: prompt || '', tags: tags || '', mv, title: title || '', task: 'upload_extend', continue_clip_id, continue_at: continue_at ?? 28 };
      if (seed && seed > 0) body.seed = seed;
      const r = await fetch(`${config.ZHENZHEN_BASE_URL}/suno/generate`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
      if (!r.ok) {
        const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
        await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
        return res.status(r.status).json({ success: false, error: errorText });
      }
      const taskId = data?.id;
      const clipIds = (data?.clips || []).map((c) => c.id).filter(Boolean);
      if (!taskId) return res.status(500).json({ success: false, error: '未获取 task' });
      rememberTaskKey(taskId, apiKey, { model: `suno-${version || 'v5.5'}`, ...providerContext.taskMeta });
      for (const clipId of clipIds) rememberTaskKey(clipId, apiKey, { model: `suno-${version || 'v5.5'}`, taskId, ...providerContext.taskMeta });
      return res.json({ success: true, data: { taskId, clipIds, raw: data } });
    }
    if (m === 'cover') {
      if (!cover_clip_id) return res.status(400).json({ success: false, error: 'cover 模式需 cover_clip_id' });
      const body = {
        prompt: prompt || '', tags: tags || '', mv, title: title || '', task: 'cover',
        cover_clip_id, generation_type: 'TEXT', make_instrumental: false, negative_tags: '',
        continue_clip_id: null, continue_at: null, continued_aligned_prompt: null,
        infill_start_s: null, infill_end_s: null,
      };
      if (seed && seed > 0) body.seed = seed;
      const r = await fetch(`${config.ZHENZHEN_BASE_URL}/suno/submit/music`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
      if (!r.ok) {
        const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
        await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
        return res.status(r.status).json({ success: false, error: errorText });
      }
      const taskId = (typeof data?.data === 'string' ? data.data : data?.id) || '';
      const clipIds = Array.isArray(data?.data) ? data.data.map((c) => c.id || c.clip_id).filter(Boolean) : (data?.clips || []).map((c) => c.id);
      if (!taskId) return res.status(500).json({ success: false, error: '未获取 task: ' + text.slice(0, 200) });
      rememberTaskKey(taskId, apiKey, { model: `suno-${version || 'v5.5'}`, ...providerContext.taskMeta });
      for (const clipId of clipIds) rememberTaskKey(clipId, apiKey, { model: `suno-${version || 'v5.5'}`, taskId, ...providerContext.taskMeta });
      return res.json({ success: true, data: { taskId, clipIds, raw: data } });
    }
    return res.status(400).json({ success: false, error: `未知模式: ${m}` });
  } catch (e) {
    console.error('proxy/audio/submit 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

router.get('/audio/query', async (req, res) => {
  const settings = loadRawSettings();
  const ids = String(req.query.clipIds || req.query.taskId || '').trim();
  if (!ids) return res.status(400).json({ success: false, error: 'clipIds 或 taskId 必填' });
  const rememberedMeta = recallTaskMeta(ids.split(',')[0]?.trim() || ids);
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
    if (!ensureKey(settings, res, 'suno', 'Suno')) return;
  }
  // 是否将完成的音频转存到本地 output 目录(默认 true)
  const saveLocal = String(req.query.saveLocal ?? 'true').toLowerCase() !== 'false';
  try {
    const r = await fetch(`${config.ZHENZHEN_BASE_URL}/suno/feed/${encodeURIComponent(ids)}`, {
      headers: { Authorization: `Bearer ${settings.zhenzhenApiKey}` },
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey({ taskMeta: rememberedMeta || {} }, settings.zhenzhenApiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText });
    }
    const clips = Array.isArray(data) ? data : (data?.clips || []);
    const tracks = [];
    for (const c of clips) {
      if (c?.status === 'complete' && c?.audio_url) {
        const remoteUrl = c.audio_url;
        const localUrl = saveLocal ? await saveRemoteAudio(remoteUrl) : remoteUrl;
        tracks.push({
          id: c.id || c.clip_id,
          clipId: c.clip_id || c.id,
          audioUrl: localUrl,
          remoteUrl,
          imageUrl: c.image_large_url || c.image_url || '',
          title: c.title || '',
          tags: c.tags || '',
          duration: c.metadata?.duration || 0,
        });
      }
    }
    const allDone = clips.length > 0 && tracks.length === clips.length;
    res.json({
      success: true,
      data: {
        status: allDone ? 'SUCCESS' : 'PENDING',
        tracks,
        total: clips.length,
        completed: tracks.length,
        raw: data,
      },
    });
  } catch (e) {
    console.error('proxy/audio/query 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// ========================================================================
// 音频上传 (Suno cover/extend 使用)
// 完全对齐主项目 gpt-image-2-web 的 _sunoUploadAudio 5 步流程:
// 1) POST /suno/uploads/audio { extension }  -> { id, url, fields? }
// 2) S3 上传: 有 fields 走 POST FormData / 无 fields 走 PUT 预签 URL
// 3) POST /suno/uploads/audio/{id}/upload-finish { upload_type, upload_filename }
// 4) GET /suno/uploads/audio/{id} 轮询 30 × 2s 直到 status='complete'
// 5) POST /suno/uploads/audio/{id}/initialize-clip {} -> { clip_id }
// ========================================================================
router.post('/audio/upload', audioUpload.single('file'), async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 修复 BUG —— 之前完全缺失 applyClassifiedKey('suno')，
  // 导致 Suno cover/extend 上传步骤即使配置了 sunoApiKey 也始终用通用 zhenzhenApiKey，
  // 与 audio/submit · audio/query 的 key 不一致。改用 ensureKey 统一「专属优先 fallback 通用」。
  if (!req.file) return res.status(400).json({ success: false, error: '未接收到音频文件 (field=file)' });
  const providerParams = parseProviderParams(req.body?.providerParams);
  if (!ensureKeyOrSelectedGroup(settings, res, 'suno', 'Suno', providerParams)) return;
  let apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const audioBuf = req.file.buffer;
  const filename = req.file.originalname || 'audio.mp3';
  const ext = (filename.split('.').pop() || 'mp3').toLowerCase();
  const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', wma: 'audio/x-ms-wma' };
  const ct = mimeMap[ext] || req.file.mimetype || 'audio/mpeg';
  try {
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'audio/upload',
      kind: 'audio',
      model: 'suno-upload',
      hint: 'suno',
      providerParams,
    });
    apiKey = settings.zhenzhenApiKey;
    // 1) init
    const r1 = await fetch(`${baseUrl}/suno/uploads/audio`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ extension: ext }),
    });
    if (!r1.ok) {
      const errorText = `Upload init failed: ${r1.status} ${await r1.text()}`;
      await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
      return res.status(r1.status).json({ success: false, error: errorText });
    }
    const r1Json = await r1.json();
    const upData = (r1Json.code && r1Json.data) ? r1Json.data : r1Json;
    const uploadId = upData.id;
    const uploadUrl = upData.url;
    const fields = upData.fields;
    if (!uploadId || !uploadUrl) return res.status(500).json({ success: false, error: 'Upload init 返回无效: missing id/url' });
    // 2) S3 upload
    let r2;
    if (fields && Object.keys(fields).length > 0) {
      const fd = new FormData();
      Object.keys(fields).forEach((k) => fd.append(k, fields[k]));
      fd.append('file', new Blob([audioBuf], { type: ct }), filename);
      r2 = await fetch(uploadUrl, { method: 'POST', body: fd });
    } else {
      r2 = await fetch(uploadUrl, { method: 'PUT', body: audioBuf, headers: { 'Content-Type': ct } });
    }
    if (r2.status !== 204 && r2.status !== 200 && !r2.ok) {
      return res.status(500).json({ success: false, error: `S3 upload failed: ${r2.status}` });
    }
    // 3) finish
    const r3 = await fetch(`${baseUrl}/suno/uploads/audio/${uploadId}/upload-finish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_type: 'file_upload', upload_filename: filename }),
    });
    if (!r3.ok) {
      const errorText = `Upload finish failed: ${r3.status} ${await r3.text()}`;
      await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
      return res.status(500).json({ success: false, error: errorText });
    }
    // 4) poll status
    let clipId = '';
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const sr = await fetch(`${baseUrl}/suno/uploads/audio/${uploadId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!sr.ok) continue;
      const srJson = await sr.json();
      const sd = (srJson.code && srJson.data) ? srJson.data : srJson;
      const st = sd.status || sd.state || '';
      if (st === 'complete') {
        // 5) initialize-clip
        const r4 = await fetch(`${baseUrl}/suno/uploads/audio/${uploadId}/initialize-clip`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!r4.ok) {
          const errorText = `Initialize clip failed: ${r4.status} ${await r4.text()}`;
          await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
          return res.status(500).json({ success: false, error: errorText });
        }
        const r4Json = await r4.json();
        const initData = (r4Json.code && r4Json.data) ? r4Json.data : r4Json;
        clipId = initData.clip_id || initData.id || '';
        break;
      } else if (st === 'failed' || st === 'error') {
        const errMsg = sd.error_message || sd.error || sd.detail || sd.message || st;
        return res.status(500).json({ success: false, error: `音频处理失败: ${errMsg}` });
      }
    }
    if (!clipId) return res.status(504).json({ success: false, error: 'Upload timeout - no clip_id (60s)' });
    return res.json({ success: true, data: { clipId, uploadId, filename, size: req.file.size, mime: ct } });
  } catch (e) {
    console.error('proxy/audio/upload 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// ========================================================================
// RunningHub 工作流(异步)
// 协议:POST /task/openapi/ai-app/run + POST /task/openapi/outputs
// API Key 取自 settings.rhApiKey（与 settings.js / 前端 ApiSettings 字段保持一致；
// 历史代码误写为 runninghubApiKey 导致永远读不到，已修正）
// v1.2.9.16: 取消 rhWalletApiKey 单独字段 —— 普通 RH 节点 与 RH 钱包应用节点
//            统一使用 settings.rhApiKey，简化用户配置心智。
// ========================================================================
// 统一选 key 工具：所有 RH 调用只用 settings.rhApiKey。
function pickRhApiKey(settings) {
  return settings?.rhApiKey || settings?.runninghubApiKey || '';
}
function missingRhKeyError() {
  return '未配置 RunningHub API Key（请在设置中填写 RunningHub API Key）';
}

module.exports = router;
