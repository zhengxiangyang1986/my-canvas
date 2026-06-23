// ==UserScript==
// @name         T8 Doubao Image Sync (Anti-Refresh Edition)
// @namespace    http://tampermonkey.net/
// @version      5.9.0
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

(function () {
  'use strict';

  // ============================================================
  // 配置
  // ============================================================
  const CONFIG = {
    // 轮询池：保持在 127.0.0.1（与画板 UI 共享连接池，因为它的生命周期长，属于后台维持）
    pollUrl: 'http://127.0.0.1:18766/api/bridge/pull?target=web-agent-doubao',
    // 推送池：全部改为 localhost！这会在浏览器底层强制开辟第二条完全独立的 6 线程连接池，
    // 彻底防止大图预警/日志请求被长时间的轮询 (pull) 或画板的 SSE 阻塞队列！
    pushUrl: 'http://localhost:18766/api/bridge/push',
    logUrl: 'http://localhost:18766/api/bridge/log',
    taskTimeoutMs: 600000,
    debug: false,
    pollIntervalMin: 500,
    pollIntervalMax: 1000
  };

  // ============================================================
  // 安全跨端日志：输出到后端黑框终端，绝对不在网页控制台裸奔
  function log(...args) {
    const msg = args.join(' ');

    // 主要日志过滤，防止高频心跳或底层重复的 Downlink 拦截信息堵塞真正的网络请求队列
    const isKeyLog = msg.includes('[Physical Media]') ||
                      msg.includes('[URL Push]') ||
                      msg.includes('[Binary Stream]') ||
                      msg.includes('[Alert]') ||
                      msg.includes('[Agent]') ||
                      msg.includes('Found AI-generated') ||
                      msg.includes('Error:') ||
                      msg.includes('stealth bridge') ||
                      msg.includes('initialized');

    if (CONFIG.debug || isKeyLog) {
      try {
        GM_xmlhttpRequest({
          method: 'POST',
          url: CONFIG.logUrl,
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ level: 'info', message: msg }),
          timeout: 2000
        });
      } catch (e) { }
    }

    // 直接输出到画布内部雷达浮层，不在真实浏览器的控制台留痕（反风控要求）
    if (typeof debugLog === 'function') debugLog(`<span style="color:#aaa;">${msg}</span>`);
  }

  // ============================================================
  // DOM 选择器（带版本号，方便网页改版时定位更新）
  // ============================================================
  const DOM_SELECTORS = {
    version: '2026.06',
    inputBox: [
      'textarea[placeholder*="描述"]',
      '[contenteditable="true"][placeholder*="描述"]',
      '#semi-input-textarea-autosize',
      'textarea[data-testid="chat-input"]',
      'textarea[placeholder*="消息"]',
      '.semi-input-textarea',
      '.chat-input textarea',
      '#chat-input',
      'textarea[placeholder*="输入"]',
      'textarea',
      '[contenteditable="true"]'
    ],
    // 发送按钮选择器（优先级从高到低）
    sendButton: [
      '#flow-end-msg-send',
      'button[data-testid="send-button"]',
      '[id*="send-msg-btn"]',
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
  let interactionInProgress = false; // 互斥锁：主流程执行中禁止抓图
  let pendingMediaCheck = false; // 挂起标志：解决锁定时渲染完成的媒体漏抓
  const processedImages = new Set();
  
  // -- 新的生命周期控制 --
  let activeTasks = {}; // taskId -> { prompt, timer }
  let activeTasksCount = 0;
  let lastDispatchedTaskId = localStorage.getItem('doubao_lastDispatchedTaskId') || null;

  // 终极防错：基于豆包 data-message-id 的 DOM 实体强绑定字典
  let messageTaskMap = {};
  try {
    messageTaskMap = JSON.parse(localStorage.getItem('doubao_messageTaskMap')) || {};
  } catch(e) {}
  function saveMessageTask(messageId, taskId) {
    if (!messageId || !taskId) return;
    messageTaskMap[messageId] = taskId;
    const keys = Object.keys(messageTaskMap);
    if (keys.length > 200) delete messageTaskMap[keys[0]]; // 限制大小，防止挤爆 localStorage
    localStorage.setItem('doubao_messageTaskMap', JSON.stringify(messageTaskMap));
  }

  // 历史提示词字典：防止任务超时被清理后，仍能通过提示词夺回主权
  let taskPromptsMap = {};
  try {
    taskPromptsMap = JSON.parse(localStorage.getItem('doubao_taskPromptsMap')) || {};
  } catch(e) {}
  function saveTaskPrompt(taskId, prompt) {
    if (!taskId || !prompt) return;
    taskPromptsMap[taskId] = prompt;
    const keys = Object.keys(taskPromptsMap);
    if (keys.length > 200) delete taskPromptsMap[keys[0]]; // 扩容到 200，必须与 messageTaskMap 保持一致，防止老任务落榜被错误覆盖！
    localStorage.setItem('doubao_taskPromptsMap', JSON.stringify(taskPromptsMap));
  }

  // 历史已下载媒体防重下字典（核心：防止刷新后滚动历史记录导致重新疯狂下载！）
  let completedMediaMap = {};
  try {
    completedMediaMap = JSON.parse(localStorage.getItem('doubao_completedMediaMap')) || {};
  } catch(e) {}
  
  function getStableMediaUrl(url) {
    if (!url) return '';
    if (url.startsWith('data:') || url.startsWith('blob:')) return url; // blob/data 每次刷新必然变化，不追求跨页持久化
    try {
      const u = new URL(url);
      return u.origin + u.pathname; // 剔除所有的临时签名和时间戳参数（如 ?x-expires=xxx）
    } catch(e) {
      return url.split('?')[0]; // fallback
    }
  }

  function markMediaAsCompleted(url) {
    const stableUrl = getStableMediaUrl(url);
    if (!stableUrl) return;
    completedMediaMap[stableUrl] = true;
    const keys = Object.keys(completedMediaMap);
    if (keys.length > 500) delete completedMediaMap[keys[0]]; // 维持500个历史记录限制
    localStorage.setItem('doubao_completedMediaMap', JSON.stringify(completedMediaMap));
  }

  // ============================================================
  // 提示词清洗与提取引擎
  // ============================================================
  function cleanPromptText(text) {
    if (!text) return '';
    return text.replace(/[\u200B-\u200D\uFEFF]/g, '') // 移除零宽字符
               .replace(/\s+/g, '')                  // 移除所有空白符
               .replace(/[.,!?;:'"()\[\]{}<>\/\\|~`@#$%^&*\-_=+，。！？；：“”‘’（）《》【】]/g, '') // 移除中英文标点
               .toLowerCase();                       // 统一转小写
  }

  function extractPromptFromBubble(bubbleEl) {
    if (!bubbleEl) return '';
    
    // 核心改进：极其精准的“前序兄弟节点”扫描（绝不越界跨消息！）
    // 如果用 parentElement 无限制向上溯源，会导致点击普通图文消息时，
    // 误吸取到整个聊天列表里最早的那条视频提示词！
    
    // 1. 先在自己肚子里找（防以后豆包结构变动）
    let quoteEl = bubbleEl.querySelector('.hyphens-auto.truncate');
    
    // 2. 如果自己肚子里没有，就只找自己“头顶上”的亲兄弟！
    // 提示词引用框在 DOM 结构中，永远位于视频框的上方（也就是它的 previousElementSibling）
    if (!quoteEl) {
      let sibling = bubbleEl.previousElementSibling;
      while (sibling && !quoteEl) {
        if (sibling.classList && sibling.classList.contains('hyphens-auto') && sibling.classList.contains('truncate')) {
          quoteEl = sibling;
        } else {
          quoteEl = sibling.querySelector('.hyphens-auto.truncate');
        }
        sibling = sibling.previousElementSibling; // 继续往上一个兄弟节点找
      }
    }

    if (quoteEl) {
      const text = quoteEl.textContent || '';
      if (text.includes('生成视频')) {
        return text; 
      }
    }
    
    return '';
  }

  function findTaskIdByBubble(bubbleEl) {
    if (!bubbleEl) return null;
    
    // 1. 获取 DOM 出生时的打底烙印（Unified Observer 留下的，或之前成功映射的）
    const msgId = bubbleEl.getAttribute('data-message-id');
    const stampedTaskId = msgId ? messageTaskMap[msgId] : null;

    // 2. 尝试提取气泡中的提示词（针对视频等异步任务）
    const rawBubbleText = extractPromptFromBubble(bubbleEl);
    
    if (rawBubbleText) {
      const cleanedBubbleText = cleanPromptText(rawBubbleText);
      const pureBubbleText = cleanedBubbleText.replace(/^生成视频/, '').replace(/^生成图片/, '');
      
      log(`[Debug Prompt Match] pureBubbleText: "${pureBubbleText.substring(0, 30)}...", len: ${pureBubbleText.length}`);
      
      if (pureBubbleText && pureBubbleText.length >= 5) {
        
        // 【核心防御】：如果这个气泡已经有烙印了，我们先看看这个老主人的提示词，是不是也和气泡匹配？
        // 如果匹配，说明这是一个“合法的历史视频”（比如用户往上滚动加载出来的旧视频），绝对不能被新任务夺舍！
        if (stampedTaskId && taskPromptsMap[stampedTaskId]) {
          const oldOwnerPrompt = cleanPromptText(taskPromptsMap[stampedTaskId]);
          if (oldOwnerPrompt && (pureBubbleText.includes(oldOwnerPrompt) || oldOwnerPrompt.includes(pureBubbleText))) {
            log(`[Prompt Match] 发现合法历史烙印 ${stampedTaskId} 且提示词完美吻合，拒绝夺舍！这是一个旧的视频！`);
            return stampedTaskId; // 保持旧的归属，不把它当作新任务
          }
        }

        // 如果没有烙印，或者老主人的提示词根本对不上（说明是 Unified Observer 错乱打底了图片任务的 ID），
        // 那就倒序遍历寻找真正的新主人！
        const entries = Object.entries(taskPromptsMap).reverse();
        
        for (const [taskId, taskPromptRaw] of entries) {
          const taskPrompt = cleanPromptText(taskPromptRaw);
          
          if (taskPrompt && (pureBubbleText.includes(taskPrompt) || taskPrompt.includes(pureBubbleText))) {
            log(`[Prompt Match] 提示词匹配优先夺回归属权! TaskID: ${taskId}`);
            if (msgId && messageTaskMap[msgId] !== taskId) {
              log(`[Prompt Match] 强制修正错误底色烙印: ${messageTaskMap[msgId] || 'None'} -> ${taskId}`);
              saveMessageTask(msgId, taskId); // 物理夺权
            }
            return taskId;
          }
        }
        log(`[Debug Prompt Match] NO MATCH FOUND in taskPromptsMap!`);
      }
    } else {
      log(`[Debug Prompt Match] extractPromptFromBubble returned empty.`);
    }

    // 3. 如果没提取到提示词（普通图片任务），或者全都没匹配上，退回底色烙印
    return stampedTaskId || null;
  }

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
      pointerEvents: 'auto'
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
    let foundTaskId = null;
    let hitMethod = 'None';
    
    // 1. 最高效：直接向上寻找 data-message-id 祖先
    const bubble = e.target.closest('[data-message-id]');
    if (bubble) {
      foundTaskId = findTaskIdByBubble(bubble);
      if (foundTaskId) {
        hitMethod = 'DOM Box (closest Message-ID)';
      }
    }

    // 2. 备用缓存：沿着 DOM 树检查 mediaTaskMap 烙印
    if (!foundTaskId) {
      let el = e.target;
      let limit = 8;
      while (el && el !== document.body && limit > 0) {
        if (mediaTaskMap.has(el)) {
          foundTaskId = mediaTaskMap.get(el);
          hitMethod = 'DOM Tree';
          break;
        }
        const medias = el.querySelectorAll ? el.querySelectorAll('img, video') : [];
        for (const m of medias) {
          if (mediaTaskMap.has(m)) {
            foundTaskId = mediaTaskMap.get(m);
            hitMethod = 'DOM Tree (Child)';
            break;
          }
        }
        if (foundTaskId) break;
        el = el.parentElement;
        limit--;
      }
    }

    // 【终极降维打击】：空间坐标碰撞法！如果根据DOM树找不到烙印（因为悬浮栏可能被渲染为同级兄弟节点）
    // 我们直接遍历页面上所有带烙印的 img 图片，看看当前鼠标点击的屏幕位置 (e.clientX, e.clientY) 是否落在这张图片区域内！
    // 性能优化：仅在有活跃任务时才执行昂贵的全页面碰撞检测，避免无任务时每次点击都遍历所有媒体元素
    if (!foundTaskId && activeTasksCount > 0) {
      const imgs = document.querySelectorAll('img, video');
      for (const img of imgs) {
        let imgTaskId = mediaTaskMap.get(img);
        if (!imgTaskId) {
          const imgBubble = img.closest('[data-message-id]');
          if (imgBubble) {
            const mId = imgBubble.getAttribute('data-message-id');
            if (mId && messageTaskMap[mId]) {
              imgTaskId = messageTaskMap[mId];
            }
          }
        }

        if (imgTaskId) {
          const rect = img.getBoundingClientRect();
          // 考虑到悬浮工具栏可能稍微超出图片边缘，我们向下和向外扩展 40px 的包围盒容差
          const expand = 40;
          if (e.clientX >= rect.left - expand && e.clientX <= rect.right + expand &&
            e.clientY >= rect.top - expand && e.clientY <= rect.bottom + expand) {
            foundTaskId = imgTaskId;
            hitMethod = 'Spatial Collision + DOM Box';
            break;
          }
        }
      }
    }

    // 【已移除记忆兜底】：防止点击历史任务时将行为错误归因为最近一次运行的任务。
    let debugMsg = `Click: <b>&lt;${e.target.tagName.toLowerCase()}&gt;</b> class='${e.target.className || ''}'<br>`;
    debugMsg += `TaskId Mapped: <span style="color:${foundTaskId ? '#0f0' : 'red'}">${foundTaskId || 'None'}</span> <span style="color:#888">(${hitMethod})</span><br>`;

    if (foundTaskId) {
      let isDownloadAction = false;
      
      // 1. 显式带有下载/保存语义的元素 (或视频底部的按钮)
      const explicitDownload = e.target.closest(
        '[class*="download"], [class*="save"], ' +
        '[aria-label*="下载"], [aria-label*="保存"], [title*="下载"], [title*="保存"], ' +
        '[class*="video-hover-button-group"] [class*="action-button"]'
      );

      if (explicitDownload) {
        isDownloadAction = true;
      } else {
        // 2. 图像悬浮条：必须严格检测是否是“最后一个”按钮，坚决排除“分享/扩图”等误触
        const hoverContainer = e.target.closest('[class*="hover-show-tag"]');
        if (hoverContainer) {
          // 只找直系子级的非分割线 div
          const btns = Array.from(hoverContainer.querySelectorAll(':scope > div')).filter(el => !el.className.includes('divider'));
          if (btns.length > 0) {
            const lastBtn = btns[btns.length - 1];
            if (lastBtn.contains(e.target)) {
              isDownloadAction = true;
            }
          }
        } else {
          // 3. 终极容错：如果既没有显式标识，又不在已知悬浮条内，但点击的是右下角附近的某个孤立的图标？
          // 为了不误杀（也不乱触发），我们保留一个基础容错：如果它的 class 包含 hover-DQYL 且没有别的明确特征，也算。
          const fuzzyBtn = e.target.closest('[class*="hover-DQYL"]');
          if (fuzzyBtn) {
            // isDownloadAction = true; // 暂不开启模糊匹配，遵循严格最后一个原则
          }
        }
      }

      debugMsg += `isDownloadAction: <span style="color:${isDownloadAction ? '#0f0' : 'orange'}">${!!isDownloadAction}</span>`;

      if (isDownloadAction) {
        // 【核心变更与修复】：绝对放行原生下载！ Watchdog 会自动清理默认下载目录的文件。
        // e.preventDefault();
        // e.stopPropagation();
        // e.stopImmediatePropagation();

        log(`[Agent] Detected manual download trigger. Emitting alert for task: ${foundTaskId}`);
        try {
          GM_xmlhttpRequest({
            method: 'POST',
            url: CONFIG.pushUrl,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ taskId: foundTaskId, action: 'download-alert' }),
            onload: () => log(`[Alert] Watchdog manual alert successfully reached backend.`)
          });
          debugMsg += ` => <b>Alert Emitted! (Native Download Allowed)</b>`;
        } catch (err) { }
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

  // ============================================================
  // 防风控：贝塞尔曲线鼠标轨迹模拟与仿生环境数据
  // ============================================================

  let vMouse = { 
    x: window.innerWidth / 2 + (Math.random() - 0.5) * 100, 
    y: window.innerHeight / 2 + (Math.random() - 0.5) * 100,
    pointerId: Math.floor(Math.random() * 10) + 1 
  };

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

  // (simulateMouseApproach 已移除：死代码，从未被调用)

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
      if (!interactionInProgress) simulateIdleScroll();
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

  async function reportError(errorMsg, specificTaskId = null) {
    log('Error:', errorMsg);
    const targetTaskId = specificTaskId || lastDispatchedTaskId || 'ALERT';
    GM_xmlhttpRequest({
      method: 'POST', url: CONFIG.pushUrl,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ taskId: targetTaskId, status: 'error', error: errorMsg })
    });
  }

  window.addEventListener('error', (event) => {
    if (event.filename && event.filename.includes('tampermonkey')) {
      reportError(`Global: ${event.message}`);
    }
  });
  window.addEventListener('unhandledrejection', (event) => {
    // 只报告来自我们自身脚本的错误，忽略豆包前端代码的海量 Promise 报错
    // 否则这些报错会疯狂调用 GM_xmlhttpRequest，堵死油猴的网络队列！
    const reason = String(event.reason || '');
    if (reason.includes('T8') || reason.includes('bridge') || reason.includes('doubao-sync')) {
      reportError(`Rejection: ${reason}`);
    }
  });

  // ============================================================
  // 文本聊天中转辅助函数
  // ============================================================

  function extractTextFromBubble(bubbleEl) {
    try {
      const clone = bubbleEl.cloneNode(true);
      
      // 移除显式操作容器和按钮，不直接移除全局的 svg 以免破坏正文里的 LaTeX 公式
      const toRemove = clone.querySelectorAll(
        'button, [class*="operation"], [class*="action"], [class*="toolbar"], [class*="footer"], [class*="feedback"], [class*="share"], [class*="copy"], [class*="like"]'
      );
      toRemove.forEach(el => el.remove());
      
      let text = clone.innerText || clone.textContent || '';
      
      // 针对末尾可能残留的操作文字进行多重清洗
      const dirtyWords = ['复制', '重新生成', '分享', '踩', '赞', '翻译', '朗读', '声音', '仅文字', '收起'];
      for (const word of dirtyWords) {
        text = text.replace(new RegExp(`(\\s|\\n)+${word}\\s*$`, 'g'), '');
        text = text.replace(new RegExp(`^${word}\\s*$`, 'g'), '');
      }
      return text.trim();
    } catch (e) {
      // 发生异常时进行基础安全降级
      let text = bubbleEl.innerText || bubbleEl.textContent || '';
      text = text.replace(/(复制|重新生成|分享|踩|赞|翻译|朗读)$/g, '').trim();
      return text;
    }
  }

  function isGenerating() {
    try {
      // 1. 查找包含“停止生成”或“停止”字样的按钮
      const stopButtons = document.querySelectorAll('button, [role="button"]');
      for (const btn of stopButtons) {
        const txt = (btn.textContent || '').trim();
        if (txt.includes('停止生成') || txt.includes('停止回复') || txt === '停止') {
          if (isElementTrulyVisible(btn)) return true;
        }
      }
      
      // 2. 查找是否有闪烁的打字光标元素（通常有 cursor-blink 或类似的 class）
      const blinkCursor = document.querySelector('[class*="cursor"], [class*="blink"], [class*="typing"]');
      if (blinkCursor && isElementTrulyVisible(blinkCursor)) {
        return true;
      }

      // 3. 查找是否有明确的加载中、思考中或骨架屏动画
      const loaders = document.querySelectorAll('[class*="loading"], [class*="thinking"], [class*="skeleton"]');
      for (const loader of loaders) {
        if (isElementTrulyVisible(loader)) return true;
      }

      // 4. 特殊处理：如果最新气泡的文本仅仅是“思考中”或者“...”，则视为仍在生成（思考）阶段
      const chatContainer = getDoubaoChatContainer() || document.body;
      const allBubbles = chatContainer.querySelectorAll(DOM_SELECTORS.aiBubble.join(','));
      if (allBubbles.length > 0) {
         const latestBubble = allBubbles[allBubbles.length - 1];
         const txt = (latestBubble.innerText || latestBubble.textContent || '').replace(/\s+/g, '');
         if (txt === '...' || txt.includes('思考中') || txt === '深度思考' || txt === '') {
            // 如果文本极短且符合思考占位符特征，或者完全为空，认为在思考/准备生成
            // 注意：如果为空也判定为 generating 可能会导致无限等待，但如果为空确实也没生成出内容
            // 结合长度判断
            if (txt.length < 10) return true;
         }
      }
    } catch (e) {}
    return false;
  }

  async function waitBubbleTextDone(initialBubbleEl) {
    let lastLength = 0;
    let stableCount = 0;
    const maxWaitSeconds = 300; // 提高到 5 分钟以适配超长脚本生成
    let currentBubble = initialBubbleEl;

    for (let s = 0; s < maxWaitSeconds; s++) {
      await sleep(1000);

      // 【关键修复】：如果气泡被移出 DOM（比如豆包的“思考中”临时气泡被正式气泡替换）
      // 我们需要自动去寻找当前对话流里的最后一个 AI 气泡
      if (currentBubble && !currentBubble.isConnected) {
        try {
           const chatContainer = getDoubaoChatContainer() || document.body;
           const allBubbles = chatContainer.querySelectorAll(DOM_SELECTORS.aiBubble.join(','));
           if (allBubbles.length > 0) {
             currentBubble = allBubbles[allBubbles.length - 1]; // 始终追踪最后一个
           }
        } catch(e) {}
      }

      if (!currentBubble) continue;

      const text = extractTextFromBubble(currentBubble);
      const len = text.length;

      // 只有在没检测到“正在生成/思考”指示时，才进行稳定度的判定
      if (!isGenerating()) {
        if (len > 0 && len === lastLength) {
          stableCount++;
          // 如果最终提取到的内容非常短，为了防止误判，我们稍微多等几秒
          const requiredStable = len < 10 ? 10 : 5;
          if (stableCount >= requiredStable) { 
            return text;
          }
        } else {
          stableCount = 0;
          lastLength = len;
        }
      } else {
        // 还在生成/思考中，重置计数器，同步最新长度
        stableCount = 0;
        lastLength = len;
      }
    }
    return currentBubble ? extractTextFromBubble(currentBubble) : '';
  }

  function pushChatTextToBackend(taskId, text) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.pushUrl,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ taskId, status: 'completed', text }),
        timeout: 5000,
        onload: (res) => {
          log(`[Chat Push] 文本结果推送成功. Status: ${res.status}`);
          resolve(res.status === 200);
        },
        onerror: () => {
          log(`[Chat Push] 失败`);
          resolve(false);
        }
      });
    });
  }

  function findBubbleByTaskId(taskId) {
    const chatContainer = getDoubaoChatContainer() || document.body;
    const bubbles = chatContainer.querySelectorAll(DOM_SELECTORS.aiBubble.join(','));
    for (const b of bubbles) {
      const msgId = b.getAttribute('data-message-id');
      if (msgId && messageTaskMap[msgId] === taskId) {
        return b;
      }
    }
    return bubbles.length > 0 ? bubbles[bubbles.length - 1] : null;
  }

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
      /*
      GM_xmlhttpRequest({
        method: 'POST', url: CONFIG.pushUrl,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ taskId, status, base64Data, error }),
        onload: () => resolve(true),
        onerror: () => resolve(false)
      });
      */
      resolve(true); // 已根据用户要求临时关闭
    });
  }

  function clearTaskState(taskId) {
    interactionInProgress = false;
    
    if (taskId && activeTasks[taskId]) {
      clearTimeout(activeTasks[taskId].timer);
      delete activeTasks[taskId];
      activeTasksCount--;
      log(`[Task Lifecycle] Task ${taskId} finished. Active tasks remaining: ${activeTasksCount}`);
    } else if (!taskId) {
      for (const tid in activeTasks) {
        clearTimeout(activeTasks[tid].timer);
      }
      activeTasks = {};
      activeTasksCount = 0;
      log(`[Task Lifecycle] Force cleared ALL tasks.`);
    }

    if (activeTasksCount <= 0) {
      activeTasksCount = 0;
      stopUnifiedObserver();
    }
    
    if (pendingMediaCheck) {
      log(`[Agent] Executing pending media check after state clear...`);
      pendingMediaCheck = false;
      checkPageForMedia();
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

  // --- 聚焦模拟（用于触发弹窗等UI变化） ---
  async function simulateFocusAndHover(inputElement) {
    if (!inputElement) return;
    
    const rect = inputElement.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      await glideMouseTo(inputElement, rect.left + rect.width / 2, rect.top + rect.height / 2);
    } else {
      const events = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'];
      for (let e of events) {
        inputElement.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true }));
      }
    }
    
    inputElement.focus();
    inputElement.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await sleep(20);
  }

  // --- 仿真指针与鼠标事件分发（带有补全的高级坐标、动态 PointerID 递增） ---
  function createPointerProps(x, y, dx = 0, dy = 0) {
    return {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y,
      screenX: window.screenX + x, screenY: window.screenY + y,
      pageX: window.scrollX + x, pageY: window.scrollY + y,
      movementX: dx, movementY: dy,
      pointerId: vMouse.pointerId, pointerType: 'mouse',
      isPrimary: true, button: 0, buttons: 0
    };
  }

  // 利用贝塞尔曲线移动虚拟鼠标从当前位置到目标元素中心
  async function glideMouseTo(targetEl, targetX, targetY) {
    if (!targetEl) return;
    vMouse.pointerId++; 
    
    const p0 = { x: vMouse.x, y: vMouse.y };
    const p2 = { x: targetX, y: targetY };
    const dist = Math.hypot(p2.x - p0.x, p2.y - p0.y);
    
    // 如果极近，不需要长轨迹
    if (dist < 5) {
      const finalProps = createPointerProps(targetX, targetY);
      try {
        targetEl.dispatchEvent(new PointerEvent('pointerover', finalProps));
        targetEl.dispatchEvent(new PointerEvent('pointerenter', finalProps));
        targetEl.dispatchEvent(new MouseEvent('mouseover', finalProps));
        targetEl.dispatchEvent(new MouseEvent('mouseenter', finalProps));
      } catch(e) {}
      vMouse.x = targetX; vMouse.y = targetY;
      return;
    }

    const p1 = {
      x: p0.x + (p2.x - p0.x) * 0.5 + (Math.random() - 0.5) * dist * 0.4,
      y: p0.y + (p2.y - p0.y) * 0.5 + (Math.random() - 0.5) * dist * 0.4
    };

    const steps = Math.max(5, Math.min(25, Math.floor(dist / 20)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const pt = bezierPoint(t, p0, p1, p2);
      const props = createPointerProps(pt.x, pt.y, pt.x - vMouse.x, pt.y - vMouse.y);
      try {
        const elAtPoint = document.elementFromPoint(pt.x, pt.y) || document.body;
        elAtPoint.dispatchEvent(new PointerEvent('pointermove', props));
        elAtPoint.dispatchEvent(new MouseEvent('mousemove', props));
      } catch (e) {}
      vMouse.x = pt.x; vMouse.y = pt.y;
      await sleep(10 + Math.random() * 15 + (i === steps ? 30 : 0));
    }
    
    const finalProps = createPointerProps(targetX, targetY);
    try {
      targetEl.dispatchEvent(new PointerEvent('pointerover', finalProps));
      targetEl.dispatchEvent(new PointerEvent('pointerenter', finalProps));
      targetEl.dispatchEvent(new MouseEvent('mouseover', finalProps));
      targetEl.dispatchEvent(new MouseEvent('mouseenter', finalProps));
    } catch(e) {}
  }

  // --- 批量拖拽模拟 ---
  async function simulateDropMultiple(element, urls) {
    const dt = new DataTransfer();
    for (const url of urls) {
      const file = await fetchUrlAsFile(url);
      dt.items.add(file);
    }

    const events = ['dragenter', 'dragover', 'drop'];
    for (const eventType of events) {
      element.dispatchEvent(new DragEvent(eventType, {
        bubbles: true, cancelable: true, dataTransfer: dt
      }));
      await sleep(30 + Math.random() * 50);
    }
  }

  // --- 批量文件输入模拟 ---
  async function simulateFileInputUploadMultiple(inputElement, urls) {
    const dt = new DataTransfer();
    for (const url of urls) {
      const file = await fetchUrlAsFile(url);
      dt.items.add(file);
    }
    inputElement.files = dt.files;
    inputElement.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // --- 极速引擎（修复文本防拦截注入） ---
  async function simulateHumanTyping(element, text) {
    element.focus();
    await randomDelay(50, 100);

    let isTextarea = (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT');

    try {
      // 1. 选中所有文本以备覆盖
      if (isTextarea) {
        element.select();
      } else if (element.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      // 2. 补发真实键盘粘贴组合键序列 (Ctrl/Cmd + V)
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modKey = isMac ? 'Meta' : 'Control';
      const modCode = isMac ? 'MetaLeft' : 'ControlLeft';
      
      element.dispatchEvent(new KeyboardEvent('keydown', { key: modKey, code: modCode, ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true }));
      await sleep(10 + Math.random() * 20);
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true }));
      
      // 3. 触发真实系统的剪贴板粘贴行为
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: new DataTransfer()
      });
      pasteEvent.clipboardData.setData('text/plain', text);
      const pasteAccepted = !element.dispatchEvent(pasteEvent);

      // 4. 原生命令注入：如果组件没有 preventDefault 拦截，或者它是原生输入框
      if (!pasteAccepted || isTextarea) {
        document.execCommand('insertText', false, text);
      }

      // 5. 使用高级 InputEvent 唤醒 React/Vue，完全放弃对 _valueTracker 的粗暴修改
      element.dispatchEvent(new InputEvent('input', { 
        bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: text 
      }));
      if (isTextarea) {
        element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }

      // 键盘序列释放
      await sleep(10 + Math.random() * 20);
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', code: 'KeyV', ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true }));
      await sleep(5 + Math.random() * 10);
      element.dispatchEvent(new KeyboardEvent('keyup', { key: modKey, code: modCode, ctrlKey: false, metaKey: false, bubbles: true, cancelable: true }));
      
      log('Text injected using pure Ctrl+V event sequence.');
    } catch (err) {
      log('Text injection sequence failed:', err.message);
    }

    await sleep(50);
  }

  // --- 发送（综合防风控与鲁棒性：回车键 + 焦点唤醒 + 按钮兜底） ---
  async function simulateSend(inputBox, textForSync = '') {
    log('Sending message... ensuring focus on inputBox');
    inputBox.focus();
    inputBox.dispatchEvent(new Event('focus', { bubbles: true }));
    inputBox.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    // 提示词的强制同步逻辑已经统一移至 simulateHumanTyping，此处不再重复同步，以防双份追加。

    await sleep(100);

    log('Dispatching Enter key events...');
    const keyProps = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    };
    inputBox.dispatchEvent(new KeyboardEvent('keydown', keyProps));
    inputBox.dispatchEvent(new KeyboardEvent('keypress', keyProps));
    await sleep(40 + Math.random() * 60);
    inputBox.dispatchEvent(new KeyboardEvent('keyup', keyProps));

    // 遵从指令：完全使用纯回车键序列，放弃高危的按钮点击兜底
    log('Send sequence completed (Enter key only).');
  }

  // ============================================================
  // 豆包页面适配器
  // ============================================================

  function isElementTrulyVisible(el) {
    const rect = el.getBoundingClientRect();
    // 尺寸必须大于0
    if (rect.width === 0 || rect.height === 0) return false;
    // 必须在屏幕视窗内（防止被 transform: translateX(-100%) 等方式移出屏幕）
    if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) {
      return false;
    }
    // 样式不能是隐藏
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    return true;
  }

  function findVisibleElementBySelectors(selectors) {
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        if (isElementTrulyVisible(el)) {
          return el;
        }
      }
    }
    return null;
  }

  function getDoubaoInputBox() {
    return findVisibleElementBySelectors(DOM_SELECTORS.inputBox);
  }

  function getDoubaoUploadArea() {
    const el = findVisibleElementBySelectors(DOM_SELECTORS.inputBox);
    if (el && el.tagName === 'TEXTAREA') return el.parentElement;
    return el;
  }

  function getDoubaoChatContainer() {
    return findVisibleElementBySelectors(DOM_SELECTORS.chatContainer);
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

  async function switchGenerationTab(model) {
    if (model === 'web-agent-doubao-chat') return; // 普通聊天无需切换 Tab，直接在当前主窗口进行，避免多余误触

    let targetText = '';
    if (model === 'video') targetText = '视频生成';
    else if (model === 'web-agent-doubao') targetText = '图像生成';
    else if (model === 'web-agent-doubao-chat') targetText = '豆包';

    if (!targetText) return;

    log(`Checking if we need to switch to tab: ${targetText}`);

    const isTabClickable = (node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };

    // 加入重试机制，防止 React 渲染延迟导致瞬间找不到
    for (let attempt = 0; attempt < 8; attempt++) {
      // 1. 优先寻找显式的按钮/可点击元素，其文本包含 targetText
      const clickables = document.querySelectorAll('button, [role="button"], [class*="skill-item"], [class*="button"], [class*="skill-bar-button"]');
      for (const el of clickables) {
        if (el.closest('[data-testid="chat-message-list"], .chat-message-container')) continue;
        
        const text = (el.textContent || '').trim();
        // 清洗掉所有空格、换行、零宽字符
        const cleanText = text.replace(/[\s\u200b\u200c\u200d\ufeff]+/g, '');
        if (cleanText.includes(targetText)) {
          const clickable = isTabClickable(el);
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          log(`[Tab Search] Match: "${cleanText}", isClickable: ${clickable} (Attempt ${attempt + 1}, width: ${rect.width}, height: ${rect.height}, display: ${style.display}, visibility: ${style.visibility})`);
          
          if (clickable) {
            el.click();
            log(`Switched to tab: ${targetText} via clickable element (Attempt ${attempt + 1})`);
            await sleep(800); // 留出 React 路由/组件挂载时间
            return;
          }
        }
      }

      // 2. 降级寻找任何包含该文本的可见 div/span/p 等，再向上寻祖先可点击元素
      const elements = document.querySelectorAll('div, span, p');
      for (const el of elements) {
        if (el.closest('[data-testid="chat-message-list"], .chat-message-container')) continue;
        
        const text = (el.textContent || '').trim();
        const cleanText = text.replace(/[\s\u200b\u200c\u200d\ufeff]+/g, '');
        if (cleanText === targetText) {
          const clickable = el.closest('button, [role="button"], [class*="skill-item"], [class*="button"]') || el;
          const isClickable = isTabClickable(clickable);
          log(`[Tab Search Fallback] Match: "${cleanText}", isClickable: ${isClickable} (Attempt ${attempt + 1})`);
          
          if (isClickable) {
            clickable.click();
            log(`Switched to tab: ${targetText} via text node closest clickable (Attempt ${attempt + 1})`);
            await sleep(800);
            return;
          }
        }
      }
      await sleep(400); // 短暂休眠后重试
    }
    log("Warning: Tab \"" + targetText + "\" not found after retries. Proceeding with default view.");
  }

  // ============================================================
  // Unified Observer 核心引擎
  // ============================================================
  let unifiedObserver = null;
  let mediaDebounceTimer = null;

  function startUnifiedObserver() {
    if (unifiedObserver) return;

    const chatContainer = getDoubaoChatContainer() || document.body;
    log('[Unified Observer] Starting core unified DOM engine...');

    unifiedObserver = new MutationObserver((mutations) => {
      if (activeTasksCount <= 0) return;
      
      let hasMedia = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            
            // 1. 同步打底烙印逻辑：任何新出生的气泡，无条件先打上 lastDispatchedTaskId
            const msgEls = node.matches('[data-message-id]') ? [node] : Array.from(node.querySelectorAll('[data-message-id]'));
            for (const el of msgEls) {
              const msgId = el.getAttribute('data-message-id');
              if (msgId && !messageTaskMap[msgId] && lastDispatchedTaskId) {
                saveMessageTask(msgId, lastDispatchedTaskId);
                log(`[Unified Observer] 👶 New bubble ${msgId} stamped with base color: ${lastDispatchedTaskId}`);
              }
            }

            // 2. 媒体发现逻辑（允许在互斥锁期间发现媒体，只是延后收集）
            if (node.matches('img, video') || node.querySelector('img, video')) {
              hasMedia = true;
            }
          }
        } else if (mutation.type === 'attributes' && mutation.attributeName === 'data-message-id') {
          const el = mutation.target;
          const msgId = el.getAttribute('data-message-id');
          if (msgId && !messageTaskMap[msgId] && lastDispatchedTaskId) {
            saveMessageTask(msgId, lastDispatchedTaskId);
            log(`[Unified Observer] 👶 Bubble dynamically stamped via attribute: ${msgId} -> ${lastDispatchedTaskId}`);
          }
        }
      }

      if (hasMedia) {
        clearTimeout(mediaDebounceTimer);
        mediaDebounceTimer = setTimeout(async () => {
          log(`[Unified Observer] 🎬 DOM Mutation detected media elements. Waking up to harvest...`);
          // 连续扫描两次防止渲染未完成
          for (let i = 0; i < 2; i++) {
            const success = await checkPageForMedia();
            if (success) {
              log('[Unified Observer] Harvest success and target secured.');
              break;
            }
            if (i < 1) await sleep(500);
          }
        }, 300);
      }
    });

    unifiedObserver.observe(chatContainer, { 
      childList: true, 
      subtree: true,
      attributes: true,
      attributeFilter: ['data-message-id']
    });
  }

  function stopUnifiedObserver() {
    if (unifiedObserver) {
      log('[Unified Observer] No active tasks remaining. Shutting down engine to sleep.');
      unifiedObserver.disconnect();
      unifiedObserver = null;
    }
  }

  async function handleTask(task) {
    const { prompt, images, model } = task.payload;
    const taskModel = model === 'video' ? 'video' : (model === 'web-agent-doubao-chat' ? 'web-agent-doubao-chat' : 'web-agent-doubao');

    lastDispatchedTaskId = task.id;
    localStorage.setItem('doubao_lastDispatchedTaskId', task.id);
    
    interactionInProgress = true;
    activeTasksCount++;
    const timeoutMs = (taskModel === 'web-agent-doubao' || taskModel === 'web-agent-doubao-chat') ? 120000 : CONFIG.taskTimeoutMs;

    activeTasks[task.id] = {
      prompt: prompt || '',
      type: taskModel,
      timer: setTimeout(() => {
        clearTaskState(task.id);
        reportError(`Task Timeout: Exceeded ${timeoutMs / 1000}s`, task.id);
      }, timeoutMs)
    };

    saveTaskPrompt(task.id, prompt); // 即使任务超时并从 activeTasks 中移除，仍然可以使用历史提示词进行气泡匹配！

    // 唤醒全局统一引擎！
    startUnifiedObserver();

    // 快照当前页面所有图片
    snapshotAllImages();

    try {
      // --- 步骤 1：智能切换独立生图/生视频频道 ---
      await switchGenerationTab(taskModel);

      // 加固输入框获取逻辑：React 组件渲染可能有延迟，此处添加最长 5 秒的轮询重试
      let inputBox = null;
      for (let i = 0; i < 20; i++) {
        inputBox = getDoubaoInputBox();
        if (inputBox) break;
        await sleep(250);
      }

      if (!inputBox) {
        throw new Error(`Selector outdated (v${DOM_SELECTORS.version}): input not found.`);
      }

      // --- 步骤0：标记含图任务 --- //
      const hasImages = (images && images.length > 0);

      // --- 步骤1：触发文件注入 --- //
      if (images && images.length > 0) {
        await simulateFocusAndHover(inputBox);

        const fileInput = document.querySelector('input[type="file"][accept*="image"]')
          || document.querySelector('input[type="file"]');

        if (fileInput) {
          log('Uploading via file input with focus lifecycle (Batch Mode)...');
          await simulateFileInputUploadMultiple(fileInput, images);
        } else {
          const uploadArea = getDoubaoUploadArea();
          if (!uploadArea) throw new Error('Upload area not found.');
          await simulateFocusAndHover(uploadArea);
          log('Fallback: uploading via drag&drop (Batch Mode)...');
          await simulateDropMultiple(uploadArea, images);
        }

        await randomDelay(800, 1200);
      }

      // --- 步骤2：极速文本注入 ---
      await simulateFocusAndHover(inputBox);
      await simulateHumanTyping(inputBox, prompt || 'Hello');

      // --- 步骤2.5：视觉层嗅探，死磕上传指示器 ---
      if (hasImages) {
        log('Awaiting DOM visual layer confirmation for upload completion...');
        await waitForUploadComplete(images.length);
        log('DOM indicates upload is clear. Waiting randomly for UI finalize...');
        await randomDelay(1000, 2000);
      }

      // --- 步骤2.8：已经由 handleTask 开始了 UnifiedObserver，无需单独挂载临时监听器 ---

      // --- 步骤3：发送 ---
      await simulateSend(inputBox, prompt || 'Hello');

      // --- 步骤4：发送后等待渲染 + 重新快照 ---
      await sleep(humanDelay(4000, 0.3));
      snapshotAllImages();

      if (taskModel === 'web-agent-doubao-chat') {
        log(`[Chat Task] 等待 AI 回复打字完成...`);
        let bubbleEl = null;
        for (let i = 0; i < 20; i++) {
          bubbleEl = findBubbleByTaskId(task.id);
          if (bubbleEl) break;
          await sleep(500);
        }

        if (!bubbleEl) {
          throw new Error('未定位到 AI 回复气泡框。');
        }

        const replyText = await waitBubbleTextDone(bubbleEl);
        log(`[Chat Task] 抓取到完整文本回复: ${replyText.slice(0, 100)}...`);

        const pushSuccess = await pushChatTextToBackend(task.id, replyText);
        if (pushSuccess) {
          log(`[Chat Task] 成功将文本结果推送到后端。`);
        } else {
          log(`[Chat Task] 推送文本失败。`);
        }
        clearTaskState(task.id);
        return;
      }

      interactionInProgress = false;
      if (pendingMediaCheck) {
        log(`[Agent] Executing pending media check after interaction...`);
        pendingMediaCheck = false;
        checkPageForMedia();
      }

      await pushResult(task.id, 'running');

    } catch (e) {
      clearTaskState(task.id); // 抛错时必须立即清理任务状态
      await reportError(`Task failed: ${e.message}`, task.id);
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
  async function waitForUploadComplete(expectedCount = 0) {
    const intervalMs = 1000;
    let elapsed = 0;

    log(`[Upload Sniffer] Target count: ${expectedCount} images. Waiting for upload...`);
    // 核心缺陷修复：给前端 React 框架留出渲染进度圆圈的喘息时间
    // 否则刚注入图片，DOM 还没来得及长出圆圈，就会被错误地秒判通过！
    await sleep(1000);

    const MAX_UPLOAD_WAIT = 60000; // 硬超时 60 秒，防止静默上传失败导致死循环卡死整条流水线
    while (elapsed < MAX_UPLOAD_WAIT) {
      let isLoading = false;
      let activeIndicatorClass = '';
      let uploadedReadyCount = 0;
      let hasError = false;
      let activeErrorClass = '';
      let composer = null;

      // 1. 物理定位与计数，并对每个有效图片子卡片区域做局部的上传报错感叹号嗅探
      const inputBox = getDoubaoInputBox();
      if (inputBox) {
        let p = inputBox.parentElement;
        let depth = 0;
        let bestComposer = null;
        let maxCount = 0;
        let finalError = false;

        while (p && p !== document.body && depth < 12) {
          // 【核心防御】绝不进行全屏扫描！
          // 防御1：不要扩散到包含历史聊天记录的容器
          if (p.querySelector('[data-testid="chat-message-list"], .chat-message-container')) break;
          // 防御2：容器高度如果超过了视窗的 75%，说明已经扩大到了主页面级别，立刻停止
          if (p.clientHeight > window.innerHeight * 0.75) break;

          const imgs = p.querySelectorAll('img');
          let count = 0;
          let foundError = false;
          for (const img of imgs) {
            // 排除用户头像和极小的图标
            const isAvatar = img.closest('[class*="avatar"], [class*="Avatar"], [class*="user-info"]');
            if (!isAvatar) {
              const isLoaded = img.clientWidth > 15 || img.naturalWidth > 15;
              const isLocalOrBlob = img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:'));
              if (isLoaded || isLocalOrBlob) {
                count++;

                // 对此张图片所在的局部预览卡片区域进行报错探测（向上遍历最多 4 层父级）
                let card = img.parentElement;
                let cardDepth = 0;
                while (card && card !== p && cardDepth < 4) {
                  const errorIndicators = card.querySelectorAll(
                    '[class*="error"], [class*="fail"], [class*="warning"], [class*="alert"], .semi-icon-alert-circle, [data-icon*="alert"], [data-icon*="error"], [aria-label*="失败"], [aria-label*="错误"]'
                  );
                  for (const el of errorIndicators) {
                    const style = window.getComputedStyle(el);
                    // 必须加上物理尺寸判断，防止父元素 display:none 但子元素属性依旧的问题
                    // 使用 getBoundingClientRect() 兼容 SVG 元素的尺寸获取
                    const rect = el.getBoundingClientRect();
                    if (style.display !== 'none' && style.opacity !== '0' && style.visibility !== 'hidden' && (rect.width > 0 || rect.height > 0)) {
                      foundError = true;
                      activeErrorClass = `${img.src.slice(0, 30)}... -> ${el.className || el.tagName}`;
                      break;
                    }
                  }
                  if (foundError) break;
                  card = card.parentElement;
                  cardDepth++;
                }
              }
            }
          }

          if (count > maxCount) {
            maxCount = count;
            bestComposer = p;
            finalError = foundError;
          }

          // 如果已经达到了预期图片数量，说明当前容器完美包裹了所有上传预览图，立刻停止扩散
          if (expectedCount > 0 && count >= expectedCount) {
            break;
          }

          p = p.parentElement;
          depth++;
        }

        if (bestComposer) {
          composer = bestComposer;
          uploadedReadyCount = maxCount;
          hasError = finalError;
        }
      }

      // 2. 局部精确检测：如果找到了局部容器，只检测其内部的进度圈，防止被聊天历史干扰
      if (composer) {
        // 精准检测局部进度指示器：
        const loadingIndicators = composer.querySelectorAll(
          '.semi-progress-circle-text, .semi-progress-circle-ring-inner, [class*="progress-circle"]'
        );
        for (const el of loadingIndicators) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0.05 && (rect.width > 0 || rect.height > 0)) {
            // 核心修复：如果进度圈上的数字已经跑到 100%，说明其实已经传完了，只是前端的消失动画卡住了或延迟了
            if (el.textContent && el.textContent.includes('100%')) {
              continue;
            }
            isLoading = true;
            activeIndicatorClass = el.className || el.tagName;
            break;
          }
        }
      }

      // 只有在没有进度圈在转，且已就绪的图片数量满足期望值，且没有上传失败指示时才放行
      if (isLoading || hasError || (expectedCount > 0 && uploadedReadyCount < expectedCount)) {
        let logMsg = `Still uploading...`;
        if (isLoading) logMsg += ` [Progress circle active: ${activeIndicatorClass}]`;
        if (hasError) logMsg += ` [Exclamation mark/Error detected: ${activeErrorClass}]`;
        if (expectedCount > 0 && uploadedReadyCount < expectedCount) logMsg += ` [Images ready: ${uploadedReadyCount}/${expectedCount}]`;
        log(`${logMsg} (${Math.round(elapsed / 1000)}s elapsed)`);
      } else {
        log(`All uploads clear. Progress ring: inactive, Ready images: ${uploadedReadyCount}/${expectedCount}. Wait considered complete after ${Math.round(elapsed / 1000)}s.`);
        return true;
      }

      await sleep(intervalMs);
      elapsed += intervalMs;
    }

    // 超时兜底：如果 60 秒内既没有检测到进度圈消失、也没有达到预期图片数，强制放行防卡死
    log(`[Upload Sniffer] HARD TIMEOUT after ${MAX_UPLOAD_WAIT/1000}s! Force proceeding to prevent pipeline deadlock.`);
    return false;
  }

  // (createUploadSniffer 已移除：死代码，从未被调用。原网络底板嗅探器已被 waitForUploadComplete 视觉层嗅探器完全替代)

  async function checkPageForMedia() {
    if (interactionInProgress) {
      log('[Physical Media] Interaction locked. Marking pendingMediaCheck = true.');
      pendingMediaCheck = true;
      return false;
    }

    try {
      const chatContainer = getDoubaoChatContainer() || document.body;
      const mediaElements = chatContainer.querySelectorAll('img, video');

      for (const el of mediaElements) {
        const url = el.src || (el.querySelector('source') ? el.querySelector('source').src : null);
        if (!url) continue;

        if (url.includes('avatar') || url.includes('icon') || url.includes('svg')) continue;
        if (url.includes('logo') || url.includes('emoji')) continue;
        if (processedImages.has(url)) continue;

        // 核心防御：跨页面刷新的物理防重下（基于 Stable URL 校验，剔除签名过期因素）
        const stableUrl = getStableMediaUrl(url);
        if (stableUrl && completedMediaMap[stableUrl]) {
          log(`[Physical Media] Media ${stableUrl.substring(0, 50)}... was already downloaded in the past. Skipping historical item.`);
          processedImages.add(url);
          continue;
        }

        if (!isInsideAiBubble(el)) {
          processedImages.add(url);
          continue;
        }

        const isVideo = el.tagName === 'VIDEO';

        if (!isVideo) {
          if (!el.complete) {
            await Promise.race([
              new Promise(r => { el.onload = r; el.onerror = r; }),
              sleep(5000)
            ]);
          }
          if (el.naturalWidth < 100 || el.naturalHeight < 100) continue;
        }

        const container = el.closest('[class*="message"], [class*="bubble"], .flex') || el.parentElement;
        
        let activeTaskId = mediaTaskMap.get(el);
        
        if (!activeTaskId) {
          const bubble = el.closest('[data-message-id]');
          if (bubble) {
            activeTaskId = findTaskIdByBubble(bubble);
          }
        }

        if (!activeTaskId) {
          let p = el.parentElement;
          let depth = 0;
          while (p && p !== document.body && depth < 20) {
            if (mediaTaskMap.has(p)) { activeTaskId = mediaTaskMap.get(p); break; }
            p = p.parentElement; depth++;
          }
        }

        // 【终极迟滞匹配大招】如果真的是 DOM 脱节（例如浮层 Portal），使用最后一个发出的 taskId
        if (!activeTaskId && lastDispatchedTaskId) {
          activeTaskId = lastDispatchedTaskId;
          log(`[Agent] Fallback to lastDispatchedTaskId: ${activeTaskId}`);
        }

        // 【新增极强防御】：基于 TaskID 的防重判定。解决视频从 Blob 变为 CDN 导致的重复下载
        if (activeTaskId && localStorage.getItem('doubao_downloaded_task_' + activeTaskId)) {
          log(`[Physical Media] Task ${activeTaskId} already triggered download. Skipping media processing.`);
          processedImages.add(url);
          if (stableUrl) markMediaAsCompleted(url);
          continue;
        }

        processedImages.add(url);
        log(`Found AI-generated ${isVideo ? 'video' : 'image'}! Trying URL push first...`);

        if (activeTaskId) {
          mediaTaskMap.set(el, activeTaskId);
          let p = el.parentElement;
          let depth = 0;
          while (p && p !== document.body && depth < 10) {
            mediaTaskMap.set(p, activeTaskId);
            p = p.parentElement;
            depth++;
          }
          log(`[Agent] Imprinted media card with taskId: ${activeTaskId}`);
        }

        // 【物理原媒体截获优先通道】针对图片和视频，分别进行严密的 DOM 选择器寻址，点击原生下载按钮转交看门狗打捞
        let downloadBtn = null;

        // 1. 定位包裹容器 (可以是图片卡片 image-box，或者是视频卡片 block-video 或 video-hover-button-group)
        const videoContainer = el.closest('[class*="block-video"], [class*="video-hover-button-group-container"]');
        const imageContainer = el.closest('[class*="image-box"]');
        const itemContainer = videoContainer || imageContainer || container;
        const isVideoCard = isVideo || (videoContainer !== null);

        // 2. 计算中心点并执行【多层级事件穿透唤醒】
        const rect = itemContainer.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;

        log(`[Physical Media] Gliding mouse to media card with Bezier path...`);
        await glideMouseTo(itemContainer, clientX, clientY);
        
        const innerImg = itemContainer.querySelector('img');
        if (innerImg) {
          await glideMouseTo(innerImg, clientX, clientY);
        }

        const playerWrapper = itemContainer.querySelector('[class*="player-wrapper"]') || itemContainer.querySelector('[class*="player"]');
        if (playerWrapper) {
          await glideMouseTo(playerWrapper, clientX, clientY);
        }

        // 3. 轮询等待操作工具栏渲染就绪 (最长等待 2.0s)
        log('[Physical Media] Waiting for hover toolbar to render...');
        let toolReady = false;
        let elapsed = 0;
        const checkInterval = 100;
        const maxTimeout = 2000;
        const targetSelector = isVideoCard ? '[class*="video-hover-button-group"]' : '[class*="hover-show-tag"]';

        while (elapsed < maxTimeout) {
          if (itemContainer.querySelector(targetSelector)) {
            toolReady = true;
            break;
          }
          await sleep(checkInterval);
          elapsed += checkInterval;
        }

        // 4. 查找下载按钮
        if (toolReady) {
          if (!isVideoCard) {
            // 图片操作按钮选择器：【保持原有逻辑不变】
            const btns = itemContainer.querySelectorAll('[class*="hover-show-tag"] > div:not([class*="divider"])');
            if (btns.length > 0) {
              downloadBtn = btns[btns.length - 1]; // 最后一个是下载按钮
              log('[Physical Media] Locked image download button via classic path');
            }
          } else {
            // 视频操作按钮选择器：【升级为高精度检索链】
            const btns = itemContainer.querySelectorAll(
              '[class*="video-hover-button-group"] [class*="button-group"] > [class*="action-button"]'
            );
            if (btns.length > 0) {
              downloadBtn = btns[btns.length - 1]; // 最后一个是下载按钮
              log('[Physical Media] Locked video download button via high-precision path');
            }
          }
        }

        // 5. 模糊检索与降级兜底
        if (itemContainer && !downloadBtn) {
          log('[Physical Media] Classic/High-precision path failed. Trying fuzzy query fallback...');
          const buttons = itemContainer.querySelectorAll('button, [role="button"], [class*="button"], [class*="action"]');
          for (const btn of buttons) {
            if (btn.className && btn.className.includes('button-group')) continue;

            const text = (btn.textContent || '').trim();
            const label = (btn.getAttribute('aria-label') || '').trim();
            const title = (btn.getAttribute('title') || '').trim();
            const cls = btn.className || '';
            const allText = text + label + title;

            // 【核心修复】：绝对排除所有下载“文本/文档”或执行“复制/反馈”的干扰按钮！
            if (allText.includes('文档') || allText.includes('文本') || 
                allText.includes('复制') || allText.includes('重新生成') || 
                allText.includes('踩') || allText.includes('赞')) {
              continue;
            }

            if (
              text.includes('下载') || 
              label.includes('下载') || 
              title.includes('下载') || 
              cls.includes('download')
            ) {
              downloadBtn = btn;
              log('[Physical Media] Locked download button via fuzzy fallback');
              break;
            }
          }

          if (!downloadBtn) {
            // 终极降级（同样排除文本下载）
            const vBtns = Array.from(itemContainer.querySelectorAll('button[aria-label*="下载"], button[title*="下载"], [class*="download"]'))
              .filter(btn => {
                const t = (btn.textContent || '') + (btn.getAttribute('aria-label') || '') + (btn.getAttribute('title') || '');
                return !t.includes('文档') && !t.includes('文本');
              });
            if (vBtns.length > 0) {
              downloadBtn = vBtns[vBtns.length - 1];
              log('[Physical Media] Locked download button via last-resort fallback');
            }
          }
        }
        
        if (downloadBtn) {
          if (isAutoSyncEnabled) {
            log(`[Physical Media] Auto Sync ON: Auto clicking download button for ${isVideo ? 'video' : 'image'}...`);
            
            // 显式推送认领池，终结后端的乱序重命名！
            if (activeTaskId) {
              GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.pushUrl,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ taskId: activeTaskId, action: 'download-alert' }),
                onload: () => log(`[Alert] Watchdog notified for Task ${activeTaskId} right before download`)
              });
            }

            // 【彻底防史前重下】：一旦触发原生下载，永久记录此媒体到 localStorage
            markMediaAsCompleted(url);
            if (activeTaskId) {
              localStorage.setItem('doubao_downloaded_task_' + activeTaskId, 'true');
            }
            log(`[Physical Media] Marked stable URL & TaskID as COMPLETED to prevent future scrolling re-downloads.`);

            processedImages.add(url);
            downloadBtn.click(); // 触发豆包原生下载 -> 后端 Watchdog 接收
            clearTaskState(activeTaskId);
            return true;
          } else {
            log(`[Physical Media] Auto Sync OFF: 媒体已加烙印。挂起等待用户手动点击下载...`);
            processedImages.add(url);
            continue; // 跳过当前循环，保留任务状态和打上的烙印
          }
        }

        // 对于所有媒体任务（图像和视频），如果没找到原生下载按钮，我们不降级推送数据流，而是等待下一次嗅探重试
        log(`[Physical Media] 媒体下载按钮暂未就绪，等待下一次嗅探...`);
        processedImages.delete(url); // 移出已处理缓存，以备下一轮检测
        continue;
      }
    } catch (e) { /* 静默 */ }
    return false;
  }

  // ============================================================
  // 结果媒体下行嗅探器
  // ============================================================

  // (原 initResultMediaSniffer 已被 UnifiedObserver 替代并移除)

  // ============================================================
  // 启动
  // ============================================================

  function bootstrap() {
    log('Event-Driven Stealth Bridge V5 initialized.');
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
