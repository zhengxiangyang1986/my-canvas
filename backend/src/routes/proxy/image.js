const express = require('express');
const router = express.Router();
const config = require('../../config');
const {
  loadRawSettings,
  normalizeImageApiModel,
  gptImage2ZhenzhenVariantSize,
  isBananaImageModel,
  ensureKey,
  ensureDefaultZhenzhenKey,
  rememberTaskKey,
  recallTaskMeta,
  ensureKeyOrSelectedGroup,
  applyZhenzhenProviderContext,
  invalidateZhenzhenProviderKey,
  saveRemoteImage,
  refToBananaImage,
  imageError,
  imageApiFailed,
  imageStatus,
  saveImageItemsFromResult,
  callImageUpstreamAsync,
  normalizeImageResponse
} = require('./_helpers');

router.post('/image', async (req, res) => {
  const settings = loadRawSettings();
  const {
    model, apiModel, paramKind: paramKindIn,
    prompt, n,
    aspect_ratio, image_size,
    images, image, size, quality, providerParams,
  } = req.body || {};
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  if (!ensureKeyOrSelectedGroup(settings, res, apiModel || model || '', '图像', providerParams)) return;
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt 必填' });
  const originalApiModel = String(apiModel || model || '');
  const gptImage2ForcedSize = gptImage2ZhenzhenVariantSize(originalApiModel);
  const finalApiModel = normalizeImageApiModel(originalApiModel);
  const ml = `${originalApiModel} ${finalApiModel}`.toLowerCase();
  const paramKind = paramKindIn || (ml.includes('grok') && ml.includes('image') ? 'grok-image' : (isBananaImageModel(ml) ? 'banana-ratio' : 'gpt-size'));
  if (!finalApiModel) return res.status(400).json({ success: false, error: 'model 必填' });
  const refs = Array.isArray(images) ? images.filter(Boolean) : [];
  if (typeof image === 'string' && image && !refs.includes(image)) refs.unshift(image);

  try {
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'image',
      kind: 'image',
      model: finalApiModel,
      hint: apiModel || model || '',
      providerParams,
    });
    const r = await callImageUpstreamAsync({
      apiKey: settings.zhenzhenApiKey, finalApiModel, paramKind,
      prompt, n, aspect_ratio, image_size: gptImage2ForcedSize || image_size, refs, size: gptImage2ForcedSize ? undefined : size, quality,
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 300) });
    }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey(providerContext, settings.zhenzhenApiKey, errorText);
      return res.status(r.status).json({
        success: false,
        error: errorText,
      });
    }
    const norm = await normalizeImageResponse(data);
    if (norm.kind === 'failed') {
      await invalidateZhenzhenProviderKey(providerContext, settings.zhenzhenApiKey, norm.error);
      return res.status(500).json({ success: false, error: norm.error || '上游图像任务失败', raw: data });
    }
    if (norm.kind === 'sync') {
      return res.json({ success: true, data: { urls: norm.urls, raw: data, model: finalApiModel, prompt } });
    }
    if (norm.kind === 'async') {
      // 同步接口需要同步返回结果 → 内部轮询
      const url = await pollImageTask(norm.taskId, settings.zhenzhenApiKey);
      if (!url) return res.status(500).json({ success: false, error: '异步任务轮询超时/失败', taskId: norm.taskId });
      return res.json({ success: true, data: { urls: [url], raw: data, taskId: norm.taskId, model: finalApiModel, prompt } });
    }
    return res.status(500).json({ success: false, error: '上游未返回图片也未返 task_id: ' + JSON.stringify(data).slice(0, 300) });
  } catch (e) {
    console.error('proxy/image 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// ========================================================================
// 图像异步任务接口(与主项目 gpt-image-2-web 一致)
// POST /api/proxy/image/submit -> { taskId }(同 submit 逻辑,但不同步轮询)
// GET  /api/proxy/image/status/:tid -> { status, progress, urls? }
// ========================================================================
router.post('/image/submit', async (req, res) => {
  const settings = loadRawSettings();
  try {
    const { model, apiModel, paramKind: paramKindIn, prompt, n,
            aspect_ratio, image_size, images, image, size, quality, providerParams } = req.body || {};
    // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
    if (!ensureKeyOrSelectedGroup(settings, res, apiModel || model || '', '图像', providerParams)) return;
    if (!prompt) return res.status(400).json({ success: false, error: 'prompt 不得为空' });
    const originalApiModel = String(apiModel || model || '');
    const gptImage2ForcedSize = gptImage2ZhenzhenVariantSize(originalApiModel);
    const finalApiModel = normalizeImageApiModel(originalApiModel);
    const ml = `${originalApiModel} ${finalApiModel}`.toLowerCase();
    const paramKind = paramKindIn || (ml.includes('grok') && ml.includes('image') ? 'grok-image' : (isBananaImageModel(ml) ? 'banana-ratio' : 'gpt-size'));
    if (!finalApiModel) return res.status(400).json({ success: false, error: 'model 必填' });
    const refs = Array.isArray(images) ? images.filter(Boolean) : [];
    if (typeof image === 'string' && image && !refs.includes(image)) refs.unshift(image);

    // 完全对齐主项目 gpt-image-2-web:走 ?async=true,GPT2 强制 multipart edits + 白图占位
    const providerContext = await applyZhenzhenProviderContext(settings, {
      route: 'image/submit',
      kind: 'image',
      model: finalApiModel,
      hint: apiModel || model || '',
      providerParams,
    });
    const r = await callImageUpstreamAsync({
      apiKey: settings.zhenzhenApiKey, finalApiModel, paramKind,
      prompt, n, aspect_ratio, image_size: gptImage2ForcedSize || image_size, refs, size: gptImage2ForcedSize ? undefined : size, quality,
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey(providerContext, settings.zhenzhenApiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText, raw: data });
    }

    const norm = await normalizeImageResponse(data);
    if (norm.kind === 'failed') {
      await invalidateZhenzhenProviderKey(providerContext, settings.zhenzhenApiKey, norm.error);
      return res.status(500).json({ success: false, error: norm.error || '上游图像任务失败', raw: data });
    }
    if (norm.kind === 'sync') {
      return res.json({ success: true, data: { sync: true, status: 'completed', progress: '100%', urls: norm.urls, raw: data } });
    }
    if (norm.kind === 'async') {
      rememberTaskKey(norm.taskId, settings.zhenzhenApiKey, { model: finalApiModel, ...providerContext.taskMeta });
      return res.json({ success: true, data: { sync: false, taskId: norm.taskId, status: 'pending', progress: '0%', raw: data } });
    }
    return res.status(500).json({ success: false, error: '未获取到 task_id 且无同步结果: ' + JSON.stringify(data).slice(0, 300) });
  } catch (e) {
    console.error('proxy/image/submit 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// 查询异步图像任务状态
router.get('/image/status/:tid', async (req, res) => {
  const settings = loadRawSettings();
  // 优先从 submit 阶段记录的 (taskId → key) 映射恢复，防止前端未传 model 导致 fallback 错 key。
  const rememberedMeta = recallTaskMeta(req.params.tid);
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // v1.2.9.15: 一体化「专属优先 fallback 通用」校验（查询阶段可选传 ?model=xxx）
    if (!ensureKey(settings, res, String(req.query.model || ''), '图像')) return;
  }
  const tid = req.params.tid;
  try {
    const url = `${config.ZHENZHEN_BASE_URL}/v1/images/tasks/${encodeURIComponent(tid)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${settings.zhenzhenApiKey}` } });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (!r.ok) {
      const errorText = data?.error?.message || data?.message || `上游 HTTP ${r.status}`;
      await invalidateZhenzhenProviderKey({ taskMeta: rememberedMeta || {} }, settings.zhenzhenApiKey, errorText);
      return res.status(r.status).json({ success: false, error: errorText, raw: data });
    }
    if (imageApiFailed(data)) {
      const errorText = imageError(data) || '任务失败';
      await invalidateZhenzhenProviderKey({ taskMeta: rememberedMeta || {} }, settings.zhenzhenApiKey, errorText);
      return res.json({ success: false, data: { status: 'failed', progress: '0%', error: errorText, raw: data } });
    }
    const statusRaw = imageStatus(data);
    const status = String(statusRaw || '').toLowerCase();
    const inner = data?.data && typeof data.data === 'object' ? data.data : {};
    const progress = inner.progress || data?.progress || '0%';
    const SUCCESS = ['success', 'completed', 'complete', 'done', 'finished'];
    const FAILURE = ['failure', 'failed', 'error', 'cancelled', 'canceled'];
    const urls = await saveImageItemsFromResult(data);
    if (SUCCESS.includes(status) || urls.length) {
      return res.json({ success: true, data: { status: 'completed', progress: '100%', urls, raw: data } });
    }
    if (FAILURE.includes(status)) {
      return res.json({ success: false, data: { status: 'failed', progress, error: imageError(data) || inner.fail_reason || '任务失败', raw: data } });
    }
    res.json({ success: true, data: { status: status || 'pending', progress, raw: data } });
  } catch (e) {
    console.error('proxy/image/status 错误:', e);
    res.status(500).json({ success: false, error: e.message || '查询失败' });
  }
});

// ========== 图像异步任务轮询(同步代理内部使用,路径对齐主项目 /v1/images/tasks/) ==========
// 轮询上限:1800 × 2s = 3600s = 60 分钟,与前端 ImageNode 标准路径保持一致,
// 避免 GPT2 复杂 prompt / 多参考图任务被 120s 提前中断。
async function pollImageTask(taskId, apiKey, maxRetries = 1800, interval = 2000) {
  const url = `${config.ZHENZHEN_BASE_URL}/v1/images/tasks/${encodeURIComponent(taskId)}`;
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { continue; }
      if (!r.ok) continue;
      const st = String(imageStatus(data) || '').toLowerCase();
      const urls = await saveImageItemsFromResult(data);
      if (['success', 'completed', 'complete', 'done', 'finished'].includes(st) || urls.length) {
        return urls[0] || null;
      }
      if (['failure', 'failed', 'error', 'cancelled', 'canceled'].includes(st) || imageApiFailed(data)) {
        console.error('[poll] 任务失败:', imageError(data) || st);
        return null;
      }
    } catch (e) {
      console.warn('[poll] 轮询异常:', e.message);
    }
  }
  return null;
}

// ========================================================================
// FAL 渠道 —— 完全对齐 gpt-image-2-web SKILL.md §FAL模型渠道接入规范
// 不破坏原有 /image · /image/submit · /image/status/:tid 三个路由。
//
// 核心路由:
//   POST /api/proxy/image/fal/submit   -> { sync, urls?, requestId?, responseUrl?, endpoint? }
//   POST /api/proxy/image/fal/query    -> { status, images?, error? }   body: { responseUrl, endpoint, requestId }
//
// 主项目上游协议(index.html line 2890 runGPTFal / line 3587 runNanoFal):
//   URL: ${baseUrl}/fal/${endpoint}
//   Auth: Bearer ${apiKey}
//   GPT FAL  endpoint: 'openai/gpt-image-2' 或 'openai/gpt-image-2/edit'
//   NBPro FAL endpoint: 'fal-ai/nano-banana-pro/edit'
//   参考图上传: POST ${baseUrl}/v1/files  (复用现有 uploadRefToZhenzhen)
//   response_url 域名修复: queue.fal.run → ${baseUrl}/fal
//   轮询 HTTP 非200时 body 中 status=IN_QUEUE/IN_PROGRESS 仍视为进行中
// ========================================================================

const FAL_REGISTRY = {
  'gpt-image-2-fal': {
    endpoint: 'openai/gpt-image-2',
    editEndpoint: 'openai/gpt-image-2/edit',
    paramKind: 'gpt-fal',
    maxRefs: 5,
  },
  'nano-banana-pro-fal': {
    endpoint: 'fal-ai/nano-banana-pro/edit',
    editEndpoint: 'fal-ai/nano-banana-pro/edit',
    paramKind: 'nbpro-fal',
    maxRefs: 8,
  },
  // 主项目 runGeminiFal (line 3491) 与 runNanoFal 共用同一 fal-ai/nano-banana-pro/edit 端点 + 同 paramKind。
  // 只是 UI 控件 id 前缀不同 (g2f_* vs nf_*)。后端零增量分支，复用 nbpro-fal payload 组装。
  'nano-banana-2-fal': {
    endpoint: 'fal-ai/nano-banana-pro/edit',
    editEndpoint: 'fal-ai/nano-banana-pro/edit',
    paramKind: 'nbpro-fal',
    maxRefs: 8,
  },
};

// 按 16 倍数对齐(主项目 line 2904)
function snap16(v, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(256, Math.min(3840, Math.round(n / 16) * 16));
}

// 修复 response_url 域名(主项目 line 2954)
function fixFalResponseUrl(responseUrl, baseUrl, endpoint, requestId) {
  let url = String(responseUrl || '');
  if (url.includes('queue.fal.run')) {
    url = url.replace('https://queue.fal.run', `${baseUrl}/fal`);
  }
  if (!url) {
    const requestEndpoint = String(endpoint || '').startsWith('fal-ai/sora-2/')
      ? 'fal-ai/sora-2'
      : endpoint;
    url = `${baseUrl}/fal/${requestEndpoint}/requests/${requestId}`;
  }
  return url;
}

// POST /api/proxy/image/fal/submit
//   body 公用: { apiModel, prompt, images?, n?, format?, sync?, ... }
//   gpt-fal 专属: { mode?: 'edit'|'gen', size?: '1024x1024'|'square'|...|'custom', customW?, customH?, quality?: low|medium|high|auto }
//   nbpro-fal 专属: { aspect_ratio, resolution, safety_tolerance, seed?, system_prompt?, enable_web_search?, image_mode?: 'image_url'|'base64' }
router.post('/image/fal/submit', async (req, res) => {
  const settings = loadRawSettings();
  const {
    apiModel, prompt, images, n, format, sync,
    // gpt-fal
    mode, size, customW, customH, quality,
    // nbpro-fal
    aspect_ratio, resolution, safety_tolerance, seed,
    system_prompt, enable_web_search, image_mode,
  } = req.body || {};
  // FAL 全部固定使用通用贞贞 API Key，不参与 New API 分组令牌。
  if (!ensureDefaultZhenzhenKey(settings, res, '图像 FAL')) return;
  let apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;

  if (!apiModel) return res.status(400).json({ success: false, error: 'apiModel 必填' });
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt 不得为空' });

  const reg = FAL_REGISTRY[apiModel];
  if (!reg) return res.status(400).json({ success: false, error: `未知的 FAL 模型: ${apiModel}` });

  const refs = Array.isArray(images) ? images.filter(Boolean) : [];
  const trimmedRefs = refs.slice(0, reg.maxRefs);
  const numImages = Math.max(1, Math.min(4, parseInt(n ?? 1, 10) || 1));
  const outputFormat = String(format || 'png').toLowerCase();

  // ========== 根据 paramKind 组装 payload ==========
  let payload;
  let endpoint;
  try {
    if (reg.paramKind === 'gpt-fal') {
      // 选 endpoint: edit 或 gen
      const useEdit = (mode === 'edit') || (mode !== 'gen' && trimmedRefs.length > 0);
      endpoint = useEdit ? (reg.editEndpoint || reg.endpoint) : reg.endpoint;
      // image_size
      let imageSize;
      const sz = String(size || 'auto');
      if (sz === 'custom') {
        imageSize = { width: snap16(customW, 1280), height: snap16(customH, 1280) };
      } else if (sz && sz !== 'auto') {
        imageSize = sz; // 预设字串 square_hd / portrait_16_9 等,或像素串
      }
      payload = {
        prompt,
        quality: String(quality || 'medium'),
        num_images: numImages,
        output_format: outputFormat,
      };
      if (imageSize) payload.image_size = imageSize;
      // image_urls 仅在 edit 下添加
      if (useEdit && trimmedRefs.length) {
        const urls = [];
        for (let i = 0; i < trimmedRefs.length; i++) {
          const u = await uploadRefToZhenzhen(trimmedRefs[i], apiKey);
          if (u) urls.push(u);
          else throw new Error(`FAL 参考图 #${i + 1} 上传失败`);
        }
        if (urls.length) payload.image_urls = urls;
      }
      if (sync === true || sync === 'true') payload.sync_mode = true;
    } else if (reg.paramKind === 'nbpro-fal') {
      // nano-banana-pro 只有 edit 端点
      endpoint = reg.endpoint;
      payload = {
        prompt,
        num_images: numImages,
        aspect_ratio: String(aspect_ratio || 'auto'),
        resolution: String(resolution || '2K'),
        output_format: outputFormat,
        safety_tolerance: String(safety_tolerance || '4'),
      };
      if (seed && Number(seed) > 0) payload.seed = Number(seed);
      if (system_prompt) payload.system_prompt = String(system_prompt);
      if (enable_web_search === true || enable_web_search === 'true') payload.enable_web_search = true;
      // 参考图(最多 8 张)
      if (trimmedRefs.length) {
        const imgs = [];
        const useBase64 = String(image_mode || 'image_url') === 'base64';
        for (let i = 0; i < trimmedRefs.length; i++) {
          const r = trimmedRefs[i];
          if (useBase64) {
            // 转 base64 dataURI
            const conv = await refToBananaImage(r);
            if (conv) imgs.push(conv);
          } else {
            const u = await uploadRefToZhenzhen(r, apiKey);
            if (u) imgs.push(u);
            else throw new Error(`FAL 参考图 #${i + 1} 上传失败`);
          }
        }
        if (imgs.length) payload.image_urls = imgs;
      }
    } else {
      return res.status(400).json({ success: false, error: `不支持的 FAL paramKind: ${reg.paramKind}` });
    }

    const falUrl = `${baseUrl}/fal/${endpoint}`;
    console.log('[fal/submit]', apiModel, '→', falUrl, '| payload keys:', Object.keys(payload), '| refs:', trimmedRefs.length);

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
    if (data?.detail && !data?.images && !data?.request_id) {
      return res.status(400).json({ success: false, error: `FAL 错误: ${JSON.stringify(data.detail).slice(0, 300)}` });
    }

    // 同步返回
    if (Array.isArray(data?.images) && data.images.length) {
      const urls = [];
      for (const it of data.images) {
        if (it?.url) {
          const local = await saveRemoteImage(it.url);
          urls.push(local);
        }
      }
      return res.json({ success: true, data: { sync: true, urls, endpoint, raw: data } });
    }

    // 异步
    const requestId = data?.request_id;
    let responseUrl = data?.response_url || '';
    if (!requestId) {
      return res.status(500).json({ success: false, error: '未获取到 request_id: ' + JSON.stringify(data).slice(0, 300) });
    }
    responseUrl = fixFalResponseUrl(responseUrl, baseUrl, endpoint, requestId);
    rememberTaskKey(requestId, apiKey, { model: apiModel, endpoint });
    return res.json({
      success: true,
      data: { sync: false, requestId, responseUrl, endpoint, raw: data },
    });
  } catch (e) {
    console.error('proxy/image/fal/submit 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// POST /api/proxy/image/fal/query
//   body: { responseUrl, endpoint, requestId }
//   返回: { status: 'pending'|'completed'|'failed', urls?, error? }
router.post('/image/fal/query', async (req, res) => {
  const settings = loadRawSettings();
  const { responseUrl: rawUrl, endpoint, requestId } = req.body || {};
  const rememberedMeta = recallTaskMeta(requestId);
  if (rememberedMeta?.apiKey) {
    if (settings) settings.zhenzhenApiKey = rememberedMeta.apiKey;
    else return res.status(400).json({ success: false, error: '未找到 settings' });
  } else {
    // FAL 查询和提交保持同一策略：只用通用贞贞 API Key。
    if (!ensureDefaultZhenzhenKey(settings, res, '图像 FAL')) return;
  }
  const apiKey = settings.zhenzhenApiKey;
  const baseUrl = config.ZHENZHEN_BASE_URL;
  const responseUrl = fixFalResponseUrl(rawUrl, baseUrl, endpoint, requestId);
  if (!responseUrl) return res.status(400).json({ success: false, error: 'responseUrl 或 (endpoint+requestId) 必填' });

  try {
    const pr = await fetch(responseUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await pr.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    // HTTP 非200: 主项目规范 - body 中 status=IN_QUEUE/IN_PROGRESS 视为继续等待,其他报错
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
    // 完成
    if (Array.isArray(data.images) && data.images.length) {
      const urls = [];
      for (const it of data.images) {
        if (it?.url) {
          const local = await saveRemoteImage(it.url);
          urls.push(local);
        }
      }
      return res.json({ success: true, data: { status: 'completed', urls, raw: data } });
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
    console.error('proxy/image/fal/query 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '查询失败' });
  }
});

// ============================================================================
// Midjourney 三路由：严格对齐 gpt-image-2-web server.py _handle_mj_imagine / _handle_mj_fetch_task / _handle_mj_upload
//   上游：{ZHENZHEN_BASE_URL}/{mj-turbo|mj-fast|mj-relax}/mj/submit/imagine
//          {ZHENZHEN_BASE_URL}/{...}/mj/task/{id}/fetch
//          {ZHENZHEN_BASE_URL}/{...}/mj/submit/upload-discord-images
//   服从贞贞工坊集中 Key（同上其他 zhenzhen 路由）。
// ============================================================================
const MJ_SPEED_MAP = { turbo: 'mj-turbo', fast: 'mj-fast', relax: 'mj-relax' };
function mjSpeedSeg(speed) {
  return MJ_SPEED_MAP[String(speed || '').toLowerCase()] || 'mj-fast';
}

// ---- POST /api/proxy/mj/imagine ----
// body: { prompt, ar?, no?, c?, s?, iw?, sw?, cw?, sv?, seed?, base64Array?, speed?, modes?, instanceId?, notifyHook?, remix? }
// 返回上游 imagine 原始响应 { code, description, result(taskId), properties }
router.post('/mj/imagine', async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  if (!ensureKey(settings, res, 'mj', 'MJ')) return;
  const body = req.body || {};
  const speedSeg = mjSpeedSeg(body.speed);
  const url = `${config.ZHENZHEN_BASE_URL}/${speedSeg}/mj/submit/imagine`;
  // 严格对齐主项目 runMJ payload（index.html L4547~L4587）
  const payload = {
    base64Array: Array.isArray(body.base64Array) ? body.base64Array : [],
    instanceId: body.instanceId || '',
    modes: Array.isArray(body.modes) ? body.modes : [],
    notifyHook: body.notifyHook || '',
    prompt: String(body.prompt || ''),
    remix: body.remix !== false,
    state: body.state || '',
    ar: body.ar || null,
    no: body.no || null,
    c: body.c || null,
    s: body.s || null,
    iw: body.iw || null,
    tile: false,
    r: null,
    video: false,
    sw: body.sw || null,
    cw: body.cw || null,
    sv: body.sv || null,
    seed: body.seed || null,
  };
  try {
    console.log(`[mj/imagine] -> ${url}\n  prompt: ${payload.prompt.slice(0, 200)}`);
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.zhenzhenApiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
    if (!r.ok) return res.status(r.status).json({ success: false, error: data?.error || data?.description || `上游 HTTP ${r.status}` });
    return res.json({ success: true, data });
  } catch (e) {
    console.error('proxy/mj/imagine 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '提交失败' });
  }
});

// ---- GET /api/proxy/mj/task/:id?speed=fast ----
// 轮询任务状态
router.get('/mj/task/:id', async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  if (!ensureKey(settings, res, 'mj', 'MJ')) return;
  const taskId = req.params.id;
  const speedSeg = mjSpeedSeg(req.query.speed);
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId 必填' });
  const url = `${config.ZHENZHEN_BASE_URL}/${speedSeg}/mj/task/${encodeURIComponent(taskId)}/fetch`;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.zhenzhenApiKey}`,
      },
    });
    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + raw.slice(0, 200) }); }
    if (!r.ok) return res.status(r.status).json({ success: false, error: data?.error || data?.description || `上游 HTTP ${r.status}` });
    // image_urls 可能是 JSON 字符串也可能已是数组，透传，让前端统一处理
    return res.json({ success: true, data });
  } catch (e) {
    console.error('proxy/mj/task 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '查询失败' });
  }
});

// ---- POST /api/proxy/mj/upload ----
// body: { base64Data: 'data:image/png;base64,xxxx', speed? }
// 上传参考图到 MJ Discord，返回 URL（主项目 uploadMJImage L4407 + server.py L2457）
router.post('/mj/upload', async (req, res) => {
  const settings = loadRawSettings();
  // v1.2.9.15: 一体化「专属优先 fallback 通用」校验
  if (!ensureKey(settings, res, 'mj', 'MJ')) return;
  const { base64Data, speed } = req.body || {};
  if (!base64Data) return res.status(400).json({ success: false, error: 'base64Data 不得为空' });
  const speedSeg = mjSpeedSeg(speed);
  const url = `${config.ZHENZHEN_BASE_URL}/${speedSeg}/mj/submit/upload-discord-images`;
  const payload = { base64Array: [base64Data], instanceId: '', notifyHook: '' };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.zhenzhenApiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) }); }
    if (!r.ok) return res.status(r.status).json({ success: false, error: data?.error || data?.description || `上游 HTTP ${r.status}` });
    if (data.status === 'FAILURE') return res.status(500).json({ success: false, error: data.fail_reason || data.failReason || 'MJ upload failed' });
    let imgUrl = '';
    if (Array.isArray(data.result)) imgUrl = data.result[0] || '';
    else if (typeof data.result === 'string') imgUrl = data.result;
    if (!imgUrl) return res.status(500).json({ success: false, error: '上游未返回 URL: ' + JSON.stringify(data).slice(0, 200) });
    return res.json({ success: true, data: { url: imgUrl, raw: data } });
  } catch (e) {
    console.error('proxy/mj/upload 错误:', e);
    return res.status(500).json({ success: false, error: e.message || '上传失败' });
  }
});

// ========== POST /api/proxy/llm — LLM Chat(独立 Key) ==========
function hasLlmVideoParts(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) => Array.isArray(msg?.content) && msg.content.some((part) => (
    part?.type === 'video_url' || part?.type === 'input_video' || !!part?.video_url || !!part?.input_video
  )));
}

// body: { model, messages, temperature?, max_tokens?, stream?, llmVideoMode? }
//   - messages[i].content 支持 string 或 多模态数组 [{type:'text',text} | {type:'image_url',image_url:{url}} | {type:'video_url',video_url:{url}}]
//   - stream=true → 透传上游 SSE(text/event-stream) 到前端；有视频时强制非流式，避免网关丢多模态附件
//   - 完全对齐 gpt-image-2-web _doSendChat (index.html L8128~L8305)
module.exports = router;
