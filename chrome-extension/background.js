// Background service worker for Chrome extension.
// IMPORTANT: In MV3, service workers can be suspended, so we keep the WebSocket
// in an offscreen document instead (offscreen.js).

let lastWsConnected = null;

function normalizeWsUrl(input) {
    const url = (input || '').trim();
    if (!url) return '';

    if (url.startsWith('http://')) return url.replace('http://', 'ws://');
    if (url.startsWith('https://')) return url.replace('https://', 'wss://');
    if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
    return 'wss://' + url;
}

async function setupOffscreenDocument() {
    // Offscreen requires permissions: "offscreen" in manifest.
    const offscreenUrl = chrome.runtime.getURL('offscreen.html');

    // If Chrome supports runtime.getContexts (Chrome 116+), avoid creating duplicates.
    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [offscreenUrl]
        });
        if (contexts && contexts.length > 0) return;
    }

    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Keep SMS Sync WebSocket connection alive in the background.'
    });
}

function connectUsingOffscreen(wsUrl, apiSecret) {
    const url = normalizeWsUrl(wsUrl);
    if (!url) return;

    setupOffscreenDocument()
        .then(() => {
            chrome.runtime.sendMessage({
                type: 'CONNECT',
                url,
                apiSecret,
                target: 'offscreen'
            });
        })
        .catch((err) => {
            console.error('[Background] Failed to set up offscreen document:', err);
        });
}

function disconnectUsingOffscreen() {
    chrome.runtime.sendMessage({
        type: 'DISCONNECT',
        target: 'offscreen'
    });
}

function initFromStorage() {
    chrome.storage.sync.get(['backendUrl', 'apiSecret'], (result) => {
        if (result.backendUrl) {
            connectUsingOffscreen(result.backendUrl, result.apiSecret);
        }
    });
}

// Also run immediately when the service worker wakes for any reason.
initFromStorage();

// Ensure we connect on install/startup.
chrome.runtime.onInstalled.addListener(() => initFromStorage());
chrome.runtime.onStartup.addListener(() => initFromStorage());

// Reconnect when user updates backend URL or API Secret.
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && (changes.backendUrl || changes.apiSecret)) {
        chrome.storage.sync.get(['backendUrl', 'apiSecret'], (result) => {
            if (result.backendUrl) {
                connectUsingOffscreen(result.backendUrl, result.apiSecret);
            } else {
                disconnectUsingOffscreen();
            }
        });
    }
});

// Receive messages from offscreen.js (SMS + connection status)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'SMS_RECEIVED') {
        lastWsConnected = true;

        // Store message
        chrome.storage.local.get(['messages'], (result) => {
            let messages = result.messages || [];
            messages.unshift({
                sender: msg.sender,
                message: msg.message,
                timestamp: msg.timestamp || new Date().toISOString()
            });

            if (messages.length > 100) {
                messages = messages.slice(0, 100);
            }

            chrome.storage.local.set({ messages });
        });

        // Show notification
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: `SMS from ${msg.sender}`,
            message: (msg.message || '').substring(0, 100)
        });

        return;
    }

    if (msg.type === 'WS_STATUS') {
        lastWsConnected = Boolean(msg.connected);
        return; // Offscreen already sends WS_STATUS directly; popup can listen too.
    }

    if (msg.type === 'REQUEST_WS_STATUS') {
        sendResponse({ connected: lastWsConnected === true });
        return true;
    }
});

