export type ComfyFieldSource =
  | 'prompt'
  | 'negative'
  | 'image1'
  | 'image2'
  | 'image3'
  | 'width'
  | 'height'
  | 'seed'
  | 'steps'
  | 'cfg'
  | 'sampler_name'
  | 'scheduler'
  | 'denoise'
  | 'fixed';

export interface ComfyFieldMapping {
  nodeId: string;
  fieldName: string;
  source?: string;
  value?: any;
}

export interface ComfyDetectedField extends ComfyFieldMapping {
  classType: string;
  nodeTitle: string;
  label: string;
}

export interface ComfyWorkflowAnalysis {
  fields: ComfyDetectedField[];
  imageInputCount: number;
  outputCount: number;
  warnings: string[];
}

export const COMFY_FIELD_SOURCE_OPTIONS: Array<{ value: ComfyFieldSource; label: string; hint?: string }> = [
  { value: 'prompt', label: '正向 Prompt' },
  { value: 'negative', label: '负向 Prompt' },
  { value: 'image1', label: '上游图片 1' },
  { value: 'image2', label: '上游图片 2' },
  { value: 'image3', label: '上游图片 3' },
  { value: 'width', label: '宽度' },
  { value: 'height', label: '高度' },
  { value: 'seed', label: 'Seed' },
  { value: 'steps', label: 'Steps' },
  { value: 'cfg', label: 'CFG' },
  { value: 'sampler_name', label: 'Sampler' },
  { value: 'scheduler', label: 'Scheduler' },
  { value: 'denoise', label: 'Denoise' },
  { value: 'fixed', label: '固定值' },
];

function entriesOfWorkflow(workflow: unknown): Array<[string, any]> {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return [];
  return Object.entries(workflow as Record<string, any>).filter(([, node]) => (
    node && typeof node === 'object' && !Array.isArray(node) && node.inputs && typeof node.inputs === 'object'
  ));
}

function nodeTitle(nodeId: string, node: any): string {
  return String(node?._meta?.title || node?.title || node?.class_type || `#${nodeId}`).trim();
}

function classTypeOf(node: any): string {
  return String(node?.class_type || '').trim();
}

function pushField(
  out: ComfyDetectedField[],
  seen: Set<string>,
  nodeId: string,
  node: any,
  fieldName: string,
  source: ComfyFieldSource,
) {
  const key = `${nodeId}::${fieldName}`;
  if (seen.has(key)) return;
  seen.add(key);
  const classType = classTypeOf(node);
  const title = nodeTitle(nodeId, node);
  out.push({
    nodeId,
    fieldName,
    source,
    classType,
    nodeTitle: title,
    label: `${title} #${nodeId} · ${fieldName}`,
  });
}

function isNegativePromptNode(node: any, promptTextAlreadySeen: boolean): boolean {
  const text = `${node?._meta?.title || ''} ${node?.title || ''} ${node?.class_type || ''}`.toLowerCase();
  if (/negative|neg|反向|负向|不要|排除/.test(text)) return true;
  return promptTextAlreadySeen;
}

export function analyzeComfyWorkflow(workflow: unknown): ComfyWorkflowAnalysis {
  const fields: ComfyDetectedField[] = [];
  const seen = new Set<string>();
  let promptTextSeen = false;
  let imageInputCount = 0;
  let outputCount = 0;
  const warnings: string[] = [];
  const entries = entriesOfWorkflow(workflow);

  if (!entries.length) {
    warnings.push('未识别到 API Workflow 节点；请确认导入的是 ComfyUI API 格式，而不是普通前端 workflow。');
    return { fields, imageInputCount, outputCount, warnings };
  }

  for (const [nodeId, node] of entries) {
    const classType = classTypeOf(node);
    const lowClass = classType.toLowerCase();
    const inputs = node.inputs || {};
    const inputKeys = Object.keys(inputs);

    if (lowClass.includes('cliptextencode') && Object.prototype.hasOwnProperty.call(inputs, 'text')) {
      const source: ComfyFieldSource = isNegativePromptNode(node, promptTextSeen) ? 'negative' : 'prompt';
      pushField(fields, seen, nodeId, node, 'text', source);
      if (source === 'prompt') promptTextSeen = true;
    }

    if ((lowClass.includes('loadimage') || lowClass.includes('imageinput')) && Object.prototype.hasOwnProperty.call(inputs, 'image')) {
      imageInputCount += 1;
      pushField(fields, seen, nodeId, node, 'image', (`image${Math.min(imageInputCount, 3)}` as ComfyFieldSource));
    }

    if (lowClass.includes('emptylatent') || lowClass.includes('latentimage')) {
      if (Object.prototype.hasOwnProperty.call(inputs, 'width')) pushField(fields, seen, nodeId, node, 'width', 'width');
      if (Object.prototype.hasOwnProperty.call(inputs, 'height')) pushField(fields, seen, nodeId, node, 'height', 'height');
    }

    if (lowClass.includes('ksampler') || lowClass.includes('sampler')) {
      for (const key of ['seed', 'noise_seed']) {
        if (Object.prototype.hasOwnProperty.call(inputs, key)) pushField(fields, seen, nodeId, node, key, 'seed');
      }
      for (const key of ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'] as const) {
        if (Object.prototype.hasOwnProperty.call(inputs, key)) pushField(fields, seen, nodeId, node, key, key);
      }
    }

    if (lowClass.includes('saveimage') || lowClass.includes('previewimage')) outputCount += 1;

    if (!lowClass && inputKeys.length > 0) {
      warnings.push(`#${nodeId} 缺少 class_type，可能不是标准 API Workflow 节点。`);
    }
  }

  if (!fields.some((field) => field.source === 'prompt')) {
    warnings.push('未自动找到正向 Prompt 字段；可以在映射表中手动添加或切到高级 fields JSON。');
  }
  if (imageInputCount > 0 && !fields.some((field) => /^image\d+$/.test(String(field.source || '')))) {
    warnings.push('检测到图像输入节点，但没有生成图片映射。');
  }

  return { fields, imageInputCount, outputCount, warnings };
}

export function compactComfyFields(fields: Array<ComfyFieldMapping | ComfyDetectedField> | undefined): ComfyFieldMapping[] {
  const out: ComfyFieldMapping[] = [];
  const seen = new Set<string>();
  for (const field of Array.isArray(fields) ? fields : []) {
    const nodeId = String(field?.nodeId || '').trim();
    const fieldName = String(field?.fieldName || '').trim();
    if (!nodeId || !fieldName) continue;
    const key = `${nodeId}::${fieldName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = String(field.source || fieldName || '').trim();
    const next: ComfyFieldMapping = { nodeId, fieldName, source };
    if (Object.prototype.hasOwnProperty.call(field, 'value')) next.value = field.value;
    out.push(next);
  }
  return out;
}
