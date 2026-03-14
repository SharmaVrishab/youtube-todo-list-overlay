require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3002;
const POLL_INTERVAL_MS = 8000; // 8s minimum → ~9,000 units for 4hr stream (fits in 10k daily quota)
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ─── OAuth2 setup ─────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.OAUTH_CLIENT_ID,
  process.env.OAUTH_CLIENT_SECRET,
  `${BASE_URL}/auth/callback`
);

// Save updated tokens — env var takes priority, fallback to file for local dev
function saveTokens(tokens) {
  if (!process.env.BASE_URL) {
    // Local: write to file
    try { fs.writeFileSync(path.join(__dirname, 'tokens.json'), JSON.stringify(tokens)); } catch {}
  }
  // On Railway: log the refresh token so you can copy it into env vars
  if (tokens.refresh_token) {
    console.log(`\n🔑 Save this as OAUTH_REFRESH_TOKEN in your Railway env vars:\n   ${tokens.refresh_token}\n`);
  }
}

oauth2Client.on('tokens', tokens => {
  const existing = loadTokens() || {};
  saveTokens({ ...existing, ...tokens });
});

function loadTokens() {
  // Prefer env var (Railway), fallback to file (local)
  if (process.env.OAUTH_REFRESH_TOKEN) {
    return { refresh_token: process.env.OAUTH_REFRESH_TOKEN };
  }
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json'))); } catch { return null; }
}

const savedTokens = loadTokens();
if (savedTokens) oauth2Client.setCredentials(savedTokens);

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// ─── Data store ──────────────────────────────────────────────────────────────
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

  if (lower === '!clear') {
    userTodos[user] = [];
    broadcastUser(user);
    console.log(`[${user}] cleared list`);
    return;
  }

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

  if (lower === '!start') {
    broadcast({ type: 'control', action: 'start' });
    console.log(`[${user}] overlay scroll started`);
    return;
  }

  if (lower === '!stop') {
    broadcast({ type: 'control', action: 'stop' });
    console.log(`[${user}] overlay scroll stopped`);
    return;
  }
}

// ─── YouTube Live Chat polling ────────────────────────────────────────────────
let pageToken = null;
let activeLiveChatId = null;

async function fetchLiveChatId() {
  try {
    const res = await youtube.liveBroadcasts.list({
      part: ['snippet', 'status'],
      broadcastType: 'all',
      mine: true,
    });

    const broadcast = res.data.items?.find(b => b.status?.lifeCycleStatus === 'live');
    if (!broadcast) {
      console.log('No active broadcast found, retrying in 30s...');
      setTimeout(fetchLiveChatId, 30000);
      return;
    }

    const chatId = broadcast.snippet?.liveChatId;
    if (!chatId) {
      console.log('Broadcast found but no live chat, retrying in 30s...');
      setTimeout(fetchLiveChatId, 30000);
      return;
    }

    activeLiveChatId = chatId;
    console.log(`✅ Live chat detected: "${broadcast.snippet.title}"`);
    pollYouTubeChat();
  } catch (err) {
    console.error('Error fetching live chat ID:', err.response?.data?.error?.message || err.message);
    setTimeout(fetchLiveChatId, 30000);
  }
}

async function pollYouTubeChat() {
  if (!activeLiveChatId) return;
  try {
    const params = {
      liveChatId: activeLiveChatId,
      part: ['snippet', 'authorDetails'],
      maxResults: 200,
    };
    if (pageToken) params.pageToken = pageToken;

    const res = await youtube.liveChatMessages.list(params);

    pageToken = res.data.nextPageToken;
    const items = res.data.items || [];

    items.forEach(item => {
      const user = item.authorDetails.displayName;
      const text = item.snippet.displayMessage || '';
      if (text.startsWith('!')) handleCommand(user, text);
    });

    const interval = Math.max(res.data.pollingIntervalMillis || POLL_INTERVAL_MS, POLL_INTERVAL_MS);
    setTimeout(pollYouTubeChat, interval);
  } catch (err) {
    const status = err.response?.status;
    console.error('YouTube chat poll error:', err.response?.data?.error?.message || err.message);
    if (status === 403 || status === 404) {
      activeLiveChatId = null;
      pageToken = null;
      console.log('Live chat ended, scanning for new stream...');
      setTimeout(fetchLiveChatId, 30000);
    } else {
      setTimeout(pollYouTubeChat, POLL_INTERVAL_MS);
    }
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// OAuth routes
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    redirect_uri: `${BASE_URL}/auth/callback`,
    scope: ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.force-ssl'],
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken({ code: req.query.code, redirect_uri: `${BASE_URL}/auth/callback` });
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);
    res.send('<h2>✅ Auth successful! You can close this tab.</h2><p>The server is now connected to your YouTube account.</p>');
    console.log('✅ OAuth tokens saved. Starting live chat detection...');
    fetchLiveChatId();
  } catch (err) {
    res.status(500).send('Auth failed: ' + err.message);
  }
});

app.post('/command', (req, res) => {
  const { user, message } = req.body;
  if (!user || !message) return res.status(400).json({ error: 'user and message required' });
  handleCommand(user, message);
  res.json({ todos: userTodos[user] || [] });
});

app.get('/todos', (req, res) => res.json(userTodos));
app.get('/todos/:user', (req, res) => res.json(userTodos[req.params.user] || []));

app.delete('/todos/:user', (req, res) => {
  userTodos[req.params.user] = [];
  broadcastUser(req.params.user);
  res.json({ ok: true });
});

app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/debug', (_req, res) => res.json({
  BASE_URL,
  redirect_uri: `${BASE_URL}/auth/callback`,
  has_client_id: !!process.env.OAUTH_CLIENT_ID,
  has_client_secret: !!process.env.OAUTH_CLIENT_SECRET,
}));
app.get('/overlay', (req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  console.log('Overlay/dashboard connected');
  ws.send(JSON.stringify({ type: 'all', users: userTodos }));

  ws.on('message', raw => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'command') handleCommand(data.user, data.message);
    } catch {}
  });

  ws.on('close', () => console.log('Client disconnected'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎬 YouTube To-Do Widget running!`);
  console.log(`   Overlay   → http://localhost:${PORT}/overlay`);
  console.log(`   Dashboard → http://localhost:${PORT}/dashboard`);

  if (savedTokens) {
    console.log(`   OAuth tokens found — scanning for live stream...`);
    fetchLiveChatId();
  } else {
    console.log(`\n⚠️  Not authenticated yet!`);
    console.log(`   Open this URL to connect your YouTube account:`);
    console.log(`   → http://localhost:${PORT}/auth\n`);
  }
});
