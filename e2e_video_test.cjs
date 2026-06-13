const { chromium } = require('playwright');
(async () => {
  console.log('🚀 启动全自动前端双盲测试（完全解耦模式）...');
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    console.log('🌐 正在访问 my-canvas 画布 (端口 11422)...');
    await page.goto('http://127.0.0.1:11422/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('🎬 正在添加【视频节点】...');
    await page.click('button:has-text("Video"), button:has-text("视频")').catch(()=>null);
    await page.waitForTimeout(2000);
    console.log('📝 正在输入测试 Prompt...');
    const textareas = page.locator('textarea');
    if (await textareas.count() > 0) {
      await textareas.last().fill('赛博朋克机器猫正在喝咖啡，动作流畅，4k高画质，光影绚丽');
    }
    console.log('🤖 正在选择 Doubao Video 模型...');
    const select = page.locator('select');
    if (await select.count() > 0) {
      await select.last().selectOption({ label: 'Doubao Video' }).catch(()=>null);
      await select.last().selectOption('doubao-video').catch(()=>null);
    }
    console.log('📤 提交生成，发起呼叫...');
    await page.locator('button:has-text("生成"), button:has-text("Generate")').last().click().catch(()=>null);
    console.log('⏳ 等待真实浏览器内的油猴接管任务并提交视频返回...');
    await page.waitForFunction(() => {
      const vids = Array.from(document.querySelectorAll('video'));
      return vids.some(v => {
        const s = v.src || (v.querySelector('source') ? v.querySelector('source').src : '');
        return s && s.includes('bridge_media');
      });
    }, { timeout: 600000 });
    console.log('🎉🎉🎉 验收成功！画布成功捕获并在本地渲染了无损视频！');
  } catch (err) {
    console.error('❌ 测试遇到问题：', err);
  } finally {
    await browser.close();
  }
})();
