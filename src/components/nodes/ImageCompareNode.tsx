import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Handle, Position, useNodeConnections, useNodesData, type NodeProps } from '@xyflow/react';
import { AlertCircle, GitCompare, Loader2, Sparkles } from 'lucide-react';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { useHasAutoOutput } from './useHasAutoOutput';
import { opCompare, uploadDataUrl } from '../../services/imageOps';

/**
 * ImageCompareNode - 图像对比
 *
 * 默认连接 2 张图后直接在节点内预览；点击运行时由后端生成一张静态对比结果图，
 * 写入 data.imageUrl，继续交给下游 OutputNode / 资源库 / 导出链路使用。
 */
const COLOR = '#fb923c';

type CompareMode = 'slider' | 'side-by-side' | 'overlay' | 'blink' | 'heatmap' | 'focus';
type AlignMode = 'contain' | 'cover' | 'fill';

interface CompareStats {
  imageA: { width: number; height: number };
  imageB: { width: number; height: number };
  meanDiff?: number;
  changedRatio?: number;
  maxDiff?: number;
}

const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i;
const AUDIO_RE = /\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/i;

const MODE_OPTIONS: Array<{ value: CompareMode; label: string; short: string }> = [
  { value: 'slider', label: '滑杆对比', short: '滑杆' },
  { value: 'side-by-side', label: '并排对比', short: '并排' },
  { value: 'overlay', label: '透明叠加', short: '叠加' },
  { value: 'blink', label: '闪烁对比', short: '闪烁' },
  { value: 'heatmap', label: '差异热力图', short: '热力' },
  { value: 'focus', label: '差异聚焦', short: '聚焦' },
];

const ALIGN_OPTIONS: Array<{ value: AlignMode; label: string }> = [
  { value: 'contain', label: '完整适配' },
  { value: 'cover', label: '裁剪铺满' },
  { value: 'fill', label: '拉伸对齐' },
];

function isImageLikeUrl(url: string): boolean {
  if (!url) return false;
  if (AUDIO_RE.test(url) || VIDEO_RE.test(url)) return false;
  return true;
}

function pushImage(out: string[], value: any) {
  if (typeof value !== 'string') return;
  const s = value.trim();
  if (!s || !isImageLikeUrl(s) || out.includes(s)) return;
  out.push(s);
}

function extractImages(data: any, sourceHandle?: string | null): string[] {
  const out: string[] = [];
  if (!data) return out;

  const isFramePair =
    Object.prototype.hasOwnProperty.call(data, 'firstFrameUrl') &&
    Object.prototype.hasOwnProperty.call(data, 'lastFrameUrl');
  if (isFramePair) {
    if (sourceHandle === 'last') {
      pushImage(out, data.lastFrameUrl);
      return out;
    }
    if (sourceHandle === 'first') {
      pushImage(out, data.firstFrameUrl);
      return out;
    }
    pushImage(out, data.firstFrameUrl);
    pushImage(out, data.lastFrameUrl);
    return out;
  }

  pushImage(out, data.imageUrl);
  for (const field of ['imageUrls', 'urls', 'generatedImages']) {
    const v = data[field];
    if (Array.isArray(v)) v.forEach((u) => pushImage(out, u));
  }
  return out;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图像读取失败'));
    img.src = url;
  });
}

function drawAligned(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  width: number,
  height: number,
  align: AlignMode,
) {
  if (align === 'fill') {
    ctx.drawImage(img, 0, 0, width, height);
    return;
  }
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const scale = align === 'cover'
    ? Math.max(width / iw, height / ih)
    : Math.min(width / iw, height / ih);
  const w = iw * scale;
  const h = ih * scale;
  ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
}

function drawDiffPixels(
  rawA: Uint8ClampedArray,
  rawB: Uint8ClampedArray,
  threshold: number,
  variant: 'heatmap' | 'focus',
) {
  const out = new Uint8ClampedArray(rawA.length);
  for (let i = 0; i < rawA.length; i += 4) {
    const diff = (
      Math.abs(rawA[i] - rawB[i]) +
      Math.abs(rawA[i + 1] - rawB[i + 1]) +
      Math.abs(rawA[i + 2] - rawB[i + 2])
    ) / 3;
    const t = Math.max(0, Math.min(1, (diff - threshold) / Math.max(1, 255 - threshold)));

    if (variant === 'focus') {
      if (diff < threshold) {
        const gray = rawA[i] * 0.299 + rawA[i + 1] * 0.587 + rawA[i + 2] * 0.114;
        out[i] = gray * 0.58;
        out[i + 1] = gray * 0.58;
        out[i + 2] = gray * 0.58;
      } else {
        const mix = Math.max(0.18, t * 0.36);
        out[i] = rawB[i] * (1 - mix) + 255 * mix;
        out[i + 1] = rawB[i + 1] * (1 - mix) + 148 * mix;
        out[i + 2] = rawB[i + 2] * (1 - mix) + 36 * mix;
      }
      out[i + 3] = 255;
      continue;
    }

    const mix = diff < threshold ? 0 : Math.max(0.3, t * 0.82);
    const heatR = 255;
    const heatG = Math.round(232 * (1 - t) + 48 * t);
    const heatB = Math.round(60 * (1 - t));
    const base = diff < threshold ? 0.86 : 0.62;
    out[i] = rawA[i] * base * (1 - mix) + heatR * mix;
    out[i + 1] = rawA[i + 1] * base * (1 - mix) + heatG * mix;
    out[i + 2] = rawA[i + 2] * base * (1 - mix) + heatB * mix;
    out[i + 3] = 255;
  }
  return out;
}

function DiffCanvasPreview(props: {
  before: string;
  after: string;
  align: AlignMode;
  threshold: number;
  variant: 'heatmap' | 'focus';
}) {
  const { before, after, align, threshold, variant } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadImage(before), loadImage(after)])
      .then(([a, b]) => {
        if (cancelled) return;
        const baseW = a.naturalWidth || a.width || 1;
        const baseH = a.naturalHeight || a.height || 1;
        const scale = Math.min(720 / baseW, 420 / baseH, 1);
        const w = Math.max(80, Math.round(baseW * scale));
        const h = Math.max(80, Math.round(baseH * scale));
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, w, h);
        drawAligned(ctx, a, w, h, 'fill');
        const imgA = ctx.getImageData(0, 0, w, h);
        ctx.clearRect(0, 0, w, h);
        drawAligned(ctx, b, w, h, align);
        const imgB = ctx.getImageData(0, 0, w, h);
        const out = new ImageData(drawDiffPixels(imgA.data, imgB.data, threshold, variant), w, h);
        ctx.putImageData(out, 0, 0);
      })
      .catch(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (canvas && ctx) {
          canvas.width = 640;
          canvas.height = 360;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [align, after, before, threshold, variant]);

  return <canvas ref={canvasRef} className="block h-full w-full rounded-lg object-contain" />;
}

async function drawAlignedToImageData(
  img: HTMLImageElement,
  width: number,
  height: number,
  align: AlignMode,
) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 不可用');
  ctx.clearRect(0, 0, width, height);
  drawAligned(ctx, img, width, height, align);
  return { canvas, ctx, imageData: ctx.getImageData(0, 0, width, height) };
}

async function renderCompareDataUrl(args: {
  before: string;
  after: string;
  mode: CompareMode;
  align: AlignMode;
  split: number;
  opacity: number;
  threshold: number;
}) {
  const { before, after, mode, align, split, opacity, threshold } = args;
  const [a, b] = await Promise.all([loadImage(before), loadImage(after)]);
  const width = a.naturalWidth || a.width || 1;
  const height = a.naturalHeight || a.height || 1;
  const { canvas: canvasA, ctx: ctxA, imageData: dataA } = await drawAlignedToImageData(a, width, height, 'fill');
  const { canvas: canvasB, imageData: dataB } = await drawAlignedToImageData(b, width, height, align);

  if (mode === 'side-by-side' || mode === 'blink') {
    const gap = 16;
    const out = document.createElement('canvas');
    out.width = width * 2 + gap;
    out.height = height;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('canvas 不可用');
    ctx.drawImage(canvasA, 0, 0);
    ctx.drawImage(canvasB, width + gap, 0);
    return out.toDataURL('image/png');
  }

  if (mode === 'overlay') {
    ctxA.save();
    ctxA.globalAlpha = Math.max(0, Math.min(1, opacity / 100));
    ctxA.drawImage(canvasB, 0, 0);
    ctxA.restore();
    return canvasA.toDataURL('image/png');
  }

  if (mode === 'heatmap' || mode === 'focus') {
    const raw = drawDiffPixels(dataA.data, dataB.data, threshold, mode);
    ctxA.putImageData(new ImageData(raw, width, height), 0, 0);
    return canvasA.toDataURL('image/png');
  }

  const clipW = Math.max(1, Math.min(width, Math.round(width * split / 100)));
  ctxA.save();
  ctxA.beginPath();
  ctxA.rect(0, 0, clipW, height);
  ctxA.clip();
  ctxA.drawImage(canvasB, 0, 0);
  ctxA.restore();
  ctxA.fillStyle = '#fb923c';
  ctxA.fillRect(Math.max(0, clipW - 1), 0, 2, height);
  return canvasA.toDataURL('image/png');
}

const ImageCompareNode = (p: NodeProps) => {
  const update = useUpdateNodeData(p.id);
  const hasAutoOutput = useHasAutoOutput(p.id);
  const conns = useNodeConnections({ id: p.id, handleType: 'target' });
  const upstreamIds = useMemo(() => Array.from(new Set(conns.map((c) => c.source))), [conns]);
  const upstreamNodes = useNodesData(upstreamIds);
  const d = (p.data as any) || {};

  const mode: CompareMode = d.mode === 'checker' ? 'focus' : (d.mode || 'slider');
  const align: AlignMode = d.align || 'contain';
  const split = Math.max(0, Math.min(100, Number(d.split ?? 50)));
  const opacity = Math.max(0, Math.min(100, Number(d.opacity ?? 50)));
  const threshold = Math.max(0, Math.min(255, Number(d.threshold ?? 24)));
  const status: 'idle' | 'running' | 'success' | 'error' = d.status || 'idle';
  const outputUrl: string = d.imageUrl || '';

  const [error, setError] = useState<string | null>(d.error || null);
  const [stats, setStats] = useState<CompareStats | null>(null);
  const [blinkOn, setBlinkOn] = useState(false);

  const upstreamSig = useMemo(() => {
    const list = Array.isArray(upstreamNodes) ? upstreamNodes : [];
    return list
      .map((n: any) => {
        const ud = n?.data || {};
        return [
          n?.id || '',
          ud.imageUrl || '',
          Array.isArray(ud.imageUrls) ? ud.imageUrls.join(',') : '',
          Array.isArray(ud.urls) ? ud.urls.join(',') : '',
          Array.isArray(ud.generatedImages) ? ud.generatedImages.join(',') : '',
          ud.firstFrameUrl || '',
          ud.lastFrameUrl || '',
        ].join('§');
      })
      .join('|');
  }, [upstreamNodes]);

  const pair = useMemo(() => {
    const nodeMap = new Map<string, any>();
    const list = Array.isArray(upstreamNodes) ? upstreamNodes : [];
    for (const n of list as any[]) nodeMap.set(n.id, n);

    const aCandidates: string[] = [];
    const bCandidates: string[] = [];
    const autoCandidates: string[] = [];
    const allCandidates: string[] = [];

    for (const c of conns as any[]) {
      const n = nodeMap.get(c.source);
      const imgs = extractImages(n?.data, c.sourceHandle ?? null);
      for (const img of imgs) {
        if (!allCandidates.includes(img)) allCandidates.push(img);
        if (c.targetHandle === 'a') {
          if (!aCandidates.includes(img)) aCandidates.push(img);
        } else if (c.targetHandle === 'b') {
          if (!bCandidates.includes(img)) bCandidates.push(img);
        } else if (!autoCandidates.includes(img)) {
          autoCandidates.push(img);
        }
      }
    }

    const before = aCandidates[0] || autoCandidates[0] || allCandidates[0] || '';
    const after =
      bCandidates[0] ||
      autoCandidates.find((u) => u !== before) ||
      allCandidates.find((u) => u !== before) ||
      '';
    return { before, after, count: allCandidates.length };
  }, [conns, upstreamNodes, upstreamSig]);

  const before = pair.before;
  const after = pair.after;
  const hasPair = !!before && !!after;

  useEffect(() => {
    if (mode !== 'blink') {
      setBlinkOn(false);
      return;
    }
    const timer = window.setInterval(() => setBlinkOn((v) => !v), 650);
    return () => window.clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    let cancelled = false;
    if (!hasPair) {
      setStats(null);
      return;
    }
    Promise.all([loadImage(before), loadImage(after)])
      .then(([a, b]) => {
        if (cancelled) return;
        const baseW = a.naturalWidth || a.width || 1;
        const baseH = a.naturalHeight || a.height || 1;
        const sampleScale = Math.min(192 / baseW, 192 / baseH, 1);
        const sampleW = Math.max(24, Math.round(baseW * sampleScale));
        const sampleH = Math.max(24, Math.round(baseH * sampleScale));
        const canvas = document.createElement('canvas');
        canvas.width = sampleW;
        canvas.height = sampleH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setStats({
            imageA: { width: baseW, height: baseH },
            imageB: { width: b.naturalWidth || b.width || 1, height: b.naturalHeight || b.height || 1 },
          });
          return;
        }
        ctx.clearRect(0, 0, sampleW, sampleH);
        drawAligned(ctx, a, sampleW, sampleH, 'fill');
        const dataA = ctx.getImageData(0, 0, sampleW, sampleH).data;
        ctx.clearRect(0, 0, sampleW, sampleH);
        drawAligned(ctx, b, sampleW, sampleH, align);
        const dataB = ctx.getImageData(0, 0, sampleW, sampleH).data;
        let sum = 0;
        let max = 0;
        let changed = 0;
        const px = sampleW * sampleH;
        for (let i = 0; i < dataA.length; i += 4) {
          const diff = (
            Math.abs(dataA[i] - dataB[i]) +
            Math.abs(dataA[i + 1] - dataB[i + 1]) +
            Math.abs(dataA[i + 2] - dataB[i + 2])
          ) / 3;
          sum += diff;
          if (diff > max) max = diff;
          if (diff >= threshold) changed += 1;
        }
        setStats({
          imageA: { width: baseW, height: baseH },
          imageB: { width: b.naturalWidth || b.width || 1, height: b.naturalHeight || b.height || 1 },
          meanDiff: sum / px,
          maxDiff: max,
          changedRatio: changed / px,
        });
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [before, after, align, threshold, hasPair]);

  const handleRun = useCallback(async () => {
    setError(null);
    if (!before || !after) {
      const msg = '请连接 2 张上游图像';
      setError(msg);
      update({ status: 'error', error: msg });
      return;
    }
    update({ status: 'running', error: null });
    try {
      let r: Awaited<ReturnType<typeof opCompare>>;
      try {
        r = await opCompare(before, after, mode, {
          align,
          split,
          opacity,
          threshold,
        });
      } catch (backendError) {
        const dataUrl = await renderCompareDataUrl({ before, after, mode, align, split, opacity, threshold });
        const imageUrl = await uploadDataUrl(dataUrl, 'compare');
        r = {
          imageUrl,
          metrics: {
            width: stats?.imageA.width || 0,
            height: stats?.imageA.height || 0,
            imageA: stats?.imageA || { width: 0, height: 0 },
            imageB: stats?.imageB || { width: 0, height: 0 },
            meanDiff: stats?.meanDiff || 0,
            maxDiff: stats?.maxDiff || 0,
            changedRatio: stats?.changedRatio || 0,
            threshold,
          },
        };
        console.warn('[image-compare] fallback to browser canvas:', backendError);
      }
      update({
        status: 'success',
        imageUrl: r.imageUrl,
        compareMetrics: r.metrics,
        error: null,
      });
    } catch (e: any) {
      const msg = e?.message || '生成对比图失败';
      setError(msg);
      update({ status: 'error', error: msg });
    }
  }, [align, after, before, mode, opacity, split, threshold, update]);

  useRunTrigger(p.id, async () => {
    if (status === 'running') return;
    await handleRun();
  });

  const setMode = (value: CompareMode) => update({ mode: value });
  const setAlign = (value: AlignMode) => update({ align: value });

  const nodeStyle: CSSProperties = {
    width: 380,
    borderColor: p.selected ? COLOR : undefined,
    boxShadow: p.selected ? `0 0 0 2px ${COLOR}, var(--t8-shadow-strong, 0 18px 36px rgba(0,0,0,.22))` : undefined,
  };

  const imageFit = align === 'fill' ? 'fill' : align;

  const renderPreview = () => {
    if (!before) {
      return (
        <div className="aspect-video rounded-lg border border-dashed border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] flex items-center justify-center text-xs text-[var(--t8-text-dim)]">
          连接第一张图
        </div>
      );
    }
    if (!after) {
      return (
        <div className="space-y-2">
          <div className="aspect-video rounded-lg overflow-hidden bg-[var(--t8-bg-panel-muted)] border border-[var(--t8-border)]">
            <img src={before} alt="原图 A" className="w-full h-full object-contain" draggable={false} />
          </div>
          <div className="text-center text-xs text-[var(--t8-text-dim)]">继续连接第二张图</div>
        </div>
      );
    }

    if (mode === 'side-by-side') {
      return (
        <div className="grid grid-cols-2 gap-2">
          {[
            ['原图', before],
            ['对比图', after],
          ].map(([label, url]) => (
            <div key={label} className="overflow-hidden rounded-lg border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)]">
              <div className="px-2 py-1 text-[10px] font-bold text-[var(--t8-text-muted)] border-b border-[var(--t8-border)]">{label}</div>
              <div className="aspect-square">
                <img src={url} alt={label} className="w-full h-full object-contain" draggable={false} />
              </div>
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="relative aspect-video overflow-hidden rounded-lg border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] select-none">
        <img
          src={before}
          alt="原图 A"
          className="absolute inset-0 w-full h-full"
          style={{ objectFit: imageFit as any, opacity: mode === 'blink' && blinkOn ? 0 : mode === 'heatmap' ? 0.35 : 1 }}
          draggable={false}
        />
        {mode === 'slider' && (
          <>
            <img
              src={after}
              alt="对比图 B"
              className="absolute inset-0 w-full h-full"
              style={{ objectFit: imageFit as any, clipPath: `inset(0 ${100 - split}% 0 0)` }}
              draggable={false}
            />
            <div className="absolute inset-y-0 w-0.5 bg-[var(--t8-accent)] shadow" style={{ left: `calc(${split}% - 1px)` }} />
          </>
        )}
        {mode === 'overlay' && (
          <img
            src={after}
            alt="对比图 B"
            className="absolute inset-0 w-full h-full"
            style={{ objectFit: imageFit as any, opacity: opacity / 100 }}
            draggable={false}
          />
        )}
        {mode === 'blink' && (
          <>
            <img
              src={after}
              alt="对比图 B"
              className="absolute inset-0 w-full h-full"
              style={{ objectFit: imageFit as any, opacity: blinkOn ? 1 : 0 }}
              draggable={false}
            />
            <div className="absolute bottom-2 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold text-white">
              {blinkOn ? '对比图' : '原图'}
            </div>
          </>
        )}
        {(mode === 'heatmap' || mode === 'focus') && (
          <div className="absolute inset-0 bg-[var(--t8-bg-panel-muted)]">
            <DiffCanvasPreview before={before} after={after} align={align} threshold={threshold} variant={mode} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="t8-node relative transition-all" style={nodeStyle}>
      <Handle id="a" type="target" position={Position.Left} style={{ top: '37%', background: COLOR, border: 0 }} />
      <Handle id="b" type="target" position={Position.Left} style={{ top: '63%', background: COLOR, border: 0 }} />
      <Handle type="source" position={Position.Right} style={{ background: COLOR, border: 0 }} />

      <div className="relative z-10">
        <div className="t8-node-header flex items-center gap-2 px-3 py-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'color-mix(in srgb, var(--t8-accent) 18%, transparent)', color: 'var(--t8-accent)' }}
          >
            <GitCompare size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-[var(--t8-text-main)]">图像对比</div>
            <div className="text-[10px] text-[var(--t8-text-muted)]">
              {hasPair ? `${MODE_OPTIONS.find((x) => x.value === mode)?.label || '对比'} · ${ALIGN_OPTIONS.find((x) => x.value === align)?.label}` : `已连接 ${pair.count}/2 张图`}
            </div>
          </div>
        </div>

        <div className="p-3 space-y-3 nodrag" onMouseDown={(e) => e.stopPropagation()}>
          {renderPreview()}

          <div className="grid grid-cols-3 gap-1.5">
            {MODE_OPTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setMode(item.value)}
                title={item.label}
                className={`t8-btn px-2 py-1.5 text-[11px] ${mode === item.value ? 't8-btn-primary' : ''}`}
              >
                {item.short}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-[var(--t8-text-muted)]">对齐</span>
              <select
                value={align}
                onChange={(e) => setAlign(e.target.value as AlignMode)}
                className="t8-select w-full px-2 py-1.5 text-xs"
              >
                {ALIGN_OPTIONS.map((x) => (
                  <option key={x.value} value={x.value}>{x.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-[var(--t8-text-muted)]">
                {mode === 'overlay' ? `透明度 ${opacity}%` : (mode === 'heatmap' || mode === 'focus') ? `阈值 ${threshold}` : `分割 ${split}%`}
              </span>
              <input
                type="range"
                min={0}
                max={(mode === 'heatmap' || mode === 'focus') ? 120 : 100}
                value={mode === 'overlay' ? opacity : (mode === 'heatmap' || mode === 'focus') ? threshold : split}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (mode === 'overlay') update({ opacity: v });
                  else if (mode === 'heatmap' || mode === 'focus') update({ threshold: v });
                  else update({ split: v });
                }}
                className="w-full accent-orange-400"
              />
            </label>
          </div>

          <div className="grid grid-cols-3 gap-1.5 text-[10px] text-[var(--t8-text-muted)]">
            <div className="rounded-md border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] px-2 py-1">
              原图 {stats ? `${stats.imageA.width}×${stats.imageA.height}` : '--'}
            </div>
            <div className="rounded-md border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] px-2 py-1">
              对比 {stats ? `${stats.imageB.width}×${stats.imageB.height}` : '--'}
            </div>
            <div className="rounded-md border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] px-2 py-1">
              变化 {stats?.changedRatio !== undefined ? `${Math.round(stats.changedRatio * 100)}%` : '--'}
            </div>
          </div>

          <button
            type="button"
            onClick={handleRun}
            disabled={status === 'running' || !hasPair}
            className="t8-btn t8-btn-primary w-full px-3 py-2 text-xs disabled:opacity-50"
          >
            {status === 'running' ? (
              <>
                <Loader2 size={13} className="animate-spin" /> 生成中...
              </>
            ) : (
              <>
                <Sparkles size={13} /> 生成对比结果图
              </>
            )}
          </button>

          {mode === 'blink' && (
            <div className="text-[10px] text-[var(--t8-text-dim)]">闪烁模式运行时会导出为并排对比图。</div>
          )}
          {outputUrl && !hasAutoOutput && (
            <div className="rounded-md border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] px-2 py-1 text-[10px] text-[var(--t8-text-muted)]">
              已生成结果，可从右侧端口继续连接输出素材。
            </div>
          )}
          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-300">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default memo(ImageCompareNode);
