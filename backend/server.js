const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected clients (Chrome extensions)
const clients = new Set();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('.')); // Serve static files (for test.html)

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('Chrome extension connected');
  clients.add(ws);

  ws.on('close', () => {
    console.log('Chrome extension disconnected');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to SMS Sync server'
  }));
});

// Helper function to broadcast SMS to all connected clients
function broadcastSMS(smsData) {
  const messageStr = JSON.stringify(smsData);
  let sentCount = 0;
  
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
      sentCount++;
    }
  });

  return sentCount;
}

// REST API endpoint to receive SMS from mobile app
app.post('/api/sms', (req, res) => {
  const { sender, message, timestamp } = req.body;

  if (!sender || !message) {
    return res.status(400).json({ error: 'Missing required fields: sender, message' });
  }

  const smsData = {
    type: 'sms',
    sender: sender,
    message: message,
    timestamp: timestamp || new Date().toISOString()
  };

  console.log('Received SMS:', smsData);

  // Broadcast to all connected Chrome extensions
  const sentCount = broadcastSMS(smsData);
  console.log(`Broadcasted SMS to ${sentCount} client(s)`);

  res.json({ 
    success: true, 
    message: 'SMS received and broadcasted',
    clientsNotified: sentCount
  });
});

// Test endpoint to send a test SMS
app.post('/api/test-sms', (req, res) => {
  const { sender, message, timestamp } = req.body;

  // Use default test values if not provided
  const testSmsData = {
    type: 'sms',
    sender: sender || '+1234567890',
    message: message || 'This is a test SMS message',
    timestamp: timestamp || new Date().toISOString()
  };

  console.log('Test SMS received:', testSmsData);

  // Broadcast to all connected Chrome extensions
  const sentCount = broadcastSMS(testSmsData);
  console.log(`Broadcasted test SMS to ${sentCount} client(s)`);

  res.json({ 
    success: true, 
    message: 'Test SMS sent and broadcasted',
    clientsNotified: sentCount,
    data: testSmsData
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connectedClients: clients.size,
    timestamp: new Date().toISOString()
  });
});

// Get server info
app.get('/api/info', (req, res) => {
  res.json({
    name: 'SMS Sync Backend',
    version: '1.0.0',
    connectedClients: clients.size,
    uptime: process.uptime()
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`SMS Sync Backend Server running on port ${PORT}`);
  console.log(`WebSocket server ready for Chrome extension connections`);
  console.log(`API endpoint: http://localhost:${PORT}/api/sms`);
  console.log(`Test endpoint: http://localhost:${PORT}/api/test-sms`);
  console.log(`Test page: http://localhost:${PORT}/test.html`);
  console.log(`\nExample test request:`);
  console.log(`curl -X POST http://localhost:${PORT}/api/test-sms \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '{"sender": "+1234567890", "message": "Test message"}'`);
});

