// ==UserScript==
// @name         T8 Doubao Image Sync (Anti-Refresh Edition)
// @namespace    http://tampermonkey.net/
// @version      5.4.2
// @description  启用二进制双盲管道：通过GM_xmlhttpRequest直接落盘大视频至后端Multer，彻底终结Base64卡顿与防盗链。
// @author       Antigravity
// @match        https://www.doubao.com/chat/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_log
// @connect      127.0.0.1
// @connect      localhost
// @connect      byteimg.com
// @connect      douyinvod.com
// @connect      snssdk.com
// @connect      volces.com
// @connect      doubao.com
// @sandbox      JavaScript
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  // ============================================================
  // 配置
  // ============================================================
  const DEBUG = true;
  const CONFIG = {
    pollUrl: 'http://127.0.0.1:18766/api/bridge/pull',
    pushUrl: 'http://127.0.0.1:18766/api/bridge/push',
    pushMediaUrl: 'http://127.0.0.1:18766/api/bridge/push-media',
    pushUrlUrl: 'http://127.0.0.1:18766/api/bridge/push-url',  // 【新增】高速 URL 推送通道
    downloadAlertUrl: 'http://127.0.0.1:18766/api/bridge/download-alert',
    logUrl: 'http://127.0.0.1:18766/api/bridge/log',
    taskTimeoutMs: 600000,
    debug: false,
    pollIntervalMin: 500,
    pollIntervalMax: 1000
  };

  // ============================================================
  // 安全跨端日志：输出到后端黑框终端，绝对不在网页控制台裸奔
  function log(...args) {
    const msg = args.join(' ');

    // 【物理静音】无论配置如何，绝不调用原生或任何形式的前端控制台输出，防大厂探针
    // 只走特权隧道发送到后端的终端
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.logUrl,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ level: 'info', message: msg })
      });
    } catch (e) {}

    // 如果网页调试端开启了，也向网页输出
    if (typeof debugLog === 'function') debugLog(`<span style="color:#aaa;">${msg}</span>`);
  }

  // ============================================================
  // DOM 选择器（带版本号，方便网页改版时定位更新）
  // ============================================================
  const DOM_SELECTORS = {
    version: '2026.06',
    inputBox: [
      'textarea[data-testid="chat-input"]',
      '#chat-input',
      'textarea[placeholder*="输入"]',
      'textarea',
      '[contenteditable="true"]'
    ],
    // 发送按钮选择器（优先级从高到低）
    sendButton: [
      'button[data-testid="send-button"]',
      'button[type="submit"]',
      'form button:last-of-type'
    ],
    chatContainer: [
      '[data-testid="chat-message-list"]',
      '.chat-message-container',
      'main',
      'body'
    ],
    // AI 回复气泡选择器（排除用户自己发的消息）
    aiBubble: [
      '[data-message-id]:not(.justify-end)',
      '[class*="assistant"]',
      '[class*="ai-message"]',
      '[class*="bot-message"]'
    ]
  };

  // ============================================================
  // 状态
  // ============================================================
  let isAutoSyncEnabled = GM_getValue('autoSync', true);
  let isPolling = false;
  let currentTaskId = localStorage.getItem('doubao_currentTaskId') || null;
  let currentTaskModel = localStorage.getItem('doubao_currentTaskModel') || null;
  let lastActiveTaskId = localStorage.getItem('doubao_lastActiveTaskId') || null;
  let taskTimeoutTimer = null;
  let interactionInProgress = false; // 互斥锁：主流程执行中禁止抓图
  const processedImages = new Set();

  // 弱引用缓存：绑定 DOM元素 -> taskId，绝对隐身不改 HTML
  const mediaTaskMap = new WeakMap();

  // ============================================================
  // 调试浮层面板 UI (方便用户定位漏抓问题)
  // ============================================================
  let debugPanel = null;
  let debugToggleButton = null;

  function initDebugPanel() {
    if (document.getElementById('web-agent-debug-panel')) return;

    // 创建一个浮动的展开/关闭按钮
    debugToggleButton = document.createElement('div');
    Object.assign(debugToggleButton.style, {
      position: 'fixed',
      bottom: '10px',
      right: '10px',
      backgroundColor: '#333',
      color: '#0f0',
      padding: '5px 10px',
      borderRadius: '5px',
      cursor: 'pointer',
      zIndex: '9999999',
      fontFamily: 'monospace',
      fontSize: '12px',
      boxShadow: '0 0 5px rgba(0,255,0,0.5)'
    });
    debugToggleButton.innerText = '🐛 开启画布雷达日志';
    document.body.appendChild(debugToggleButton);

    debugPanel = document.createElement('div');
    debugPanel.id = 'web-agent-debug-panel';
    Object.assign(debugPanel.style, {
      position: 'fixed',
      bottom: '40px',
      right: '10px',
      width: '450px',
      height: '350px',
      backgroundColor: 'rgba(0, 0, 0, 0.85)',
      color: '#0f0',
      fontFamily: 'monospace',
      fontSize: '12px',
      padding: '10px',
      overflowY: 'auto',
      zIndex: '9999999',
      border: '1px solid #0f0',
      display: 'none',
      pointerEvents: 'none'
    });
    document.body.appendChild(debugPanel);

    debugToggleButton.addEventListener('click', () => {
      if (debugPanel.style.display === 'none') {
        debugPanel.style.display = 'block';
        debugToggleButton.innerText = '🐛 关闭雷达日志';
      } else {
        debugPanel.style.display = 'none';
        debugToggleButton.innerText = '🐛 开启画布雷达日志';
      }
    });

    GM_registerMenuCommand("🔍 Toggle Click Debug Panel", () => {
      debugToggleButton.click();
    });
  }

  // 立即在页面加载时注入小按钮
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDebugPanel);
  } else {
    initDebugPanel();
  }

  function debugLog(msg) {
    if (!debugPanel) return;
    const line = document.createElement('div');
    line.style.borderBottom = '1px dashed #333';
    line.style.paddingBottom = '3px';
    line.style.marginBottom = '3px';
    line.innerHTML = `[${new Date().toLocaleTimeString()}] ${msg}`;
    debugPanel.appendChild(line);
    if (debugPanel.childElementCount > 50) debugPanel.removeChild(debugPanel.firstChild);
    debugPanel.scrollTop = debugPanel.scrollHeight;
  }

  // ============================================================
  // 旁路预警防空雷达 (0 风控事件代理)
  // ============================================================
  document.addEventListener('click', (e) => {
    // 【移除拦截】无论是全自动还是手动模式，雷达必须永久在线，用于捕获用户的物理点击！

    // 逆向遍历寻找带有 taskId 烙印的祖先元素
    let el = e.target;
    let foundTaskId = null;
    let limit = 15; // 搜索深度

    while (el && el !== document.body && limit > 0) {
      if (mediaTaskMap.has(el)) {
        foundTaskId = mediaTaskMap.get(el);
        break;
      }
      el = el.parentElement;
      limit--;
    }

    // 【终极降维打击】：空间坐标碰撞法！如果根据DOM树找不到烙印（因为悬浮栏可能被渲染为同级兄弟节点）
    // 我们直接遍历页面上所有带烙印的 img 图片，看看当前鼠标点击的屏幕位置 (e.clientX, e.clientY) 是否落在这张图片区域内！
    let hitMethod = foundTaskId ? 'DOM Tree' : 'None';
    if (!foundTaskId) {
       const imgs = document.querySelectorAll('img');
       for (const img of imgs) {
          if (mediaTaskMap.has(img)) {
             const rect = img.getBoundingClientRect();
             // 考虑到悬浮工具栏可能稍微超出图片边缘，我们向下和向外扩展 40px 的包围盒容差
             const expand = 40;
             if (e.clientX >= rect.left - expand && e.clientX <= rect.right + expand &&
                 e.clientY >= rect.top - expand && e.clientY <= rect.bottom + expand) {
                 foundTaskId = mediaTaskMap.get(img);
                 hitMethod = 'Spatial Collision';
                 break;
             }
          }
       }
    }

    // 【最强兜底策略】：如果在 DOM 树里找不到，空间碰撞也没碰到。通常是因为这是生图结束后的补点动作，
    // 而生图结束时 currentTaskId 会被清空，导致后续渲染的悬浮栏根本没机会打烙印！
    // 没关系，只要你在这个单页面应用里跑过最近一次画布任务，点下载就默认是给它的！
    if (!foundTaskId && lastActiveTaskId) {
       foundTaskId = lastActiveTaskId;
       hitMethod = 'Memory Fallback (Last Task)';
    }

    let debugMsg = `Click: <b>&lt;${e.target.tagName.toLowerCase()}&gt;</b> class='${e.target.className || ''}'<br>`;
    debugMsg += `TaskId Mapped: <span style="color:${foundTaskId ? '#0f0' : 'red'}">${foundTaskId || 'None'}</span> <span style="color:#888">(${hitMethod})</span><br>`;

    if (foundTaskId) {
      // 确认点击的是否是操作按钮（允许 button, svg 以及豆包特殊的 hover-show-tag 悬浮工具栏按钮，排除 a 标签防止误触）
      // 【新增】对视频的 hover 按钮增加 class 拦截 video-hover-button-group
      const isDownloadAction = e.target.closest('button, svg, [role="button"], [class*="download"], [class*="save"], [aria-label*="下载"], [aria-label*="保存"], [title*="下载"], [title*="保存"], [class*="hover-show-tag"] div, [class*="hover-DQYL"], [class*="video-hover-button-group"]');

      debugMsg += `isDownloadAction: <span style="color:${isDownloadAction ? '#0f0' : 'orange'}">${!!isDownloadAction}</span>`;

      if (isDownloadAction) {
        log(`[Agent] Detected manual download trigger. Emitting alert for task: ${foundTaskId}`);
        try {
          GM_xmlhttpRequest({
            method: 'POST',
            url: CONFIG.downloadAlertUrl,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ taskId: foundTaskId })
          });
          debugMsg += ` => <b>Alert Emitted!</b>`;
        } catch (err) {}
      }
    }
    debugLog(debugMsg);
  }, { capture: true, passive: true });


  // ============================================================
  // 防风控：拟人化时间引擎
  // ============================================================

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 对数正态分布随机延迟
  function humanDelay(medianMs, spreadFactor = 0.4) {
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const logMedian = Math.log(medianMs);
    const delay = Math.exp(logMedian + spreadFactor * z);
    return Math.max(100, Math.min(delay, medianMs * 5));
  }

  // 均匀随机延迟（轻量级场景使用）
  function randomDelay(min, max) {
    return sleep(min + Math.random() * (max - min));
  }

  // 拟人化犹豫（0.3s~1.5s）
  function humanHesitation() {
    return sleep(humanDelay(600, 0.5));
  }

  // ============================================================
  // 防风控：贝塞尔曲线鼠标轨迹模拟
  // ============================================================

  function getElementCenter(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2 + (Math.random() - 0.5) * rect.width * 0.3,
      y: rect.top + rect.height / 2 + (Math.random() - 0.5) * rect.height * 0.3
    };
  }

  function bezierPoint(t, p0, p1, p2) {
    const u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y
    };
  }

  async function simulateMouseApproach(targetEl) {
    try {
      const target = getElementCenter(targetEl);
      const start = {
        x: target.x + (Math.random() - 0.5) * 400,
        y: target.y + (Math.random() - 0.5) * 300
      };
      const control = {
        x: (start.x + target.x) / 2 + (Math.random() - 0.5) * 150,
        y: (start.y + target.y) / 2 + (Math.random() - 0.5) * 100
      };
      const steps = 8 + Math.floor(Math.random() * 6);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const easedT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const pt = bezierPoint(easedT, start, control, target);
        targetEl.dispatchEvent(new MouseEvent('mousemove', {
          clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true
        }));
        await sleep(15 + Math.random() * 25);
      }
    } catch (e) { /* 静默 */ }
  }

  // ============================================================
  // 防风控：空闲活跃度伪装
  // ============================================================

  function simulateIdleScroll() {
    try {
      const chatContainer = getDoubaoChatContainer();
      if (chatContainer && chatContainer !== document.body) {
        chatContainer.scrollTop += (Math.random() - 0.3) * 80;
      }
    } catch (e) { /* 静默 */ }
  }

  async function idleActivitySimulator() {
    while (true) {
      await sleep(15000 + Math.random() * 30000);
      if (!currentTaskId) simulateIdleScroll();
    }
  }

  // ============================================================
  // 菜单
  // ============================================================

  function updateMenus() {
    GM_registerMenuCommand(`Toggle Auto Sync: ${isAutoSyncEnabled ? 'ON 🟢' : 'OFF 🔴'}`, () => {
      isAutoSyncEnabled = !isAutoSyncEnabled;
      GM_setValue('autoSync', isAutoSyncEnabled);
      alert(`Auto Sync is now ${isAutoSyncEnabled ? 'ON' : 'OFF'}`);
      location.reload();
    });
  }
  updateMenus();

  // ============================================================
  // 错误上报（静默通道）
  // ============================================================

  async function reportError(errorMsg) {
    log('Error:', errorMsg);
    if (currentTaskId) {
      await pushResult(currentTaskId, 'failed', null, errorMsg);
      clearTaskState();
    } else {
      GM_xmlhttpRequest({
        method: 'POST', url: CONFIG.pushUrl,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ taskId: 'ALERT', status: 'error', error: errorMsg })
      });
    }
  }

  window.addEventListener('error', (event) => {
    if (event.filename && event.filename.includes('tampermonkey')) {
      reportError(`Global: ${event.message}`);
    }
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError(`Rejection: ${event.reason}`);
  });

  // ============================================================
  // 网络层：隐身轮询（指数退避 + 抖动）
  // ============================================================

  async function pollTasks() {
    if (isPolling) return;
    isPolling = true;

    while (true) {
      try {
        const response = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET', url: CONFIG.pollUrl, timeout: 35000,
            onload: (res) => resolve(res),
            onerror: (err) => reject(err),
            ontimeout: () => resolve(null)
          });
        });

        if (response && response.status === 200) {
          const data = JSON.parse(response.responseText);
          if (data && data.task) {
            log('Received task:', data.task.id);
            await handleTask(data.task);
          }
        }
      } catch (e) {
        // 出错时给予 2 秒喘息，防止刷屏死锁
        await sleep(2000);
      }

      // 【零延迟挂起】无论后端是 25 秒超时返回空，还是刚执行完任务，立刻发起下一次挂起
      await sleep(100);
    }
  }

  async function pushResult(taskId, status, base64Data = null, error = null) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST', url: CONFIG.pushUrl,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ taskId, status, base64Data, error }),
        onload: () => resolve(true),
        onerror: () => resolve(false)
      });
    });
  }

  function clearTaskState() {
    currentTaskId = null;
    currentTaskModel = null;
    localStorage.removeItem('doubao_currentTaskId');
    localStorage.removeItem('doubao_currentTaskModel');
    interactionInProgress = false;
    if (taskTimeoutTimer) {
      clearTimeout(taskTimeoutTimer);
      taskTimeoutTimer = null;
    }
  }

  // ============================================================
  // 仿生交互引擎
  // ============================================================

  // --- 文件获取 ---
  async function fetchUrlAsFile(url, filename = 'reference.png') {
    return new Promise((resolve, reject) => {
      if (url.startsWith('data:')) {
        try {
          const matches = url.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
          if (matches && matches.length === 3) {
            const mime = matches[1];
            const byteCharacters = atob(matches[2]);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blobObj = new Blob([byteArray], { type: mime });
            resolve(new File([blobObj], filename, { type: mime }));
          } else {
            reject(new Error('Invalid data URI'));
          }
        } catch (e) { reject(e); }
        return;
      }

      GM_xmlhttpRequest({
        method: 'GET', url: url, responseType: 'blob',
        onload: (res) => {
          if (res.status === 200) {
            resolve(new File([res.response], filename, { type: res.response.type }));
          } else {
            reject(new Error(`Fetch image failed: ${res.status}`));
          }
        },
        onerror: (err) => reject(err)
      });
    });
  }

  // --- 焦点生命周期文件注入（从参考脚本吸取） ---
  async function simulateFileInputUpload(inputElement, url) {
    const file = await fetchUrlAsFile(url);
    const dt = new DataTransfer();
    dt.items.add(file);

    // 1. 模拟 Tab 焦点硬转移（唤醒 React 框架的事件监听器）
    inputElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', keyCode: 9, bubbles: true
    }));
    inputElement.focus({ preventScroll: true });
    inputElement.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await randomDelay(80, 150);

    // 2. 单文件注入
    inputElement.files = dt.files;
    await randomDelay(50, 100);

    // 3. 严格按真实顺序提交事件
    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    await randomDelay(30, 60);
    inputElement.dispatchEvent(new Event('change', { bubbles: true }));

    // 4. 散焦退出（完成焦点生命周期）
    await randomDelay(80, 150);
    inputElement.blur();
    inputElement.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  // --- 拖拽模拟（降级方案，含事件间微延迟） ---
  async function simulateDrop(element, url) {
    const file = await fetchUrlAsFile(url);
    const dt = new DataTransfer();
    dt.items.add(file);

    const events = ['dragenter', 'dragover', 'drop'];
    for (const eventType of events) {
      element.dispatchEvent(new DragEvent(eventType, {
        bubbles: true, cancelable: true, dataTransfer: dt
      }));
      await sleep(30 + Math.random() * 50);
    }
  }

  // --- 极速引擎（保留 5.3.0 原版逻辑但去除所有降速模拟） ---
  async function simulateHumanTyping(element, text) {
    element.focus();
    await randomDelay(50, 100);

    let i = 0;
    while (i < text.length) {
      // 改为极大块一次性输入，实现粘贴效果
      const chunkSize = text.length;
      const chunk = text.slice(i, i + chunkSize);

      const success = document.execCommand('insertText', false, chunk);
      if (!success) {
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true, cancelable: true, clipboardData: new DataTransfer()
        });
        pasteEvent.clipboardData.setData('text/plain', chunk);
        element.dispatchEvent(pasteEvent);

        const tracker = element._valueTracker;
        if (tracker) tracker.setValue('');
        
        // 【保险兜底】防患于未然：兼容未来的 contenteditable 富文本结构
        if ('value' in element) {
          element.value = (element.value || '') + chunk;
        } else {
          element.textContent = (element.textContent || '') + chunk;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }

      i += chunk.length;
      await sleep(10); // 极短的底层缓冲
    }
  }

  // --- 发送（纯净防风控：仅模拟回车键发送，永不点击按钮） ---
  async function simulateSend(inputBox) {
    log('Sending message via simulated Enter key...');
    const keyProps = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    };
    inputBox.dispatchEvent(new KeyboardEvent('keydown', keyProps));
    await sleep(40 + Math.random() * 60);
    inputBox.dispatchEvent(new KeyboardEvent('keyup', keyProps));
    log('Sent via Enter key.');
  }

  function findSendButton(inputBox) {
    // 从输入框的祖先容器中寻找发送按钮
    const form = inputBox.closest('form');
    if (form) {
      for (const sel of DOM_SELECTORS.sendButton) {
        const btn = form.querySelector(sel);
        if (btn) return btn;
      }
    }

    const wrapper = inputBox.closest(
      '[class*="input"], [class*="composer"], [class*="chat-input"], footer'
    );
    if (wrapper) {
      const btn = wrapper.querySelector('button');
      if (btn) return btn;
    }

    for (const sel of DOM_SELECTORS.sendButton) {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  // ============================================================
  // 豆包页面适配器
  // ============================================================

  function findElementBySelectors(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function getDoubaoInputBox() {
    return findElementBySelectors(DOM_SELECTORS.inputBox);
  }

  function getDoubaoUploadArea() {
    const el = findElementBySelectors(DOM_SELECTORS.inputBox);
    if (el && el.tagName === 'TEXTAREA') return el.parentElement;
    return el;
  }

  function getDoubaoChatContainer() {
    return findElementBySelectors(DOM_SELECTORS.chatContainer);
  }

  // 判断一个图片元素是否处于 AI 回复气泡中（核心：隔离原图误抓）
  function isInsideAiBubble(imgElement) {
    for (const sel of DOM_SELECTORS.aiBubble) {
      const bubble = imgElement.closest(sel);
      if (bubble) return true;
    }

    let parent = imgElement.parentElement;
    let depth = 0;
    while (parent && depth < 15) {
      const style = window.getComputedStyle(parent);
      const cls = parent.className || '';

      if (style.justifyContent === 'flex-end' || style.textAlign === 'right') return false;
      if (/\b(user|self|human|justify-end|sent)\b/i.test(cls)) return false;

      if (/\b(assistant|bot|ai|received|model)\b/i.test(cls)) return true;

      if (parent.hasAttribute('data-message-id')) {
        return !/justify-end/i.test(cls);
      }

      parent = parent.parentElement;
      depth++;
    }
    return false;
  }

  // ============================================================
  // 任务处理主流程
  // ============================================================

  async function handleTask(task) {
    currentTaskId = task.id;
    lastActiveTaskId = task.id;
    localStorage.setItem('doubao_currentTaskId', currentTaskId);
    localStorage.setItem('doubao_lastActiveTaskId', lastActiveTaskId);
    interactionInProgress = true; 
    const { prompt, images, model } = task.payload;
    currentTaskModel = model; // 保存模型身份（生图 vs 生视频）
    localStorage.setItem('doubao_currentTaskModel', currentTaskModel);

    // 快照当前页面所有图片
    snapshotAllImages();

    // 超时保护
    taskTimeoutTimer = setTimeout(() => {
      if (currentTaskId === task.id) {
        reportError(`Task Timeout: Exceeded ${CONFIG.taskTimeoutMs / 1000}s`);
      }
    }, CONFIG.taskTimeoutMs);

    try {
      const inputBox = getDoubaoInputBox();
      if (!inputBox) {
        throw new Error(`Selector outdated (v${DOM_SELECTORS.version}): input not found.`);
      }

      // --- 步骤0：标记含图任务 --- //
      const hasImages = (images && images.length > 0);

      // --- 步骤1：触发文件注入 --- //
      if (images && images.length > 0) {
        await simulateMouseApproach(inputBox);

        const fileInput = document.querySelector('input[type="file"][accept*="image"]')
                       || document.querySelector('input[type="file"]');

        if (fileInput) {
          log('Uploading via file input with focus lifecycle...');
          for (const imgUrl of images) {
            await simulateFileInputUpload(fileInput, imgUrl);
            await randomDelay(500, 1000);
          }
        } else {
          const uploadArea = getDoubaoUploadArea();
          if (!uploadArea) throw new Error('Upload area not found.');
          await simulateMouseApproach(uploadArea);
          log('Fallback: uploading via drag&drop...');
          for (const imgUrl of images) {
            await simulateDrop(uploadArea, imgUrl);
            await randomDelay(500, 1000);
          }
        }

        await randomDelay(800, 1200);
      }

      // --- 步骤2：碎片化打字 ---
      await simulateMouseApproach(inputBox);
      await simulateHumanTyping(inputBox, prompt || 'Hello');
      await humanHesitation();

      // --- 步骤2.5：视觉层嗅探，死磕上传指示器 ---
      if (hasImages) {
        log('Awaiting DOM visual layer confirmation for upload completion...');
        await waitForUploadComplete();
        log('DOM indicates upload is clear. Waiting randomly for UI finalize...');
        await randomDelay(1000, 2000);
      }

      // --- 步骤3：发送 ---
      await simulateSend(inputBox);

      // --- 步骤4：发送后等待渲染 + 重新快照 ---
      await sleep(humanDelay(4000, 0.3));
      snapshotAllImages();

      interactionInProgress = false;
      await pushResult(currentTaskId, 'running');

    } catch (e) {
      interactionInProgress = false;
      await reportError(`Task failed: ${e.message}`);
    }
  }


  function snapshotAllImages() {
    try {
      const chatContainer = getDoubaoChatContainer() || document.body;
      chatContainer.querySelectorAll('img, video').forEach(el => {
        const src = el.src || (el.querySelector('source') ? el.querySelector('source').src : null);
        if (src) processedImages.add(src);
      });
      log('Snapshot media. Set size:', processedImages.size);
    } catch (e) { /* 静默 */ }
  }

  // ============================================================
  // 视觉底板嗅探器 (精准等待图片上传完成)
  // ============================================================
  async function waitForUploadComplete() {
    const MAX_WAIT_MS = 30000;
    const intervalMs = 1000;
    let elapsed = 0;

    // 核心缺陷修复：给前端 React 框架留出渲染进度圆圈的喘息时间
    // 否则刚注入图片，DOM 还没来得及长出圆圈，就会被错误地秒判通过！
    log('Waiting 1000ms for Doubao UI to mount upload progress circles...');
    await sleep(1000);

    while (elapsed < MAX_WAIT_MS) {
      // 根据用户提供的真实 DOM 结构精准狙击：
      const loadingIndicators = document.querySelectorAll(
        '.semi-progress-circle-text, .semi-progress-circle-ring-inner, [class*="progress-circle"]'
      );
      
      let isLoading = false;
      for (const el of loadingIndicators) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.opacity !== '0' && style.visibility !== 'hidden') {
          isLoading = true;
          break;
        }
      }

      if (!isLoading) {
        log(`No visible progress elements found. Wait considered complete after ${elapsed}ms.`);
        return true;
      }
      
      log(`Still uploading... DOM semi-progress-circle detected. (${elapsed}ms elapsed)`);
      await sleep(intervalMs);
      elapsed += intervalMs;
    }
    
    log(`Warning: Wait for upload timed out after ${MAX_WAIT_MS}ms. Forcing proceed.`);
    return false;
  }

  // ============================================================
  // 网络底板嗅探器
  // ============================================================
  function createUploadSniffer(expectedCount) {
    let uploadedCount = 0;
    let isFinished = false;
    let silenceTimer = null;
    let finishResolver = null;
    const SILENCE_THRESHOLD = 2500; 

    const finish = () => {
      if (isFinished) return;
      isFinished = true;
      log(`[Sniffer] Network silence reached. Confirming ${uploadedCount} uploads finished.`);
      if (silenceTimer) clearTimeout(silenceTimer);
      if (finishResolver) finishResolver(true);
    };

    const resetSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      if (uploadedCount >= expectedCount) {
        silenceTimer = setTimeout(finish, SILENCE_THRESHOLD);
      }
    };

    const observer = new PerformanceObserver((list) => {
      if (isFinished) return;
      const entries = list.getEntries();
      for (const entry of entries) {
        if (entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') {
          const url = entry.name.toLowerCase();
          if (url.includes('upload') || url.includes('file') || url.includes('tos') || url.includes('image')) {
            if (entry.duration > 80) {
              uploadedCount++;
              log(`[Sniffer] Intercepted chunk/upload API (Duration: ${Math.round(entry.duration)}ms)`);
              resetSilenceTimer();
            }
          }
        }
      }
    });

    observer.observe({ entryTypes: ['resource'] });

    return {
      wait: (timeoutMs) => new Promise((resolve) => {
        if (isFinished) {
          log(`[Sniffer] Network was already silent. Confirming immediately.`);
          observer.disconnect();
          resolve(true);
          return;
        }
        finishResolver = (res) => {
          observer.disconnect();
          resolve(res);
        };
        setTimeout(() => {
          if (!isFinished) {
            log(`[Sniffer] Absolute timeout after ${timeoutMs}ms. Forcing proceed.`);
            isFinished = true;
            finishResolver(false);
          }
        }, timeoutMs);
      })
    };
  }

  async function checkPageForMedia() {
    if (!currentTaskId) return;
    if (interactionInProgress) return;

    try {
      const chatContainer = getDoubaoChatContainer() || document.body;
      const mediaElements = chatContainer.querySelectorAll('img, video');

      for (const el of mediaElements) {
        const url = el.src || (el.querySelector('source') ? el.querySelector('source').src : null);
        if (!url) continue;

        if (url.includes('avatar') || url.includes('icon') || url.includes('svg')) continue;
        if (url.includes('logo') || url.includes('emoji')) continue;
        if (processedImages.has(url)) continue;

        if (!isInsideAiBubble(el)) {
          processedImages.add(url);
          continue;
        }

        const isVideo = el.tagName === 'VIDEO';

        // 核心：防异种媒体混淆！严格的类型双向隔离！
        if (currentTaskModel === 'video' && !isVideo) continue;
        if (currentTaskModel !== 'video' && isVideo) continue;

        if (!isVideo) {
          if (!el.complete) {
            await new Promise(r => { el.onload = r; el.onerror = r; });
          }
          if (el.naturalWidth < 100 || el.naturalHeight < 100) continue;
        }

        processedImages.add(url);
        log(`Found AI-generated ${isVideo ? 'video' : 'image'}! Trying URL push first...`);

        const container = el.closest('[class*="message"], [class*="bubble"], .flex') || el.parentElement;
        if (!mediaTaskMap.has(el) && currentTaskId) {
          mediaTaskMap.set(el, currentTaskId);
          let p = el.parentElement;
          let depth = 0;
          while (p && p !== document.body && depth < 6) {
            mediaTaskMap.set(p, currentTaskId);
            p = p.parentElement;
            depth++;
          }
          log(`[Agent] Imprinted media card with taskId: ${currentTaskId}`);
        }

        // 【物理原媒体截获优先通道】针对图片和视频，分别进行严密的 DOM 选择器寻址，点击原生下载按钮转交看门狗打捞
        let downloadBtn = null;
        if (!isVideo) {
          const itemContainer = el.closest('[class*="image-box"]') || container;
          if (itemContainer) {
            const btns = itemContainer.querySelectorAll('[class*="hover-show-tag"] > div:not([class*="divider"])');
            if (btns.length > 0) {
              downloadBtn = btns[btns.length - 1]; // 图片的最后一个通常是下载按钮
            }
          }
        } else {
          const itemContainer = el.closest('[class*="video-box"], [class*="video-wrapper"], .flex') || container;
          if (itemContainer) {
            // 视频专属按钮选择器：防患于未然，抓取所有按钮取最后一个，防止未来出现"分享"干扰
            const vBtns = itemContainer.querySelectorAll('[class*="video-hover-button-group"] [class*="action-button"], button[aria-label*="下载"], button[title*="下载"], [class*="download"]');
            if (vBtns.length > 0) {
              downloadBtn = vBtns[vBtns.length - 1];
            }
          }
        }

        if (downloadBtn) {
          if (isAutoSyncEnabled) {
            log(`[Physical Media] Auto Sync ON: Auto clicking download button for ${isVideo ? 'video' : 'image'}...`);
            processedImages.add(url);
            downloadBtn.click(); // 触发豆包原生下载 -> 后端 Watchdog 接收
            clearTaskState();
            return true;
          } else {
            log(`[Physical Media] Auto Sync OFF: 媒体已加烙印。挂起等待用户手动点击下载...`);
            processedImages.add(url);
            continue; // 跳过当前循环，保留任务状态和打上的烙印
          }
        }

        // 【大一统优先通道】如果没找到下载按钮，或者是视频，全部直接尝试 URL 推送！
        if (isAutoSyncEnabled) {
            const urlSuccess = await pushUrlToBackend(url, currentTaskId);
            if (urlSuccess) {
              clearTaskState();
              return true;
            }
            
            log(`[URL Push] 降级：用二进制流备用...`);

            // URL 推送失败时才用二进制流
            const success = await downloadAndPushBinaryMedia(url, currentTaskId);
            if (success) {
              clearTaskState();
              return true;
            }
        } else {
            // 在手动模式下，视频或其他媒体也被标记挂起，等待用户自行决定。
            processedImages.add(url);
        }
      }
    } catch (e) { /* 静默 */ }
    return false; 
  }

  function pushUrlToBackend(url, taskId) {
    log(`[URL Push] 推送媒体 URL 到后端直接下载: ${url.substring(0, 80)}...`);
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.pushUrlUrl,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ taskId, url, status: 'completed' }),
        timeout: 5000,
        onload: (res) => {
          log(`[URL Push] 后端确认收到 URL. Status: ${res.status}`);
          resolve(res.status === 200);
        },
        onerror: () => {
          log(`[URL Push] 失败，降级到二进制流...`);
          resolve(false);
        },
        ontimeout: () => {
          log(`[URL Push] 超时，降级到二进制流...`);
          resolve(false);
        }
      });
    });
  }

  async function downloadAndPushBinaryMedia(url, taskId) {
    log(`[Binary Stream] Initiating privileged download for: ${url}`);
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'blob',
        onload: (res) => {
          if (res.status === 200 && res.response) {
            log(`[Binary Stream] Blob secured. Size: ${(res.response.size / 1024 / 1024).toFixed(2)} MB`);
            const fd = new FormData();
            fd.append('taskId', taskId);
            fd.append('status', 'completed');

            let ext = '.mp4';
            if (res.response.type) {
              if (res.response.type.includes('image')) ext = res.response.type.includes('jpeg') ? '.jpg' : '.png';
              else if (res.response.type.includes('video')) ext = res.response.type.includes('webm') ? '.webm' : '.mp4';
            } else if (!url.includes('video') && !url.includes('.mp4')) {
              ext = '.jpg';
            }

            fd.append('media', res.response, `media${ext}`);

            log(`[Binary Stream] Pushing binary blob to bridge...`);
            GM_xmlhttpRequest({
              method: 'POST',
              url: CONFIG.pushMediaUrl,
              data: fd,
              onload: (pushRes) => {
                log(`[Binary Stream] Transfer complete. Status: ${pushRes.status}`);
                resolve(pushRes.status === 200);
              },
              onerror: () => {
                log(`[Binary Stream] Transfer failed.`);
                resolve(false);
              }
            });
          } else {
            resolve(false);
          }
        },
        onerror: () => resolve(false)
      });
    });
  }

  // ============================================================
  // 结果媒体下行嗅探器
  // ============================================================

  let resultDebounceTimer = null;

  function initResultMediaSniffer() {
    log('Initializing Global Media Response Sniffer (Zero Polling)...');
    const observer = new PerformanceObserver((list) => {
      if (!currentTaskId || interactionInProgress) return;

      const entries = list.getEntries();
      let hasSuspect = false;
      for (const entry of entries) {
        const type = entry.initiatorType;
        const name = entry.name.toLowerCase();

        if (type === 'img' || type === 'video' || type === 'css' || type === 'fetch' || type === 'xmlhttprequest') {
          if (!name.includes('avatar') && !name.includes('icon') && !name.includes('svg') && !name.includes('logo')) {
            hasSuspect = true;
            break;
          }
        }
      }

      if (hasSuspect) {
        clearTimeout(resultDebounceTimer);
        const randomDebounce = Math.floor(Math.random() * 1000) + 500;

        resultDebounceTimer = setTimeout(async () => {
          log(`[Event Driven] Downlink media detected. Waking up after ${randomDebounce}ms to harvest...`);
          for (let i = 0; i < 2; i++) {
             const success = await checkPageForMedia();
             if (success || !currentTaskId) {
                 log('[Event Driven] Harvest success and target secured.');
                 break;
             }
             if (i < 1) await sleep(500); 
          }
        }, randomDebounce);
      }
    });

    observer.observe({ entryTypes: ['resource'] });
  }

  // ============================================================
  // 启动
  // ============================================================

  function bootstrap() {
    log('Event-Driven Stealth Bridge V5 initialized.');
    initResultMediaSniffer(); 
    pollTasks();
    idleActivitySimulator();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(bootstrap, 1500 + Math.random() * 2000);
    });
  } else {
    setTimeout(bootstrap, 1500 + Math.random() * 2000);
  }

})();
