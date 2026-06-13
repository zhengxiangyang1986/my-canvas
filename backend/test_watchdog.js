const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = globalThis.fetch;

async function runWatchdogTest() {
  const HOST = 'http://127.0.0.1:18766';
  console.log('1. Submitting task as Frontend...');
  const submitRes = await fetch(`${HOST}/api/bridge/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'watchdog test', model: 'web-agent-doubao', images: [] })
  });
  const submitData = await submitRes.json();
  const taskId = submitData.taskId;
  console.log('   Task ID:', taskId);

  console.log('2. Starting Frontend SSE Listener (Mock DoubaoBridgeListener)...');
  let sseResponse = null;
  const ssePromise = new Promise((resolve, reject) => {
    const req = http.get(`${HOST}/api/bridge/events`, (res) => {
      sseResponse = res;
      res.on('data', (chunk) => {
        const msg = chunk.toString();
        // 我们刚刚修复了 DoubaoBridgeListener，现在应该监听 event: rawUrls
        if (msg.includes('event: rawUrls')) {
          console.log('   [SSE Event Received]:', msg.trim());
          
          // 解析出 data 部分
          const lines = msg.split('\n');
          const dataLine = lines.find(l => l.startsWith('data: '));
          if (dataLine) {
            const payload = JSON.parse(dataLine.replace('data: ', ''));
            if (payload.taskId === taskId && Array.isArray(payload.rawUrls)) {
              console.log('   => MATCH! The remoteUrls are successfully extracted:', payload.rawUrls);
              resolve();
            }
          }
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });

  // 等待 SSE 连接建立
  await new Promise(r => setTimeout(r, 1000));

  console.log('3. Simulating Tampermonkey trigger (File download & alert)...');
  const downloadsPath = path.join(os.homedir(), 'Downloads');
  const fakeDownloadFile = path.join(downloadsPath, `test_mock_download_${Date.now()}.png`);
  
  // 模拟油猴发起浏览器下载，文件落盘到 Downloads
  fs.writeFileSync(fakeDownloadFile, 'fake-image-data');
  console.log(`   Mock file created at: ${fakeDownloadFile}`);

  // 发送 download-alert 给看门狗
  await fetch(`${HOST}/api/bridge/download-alert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId })
  });

  console.log('4. Waiting for Watchdog to catch the file and broadcast SSE...');
  
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('SSE Timeout')), 10000));
  
  try {
    await Promise.race([ssePromise, timeoutPromise]);
    console.log('✅ ALL WATCHDOG & SSE TESTS PASSED!');
  } catch (err) {
    console.error('❌ TEST FAILED:', err.message);
  } finally {
    if (sseResponse) sseResponse.destroy();
    // 清理假文件
    if (fs.existsSync(fakeDownloadFile)) {
      fs.unlinkSync(fakeDownloadFile);
    }
  }
}

runWatchdogTest().catch(console.error);
