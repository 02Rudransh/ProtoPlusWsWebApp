/*
 * WebSocket Server for Long Distance Communication Devices
 * Node.js Server - Complete Production-Ready Version
 * 
 * Run: node server.js
 * The server will listen on port 8080 (or PORT environment variable)
 */

const WebSocket = require('ws');
const http = require('http');

// ===== CONFIGURATION =====
const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const CONNECTION_TIMEOUT = 60000; // 60 seconds

// ===== CREATE HTTP SERVER =====
const server = http.createServer();

// ===== CREATE WEBSOCKET SERVER =====
const wss = new WebSocket.Server({
  server,
  clientTracking: true,
  perMessageDeflate: false
});

// ===== DATA STRUCTURES =====
// Store connected devices: { deviceId: { ws, partnerId, connected, lastHeartbeat } }
const devices = new Map();

// Store device pairs: { device_001: device_002, device_002: device_001 }
const devicePairs = new Map();

// Statistics
const stats = {
  totalConnections: 0,
  totalMessages: 0,
  totalSignals: 0,
  totalAcknowledgments: 0,
  startTime: new Date()
};

// ===== UTILITY FUNCTIONS =====
function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...data
  };

  const emoji = {
    'INFO': '📘',
    'SUCCESS': '✅',
    'WARNING': '⚠️',
    'ERROR': '❌',
    'DEBUG': '🔍'
  };

  console.log(`${emoji[level] || '📝'} [${timestamp}] ${message}`,
    Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '');
}

function sendToDevice(deviceId, message) {
  const device = devices.get(deviceId);
  if (device && device.ws.readyState === WebSocket.OPEN) {
    try {
      device.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      log('ERROR', `Failed to send message to ${deviceId}`, { error: error.message });
      return false;
    }
  }
  return false;
}

function isDeviceOnline(deviceId) {
  const device = devices.get(deviceId);
  return device && device.ws.readyState === WebSocket.OPEN;
}

function notifyPartnerStatus(deviceId, status) {
  const partnerId = devicePairs.get(deviceId);
  if (partnerId && isDeviceOnline(partnerId)) {
    sendToDevice(partnerId, {
      type: status === 'online' ? 'partner_online' : 'partner_offline',
      partnerId: deviceId,
      timestamp: new Date().toISOString()
    });
  }
}

function cleanupDevice(deviceId) {
  if (!deviceId) return;

  log('INFO', `Cleaning up device: ${deviceId}`);

  // Notify partner
  notifyPartnerStatus(deviceId, 'offline');

  // Remove from active devices
  devices.delete(deviceId);

  // Don't remove from devicePairs - allow reconnection
}

// ===== WEBSOCKET SERVER EVENTS =====
log('INFO', '🚀 WebSocket Server Starting...');

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  const connectionId = Math.random().toString(36).substring(7);

  stats.totalConnections++;

  log('SUCCESS', `New connection from ${clientIp}`, {
    connectionId,
    totalConnections: wss.clients.size
  });

  let currentDeviceId = null;
  let heartbeatTimer = null;

  // Set connection timeout
  const connectionTimeout = setTimeout(() => {
    if (!currentDeviceId) {
      log('WARNING', 'Connection timeout - device did not register', { connectionId });
      ws.close(1000, 'Registration timeout');
    }
  }, CONNECTION_TIMEOUT);

  // Send welcome message
  try {
    ws.send(JSON.stringify({
      type: 'welcome',
      message: 'Connected to Long Distance Device Server',
      connectionId: connectionId,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    log('ERROR', 'Failed to send welcome message', { error: error.message });
  }

  // Setup heartbeat
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
    if (currentDeviceId) {
      const device = devices.get(currentDeviceId);
      if (device) {
        device.lastHeartbeat = Date.now();
      }
    }
  });

  // ===== MESSAGE HANDLER =====
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      stats.totalMessages++;

      log('DEBUG', `Message from ${currentDeviceId || 'unregistered'}`, {
        type: data.type,
        from: data.from || currentDeviceId
      });

      handleMessage(ws, data);
    } catch (error) {
      log('ERROR', 'Error parsing message', {
        error: error.message,
        deviceId: currentDeviceId
      });

      try {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
          error: error.message
        }));
      } catch (sendError) {
        log('ERROR', 'Failed to send error message', { error: sendError.message });
      }
    }
  });

  // ===== CLOSE HANDLER =====
  ws.on('close', (code, reason) => {
    clearTimeout(connectionTimeout);
    clearInterval(heartbeatTimer);

    log('INFO', `Device disconnected: ${currentDeviceId || 'unregistered'}`, {
      code,
      reason: reason.toString(),
      connectionId
    });

    cleanupDevice(currentDeviceId);
  });

  // ===== ERROR HANDLER =====
  ws.on('error', (error) => {
    log('ERROR', `WebSocket error for ${currentDeviceId || 'unregistered'}`, {
      error: error.message,
      connectionId
    });
  });

  // ===== MESSAGE ROUTING =====
  function handleMessage(ws, data) {
    const { type } = data;

    switch (type) {
      case 'register':
        handleRegister(ws, data);
        break;

      case 'send_signal':
        handleSendSignal(ws, data);
        break;

      case 'receive_ack':
        handleReceiveAck(ws, data);
        break;

      case 'heartbeat':
      case 'ping':
        // Respond to heartbeat/ping
        try {
          ws.send(JSON.stringify({
            type: 'heartbeat_ack',
            timestamp: new Date().toISOString()
          }));
        } catch (error) {
          log('ERROR', 'Failed to send heartbeat ack', { error: error.message });
        }
        break;

      case 'status_request':
        handleStatusRequest(ws);
        break;

      default:
        log('WARNING', `Unknown message type: ${type}`, { deviceId: currentDeviceId });
        try {
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unknown message type: ${type}`
          }));
        } catch (error) {
          log('ERROR', 'Failed to send unknown type error', { error: error.message });
        }
    }
  }

  // ===== HANDLE DEVICE REGISTRATION =====
  function handleRegister(ws, data) {
    const { deviceId, partnerId } = data;

    if (!deviceId || !partnerId) {
      try {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Missing deviceId or partnerId'
        }));
      } catch (error) {
        log('ERROR', 'Failed to send registration error', { error: error.message });
      }
      return;
    }

    clearTimeout(connectionTimeout);
    currentDeviceId = deviceId;

    // Check if device was already registered (reconnection)
    const existingDevice = devices.get(deviceId);
    if (existingDevice) {
      log('INFO', `Device reconnecting: ${deviceId}`);
      // Close old connection
      try {
        existingDevice.ws.close();
      } catch (error) {
        // Ignore error on closing old connection
      }
    }

    // Store device connection
    devices.set(deviceId, {
      ws: ws,
      partnerId: partnerId,
      connected: Date.now(),
      lastHeartbeat: Date.now()
    });

    // Store device pair
    devicePairs.set(deviceId, partnerId);

    log('SUCCESS', `Device registered: ${deviceId}`, {
      partnerId,
      totalDevices: devices.size
    });

    // Send registration confirmation
    try {
      ws.send(JSON.stringify({
        type: 'registered',
        deviceId: deviceId,
        partnerId: partnerId,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      log('ERROR', 'Failed to send registration confirmation', { error: error.message });
    }

    // Check if partner is online
    if (isDeviceOnline(partnerId)) {
      // Notify this device that partner is online
      sendToDevice(deviceId, {
        type: 'partner_online',
        partnerId: partnerId,
        timestamp: new Date().toISOString()
      });

      // Notify partner that this device is online
      sendToDevice(partnerId, {
        type: 'partner_online',
        partnerId: deviceId,
        timestamp: new Date().toISOString()
      });

      log('SUCCESS', `Both devices online: ${deviceId} ↔ ${partnerId}`);
    } else {
      // Partner is offline
      try {
        ws.send(JSON.stringify({
          type: 'partner_offline',
          partnerId: partnerId,
          timestamp: new Date().toISOString()
        }));
      } catch (error) {
        log('ERROR', 'Failed to send partner offline message', { error: error.message });
      }

      log('INFO', `Waiting for partner: ${partnerId}`);
    }

    // Start heartbeat for this connection
    heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
  }

  // ===== HANDLE SEND SIGNAL =====
  function handleSendSignal(ws, data) {
    const { from, to } = data;

    if (!from || !to) {
      try {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Missing from or to field'
        }));
      } catch (error) {
        log('ERROR', 'Failed to send signal error', { error: error.message });
      }
      return;
    }

    stats.totalSignals++;
    log('SUCCESS', `📤 Signal: ${from} → ${to}`);

    // Verify sender is registered
    if (from !== currentDeviceId) {
      log('WARNING', `Device ${currentDeviceId} trying to send as ${from}`);
      try {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Device ID mismatch'
        }));
      } catch (error) {
        log('ERROR', 'Failed to send mismatch error', { error: error.message });
      }
      return;
    }

    // Check if target device is online
    if (!isDeviceOnline(to)) {
      log('WARNING', `Target device ${to} not available`);
      try {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Target device not connected',
          targetDevice: to
        }));
      } catch (error) {
        log('ERROR', 'Failed to send target not available error', { error: error.message });
      }
      return;
    }

    // Forward signal to target device
    const success = sendToDevice(to, {
      type: 'send_signal',
      from: from,
      to: to,
      timestamp: new Date().toISOString()
    });

    if (success) {
      log('SUCCESS', `✅ Signal forwarded to ${to}`);
    } else {
      log('ERROR', `Failed to forward signal to ${to}`);
      try {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Failed to forward signal'
        }));
      } catch (error) {
        log('ERROR', 'Failed to send forward error', { error: error.message });
      }
    }
  }

  // ===== HANDLE RECEIVE ACKNOWLEDGMENT =====
  function handleReceiveAck(ws, data) {
    const { from, to } = data;

    if (!from || !to) {
      try {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Missing from or to field'
        }));
      } catch (error) {
        log('ERROR', 'Failed to send ack error', { error: error.message });
      }
      return;
    }

    stats.totalAcknowledgments++;
    log('SUCCESS', `📥 Acknowledgment: ${from} → ${to}`);

    // Send acknowledgment to both devices
    const devicesToNotify = [from, to];
    let successCount = 0;

    devicesToNotify.forEach(deviceId => {
      const success = sendToDevice(deviceId, {
        type: 'receive_ack',
        from: from,
        to: to,
        timestamp: new Date().toISOString()
      });

      if (success) {
        successCount++;
      }
    });

    log('SUCCESS', `✅ Acknowledgment sent to ${successCount}/2 devices`);
  }

  // ===== HANDLE STATUS REQUEST =====
  function handleStatusRequest(ws) {
    const deviceList = Array.from(devices.keys());
    const pairsList = Array.from(devicePairs.entries());

    try {
      ws.send(JSON.stringify({
        type: 'status_response',
        connectedDevices: deviceList,
        devicePairs: pairsList,
        stats: stats,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      log('ERROR', 'Failed to send status response', { error: error.message });
    }
  }
});

// ===== HTTP SERVER FOR HEALTH CHECK =====
server.on('request', (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/health' || req.url === '/') {
    const deviceList = Array.from(devices.keys());
    const uptime = Math.floor(process.uptime());

    const healthData = {
      status: 'ok',
      uptime: uptime,
      uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
      connectedDevices: devices.size,
      deviceList: deviceList,
      devicePairs: devicePairs.size,
      stats: {
        totalConnections: stats.totalConnections,
        totalMessages: stats.totalMessages,
        totalSignals: stats.totalSignals,
        totalAcknowledgments: stats.totalAcknowledgments,
        startTime: stats.startTime
      },
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthData, null, 2));

  } else if (req.url === '/stats') {
    const statsData = {
      ...stats,
      connectedDevices: devices.size,
      devicePairs: devicePairs.size,
      activeConnections: wss.clients.size,
      timestamp: new Date().toISOString()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statsData, null, 2));

  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n\nAvailable endpoints:\n- GET /health\n- GET /stats');
  }
});

// ===== HEARTBEAT CHECKER =====
const heartbeatChecker = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      log('WARNING', 'Terminating inactive connection');
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// ===== START SERVER =====
server.listen(PORT, () => {
  log('SUCCESS', `🚀 Server running on port ${PORT}`);
  log('INFO', `📡 WebSocket endpoint: ws://localhost:${PORT}`);
  log('INFO', `🏥 Health check: http://localhost:${PORT}/health`);
  log('INFO', `📊 Statistics: http://localhost:${PORT}/stats`);
  log('INFO', `\n💡 Waiting for device connections...`);
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGTERM', () => {
  log('WARNING', '🛑 Server shutting down...');

  clearInterval(heartbeatChecker);

  // Close all WebSocket connections
  wss.clients.forEach(client => {
    client.close(1001, 'Server shutting down');
  });

  // Close server
  server.close(() => {
    log('SUCCESS', '✅ Server closed gracefully');
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    log('ERROR', '❌ Forcing server shutdown');
    process.exit(1);
  }, 10000);
});

process.on('SIGINT', () => {
  log('WARNING', '\n🛑 Received SIGINT, shutting down...');
  process.emit('SIGTERM');
});

// ===== ERROR HANDLERS =====
process.on('uncaughtException', (error) => {
  log('ERROR', '❌ Uncaught Exception:', { error: error.message, stack: error.stack });
  // Don't exit - keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  log('ERROR', '❌ Unhandled Rejection:', { reason, promise });
  // Don't exit - keep server running
});

// ===== PERIODIC STATUS LOG =====
setInterval(() => {
  const activeDevices = Array.from(devices.keys());
  if (activeDevices.length > 0) {
    log('INFO', `📊 Status Report`, {
      activeDevices: activeDevices,
      totalConnections: wss.clients.size,
      totalSignals: stats.totalSignals,
      totalAcknowledgments: stats.totalAcknowledgments,
      uptime: `${Math.floor(process.uptime() / 60)} minutes`
    });
  } else {
    log('INFO', '📊 No devices currently connected');
  }
}, 60000); // Log every minute

log('SUCCESS', '✅ Server initialization complete');