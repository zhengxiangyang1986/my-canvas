const express = require('express');
const router = express.Router();
const config = require('../../config');
const {
  safeOutputExt,
  loadRawSettings,
  ensureKey,
  ensureDefaultZhenzhenKey,
  rememberTaskKey,
  recallTaskMeta,
  ensureKeyOrSelectedGroup,
  applyZhenzhenProviderContext,
  invalidateZhenzhenProviderKey,
  saveRemoteImage,
  saveRemoteAudio,
  refToBuffer,
  refToBananaImage
} = require('./_helpers');

router.post('/video/fal/submit', async (req, res) => {
  const settings = loadRawSettings();
  const {
    apiModel, prompt, images,
    // veo-fal
    aspect_ratio, duration, resolution, generate_audio, safety_tolerance, image_mode,
    // grok-fal
    gkDuration, gkRatio, gkMode, gkReferenceUrls,
    // sora-fal
    soraMode, soraRatio, soraDuration, soraResolution, soraDeleteVideo, soraBlockIp, soraCharacterIds,
  } = req.body || {};
  const rawApiModel = String(apiModel || '').trim();
  // 历史节点里可能保存过日期版 Sora2 选项；T8 现在只暴露稳定的 sora-2 FAL。
  const effectiveApiModel = /^sora-2(?:-\d{4}-\d{2}-\d{2})?$/.test(rawApiModel) ? 'sora-2' : rawApiModel;
  // FAL 全部固定使用通用贞贞 API Key，不参与 New API 分组令牌。
  if (!ensureDefaultZhenzhenKey(settings, res, '视频 FAL')) return;
  let apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;

  if (!rawApiModel) return res.status(400).json({ success: false, error: 'apiModel 必填' });
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt 不得为空' });

  const reg = VIDEO_FAL_REGISTRY[effectiveApiModel];
  if (!reg) return res.status(400).json({ success: false, error: `未知的 Video FAL 模型: ${rawApiModel}` });

  const refs = Array.isArray(images) ? images.filter(Boolean) : [];
  const trimmedRefs = refs.slice(0, reg.maxRefImages);

  let payload;
  let endpoint;
  try {
    if (reg.paramKind === 'veo-fal') {
      // ===== Veo3.1 FAL (主项目 runVeo3Fal line 3694) =====
      endpoint = reg.endpoint;
      payload = {
        prompt,
        aspect_ratio: String(aspect_ratio || '16:9'),
        duration: String(duration || '8s'),
        resolution: String(resolution || '720p'),
        generate_audio: generate_audio === true,
        safety_tolerance: parseInt(safety_tolerance ?? 4, 10) || 4,
      };
      // 参考图(最多 3 张)
      if (trimmedRefs.length) {
        const imgArr = [];
        const useBase64 = String(image_mode || 'image_url') === 'base64';
        for (let i = 0; i < trimmedRefs.length; i++) {
          if (useBase64) {
            // base64 直传
            const conv = await refToBananaImage(trimmedRefs[i]);
            if (conv) imgArr.push(conv);
          } else {
            const u = await uploadRefToZhenzhen(trimmedRefs[i], apiKey);
            if (u) imgArr.push(u);
            else throw new Error(`FAL 参考图 #${i + 1} 上传失败`);
          }
        }
        if (imgArr.length) payload.image_urls = imgArr;
      }
    } else if (reg.paramKind === 'grok-fal') {
      // ===== Grok Video FAL (主项目 runGrokFal line 3787) =====
      const isV15 = effectiveApiModel === 'grok-imagine-video-1.5';
      const mode = isV15
        ? 'image_to_video'
        : String(gkMode || 'image_to_video') === 'reference_to_video' ? 'reference_to_video' : 'image_to_video';
      const extraReferenceUrls = splitGrokReferenceUrls(gkReferenceUrls);
      const hasImg = trimmedRefs.length > 0;
      const effectiveRatio = (mode === 'reference_to_video' || !hasImg) && String(gkRatio || '16:9') === 'auto'
        ? '16:9'
        : String(gkRatio || '16:9');
      payload = {
        prompt,
        duration: parseInt(gkDuration ?? 6, 10) || 6,
        resolution: String(resolution || '720p'),
      };
      if (!isV15) payload.aspect_ratio = effectiveRatio;
      const useBase64 = String(image_mode || reg.defaultImageMode || 'base64') === 'base64';
      if (isV15) {
        endpoint = reg.endpoint;
        if (!hasImg) throw new Error('Grok Video 1.5 requires one uploaded image');
        const imgData = useBase64
          ? await refToBananaImage(trimmedRefs[0])
          : await uploadRefToZhenzhen(trimmedRefs[0], apiKey);
        if (imgData) payload.image_url = imgData;
        else throw new Error('Grok Video 1.5 参考图处理失败');
      } else if (mode === 'reference_to_video') {
        endpoint = reg.referenceEndpoint || reg.i2vEndpoint || reg.endpoint;
        const referenceImageUrls = [];
        const uploadRefs = trimmedRefs.slice(0, 7);
        for (let i = 0; i < uploadRefs.length && referenceImageUrls.length < 7; i++) {
          const imgData = useBase64
            ? await refToBananaImage(uploadRefs[i])
            : await uploadRefToZhenzhen(uploadRefs[i], apiKey);
          if (imgData) referenceImageUrls.push(imgData);
          else throw new Error(`Grok FAL 参考图 #${i + 1} 处理失败`);
        }
        for (const url of extraReferenceUrls) {
          if (referenceImageUrls.length >= 7) break;
          referenceImageUrls.push(url);
        }
        if (!referenceImageUrls.length) throw new Error('Grok FAL 参考生视频需要至少 1 张参考图或 URL');
        payload.reference_image_urls = referenceImageUrls;
      } else {
        endpoint = hasImg ? (reg.i2vEndpoint || reg.endpoint) : reg.endpoint;
        // 图生视频模式: 单张 image_url；无图时保留文生视频 fallback。
        if (hasImg) {
          const imgData = useBase64
            ? await refToBananaImage(trimmedRefs[0])
            : await uploadRefToZhenzhen(trimmedRefs[0], apiKey);
          if (imgData) payload.image_url = imgData;
          else throw new Error('Grok FAL 参考图处理失败');
        }
      }
    } else if (reg.paramKind === 'sora-fal') {
      // ===== Sora2 FAL (主项目 runSora2Fal line 5341) =====
      const hasImg = trimmedRefs.length > 0;
      let mode = String(soraMode || 'auto');
      if (!['auto', 'text_to_video', 'image_to_video'].includes(mode)) mode = 'auto';
      if (mode === 'auto') mode = hasImg ? 'image_to_video' : 'text_to_video';
      if (mode === 'image_to_video' && !hasImg) throw new Error('FAL Sora2 image-to-video requires one uploaded image');

      const ratio = String(soraRatio || aspect_ratio || '16:9');
      const reso = String(soraResolution || resolution || '720p');
      endpoint = mode === 'image_to_video' ? (reg.i2vEndpoint || reg.endpoint) : reg.endpoint;
      payload = {
        prompt,
        resolution: mode === 'text_to_video' && reso === 'auto' ? '720p' : reso,
        aspect_ratio: mode === 'text_to_video' && ratio === 'auto' ? '16:9' : ratio,
        duration: parseInt(soraDuration ?? duration ?? 4, 10) || 4,
        delete_video: soraDeleteVideo !== false,
        model: effectiveApiModel,
        detect_and_block_ip: soraBlockIp === true,
      };
      const ids = splitSoraCharacterIds(soraCharacterIds);
      if (ids.length) payload.character_ids = ids;
      if (mode === 'image_to_video') {
        const useBase64 = String(image_mode || 'base64') === 'base64';
        const imgData = useBase64
          ? await refToBananaImage(trimmedRefs[0])
          : await uploadRefToZhenzhen(trimmedRefs[0], apiKey);
        if (imgData) payload.image_url = imgData;
        else throw new Error('Sora2 FAL 参考图处理失败');
      }
    } else {
      return res.status(400).json({ success: false, error: `不支持的 Video FAL paramKind: ${reg.paramKind}` });
    }

    const falUrl = `${baseUrl}/fal/${endpoint}`;
    console.log('[video/fal/submit]', effectiveApiModel, '→', falUrl, '| payload keys:', Object.keys(payload), '| refs:', trimmedRefs.length);

    const resp = await fetch(falUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (!resp.ok) {
      return res.status(resp.status).json({
        success: false,
        error: data?.error || data?.detail || data?.message || `FAL HTTP ${resp.status}: ${text.slice(0, 300)}`,
      });
    }
    if (Array.isArray(data)) {
      return res.status(400).json({ success: false, error: `FAL 参数校验错误: ${JSON.stringify(data).slice(0, 300)}` });
    }
    if (data?.detail && !data?.video && !data?.request_id) {
      return res.status(400).json({ success: false, error: `FAL 错误: ${JSON.stringify(data.detail).slice(0, 300)}` });
    }

    // 同步返回: result.video.url 或同类 video_url/url 字段
    const syncVideoUrl = getFalVideoUrl(data);
    if (syncVideoUrl) {
      const local = await saveRemoteVideo(syncVideoUrl);
      return res.json({ success: true, data: { sync: true, videoUrl: local, endpoint, raw: data } });
    }

    // 异步: request_id + response_url
    const requestId = data?.request_id;
    let responseUrl = data?.response_url || '';
    if (!requestId) {
      return res.status(500).json({ success: false, error: '未获取到 request_id: ' + JSON.stringify(data).slice(0, 300) });
    }
    responseUrl = fixFalResponseUrl(responseUrl, baseUrl, endpoint, requestId);
    rememberTaskKey(requestId, apiKey, { model: effectiveApiModel, endpoint });
    return res.json({
      success: true,
      data: { sync: false, requestId, responseUrl, endpoint, raw: data },
    });
  } catch (e) {
    console.error('proxy/video/fal/submit 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// POST /api/proxy/video/fal/query
//   body: { responseUrl, endpoint, requestId }
//   完成标志: data.video.url (区别于图像的 data.images[])
router.post('/video/fal/query', async (req, res) => {
  const settings = loadRawSettings();
  const { responseUrl: rawUrl, endpoint, requestId } = req.body || {};
  const rememberedMeta = recallTaskMeta(requestId);
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // FAL 查询和提交保持同一策略：只用通用贞贞 API Key。
    if (!ensureDefaultZhenzhenKey(settings, res, '视频 FAL')) return;
  }
  const apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const responseUrl = fixFalResponseUrl(rawUrl, baseUrl, endpoint, requestId);
  if (!responseUrl) return res.status(400).json({ success: false, error: 'responseUrl 或 (endpoint+requestId) 必填' });

  try {
    const pr = await fetch(responseUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await pr.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    // HTTP 非200: 主项目规范 - body 中 status=IN_QUEUE/IN_PROGRESS 视为继续等待
    if (!pr.ok) {
      if (data && (data.status === 'IN_QUEUE' || data.status === 'IN_PROGRESS')) {
        return res.json({ success: true, data: { status: 'pending', raw: data } });
      }
      return res.status(pr.status).json({
        success: false,
        error: `FAL Poll HTTP ${pr.status}: ${text.slice(0, 300)}`,
        raw: data,
      });
    }
    if (!data) {
      return res.status(500).json({ success: false, error: 'FAL Poll 响应非 JSON: ' + text.slice(0, 200) });
    }
    // 完成: video.url 或同类 video_url/url 字段
    const finishedVideoUrl = getFalVideoUrl(data);
    if (finishedVideoUrl) {
      const local = await saveRemoteVideo(finishedVideoUrl);
      return res.json({ success: true, data: { status: 'completed', videoUrl: local, raw: data } });
    }
    const st = String(data.status || '').toUpperCase();
    if (st === 'FAILED' || st === 'CANCELLED') {
      return res.json({
        success: false,
        data: { status: 'failed', error: data.error || data.detail || `FAL ${st}` },
      });
    }
    // IN_QUEUE / IN_PROGRESS / 空 => pending
    return res.json({ success: true, data: { status: 'pending', falStatus: st || 'IN_QUEUE', raw: data } });
  } catch (e) {
    console.error('proxy/video/fal/query 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '查询失败' });
  }
});

// ========================================================================
// Fal 超市通用 FAL Queue 适配器
// 不替换现有 /image/fal/* 与 /video/fal/* 路由；这里只服务新的 Fal超市节点。
// ========================================================================

const FAL_TOOLBOX_PENDING = new Set(['IN_QUEUE', 'IN_PROGRESS', 'PENDING', 'RUNNING', 'QUEUED']);
const FAL_TOOLBOX_COMPLETED = new Set(['COMPLETED', 'COMPLETE', 'DONE', 'SUCCEEDED', 'SUCCESS']);
const FAL_TOOLBOX_FAILED = new Set(['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED']);

function isFalToolboxEndpoint(value) {
  const endpoint = String(value || '').trim();
  return !!endpoint && /^[a-z0-9._~:/-]+$/i.test(endpoint) && !endpoint.includes('..') && !/^https?:\/\//i.test(endpoint);
}

function falToolboxStatusValue(data) {
  if (!data || typeof data !== 'object') return '';
  const status = data.status ?? data.state ?? data.task_status ?? data.taskStatus;
  return String(status || '').trim().toUpperCase();
}

function falToolboxErrorMessage(data, fallback = 'FAL 任务失败') {
  if (!data) return fallback;
  if (typeof data === 'string') return data;
  const candidates = [
    data.failure_details,
    data.failure_reason,
    data.fail_reason,
    data.error,
    data.errors,
    data.detail,
    data.message,
    data.msg,
    data.data?.failure_details,
    data.data?.error,
    data.data?.detail,
    data.data?.message,
  ];
  for (const candidate of candidates) {
    if (candidate == null || candidate === '' || (Array.isArray(candidate) && !candidate.length)) continue;
    const msg = stringifyUpstreamErrorValue(candidate);
    if (msg) return msg;
  }
  try {
    return JSON.stringify(data).slice(0, 800);
  } catch {
    return fallback;
  }
}

function fixFalToolboxUrl(url, baseUrl, endpoint, requestId) {
  let value = String(url || '').trim();
  if (value.includes('queue.fal.run')) value = value.replace('https://queue.fal.run', `${baseUrl}/fal`);
  if (value.includes('fal.run')) value = value.replace('https://fal.run', `${baseUrl}/fal`);
  if (!value && endpoint && requestId) value = `${baseUrl}/fal/${endpoint}/requests/${requestId}`;
  return value;
}

function getByPath(data, pathText) {
  if (!data || !pathText) return undefined;
  const parts = String(pathText).split('.').filter(Boolean);
  let cur = data;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function collectFalToolboxUrls(value, out = []) {
  const pushUrl = (url) => {
    const text = String(url || '').trim();
    if (text && !out.includes(text)) out.push(text);
  };
  if (value == null) return out;
  if (typeof value === 'string') {
    if (/^(https?:\/\/|\/files\/|\/output\/|\/input\/)/i.test(value) || /^data:/i.test(value)) pushUrl(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFalToolboxUrls(item, out);
    return out;
  }
  if (typeof value === 'object') {
    if (typeof value.url === 'string') pushUrl(value.url);
    if (typeof value.file_url === 'string') pushUrl(value.file_url);
    if (typeof value.fileUrl === 'string') pushUrl(value.fileUrl);
    for (const child of Object.values(value)) collectFalToolboxUrls(child, out);
  }
  return out;
}

function collectFalToolboxText(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    if (!/^(https?:\/\/|\/files\/|data:)/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFalToolboxText(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'caption', 'prompt']) {
      if (typeof value[key] === 'string') out.push(value[key]);
    }
  }
  return out;
}

async function saveRemoteFalToolboxFile(url, kind) {
  if (/^\/(files|output|input)\//i.test(String(url || ''))) return url;
  if (kind === 'image') return saveRemoteImage(url);
  if (kind === 'video') return saveRemoteVideo(url);
  if (kind === 'audio') return saveRemoteAudio(url);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const cleanUrl = String(url || '').split(/[?#]/)[0];
    const match = cleanUrl.match(/\.([a-z0-9]{2,8})$/i);
    const ext = safeOutputExt(match?.[1], kind === 'model3d' ? 'glb' : 'bin');
    const prefix = kind === 'model3d' ? 'model3d' : 'fal';
    const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    fs.writeFileSync(path.join(config.OUTPUT_DIR, filename), buf);
    return `/files/output/${filename}`;
  } catch (e) {
    console.error('⚠ 转存 FAL 文件失败:', e.message);
    return url;
  }
}

async function extractFalToolboxOutputs(data, outputSchema) {
  const outputs = Array.isArray(outputSchema) ? outputSchema : [];
  const urls = [];
  const imageUrls = [];
  const videoUrls = [];
  const audioUrls = [];
  const modelUrls = [];
  const textOutputs = [];
  const jsonOutputs = [];

  const normalizedOutputs = outputs.length ? outputs : [
    { key: 'images', kind: 'image', pathCandidates: ['images', 'data.images'] },
    { key: 'video', kind: 'video', pathCandidates: ['video', 'data.video', 'video_url', 'url'] },
    { key: 'audio', kind: 'audio', pathCandidates: ['audio', 'data.audio', 'audio_url'] },
    { key: 'model', kind: 'model3d', pathCandidates: ['model', 'mesh', 'file', 'files'] },
  ];

  for (const output of normalizedOutputs) {
    const kind = String(output?.kind || 'json');
    const candidates = Array.isArray(output?.pathCandidates) && output.pathCandidates.length
      ? output.pathCandidates
      : [output?.key].filter(Boolean);
    for (const candidate of candidates) {
      const value = getByPath(data, candidate);
      if (value == null) continue;
      if (kind === 'text') {
        textOutputs.push(...collectFalToolboxText(value));
        continue;
      }
      if (kind === 'json') {
        jsonOutputs.push(value);
        continue;
      }
      const found = collectFalToolboxUrls(value, []);
      for (const remote of found) {
        const local = await saveRemoteFalToolboxFile(remote, kind);
        urls.push(local);
        if (kind === 'image') imageUrls.push(local);
        else if (kind === 'video') videoUrls.push(local);
        else if (kind === 'audio') audioUrls.push(local);
        else if (kind === 'model3d') modelUrls.push(local);
      }
    }
  }

  return {
    urls: Array.from(new Set(urls)),
    imageUrls: Array.from(new Set(imageUrls)),
    videoUrls: Array.from(new Set(videoUrls)),
    audioUrls: Array.from(new Set(audioUrls)),
    modelUrls: Array.from(new Set(modelUrls)),
    textOutputs: Array.from(new Set(textOutputs.filter(Boolean))),
    jsonOutputs,
  };
}

function falToolboxHasOutput(result) {
  return Boolean(result.urls.length || result.textOutputs.length || result.jsonOutputs.length);
}

async function resolveFalToolboxMediaPayload(payload, mediaFields, apiKey) {
  const next = { ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}) };
  const fields = Array.isArray(mediaFields) ? mediaFields : [];
  for (const field of fields) {
    const key = String(field?.key || '').trim();
    if (!key || !(key in next)) continue;
    const rawValues = Array.isArray(next[key]) ? next[key] : [next[key]];
    const resolved = [];
    for (const raw of rawValues) {
      const value = String(raw || '').trim();
      if (!value) continue;
      if (field?.upload === false) {
        resolved.push(value);
      } else if (field?.kind === 'image' && field?.mediaMode === 'base64') {
        const dataUrl = await refToBananaImage(value);
        if (!dataUrl) throw new Error(`FAL 图片读取失败: ${value.slice(0, 80)}`);
        resolved.push(dataUrl);
      } else {
        const url = await uploadRefToZhenzhen(value, apiKey);
        if (!url) throw new Error(`FAL 素材上传失败: ${value.slice(0, 80)}`);
        resolved.push(url);
      }
    }
    if (field?.multiple === false || !Array.isArray(next[key])) next[key] = resolved[0] || '';
    else next[key] = resolved;
  }
  return next;
}

router.post('/fal-toolbox/submit', async (req, res) => {
  const settings = loadRawSettings();
  if (!ensureDefaultZhenzhenKey(settings, res, 'Fal超市')) return;
  const apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const {
    toolId,
    title,
    endpoint,
    payload,
    mediaFields,
    outputSchema,
    statusPath,
  } = req.body || {};
  if (!isFalToolboxEndpoint(endpoint)) {
    return res.status(400).json({ success: false, error: `非法 FAL endpoint: ${endpoint || ''}` });
  }
  try {
    const finalPayload = await resolveFalToolboxMediaPayload(payload, mediaFields, apiKey);
    const falUrl = `${baseUrl}/fal/${endpoint}`;
    console.log('[fal-toolbox/submit]', toolId || title || endpoint, '→', falUrl, '| payload keys:', Object.keys(finalPayload));
    const upstream = await fetch(falUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(finalPayload),
    });
    const text = await upstream.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        success: false,
        error: falToolboxErrorMessage(data, `FAL HTTP ${upstream.status}: ${text.slice(0, 300)}`),
        raw: data,
      });
    }
    if (Array.isArray(data)) {
      return res.status(400).json({ success: false, error: `FAL 参数校验错误: ${JSON.stringify(data).slice(0, 500)}` });
    }
    const st = falToolboxStatusValue(data);
    if (FAL_TOOLBOX_FAILED.has(st)) {
      return res.json({ success: false, data: { status: 'failed', error: falToolboxErrorMessage(data, `FAL ${st}`), raw: data } });
    }

    const output = await extractFalToolboxOutputs(data, outputSchema);
    if (falToolboxHasOutput(output)) {
      return res.json({ success: true, data: { sync: true, endpoint, ...output, raw: data } });
    }

    const requestId = data?.request_id || data?.requestId;
    if (!requestId) {
      return res.status(500).json({ success: false, error: 'FAL 未返回 request_id: ' + JSON.stringify(data).slice(0, 400), raw: data });
    }
    const responseUrl = fixFalToolboxUrl(data?.response_url || data?.responseUrl, baseUrl, endpoint, requestId);
    const rawStatusUrl = data?.status_url || data?.statusUrl || (statusPath === 'result-only' ? '' : `${responseUrl}/status`);
    const statusUrl = rawStatusUrl ? fixFalToolboxUrl(rawStatusUrl, baseUrl, endpoint, requestId) : '';
    rememberTaskKey(requestId, apiKey, {
      route: 'fal-toolbox',
      toolId,
      title,
      endpoint,
      outputSchema,
      responseUrl,
      statusUrl,
      statusPath,
    });
    return res.json({
      success: true,
      data: { sync: false, requestId, responseUrl, statusUrl, endpoint, raw: data },
    });
  } catch (e) {
    console.error('proxy/fal-toolbox/submit 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

router.post('/fal-toolbox/query', async (req, res) => {
  const settings = loadRawSettings();
  const { responseUrl: rawResponseUrl, statusUrl: rawStatusUrl, endpoint: rawEndpoint, requestId, outputSchema: bodyOutputSchema, statusPath: rawStatusPath } = req.body || {};
  const rememberedMeta = recallTaskMeta(requestId);
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    if (!ensureDefaultZhenzhenKey(settings, res, 'Fal超市')) return;
  }
  const apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const endpoint = rememberedMeta?.endpoint || rawEndpoint;
  const outputSchema = rememberedMeta?.outputSchema || bodyOutputSchema;
  const statusPath = rememberedMeta?.statusPath || rawStatusPath;
  const responseUrl = fixFalToolboxUrl(rawResponseUrl || rememberedMeta?.responseUrl, baseUrl, endpoint, requestId);
  const rawEffectiveStatusUrl = rawStatusUrl || rememberedMeta?.statusUrl || (statusPath === 'result-only' ? '' : (responseUrl ? `${responseUrl}/status` : ''));
  const statusUrl = rawEffectiveStatusUrl ? fixFalToolboxUrl(rawEffectiveStatusUrl, baseUrl, endpoint, requestId) : '';
  if (!responseUrl && !statusUrl) return res.status(400).json({ success: false, error: 'responseUrl/statusUrl 或 requestId 必填' });

  const fetchJson = async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return { r, text, data };
  };

  try {
    let statusData = null;
    if (statusUrl) {
      const statusResp = await fetchJson(statusUrl);
      statusData = statusResp.data;
      if (!statusResp.r.ok) {
        const st = falToolboxStatusValue(statusData);
        if (FAL_TOOLBOX_PENDING.has(st)) {
          return res.json({ success: true, data: { status: 'pending', falStatus: st, requestId, responseUrl, statusUrl, raw: statusData } });
        }
        return res.status(statusResp.r.status).json({
          success: false,
          data: { status: 'failed', error: falToolboxErrorMessage(statusData, `FAL Poll HTTP ${statusResp.r.status}: ${statusResp.text.slice(0, 300)}`), raw: statusData },
        });
      }
      const st = falToolboxStatusValue(statusData);
      if (FAL_TOOLBOX_FAILED.has(st)) {
        return res.json({ success: false, data: { status: 'failed', error: falToolboxErrorMessage(statusData, `FAL ${st}`), falStatus: st, requestId, responseUrl, statusUrl, raw: statusData } });
      }
      const statusOutput = await extractFalToolboxOutputs(statusData, outputSchema);
      if (falToolboxHasOutput(statusOutput)) {
        return res.json({ success: true, data: { status: 'completed', requestId, responseUrl, statusUrl, ...statusOutput, raw: statusData } });
      }
      if (st && !FAL_TOOLBOX_COMPLETED.has(st)) {
        return res.json({ success: true, data: { status: 'pending', falStatus: st, requestId, responseUrl, statusUrl, raw: statusData } });
      }
    }

    const resultResp = await fetchJson(responseUrl || statusUrl);
    if (!resultResp.r.ok) {
      const st = falToolboxStatusValue(resultResp.data);
      if (FAL_TOOLBOX_PENDING.has(st)) {
        return res.json({ success: true, data: { status: 'pending', falStatus: st, requestId, responseUrl, statusUrl, raw: resultResp.data } });
      }
      return res.status(resultResp.r.status).json({
        success: false,
        data: { status: 'failed', error: falToolboxErrorMessage(resultResp.data, `FAL Result HTTP ${resultResp.r.status}: ${resultResp.text.slice(0, 300)}`), raw: resultResp.data },
      });
    }
    if (!resultResp.data) {
      return res.status(500).json({ success: false, data: { status: 'failed', error: 'FAL 响应非 JSON: ' + resultResp.text.slice(0, 200) } });
    }
    const resultStatus = falToolboxStatusValue(resultResp.data);
    if (FAL_TOOLBOX_FAILED.has(resultStatus)) {
      return res.json({ success: false, data: { status: 'failed', error: falToolboxErrorMessage(resultResp.data, `FAL ${resultStatus}`), falStatus: resultStatus, requestId, responseUrl, statusUrl, raw: resultResp.data } });
    }
    const output = await extractFalToolboxOutputs(resultResp.data, outputSchema);
    if (falToolboxHasOutput(output)) {
      return res.json({ success: true, data: { status: 'completed', requestId, responseUrl, statusUrl, ...output, raw: resultResp.data } });
    }
    return res.json({ success: true, data: { status: 'pending', falStatus: resultStatus || falToolboxStatusValue(statusData) || 'IN_PROGRESS', requestId, responseUrl, statusUrl, raw: resultResp.data || statusData } });
  } catch (e) {
    console.error('proxy/fal-toolbox/query 错误:', e);
    return res.status(500).json({ success: false, data: { status: 'failed', error: e.message || '查询失败' } });
  }
});

router.post('/video/submit', async (req, res) => {
  const settings = loadRawSettings();
  const {
    model, prompt,
    // Veo 参数
    aspect_ratio, enhance_prompt, enable_upsample,
    // Grok 参数
    ratio, duration, resolution,
    // 通用
    seed, private: privateVideo, is_private, watermark, images, providerParams,
  } = req.body || {};
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  if (!ensureKeyOrSelectedGroup(settings, res, model || '', '视频', providerParams)) return;
  if (!model || !prompt) {
    return res.status(400).json({ success: false, error: 'model 和 prompt 必填' });
  }
  const lowerModel = String(model).toLowerCase();
  const isVeoOmni = isVeoOmniModel(lowerModel);
  const isGrok = lowerModel.includes('grok');
  const isSoraZhenzhen = lowerModel === 'sora-2-zhenzhen';
  const isVeo = lowerModel.includes('veo');
  let body;

  try {
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'video/submit',
      kind: 'video',
      model,
      hint: model || '',
      providerParams,
    });
    const apiKey = settings.zhenzhenApiKey;
    if (isVeoOmni) {
      // ===== Veo Omni 协议(参考 Comfly_veo_omini): POST /v1/videos multipart =====
      const refs = Array.isArray(images) ? images.slice(0, 1) : [];
      if (!refs.length) {
        return res.status(400).json({ success: false, error: 'veo-omni-10s 需要 1 张参考图' });
      }
      const conv = await refToBuffer(refs[0]);
      if (!conv) {
        return res.status(400).json({ success: false, error: 'veo-omni-10s 参考图读取失败' });
      }
      const form = new FormData();
      const seconds = ['4', '5', '6', '8', '10'].includes(String(duration)) ? String(duration) : '10';
      const size = veoOmniSizeFromAspect(aspect_ratio || ratio || '16:9');
      form.append('model', VEO_OMNI_UPSTREAM_MODEL);
      form.append('prompt', prompt);
      form.append('size', size);
      form.append('seconds', seconds);
      form.append('watermark', String(Boolean(watermark)).toLowerCase());
      form.append('input_reference', new Blob([conv.buf], { type: conv.mime }), `input_reference.${conv.ext || 'png'}`);

      const upstream = `${config.ZHENZHEN_BASE_URL}/v1/videos`;
      console.log('[upstream] Veo Omni → /v1/videos model:', VEO_OMNI_UPSTREAM_MODEL, 'size:', size, 'seconds:', seconds, 'refs:', refs.length);
      const r = await fetch(upstream, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch {
        return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
      }
      if (!r.ok) {
        const errorText = getUpstreamErrorMessage(data, text, r.status);
        await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
        return res.status(r.status).json({ success: false, error: errorText, raw: data });
      }
      const taskId = data?.task_id || data?.id;
      if (!taskId) return res.status(500).json({ success: false, error: '未获取到 task_id: ' + text.slice(0, 200) });
      rememberTaskKey(taskId, apiKey, { model: VEO_OMNI_PUBLIC_MODEL, ...providerContext.taskMeta });
      return res.json({ success: true, data: { taskId, raw: data } });
    } else if (isSoraZhenzhen) {
      // ===== Sora2 Zhenzhen API 协议(参考 gpt-image-2-web runSora2) =====
      body = {
        prompt,
        model: 'sora-2',
        aspect_ratio: aspect_ratio || ratio || '16:9',
        duration: String(duration ?? 15),
        private: privateVideo !== false && is_private !== false,
      };
      if (seed && seed > 0) body.seed = seed;
      if (Array.isArray(images) && images.length) {
        const refs = images.slice(0, 1).map(stripDataUrlPrefix).filter(Boolean);
        if (refs.length) body.images = refs;
      }
      console.log('[upstream] Sora2 Zhenzhen → /v2/videos/generations model:', body.model, 'aspect_ratio:', body.aspect_ratio, 'duration:', body.duration, 'private:', body.private, 'refs:', body.images?.length || 0);
    } else if (isGrok) {
      // ===== Grok Video 协议(主项目 runGrok3 line 3863) =====
      body = {
        prompt,
        model,
        ratio: ratio || '16:9',
        duration: parseInt(duration ?? 15, 10),
        resolution: resolution || '720P',
      };
      if (seed && seed > 0) body.seed = seed;
      if (Array.isArray(images) && images.length) {
        const refs = images.slice(0, 7); // Grok 最多 7 张
        const urls = [];
        for (let i = 0; i < refs.length; i++) {
          const u = await uploadRefToZhenzhen(refs[i], apiKey);
          if (u) urls.push(u);
          else throw new Error(`参考图 #${i + 1} 上传失败`);
        }
        if (urls.length) body.images = urls;
      }
      console.log('[upstream] Grok Video → /v2/videos/generations model:', model, 'ratio:', body.ratio, 'duration:', body.duration, 'resolution:', body.resolution, 'refs:', body.images?.length || 0);
    } else {
      // ===== Veo3.1 协议(主项目 runVeo3 line 3372)=====
      // 旧 seedance / 默认行为也走这里(零破坏)
      body = { prompt, model, enhance_prompt: enhance_prompt !== false };
      if (aspect_ratio) body.aspect_ratio = aspect_ratio;
      if (seed && seed > 0) body.seed = seed;
      if (enable_upsample) body.enable_upsample = true;
      if (Array.isArray(images) && images.length) body.images = images.slice(0, 3); // base64 dataURL
      console.log('[upstream] Veo/Default → /v2/videos/generations model:', model, 'aspect_ratio:', body.aspect_ratio, 'refs:', body.images?.length || 0, isVeo ? '(veo)' : '(legacy)');
    }

    const upstream = `${config.ZHENZHEN_BASE_URL}/v2/videos/generations`;
    const r = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
    }
    if (!r.ok) {
      const errorText = getUpstreamErrorMessage(data, text, r.status);
      await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText, raw: data });
    }
    const taskId = data?.task_id || data?.id;
    if (!taskId) return res.status(500).json({ success: false, error: '未获取到 task_id: ' + text.slice(0, 200) });
    rememberTaskKey(taskId, apiKey, { model, ...providerContext.taskMeta });
    res.json({ success: true, data: { taskId, raw: data } });
  } catch (e) {
    console.error('proxy/video/submit 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

router.get('/video/query', async (req, res) => {
  const settings = loadRawSettings();
  const taskId = String(req.query.taskId || '').trim();
  const rememberedMeta = recallTaskMeta(taskId);
  const queryModel = String(req.query.model || rememberedMeta?.model || '').trim();
  // 优先从 submit 阶段记录的 (taskId → key) 映射恢复，防止前端未传 model 导致 fallback 错 key。
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
    if (!ensureKey(settings, res, queryModel, '视频')) return;
  }
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId 必填' });
  const isVeoOmni = isVeoOmniModel(queryModel);
  const upstream = isVeoOmni
    ? `${config.ZHENZHEN_BASE_URL}/v1/videos/${encodeURIComponent(taskId)}`
    : `${config.ZHENZHEN_BASE_URL}/v2/videos/generations/${encodeURIComponent(taskId)}`;
  try {
    const r = await fetch(upstream, {
      headers: { Authorization: `Bearer ${settings.zhenzhenApiKey}` },
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
    }
    if (!r.ok) {
      const errorText = getUpstreamErrorMessage(data, text, r.status);
      await invalidateZhenzhenProviderKey({ taskMeta: rememberedMeta || {} }, settings.zhenzhenApiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText, raw: data });
    }
    const st = normalizeVideoTaskStatus(data?.status);
    let videoUrl = null;
    if (st === 'SUCCESS') {
      const remote = getFalVideoUrl(data);
      if (remote) {
        videoUrl = await saveRemoteVideo(remote);
      }
    }
    res.json({
      success: true,
      data: {
        status: st || 'PENDING',
        progress: data?.progress == null ? '' : String(data.progress),
        videoUrl,
        failReason: data?.fail_reason || data?.failure_details || data?.error || data?.message || null,
        raw: data,
      },
    });
  } catch (e) {
    console.error('proxy/video/query 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// ========================================================================
// Seedance 2.0(异步)— 完全对齐 gpt-image-2-web runSeedance / pollSeedance
//   submit: POST ${ZHENZHEN_BASE_URL}/seedance/v3/contents/generations/tasks
//   query : GET  ${ZHENZHEN_BASE_URL}/seedance/v3/contents/generations/tasks/{tid}
// payload: { model, content[], duration, ratio, resolution, generate_audio,
//            return_last_frame, watermark, tools?[web_search], seed? }
// content 数组成员:
//   { type:'text', text }
//   { type:'image_url', image_url:{url}, role:'first_frame'|'last_frame'|'reference_image' }
//   { type:'video_url', video_url:{url}, role:'reference_video' }   // 需先 /v1/files 上传换 URL
//   { type:'audio_url', audio_url:{url}, role:'reference_audio' }   // 需先 /v1/files 上传换 URL
// ========================================================================
router.post('/seedance/submit', async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  let apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const {
    model, prompt,
    duration, ratio, resolution,
    generate_audio, return_last_frame, watermark, web_search,
    seed,
    firstFrame, lastFrame,
    refImages,
    videos, audios,
    providerParams,
  } = req.body || {};
  if (!ensureKeyOrSelectedGroup(settings, res, 'seedance', 'Seedance', providerParams)) return;

  if (!model) return res.status(400).json({ success: false, error: 'model 必填' });
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt 不得为空' });

  try {
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'seedance/submit',
      kind: 'seedance',
      model,
      hint: model || 'seedance',
      providerParams,
    });
    apiKey = settings.zhenzhenApiKey;
    const content = [{ type: 'text', text: String(prompt) }];

    const hasF = !!firstFrame;
    const hasL = !!lastFrame;

    // first_frame:
    //   - 单独 first_frame(无 last_frame): 不带 role
    //   - 与 last_frame 同时存在: role='first_frame'
    if (hasF) {
      const u = await uploadRefToZhenzhen(firstFrame, apiKey);
      if (!u) throw new Error('first_frame 上传失败');
      const e = { type: 'image_url', image_url: { url: u } };
      if (hasL) e.role = 'first_frame';
      content.push(e);
    }

    // last_frame: 必须与 first_frame 同时
    if (hasL && hasF) {
      const u = await uploadRefToZhenzhen(lastFrame, apiKey);
      if (!u) throw new Error('last_frame 上传失败');
      content.push({ type: 'image_url', image_url: { url: u }, role: 'last_frame' });
    }

    // reference_image
    if (Array.isArray(refImages)) {
      for (let i = 0; i < refImages.length; i++) {
        const u = await uploadRefToZhenzhen(refImages[i], apiKey);
        if (u) content.push({ type: 'image_url', image_url: { url: u }, role: 'reference_image' });
      }
    }

    // reference_video / reference_audio:
    // gpt-image-2-web 的 runSeedance 会把本地视频/音频先上传到 /v1/files，再把返回 URL 放入 content。
    // T8 画布上游素材通常是 /files/input 或 /files/output，本地地址不能直接提交给 Seedance。
    if (Array.isArray(videos)) {
      for (let i = 0; i < videos.length; i++) {
        const v = videos[i];
        if (typeof v === 'string' && v) {
          const u = await uploadRefToZhenzhen(v, apiKey);
          if (!u) throw new Error(`reference_video ${i + 1} 上传失败`);
          content.push({ type: 'video_url', video_url: { url: u }, role: 'reference_video' });
        }
      }
    }
    if (Array.isArray(audios)) {
      for (let i = 0; i < audios.length; i++) {
        const a = audios[i];
        if (typeof a === 'string' && a) {
          const u = await uploadRefToZhenzhen(a, apiKey);
          if (!u) throw new Error(`reference_audio ${i + 1} 上传失败`);
          content.push({ type: 'audio_url', audio_url: { url: u }, role: 'reference_audio' });
        }
      }
    }

    const payload = {
      model,
      content,
      duration: parseInt(duration ?? 5, 10),
      ratio: ratio || '16:9',
      resolution: resolution || '720p',
      generate_audio: generate_audio !== false,
      return_last_frame: return_last_frame === true,
      watermark: watermark === true,
    };
    if (web_search === true) payload.tools = [{ type: 'web_search' }];
    if (typeof seed === 'number' && seed !== -1) payload.seed = seed;

    console.log('[upstream] Seedance2.0 → /seedance/v3/contents/generations/tasks model:', model,
      'duration:', payload.duration, 'ratio:', payload.ratio, 'resolution:', payload.resolution,
      'content_items:', content.length);

    const r = await fetch(`${baseUrl}/seedance/v3/contents/generations/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
    }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey(providerContext, apiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText });
    }
    const taskId = data?.id || data?.task_id;
    if (!taskId) return res.status(500).json({ success: false, error: '未获取到 task_id: ' + text.slice(0, 200) });
    rememberTaskKey(taskId, apiKey, { model, ...providerContext.taskMeta });
    res.json({ success: true, data: { taskId, raw: data } });
  } catch (e) {
    console.error('proxy/seedance/submit 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

router.get('/seedance/query', async (req, res) => {
  const settings = loadRawSettings();
  const taskId = String(req.query.taskId || '').trim();
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId 必填' });
  const rememberedMeta = recallTaskMeta(taskId);
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
    if (!ensureKey(settings, res, 'seedance', 'Seedance')) return;
  }

  const apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const upstream = `${baseUrl}/seedance/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`;

  try {
    const r = await fetch(upstream, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
    }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey({ taskMeta: rememberedMeta || {} }, apiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText });
    }
    // 状态归一(对齐主项目)
    let st = String(data?.status || '').toLowerCase();
    if (st === 'success') st = 'succeeded';
    if (st === 'fail' || st === 'failure') st = 'failed';

    let videoUrl = null;
    if (st === 'succeeded') {
      // 多重路径解析 video_url(对齐 pollSeedance line 3287-3296)
      let vUrl = null;
      const rc = data?.content;
      if (rc && typeof rc === 'object' && !Array.isArray(rc)) {
        vUrl = rc.video_url || rc.videoUrl;
      }
      if (!vUrl && data?.data && typeof data.data === 'object') {
        const dc = data.data.content;
        if (dc && typeof dc === 'object') vUrl = dc.video_url || dc.videoUrl;
        if (!vUrl) vUrl = data.data.video_url || data.data.videoUrl;
      }
      if (!vUrl && Array.isArray(data?.results)) {
        for (const it of data.results) {
          if (it && (it.outputType === 'mp4' || it.outputType === 'video' || (it.url && /\.mp4(\?|$)/i.test(it.url)))) {
            vUrl = it.url; break;
          }
          if (it && it.url && !vUrl) vUrl = it.url;
        }
      }
      if (!vUrl && Array.isArray(data?.content)) {
        for (const it of data.content) {
          if (it?.type === 'video_url') {
            const vu = it.video_url;
            vUrl = typeof vu === 'string' ? vu : (vu && vu.url);
            if (vUrl) break;
          }
        }
      }
      if (!vUrl) vUrl = data?.video_url || data?.videoUrl;

      if (vUrl) {
        // 转存到本地
        videoUrl = await saveRemoteVideo(vUrl);
      }
    }

    return res.json({
      success: true,
      data: {
        status: st || 'pending',
        progress: data?.progress || '',
        videoUrl,
        failReason: data?.fail_reason || data?.failReason || null,
        raw: data,
      },
    });
  } catch (e) {
    console.error('proxy/seedance/query 错误:', e);
    res.status(500).json({ success: false, error: e.message || '查询失败' });
  }
});

// ========================================================================
// 音频生成(Suno - 异步)
// 协议(贞贞工坊):POST /suno/generate + GET /suno/feed/:clipIds + POST /suno/submit/music
// 模式:generate / cover / extend
// 严格对齐主项目 gpt-image-2-web 的 SUNO_MV_MAP (7 个版本)
// ========================================================================
const SUNO_MV_MAP = {
  'v3.0': 'chirp-v3.0',
  'v3.5': 'chirp-v3.5',
  'v4': 'chirp-v4',
  'v4.5': 'chirp-auk',
  'v4.5+': 'chirp-bluejay',
  'v5': 'chirp-crow',
  'v5.5': 'chirp-fenix',
};

// 兼容带 'suno-' 前缀的旧调用方 (如 'suno-v5.5')
function resolveSunoMv(version) {
  const v = String(version || 'v5.5').replace(/^suno-/i, '');
  return SUNO_MV_MAP[v] || 'chirp-fenix';
}

module.exports = router;
