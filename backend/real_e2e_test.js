const http = require('http');
const fetch = globalThis.fetch;

// 1x1 红色小图的 base64
const redPngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function runRealTest() {
  const HOST = 'http://127.0.0.1:18766';
  console.log('📡 [第一步]: 正在向队列提交真实【图生图】生图任务...');
  
  const submitRes = await fetch(`${HOST}/api/bridge/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      prompt: '改图：请将这张图变成梵高星空油画风格', 
      model: 'web-agent-doubao', 
      images: [redPngBase64] // 携带 Base64 参考图！！
    })
  });
  const submitData = await submitRes.json();
  const taskId = submitData.taskId;
  console.log(`✅ 【图生图】任务提交成功！Task ID: ${taskId}`);
  console.log('👀 请观察您打开的【豆包网页端】，油猴插件现在应该正带着图片在向豆包提问！');

  console.log('⏳ [第二步]: 正在监听前端 SSE 广播，等待看门狗捕获豆包下载的高清原图...');
  let sseResponse = null;
  const ssePromise = new Promise((resolve, reject) => {
    const req = http.get(`${HOST}/api/bridge/events`, (res) => {
      sseResponse = res;
      res.on('data', (chunk) => {
        const msg = chunk.toString();
        if (msg.includes('event: rawUrls')) {
          console.log('\n=============================================');
          console.log('🎉 [看门狗预警]: 嗅探到真实浏览器下载，并已通过SSE向前端发射数据！');
          console.log('=============================================');
          
          const lines = msg.split('\n');
          const dataLine = lines.find(l => l.startsWith('data: '));
          if (dataLine) {
            const payload = JSON.parse(dataLine.replace('data: ', ''));
            if (payload.taskId === taskId && Array.isArray(payload.rawUrls)) {
              console.log('🚀 成功获取到传回的最终本地图片路径:');
              console.log(payload.rawUrls);
              resolve();
            }
          }
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });

  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('等待真实豆包出图超时 (45秒)')), 45000));
  
  try {
    await Promise.race([ssePromise, timeoutPromise]);
    console.log('\n🟢 图生图全链路联调测试：完美通过！');
  } catch (err) {
    console.error('\n🔴 测试异常或超时：', err.message);
  } finally {
    if (sseResponse) sseResponse.destroy();
  }
}

runRealTest().catch(console.error);
