/**
 * 图像处理操作 - 基于 sharp
 * 路由前缀: /api/image
 * 输入图像统一通过 imageUrl(本地 /files/output 或 /files/input)
 * 输出存到 /output 并返回本地 URL
 */
const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const config = require('../config');

const router = express.Router();

// 把本地 URL 解析为绝对路径
function resolveLocalUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('/files/output/')) return path.join(config.OUTPUT_DIR, url.replace('/files/output/', ''));
  if (url.startsWith('/files/input/')) return path.join(config.INPUT_DIR, url.replace('/files/input/', ''));
  if (url.startsWith('/output/')) return path.join(config.OUTPUT_DIR, url.replace('/output/', ''));
  if (url.startsWith('/input/')) return path.join(config.INPUT_DIR, url.replace('/input/', ''));
  return null;
}

// 下载远端图像到 buffer
async function fetchImageBuffer(url) {
  const local = resolveLocalUrl(url);
  if (local && fs.existsSync(local)) return fs.readFileSync(local);
  if (url && /^https?:/i.test(url)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`下载失败: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  if (url && url.startsWith('data:image/')) {
    const m = url.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
    if (m) return Buffer.from(m[1], 'base64');
  }
  throw new Error('无法解析图像源');
}

function saveBuffer(buf, ext = 'png') {
  const filename = `op_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const filePath = path.join(config.OUTPUT_DIR, filename);
  fs.writeFileSync(filePath, buf);
  return `/files/output/${filename}`;
}

// 异步保存 (不阻塞 event loop, grid-crop 并发场景必需)
async function saveBufferAsync(buf, ext = 'png') {
  const filename = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filePath = path.join(config.OUTPUT_DIR, filename);
  await fsp.writeFile(filePath, buf);
  return `/files/output/${filename}`;
}

// 根据 meta.format 选输出格式, 避免全部重编为 PNG (高压缩低速).
// 返回 { ext, encode(pipe) } 供调用者接上 sharp pipe.
function chooseEncoder(meta) {
  const fmt = (meta && meta.format) || 'png';
  if (fmt === 'jpeg' || fmt === 'jpg') {
    return {
      ext: 'jpg',
      encode: (p) => p.jpeg({ quality: 92, mozjpeg: false }),
    };
  }
  if (fmt === 'webp') {
    return { ext: 'webp', encode: (p) => p.webp({ quality: 92, effort: 1 }) };
  }
  // PNG 在低压缩 + 低 effort 下可提速 5-10x
  return {
    ext: 'png',
    encode: (p) => p.png({ compressionLevel: 3, effort: 1 }),
  };
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeCompareMode(v) {
  const s = String(v || 'slider');
  if (s === 'checker') return 'focus';
  if (['slider', 'side-by-side', 'overlay', 'blink', 'heatmap', 'focus'].includes(s)) return s;
  return 'slider';
}

function normalizeAlign(v) {
  const s = String(v || 'contain');
  if (s === 'cover' || s === 'fill' || s === 'contain') return s;
  return 'contain';
}

async function normalizeForCompare(buffer, width, height, align) {
  return sharp(buffer)
    .resize(width, height, {
      fit: align,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function rawRgba(pngBuffer, width, height) {
  return sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: false });
}

function computeCompareMetrics(rawA, rawB, width, height, threshold) {
  let sum = 0;
  let max = 0;
  let changed = 0;
  const px = width * height;
  for (let i = 0; i < rawA.length; i += 4) {
    const diff = (
      Math.abs(rawA[i] - rawB[i]) +
      Math.abs(rawA[i + 1] - rawB[i + 1]) +
      Math.abs(rawA[i + 2] - rawB[i + 2])
    ) / 3;
    sum += diff;
    if (diff > max) max = diff;
    if (diff >= threshold) changed += 1;
  }
  return {
    meanDiff: px ? Number((sum / px).toFixed(2)) : 0,
    maxDiff: Number(max.toFixed(2)),
    changedRatio: px ? Number((changed / px).toFixed(4)) : 0,
  };
}

function blendOverlay(rawA, rawB, opacity) {
  const out = Buffer.alloc(rawA.length);
  const o = Math.max(0, Math.min(1, opacity));
  for (let i = 0; i < rawA.length; i += 4) {
    out[i] = Math.round(rawA[i] * (1 - o) + rawB[i] * o);
    out[i + 1] = Math.round(rawA[i + 1] * (1 - o) + rawB[i + 1] * o);
    out[i + 2] = Math.round(rawA[i + 2] * (1 - o) + rawB[i + 2] * o);
    out[i + 3] = 255;
  }
  return out;
}

function makeHeatmap(rawA, rawB, threshold) {
  const out = Buffer.alloc(rawA.length);
  for (let i = 0; i < rawA.length; i += 4) {
    const diff = (
      Math.abs(rawA[i] - rawB[i]) +
      Math.abs(rawA[i + 1] - rawB[i + 1]) +
      Math.abs(rawA[i + 2] - rawB[i + 2])
    ) / 3;
    const intensity = Math.max(0, Math.min(1, (diff - threshold) / Math.max(1, 255 - threshold)));
    const mix = diff < threshold ? 0 : Math.max(0.3, intensity * 0.82);
    const heatR = 255;
    const heatG = Math.round(232 * (1 - intensity) + 48 * intensity);
    const heatB = Math.round(60 * (1 - intensity));
    const base = diff < threshold ? 0.86 : 0.62;
    out[i] = Math.round(rawA[i] * base * (1 - mix) + heatR * mix);
    out[i + 1] = Math.round(rawA[i + 1] * base * (1 - mix) + heatG * mix);
    out[i + 2] = Math.round(rawA[i + 2] * base * (1 - mix) + heatB * mix);
    out[i + 3] = 255;
  }
  return out;
}

function makeFocus(rawA, rawB, threshold) {
  const out = Buffer.alloc(rawA.length);
  for (let i = 0; i < rawA.length; i += 4) {
    const diff = (
      Math.abs(rawA[i] - rawB[i]) +
      Math.abs(rawA[i + 1] - rawB[i + 1]) +
      Math.abs(rawA[i + 2] - rawB[i + 2])
    ) / 3;
    const intensity = Math.max(0, Math.min(1, (diff - threshold) / Math.max(1, 255 - threshold)));
    if (diff < threshold) {
      const gray = rawA[i] * 0.299 + rawA[i + 1] * 0.587 + rawA[i + 2] * 0.114;
      out[i] = Math.round(gray * 0.58);
      out[i + 1] = Math.round(gray * 0.58);
      out[i + 2] = Math.round(gray * 0.58);
    } else {
      const mix = Math.max(0.18, intensity * 0.36);
      out[i] = Math.round(rawB[i] * (1 - mix) + 255 * mix);
      out[i + 1] = Math.round(rawB[i + 1] * (1 - mix) + 148 * mix);
      out[i + 2] = Math.round(rawB[i + 2] * (1 - mix) + 36 * mix);
    }
    out[i + 3] = 255;
  }
  return out;
}

// ========== POST /api/image/resize — 尺寸调整 ==========
// body: { imageUrl, width, height, fit? }
router.post('/resize', async (req, res) => {
  try {
    const { imageUrl, width, height, fit } = req.body || {};
    if (!imageUrl) return res.status(400).json({ success: false, error: 'imageUrl 必填' });
    const buf = await fetchImageBuffer(imageUrl);
    const out = await sharp(buf)
      .resize(width || null, height || null, { fit: fit || 'inside' })
      .png()
      .toBuffer();
    res.json({ success: true, data: { imageUrl: saveBuffer(out, 'png') } });
  } catch (e) {
    console.error('resize 错误:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== POST /api/image/upscale — 简单放大(线性 2x/3x/4x) ==========
// body: { imageUrl, scale }
router.post('/upscale', async (req, res) => {
  try {
    const { imageUrl, scale } = req.body || {};
    if (!imageUrl) return res.status(400).json({ success: false, error: 'imageUrl 必填' });
    const s = Math.max(1, Math.min(8, parseFloat(scale) || 2));
    const buf = await fetchImageBuffer(imageUrl);
    const meta = await sharp(buf).metadata();
    const out = await sharp(buf)
      .resize(Math.round((meta.width || 1024) * s), Math.round((meta.height || 1024) * s), { kernel: 'lanczos3' })
      .png()
      .toBuffer();
    res.json({ success: true, data: { imageUrl: saveBuffer(out, 'png'), scale: s } });
  } catch (e) {
    console.error('upscale 错误:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== POST /api/image/crop — 精确裁剪 (在 OutputNode 双击编辑用) ==========
// body: { imageUrl, x, y, w, h }  坐标均为原图 natural 像素
router.post('/crop', async (req, res) => {
  try {
    const { imageUrl, x, y, w, h } = req.body || {};
    if (!imageUrl) return res.status(400).json({ success: false, error: 'imageUrl 必填' });
    const X = Math.max(0, parseInt(x) || 0);
    const Y = Math.max(0, parseInt(y) || 0);
    const W = Math.max(1, parseInt(w) || 0);
    const H = Math.max(1, parseInt(h) || 0);
    const buf = await fetchImageBuffer(imageUrl);
    const meta = await sharp(buf).metadata();
    const maxW = (meta.width || 0) - X;
    const maxH = (meta.height || 0) - Y;
    const cw = Math.min(W, Math.max(1, maxW));
    const ch = Math.min(H, Math.max(1, maxH));
    const enc = chooseEncoder(meta);
    const out = await enc
      .encode(sharp(buf).extract({ left: X, top: Y, width: cw, height: ch }))
      .toBuffer();
    const url = await saveBufferAsync(out, enc.ext);
    res.json({ success: true, data: { imageUrl: url } });
  } catch (e) {
    console.error('crop 错误:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== POST /api/image/grid-crop — 九宫格切图 ==========
// body:
//   等分模式: { imageUrl, rows?, cols?, gap? }
//   自定义橩矩形模式: { imageUrl, rectsPx: [{x,y,w,h,row?,col?}] } 优先
router.post('/grid-crop', async (req, res) => {
  try {
    const { imageUrl, rows, cols, gap, rectsPx } = req.body || {};
    if (!imageUrl) return res.status(400).json({ success: false, error: 'imageUrl 必填' });
    const buf = await fetchImageBuffer(imageUrl);
    const meta = await sharp(buf).metadata();
    const W = meta.width || 0,
      H = meta.height || 0;
    if (!W || !H) throw new Error('无法读取图像尺寸');

    let outRects = [];
    let layoutRows = 1;
    let layoutCols = 1;
    let layoutGap = 0;

    // ---- 分支 A: 使用外部计算好的矩形 (自定义切线场景) ----
    if (Array.isArray(rectsPx) && rectsPx.length > 0) {
      outRects = rectsPx
        .map((r) => ({
          x: Math.max(0, parseInt(r.x) || 0),
          y: Math.max(0, parseInt(r.y) || 0),
          w: Math.max(1, parseInt(r.w) || 0),
          h: Math.max(1, parseInt(r.h) || 0),
          row: parseInt(r.row) || 0,
          col: parseInt(r.col) || 0,
        }))
        .filter((r) => r.x + r.w <= W && r.y + r.h <= H);
      layoutRows = Math.max(1, ...outRects.map((r) => r.row + 1));
      layoutCols = Math.max(1, ...outRects.map((r) => r.col + 1));
      layoutGap = Math.max(0, parseInt(gap) || 0);
    } else {
      // ---- 分支 B: 等分模式, 可传 gap 收缩内部边缘 ----
      const r = Math.max(1, Math.min(20, parseInt(rows) || 3));
      const c = Math.max(1, Math.min(20, parseInt(cols) || 3));
      const G = Math.max(0, Math.min(240, parseInt(gap) || 0));
      const halfGap = G / 2;
      for (let row = 0; row < r; row++) {
        const topLine = (row * H) / r;
        const bottomLine = ((row + 1) * H) / r;
        const y1 = Math.round(row === 0 ? 0 : topLine + halfGap);
        const y2 = Math.round(row === r - 1 ? H : bottomLine - halfGap);
        for (let col = 0; col < c; col++) {
          const leftLine = (col * W) / c;
          const rightLine = ((col + 1) * W) / c;
          const x1 = Math.round(col === 0 ? 0 : leftLine + halfGap);
          const x2 = Math.round(col === c - 1 ? W : rightLine - halfGap);
          if (x2 > x1 && y2 > y1) {
            outRects.push({ row, col, x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
          }
        }
      }
      layoutRows = r;
      layoutCols = c;
      layoutGap = G;
    }

    if (outRects.length === 0) {
      return res.status(400).json({ success: false, error: '无有效切割矩形' });
    }

    const enc = chooseEncoder(meta);
    // 并发切割 + 并发保存, 显著提速 (N=9 时以往 ~9x 串行)
    const tiles = await Promise.all(
      outRects.map((rect) =>
        enc
          .encode(
            sharp(buf).extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }),
          )
          .toBuffer(),
      ),
    );
    const urls = await Promise.all(tiles.map((t) => saveBufferAsync(t, enc.ext)));
    res.json({
      success: true,
      data: {
        urls,
        rows: layoutRows,
        cols: layoutCols,
        gap: layoutGap,
        layout: { rows: layoutRows, cols: layoutCols, gap: layoutGap },
      },
    });
  } catch (e) {
    console.error('grid-crop 错误:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== POST /api/image/combine — 横向/纵向拼接 ==========
// body: { imageUrls: [], direction: 'horizontal'|'vertical' }
router.post('/combine', async (req, res) => {
  try {
    const { imageUrls, direction } = req.body || {};
    if (!Array.isArray(imageUrls) || imageUrls.length < 2) {
      return res.status(400).json({ success: false, error: '至少需要 2 张图像' });
    }
    const dir = direction === 'vertical' ? 'vertical' : 'horizontal';
    const buffers = [];
    for (const u of imageUrls) buffers.push(await fetchImageBuffer(u));
    const metas = await Promise.all(buffers.map((b) => sharp(b).metadata()));

    let W, H, composites;
    if (dir === 'horizontal') {
      H = Math.max(...metas.map((m) => m.height || 0));
      // 等比缩放至同高
      const scaled = await Promise.all(buffers.map((b, i) => {
        const m = metas[i];
        const w = Math.round(((m.width || 1) * H) / (m.height || 1));
        return sharp(b).resize(w, H).png().toBuffer().then((buf) => ({ buf, w }));
      }));
      W = scaled.reduce((s, x) => s + x.w, 0);
      composites = [];
      let off = 0;
      for (const { buf, w } of scaled) {
        composites.push({ input: buf, left: off, top: 0 });
        off += w;
      }
    } else {
      W = Math.max(...metas.map((m) => m.width || 0));
      const scaled = await Promise.all(buffers.map((b, i) => {
        const m = metas[i];
        const h = Math.round(((m.height || 1) * W) / (m.width || 1));
        return sharp(b).resize(W, h).png().toBuffer().then((buf) => ({ buf, h }));
      }));
      H = scaled.reduce((s, x) => s + x.h, 0);
      composites = [];
      let off = 0;
      for (const { buf, h } of scaled) {
        composites.push({ input: buf, left: 0, top: off });
        off += h;
      }
    }

    const out = await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite(composites)
      .png()
      .toBuffer();
    res.json({ success: true, data: { imageUrl: saveBuffer(out, 'png') } });
  } catch (e) {
    console.error('combine 错误:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== POST /api/image/compare — 图像对比 ==========
// body: { imageAUrl, imageBUrl, mode, align?, split?, opacity?, threshold? }
router.post('/compare', async (req, res) => {
  try {
    const {
      imageAUrl,
      imageBUrl,
      mode,
      align,
      split,
      opacity,
      threshold,
    } = req.body || {};
    if (!imageAUrl || !imageBUrl) {
      return res.status(400).json({ success: false, error: 'imageAUrl / imageBUrl 必填' });
    }

    const outMode = normalizeCompareMode(mode);
    const fit = normalizeAlign(align);
    const splitPct = clampNumber(split, 0, 100, 50);
    const opacityPct = clampNumber(opacity, 0, 100, 50) / 100;
    const thresholdValue = clampNumber(threshold, 0, 255, 24);

    const [bufA, bufB] = await Promise.all([
      fetchImageBuffer(imageAUrl),
      fetchImageBuffer(imageBUrl),
    ]);
    const [metaA, metaB] = await Promise.all([
      sharp(bufA).metadata(),
      sharp(bufB).metadata(),
    ]);
    const width = metaA.width || 0;
    const height = metaA.height || 0;
    if (!width || !height) throw new Error('无法读取原图尺寸');

    const [pngA, pngB] = await Promise.all([
      normalizeForCompare(bufA, width, height, 'fill'),
      normalizeForCompare(bufB, width, height, fit),
    ]);
    const [rawA, rawB] = await Promise.all([
      rawRgba(pngA, width, height),
      rawRgba(pngB, width, height),
    ]);
    const metrics = {
      width,
      height,
      imageA: { width: metaA.width || 0, height: metaA.height || 0 },
      imageB: { width: metaB.width || 0, height: metaB.height || 0 },
      threshold: thresholdValue,
      ...computeCompareMetrics(rawA, rawB, width, height, thresholdValue),
    };

    let out;
    if (outMode === 'side-by-side' || outMode === 'blink') {
      const gap = 16;
      out = await sharp({
        create: {
          width: width * 2 + gap,
          height,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite([
          { input: pngA, left: 0, top: 0 },
          { input: pngB, left: width + gap, top: 0 },
        ])
        .png({ compressionLevel: 3, effort: 1 })
        .toBuffer();
    } else if (outMode === 'overlay') {
      const raw = blendOverlay(rawA, rawB, opacityPct);
      out = await sharp(raw, { raw: { width, height, channels: 4 } })
        .png({ compressionLevel: 3, effort: 1 })
        .toBuffer();
    } else if (outMode === 'heatmap') {
      const raw = makeHeatmap(rawA, rawB, thresholdValue);
      out = await sharp(raw, { raw: { width, height, channels: 4 } })
        .png({ compressionLevel: 3, effort: 1 })
        .toBuffer();
    } else if (outMode === 'focus') {
      const raw = makeFocus(rawA, rawB, thresholdValue);
      out = await sharp(raw, { raw: { width, height, channels: 4 } })
        .png({ compressionLevel: 3, effort: 1 })
        .toBuffer();
    } else {
      const clipW = Math.max(1, Math.min(width, Math.round(width * splitPct / 100)));
      const clippedB = await sharp(pngB)
        .extract({ left: 0, top: 0, width: clipW, height })
        .png({ compressionLevel: 3, effort: 1 })
        .toBuffer();
      const lineX = Math.max(0, Math.min(width - 2, clipW - 1));
      const lineSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="${height}" viewBox="0 0 4 ${height}"><rect x="1" y="0" width="2" height="${height}" fill="#fb923c"/><rect x="0" y="0" width="4" height="${height}" fill="none" stroke="#ffffff" stroke-opacity=".85" stroke-width="1"/></svg>`
      );
      out = await sharp(pngA)
        .composite([
          { input: clippedB, left: 0, top: 0 },
          { input: lineSvg, left: lineX, top: 0 },
        ])
        .png({ compressionLevel: 3, effort: 1 })
        .toBuffer();
    }

    const imageUrl = await saveBufferAsync(out, 'png');
    res.json({ success: true, data: { imageUrl, metrics } });
  } catch (e) {
    console.error('compare 错误:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== POST /api/image/remove-bg — 抠图(占位:返回原图) ==========
// 真实抠图通常需要 RH 工作流或 AI 模型,Phase 4 接入
router.post('/remove-bg', async (req, res) => {
  try {
    const { imageUrl } = req.body || {};
    if (!imageUrl) return res.status(400).json({ success: false, error: 'imageUrl 必填' });
    // 简易实现:转 PNG(保留 alpha),不做真实背景去除
    const buf = await fetchImageBuffer(imageUrl);
    const out = await sharp(buf).png().toBuffer();
    res.json({
      success: true,
      data: {
        imageUrl: saveBuffer(out, 'png'),
        warning: '当前为占位实现,真实抠图需 RH 工作流或 AI 模型',
      },
    });
  } catch (e) {
    console.error('remove-bg 错误:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
