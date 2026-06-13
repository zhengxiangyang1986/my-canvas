// ====== DOUBAO WEB AGENT BRIDGE (可随时安全移除) ======
// 该文件用于封装与后端 /api/bridge 相关的请求以及前台节点的轮询高级方法。
// 移除该文件及其在节点中的引用即可完全解耦。

export interface BridgeTaskRequest {
  prompt: string;
  images?: string[]; // base64 images
  model?: string;
}

export async function submitBridgeTask(req: BridgeTaskRequest): Promise<{ taskId: string }> {
  const r = await fetch('/api/bridge/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const data = await r.json();
  if (!r.ok || !data.success) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

export interface BridgeQueryResult {
  status: 'queued' | 'running' | 'completed' | 'failed' | string;
  progress?: string;
  urls?: string[];
  rawUrls?: string[];
  error?: string;
}

export async function queryBridgeTask(taskId: string): Promise<BridgeQueryResult> {
  const r = await fetch(`/api/bridge/inbox/${encodeURIComponent(taskId)}`);
  const data = await r.json();
  if (!r.ok || !data.success) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// 统一提取的通用生成控制流（适用于 ImageNode 和 VideoNode）
export async function executeDoubaoBridgeGeneration(options: {
  prompt: string;
  images: string[];
  model: string;
  onUpdate: (patch: any) => void;
  id: string;
  logBus: any;
  taskCompletionSound: any;
  nodeType: 'image' | 'video';
}) {
  const { prompt, images, model, onUpdate, id, logBus, taskCompletionSound, nodeType } = options;
  const src = `${nodeType}:${id.slice(0, 6)}`;
  
  logBus.info(`Doubao Bridge 提交: model=${model} 参考图=${images.length} prompt="${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}"`, src);

  // 1. 如果有参考图（由于是本地路径或者外部URL，需要先转base64传递给桥接后端，以防油猴拿不到内网图）
  // 或者让油猴直接处理URL？为了最稳定，我们这里转换成 base64 传给油猴。
  const base64Array: string[] = [];
  for (const u of images) {
    try {
      const resp = await fetch(u);
      const blob = await resp.blob();
      const dataUrl: string = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(new Error('读取失败'));
        fr.readAsDataURL(blob);
      });
      base64Array.push(dataUrl);
    } catch (err: any) {
      logBus.warn(`Doubao 主参考图转 base64 失败,跳过: ${u}`, src);
    }
  }

  // 2. 提交任务
  const submit = await submitBridgeTask({
    prompt,
    model,
    images: base64Array,
  });

  const taskId = submit.taskId;
  if (!taskId) throw new Error('Doubao Bridge 未获取到 taskId');
  
  logBus.info(`Doubao Bridge 异步任务已提交 taskId=${taskId} 进入轮询…`, src);
  onUpdate({ progress: '5%', taskId });

  // 3. 轮询状态（防油猴超时，可以设置 1800 次 * 2秒 = 3600 秒 = 1小时）
  const maxPoll = 1800;
  const interval = 2000;
  let lastProg = '5%';

  for (let i = 0; i < maxPoll; i++) {
    await new Promise((r) => setTimeout(r, interval));
    const q = await queryBridgeTask(taskId);

    if (q.progress && q.progress !== lastProg) {
      lastProg = q.progress;
      onUpdate({ progress: q.progress });
      logBus.debug(`[${i + 1}/${maxPoll}] status=${q.status} progress=${q.progress}`, src);
    }

    const st = String(q.status || '').toLowerCase();
    if (st === 'completed' || st === 'success' || st === 'done') {
      const url = q.urls?.[0];
      if (!url) throw new Error('Doubao 任务完成但未返回素材');
      
      logBus.success(`Doubao 任务完成 → ${url}`, src);
      
      const updateData: any = {
        status: 'success',
        progress: '100%',
        lastPrompt: prompt,
        usedI2I: images.length > 0,
      };

      // 适配 Image 和 Video
      if (nodeType === 'image') {
        updateData.imageUrl = url;
        updateData.imageUrls = q.urls;
        // 如果后端传回了真实 URL，可以直接作为 remoteUrl (或者后面通过监听事件获取)
        if (q.rawUrls?.length) updateData.remoteImageUrls = q.rawUrls;
      } else {
        updateData.videoUrl = url;
        if (q.rawUrls?.length) updateData.remoteUrl = q.rawUrls[0];
      }

      onUpdate(updateData);
      taskCompletionSound.notifyComplete(id, nodeType);
      return;
    }
    
    if (st === 'failed' || st === 'failure' || st === 'error') {
      throw new Error(q.error || 'Doubao 任务生成失败');
    }
  }

  throw new Error(`Doubao 生成超时: ${(maxPoll * interval) / 1000}s 未完成`);
}
// ====================================================
