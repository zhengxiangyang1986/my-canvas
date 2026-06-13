const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

(async () => {
  console.log('正在启动 Playwright 有头(Headed)持久化浏览器...');
  
  // 指定持久化目录，这样用户登录过的豆包账号或者油猴插件就会被保留
  const userDataDir = path.join(os.homedir(), '.playwright_persistent_profile');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    // 强制允许弹出窗口并忽略部分证书错误
    ignoreHTTPSErrors: true,
  });

  // 打开第一个标签页：我们的画布
  const pageCanvas = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  console.log('=> 打开画布页面');
  await pageCanvas.goto('http://127.0.0.1:11422/');

  // 打开第二个标签页：豆包网页版
  console.log('=> 打开豆包网页版');
  const pageDoubao = await context.newPage();
  await pageDoubao.goto('https://www.doubao.com/chat/');

  console.log('====================================================');
  console.log('🚀 浏览器已拉起，上下文已挂载！');
  console.log('👉 请确认网页版豆包中的油猴插件已激活并登录账号。');
  console.log('👉 然后切换回画布页面（第一个标签），添加图像/视频节点并点击生成。');
  console.log('👉 看看本地看门狗与节点组件能否同步接收到数据吧！');
  console.log('====================================================');

  // 挂起程序，防止浏览器关闭
  await new Promise(() => {});
})();
