// Offscreen document that holds the WebSocket connection alive.
// MV3 service workers may be suspended when the popup closes; offscreen keeps a DOM context alive.

let ws = null;
let currentUrl = null;
let reconnectTimer = null;

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

function scheduleReconnect() {
  if (!currentUrl) return;
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket(currentUrl);
  }, reconnectDelayMs);

  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_DELAY_MAX_MS);
}

function connectWebSocket(url) {
  const normalized = normalizeWsUrl(url);
  if (!normalized) return;

  currentUrl = normalized;

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

  ws = new WebSocket(currentUrl);

  ws.onopen = () => {
    reconnectDelayMs = 1000;
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: true });
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data && data.type === 'sms') {
        chrome.runtime.sendMessage({
          type: 'SMS_RECEIVED',
          sender: data.sender,
          message: data.message,
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

  ws.onclose = () => {
    ws = null;
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false });
    scheduleReconnect();
  };
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'CONNECT' && msg.url) {
    connectWebSocket(msg.url);
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

