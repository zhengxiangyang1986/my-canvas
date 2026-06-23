/**
 * 上游 API 代理路由
 * 1. 隐藏 API Key,前端只通过 /api/proxy/* 调用
 * 2. 自动注入对应的 Key(贞贞工坊 / LLM 独立)
 * 3. 图像生成结果自动转存到 /output 并返回本地 URL
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../../config');
const { getWhitePng } = require('../../utils/whitePng');
const { tryDecodeDuckPayload } = require('../../utils/duckPayload');
const { normalizeLlmMessageMedia } = require('../../providers/llmMedia');
const { runLocalHooks } = require('../../extensions/runtimeHooks');



// 音频文件上传中间件(内存存储, 50MB)
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function safeOutputExt(ext, fallback = 'png') {
  const s = String(ext || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
  return s || fallback;
}

function extFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/flac': 'flac',
  };
  return map[ct] || '';
}

function inferRemoteOutputExt(url, contentType) {
  const tail = String(url || '').split(/[?#]/)[0];
  const m = tail.match(/\.([a-z0-9]{2,8})$/i);
  return safeOutputExt(m ? m[1] : extFromContentType(contentType), 'png');
}

// ========== 工具:加载 Settings 明文 ==========
function loadRawSettings() {
  if (!fs.existsSync(config.SETTINGS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

// ========== 工具: 按提示词（模型名 / endpoint / 路由名）选择分类 API Key ==========
// 未填分类 key 时 fallback 到 通用 zhenzhenApiKey。
// hint 例: 'gpt-image-1' / 'nano-banana-pro' / 'gemini-3.1-flash-image-preview' / 'mj-fast' / 'veo3.1-fal'
//          / 'grok-video-fal' / 'seedance-v3' / 'suno-v5.5' / 'fal-ai/nano-banana/edit'
function pickApiKey(settings, hint = '') {
  if (!settings) return '';
  const fb = settings.zhenzhenApiKey || '';
  const m = String(hint || '').toLowerCase();
  if (!m) return fb;
  if (m.includes('gpt-image') || m.includes('gpt2') || m.includes('gpt_image') || m.includes('gptimage')) return settings.gptImageApiKey || fb;
  if (m.includes('nano-banana') || m.includes('nano_banana') || m.includes('nanobanana') || m.includes('flash-image-preview')) return settings.nanoBananaApiKey || fb;
  if (m.includes('midjourney') || /\bmj[-_/]/.test(m) || m.startsWith('mj') || m === 'mj') return settings.mjApiKey || fb;
  if (m.includes('veo')) return settings.veoApiKey || fb;
  if (m.includes('sora')) return settings.soraApiKey || fb;
  if (m.includes('grok')) return settings.grokApiKey || fb;
  if (m.includes('seedance')) return settings.seedanceApiKey || fb;
  if (m.includes('suno') || m.includes('chirp')) return settings.sunoApiKey || fb;
  return fb;
}

function normalizeImageApiModel(model) {
  const raw = String(model || '').trim();
  if (raw === 'nano-banana-2') return 'gemini-3.1-flash-image-preview';
  if (gptImage2ZhenzhenVariantSize(raw)) return 'gpt-image-2';
  return raw;
}

function gptImage2ZhenzhenVariantSize(model) {
  const raw = String(model || '').trim().toLowerCase();
  if (raw === 'gpt-image-2-2k') return '2K';
  if (raw === 'gpt-image-2-4k') return '4K';
  return '';
}

function isBananaImageModel(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('nano-banana')
    || m.includes('nano_banana')
    || m.includes('nanobanana')
    || m.includes('flash-image-preview');
}

// ========== 工具: 以提示词为准，将 settings.zhenzhenApiKey 临时覆盖为分类 key ==========
// 调用后，后续所有 settings.zhenzhenApiKey 引用默认都会拿到分类 key（零侵入原逻辑）。
function applyClassifiedKey(settings, hint) {
  if (!settings) return;
  const picked = pickApiKey(settings, hint);
  if (picked) settings.zhenzhenApiKey = picked;
}

// ========== v1.2.9.15 新增：「专属优先 fallback 通用」一体化 API Key 校验 ==========
// 修复 v1.2.9.14 之前的两类 bug：
//   ① 旧路由先校验 settings.zhenzhenApiKey 非空 → 再 applyClassifiedKey；
//      若用户「只配置了分类专属 key 而通用 key 留空」，会被第一道检查误拦，
//      报「未配置贞贞工坊 API Key」，但其实专属 key 已存在；
//   ② 即使 zhenzhenApiKey 是错误值（如 '123'），按旧顺序通过校验后 applyClassifiedKey
//      仍能用 sunoApiKey 覆盖，但用户错配了 audio/upload 这类「完全没调 applyClassifiedKey」
//      的子路由 → Suno 上传步骤直接用 zhenzhenApiKey='123' 上传 → 上游返回令牌错误。
//
// 用法：
//   const settings = loadRawSettings();
//   if (!ensureKey(settings, res, 'suno', 'Suno')) return;
//   // 此时 settings.zhenzhenApiKey 已是 effective key（专属优先 fallback 通用），
//   // 后续直接 `Bearer ${settings.zhenzhenApiKey}` 即可。
//
// 副作用：成功时（return true）已对 settings 做 applyClassifiedKey；
//        失败时（return false）已通过 res 写入 400 响应，调用方应直接 return。
//
// 设计原则：
//   - 「专属优先」：sunoApiKey 非空 → 用 sunoApiKey；
//   - 「通用 fallback」：sunoApiKey 留空但 zhenzhenApiKey 非空 → 用 zhenzhenApiKey；
//   - 「双空才拒」：两者都空时报「分类专属 + 通用 至少填其一」。
function ensureKey(settings, res, hint, label) {
  if (!settings) {
    res.status(400).json({ success: false, error: '未找到 settings 文件，请先在【设置】中配置 API Key' });
    return false;
  }
  applyClassifiedKey(settings, hint || '');
  if (!settings.zhenzhenApiKey) {
    const tip = label
      ? `未配置 ${label} 专属 API Key，且贞贞工坊通用 API Key 也为空（请在【设置】中至少填写其中一个）`
      : '未配置贞贞工坊 API Key（请在【设置】中填写）';
    res.status(400).json({ success: false, error: tip });
    return false;
  }
  return true;
}

function ensureDefaultZhenzhenKey(settings, res, label = '贞贞工坊') {
  if (!settings) {
    res.status(400).json({ success: false, error: '未找到 settings 文件，请先在【设置】中配置 API Key' });
    return false;
  }
  if (!settings.zhenzhenApiKey) {
    res.status(400).json({ success: false, error: `${label} 使用通用贞贞 API Key，请先在【设置】中填写贞贞工坊通用 API Key` });
    return false;
  }
  return true;
}

// ========== 工具: taskId → 实际使用的 apiKey 内存映射 ==========
// submit 阶段根据 hint 选了分类 key 后，将 (taskId → key) 记下，
// query/status 阶段优先从该 Map 恢复 key，
// 防止前端未透传 model 时轮询错误 fallback 到通用 key 导致“令牌不合法”。
// 30 分钟过期自清。
const taskKeyMap = new Map();
function rememberTaskKey(taskId, apiKey, meta = {}) {
  if (!taskId || !apiKey) return;
  taskKeyMap.set(String(taskId), { apiKey, ...meta });
  setTimeout(() => taskKeyMap.delete(String(taskId)), 30 * 60 * 1000);
}
function recallTaskMeta(taskId) {
  if (!taskId) return null;
  const item = taskKeyMap.get(String(taskId));
  if (!item) return null;
  return typeof item === 'string' ? { apiKey: item } : item;
}
function recallTaskKey(taskId) {
  return recallTaskMeta(taskId)?.apiKey || null;
}

function normalizeProviderParams(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseProviderParams(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return normalizeProviderParams(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return normalizeProviderParams(value);
}

function hasSelectedProviderGroup(providerParams) {
  const params = normalizeProviderParams(providerParams);
  return !!String(params.zhenzhenGroup || params.t8Group || params.group || '').trim();
}

function ensureKeyOrSelectedGroup(settings, res, hint = '', label = '', providerParams = {}) {
  if (!settings) {
    res.status(400).json({ success: false, error: '未找到 settings 文件，请先在【设置】中配置 API Key' });
    return false;
  }
  applyClassifiedKey(settings, hint || '');
  if (settings.zhenzhenApiKey || hasSelectedProviderGroup(providerParams)) return true;
  const tip = label
    ? `未配置 ${label} 专属 API Key，且贞贞工坊通用 API Key 也为空（如已绑定 New API 分组令牌，请在节点上选择分组）`
    : '未配置贞贞工坊 API Key（请在【设置】中填写，或绑定 New API 后在节点选择分组）';
  res.status(400).json({ success: false, error: tip });
  return false;
}

async function applyZhenzhenProviderContext(settings, options = {}) {
  if (!settings) {
    return {
      apiKey: '',
      taskMeta: {},
    };
  }
  const providerParams = normalizeProviderParams(options.providerParams);
  const selectedGroup = String(providerParams.zhenzhenGroup || providerParams.t8Group || providerParams.group || '').trim();
  const result = await runLocalHooks('zhenzhen.resolveApiKey', {
    provider: 'zhenzhen',
    route: options.route || '',
    kind: options.kind || '',
    model: options.model || options.hint || '',
    hint: options.hint || options.model || '',
    apiKey: settings.zhenzhenApiKey,
    providerParams,
  });
  if (result?.apiKey && typeof result.apiKey === 'string') {
    settings.zhenzhenApiKey = result.apiKey;
  }
  if (selectedGroup && !settings.zhenzhenApiKey) {
    throw new Error('已选择分组令牌，但当前未找到可用 API Key；请在 API Key 设置里启用并绑定 New API 分组令牌，或改用通用贞贞 API Key');
  }
  const taskMeta = {
    ...(result?.taskMeta && typeof result.taskMeta === 'object' ? result.taskMeta : {}),
  };
  if (result?.group) taskMeta.group = result.group;
  if (result?.groupLabel) taskMeta.groupLabel = result.groupLabel;
  if (result?.model) taskMeta.model = result.model;
  return {
    apiKey: settings.zhenzhenApiKey,
    taskMeta,
  };
}

function isInvalidApiKeyError(errorText) {
  return /无效的令牌|令牌无效|invalid\s+(?:access\s+)?token|unauthorized/i.test(String(errorText || ''));
}

async function invalidateZhenzhenProviderKey(providerContext, apiKey, errorText) {
  const group = providerContext?.taskMeta?.group || providerContext?.taskMeta?.selectedGroup;
  if (!group || !apiKey || !isInvalidApiKeyError(errorText)) return;
  try {
    await runLocalHooks('zhenzhen.invalidateApiKey', {
      group,
      apiKey,
      error: String(errorText || '').slice(0, 500),
    });
  } catch (error) {
    console.warn('[zhenzhen] invalidate group token failed:', error?.message || error);
  }
}

// ========== 工具:保存上游返回的图像到本地 ==========
async function saveRemoteImage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (url.match(/\.(png|jpe?g|webp|gif)/i)?.[1] || 'png').toLowerCase();
    const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const filePath = path.join(config.OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, buf);
    return `/files/output/${filename}`;
  } catch (e) {
    console.error('⚠ 转存图像失败:', e.message);
    return url; // 退化:返回原 URL
  }
}

// ========== 工具:保存上游返回的音频到本地 ==========
async function saveRemoteAudio(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (url.match(/\.(mp3|wav|m4a|ogg|flac|aac)/i)?.[1] || 'mp3').toLowerCase();
    const filename = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const filePath = path.join(config.OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, buf);
    return `/files/output/${filename}`;
  } catch (e) {
    console.error('⚠ 转存音频失败:', e.message);
    return url; // 退化:返回原 URL
  }
}

// 处理 b64_json 格式
function saveBase64Image(b64) {
  try {
    const raw = String(b64 || '');
    const clean = raw.includes(',') ? raw.split(',').pop() : raw;
    const buf = Buffer.from(clean || '', 'base64');
    const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
    const filePath = path.join(config.OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, buf);
    return `/files/output/${filename}`;
  } catch (e) {
    console.error('⚠ 解析 b64 失败:', e.message);
    return null;
  }
}

// ========== POST /api/proxy/image — 图像生成 ==========
// body: { model, apiModel?, paramKind?, prompt, aspect_ratio?, image_size?, images?[], size?, image?, quality?, n? }
//
// 主项目对齐的双协议路由:
//  1. paramKind === 'gpt-size'
//     - 无参考图 → POST /v1/images/generations (JSON)  body: { model, prompt, size }
//     - 有参考图 → POST /v1/images/edits        (multipart) image 多次 append
//     - size 从 (aspect_ratio + image_size 等级) 映射为像素串(1024x1024/1536x1024/1024x1536/2048x2048…)
//  2. paramKind === 'banana-ratio'
//     - POST /v1/images/generations (JSON) body: { model, prompt, aspect_ratio, image_size:'1K'|'2K'|'4K', image:[base64...]? }

// ========== 主项目 gpt-image-2-web 完整 GPT_SIZE_MAP(line 2173)==========
const GPT_SIZE_MAP = {
  '1:1_1k': '1024x1024', '1:1_2k': '2048x2048', '1:1_4k': '2880x2880',
  '3:2_1k': '1248x832',  '3:2_2k': '2496x1664', '3:2_4k': '3504x2336',
  '2:3_1k': '832x1248',  '2:3_2k': '1664x2496', '2:3_4k': '2336x3504',
  '4:3_1k': '1152x864',  '4:3_2k': '2304x1728', '4:3_4k': '3264x2448',
  '3:4_1k': '864x1152',  '3:4_2k': '1728x2304', '3:4_4k': '2448x3264',
  '5:4_1k': '1120x896',  '5:4_2k': '2240x1792', '5:4_4k': '3200x2560',
  '4:5_1k': '896x1120',  '4:5_2k': '1792x2240', '4:5_4k': '2560x3200',
  '16:9_1k': '1280x720', '16:9_2k': '2560x1440', '16:9_4k': '3840x2160',
  '9:16_1k': '720x1280', '9:16_2k': '1440x2560', '9:16_4k': '2160x3840',
  '2:1_1k': '2048x1024', '2:1_2k': '2688x1344', '2:1_4k': '3840x1920',
  '1:2_1k': '1024x2048', '1:2_2k': '1344x2688', '1:2_4k': '1920x3840',
  '21:9_1k': '1456x624', '21:9_2k': '3024x1296', '21:9_4k': '3696x1584',
  '9:21_1k': '624x1456', '9:21_2k': '1296x3024', '9:21_4k': '1584x3696',
};

// 将 (aspectRatio + sizeLevel) 用主项目 GPT_SIZE_MAP 映射成像素串;Auto 返 'auto'
function aspectToGptSize(aspectRatio, sizeLevel) {
  const ar = String(aspectRatio || '').trim();
  const lvl = String(sizeLevel || '1K').toLowerCase();
  const isAuto = !ar || ar === 'Auto' || ar === 'AUTO' || ar === 'empty';
  if (isAuto) return 'auto';
  const key = `${ar}_${lvl}`;
  return GPT_SIZE_MAP[key] || '1024x1024';
}

// 将 base64 dataURL / http(s) URL 转成 multipart Buffer
async function refToBuffer(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref.startsWith('data:')) {
    const m = ref.match(/^data:([^;,]+);base64,(.+)$/);
    if (!m) return null;
    const mime = m[1] || 'image/png';
    const buf = Buffer.from(m[2], 'base64');
    const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return { buf, mime, ext };
  }
  if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('/files/')) {
    // /files/* 是本地静态,走 127.0.0.1:18766
    const url = ref.startsWith('/') ? `http://127.0.0.1:${config.PORT}${ref}` : ref;
    const r = await fetch(url);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = (ct.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return { buf, mime: ct, ext };
  }
  return null;
}

// 将 base64/URL 参考图转成 banana 希望的 dataURL 或保留外部 URL
async function refToBananaImage(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref.startsWith('data:')) return ref;
  if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
  if (ref.startsWith('/files/')) {
    // 本地资源 → 转 base64
    try {
      const r = await fetch(`http://127.0.0.1:${config.PORT}${ref}`);
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await r.arrayBuffer());
      return `data:${ct};base64,${buf.toString('base64')}`;
    } catch { return null; }
  }
  return null;
}

// Grok Image 默认按 gpt-image-2-web 的 Base64 方式传参考图,最多 4 张。
async function refToGrokImage(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref.startsWith('data:')) return ref.startsWith('data:image') ? ref : null;
  if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('/files/')) {
    try {
      const url = ref.startsWith('/') ? `http://127.0.0.1:${config.PORT}${ref}` : ref;
      const r = await fetch(url);
      if (!r.ok) return ref.startsWith('http') ? ref : null;
      const ct = r.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await r.arrayBuffer());
      if (!String(ct).toLowerCase().startsWith('image/')) return null;
      return `data:${ct};base64,${buf.toString('base64')}`;
    } catch {
      // 外网图片转 base64 失败时保留 URL,避免破坏已有可公网访问的上游图。
      return ref.startsWith('http') ? ref : null;
    }
  }
  return null;
}

function isImageTaskString(s) {
  return /^[A-Za-z0-9_-]{8,256}$/.test(String(s || '').trim());
}

function imageTaskId(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  for (const k of ['task_id', 'id', 'request_id']) {
    if (result[k]) return String(result[k]);
  }
  const d = result.data;
  if (typeof d === 'string' && d.trim() && !/^https?:\/\//.test(d) && !d.startsWith('data:image')) return d.trim();
  if (d && typeof d === 'object') {
    for (const k of ['task_id', 'id', 'request_id']) {
      if (d[k]) return String(d[k]);
    }
  }
  return '';
}

function imageError(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.substring(0, 500);
  if (Array.isArray(result)) return JSON.stringify(result.slice(0, 3)).substring(0, 500);
  if (typeof result !== 'object') return '';
  for (const k of ['detail', 'fail_reason', 'error', 'message']) {
    const v = result[k];
    if (!v) continue;
    if (typeof v === 'string') return v.substring(0, 500);
    if (typeof v === 'object') return String(v.message || v.detail || JSON.stringify(v)).substring(0, 500);
  }
  const d = result.data;
  if (d && typeof d === 'object') {
    const nested = imageError(d);
    if (nested) return nested;
  }
  return '';
}

function imageApiFailed(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const code = String(result.code ?? '').toLowerCase();
  if (code && !['success', 'ok', '0', '200'].includes(code)) return true;
  if (result.detail || result.error) return true;
  return false;
}

function imageStatus(result) {
  if (!result || typeof result !== 'object') return '';
  for (const k of ['status', 'task_status', 'state']) {
    if (result[k]) return String(result[k]).toUpperCase();
  }
  const d = result.data;
  if (d && typeof d === 'object') {
    for (const k of ['status', 'task_status', 'state']) {
      if (d[k]) return String(d[k]).toUpperCase();
    }
  }
  return '';
}

function imageItems(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (typeof result === 'string') {
    const s = result.trim();
    return s && !isImageTaskString(s) ? [s] : [];
  }
  if (typeof result !== 'object') return [];
  if (result.url || result.image_url || result.b64_json || result.base64 || result.image_base64) return [result];
  for (const k of ['data', 'images', 'result', 'results', 'output', 'outputs', 'image', 'url']) {
    const v = result[k];
    if (!v) continue;
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s || isImageTaskString(s)) continue;
      return [s];
    }
    if (typeof v === 'object') {
      const nested = imageItems(v);
      if (nested.length) return nested;
    }
  }
  return [];
}

function normalizeImageItems(result) {
  return imageItems(result).map((item) => {
    if (typeof item === 'string') {
      return /^https?:\/\//.test(item) ? { url: item } : { b64_json: item.startsWith('data:image') ? item : item };
    }
    if (item && typeof item === 'object') {
      const url = item.url || item.image_url || (typeof item.image === 'string' && /^https?:\/\//.test(item.image) ? item.image : '');
      const b64 = item.b64_json || item.base64 || item.image_base64 || (!url && typeof item.image === 'string' ? item.image : '');
      if (url) return { url };
      if (b64) return { b64_json: b64 };
    }
    return null;
  }).filter(Boolean);
}

async function saveImageItemsFromResult(result) {
  const urls = [];
  for (const it of normalizeImageItems(result)) {
    if (it?.b64_json) {
      const u = saveBase64Image(it.b64_json);
      if (u) urls.push(u);
    } else if (it?.url) {
      const u = await saveRemoteImage(it.url);
      urls.push(u);
    }
  }
  return urls;
}

// LLM 多模态 image_url 预处理:
//   上游 LLM 服务(贞贞工坊)无法访问本地 /files/* 路径,需提前转成 base64 dataURL inline。
//   - data: 保留
//   - http(s):// 保留(上游可访问)
//   - /files/* → 本地拉 buffer 转 base64 dataURL
//   对齐 gpt-image-2-web chat 模式处理参考图的思路。
//   零破坏:对于 content 为字符串的普通文本消息不动;仅处理 content 为数组且含 image_url 部分。
async function normalizeLlmMessageImages(messages) {
  if (!Array.isArray(messages)) return messages;
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!part || part.type !== 'image_url' || !part.image_url) continue;
      const url = part.image_url.url;
      if (typeof url !== 'string' || !url) continue;
      // 已是 base64 或外网 URL→不动
      if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) continue;
      // 本地路径→转 base64 dataURL
      if (url.startsWith('/files/')) {
        const dataUrl = await refToBananaImage(url);
        if (dataUrl) {
          part.image_url.url = dataUrl;
        } else {
          // 转换失败:报一个明确错误,避免上游 'base64:/files/...' 这种误导报错
          throw new Error(`本地图片读取失败: ${url}`);
        }
      }
      // 其它未知前缀:保留原值,让上游报真错误
    }
  }
  return messages;
}

// ========================================================================
// 核心 helper:完全对齐主项目 gpt-image-2-web 的上游调用
//   - GPT2 始终走 multipart /v1/images/edits?async=true(line 2869)
//   - 文生图时用 1024x1024 白图占位(line 2861)
//   - GPT2 字段: prompt/model/n/quality/moderation/size(像素串)/aspectRatio(camelCase)/resolution(1k|2k|4k)
//   - nano-banana 文生图: JSON /generations?async=true { prompt, model, aspect_ratio, image_size }
//   - nano-banana 图生图: multipart /edits?async=true 添加 image 多个
//   - Grok Image: JSON /generations?async=true { model, prompt, aspect_ratio, image:[base64...]? }
// ========================================================================
async function callImageUpstreamAsync({ apiKey, finalApiModel, paramKind, prompt, n, aspect_ratio, image_size, refs, size, quality }) {
  const upstreamBase = `${config.ZHENZHEN_BASE_URL}/v1/images`;
  const auth = `Bearer ${apiKey}`;
  const ar = String(aspect_ratio || '').trim();
  const isAuto = !ar || ar === 'Auto' || ar === 'AUTO' || ar === 'empty';
  const lvlLower = String(image_size || '1K').toLowerCase();
  const lvlUpper = String(image_size || '2K').toUpperCase();
  const hasRefs = Array.isArray(refs) && refs.length > 0;

  // ===== Grok Image 路径(对齐 gpt-image-2-web Tab 12,默认参考图 Base64) =====
  if (paramKind === 'grok-image') {
    const grokRefs = [];
    if (hasRefs) {
      for (const ref of refs.slice(0, 4)) {
        const converted = await refToGrokImage(ref);
        if (converted) grokRefs.push(converted);
      }
    }
    const body = { model: finalApiModel, prompt, aspect_ratio: isAuto ? '1:1' : ar };
    if (grokRefs.length) body.image = grokRefs;
    const url = `${upstreamBase}/generations?async=true`;
    console.log('[upstream] Grok Image JSON → /generations?async=true model:', finalApiModel, 'aspect_ratio:', body.aspect_ratio, 'refs:', grokRefs.length);
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(body),
    });
  }

  // ===== GPT2 总走 multipart /edits?async=true(文生图加白图占位) =====
  if (paramKind === 'gpt-size') {
    const form = new FormData();
    const px = size || aspectToGptSize(ar, lvlLower);
    form.append('prompt', prompt);
    form.append('model', finalApiModel);
    form.append('n', String(n || 1));
    form.append('quality', quality || 'auto');
    form.append('moderation', 'auto');
    form.append('size', px);
    form.append('aspectRatio', isAuto ? '' : ar); // 主项目用 camelCase
    form.append('resolution', lvlLower);          // 主项目用小写 1k/2k/4k

    if (hasRefs) {
      for (let i = 0; i < refs.length; i++) {
        const conv = await refToBuffer(refs[i]);
        if (!conv) continue;
        const blob = new Blob([conv.buf], { type: conv.mime });
        form.append('image', blob, `image_${i}.${conv.ext}`);
      }
    } else {
      // 主项目 line 2861: 无参考图时创建 1024x1024 白图占位
      const whiteBuf = getWhitePng(1024, 1024);
      const blob = new Blob([whiteBuf], { type: 'image/png' });
      form.append('image', blob, 'blank.png');
    }

    const url = `${upstreamBase}/edits?async=true`;
    console.log('[upstream] GPT2 multipart → /edits?async=true model:', finalApiModel, 'size:', px, 'aspectRatio:', ar, 'resolution:', lvlLower, 'refs:', refs?.length || 0);
    return await fetch(url, { method: 'POST', headers: { Authorization: auth }, body: form });
  }

  // ===== nano-banana 路径 =====
  if (hasRefs) {
    // 图生图 → multipart /edits?async=true
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('model', finalApiModel);
    form.append('aspect_ratio', isAuto ? '1:1' : ar);
    form.append('image_size', lvlUpper);
    for (let i = 0; i < refs.length; i++) {
      const conv = await refToBuffer(refs[i]);
      if (!conv) continue;
      const blob = new Blob([conv.buf], { type: conv.mime });
      form.append('image', blob, `image_${i}.${conv.ext}`);
    }
    const url = `${upstreamBase}/edits?async=true`;
    console.log('[upstream] nano-banana multipart → /edits?async=true model:', finalApiModel, 'aspect_ratio:', ar, 'image_size:', lvlUpper, 'refs:', refs.length);
    return await fetch(url, { method: 'POST', headers: { Authorization: auth }, body: form });
  }
  // 文生图 → JSON /generations?async=true
  const body = { prompt, model: finalApiModel, aspect_ratio: isAuto ? '1:1' : ar };
  body.image_size = lvlUpper;
  const url = `${upstreamBase}/generations?async=true`;
  console.log('[upstream] nano-banana JSON → /generations?async=true model:', finalApiModel, 'aspect_ratio:', body.aspect_ratio, 'image_size:', body.image_size);
  return await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(body),
  });
}

// 将上游响应 normalize 为 { kind: 'sync'|'async', urls?, taskId? }
async function normalizeImageResponse(data) {
  if (imageApiFailed(data)) {
    return { kind: 'failed', error: imageError(data) || '上游图像 API 返回失败' };
  }
  const urls = await saveImageItemsFromResult(data);
  if (urls.length) return { kind: 'sync', urls };
  // 异步任务 task_id
  const taskId = imageTaskId(data);
  if (taskId) return { kind: 'async', taskId };
  return { kind: 'unknown' };
}

module.exports = {
  safeOutputExt,
  extFromContentType,
  inferRemoteOutputExt,
  loadRawSettings,
  pickApiKey,
  normalizeImageApiModel,
  gptImage2ZhenzhenVariantSize,
  isBananaImageModel,
  applyClassifiedKey,
  ensureKey,
  ensureDefaultZhenzhenKey,
  rememberTaskKey,
  recallTaskMeta,
  recallTaskKey,
  normalizeProviderParams,
  parseProviderParams,
  hasSelectedProviderGroup,
  ensureKeyOrSelectedGroup,
  applyZhenzhenProviderContext,
  isInvalidApiKeyError,
  invalidateZhenzhenProviderKey,
  saveRemoteImage,
  saveRemoteAudio,
  saveBase64Image,
  aspectToGptSize,
  refToBuffer,
  refToBananaImage,
  refToGrokImage,
  isImageTaskString,
  imageTaskId,
  imageError,
  imageApiFailed,
  imageStatus,
  imageItems,
  normalizeImageItems,
  saveImageItemsFromResult,
  normalizeLlmMessageImages,
  callImageUpstreamAsync,
  normalizeImageResponse,
  audioUpload,
  taskKeyMap,
  GPT_SIZE_MAP
};
