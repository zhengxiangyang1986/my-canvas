const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const redPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const testImagePath = path.join(__dirname, 'test_cat.png');
fs.writeFileSync(testImagePath, Buffer.from(redPngBase64, 'base64'));

(async () => {
  console.log('1. 正在启动 Playwright 有头自动化浏览器...');
  const userDataDir = path.join(os.homedir(), '.playwright_persistent_profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    ignoreHTTPSErrors: true,
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  
  console.log('2. 访问本地画布服务 http://127.0.0.1:11422/ ...');
  await page.goto('http://127.0.0.1:11422/');
  await page.waitForTimeout(3000);

  console.log('3. 尝试多种方式添加【图像节点】...');
  try {
    // 尝试找 title 中包含图像的侧边栏按钮
    const btn1 = page.locator('[title*="图像"]').first();
    if (await btn1.count() > 0) {
      await btn1.click();
      console.log('   => 通过 title 点击到了图像生成节点');
    } else {
      // 尝试找内部文字包含图像的 button
      const btn2 = page.getByRole('button', { name: /图像/ }).first();
      await btn2.click();
      console.log('   => 通过文字点击到了图像生成节点');
    }
  } catch (err) {
    console.log('   => 尝试添加图像节点失败，尝试在屏幕中央双击唤出菜单...');
    await page.mouse.dblclick(700, 450);
    await page.waitForTimeout(1000);
    try {
      await page.getByText(/图像/i).first().click();
      console.log('   => 通过双击菜单添加成功');
    } catch(e) {
       console.log('   => 所有 UI 尝试失败，尝试直接向前端派发全局事件或者调用代码注入...');
       await page.evaluate(() => {
           // 强行找到 window 上的 addNode 或通过 dispatchEvent，但先不报致命错，看后面能不能找到 input
       });
    }
  }
  
  await page.waitForTimeout(2000);

  console.log('4. 查找文件上传入口并传入测试图片...');
  try {
    // 等待 input type=file 出现，哪怕是隐藏的
    const fileInput = page.locator('input[type="file"]').last();
    // 使用强制上传
    await fileInput.setInputFiles(testImagePath);
    console.log('   => 成功上传了测试图片!');
  } catch (err) {
    console.log('   => 上传失败:', err.message);
  }

  await page.waitForTimeout(1000);

  console.log('5. 填写改图提示词...');
  try {
    const textarea = page.locator('textarea').last();
    await textarea.fill('改图测试：请将这张图变成梵高星空风格');
    console.log('   => 提示词填写完成!');
  } catch(e) {
    console.log('   => 填词失败:', e.message);
  }

  console.log('6. 选择豆包模型...');
  try {
    const tabs = page.locator('.flex.items-center.gap-1.text-xs').filter({ hasText: '豆包' }).first();
    if (await tabs.count() > 0) {
      await tabs.click();
    } else {
      const doubaoTxt = page.getByText(/web-agent-doubao|豆包/i).last();
      await doubaoTxt.click();
    }
    console.log('   => 成功尝试选择豆包模型!');
  } catch(e) {
    console.log('   => 模型选择警告:', e.message);
  }

  await page.waitForTimeout(1000);

  console.log('7. 点击【生成】按钮!');
  try {
    const generateBtn = page.getByRole('button', { name: /生成/ }).last();
    await generateBtn.click();
    console.log('   => 成功触发提交！！任务已进入队列！');
  } catch(e) {
    console.log('   => 生成按钮点击失败:', e.message);
  }

  console.log('====================================================');
  console.log('✅ 自动化测试操作已全部投递，如果上面的步骤没有致命错误，请看您的豆包页面！');
  console.log('====================================================');

  await new Promise(() => {});
})();
