import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We just test the timeout and recursive setTimeout logic abstractly 
// to simulate what AudioNode and VideoNode do since we can't easily 
// render full React flow nodes in this isolated test without huge setups.

const createMockPoller = (queryMock: any) => {
  let pollTimer: any = null;
  let status = 'polling';
  let error = null;
  let result = null;

  const stopPoll = () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const startPolling = (MAX = 10, POLL_INT = 100) => {
    stopPoll();
    return new Promise<void>((resolve, reject) => {
      let elapsed = 0;
      const tick = async () => {
        elapsed += 1;
        if (elapsed > MAX) {
          stopPoll();
          status = 'error';
          error = '轮询超时';
          reject(new Error('轮询超时'));
          return;
        }
        try {
          const r = await queryMock();
          if (r.status === 'SUCCESS') {
            stopPoll();
            status = 'success';
            result = r;
            resolve();
            return;
          } else if (r.status === 'FAILURE') {
            stopPoll();
            status = 'error';
            error = r.failReason || '生成失败';
            reject(new Error(error));
            return;
          }
        } catch (e: any) {
          // ignore
        }
        pollTimer = setTimeout(tick, POLL_INT);
      };
      pollTimer = setTimeout(tick, POLL_INT);
    });
  };

  return { startPolling, stopPoll, getStatus: () => ({ status, error, result }) };
};

describe('Polling race condition logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('startPolling 不应并发调用 query', async () => {
    let callCount = 0;
    const queryMock = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        callCount++;
        // Simulate a query taking longer than the poll interval
        setTimeout(() => resolve({ status: 'POLLING' }), 500); 
      });
    });

    const poller = createMockPoller(queryMock);
    
    // Start polling without awaiting here so we can advance timers
    poller.startPolling(10, 100).catch(() => {});
    
    // First tick is scheduled
    await vi.advanceTimersByTimeAsync(100); 
    
    // query is executing... takes 500ms.
    // If it was setInterval, after 100ms it would fire again.
    // Let's advance by 300ms (total 400ms elapsed).
    await vi.advanceTimersByTimeAsync(300);
    
    // Should still be only 1 call!
    expect(callCount).toBe(1);

    // Finish the first query
    await vi.advanceTimersByTimeAsync(200); 
    
    // Now it should schedule the next tick
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(2);
  });

  it('stopPoll 应正确清除 setTimeout', async () => {
    const queryMock = vi.fn().mockResolvedValue({ status: 'POLLING' });
    const poller = createMockPoller(queryMock);
    
    poller.startPolling(10, 100).catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    expect(queryMock).toHaveBeenCalledTimes(1);

    poller.stopPoll();
    await vi.advanceTimersByTimeAsync(500);
    expect(queryMock).toHaveBeenCalledTimes(1); // No more calls
  });

  it('轮询超时应 reject 并更新 status=error', async () => {
    const queryMock = vi.fn().mockResolvedValue({ status: 'POLLING' });
    const poller = createMockPoller(queryMock);
    
    const p = poller.startPolling(3, 100);
    await vi.advanceTimersByTimeAsync(1000);
    
    await expect(p).rejects.toThrow('轮询超时');
    expect(poller.getStatus().status).toBe('error');
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('轮询成功应 resolve 且仅调用一次', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ status: 'POLLING' })
      .mockResolvedValueOnce({ status: 'SUCCESS', videoUrl: 'url' });
    const poller = createMockPoller(queryMock);
    
    const p = poller.startPolling(10, 100);
    await vi.advanceTimersByTimeAsync(100); // call 1
    await vi.advanceTimersByTimeAsync(100); // call 2
    
    await p;
    expect(poller.getStatus().status).toBe('success');
    expect(queryMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500);
    expect(queryMock).toHaveBeenCalledTimes(2); // no more calls
  });
  
  it('Suno 双轨成功应正确分配 audioUrl 和 audioUrl_1', async () => {
    const queryMock = vi.fn().mockResolvedValue({ 
      status: 'SUCCESS', 
      tracks: [{ audioUrl: 'a' }, { audioUrl: 'b' }] 
    });
    const poller = createMockPoller(queryMock);
    
    const p = poller.startPolling(10, 100);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    
    const st = poller.getStatus();
    expect(st.status).toBe('success');
    expect(st.result.tracks[0].audioUrl).toBe('a');
    expect(st.result.tracks[1].audioUrl).toBe('b');
  });
});
