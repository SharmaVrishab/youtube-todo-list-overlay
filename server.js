require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3002;
const YT_API_KEY = process.env.YOUTUBE_API_KEY || '';
const LIVE_CHAT_ID = process.env.LIVE_CHAT_ID || '';
const POLL_INTERVAL_MS = 5000;

// ─── Data store ──────────────────────────────────────────────────────────────
// userTodos[username] = [{ id, task, done, addedAt }]
const userTodos = {};
let nextId = 1;

// ─── Broadcast helpers ────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function broadcastUser(user) {
  broadcast({ type: 'user', user, todos: userTodos[user] || [] });
}

// ─── Task helpers ─────────────────────────────────────────────────────────────
function getOrCreate(user) {
  if (!userTodos[user]) userTodos[user] = [];
  return userTodos[user];
}

// ─── Command parser ───────────────────────────────────────────────────────────
function handleCommand(user, message) {
  const msg = message.trim();
  const lower = msg.toLowerCase();

  // !add task1, task2, task3
  if (lower.startsWith('!add ')) {
    const taskStr = msg.slice(5).trim();
    if (!taskStr) return;
    const todos = getOrCreate(user);
    const newTasks = taskStr.split(',').map(t => t.trim()).filter(Boolean);
    newTasks.forEach(task => {
      todos.push({ id: nextId++, task, done: false, addedAt: Date.now() });
    });
    broadcastUser(user);
    console.log(`[${user}] added: ${newTasks.join(', ')}`);
    return;
  }

  // !done [number] — if no number, marks the first incomplete task
  if (lower.startsWith('!done')) {
    const todos = getOrCreate(user);
    const arg = msg.slice(5).trim();
    if (arg) {
      const num = parseInt(arg, 10);
      if (!isNaN(num) && num >= 1 && num <= todos.length) {
        todos[num - 1].done = true;
        broadcastUser(user);
        console.log(`[${user}] done #${num}`);
      }
    } else {
      const idx = todos.findIndex(t => !t.done);
      if (idx !== -1) {
        todos[idx].done = true;
        broadcastUser(user);
        console.log(`[${user}] done current task`);
      }
    }
    return;
  }

  // !remove <number>  or  !del <number>
  if (lower.startsWith('!remove ') || lower.startsWith('!del ')) {
    const todos = getOrCreate(user);
    const arg = msg.replace(/^!(remove|del)\s+/i, '').trim();
    const num = parseInt(arg, 10);
    if (!isNaN(num) && num >= 1 && num <= todos.length) {
      todos.splice(num - 1, 1);
      broadcastUser(user);
      console.log(`[${user}] removed #${num}`);
    }
    return;
  }

  // !edit <number> <new text>
  if (lower.startsWith('!edit ')) {
    const todos = getOrCreate(user);
    const parts = msg.slice(6).trim().split(' ');
    const num = parseInt(parts[0], 10);
    const newText = parts.slice(1).join(' ').trim();
    if (!isNaN(num) && num >= 1 && num <= todos.length && newText) {
      todos[num - 1].task = newText;
      broadcastUser(user);
      console.log(`[${user}] edited #${num} -> ${newText}`);
    }
    return;
  }

  // !clear — remove all tasks for the user
  if (lower === '!clear') {
    userTodos[user] = [];
    broadcastUser(user);
    console.log(`[${user}] cleared list`);
    return;
  }

  // !undone <number> — unmark a task
  if (lower.startsWith('!undone ')) {
    const todos = getOrCreate(user);
    const num = parseInt(msg.slice(8).trim(), 10);
    if (!isNaN(num) && num >= 1 && num <= todos.length) {
      todos[num - 1].done = false;
      broadcastUser(user);
      console.log(`[${user}] undone #${num}`);
    }
    return;
  }

  // !start — begin auto-scroll animation on the overlay
  if (lower === '!start') {
    broadcast({ type: 'control', action: 'start' });
    console.log(`[${user}] overlay scroll started`);
    return;
  }

  // !stop — stop auto-scroll animation
  if (lower === '!stop') {
    broadcast({ type: 'control', action: 'stop' });
    console.log(`[${user}] overlay scroll stopped`);
    return;
  }

  // !task — show current task (no-op for overlay, handled by client display)
  // !check — same as !task, just for acknowledgement
}

// ─── YouTube Live Chat polling ────────────────────────────────────────────────
let pageToken = null;

async function pollYouTubeChat() {
  if (!YT_API_KEY || !LIVE_CHAT_ID) return;
  try {
    const params = {
      liveChatId: LIVE_CHAT_ID,
      part: 'snippet,authorDetails',
      key: YT_API_KEY,
      maxResults: 200,
    };
    if (pageToken) params.pageToken = pageToken;

    const res = await axios.get(
      'https://www.googleapis.com/youtube/v3/liveChat/messages',
      { params }
    );

    pageToken = res.data.nextPageToken;
    const items = res.data.items || [];

    items.forEach(item => {
      const user = item.authorDetails.displayName;
      const text = item.snippet.displayMessage || '';
      if (text.startsWith('!')) handleCommand(user, text);
    });

    // Schedule next poll using the interval YouTube recommends
    const interval = res.data.pollingIntervalMillis || POLL_INTERVAL_MS;
    setTimeout(pollYouTubeChat, interval);
  } catch (err) {
    console.error('YouTube chat poll error:', err.response?.data?.error?.message || err.message);
    setTimeout(pollYouTubeChat, POLL_INTERVAL_MS);
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// POST /command — simulate a chat command (for testing / dashboard use)
app.post('/command', (req, res) => {
  const { user, message } = req.body;
  if (!user || !message) return res.status(400).json({ error: 'user and message required' });
  handleCommand(user, message);
  res.json({ todos: userTodos[user] || [] });
});

// GET /todos — all users
app.get('/todos', (req, res) => res.json(userTodos));

// GET /todos/:user — single user
app.get('/todos/:user', (req, res) => {
  res.json(userTodos[req.params.user] || []);
});

// DELETE /todos/:user — clear a user's list (dashboard)
app.delete('/todos/:user', (req, res) => {
  userTodos[req.params.user] = [];
  broadcastUser(req.params.user);
  res.json({ ok: true });
});

// Serve overlay for OBS
app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'overlay.html'));
});

// Serve dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  console.log('Overlay/dashboard connected');
  // Send full state on connect
  ws.send(JSON.stringify({ type: 'all', users: userTodos }));

  ws.on('message', raw => {
    try {
      const data = JSON.parse(raw);
      // Dashboard can send commands directly over WS
      if (data.type === 'command') {
        handleCommand(data.user, data.message);
      }
    } catch {}
  });

  ws.on('close', () => console.log('Client disconnected'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎬 YouTube To-Do Widget running!`);
  console.log(`   Overlay  → http://localhost:${PORT}/overlay`);
  console.log(`   Dashboard→ http://localhost:${PORT}/dashboard`);
  if (YT_API_KEY && LIVE_CHAT_ID) {
    console.log(`   Polling YouTube Live Chat...`);
    pollYouTubeChat();
  } else {
    console.log(`   ⚠️  No YOUTUBE_API_KEY / LIVE_CHAT_ID set — use dashboard or POST /command`);
  }
});
