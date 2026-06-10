// Offscreen document that holds the WebSocket connection alive.
// MV3 service workers may be suspended when the popup closes; offscreen keeps a DOM context alive.

let ws = null;
let currentUrl = null;
let currentApiSecret = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

let reconnectDelayMs = 1000;
const RECONNECT_DELAY_MAX_MS = 30000;

function normalizeWsUrl(input) {
  const url = (input || '').trim();
  if (!url) return '';

  if (url.startsWith('http://')) return url.replace('http://', 'ws://');
  if (url.startsWith('https://')) return url.replace('https://', 'wss://');

  if (url.startsWith('ws://') || url.startsWith('wss://')) return url;

  // Default to wss for security if protocol is missing.
  return 'wss://' + url;
}

function scheduleReconnect(closeCode) {
  if (closeCode === 4000) {
    console.error('[Offscreen] Connection rejected: Unauthorized. Stopping reconnect attempts.');
    return;
  }

  if (!currentUrl) return;

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[Offscreen] Max reconnect attempts reached. Giving up.');
    return;
  }

  if (reconnectTimer) return;

  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket(currentUrl, currentApiSecret);
  }, reconnectDelayMs);

  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_DELAY_MAX_MS);
}

function connectWebSocket(url, apiSecret) {
  const normalized = normalizeWsUrl(url);
  if (!normalized) return;

  currentUrl = normalized;
  if (apiSecret !== undefined) {
    currentApiSecret = apiSecret;
  }

  // Close existing connection before reconnecting.
  if (ws) {
    try {
      ws.close();
    } catch (_) {
      // ignore
    }
    ws = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Let background/popup know we are trying again.
  chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false });

  let finalUrl = currentUrl;
  if (currentApiSecret) {
    if (finalUrl.includes('?')) {
      finalUrl += `&token=${encodeURIComponent(currentApiSecret)}`;
    } else {
      finalUrl += `?token=${encodeURIComponent(currentApiSecret)}`;
    }
  }

  ws = new WebSocket(finalUrl);

  ws.onopen = () => {
    reconnectDelayMs = 1000;
    reconnectAttempts = 0;
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: true });
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data && (data.type === 'sms' || data.type === 'mms')) {
        chrome.runtime.sendMessage({
          type: 'SMS_RECEIVED',
          msgType: data.type,
          sender: data.sender,
          message: data.message || '',
          subject: data.subject || null,
          attachments: data.attachments || [],
          timestamp: data.timestamp || new Date().toISOString()
        });
      }
    } catch (err) {
      // Parsing errors shouldn't kill the socket.
      console.error('[Offscreen] Failed to parse message:', err);
    }
  };

  ws.onerror = (err) => {
    console.error('[Offscreen] WebSocket error:', err);
    // onclose will schedule reconnect.
  };

  ws.onclose = (event) => {
    ws = null;
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false });
    scheduleReconnect(event ? event.code : null);
  };
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'CONNECT' && msg.url) {
    reconnectAttempts = 0;
    reconnectDelayMs = 1000;
    connectWebSocket(msg.url, msg.apiSecret);
  }

  if (msg.type === 'DISCONNECT') {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    currentUrl = null;
    if (ws) {
      try {
        ws.close();
      } catch (_) {
        // ignore
      }
      ws = null;
    }
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false });
  }
});

