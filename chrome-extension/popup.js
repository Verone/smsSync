let ws = null;
let messages = [];

// Load saved backend URL
chrome.storage.sync.get(['backendUrl'], (result) => {
    if (result.backendUrl) {
        document.getElementById('backendUrl').value = result.backendUrl;
        connectWebSocket(result.backendUrl);
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
        
        chrome.storage.sync.set({ backendUrl: wsUrl }, () => {
            connectWebSocket(wsUrl);
        });
    }
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
                
                if (data.type === 'sms') {
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
    const message = {
        sender: data.sender,
        message: data.message,
        timestamp: data.timestamp || new Date().toISOString()
    };

    messages.unshift(message); // Add to beginning
    if (messages.length > 100) {
        messages = messages.slice(0, 100); // Keep only last 100
    }

    // Save to storage
    chrome.storage.local.set({ messages: messages }, () => {
        renderMessages();
    });

    // Show notification
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: `SMS from ${data.sender}`,
        message: data.message.substring(0, 100)
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
        
        return `
            <div class="message-item">
                <div class="message-header">
                    <span class="message-sender">${escapeHtml(msg.sender)}</span>
                    <span class="message-time">${timeStr}</span>
                </div>
                <div class="message-body">${escapeHtml(msg.message)}</div>
            </div>
        `;
    }).join('');
}

function updateStatus(text, connected) {
    const statusText = document.getElementById('statusText');
    const statusDot = document.getElementById('statusDot');
    
    statusText.textContent = text;
    statusDot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

