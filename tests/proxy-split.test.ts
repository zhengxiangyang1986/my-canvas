import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('proxy.js split refactoring', () => {
  const backendSrcDir = path.resolve(__dirname, '../backend/src');
  const proxyDir = path.join(backendSrcDir, 'routes', 'proxy');
  const oldProxyJs = path.join(backendSrcDir, 'routes', 'proxy.js');

  it('旧 proxy.js 应不再存在', () => {
    expect(fs.existsSync(oldProxyJs)).toBe(false);
  });

  it('proxy/index.js 应成功加载且导出 router', () => {
    const proxyModule = require(proxyDir);
    expect(proxyModule).toBeDefined();
    // In express 4, a Router is a function with 'use'
    expect(typeof proxyModule).toBe('function');
    expect(typeof proxyModule.use).toBe('function');
  });

  it('_helpers.js 的所有导出函数应可调用', () => {
    const helpers = require(path.join(proxyDir, '_helpers.js'));
    expect(helpers).toBeDefined();
    expect(typeof helpers.pickApiKey).toBe('function');
    expect(typeof helpers.normalizeProviderParams).toBe('function');
    expect(typeof helpers.audioUpload).toBe('object'); // multer instance
  });

  it('image.js 应注册相关路由', () => {
    const router = require(path.join(proxyDir, 'image.js'));
    expect(router).toBeDefined();
    const stack = router.stack;
    const paths = stack.map((layer: any) => layer.route && layer.route.path).filter(Boolean);
    expect(paths).toContain('/image');
    expect(paths).toContain('/image/submit');
    expect(paths).toContain('/mj/imagine');
  });

  it('video.js 应注册相关路由', () => {
    const router = require(path.join(proxyDir, 'video.js'));
    const stack = router.stack;
    const paths = stack.map((layer: any) => layer.route && layer.route.path).filter(Boolean);
    expect(paths).toContain('/video/submit');
    expect(paths).toContain('/video/fal/submit');
  });

  it('llm.js 应注册相关路由', () => {
    const router = require(path.join(proxyDir, 'llm.js'));
    const stack = router.stack;
    const paths = stack.map((layer: any) => layer.route && layer.route.path).filter(Boolean);
    expect(paths).toContain('/llm');
  });

  it('audio.js 应注册相关路由', () => {
    const router = require(path.join(proxyDir, 'audio.js'));
    const stack = router.stack;
    const paths = stack.map((layer: any) => layer.route && layer.route.path).filter(Boolean);
    expect(paths).toContain('/audio/submit');
    expect(paths).toContain('/audio/upload');
  });
});
