const { resolveMediaRef } = require('./mediaResolver');
const { normalizeLlmMessageMedia } = require('./llmMedia');
const {
  fetchWithTimeout,
  validateProvider,
  providerEndpointUrl,
  extractChatText,
  extractImageUrls,
  extractVideoUrls,
} = require('./openaiCompatible');

function bearerHeaders(provider) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
  };
}

function trimBodyForError(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function responseJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function unwrapResponse(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) && !raw.choices && !raw.data?.url && !raw.data?.b64_json) {
      return raw.data;
    }
  }
  return raw;
}

function extractTaskId(raw) {
  const data = unwrapResponse(raw);
  return String(
    data?.video_id ||
    data?.videoId ||
    data?.task_id ||
    data?.taskId ||
    data?.id ||
    raw?.video_id ||
    raw?.videoId ||
    raw?.task_id ||
    raw?.taskId ||
    raw?.id ||
    '',
  ).trim();
}

async function resolveReferenceImages(refs, options = {}) {
  const out = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const value = typeof ref === 'string' ? ref : ref?.url || ref?.imageUrl || ref?.value;
    if (!value) continue;

    // 如果已经是公网直链 (https:// 开头)，直接使用公网直链，避免转化为 Base64 造成 Payload 过大和超时
    if (value.startsWith('https://')) {
      out.push(value);
      continue;
    }

    const resolved = await resolveMediaRef(value, {
      target: options.referenceTarget || 'data-url',
      baseUrl: options.baseUrl,
    });
    out.push(resolved.dataUrl || resolved.url || resolved.path || value);
  }
  return out;
}

async function generateChat(provider, input = {}, options = {}) {
  const validation = validateProvider(provider, { apiKeyRequired: true });
  if (!validation.ok) return validation;

  const model = String(input.model || input.providerModel || provider.defaults?.chatModel || 'agnes-2.0-flash').trim();
  const messages = Array.isArray(input.messages) && input.messages.length
    ? input.messages
    : [{ role: 'user', content: String(input.prompt || '').trim() }];

  if (!messages.some((message) => String(message?.content || '').trim())) {
    return { ok: false, code: 'missing_prompt', providerId: provider.id, protocol: 'agens', error: '请输入要发送的内容。' };
  }

  let normalizedMessages;
  try {
    normalizedMessages = await normalizeLlmMessageMedia(messages, input, {
      baseUrl: options.baseUrl,
      ffmpegPath: options.ffmpegPath,
      ffmpegTimeoutMs: options.ffmpegTimeoutMs,
    });
  } catch (e) {
    return { ok: false, code: 'invalid_multimodal_reference', providerId: provider.id, protocol: 'agens', error: e?.message || '多模态素材预处理失败。' };
  }

  const body = { model, messages: normalizedMessages };
  if (input.temperature != null) body.temperature = Number(input.temperature);
  if (input.maxTokens != null) body.max_tokens = Number(input.maxTokens);
  if (input.max_tokens != null) body.max_tokens = Number(input.max_tokens);
  if (input.stream != null) body.stream = !!input.stream;

  const url = providerEndpointUrl(provider, '/chat/completions', ['chatEndpoint', 'chat_endpoint']);
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: bearerHeaders(provider),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    const raw = await responseJson(res);
    if (!res.ok) {
      return { ok: false, code: 'http_error', providerId: provider.id, protocol: 'agens', error: `Agens 调用失败：HTTP ${res.status} ${trimBodyForError(raw?.message)}`, raw };
    }
    const text = extractChatText(raw);
    if (!text) {
      return { ok: false, code: 'empty_text', providerId: provider.id, protocol: 'agens', error: 'Agens 没有返回文本。', raw };
    }
    return { ok: true, kind: 'llm', code: 'completed', providerId: provider.id, protocol: 'agens', model, text, raw };
  } catch (e) {
    return { ok: false, code: e?.name === 'AbortError' ? 'timeout' : 'network_error', providerId: provider.id, protocol: 'agens', error: e?.name === 'AbortError' ? 'Agens 调用超时。' : (e?.message || 'Agens 调用失败。') };
  }
}

async function generateImage(provider, input = {}, options = {}) {
  const validation = validateProvider(provider, { apiKeyRequired: true });
  if (!validation.ok) return validation;

  const prompt = String(input.prompt || '').trim();
  if (!prompt) {
    return { ok: false, code: 'missing_prompt', providerId: provider.id, protocol: 'agens', error: '请输入图像提示词。' };
  }

  const model = String(input.model || input.providerModel || provider.defaults?.imageModel || 'agnes-image-2.1-flash').trim();
  const body = { model, prompt };

  if (input.size) body.size = String(input.size);
  if (input.n != null) body.n = Number(input.n);
  if (input.quality) body.quality = String(input.quality);

  let responseFormat = input.response_format || 'url';

  let hasRef = false;
  try {
    const refs = await resolveReferenceImages(input.images || input.referenceImages || input.reference_images, {
      baseUrl: options.baseUrl,
      referenceTarget: input.referenceTarget || provider.defaults?.referenceTarget || 'data-url',
    });
    if (refs.length) {
      hasRef = true;
      body.extra_body = body.extra_body || {};
      body.extra_body.image = refs; // Agens 支持 image 数组
    }
  } catch (e) {
    return { ok: false, code: 'invalid_reference', providerId: provider.id, protocol: 'agens', error: e?.message || '参考图解析失败。' };
  }

  // Agens 的特殊要求: response_format 必须放在 extra_body，不管是不是图生图，统统放进去更稳妥，或者只有传入 response_format 时才放
  body.extra_body = body.extra_body || {};
  body.extra_body.response_format = responseFormat;

  const url = providerEndpointUrl(provider, '/images/generations', ['imageGenerationEndpoint', 'image_generation_endpoint']);
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: bearerHeaders(provider),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    const raw = await responseJson(res);
    if (!res.ok) {
      return { ok: false, code: 'http_error', providerId: provider.id, protocol: 'agens', error: `Agens 图像调用失败：HTTP ${res.status} ${trimBodyForError(raw?.message)}`, raw };
    }
    const imageUrls = extractImageUrls(raw);
    if (!imageUrls.length) {
      return { ok: false, code: 'empty_image', providerId: provider.id, protocol: 'agens', error: 'Agens 图像接口没有返回图片。', raw };
    }
    return { ok: true, kind: 'image', code: 'completed', providerId: provider.id, protocol: 'agens', model, imageUrls, raw };
  } catch (e) {
    return { ok: false, code: e?.name === 'AbortError' ? 'timeout' : 'network_error', providerId: provider.id, protocol: 'agens', error: e?.name === 'AbortError' ? 'Agens 图像调用超时。' : (e?.message || 'Agens 图像调用失败。') };
  }
}

async function generateVideo(provider, input = {}, options = {}) {
  const validation = validateProvider(provider, { apiKeyRequired: true });
  if (!validation.ok) return validation;

  const prompt = String(input.prompt || '').trim();
  if (!prompt) {
    return { ok: false, code: 'missing_prompt', providerId: provider.id, protocol: 'agens', error: '请输入视频提示词。' };
  }

  const model = String(input.model || input.providerModel || provider.defaults?.videoModel || 'agnes-video-v2.0').trim();
  const body = { model, prompt };

  // 处理分辨率和宽高比，转化为 Agens 要求的 size 字段 (必须是 32 的倍数更稳妥)
  if (input.size) {
    body.size = String(input.size);
  } else if (input.resolution || input.aspect_ratio || input.ratio) {
    const resStr = String(input.resolution || '720P').toUpperCase();
    const ratioStr = String(input.aspect_ratio || input.ratio || '16:9').trim();

    let baseWidth = 1280, baseHeight = 768; // 默认 720P 级别
    if (resStr === '480P') {
      baseWidth = 864; baseHeight = 480;
    } else if (resStr === '1080P') {
      baseWidth = 1920; baseHeight = 1088;
    } else if (resStr === '2K') {
      baseWidth = 2560; baseHeight = 1440;
    } else if (resStr === '4K') {
      baseWidth = 3840; baseHeight = 2176;
    }

    if (ratioStr === '1:1') {
      body.size = `${baseHeight}x${baseHeight}`;
    } else if (ratioStr === '9:16' || ratioStr === '3:4') {
      body.size = `${baseHeight}x${baseWidth}`;
    } else {
      body.size = `${baseWidth}x${baseHeight}`;
    }
  }

  // Agens 视频时长控制: num_frames 和 frame_rate (num_frames = 8n + 1, max 441)
  const duration = input.duration != null ? Number(input.duration) : 6;
  const frameRate = 24;
  let numFrames = Math.round((duration * frameRate) / 8) * 8 + 1;
  if (numFrames > 441) numFrames = 441;
  
  body.num_frames = numFrames;
  body.frame_rate = frameRate;
  
  // 提取前端可能传入的生成模式
  const mode = input.mode || input.providerParams?.mode || 'standard';

  try {
    const refs = await resolveReferenceImages(input.images || input.referenceImages || input.reference_images, {
      baseUrl: options.baseUrl,
      referenceTarget: input.referenceTarget || provider.defaults?.videoReferenceTarget || 'data-url',
    });

    if (refs.length > 0) {
      if (mode === 'keyframes') {
        // 智能关键帧模式: 强制使用 extra_body 结构并附带 keyframes 模式参数
        body.extra_body = body.extra_body || {};
        body.extra_body.mode = 'keyframes';
        body.extra_body.image = refs;
      } else {
        // 标准模式 (Standard): 根据图片数量组装，但永远不附加关键帧模式参数
        if (refs.length === 1) {
          body.image = refs[0];
        } else {
          body.extra_body = body.extra_body || {};
          body.extra_body.image = refs;
        }
      }
    }
  } catch (e) {
    return { ok: false, code: 'invalid_reference', providerId: provider.id, protocol: 'agens', error: e?.message || '参考图解析失败。' };
  }

  // Agens 视频可能使用原生的 /videos 或者 /v1/videos
  // 我们通过 providerEndpointUrl 获取默认的 baseUrl，并拼接 /videos
  let url = providerEndpointUrl(provider, '/videos', ['videoGenerationEndpoint', 'video_generation_endpoint']);
  if (url.includes('/videos/generations')) {
    url = url.replace('/videos/generations', '/videos');
  }

  try {
    // 在后端终端打印原始请求，防止网络卡死时看不见
    console.log(`[Agens Video] 发起请求: URL=${url}`, JSON.stringify(body));

    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: bearerHeaders(provider),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    const raw = await responseJson(res);
    
    console.log(`[Agens Video] 收到响应: HTTP ${res.status}`, JSON.stringify(raw));

    if (!res.ok) {
      return { ok: false, code: 'http_error', providerId: provider.id, protocol: 'agens', error: `Agens 视频调用失败：HTTP ${res.status}。原始响应: ${JSON.stringify(raw)}`, raw };
    }

    const taskId = extractTaskId(raw);
    const initialVideoUrls = extractVideoUrls(raw);

    if (initialVideoUrls.length) {
      return { ok: true, kind: 'video', code: 'completed', providerId: provider.id, protocol: 'agens', model, taskId, videoUrls: initialVideoUrls, raw };
    }

    if (!taskId) {
      return { ok: false, code: 'missing_task_id', providerId: provider.id, protocol: 'agens', error: `Agens 视频接口未返回 task id。原始响应: ${JSON.stringify(raw)}`, raw };
    }

    // 长时静默轮询逻辑
    return await pollAgensVideo(provider, taskId, model, options);
  } catch (e) {
    return { ok: false, code: e?.name === 'AbortError' ? 'timeout' : 'network_error', providerId: provider.id, protocol: 'agens', error: e?.name === 'AbortError' ? 'Agens 视频调用超时。' : (e?.message || 'Agens 视频调用失败。') };
  }
}

async function pollAgensVideo(provider, taskId, model, options = {}) {
  let baseUrl = cleanBaseUrl(provider?.baseUrl);
  // Agens 的查询接口是根目录下的 /agnesapi，如果用户填了 /v1，需要切掉，否则会触发 404
  if (baseUrl.endsWith('/v1')) {
    baseUrl = baseUrl.slice(0, -3);
  }
  const url = `${baseUrl}/agnesapi?video_id=${encodeURIComponent(taskId)}`;
  
  const startTime = Date.now();
  const maxTimeout = options.maxPollingMs || 10 * 60 * 1000; // 最大 10 分钟
  const pollInterval = 5000;

  while (Date.now() - startTime < maxTimeout) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      console.log(`[Agens Video] 轮询请求: URL=${url}`);
      const res = await fetchWithTimeout(url, {
        method: 'GET',
        headers: bearerHeaders(provider),
        timeoutMs: 10000,
        fetchImpl: options.fetchImpl,
      });
      const raw = await responseJson(res);
      console.log(`[Agens Video] 轮询响应: HTTP ${res.status}`, JSON.stringify(raw));

      if (!res.ok) {
        continue; // 忽略某一次查询失败
      }

      const statusStr = String(raw?.status || raw?.data?.status || '').toLowerCase();
      
      // 判断成功
      const videoUrls = extractVideoUrls(raw);
      if (videoUrls.length > 0 && statusStr !== 'processing' && statusStr !== 'pending') {
        return { ok: true, kind: 'video', code: 'completed', providerId: provider.id, protocol: 'agens', model, taskId, videoUrls, raw };
      }

      // 判断失败
      if (statusStr === 'failed' || statusStr === 'error') {
        return { ok: false, code: 'generation_failed', providerId: provider.id, protocol: 'agens', error: 'Agens 视频生成失败。', taskId, raw };
      }

    } catch (e) {
      // 网络波动导致的超时，忽略并重试
      continue;
    }
  }

  return { ok: false, code: 'polling_timeout', providerId: provider.id, protocol: 'agens', error: 'Agens 视频轮询超时。', taskId };
}

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function testProvider(provider, options = {}) {
  const validation = validateProvider(provider, { apiKeyRequired: true });
  if (!validation.ok) return validation;

  if (options.dryRun) {
    return { ok: true, code: 'dry_run_ok', providerId: provider.id, protocol: 'agens', message: '配置格式可用。' };
  }

  const url = `${validation.baseUrl}/models`;
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: bearerHeaders(provider),
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    if (!res.ok) {
      return { ok: false, code: 'http_error', providerId: provider.id, protocol: 'agens', error: `Agens 测试连接失败：HTTP ${res.status}` };
    }
    return { ok: true, code: 'connected', providerId: provider.id, protocol: 'agens', message: 'Agens 连接成功。' };
  } catch (e) {
    return { ok: false, code: e?.name === 'AbortError' ? 'timeout' : 'network_error', providerId: provider.id, protocol: 'agens', error: e?.name === 'AbortError' ? 'Agens 测试连接超时。' : (e?.message || 'Agens 测试连接失败。') };
  }
}

module.exports = {
  generateChat,
  generateImage,
  generateVideo,
  testProvider,
};
