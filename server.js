// Only load .env in local dev — Railway injects vars directly into process.env
if (!process.env.RAILWAY_PUBLIC_DOMAIN) {
  require('dotenv').config();
}

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

// ─── Config — validate required vars at startup ───────────────────────────────
const config = {
  clientId:     process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  refreshToken: process.env.OAUTH_REFRESH_TOKEN, // optional — set after first auth
  port:         process.env.PORT || 3002,
  baseUrl:      process.env.BASE_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : null), // resolved after port is known
};

const REQUIRED = ['clientId', 'clientSecret'];
const missing = REQUIRED.filter(k => !config[k]);
if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.map(k => ({
    clientId: 'OAUTH_CLIENT_ID', clientSecret: 'OAUTH_CLIENT_SECRET'
  })[k]).join(', ')}`);
  process.exit(1);
}

// Resolve BASE_URL now that port is confirmed
if (!config.baseUrl) config.baseUrl = `http://localhost:${config.port}`;

const PORT = config.port;
const BASE_URL = config.baseUrl;
const POLL_INTERVAL_MS = 8000; // 8s minimum → ~9,000 units for 4hr stream (fits in 10k daily quota)

// Random token generated at startup — injected into dashboard HTML, required on sensitive endpoints
const DASHBOARD_TOKEN = require('crypto').randomBytes(24).toString('hex');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── OAuth2 setup ─────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  config.clientId,
  config.clientSecret,
  `${BASE_URL}/auth/callback`
);

// Save updated tokens — env var takes priority, fallback to file for local dev
function saveTokens(tokens) {
  if (!process.env.RAILWAY_PUBLIC_DOMAIN) {
    // Local: write to file
    try { fs.writeFileSync(path.join(__dirname, 'tokens.json'), JSON.stringify(tokens)); } catch {}
  }
  if (tokens.refresh_token) {
    console.log('✅ Refresh token received. Add OAUTH_REFRESH_TOKEN to your Railway env vars.');
  }
}

oauth2Client.on('tokens', tokens => {
  const existing = loadTokens() || {};
  saveTokens({ ...existing, ...tokens });
});

function loadTokens() {
  // Prefer env var (Railway), fallback to file (local)
  if (config.refreshToken) {
    return { refresh_token: config.refreshToken };
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

let youtubeStatus = { connected: false, title: null };

function broadcastYouTubeStatus() {
  broadcast({ type: 'youtube', ...youtubeStatus });
}

// ─── Task helpers ─────────────────────────────────────────────────────────────
function getOrCreate(user) {
  if (!userTodos[user]) userTodos[user] = [];
  return userTodos[user];
}

const MAX_TASK_LENGTH = 100;
const MAX_TASKS_PER_USER = 20;
const CMD_COOLDOWN_MS = 2000; // 1 command per user per 2s
const lastCmdTime = {};

// ─── Command parser ───────────────────────────────────────────────────────────
function handleCommand(user, message) {
  const msg = message.trim().slice(0, 500); // cap raw message length
  const lower = msg.toLowerCase();
  const safeUser = user.slice(0, 64);

  const now = Date.now();
  if (lastCmdTime[safeUser] && now - lastCmdTime[safeUser] < CMD_COOLDOWN_MS) return;
  lastCmdTime[safeUser] = now;
  setTimeout(() => delete lastCmdTime[safeUser], CMD_COOLDOWN_MS);

  if (lower.startsWith('!add ')) {
    const taskStr = msg.slice(5).trim();
    if (!taskStr) return;
    const todos = getOrCreate(safeUser);
    if (todos.length >= MAX_TASKS_PER_USER) return;
    const newTasks = taskStr.split(',').map(t => t.trim().slice(0, MAX_TASK_LENGTH)).filter(Boolean);
    const slotsLeft = MAX_TASKS_PER_USER - todos.length;
    newTasks.slice(0, slotsLeft).forEach(task => {
      todos.push({ id: nextId++, task, done: false, addedAt: Date.now() });
    });
    broadcastUser(safeUser);
    console.log(`[${safeUser}] added: ${newTasks.join(', ')}`);
    return;
  }

  if (lower.startsWith('!done')) {
    const todos = getOrCreate(safeUser);
    const arg = msg.slice(5).trim();
    if (arg) {
      const num = parseInt(arg, 10);
      if (!isNaN(num) && num >= 1 && num <= todos.length) {
        todos[num - 1].done = true;
        broadcastUser(safeUser);
        console.log(`[${safeUser}] done #${num}`);
      }
    } else {
      const idx = todos.findIndex(t => !t.done);
      if (idx !== -1) {
        todos[idx].done = true;
        broadcastUser(safeUser);
        console.log(`[${safeUser}] done current task`);
      }
    }
    return;
  }

  if (lower.startsWith('!remove ') || lower.startsWith('!del ')) {
    const todos = getOrCreate(safeUser);
    const arg = msg.replace(/^!(remove|del)\s+/i, '').trim();
    const num = parseInt(arg, 10);
    if (!isNaN(num) && num >= 1 && num <= todos.length) {
      todos.splice(num - 1, 1);
      broadcastUser(safeUser);
      console.log(`[${safeUser}] removed #${num}`);
    }
    return;
  }

  if (lower === '!clear') {
    userTodos[safeUser] = [];
    broadcastUser(safeUser);
    console.log(`[${safeUser}] cleared list`);
    return;
  }

  if (lower.startsWith('!undone ')) {
    const todos = getOrCreate(safeUser);
    const num = parseInt(msg.slice(8).trim(), 10);
    if (!isNaN(num) && num >= 1 && num <= todos.length) {
      todos[num - 1].done = false;
      broadcastUser(safeUser);
      console.log(`[${safeUser}] undone #${num}`);
    }
    return;
  }

  const isHost = safeUser === '_host' || (hostDisplayName && safeUser === hostDisplayName);

  if (lower === '!start') {
    if (!isHost) return;
    broadcast({ type: 'control', action: 'start' });
    console.log(`[${safeUser}] overlay scroll started`);
    return;
  }

  if (lower === '!stop') {
    if (!isHost) return;
    broadcast({ type: 'control', action: 'stop' });
    console.log(`[${safeUser}] overlay scroll stopped`);
    return;
  }
}

// ─── YouTube Live Chat polling ────────────────────────────────────────────────
let pageToken = null;
let activeLiveChatId = null;
let hostDisplayName = null; // set from YouTube channel on first auth
let pollingEnabled = true;  // set false via /disconnect to stop all API calls
let isScanning    = false;  // prevents double polling if /auth called while already scanning

function resetYouTubeState() {
  activeLiveChatId = null;
  pageToken = null;
  scanStartTime = null;
  isScanning = false;
  fetchRetries = 0;
  pollRetries = 0;
  youtubeStatus = { connected: false, title: null };
  broadcastYouTubeStatus();
}

function stopPolling() {
  pollingEnabled = false;
  resetYouTubeState();
  console.log('YouTube polling stopped via dashboard.');
}

const MAX_RETRIES = 5;
const MAX_SCAN_MS = 10 * 60 * 1000; // stop scanning 10 min after stream ends
let fetchRetries = 0;
let pollRetries  = 0;
let lastPollInterval = POLL_INTERVAL_MS; // track YouTube's requested interval
let scanStartTime = null;

async function fetchLiveChatId() {
  if (!pollingEnabled || isScanning) return;
  isScanning = true;
  if (!scanStartTime) scanStartTime = Date.now();
  if (Date.now() - scanStartTime > MAX_SCAN_MS) {
    console.log('No stream found after 10 min — scan stopped. Visit /auth to restart.');
    resetYouTubeState();
    return;
  }

  try {
    const res = await youtube.liveBroadcasts.list({
      part: ['snippet', 'status'],
      broadcastType: 'all',
      mine: true,
    });

    const broadcast = res.data.items?.find(b => b.status?.lifeCycleStatus === 'live');
    if (!broadcast) {
      console.log('No active broadcast found, retrying in 30s...');
      isScanning = false;
      setTimeout(fetchLiveChatId, 30000);
      return;
    }

    const chatId = broadcast.snippet?.liveChatId;
    if (!chatId) {
      console.log('Broadcast found but no live chat, retrying in 30s...');
      isScanning = false;
      setTimeout(fetchLiveChatId, 30000);
      return;
    }

    fetchRetries = 0; // reset on success
    scanStartTime = null; // reset scan timer
    activeLiveChatId = chatId;

    // Resolve host display name from authenticated channel
    if (!hostDisplayName) {
      try {
        const ch = await youtube.channels.list({ part: ['snippet'], mine: true });
        hostDisplayName = ch.data.items?.[0]?.snippet?.title || null;
        if (hostDisplayName) console.log(`   Host identified as: "${hostDisplayName}"`);
      } catch {}
    }

    youtubeStatus = { connected: true, title: broadcast.snippet.title };
    broadcastYouTubeStatus();
    isScanning = false;
    console.log(`✅ Live chat detected: "${broadcast.snippet.title}"`);
    pollYouTubeChat();
  } catch (err) {
    console.error('Error fetching live chat ID:', err.response?.data?.error?.message || err.message);
    if (++fetchRetries >= MAX_RETRIES) {
      console.error(`❌ fetchLiveChatId failed ${MAX_RETRIES} times — giving up. Re-authenticate to restart.`);
      isScanning = false;
      return;
    }
    isScanning = false;
    setTimeout(fetchLiveChatId, 30000);
  }
}

async function pollYouTubeChat() {
  if (!pollingEnabled || !activeLiveChatId) return;
  try {
    const params = {
      liveChatId: activeLiveChatId,
      part: ['snippet', 'authorDetails'],
      maxResults: 200,
    };
    if (pageToken) params.pageToken = pageToken;

    const res = await youtube.liveChatMessages.list(params);

    pollRetries = 0; // reset on success
    pageToken = res.data.nextPageToken;
    const items = res.data.items || [];

    items.forEach(item => {
      const user = item.authorDetails?.displayName;
      const text = item.snippet?.displayMessage || '';
      if (user && text.startsWith('!')) handleCommand(user, text);
    });

    lastPollInterval = Math.max(res.data.pollingIntervalMillis || POLL_INTERVAL_MS, POLL_INTERVAL_MS);
    setTimeout(pollYouTubeChat, lastPollInterval);
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.error?.message || err.message;
    console.error('YouTube chat poll error:', message);
    if (status === 403 || status === 404) {
      resetYouTubeState();
      console.log('Live chat ended, scanning for new stream...');
      setTimeout(fetchLiveChatId, 30000);
    } else {
      if (++pollRetries >= MAX_RETRIES) {
        console.error(`❌ pollYouTubeChat failed ${MAX_RETRIES} times — giving up. Re-authenticate to restart.`);
        return;
      }
      // On "too soon" errors respect YouTube's interval; otherwise back off 2x
      const backoff = message.includes('too soon') ? lastPollInterval : Math.min(lastPollInterval * 2, 60000);
      setTimeout(pollYouTubeChat, backoff);
    }
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── Dashboard auth middleware ────────────────────────────────────────────────
function requireDashboardToken(req, res, next) {
  if (req.headers['x-dashboard-token'] === DASHBOARD_TOKEN) return next();
  res.status(403).json({ error: 'Forbidden' });
}

app.post('/disconnect', requireDashboardToken, (_req, res) => {
  stopPolling();
  res.json({ ok: true });
});

// OAuth routes
app.get('/auth', (_req, res) => {
  pollingEnabled = true; // re-enable if previously disconnected
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
    const { tokens } = await oauth2Client.getToken({ code: String(req.query.code), redirect_uri: `${BASE_URL}/auth/callback` });
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);
    res.send('<h2>✅ Auth successful! You can close this tab.</h2><p>The server is now connected to your YouTube account.</p>');
    console.log('✅ OAuth tokens saved. Starting live chat detection...');
    fetchLiveChatId();
  } catch (err) {
    res.status(500).send('Auth failed: ' + err.message);
  }
});

app.post('/command', requireDashboardToken, (req, res) => {
  const { user, message } = req.body;
  if (!user || !message) return res.status(400).json({ error: 'user and message required' });
  handleCommand(user, message);
  res.json({ todos: userTodos[user] || [] });
});

app.get('/todos', (_req, res) => res.json(userTodos));
app.get('/todos/:user', (req, res) => res.json(userTodos[req.params.user] || []));

app.delete('/todos/:user', requireDashboardToken, (req, res) => {
  userTodos[req.params.user] = [];
  broadcastUser(req.params.user);
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, youtube: youtubeStatus.connected }));
app.get('/', (_req, res) => res.redirect('/dashboard'));
app.get('/overlay', (_req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
app.get('/dashboard', (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  res.send(html.replace('</head>', `<script>window.__DT__="${DASHBOARD_TOKEN}";</script></head>`));
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  console.log('Overlay/dashboard connected');
  ws.send(JSON.stringify({ type: 'all', users: userTodos }));
  ws.send(JSON.stringify({ type: 'youtube', ...youtubeStatus }));

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
  console.log(`   BASE_URL  → ${BASE_URL}`);
  console.log(`   Overlay   → ${BASE_URL}/overlay`);
  console.log(`   Dashboard → ${BASE_URL}/dashboard`);
  console.log(`   client_id set: ${!!config.clientId}`);
  console.log(`   client_secret set: ${!!config.clientSecret}`);

  if (savedTokens) {
    console.log(`   OAuth tokens found — scanning for live stream...`);
    fetchLiveChatId();
  } else {
    console.log(`\n⚠️  Not authenticated yet!`);
    console.log(`   Open this URL to connect your YouTube account:`);
    console.log(`   → ${BASE_URL}/auth\n`);
  }
});
