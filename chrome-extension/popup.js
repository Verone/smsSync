let ws = null;
let messages = [];

// Keep the UI in sync with background updates.
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.messages) {
        messages = changes.messages.newValue || [];
        renderMessages();
    }
});

// Receive connection status updates from background/offscreen.
chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'WS_STATUS' && typeof msg.connected === 'boolean') {
        updateStatus(msg.connected ? 'Connected' : 'Disconnected', msg.connected);
    }
});

// Ask background for the last known status so the popup looks correct immediately.
chrome.runtime.sendMessage({ type: 'REQUEST_WS_STATUS' }, (resp) => {
    if (resp && typeof resp.connected === 'boolean') {
        updateStatus(resp.connected ? 'Connected' : 'Disconnected', resp.connected);
    }
});

// Load saved backend URL and API Secret
chrome.storage.sync.get(['backendUrl', 'lastBackendUrl', 'apiSecret'], (result) => {
    if (result.backendUrl || result.lastBackendUrl) {
        document.getElementById('backendUrl').value = result.backendUrl || result.lastBackendUrl;
    }
    if (result.apiSecret) {
        document.getElementById('apiSecret').value = result.apiSecret;
    }
});

// Load saved messages
chrome.storage.local.get(['messages'], (result) => {
    if (result.messages) {
        messages = result.messages;
        renderMessages();
    }
});

// Save button click
document.getElementById('saveBtn').addEventListener('click', () => {
    const url = document.getElementById('backendUrl').value.trim();
    const apiSecret = document.getElementById('apiSecret').value.trim();
    if (url) {
        // Convert http/https to ws/wss
        let wsUrl = url;
        if (url.startsWith('http://')) {
            wsUrl = url.replace('http://', 'ws://');
        } else if (url.startsWith('https://')) {
            wsUrl = url.replace('https://', 'wss://');
        } else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
            // If no protocol, assume wss for security
            wsUrl = 'wss://' + url;
        }
        
        updateStatus('Connecting...', false);
        chrome.storage.sync.set({ backendUrl: wsUrl, lastBackendUrl: wsUrl, apiSecret: apiSecret });
    }
});

// Disconnect button click
document.getElementById('disconnectBtn').addEventListener('click', () => {
    chrome.storage.sync.remove(['backendUrl'], () => {
        updateStatus('Disconnected', false);
    });
});

// Clear button click
document.getElementById('clearBtn').addEventListener('click', () => {
    messages = [];
    chrome.storage.local.set({ messages: [] }, () => {
        renderMessages();
    });
});

function connectWebSocket(url) {
    // Close existing connection
    if (ws) {
        ws.close();
    }

    updateStatus('Connecting...', false);

    try {
        ws = new WebSocket(url);

        ws.onopen = () => {
            console.log('WebSocket connected');
            updateStatus('Connected', true);
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'sms' || data.type === 'mms') {
                    handleSMS(data);
                } else if (data.type === 'connected') {
                    console.log('Server:', data.message);
                }
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            updateStatus('Connection Error', false);
        };

        ws.onclose = () => {
            console.log('WebSocket disconnected');
            updateStatus('Disconnected', false);
            ws = null;
            
            // Try to reconnect after 3 seconds
            setTimeout(() => {
                if (document.getElementById('backendUrl').value) {
                    connectWebSocket(document.getElementById('backendUrl').value);
                }
            }, 3000);
        };
    } catch (error) {
        console.error('Failed to create WebSocket:', error);
        updateStatus('Connection Failed', false);
    }
}

function handleSMS(data) {
    const isMms = data.type === 'mms';
    const message = {
        msgType: data.type || 'sms',
        sender: data.sender,
        message: data.message || '',
        subject: data.subject || null,
        attachments: data.attachments || [],
        timestamp: data.timestamp || new Date().toISOString()
    };

    messages.unshift(message);
    if (messages.length > 100) {
        messages = messages.slice(0, 100);
    }

    chrome.storage.local.set({ messages: messages }, () => {
        renderMessages();
    });

    const notifBody = data.message
        ? data.message.substring(0, 100)
        : isMms ? (data.subject || '[imagem/mídia]') : '';
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: `${isMms ? 'MMS' : 'SMS'} from ${data.sender}`,
        message: notifBody
    });
}

function renderMessages() {
    const messagesList = document.getElementById('messagesList');
    
    if (messages.length === 0) {
        messagesList.innerHTML = '<p class="empty-message">No messages yet. Connect to start receiving SMS.</p>';
        return;
    }

    messagesList.innerHTML = messages.map(msg => {
        const date = new Date(msg.timestamp);
        const timeStr = date.toLocaleString();
        const isMms = msg.msgType === 'mms';
        const badge = isMms ? '<span class="mms-badge">MMS</span>' : '';
        const subject = msg.subject ? `<div class="message-subject">${escapeHtml(msg.subject)}</div>` : '';
        const body = msg.message ? `<div class="message-body">${escapeHtml(msg.message)}</div>` : '';
        const images = (msg.attachments || [])
            .filter(a => a.contentType && a.contentType.startsWith('image/'))
            .map(a => `<img class="mms-image" src="data:${escapeHtml(a.contentType)};base64,${a.data}" alt="${escapeHtml(a.name || 'imagem')}" />`)
            .join('');

        return `
            <div class="message-item">
                <div class="message-header">
                    <span class="message-sender">${badge}${escapeHtml(msg.sender)}</span>
                    <span class="message-time">${timeStr}</span>
                </div>
                ${subject}${body}${images}
            </div>
        `;
    }).join('');
}

function updateStatus(text, connected) {
    const statusText = document.getElementById('statusText');
    const statusDot = document.getElementById('statusDot');
    
    statusText.textContent = text;
    statusDot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
    
    // Disable inputs while connected or connecting
    const isConnectingOrConnected = connected || text === 'Connecting...';
    document.getElementById('backendUrl').disabled = isConnectingOrConnected;
    document.getElementById('apiSecret').disabled = isConnectingOrConnected;
    
    // Toggle buttons
    document.getElementById('saveBtn').style.display = isConnectingOrConnected ? 'none' : 'block';
    document.getElementById('disconnectBtn').style.display = isConnectingOrConnected ? 'block' : 'none';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

