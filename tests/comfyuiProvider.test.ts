import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const comfyui = require('../backend/src/providers/comfyui.js');
const { analyzeComfyWorkflow } = await import('../src/utils/comfyuiWorkflow.ts');

function jsonResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'image/png' },
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
    async arrayBuffer() {
      return Buffer.from('PNG').buffer;
    },
  };
}

test('ComfyUI image generation patches workflow, submits prompt, polls history and returns view urls', async () => {
  const calls: any[] = [];
  const provider = {
    id: 'comfyui',
    protocol: 'comfyui',
    baseUrl: 'http://127.0.0.1:8188',
    enabled: true,
    comfyuiConfig: {
      workflows: [
        {
          id: 'workflow-1',
          name: 'Flux Workflow',
          workflowJson: {
            '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
            '2': { class_type: 'KSampler', inputs: { seed: 1 } },
            '3': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
            '4': { class_type: 'LoadImage', inputs: { image: '' } },
          },
          fields: [
            { nodeId: '1', fieldName: 'text', source: 'prompt' },
            { nodeId: '3', fieldName: 'width', source: 'width' },
            { nodeId: '3', fieldName: 'height', source: 'height' },
            { nodeId: '4', fieldName: 'image', source: 'image1' },
          ],
        },
      ],
    },
  };

  const result = await comfyui.generateImage(provider, {
    prompt: 'a court',
    providerModel: 'workflow-1',
    size: '1024x768',
    images: ['/files/input/ref.png'],
  }, {
    baseUrl: 'http://127.0.0.1:18766',
    pollIntervalMs: 1,
    fetchImpl: async (url: string, init: any = {}) => {
      if (String(url).includes('/files/input/ref.png')) {
        calls.push({ url, init });
        return jsonResponse({}, 200);
      }
      if (String(url).endsWith('/upload/image')) {
        calls.push({ url, init, upload: true });
        return jsonResponse({ name: 'ref-uploaded.png' });
      }
      if (String(url).endsWith('/prompt')) {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return jsonResponse({ prompt_id: 'pid-1' });
      }
      calls.push({ url, init });
      return jsonResponse({
        'pid-1': {
          outputs: {
            '9': { images: [{ filename: 'out.png', type: 'output', subfolder: '' }] },
          },
        },
      });
    },
  });

  assert.equal(result.ok, true);
  const promptCall = calls.find((call) => String(call.url).endsWith('/prompt'));
  assert.equal(promptCall.body.prompt['1'].inputs.text, 'a court');
  assert.equal(promptCall.body.prompt['3'].inputs.width, 1024);
  assert.equal(promptCall.body.prompt['3'].inputs.height, 768);
  assert.equal(promptCall.body.prompt['4'].inputs.image, 'ref-uploaded.png');
  const downloadCall = calls.find((call) => String(call.url).includes('/files/input/ref.png'));
  const uploadCall = calls.find((call) => String(call.url).endsWith('/upload/image'));
  assert.equal(String(downloadCall.url), 'http://127.0.0.1:18766/files/input/ref.png');
  assert.equal(String(uploadCall.url), 'http://127.0.0.1:8188/upload/image');
  assert.deepEqual(result.imageUrls, ['http://127.0.0.1:8188/view?filename=out.png&type=output&subfolder=']);
});

test('ComfyUI workflow analyzer creates friendly mappings for common API workflow nodes', () => {
  const analysis = analyzeComfyWorkflow({
    '1': { class_type: 'CLIPTextEncode', inputs: { text: '' }, _meta: { title: 'Positive Prompt' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '' }, _meta: { title: 'Negative Prompt' } },
    '3': { class_type: 'LoadImage', inputs: { image: '' } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768 } },
    '5': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal' } },
    '6': { class_type: 'SaveImage', inputs: { images: ['x', 0] } },
  });

  assert.equal(analysis.imageInputCount, 1);
  assert.equal(analysis.outputCount, 1);
  assert.deepEqual(
    analysis.fields.map((field) => [field.nodeId, field.fieldName, field.source]),
    [
      ['1', 'text', 'prompt'],
      ['2', 'text', 'negative'],
      ['3', 'image', 'image1'],
      ['4', 'width', 'width'],
      ['4', 'height', 'height'],
      ['5', 'seed', 'seed'],
      ['5', 'steps', 'steps'],
      ['5', 'cfg', 'cfg'],
      ['5', 'sampler_name', 'sampler_name'],
      ['5', 'scheduler', 'scheduler'],
    ],
  );
});
