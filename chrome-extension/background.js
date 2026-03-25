// Background service worker for Chrome extension
// This keeps the WebSocket connection alive even when popup is closed

let ws = null;
let reconnectInterval = null;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Load backend URL and connect on startup
chrome.storage.sync.get(['backendUrl'], (result) => {
    if (result.backendUrl) {
        connectWebSocket(result.backendUrl);
    }
});

// Listen for storage changes (when user updates backend URL)
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.backendUrl) {
        const newUrl = changes.backendUrl.newValue;
        if (newUrl) {
            reconnectAttempts = 0; // Reset attempts on manual URL change
            connectWebSocket(newUrl);
        } else {
            // URL was cleared, disconnect
            disconnectWebSocket();
        }
    }
});

function disconnectWebSocket() {
    if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
    }
    if (ws) {
        ws.close();
        ws = null;
    }
    isConnecting = false;
    reconnectAttempts = 0;
}

function connectWebSocket(url) {
    // Prevent multiple simultaneous connection attempts
    if (isConnecting) {
        console.log('[Background] Connection already in progress, skipping...');
        return;
    }

    // Close existing connection
    if (ws) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
        ws = null;
    }

    // Clear existing reconnect interval
    if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
    }

    // Check if we've exceeded max reconnect attempts
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[Background] Max reconnect attempts reached. Please check backend URL.');
        return;
    }

    isConnecting = true;
    reconnectAttempts++;

    try {
        console.log(`[Background] Attempting to connect to ${url} (attempt ${reconnectAttempts})`);
        ws = new WebSocket(url);

        ws.onopen = () => {
            console.log('[Background] WebSocket connected successfully');
            isConnecting = false;
            reconnectAttempts = 0; // Reset on successful connection
            
            // Clear any pending reconnect interval
            if (reconnectInterval) {
                clearInterval(reconnectInterval);
                reconnectInterval = null;
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'sms') {
                    // Store message
                    chrome.storage.local.get(['messages'], (result) => {
                        let messages = result.messages || [];
                        messages.unshift({
                            sender: data.sender,
                            message: data.message,
                            timestamp: data.timestamp || new Date().toISOString()
                        });
                        
                        if (messages.length > 100) {
                            messages = messages.slice(0, 100);
                        }
                        
                        chrome.storage.local.set({ messages: messages });
                    });

                    // Show notification
                    chrome.notifications.create({
                        type: 'basic',
                        iconUrl: 'icons/icon48.png',
                        title: `SMS from ${data.sender}`,
                        message: data.message.substring(0, 100)
                    });
                } else if (data.type === 'connected') {
                    console.log('[Background] Server:', data.message);
                }
            } catch (error) {
                console.error('[Background] Error parsing message:', error);
            }
        };

        ws.onerror = (error) => {
            console.error('[Background] WebSocket error:', error);
            isConnecting = false;
        };

        ws.onclose = (event) => {
            console.log(`[Background] WebSocket disconnected. Code: ${event.code}, Reason: ${event.reason || 'Unknown'}`);
            isConnecting = false;
            ws = null;
            
            // Only reconnect if it wasn't a manual close (code 1000)
            if (event.code !== 1000 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                // Exponential backoff: 5s, 10s, 20s, etc. (max 30s)
                const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 30000);
                console.log(`[Background] Will attempt reconnect in ${delay/1000} seconds...`);
                
                reconnectInterval = setTimeout(() => {
                    chrome.storage.sync.get(['backendUrl'], (result) => {
                        if (result.backendUrl) {
                            connectWebSocket(result.backendUrl);
                        }
                    });
                }, delay);
            } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                console.error('[Background] Stopped reconnecting. Max attempts reached.');
            }
        };
    } catch (error) {
        console.error('[Background] Failed to create WebSocket:', error);
        isConnecting = false;
        
        // Retry after delay
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 30000);
            reconnectInterval = setTimeout(() => {
                chrome.storage.sync.get(['backendUrl'], (result) => {
                    if (result.backendUrl) {
                        connectWebSocket(result.backendUrl);
                    }
                });
            }, delay);
        }
    }
}

