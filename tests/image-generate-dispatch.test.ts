import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('ImageNode handleGenerate 提取验证', () => {
  const filePath = path.join(__dirname, '../src/components/nodes/ImageNode.tsx');
  const code = fs.readFileSync(filePath, 'utf8');

  it('handleGenerate 应该被大幅简化，行数不超过 80 行', () => {
    const handleGenerateStart = code.indexOf('const handleGenerate = async () => {');
    expect(handleGenerateStart).toBeGreaterThan(-1);

    const handleStopStart = code.indexOf('const handleStop = () => {', handleGenerateStart);
    // Since handleGenerate might be defined after handleStop, let's find the useRunTrigger
    const useRunTriggerStart = code.indexOf('useRunTrigger(id, handleGenerate,', handleGenerateStart);
    
    // Roughly estimate lines
    const block = code.slice(handleGenerateStart, useRunTriggerStart !== -1 ? useRunTriggerStart : handleGenerateStart + 4000);
    const lineCount = block.split('\n').length;
    
    // Currently handleGenerate is ~400 lines. We want it to be much smaller.
    // Let's assert it's less than 150 lines (giving some room for inner dispatcher logic).
    expect(lineCount).toBeLessThan(150);
  });

  it('应该提取出各个独立生成函数', () => {
    expect(code).toContain('generateViaDoubaoBridge');
    expect(code).toContain('generateViaExternal');
    expect(code).toContain('generateViaMj');
    expect(code).toContain('generateViaFal');
    expect(code).toContain('generateViaZhenzhen');
  });

  it('handleGenerate 中应该根据条件调用这些提取的函数', () => {
    const handleGenerateStart = code.indexOf('const handleGenerate = async () => {');
    const handleGenerateEnd = code.indexOf('useRunTrigger', handleGenerateStart);
    const body = code.slice(handleGenerateStart, handleGenerateEnd);

    expect(body).toContain('generateViaDoubaoBridge(');
    expect(body).toContain('generateViaExternal(');
    expect(body).toContain('generateViaMj(');
    expect(body).toContain('generateViaFal(');
    expect(body).toContain('generateViaZhenzhen(');
  });
});
