const express = require('express');
const router = express.Router();
const config = require('../../config');
const {
  extFromContentType,
  loadRawSettings
} = require('./_helpers');

router.post('/llm', async (req, res) => {
  const settings = loadRawSettings();
  if (!settings?.llmApiKey) {
    return res.status(400).json({ success: false, error: '未配置 LLM 独立 API Key' });
  }
  const { model, messages, temperature, max_tokens, stream } = req.body || {};
  if (!model || !messages) {
    return res.status(400).json({ success: false, error: 'model 和 messages 必填' });
  }
  const inputHadVideos = hasLlmVideoParts(messages);

  // 预处理 messages 中的 image_url / video_url:
  //   - 图片: 本地 /files/* 转 base64 dataURL
  //   - 视频: 默认用项目内置 ffmpeg 抽关键帧转 image_url；或按用户选择发送原视频 Base64 / URL
  // 避免上游 LLM 服务拿着本地相对路径报 convert_request_failed。
  let normalizedMessages;
  try {
    normalizedMessages = await normalizeLlmMessageMedia(messages, req.body || {}, {
      baseUrl: `http://127.0.0.1:${config.PORT}`,
    });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message || '多模态素材预处理失败' });
  }

  const upstream = `${config.ZHENZHEN_BASE_URL}/v1/chat/completions`;
  const payload = {
    model,
    messages: normalizedMessages,
    temperature: temperature ?? 0.7,
    max_tokens: max_tokens ?? 4096,
    stream: !!stream && !inputHadVideos,
  };

  try {
    const r = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.llmApiKey}`,
      },
      body: JSON.stringify(payload),
    });

    // ===== 流式分支:SSE pass-through =====
    if (payload.stream) {
      if (!r.ok) {
        const errText = await r.text();
        return res.status(r.status).json({
          success: false,
          error: `上游 HTTP ${r.status}: ${errText.slice(0, 300)}`,
        });
      }
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      // Node 18+ fetch response.body 为 ReadableStream
      try {
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        // 透传上游字节,前端按 SSE 解析
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch (streamErr) {
        console.error('proxy/llm SSE 转发异常:', streamErr);
      }
      return res.end();
    }

    // ===== 非流式分支(gpt-image-2-all 等) =====
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({ success: false, error: '上游响应非 JSON: ' + text.slice(0, 200) });
    }
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        error: data?.error?.message || `上游 HTTP ${r.status}`,
      });
    }
    // 处理 content 可能是字符串或多模态数组(gpt-image-2-all 出图)
    const choice = data?.choices?.[0];
    let content = choice?.message?.content || '';
    const imageUrls = [];
    if (Array.isArray(content)) {
      let textParts = '';
      content.forEach((part) => {
        if (part?.type === 'text') textParts += part.text || '';
        else if (part?.type === 'image_url' && part.image_url?.url) imageUrls.push(part.image_url.url);
        else if (part?.type === 'image' && part.image_url?.url) imageUrls.push(part.image_url.url);
      });
      content = textParts;
    }
    if (Array.isArray(data?.data)) {
      data.data.forEach((d) => {
        if (d?.url) imageUrls.push(d.url);
        else if (d?.b64_json) imageUrls.push('data:image/png;base64,' + d.b64_json);
      });
    }
    res.json({
      success: true,
      data: { content, imageUrls, raw: data, model },
    });
  } catch (e) {
    console.error('proxy/llm 错误:', e);
    res.status(500).json({ success: false, error: e.message || '请求失败' });
  }
});

// ========================================================================
// 视频生成(异步) — 完全对齐 gpt-image-2-web
// 协议(贞贞工坊): POST /v2/videos/generations + GET /v2/videos/generations/:tid
//
// 通过 model 字段自动选择上游 payload 协议:
//   - veo-omni-10s  → Veo Omni 协议: POST /v1/videos multipart
//                      { model=omni_flash-10s, prompt, size, seconds=10, watermark, input_reference }
//   - 含 'veo'      → Veo3.1 协议:  { prompt, model, enhance_prompt, aspect_ratio, seed?, enable_upsample?, images?(base64,最多3) }
//                       (主项目 runVeo3, index.html line 3372)
//   - 含 'grok'     → Grok Video 协议: { prompt, model, ratio, duration(数字秒), resolution, seed?, images?(URL,最多7) }
//                       (主项目 runGrok3, index.html line 3863) — 参考图先 POST /v1/files 取 URL
//   - 其它(seedance 等)→ 沿用旧 Veo 字段(零破坏)
// ========================================================================

// 上传本地/远端参考素材到上游 /v1/files 取 URL
// 对齐 gpt-image-2-web 的 uploadFileToAPI: Seedance 的图像、视频、音频都不能直接传 /files/* 本地 URL。
async function uploadRefToZhenzhen(ref, apiKey) {
  if (typeof ref !== 'string' || !ref) return null;
  const trimmed = ref.trim();
  if (/^asset-[a-z0-9_-]+$/i.test(trimmed)) return trimmed;
  let buf, mime, ext;
  if (trimmed.startsWith('data:')) {
    const m = trimmed.match(/^data:([^;,]+);base64,(.+)$/);
    if (!m) return null;
    mime = m[1] || 'image/png';
    buf = Buffer.from(m[2], 'base64');
    ext = extFromContentType(mime) || (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
  } else if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('/files/') ||
    trimmed.startsWith('/api/resources/file/') ||
    trimmed.startsWith('/api/resources/set-file/')
  ) {
    const url = trimmed.startsWith('/') ? `http://127.0.0.1:${config.PORT}${trimmed}` : trimmed;
    const r = await fetch(url);
    if (!r.ok) return null;
    mime = r.headers.get('content-type') || 'image/png';
    buf = Buffer.from(await r.arrayBuffer());
    const tailExt = url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,8})$/i)?.[1];
    ext = extFromContentType(mime) || tailExt || (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
  } else {
    return null;
  }
  const fd = new FormData();
  const blob = new Blob([buf], { type: mime });
  fd.append('file', blob, `ref_${Date.now()}.${ext}`);
  const upR = await fetch(`${config.ZHENZHEN_BASE_URL}/v1/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });
  if (!upR.ok) {
    console.warn('[video] /v1/files 上传失败 status=', upR.status);
    return null;
  }
  const j = await upR.json();
  return j?.url || null;
}

// ========================================================================
// Video FAL 渠道 — 完全对齐 gpt-image-2-web runVeo3Fal / runGrokFal
// 不破坏原有 /video/submit · /video/query 路由。
//
// POST /api/proxy/video/fal/submit  → { sync, videoUrl?, requestId?, responseUrl?, endpoint? }
// POST /api/proxy/video/fal/query   → { status, videoUrl?, error? }   body: { responseUrl, endpoint, requestId }
// ========================================================================

const VIDEO_FAL_REGISTRY = {
  'veo3.1-fal': {
    endpoint: 'fal-ai/veo3.1/fast/reference-to-video',
    paramKind: 'veo-fal',
    maxRefImages: 3,
  },
  'grok-video-fal': {
    endpoint: 'xai/grok-imagine-video/text-to-video',
    i2vEndpoint: 'xai/grok-imagine-video/image-to-video',
    referenceEndpoint: 'xai/grok-imagine-video/reference-to-video',
    paramKind: 'grok-fal',
    maxRefImages: 7,
    defaultImageMode: 'base64',
  },
  'grok-imagine-video-1.5': {
    endpoint: 'xai/grok-imagine-video/v1.5/image-to-video',
    paramKind: 'grok-fal',
    maxRefImages: 1,
    defaultImageMode: 'base64',
    requiresImage: true,
    disableAspectRatio: true,
  },
  'sora-2': {
    endpoint: 'fal-ai/sora-2/text-to-video',
    i2vEndpoint: 'fal-ai/sora-2/image-to-video',
    paramKind: 'sora-fal',
    maxRefImages: 1,
    defaultImageMode: 'base64',
  },
};

function getFalVideoUrl(data) {
  const video = data && data.video;
  if (video && typeof video === 'object' && video.url) return video.url;
  if (typeof video === 'string') return video;
  return data?.video_url
    || data?.url
    || data?.output?.video?.url
    || data?.data?.output
    || data?.data?.video_url
    || data?.data?.video?.url
    || '';
}

function splitSoraCharacterIds(raw) {
  return String(raw || '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);
}

function splitGrokReferenceUrls(raw) {
  const values = Array.isArray(raw) ? raw : String(raw || '').split(/[,，\n]/);
  return values
    .map((s) => String(s || '').trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function stripDataUrlPrefix(value) {
  const text = String(value || '').trim();
  const match = /^data:[^,;]+;base64,(.+)$/i.exec(text);
  return match ? match[1].trim() : text;
}

const VEO_OMNI_PUBLIC_MODEL = 'veo-omni-10s';
const VEO_OMNI_UPSTREAM_MODEL = 'omni_flash-10s';

function isVeoOmniModel(model) {
  const m = String(model || '').trim().toLowerCase();
  return m === VEO_OMNI_PUBLIC_MODEL || m === VEO_OMNI_UPSTREAM_MODEL;
}

function veoOmniSizeFromAspect(aspectRatio) {
  return String(aspectRatio || '').trim() === '9:16' ? '720x1280' : '1280x720';
}

function normalizeVideoTaskStatus(status) {
  const raw = String(status || '').trim();
  const lower = raw.toLowerCase();
  if (['success', 'succeeded', 'completed', 'complete', 'done'].includes(lower)) return 'SUCCESS';
  if (['failure', 'failed', 'error', 'cancelled', 'canceled'].includes(lower)) return 'FAILURE';
  if (['running', 'processing', 'in_progress', 'in-progress'].includes(lower)) return 'RUNNING';
  if (['queued', 'pending', 'created', 'submitted'].includes(lower)) return 'PENDING';
  return raw.toUpperCase();
}

function stringifyUpstreamErrorValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    if (typeof value.message === 'string') return value.message.trim();
    if (typeof value.msg === 'string') return value.msg.trim();
    if (typeof value.detail === 'string') return value.detail.trim();
    try { return JSON.stringify(value).slice(0, 500); } catch { return ''; }
  }
  return String(value).trim();
}

function getUpstreamErrorMessage(data, text, status) {
  const candidates = [
    data?.error?.message,
    data?.error,
    data?.message,
    data?.msg,
    data?.detail,
    data?.error_msg,
    data?.fail_reason,
    data?.data?.error?.message,
    data?.data?.error,
    data?.data?.message,
    data?.data?.msg,
    data?.data?.detail,
    data?.data?.fail_reason,
  ];
  for (const candidate of candidates) {
    const msg = stringifyUpstreamErrorValue(candidate);
    if (msg) return `上游 HTTP ${status}: ${msg}`;
  }
  const rawText = String(text || '').trim();
  if (rawText) return `上游 HTTP ${status}: ${rawText.slice(0, 500)}`;
  return `上游 HTTP ${status}`;
}

// 保存远程视频到本地
async function saveRemoteVideo(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (url.match(/\.(mp4|webm|mov)/i)?.[1] || 'mp4').toLowerCase();
    const filename = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const filePath = path.join(config.OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, buf);
    return `/files/output/${filename}`;
  } catch (e) {
    console.error('⚠ 转存视频失败:', e.message);
    return url;
  }
}

// POST /api/proxy/video/fal/submit
module.exports = router;
