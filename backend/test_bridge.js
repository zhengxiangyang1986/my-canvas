const fetch = globalThis.fetch;

async function testBridge() {
  const HOST = 'http://127.0.0.1:18766';
  
  console.log('1. Submitting task as Frontend...');
  const submitRes = await fetch(`${HOST}/api/bridge/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'test prompt',
      model: 'web-agent-doubao',
      images: []
    })
  });
  const submitData = await submitRes.json();
  console.log('Submit Result:', submitData);
  const taskId = submitData.taskId;

  if (!taskId) throw new Error('Failed to get taskId');

  console.log('2. Polling inbox as Frontend (should be queued)...');
  let queryRes = await fetch(`${HOST}/api/bridge/inbox/${taskId}`);
  let queryData = await queryRes.json();
  console.log('Query Result:', queryData);

  console.log('3. Pulling task as Tampermonkey (Long Polling)...');
  const pullReq = fetch(`${HOST}/api/bridge/pull`, {
    headers: { 'x-agent-id': 'mock-agent' }
  });
  
  const pullRes = await pullReq;
  const pullData = await pullRes.json();
  console.log('Pull Result:', pullData);
  
  const pulledTaskId = pullData.task ? pullData.task.id : pullData.data?.taskId;
  if (pulledTaskId !== taskId) throw new Error('Pulled wrong task ID');

  console.log('4. Pushing result as Tampermonkey...');
  const pushRes = await fetch(`${HOST}/api/bridge/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-id': 'mock-agent' },
    body: JSON.stringify({
      taskId,
      status: 'completed',
      progress: '100%',
      base64Data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    })
  });
  const pushData = await pushRes.json();
  console.log('Push Result:', pushData);

  console.log('5. Polling inbox as Frontend (should be completed)...');
  queryRes = await fetch(`${HOST}/api/bridge/inbox/${taskId}`);
  queryData = await queryRes.json();
  console.log('Final Query Result:', queryData);

  if (queryData.status === 'completed' && queryData.urls[0] && queryData.urls[0].startsWith('http')) {
    console.log('✅ ALL TESTS PASSED!');
  } else {
    console.error('❌ TEST FAILED!');
  }
}

testBridge().catch(console.error);
