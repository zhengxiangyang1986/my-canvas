// ====== DOUBAO WEB AGENT BRIDGE (可随时安全移除) ======
import { useEffect } from 'react';

/**
 * 这是一个隐形的无头组件，只用于挂载后台全局监听。
 * 它连接到后端的 SSE 事件流，并在油猴脚本推送 rawUrls (通常是真实的本地视频/原图地址) 时
 * 抛出自定义事件 bridge-raw-urls，各节点在内部监听此事件来更新自身属性。
 */
export default function DoubaoBridgeListener() {
  useEffect(() => {
    const eventSource = new EventSource('/api/bridge/events');

    const handleRawUrls = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.taskId && Array.isArray(data.rawUrls)) {
          window.dispatchEvent(new CustomEvent('bridge-raw-urls', { detail: data }));
        }
      } catch (err) {
        console.error('DoubaoBridgeListener parse error:', err);
      }
    };

    eventSource.addEventListener('rawUrls', handleRawUrls);

    eventSource.onerror = () => {
      // 静默重连
    };

    return () => {
      eventSource.removeEventListener('rawUrls', handleRawUrls);
      eventSource.close();
    };
  }, []);

  return null;
}
// ====================================================
