const { app, BrowserWindow, session, protocol, nativeImage, dialog, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
const ProfileManager = require('./profile-manager');
const AutoUpdater = require('./auto-updater');

// Paths
// When packaged, __dirname points to app.asar, but extraResources are in process.resourcesPath
const appDir = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar')
  : path.resolve(__dirname, '..');
const repoRoot = app.isPackaged
  ? process.resourcesPath
  : path.resolve(appDir, '..');
const contentRoot = path.join(repoRoot, 'content', 'www.poptropica.com');
const rendererRoot = path.join(appDir, 'src', 'renderer');
const baseHtmlPath = path.join(rendererRoot, 'base-pepper.html');
const exportsRoot = path.join(repoRoot, 'exports');
const iconPngPath = path.join(appDir, 'SwingingVine.png');

// Load store items data at startup (all 572 items from content/www.poptropica.com/items/)
const storeItemsDataPath = path.join(__dirname, 'store-items-all.json');
let STORE_ITEMS_DATA = { cards: [], costumes: [] };
try {
  STORE_ITEMS_DATA = JSON.parse(fs.readFileSync(storeItemsDataPath, 'utf8'));
  console.log(`[Store] Loaded ${STORE_ITEMS_DATA.cards.length} cards and ${STORE_ITEMS_DATA.costumes.length} costumes`);
} catch (err) {
  console.error('[Store] Failed to load store items:', err.message);
}

// User preferences
const userPrefsPath = path.join(contentRoot, 'userPrefs.json');
const defaultUserPrefs = {
  masterVolume: 100,
  musicVolume: 40,
  ambientVolume: 30,
  effectsVolume: 100,
  isMuted: false,
  travelMapVersion: "travelmap.swf",
  isFullscreen: false,
  fpsMode: 60,
  dialogueSpeed: 100
};

// Helper function to load user preferences synchronously
function getUserPrefsSync() {
  try {
    const data = fs.readFileSync(userPrefsPath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return defaultUserPrefs;
  }
}

// Share last captured POST body across interceptors and navigation hooks
let lastBasePost = null;
let lastAvatarUpload = null; // { data: Buffer, _ts: number }
let profilePreviewData = new Map(); // Store profile data for get_embedInfo.php
let embedInfoQueue = []; // Queue to track which profile should respond to next get_embedInfo.php request

// Module-level variables for profile system
let mainWindow = null;
let profileWindow = null;
const profileManager = new ProfileManager();



function normalizeIslandName(val) {
  return String(val || '').trim();
}

function normalizeRoomName(val) {
  let raw = String(val || '').trim();
  if (!raw) return '';
  const commaIdx = raw.indexOf(',');
  if (commaIdx >= 0) raw = raw.slice(0, commaIdx);
  const lastSlash = raw.lastIndexOf('/');
  if (lastSlash >= 0) raw = raw.slice(lastSlash + 1);
  raw = raw.replace(/\.swf$/i, '');
  raw = raw.replace(/^scene/i, '');
  return raw.trim();
}

function dispatchSceneSoundUpdate(post) {
  try {
    if (!post || typeof post !== 'object') return;
    const rawIsland = post.island || post['exit.island'] || post.desc_island || '';
    const rawRoom = post.room || post.desc || post['exit.room'] || '';
    const rawStartup = post.startup_path || post['exit.startup_path'] || 'gameplay';
    if (!rawIsland && !rawRoom) return;
    const normIsland = normalizeIslandName(rawIsland);
    const normRoom = normalizeRoomName(rawRoom);
    const script = `(function(){ try {
      var rawIsland = ${JSON.stringify('' + rawIsland)};
      var rawRoom = ${JSON.stringify('' + rawRoom)};
      var normIsland = ${JSON.stringify('' + normIsland)};
      var normRoom = ${JSON.stringify('' + normRoom)};
      var startup = ${JSON.stringify('' + rawStartup)};
      console.log('[sound] exitRoom POST', rawIsland + ':' + rawRoom, 'normalized to', normIsland + ':' + normRoom);
      if (window.__sound) {
        try { window.__sound.updateForScene(normIsland || rawIsland, rawRoom); } catch(e) { console.warn('[sound] updateForScene from POST failed', e); }
      }
      if (!window.__pendingScene) window.__pendingScene = {};
      try {
        if (normIsland) window.__pendingScene.normalizedIsland = normIsland;
        if (normRoom) window.__pendingScene.normalizedRoom = normRoom;
        if (rawIsland) window.__pendingScene.island = window.__pendingScene.island || rawIsland;
        if (rawRoom) window.__pendingScene.room = window.__pendingScene.room || rawRoom;
        if (startup) window.__pendingScene.startup_path = window.__pendingScene.startup_path || startup;
        window.__pendingScene.ts = Date.now();
      } catch(_){}
      window.__lastExitPost = { island: rawIsland, room: rawRoom, startup_path: startup, normalizedIsland: normIsland, normalizedRoom: normRoom, ts: Date.now() };
    } catch(err) { console.warn('[sound] exitRoom POST dispatch failed', err); } })();`;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win || mainWindow.isDestroyed()) continue;
      try { mainWindow.webContents.executeJavaScript(script, true).catch(() => {}); } catch (_) {}
    }
  } catch (_) {}
}


// Try to find PepperFlash plugin inside local pepper/ tree.
function resolvePepperFlashPath() {
  // In packaged apps, pepper is in extraResources (process.resourcesPath/pepper)
  // In development, it's relative to appDir
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'pepper')
    : path.join(appDir, 'pepper');

  const candidates = [];
  // macOS
  candidates.push(path.join(base, 'mac', 'PepperFlashPlayer.plugin'));
  // Windows - try both naming conventions and architecture-specific versions
  if (process.platform === 'win32') {
    const arch = process.arch; // 'x64', 'ia32', or 'arm64'
    console.log(`[pepper] Searching for Windows plugin (arch: ${arch}, packaged: ${app.isPackaged})`);
    console.log(`[pepper] Base directory: ${base}`);
    // Try architecture-specific naming (libpepflashplayer-x86_64.dll or libpepflashplayer-i386.dll)
    if (arch === 'x64') {
      candidates.push(path.join(base, 'windows', 'libpepflashplayer-x86_64.dll'));
      candidates.push(path.join(base, 'win', 'libpepflashplayer-x86_64.dll'));
    } else if (arch === 'ia32') {
      candidates.push(path.join(base, 'windows', 'libpepflashplayer-i386.dll'));
      candidates.push(path.join(base, 'win', 'libpepflashplayer-i386.dll'));
    }
    // Try standard naming
    candidates.push(path.join(base, 'windows', 'pepflashplayer.dll'));
    candidates.push(path.join(base, 'win', 'pepflashplayer.dll'));
  }
  // Linux
  candidates.push(path.join(base, 'linux', 'libpepflashplayer.so'));

  console.log(`[pepper] Checking ${candidates.length} candidate paths...`);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        console.log(`[pepper] Found plugin at: ${p}`);
        return p;
      } else {
        console.log(`[pepper] Not found: ${p}`);
      }
    } catch (e) {
      console.log(`[pepper] Error checking ${p}:`, e.message);
    }
  }
  return null;
}

function normalizePepperPath(p) {
  if (!p) return p;
  if (process.platform === 'darwin' && p.endsWith('.plugin')) {
    // Some Chromium builds expect the actual Mach-O binary path inside the bundle.
    const inner = path.join(p, 'Contents', 'MacOS', 'PepperFlashPlayer');
    try { if (fs.existsSync(inner)) return inner; } catch (_) {}
  }
  return p;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
    case '.htm': return 'text/html';
    case '.js': return 'application/javascript';
    case '.css': return 'text/css';
    case '.json': return 'application/json';
    case '.xml': return 'application/xml';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.ico': return 'image/x-icon';
    case '.ttf': return 'font/ttf';
    case '.swf': return 'application/x-shockwave-flash';
    case '.php': return 'text/plain';
    // Audio types
    case '.mp3': return 'audio/mpeg';
    case '.ogg': return 'audio/ogg';
    case '.wav': return 'audio/wav';
    case '.m4a':
    case '.mp4a': return 'audio/mp4';
    case '.aac': return 'audio/aac';
    default: return 'application/octet-stream';
  }
}

function sendBuffer(respond, mimeType, buf, statusCode = 200) {
  respond({ mimeType, data: buf, statusCode });
}

function sendText(respond, text, mimeType = 'text/plain', statusCode = 200) {
  sendBuffer(respond, mimeType, Buffer.from(text, 'utf8'), statusCode);
}

async function sendFile(respond, filePath) {
  try {
    const data = await fsp.readFile(filePath);
    const mime = getMimeType(filePath);
    sendBuffer(respond, mime, data, 200);
  } catch (err) {
    sendText(respond, 'Not Found', 'text/plain', 404);
  }
}

async function sendBaseWithInjectedInput(respond, inputObj) {
  try {
    let html = await fsp.readFile(baseHtmlPath, 'utf8');
    const injection = `\n<script id="input" type="application/json">${JSON.stringify(inputObj)}</script>\n`;
    if (html.includes('</head>')) html = html.replace('</head>', `${injection}</head>`);
    else html = injection + html;
    sendBuffer(respond, 'text/html', Buffer.from(html, 'utf8'), 200);
  } catch (err) {
    sendText(respond, 'Failed to build page', 'text/plain', 500);
  }
}

function setupHttpInterception() {
  const exportSessions = new Map();

  async function ensureDir(dir) {
    try { await fsp.mkdir(dir, { recursive: true }); } catch (_) {}
  }

  function parseURLEncoded(body) {
    const map = Object.create(null);
    const params = new URLSearchParams(body || '');
    for (const [k, v] of params.entries()) map[k] = v;
    return map;
  }

  function bmpRowSize(width, bytesPerPixel) {
    const raw = width * bytesPerPixel;
    const pad = (4 - (raw % 4)) % 4;
    return raw + pad;
  }

  function buildBMPHeader(width, height, rowSize) {
    const fileHeaderSize = 14;
    const dibHeaderSize = 40;
    const pixelDataSize = rowSize * height;
    const fileSize = fileHeaderSize + dibHeaderSize + pixelDataSize;
    const offset = fileHeaderSize + dibHeaderSize;
    const buf = Buffer.alloc(fileHeaderSize + dibHeaderSize);
    // BITMAPFILEHEADER
    buf.writeUInt16LE(0x4D42, 0);               // 'BM'
    buf.writeUInt32LE(fileSize, 2);             // file size
    buf.writeUInt16LE(0, 6);                    // reserved1
    buf.writeUInt16LE(0, 8);                    // reserved2
    buf.writeUInt32LE(offset, 10);              // pixel data offset
    // BITMAPINFOHEADER
    buf.writeUInt32LE(dibHeaderSize, 14);       // DIB header size
    buf.writeInt32LE(width, 18);                // width
    buf.writeInt32LE(height, 22);               // height (positive => bottom-up)
    buf.writeUInt16LE(1, 26);                   // planes
    buf.writeUInt16LE(24, 28);                  // bpp
    buf.writeUInt32LE(0, 30);                   // compression (BI_RGB)
    buf.writeUInt32LE(pixelDataSize, 34);       // image size
    buf.writeInt32LE(2835, 38);                 // X ppm (72 DPI)
    buf.writeInt32LE(2835, 42);                 // Y ppm
    buf.writeUInt32LE(0, 46);                   // colors used
    buf.writeUInt32LE(0, 50);                   // colors important
    return buf;
  }

  // Capture and optionally cancel POST to base.php early via webRequest.
  try {
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      try {
        const method = (details.method || '').toUpperCase();
        const urlStr = String(details.url || '');
        if (/(?:\/|^)(base\.php|index\.php)$/i.test(urlStr) && method === 'POST') {
          const post = {};
          if (details.uploadData && details.uploadData.length) {
            const chunks = [];
            for (const part of details.uploadData) {
              if (part.bytes) {
                const b = Buffer.isBuffer(part.bytes) ? part.bytes : Buffer.from(part.bytes);
                chunks.push(b);
              }
            }
            const body = Buffer.concat(chunks).toString('utf8');
            const params = new URLSearchParams(body);
            for (const [k, v] of params.entries()) post[k] = v;
            // Normalize keys
            const norm = {};
            if (post['exit.room']) norm.room = post['exit.room'];
            if (!norm.room && post['room']) norm.room = post['room'];
            if (!norm.room && post['desc']) norm.room = post['desc'];
            if (post['exit.island']) norm.island = post['exit.island'];
            if (!norm.island && post['island']) norm.island = post['island'];
            if (post['exit.startup_path']) norm.startup_path = post['exit.startup_path'];
            if (!norm.startup_path && post['startup_path']) norm.startup_path = post['startup_path'];
            if (Object.keys(norm).length) Object.assign(post, norm);
          }
          lastBasePost = Object.assign({ _ts: Date.now() }, post);
          try { console.log('[pepper webRequest] cached POST:', lastBasePost); } catch (_) {}
          dispatchSceneSoundUpdate(lastBasePost);
        }
        // Cache Avatar Studio image upload body for protocol handler fallback
        if (/\/jpg_encoder_download\.php$/i.test(urlStr)) {
          console.log('[avatar webRequest] jpg_encoder_download.php detected:', method, 'uploadData:', !!details.uploadData);
          if (method === 'POST' && details.uploadData && details.uploadData.length) {
            try {
              const chunks = [];
              for (const part of details.uploadData) {
                if (part.bytes) chunks.push(Buffer.isBuffer(part.bytes) ? part.bytes : Buffer.from(part.bytes));
                else if (part.file) { try { chunks.push(fs.readFileSync(part.file)); } catch(_){} }
              }
              const buf = Buffer.concat(chunks);
              lastAvatarUpload = { data: buf, _ts: Date.now() };
              try { console.log('[avatar] cached upload body:', buf.length, 'bytes, redirecting to __avatar_save'); } catch(_){}
              // Redirect to internal handler to guarantee save dialog path
              const dest = 'http://www.poptropica.com/__avatar_save';
              return cb({ redirectURL: dest });
            } catch (e) { try { console.warn('[avatar] cache failed', e&&e.message); } catch(_){} }
          } else {
            console.warn('[avatar webRequest] not redirecting - method:', method, 'hasUploadData:', !!(details.uploadData && details.uploadData.length));
          }
        }
      } catch (_) {}
      cb({});
    });
  } catch (_) {}

  protocol.interceptBufferProtocol('http', async (request, respond) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname.toLowerCase();

      if (host === 'www.poptropica.com' || host === 'poptropica.com' || host === 'static.poptropica.com') {
        const pathname = decodeURIComponent(url.pathname || '/');

        // Debug logging for Registred-contingent endpoints
        if (pathname.includes('island') || pathname.includes('finished')) {
          console.log('[Protocol] Request:', pathname, 'Method:', request.method);
        }
        // -------------------------------
        // Music Editor endpoints
        // -------------------------------
        if (pathname === '/__music_editor') {
          return sendFile(respond, path.join(rendererRoot, 'music-editor.html'));
        }
        // -------------------------------
        // Avatar Studio endpoint
        // -------------------------------
        if (pathname === '/__avatar_studio') {
          return sendFile(respond, path.join(contentRoot, 'avatarstudio', 'index.html'));
        }
        if (pathname === '/__avatar_save') {
          try {
            const fresh = lastAvatarUpload && (Date.now() - (lastAvatarUpload._ts || 0) < 15000);
            const buf = fresh ? lastAvatarUpload.data : null;
            if (!buf || !buf.length) return sendText(respond, '<!doctype html><meta charset="utf-8"><title>Error</title><body style="background:#139ffd;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">No image data found. <a href=\"/\" style=\"color:#fff;text-decoration:underline\">Return</a></body>', 'text/html', 200);
            // Reuse extractor
            async function extractImage(buf) {
              if (!buf || !buf.length) return null;
              if ((buf[0] === 0xFF && buf[1] === 0xD8) || (buf[0] === 0x89 && buf[1] === 0x50)) {
                const isPng = buf[0] === 0x89; return { data: buf, mime: isPng ? 'image/png' : 'image/jpeg', ext: isPng ? 'png' : 'jpg' };
              }
              const headStr = buf.toString('latin1', 0, Math.min(buf.length, 4096));
              if (headStr.startsWith('--')) {
                const sep = Buffer.from('\r\n\r\n', 'latin1'); const hdrEnd = buf.indexOf(sep);
                if (hdrEnd > 0) { const header = buf.toString('latin1', 0, hdrEnd); const m = /Content-Type:\s*([^\r\n]+)/i.exec(header); const mime = m ? m[1].trim().toLowerCase() : 'image/jpeg'; const start = hdrEnd + sep.length; let end = buf.indexOf(Buffer.from(header.split('\r\n')[0], 'latin1'), start); if (end < 0) end = buf.length; if (buf[end-2] === 13 && buf[end-1] === 10) end -= 2; const slice = buf.slice(start, end); const isPng = mime.includes('png') || (slice[0] === 0x89 && slice[1] === 0x50); return { data: slice, mime: isPng ? 'image/png' : 'image/jpeg', ext: isPng ? 'png' : 'jpg' }; }
              }
              return null;
            }
            const img = await extractImage(buf);
            if (!img || !img.data || !img.data.length) return sendText(respond, '<!doctype html><meta charset="utf-8"><title>Error</title><body style="background:#139ffd;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">Failed to decode image. <a href=\"/\" style=\"color:#fff;text-decoration:underline\">Return</a></body>', 'text/html', 200);
            const wins = BrowserWindow.getAllWindows();
            const parent = wins.length ? wins[0] : null;
            let defaultName = 'poptropica_avatar.' + img.ext; try { defaultName = `poptropica_avatar_${new Date().toISOString().replace(/[:.]/g,'-')}.${img.ext}`; } catch(_){ }
            const result = await dialog.showSaveDialog(parent, { title: 'Save Avatar Image', defaultPath: defaultName, filters: [ { name: 'Image', extensions: img.ext === 'png' ? ['png'] : ['jpg','jpeg'] } ] });
            if (result.canceled || !result.filePath) return sendText(respond, '<!doctype html><meta charset="utf-8"><title>Cancelled</title><body style="background:#139ffd;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">Save cancelled. <a href=\"/\" style=\"color:#fff;text-decoration:underline\">Return to game</a></body>', 'text/html', 200);
            try { await fsp.writeFile(result.filePath, img.data); } catch(e) { return sendText(respond, '<!doctype html><meta charset="utf-8"><title>Error</title><body style="background:#139ffd;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">Failed to save image. <a href=\"/\" style=\"color:#fff;text-decoration:underline\">Return</a></body>', 'text/html', 200); }
            const escaped = String(result.filePath).replace(/&/g,'&amp;').replace(/</g,'&lt;');
            return sendText(respond, `<!doctype html><meta charset="utf-8"><title>Saved</title><body style="background:#139ffd;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div>Saved to:<br><code>${escaped}</code><br><br><a href="/" style="color:#fff;text-decoration:underline">Return to game</a></div></body>`, 'text/html', 200);
          } catch (e) {
            return sendText(respond, '<!doctype html><meta charset="utf-8"><title>Error</title><body style="background:#139ffd;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">Unhandled error.</body>', 'text/html', 200);
          }
        }
        if (pathname === '/__list_music') {
          try {
            const urlObj = new URL(request.url);
            const islParam = (urlObj.searchParams.get('island') || '').trim();
            const musicRoot = path.join(contentRoot, 'sound', 'music');
            const files = [];
            async function walk(dir, rel){
              const entries = await fsp.readdir(dir, { withFileTypes: true });
              for (const ent of entries){
                if (ent.name.startsWith('.')) continue;
                const abs = path.join(dir, ent.name);
                const r = path.join(rel, ent.name);
                if (ent.isDirectory()) { await walk(abs, r); continue; }
                const ext = path.extname(ent.name).toLowerCase();
                if (['.mp3','.m4a','.ogg','.wav'].includes(ext)) files.push(r.replace(/\\/g,'/'));
              }
            }
            async function listDirNonRecursive(dir, rel){
              let entries = [];
              try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch(_) { return; }
              for (const ent of entries){
                if (ent.isDirectory()) continue;
                if (ent.name.startsWith('.')) continue;
                const ext = path.extname(ent.name).toLowerCase();
                if (['.mp3','.m4a','.ogg','.wav'].includes(ext)) files.push(path.join(rel, ent.name).replace(/\\/g,'/'));
              }
            }
            if (islParam) {
              // Only island subfolder + ambient + top-level files for speed
              await walk(path.join(musicRoot, islParam), islParam).catch(()=>{});
              await walk(path.join(musicRoot, 'ambient'), 'ambient').catch(()=>{});
              await listDirNonRecursive(musicRoot, '').catch(()=>{});
            } else {
              // Full index
              await walk(musicRoot, '');
            }
            files.sort((a,b)=>a.localeCompare(b));
            return sendText(respond, JSON.stringify({ files }), 'application/json', 200);
          } catch (e) {
            return sendText(respond, JSON.stringify({ files:[], error: String(e&&e.message||'error') }), 'application/json', 500);
          }
        }
        if (pathname === '/__list_islands') {
          try {
            const sceneIdx1 = path.join(repoRoot, '__scenes.json');
            let islands = [];
            try {
              const txt = await fsp.readFile(sceneIdx1, 'utf8');
              const o = JSON.parse(txt);
              if (o && Array.isArray(o.items)) {
                const set = new Set();
                for (const it of o.items) { if (it && it.island) set.add(String(it.island)); }
                islands = Array.from(set);
              }
            } catch(_) {
              const root = path.join(contentRoot, 'scenes');
              let entries = [];
              try { entries = await fsp.readdir(root, { withFileTypes:true }); } catch(_) {}
              islands = entries.filter(d=>d.isDirectory() && d.name.startsWith('island')).map(d=>d.name.replace(/^island/, ''));
            }
            islands.sort((a,b)=>String(a).localeCompare(String(b)));
            return sendText(respond, JSON.stringify({ islands }), 'application/json', 200);
          } catch (e) {
            return sendText(respond, JSON.stringify({ islands:[], error: String(e&&e.message||'error') }), 'application/json', 500);
          }
        }
        if (pathname === '/__list_scenes') {
          try {
            const urlObj = new URL(request.url);
            const islParam = (urlObj.searchParams.get('island') || '').trim();
            // Prefer __scenes.json; fallback to scan
            const sceneIdx1 = path.join(repoRoot, '__scenes.json');
            let items = [];
            try {
              const txt = await fsp.readFile(sceneIdx1, 'utf8');
              const o = JSON.parse(txt);
              if (o && Array.isArray(o.items)) {
                items = o.items.filter(it => !islParam || String(it.island) === islParam);
              }
            } catch (_) {
              // fallback: scan directories under content/scenes
              const root = path.join(contentRoot, 'scenes');
              const dirs = islParam ? [`island${islParam}`] : (await fsp.readdir(root, { withFileTypes:true })).filter(d=>d.isDirectory() && d.name.startsWith('island')).map(d=>d.name);
              for (const dName of dirs){
                const isl = dName.replace(/^island/, '');
                const dir = path.join(root, dName);
                let files = [];
                try { files = (await fsp.readdir(dir)).filter(n=>/^scene.+\.swf$/i.test(n)); } catch(_){ files = []; }
                for (const f of files){
                  const room = f.replace(/^scene/i,'').replace(/\.swf$/i,'');
                  items.push({ island: isl, room, file: f, title: isl+':'+room });
                }
              }
            }
            // Normalize sort
            items.sort((a,b)=> (String(a.island).localeCompare(String(b.island)) || String(a.room).localeCompare(String(b.room))));
            return sendText(respond, JSON.stringify({ items }), 'application/json', 200);
          } catch (e) {
            return sendText(respond, JSON.stringify({ items:[], error: String(e&&e.message||'error') }), 'application/json', 500);
          }
        }
        if (pathname === '/__save_music_map' && request.method === 'POST') {
          try {
            const chunks = [];
            if (Array.isArray(request.uploadData)) {
              for (const p of request.uploadData) if (p.bytes) chunks.push(Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
            }
            const body = Buffer.concat(chunks).toString('utf8');
            let xml = '';
            try { const o = JSON.parse(body); xml = String(o.xml||''); } catch(_){}
            if (!xml || !xml.trim().length) return sendText(respond, 'missing_xml', 'text/plain', 400);
            const dest = path.join(contentRoot, 'sound', 'music', 'music-map.xml');
            await fsp.writeFile(dest, xml, 'utf8');
            return sendText(respond, 'ok', 'text/plain', 200);
          } catch (e) {
            return sendText(respond, 'failed', 'text/plain', 500);
          }
        }
        // Scene export endpoints (tiles → BMP in /exports)
        if (pathname === '/__export_start' && request.method === 'POST') {
          try {
            const chunks = [];
            if (Array.isArray(request.uploadData)) {
              for (const p of request.uploadData) if (p.bytes) chunks.push(Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
            }
            const body = Buffer.concat(chunks).toString('utf8');
            const form = parseURLEncoded(body);
            const width = Math.max(1, parseInt(form.width || '0', 10));
            const height = Math.max(1, parseInt(form.height || '0', 10));
            const name = (form.name || 'scene').replace(/[^a-zA-Z0-9_.-]+/g, '_');
            if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
              return sendText(respond, JSON.stringify({ ok: false, error: 'bad_wh' }), 'application/json', 400);
            }
            await ensureDir(exportsRoot);
            const ts = new Date();
            const stamp = ts.toISOString().replace(/[:.]/g, '-');
            const file = path.join(exportsRoot, `${name}_${width}x${height}_${stamp}.bmp`);
            const fh = await fsp.open(file, 'w');
            const rowSize = bmpRowSize(width, 3);
            const hdr = buildBMPHeader(width, height, rowSize);
            await fh.write(hdr, 0, hdr.length, 0);
            // Pre-extend file to expected size (optional) by writing last byte
            const pixelDataEnd = hdr.length + rowSize * height;
            await fh.write(Buffer.from([0]), 0, 1, pixelDataEnd - 1);
            const id = Math.random().toString(36).slice(2);
            exportSessions.set(id, { fh, width, height, rowSize, file });
            const payload = `ok=true&id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`;
            return sendText(respond, payload, 'text/plain', 200);
          } catch (e) {
            return sendText(respond, 'ok=false&error=start_failed', 'text/plain', 500);
          }
        }
        if (pathname === '/__export_tile' && request.method === 'POST') {
          try {
            const chunks = [];
            if (Array.isArray(request.uploadData)) {
              for (const p of request.uploadData) if (p.bytes) chunks.push(Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
            }
            const body = Buffer.concat(chunks).toString('utf8');
            const form = parseURLEncoded(body);
            const id = form.id;
            const sess = exportSessions.get(id);
            if (!sess) return sendText(respond, 'ok=false&error=no_session', 'text/plain', 400);
            const x = parseInt(form.x || '0', 10) | 0;
            const y = parseInt(form.y || '0', 10) | 0;
            const w = parseInt(form.w || '0', 10) | 0;
            const h = parseInt(form.h || '0', 10) | 0;
            const data = form.data || '';
            if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > sess.width || y + h > sess.height) {
              return sendText(respond, 'ok=false&error=bad_tile_bounds', 'text/plain', 400);
            }
            // Expect data as comma-separated RRGGBB hex values, row-major top-down
            const pixels = data.split(',');
            if (pixels.length !== w * h) {
              return sendText(respond, 'ok=false&error=bad_tile_data', 'text/plain', 400);
            }
            // Write each row to BMP (bottom-up rows)
            let idx = 0;
            for (let ry = 0; ry < h; ry++) {
              const outRow = (sess.height - 1) - (y + ry);
              const rowPos = 14 + 40 + outRow * sess.rowSize + x * 3;
              const rowBuf = Buffer.alloc(w * 3);
              for (let rx = 0; rx < w; rx++, idx++) {
                const hex = pixels[idx];
                const val = parseInt(hex, 16) >>> 0;
                const r = (val >>> 16) & 255;
                const g = (val >>> 8) & 255;
                const b = val & 255;
                const off = rx * 3;
                rowBuf[off + 0] = b; // BGR
                rowBuf[off + 1] = g;
                rowBuf[off + 2] = r;
              }
              await sess.fh.write(rowBuf, 0, rowBuf.length, rowPos);
            }
            return sendText(respond, 'ok=true', 'text/plain', 200);
          } catch (e) {
            return sendText(respond, 'ok=false&error=tile_failed', 'text/plain', 500);
          }
        }
        if (pathname === '/__export_end' && request.method === 'POST') {
          try {
            const chunks = [];
            if (Array.isArray(request.uploadData)) {
              for (const p of request.uploadData) if (p.bytes) chunks.push(Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
            }
            const body = Buffer.concat(chunks).toString('utf8');
            const form = parseURLEncoded(body);
            const id = form.id;
            const sess = exportSessions.get(id);
            if (!sess) return sendText(respond, 'ok=false&error=no_session', 'text/plain', 400);
            await sess.fh.close();
            exportSessions.delete(id);
            const payload = `ok=true&file=${encodeURIComponent(sess.file)}`;
            return sendText(respond, payload, 'text/plain', 200);
          } catch (e) {
            return sendText(respond, 'ok=false&error=end_failed', 'text/plain', 500);
          }
        }
        // Capture current view (host-level screenshot of a rect)
        if (pathname === '/__capture_page' && request.method === 'GET') {
          try {
            const params = Object.fromEntries((new URLSearchParams(url.search || '')).entries());
            const x = Math.max(0, parseInt(params.x || '0', 10) | 0);
            const y = Math.max(0, parseInt(params.y || '0', 10) | 0);
            const w = Math.max(1, parseInt(params.w || '0', 10) | 0);
            const h = Math.max(1, parseInt(params.h || '0', 10) | 0);
            let name = String(params.name || 'poptropica_snapshot').replace(/[^a-zA-Z0-9_.-]+/g, '_');
            if (!name) name = 'poptropica_snapshot';
            const rect = { x, y, width: w, height: h };
            const wins = BrowserWindow.getAllWindows();
            if (!wins.length) return sendText(respond, 'No window', 'text/plain', 500);
            const win = wins[0];
            // Optional zoom factor for higher quality capture
            const zf = Math.max(0.25, Math.min(4, parseFloat(params.zf || '1') || 1));
            let prevZoom = 1;
            try { prevZoom = mainWindow.webContents.getZoomFactor(); } catch (_) {}
            if (zf !== prevZoom) {
              try { mainWindow.webContents.setZoomFactor(zf); } catch (_) {}
              // give Chromium a moment to re-rasterize at new zoom
              await new Promise(r => setTimeout(r, 120));
            }
            const img = await mainWindow.webContents.capturePage(rect);
            if (zf !== prevZoom) {
              try { mainWindow.webContents.setZoomFactor(prevZoom); } catch (_) {}
            }
            const png = img.toPNG();
            const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Export</title>
<body style="background:#139ffd;color:#fff;height:100vh;display:flex;align-items:center;justify-content:center;font-family:sans-serif;">
<div id="msg">Preparing download…</div>
<script>(function(){
  try{
    var b64='${png.toString('base64')}';
    var name='${name}.png';
    var url='data:image/png;base64,'+b64;
    var a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); setTimeout(function(){a.remove();}, 100);
    document.getElementById('msg').innerHTML='Download should start automatically. <a href="'+url+'" download="'+name+'" style="color:#fff;text-decoration:underline;">Click here if it didn\'t</a>. <br><br><a href="/" style="color:#fff;">Return to game</a>';
  }catch(e){ document.getElementById('msg').textContent='Failed to encode image.'; }
})();</script>
</body></html>`;
            return sendText(respond, html, 'text/html', 200);
          } catch (e) {
            return sendText(respond, '<!doctype html><title>Error</title>Failed to capture', 'text/html', 200);
          }
        }
        // Handle save_image.php (snapshot) by generating a client page that reconstructs the image
        if (pathname === '/save_image.php' && request.method === 'POST') {
          try {
            const chunks = [];
            if (Array.isArray(request.uploadData)) {
              for (const p of request.uploadData) if (p.bytes) chunks.push(Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
            }
            const body = Buffer.concat(chunks).toString('utf8');
            const params = new URLSearchParams(body || '');
            const payload = {};
            for (const [k, v] of params.entries()) payload[k] = v;
            const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Poptropica Snapshot</title>
    <script id="input" type="application/json">${JSON.stringify(payload).replace(/</g,'&lt;')}</script>
    <style>
      html,body{margin:0;height:100%;}
      body{display:flex;align-items:center;justify-content:center;background:#139ffd;color:#fff;font-family:sans-serif}
      #msg{max-width:600px;text-align:center}
      a{color:#fff}
    </style>
  </head>
  <body>
    <div id="msg">Preparing image…</div>
    <script>
      function getJSONData(){try{var el=document.getElementById('input');if(!el)return null;var obj=JSON.parse(el.textContent||el.innerText||'{}');if(obj&&typeof obj==='object'&&!Array.isArray(obj))return obj;}catch(e){}return null}
      function process(){
        var data=getJSONData();
        if(!data){done('Invalid data');return}
        var w=parseInt(data.width||data.w||data.imgWidth||0,10);
        var h=parseInt(data.height||data.h||data.imgHeight||0,10);
        var pixels=(data.img||data.pixels||'').split(',');
        if(!w||!h||pixels.length!==w*h){done('Bad dimensions or pixel data');return}
        var c=document.createElement('canvas');c.width=w;c.height=h;var ctx=c.getContext('2d');
        var img=ctx.createImageData(w,h);var i=0,bi=0;for(var y=0;y<h;y++){for(var x=0;x<w;x++,i++){var p=parseInt(pixels[i],16);if(isNaN(p))p=0;img.data[bi++]=(p>>>16)&255;img.data[bi++]=(p>>>8)&255;img.data[bi++]=p&255;img.data[bi++]=255}}ctx.putImageData(img,0,0);
        c.toBlob(function(blob){ if(!blob){done('Failed to encode');return} var url=URL.createObjectURL(blob); var a=document.createElement('a'); a.href=url; a.download=(data.name||'poptropica_snapshot')+'.png'; document.body.appendChild(a); a.click(); setTimeout(function(){URL.revokeObjectURL(url); a.remove();},2000); done('Image ready. If download didn\\'t start, ', url); });
      }
      function done(msg, url){ var m=document.getElementById('msg'); if(url){ m.innerHTML='Download should start automatically. <a href="'+url+'" download>Click here if it didn\'t</a>. <br><br><a href="/">Return to game</a>'; } else { m.innerHTML=String(msg)+'<br><br><a href="/">Return to game</a>'; } }
      process();
    </script>
  </body>
</html>`;
            return sendText(respond, html, 'text/html', 200);
          } catch (e) {
            return sendText(respond, '<!doctype html><title>Error</title>Failed to process image', 'text/html', 200);
          }
        }

        // Dynamic scene index for the Jump-To UI in the renderer
        if (pathname === '/__scenes.json') {
          try {
            const scenesRoot = path.join(contentRoot, 'scenes');
            const islands = await fsp.readdir(scenesRoot, { withFileTypes: true });
            const items = [];
            for (const dirent of islands) {
              if (!dirent.isDirectory()) continue;
              const dirName = dirent.name; // e.g., islandEarly
              if (dirName.startsWith('island')) {
                const islandKey = dirName.substring('island'.length); // Early
                const islandPath = path.join(scenesRoot, dirName);
                let files;
                try { files = await fsp.readdir(islandPath, { withFileTypes: true }); } catch { files = []; }
                for (const f of files) {
                  if (!f.isFile()) continue;
                  const fn = f.name; // e.g., sceneCity2.swf
                  if (!fn.startsWith('scene') || !fn.toLowerCase().endsWith('.swf')) continue;
                  const room = fn.substring('scene'.length, fn.length - 4); // City2
                  items.push({
                    island: islandKey,
                    room,
                    file: `/scenes/${dirName}/${fn}`,
                    title: `${islandKey}: ${room}`,
                  });
                }
              } else if (dirName === 'Global') {
                const globalPath = path.join(scenesRoot, dirName);
                let files;
                try { files = await fsp.readdir(globalPath, { withFileTypes: true }); } catch { files = []; }
                for (const f of files) {
                  if (!f.isFile()) continue;
                  const fn = f.name;
                  if (!fn.toLowerCase().endsWith('.swf')) continue;
                  const base = fn.substring(0, fn.length - 4);
                  const lower = base.toLowerCase();
                  let desc = null;
                  // Accept either sceneGlobalX.swf or <any>__sceneGlobalX.swf
                  const idx = lower.indexOf('sceneglobal');
                  if (idx >= 0) {
                    // Keep 'Global...' portion (remove only the 'scene' part)
                    desc = base.substring(idx + 'scene'.length);
                  }
                  if (!desc) continue;
                  items.push({
                    island: 'Global',
                    room: desc,
                    file: `/scenes/${dirName}/${fn}`,
                    title: `Global: ${desc}`,
                  });
                }
              }
            }
            const body = JSON.stringify({ items });
            return sendBuffer(respond, 'application/json', Buffer.from(body, 'utf8'), 200);
          } catch (e) {
            return sendText(respond, JSON.stringify({ items: [], error: 'scan_failed' }), 'application/json', 200);
          }
        }

        // Expose last captured scene POST for renderer polling
        if (pathname === '/__last_scene.json') {
          try {
            const payload = lastBasePost && typeof lastBasePost === 'object' ? {
              island: lastBasePost.island || null,
              room: lastBasePost.room || null,
              startup_path: lastBasePost.startup_path || null,
              _ts: lastBasePost._ts || 0,
            } : {};
            return sendBuffer(respond, 'application/json', Buffer.from(JSON.stringify(payload), 'utf8'), 200);
          } catch (e) {
            return sendBuffer(respond, 'application/json', Buffer.from(JSON.stringify({}), 'utf8'), 200);
          }
        }

        // Our static pepper base page (no Ruffle)
        if (pathname === '/' || pathname === '/index.php' || pathname === '/base.php') {
          let inject = {};
          if (request.method && request.method.toUpperCase() === 'POST') {
            try {
              if (Array.isArray(request.uploadData) && request.uploadData.length > 0) {
                const chunks = [];
                for (const p of request.uploadData) {
                  if (p.bytes) chunks.push(Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
                  else if (p.file) { try { chunks.push(await fsp.readFile(p.file)); } catch (_) {} }
                }
                const body = Buffer.concat(chunks).toString('utf8');
                const params = new URLSearchParams(body);
                for (const [k, v] of params.entries()) inject[k] = v;
              }
            } catch (_) {}

            // Normalize variants
            const norm = {};
            if (inject['room']) norm.room = inject['room'];
            if (!norm.room && inject['desc']) norm.room = inject['desc'];
            if (!norm.room && inject['exit.room']) norm.room = inject['exit.room'];
            if (inject['island']) norm.island = inject['island'];
            if (!norm.island && inject['exit.island']) norm.island = inject['exit.island'];
            if (inject['startup_path']) norm.startup_path = inject['startup_path'];
            if (!norm.startup_path && inject['exit.startup_path']) norm.startup_path = inject['exit.startup_path'];
            if (Object.keys(norm).length) inject = Object.assign({}, inject, norm);
          }

          if ((!inject || Object.keys(inject).length === 0) && lastBasePost && Object.keys(lastBasePost).length) {
            inject = Object.assign({}, lastBasePost);
          }

          if (inject && Object.keys(inject).length)
            return sendBaseWithInjectedInput(respond, inject);
          return sendFile(respond, baseHtmlPath);
        }

        // Dynamic endpoints (same as Ruffle app)
        if (pathname.endsWith('/get_inventory_menu.php')) {
          const menu = {
            Store: 'Store Items', divider: '- - - - - - - - - - - -', Early: 'Early Poptropica', Shark: 'Shark Tooth', Time: 'Time Tangled', Carrot: '24 Carrot', Super: 'Super Power', Spy: 'Spy', Nabooti: 'Nabooti', BigNate: 'Big Nate', Astro: 'Astro-Knights', Counter: 'Counterfeit', Reality: 'Reality TV', Myth: 'Mythology', Trade: 'Skullduggery', Steam: 'Steamworks', Peanuts: 'Great Pumpkin', Cryptid: 'Cryptids', West: 'Wild West', Wimpy: 'Wimpy Wonderland', Japan: 'Red Dragon', Shrink: 'Shrink Ray', Train: 'Mystery Train', GameShow: 'Game Show', Ghost: 'Ghost Story', Shipwreck: 'S.O.S.', Vampire: "Vampire's Curse", Woodland: 'Twisted Thicket', Tribal: 'Poptropolis Games', Charlie: 'Chocolate Factory', Boardwalk: 'Wimpy Boardwalk', Moon: 'Lunar Colony', Villain: 'Super Villain', Zombie: 'Zomberry', NightWatch: 'Night Watch', Backlot: 'Back Lot',
          };
          const payload = `answer=ok&json=${encodeURIComponent(JSON.stringify(menu))}`;
          return sendText(respond, payload, 'text/plain', 200);
        }
        if (pathname.endsWith('/list_redeemable_items.php')) {
          let catsParam = '';
          if (Array.isArray(request.uploadData) && request.uploadData.length > 0) {
            const bufs = request.uploadData.map((p) => Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
            const body = Buffer.concat(bufs).toString('utf8');
            const params = new URLSearchParams(body);
            catsParam = params.get('cats') || '';
          }
          const cats = (catsParam || '').split('|').filter(Boolean);
          console.log('[list_redeemable_items] Categories requested:', catsParam);
          console.log('[list_redeemable_items] Cards available:', STORE_ITEMS_DATA.cards.length);
          console.log('[list_redeemable_items] Costumes available:', STORE_ITEMS_DATA.costumes.length);

          // Use pre-loaded store items data
          const json = {};
          for (const c of cats) {
            if (c === '2001') {
              // Cards: only id and price (no name needed for cards)
              // Loading ALL 230 cards
              json[encodeURIComponent(c)] = STORE_ITEMS_DATA.cards.map(card => ({
                id: card.id,
                price: card.price
              }));
            } else if (c === '2002') {
              // Costumes: id, name, price, pri, pop (no look_raw)
              // Final limit: 250 costumes (stable, 270 causes view-switching issues)
              json[encodeURIComponent(c)] = STORE_ITEMS_DATA.costumes.slice(0, 250).map(costume => {
                // Clean name: replace Unicode characters that AS2 JSON parser can't handle
                let cleanName = (costume.name || '')
                  .replace(/\u2019/g, "'")  // Right single quotation mark -> apostrophe
                  .replace(/\u00f1/g, "n")  // ñ -> n
                  .replace(/[\u0080-\uFFFF]/g, ''); // Remove any other non-ASCII chars

                return {
                  id: costume.id,
                  name: cleanName,
                  price: costume.price,
                  pri: costume.pri || '1',
                  pop: costume.pop || '100'
                };
              });
            } else {
              json[encodeURIComponent(c)] = [];
            }
          }
          const payload = `items_info=${JSON.stringify(json)}`;
          console.log('[list_redeemable_items] Response size:', payload.length, 'bytes');
          return sendText(respond, payload, 'text/plain', 200);
        }
        if (pathname.endsWith('/get_looks.php')) {
          // Parse POST body to get requested item IDs
          let idsParam = '';
          if (Array.isArray(request.uploadData) && request.uploadData.length > 0) {
            const bufs = request.uploadData.map((p) => Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
            const body = Buffer.concat(bufs).toString('utf8');
            const params = new URLSearchParams(body);
            idsParam = params.get('ids') || '';
          }
          const ids = (idsParam || '').split('|').filter(Boolean);
          console.log('[get_looks] Requested IDs:', idsParam);

          // Generate look data for each costume ID from our store data
          // Format: "itemId:gender,skinColor,hairColor,eyesFrame,hair,marks,facial,shirt,hand,pants,pack,item,overshirt,overpants"
          const looks = ids.map(id => {
            // Find costume in our data
            const costume = STORE_ITEMS_DATA.costumes.find(c => c.id === id);
            if (costume && costume.look_raw) {
              // The look_raw contains createNPC parameters
              // Format: "0,0,0,0,\"specific\",a.gender,null,a.skinColor,a.hairColor,a.eyesFrame,hair,marks,facial,shirt,hand,pants,pack,item,overshirt,overpants"
              // We need to extract everything and replace variables with placeholder values

              let cleanLook = costume.look_raw.replace(/\\"/g, '').replace(/"/g, '');
              let parts = cleanLook.split(',');

              // The look_raw format is the full createNPC call:
              // createNPC(0,0,0,0,"specific", gender, null, skincolor, haircolor, eyestate, mouth, marks, facial, hair, shirt, pants, pack, item, overshirt, overpants)
              // PopStore.as charLook = [gender, skinColor, hairColor, lineColor, eyelidsPos, eyesFrame] (6 values)
              // char.swf setLook expects: [gender, skinColor, hairColor, lineColor, eyelidsPos, eyesFrame, marksFrame, pantsFrame, lineWidth, shirtFrame, hairFrame, mouthFrame, itemFrame, packFrame, facialFrame, overshirtFrame, overpantsFrame]
              // So costume.look (after PopStore slice from 6) should be: [marksFrame, pantsFrame, lineWidth, shirtFrame, hairFrame, mouthFrame, itemFrame, packFrame, facialFrame, overshirtFrame, overpantsFrame]
              //
              // createNPC order: mouth(10), marks(11), facial(12), hair(13), shirt(14), pants(15), pack(16), item(17), overshirt(18), overpants(19)
              // setLook order:   marks(6),  pants(7),  lineWidth(8), shirt(9), hair(10), mouth(11), item(12), pack(13), facial(14), overshirt(15), overpants(16)
              // Mapping: marks=11, pants=15, lineWidth=1, shirt=14, hair=13, mouth=10, item=17, pack=16, facial=12, overshirt=18, overpants=19

              if (parts.length >= 20) {
                // First, replace ALL variable placeholders in the parts array
                parts = parts.map(p => {
                  p = p.trim();
                  // Replace AS2 and AS3 variable placeholders with default values
                  if (p === 'a.gender' || p === '_loc2_.gender') return '0';
                  if (p === 'a.skinColor' || p === '_loc2_.skinColor') return '16777215';
                  if (p === 'a.hairColor' || p === '_loc2_.hairColor') return '0';
                  if (p === 'a.eyesFrame' || p === '_loc2_.eyesFrame') return '3';
                  if (p === 'a.mouthFrame' || p === '_loc2_.mouthFrame') return '1';
                  if (p === 'a.markFrame' || p === '_loc2_.markFrame') return '1';
                  if (p === 'a.marksFrame' || p === '_loc2_.marksFrame') return '1';
                  if (p === 'a.facialFrame' || p === '_loc2_.facialFrame') return '1';
                  if (p === 'a.hairFrame' || p === '_loc2_.hairFrame') return '1';
                  if (p === 'a.pantsFrame' || p === '_loc2_.pantsFrame') return '1';
                  if (p === 'a.packFrame' || p === '_loc2_.packFrame') return '1';
                  if (p === 'a.itemFrame' || p === '_loc2_.itemFrame') return '1';
                  if (p === 'a.shirtFrame' || p === '_loc2_.shirtFrame') return '1';
                  if (p === 'a.overshirtFrame' || p === '_loc2_.overshirtFrame') return '1';
                  if (p === 'a.overshirt' || p === '_loc2_.overshirt') return '1';
                  if (p === 'a.overpantsFrame' || p === '_loc2_.overpantsFrame') return '1';
                  if (p === 'a.overpants' || p === '_loc2_.overpants') return '1';
                  if (p === 'null' || p === 'undefined') return '1';
                  if (p === 'open') return '3';
                  return p;
                });

                // Now extract parts in setLook order
                let headerParts = parts.slice(0, 6); // 0,0,0,0,specific,gender
                let clothingParts = [
                  parts[11], // marksFrame
                  parts[15], // pantsFrame
                  '1',       // lineWidth (not in createNPC, default to 1)
                  parts[14], // shirtFrame
                  parts[13], // hairFrame
                  parts[10], // mouthFrame
                  parts[17], // itemFrame
                  parts[16], // packFrame
                  parts[12], // facialFrame
                  parts[18], // overshirtFrame
                  parts[19]  // overpantsFrame
                ];
                let lookParts = headerParts.concat(clothingParts);

                const lookStr = `${id}:${lookParts.join(',')}`;
                // Debug log for Geisha costume
                if (id === '3000') {
                  console.log('[get_looks] Geisha (3000) look string:', lookStr);
                }
                return lookStr;
              }
            }
            // Fallback for unknown costumes
            return `${id}:0,16777215,0,3,1,1,1,1,1,1,1,1,1,1`;
          });

          const payload = `answer=${looks.join('|')}`;
          console.log('[get_looks] Response length:', payload.length);
          console.log('[get_looks] IDs processed:', ids.join(','));
          return sendText(respond, payload, 'text/plain', 200);
        }
        if (pathname.endsWith('/list_items.php')) {
          // This endpoint returns metadata for store items
          // Parse POST body to get requested item IDs
          let itemsParam = '';
          if (Array.isArray(request.uploadData) && request.uploadData.length > 0) {
            const bufs = request.uploadData.map((p) => Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
            const body = Buffer.concat(bufs).toString('utf8');
            const params = new URLSearchParams(body);
            itemsParam = params.get('items') || '';
            console.log('[list_items] Request for items:', itemsParam);
          }

          // Parse item IDs
          const itemIds = itemsParam.split('|').filter(Boolean).map(id => parseInt(id));

          // Create item details array
          // Each item needs: item_id, item_name, item_description, price, etc.
          const itemDetails = itemIds.map(itemId => ({
            item_id: itemId,
            item_name: `Item ${itemId}`,
            item_description: `Store item #${itemId}`,
            price: 0,
            type: itemId >= 6000 ? 'power' : 'costume',
            rental: false,
            purchased_date: Math.floor(Date.now() / 1000)
          }));

          const payload = `items_info=${JSON.stringify(itemDetails)}`;
          console.log(`[list_items] Returning ${itemDetails.length} item details`);
          return sendText(respond, payload, 'text/plain', 200);
        }
        if (pathname.endsWith('/time.php')) return sendText(respond, String(Math.floor(Date.now() / 1000)), 'text/plain', 200);
        if (pathname.endsWith('/redeem_credits.php')) return sendText(respond, 'status=true&credits=0', 'text/plain', 200);
        if (pathname.endsWith('/error_message.php')) return sendText(respond, 'errorMessage=Sorry, that room is not\\navailable right now&messageTime=7000', 'text/plain', 200);

        // -------------------------------
        // Registred-contingent PHP endpoints
        // -------------------------------
        if (pathname.endsWith('/get_mem_status.php')) {
          console.log('[get_mem_status] Request received');
          // Always return active membership status for desktop version
          const payload = 'answer=ok&mem_status=active-renew&mem_date=' + new Date().toISOString().split('T')[0] + ' 00:00:00';
          return sendText(respond, payload, 'text/plain', 200);
        }

        if (pathname.endsWith('/get_skullduggery.php')) {
          console.log('[get_skullduggery] Request received');
          const currentProfileData = profileManager.currentProfile;

          if (!currentProfileData) {
            console.log('[get_skullduggery] No profile loaded');
            return sendText(respond, 'answer=nologin', 'text/plain', 200);
          }

          // Get Skullduggery data from profile's skullData or use initial defaults
          const skullData = currentProfileData.rawSO?.skullData || null;

          // Default initial data for first visit
          const defaultData = {
            voyage_days: 1,
            gold: 0,
            port_prices: [[25,25,38,25],[13,28,28,28],[25,25,15,35],[25,35,25,15],[38,15,25,25],[-1,-1,-1,-1],[-1,-1,-1,-1]],
            ship_id: 0,
            cargo: [4,2,1,0],
            crew_roster: [],
            last_port: 5,
            current_port: 5,
            loan: '',
            insurance: 0,
            level: 0,
            loc: []
          };

          // Use saved data if exists, otherwise use defaults
          const data = skullData || defaultData;

          // Build response with all required fields
          const responseFields = {
            answer: 'ok',
            gold: data.gold ?? 0,
            ship_id: data.ship_id ?? 0,
            current_port: data.current_port ?? 5,
            last_port: data.last_port ?? 5,
            voyage_days: data.voyage_days ?? 1,
            insurance: data.insurance ?? 0,
            level: data.level ?? 0,
            port_prices: JSON.stringify(data.port_prices || defaultData.port_prices),
            cargo: JSON.stringify(data.cargo || defaultData.cargo),
            crew_roster: JSON.stringify(data.crew_roster || []),
            loc: JSON.stringify(data.loc || []),
            loan: data.loan || ''
          };

          const payload = Object.entries(responseFields)
            .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
            .join('&');

          console.log('[get_skullduggery] Returning data - gold:', responseFields.gold, 'ship:', responseFields.ship_id);
          return sendText(respond, payload, 'text/plain', 200);
        }

        if (pathname.endsWith('/get_island_info.php')) {
          try {
            console.log('[get_island_info] Request received');

            const currentProfileData = profileManager.currentProfile;
            if (!currentProfileData) {
              console.log('[get_island_info] No profile loaded, returning noIslandInfo');
              return sendText(respond, 'answer=noIslandInfo', 'text/plain', 200);
            }

            // Parse POST body to get requested island names
            let islandNames = [];
            if (Array.isArray(request.uploadData) && request.uploadData.length > 0) {
              const bufs = request.uploadData.map((p) => Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
              const body = Buffer.concat(bufs).toString('utf8');
              const params = new URLSearchParams(body);

              // island_names are passed as island_names[0]=Early&island_names[1]=Shark etc.
              for (const [key, value] of params.entries()) {
                if (key.startsWith('island_names[')) {
                  islandNames.push(value);
                }
              }
            }

            console.log('[get_island_info] Requested islands:', islandNames);

          // Build response from current profile data
          const responseData = {
            items: {},
            event: {},
            photos: {},
            fields: {}
          };

          // Get data from profile
          const progress = currentProfileData.progress || {};
          const inventory = progress.inventory || {};
          const removedItems = progress.removedItems || {};
          const completedEvents = progress.completedEvents || {};

          // For each requested island, build item list and events
          for (const island of islandNames) {
            // Items: combine inventory and removedItems
            // Format: {itemId: 1} for owned, {itemId: 0} for removed
            const islandItems = {};

            if (inventory[island]) {
              for (const itemId of inventory[island]) {
                islandItems[itemId] = 1;
              }
            }

            if (removedItems[island]) {
              for (const itemId of removedItems[island]) {
                islandItems[itemId] = 0;
              }
            }

            responseData.items[island] = islandItems;

            // Events: array of completed event names
            responseData.event[island] = completedEvents[island] || [];

            // Photos: empty for now (would need photo data)
            responseData.photos[island] = [];
          }

          // Global photos (empty for now)
          responseData.photos.Global = [];

          // Fields: userData from profile
          const userData = currentProfileData.rawSO?.userData || {};
          for (const field in userData) {
            responseData.fields[field] = JSON.stringify(userData[field]);
          }

            const jsonResponse = JSON.stringify(responseData);
            const payload = `answer=ok&json=${encodeURIComponent(jsonResponse)}`;
            console.log('[get_island_info] Returning data for islands:', islandNames.join(', '));
            console.log('[get_island_info] Payload length:', payload.length);
            sendText(respond, payload, 'text/plain', 200);
            console.log('[get_island_info] Response sent, returning');
            return;
          } catch (err) {
            console.error('[get_island_info] ERROR:', err);
            return sendText(respond, 'answer=error&error=' + err.message, 'text/plain', 500);
          }
        }

        if (pathname.endsWith('/list_finished_islands.php')) {
          try {
            console.log('[list_finished_islands] Request received');

            const currentProfileData = profileManager.currentProfile;
            if (!currentProfileData) {
              console.log('[list_finished_islands] No profile loaded, returning empty');
              return sendText(respond, 'answer=ok&islands_json={}', 'text/plain', 200);
            }

            // Get island completions from profile
            const progress = currentProfileData.progress || {};
            const islandCompletions = progress.islandCompletions || {};

            const jsonResponse = JSON.stringify(islandCompletions);
            const payload = `answer=ok&islands_json=${encodeURIComponent(jsonResponse)}`;
            console.log('[list_finished_islands] Returning completions:', jsonResponse);
            console.log('[list_finished_islands] Payload length:', payload.length);
            sendText(respond, payload, 'text/plain', 200);
            console.log('[list_finished_islands] Response sent, returning');
            return;
          } catch (err) {
            console.error('[list_finished_islands] ERROR:', err);
            return sendText(respond, 'answer=error&error=' + err.message, 'text/plain', 500);
          }
        }

        if (pathname.endsWith('/finished_islands.php') || pathname.endsWith('/started_islands.php')) {
          const endpoint = pathname.endsWith('/finished_islands.php') ? 'finished_islands' : 'started_islands';
          console.log(`[${endpoint}] Request received`);

          const currentProfileData = profileManager.currentProfile;
          if (!currentProfileData) {
            console.log(`[${endpoint}] No profile loaded, returning ok`);
            return sendText(respond, 'answer=ok', 'text/plain', 200);
          }

          // Parse POST body to get island times being sent
          let islandTimes = {};
          if (Array.isArray(request.uploadData) && request.uploadData.length > 0) {
            const bufs = request.uploadData.map((p) => Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
            const body = Buffer.concat(bufs).toString('utf8');
            const params = new URLSearchParams(body);

            // islands are passed as islands[IslandName]=timestamp
            for (const [key, value] of params.entries()) {
              if (key.startsWith('islands[') && key.endsWith(']')) {
                const islandName = key.substring(8, key.length - 1);
                islandTimes[islandName] = value;
              }
            }
          }

          console.log(`[${endpoint}] Island times:`, islandTimes);

          // Store times in profile if needed
          if (Object.keys(islandTimes).length > 0 && currentProfileData.progress) {
            if (!currentProfileData.progress.islandTimes) {
              currentProfileData.progress.islandTimes = {};
            }

            for (const island in islandTimes) {
              if (!currentProfileData.progress.islandTimes[island]) {
                currentProfileData.progress.islandTimes[island] = {};
              }

              if (endpoint === 'started_islands') {
                currentProfileData.progress.islandTimes[island].start = islandTimes[island];
              } else {
                currentProfileData.progress.islandTimes[island].end = islandTimes[island];
              }
            }
          }

          return sendText(respond, 'answer=ok', 'text/plain', 200);
        }

        // -------------------------------
        // Avatar Studio endpoint - proxy to live server
        // -------------------------------
        if (pathname.endsWith('/get_embedInfo.php') && request.method === 'POST') {
          // Check if we have local profile preview data first
          let profileId = embedInfoQueue.length > 0 ? embedInfoQueue.shift() : null;

          if (profileId !== null && profilePreviewData.has(profileId)) {
            const profile = profilePreviewData.get(profileId);
            const lookParts = [
              profile.gender,
              profile.skinColor,
              profile.hairColor,
              profile.lineColor,
              profile.eyelidPos,
              profile.eyesFrame,
              profile.marksFrame,
              profile.pantsFrame,
              profile.lineWidth,
              profile.shirtFrame,
              profile.hairFrame,
              profile.mouthFrame,
              profile.itemFrame,
              profile.packFrame,
              profile.facialFrame,
              profile.overshirtFrame,
              profile.overpantsFrame,
              profile.specialAbility
            ];
            const lookString = lookParts.join(','); // NOT URL-encoded for POST response
            const response = `error=&look=${lookString}&fname=${profile.firstName}&lname=${profile.lastName}`;
            console.log(`[embedInfo POST] Serving profile ${profileId}: ${profile.firstName} ${profile.lastName}`);
            return sendText(respond, response, 'text/plain', 200);
          }

          // Forward the request to the live Poptropica server
          return new Promise((resolve) => {
            let postData = '';
            if (request.uploadData && request.uploadData.length > 0) {
              const chunks = [];
              for (const part of request.uploadData) {
                if (part.bytes) {
                  chunks.push(Buffer.isBuffer(part.bytes) ? part.bytes : Buffer.from(part.bytes));
                }
              }
              postData = Buffer.concat(chunks).toString('utf8');
            }

            console.log('[get_embedInfo] Proxying request to live server, data:', postData.substring(0, 100));

            const https = require('https');
            const options = {
              hostname: 'www.poptropica.com',
              path: '/get_embedInfo.php',
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
              }
            };

            const proxyReq = https.request(options, (proxyRes) => {
              let data = '';
              proxyRes.on('data', (chunk) => { data += chunk; });
              proxyRes.on('end', () => {
                console.log('[get_embedInfo] Received from live server (raw):', data.substring(0, 200));

                // The server returns URL-encoded data, but the Flash SWF expects it decoded
                // Parse the response and decode the look string
                const params = new URLSearchParams(data);
                const error = params.get('error') || '';
                const look = decodeURIComponent(params.get('look') || '');
                const fname = decodeURIComponent(params.get('fname') || '');
                const lname = decodeURIComponent(params.get('lname') || '');

                // Reconstruct the response with decoded values
                const decodedResponse = `error=${error}&look=${look}&fname=${fname}&lname=${lname}`;
                console.log('[get_embedInfo] Sending decoded response:', decodedResponse.substring(0, 200));

                resolve(sendText(respond, decodedResponse, 'text/plain', 200));
              });
            });

            proxyReq.on('error', (err) => {
              console.error('[get_embedInfo] Proxy request failed:', err);
              resolve(sendText(respond, 'error=proxy_failed&look=&fname=&lname=', 'text/plain', 200));
            });

            proxyReq.write(postData);
            proxyReq.end();
          });
        }

        // -------------------------------
        // Daily Pop endpoints
        // -------------------------------
        if (pathname.endsWith('/comics/get_comic_streams.php')) {
          const filePath = path.join(contentRoot, 'comics', 'get_comic_streams.php');
          return sendFile(respond, filePath);
        }
        if (pathname.endsWith('/comics/get_comic_strips.php')) {
          // Parse POST data to get comic_stream_id
          let comicStreamId = null;
          if (request.uploadData && request.uploadData.length > 0) {
            try {
              const chunks = [];
              for (const part of request.uploadData) {
                if (part.bytes) {
                  chunks.push(Buffer.isBuffer(part.bytes) ? part.bytes : Buffer.from(part.bytes));
                }
              }
              const body = Buffer.concat(chunks).toString('utf8');
              const params = new URLSearchParams(body);
              comicStreamId = params.get('comic_stream_id');
              console.log('[comic_strips] comic_stream_id:', comicStreamId);
            } catch (e) {
              console.error('[comic_strips] Failed to parse POST data:', e);
            }
          }

          // Generate comic strips based on comic_stream_id
          const comicStrips = {};
          if (comicStreamId === '12897') {
            // Poptropica comics - scan directory for all strips
            try {
              const comicsDir = path.join(contentRoot, 'images', 'comics', 'Poptropica');
              const files = fs.readdirSync(comicsDir)
                .filter(f => f.startsWith('Poptropica-') && f.endsWith('.png'))
                .sort((a, b) => {
                  const numA = parseInt(a.match(/Poptropica-(\d+)/)[1]);
                  const numB = parseInt(b.match(/Poptropica-(\d+)/)[1]);
                  return numA - numB;
                });

              files.forEach((file, i) => {
                const id = `poptropica_${i + 1}`;
                comicStrips[id] = `images/comics/Poptropica/${file}`;
              });
              console.log('[comic_strips] Loaded', files.length, 'Poptropica strips');
            } catch (e) {
              console.error('[comic_strips] Failed to load Poptropica strips:', e);
            }
          } else if (comicStreamId === '12908') {
            // Zomberry comics - scan directory for all strips
            try {
              const comicsDir = path.join(contentRoot, 'images', 'comics', 'Zomberry');
              const files = fs.readdirSync(comicsDir)
                .filter(f => f.startsWith('Zomberry-') && f.endsWith('.gif'))
                .sort((a, b) => {
                  const numA = parseInt(a.match(/Zomberry-(\d+)/)[1]);
                  const numB = parseInt(b.match(/Zomberry-(\d+)/)[1]);
                  return numA - numB;
                });

              files.forEach((file, i) => {
                const id = `zomberry_${i + 1}`;
                comicStrips[id] = `images/comics/Zomberry/${file}`;
              });
              console.log('[comic_strips] Loaded', files.length, 'Zomberry strips');
            } catch (e) {
              console.error('[comic_strips] Failed to load Zomberry strips:', e);
            }
          } else if (comicStreamId === '12927') {
            // VirusHunter comics - scan directory for all strips
            try {
              const comicsDir = path.join(contentRoot, 'images', 'comics', 'VirusHunter');
              const files = fs.readdirSync(comicsDir)
                .filter(f => f.startsWith('VirusHunter-') && f.endsWith('.jpg'))
                .sort((a, b) => {
                  const numA = parseInt(a.match(/VirusHunter-(\d+)/)[1]);
                  const numB = parseInt(b.match(/VirusHunter-(\d+)/)[1]);
                  return numA - numB;
                });

              files.forEach((file, i) => {
                const id = `virushunter_${i + 1}`;
                comicStrips[id] = `images/comics/VirusHunter/${file}`;
              });
              console.log('[comic_strips] Loaded', files.length, 'VirusHunter strips');
            } catch (e) {
              console.error('[comic_strips] Failed to load VirusHunter strips:', e);
            }
          } else {
            // For other comics (syndicated from GoComics), load from cached folders
            // Each comic has its first 50 strips cached in images/comics/{endpoint}/
            console.log('[comic_strips] Loading cached GoComics strips for stream:', comicStreamId);

            // Map comic stream ID to endpoint name
            const comicEndpoints = {
              '11020': 'peanuts',
              '11008': 'bignate',
              '11012': 'grandavenue',
              '11016': 'nancy',
              '11018': 'overthehedge',
              '11022': 'roseisrose',
              '11024': 'soup-to-nutz',
              '11010': 'frazz',
              '11014': 'meg-classics'
            };

            const endpoint = comicEndpoints[comicStreamId];
            if (endpoint) {
              const comicDir = path.join(contentRoot, 'images', 'comics', endpoint);

              // Check if cache exists, if not fetch it
              if (!fs.existsSync(comicDir)) {
                console.log('[comic_strips] Cache not found, fetching first 50 strips for', endpoint);
                try {
                  const { execSync } = require('child_process');
                  const projectRoot = path.join(__dirname, '..', '..');
                  const scriptPath = path.join(projectRoot, 'fetch_gocomics.py');

                  // Fetch first 50 strips from origin
                  const result = execSync(`python3 "${scriptPath}" ${comicStreamId} 50`, {
                    cwd: projectRoot,
                    timeout: 600000, // 10 minute timeout for 50 strips
                    encoding: 'utf8'
                  });

                  // Filter out Playwright warnings and get JSON
                  const lines = result.split('\n');
                  const jsonLine = lines.find(line => line.trim().startsWith('{'));

                  if (jsonLine) {
                    const fetchedStrips = JSON.parse(jsonLine);
                    Object.assign(comicStrips, fetchedStrips);
                    console.log('[comic_strips] Successfully cached', Object.keys(fetchedStrips).length, 'strips');
                  }
                } catch (e) {
                  console.error('[comic_strips] Failed to fetch GoComics strips:', e.message);
                }
              } else {
                // Load from cache
                try {
                  const files = fs.readdirSync(comicDir).filter(f => f.endsWith('.png')).sort();
                  files.forEach((file, index) => {
                    const stripNum = index + 1;
                    const id = `${endpoint}_${stripNum}`;
                    comicStrips[id] = `images/comics/${endpoint}/${file}`;
                  });
                  console.log('[comic_strips] Loaded', files.length, 'cached strips for', endpoint);
                } catch (e) {
                  console.error('[comic_strips] Failed to load cached strips:', e);
                }
              }
            }
          }

          const payload = `answer=ok&comic_strips_json=${encodeURIComponent(JSON.stringify(comicStrips))}`;
          return sendText(respond, payload, 'text/plain', 200);
        }
        if (pathname.endsWith('/games/interface/get_games.php')) {
          const filePath = path.join(contentRoot, 'games', 'interface', 'get_games.php');
          return sendFile(respond, filePath);
        }
        if (pathname.endsWith('/creatorClips/get_creator_clips.php')) {
          // Check if this is a Creator Clips request (mode=Sprint 2) or Sneak Peeks request
          // Parse POST data to check for mode parameter
          let mode = null;
          if (request.uploadData && request.uploadData.length > 0) {
            try {
              const chunks = [];
              for (const part of request.uploadData) {
                if (part.bytes) {
                  chunks.push(Buffer.isBuffer(part.bytes) ? part.bytes : Buffer.from(part.bytes));
                }
              }
              const body = Buffer.concat(chunks).toString('utf8');
              const params = new URLSearchParams(body);
              mode = params.get('mode');
              console.log('[creatorClips] POST data - mode:', mode);
            } catch (e) {
              console.error('[creatorClips] Failed to parse POST data:', e);
            }
          }

          if (mode === 'Sprint 2') {
            // Creator Clips - return all celebrity clips (Jeff Kinney, Mary Pope Osborne, Lincoln Peirce)
            console.log('[creatorClips] Returning Creator Clips (celebrities) - loading all clips');
            const creatorClipsJsonPath = path.join(contentRoot, 'creatorClips', 'creator_clips_all.json');
            try {
              const creatorClipsJson = JSON.parse(fs.readFileSync(creatorClipsJsonPath, 'utf8'));
              console.log('[creatorClips] Loaded', Object.keys(creatorClipsJson).length, 'creator clips');
              const payload = `answer=ok&creator_clips_json=${encodeURIComponent(JSON.stringify(creatorClipsJson))}`;
              return sendText(respond, payload, 'text/plain', 200);
            } catch (e) {
              console.error('[creatorClips] Failed to load creator_clips_all.json:', e);
              // Fallback to empty
              return sendText(respond, 'answer=ok&creator_clips_json=%7B%7D', 'text/plain', 200);
            }
          } else {
            // Sneak Peeks - return from the static file (contains all 1300 sneak peeks)
            console.log('[creatorClips] Returning Sneak Peeks - loading all sneak peeks');
            const filePath = path.join(contentRoot, 'creatorClips', 'get_creator_clips.php');
            return sendFile(respond, filePath);
          }
        }
        // Stub endpoints for missing daily pop features
        if (pathname.endsWith('/games/interface/get_highscores.php')) {
          return sendText(respond, 'answer=ok&highscores_json=%5B%5D', 'text/plain', 200);
        }
        if (pathname.endsWith('/games/interface/submit_game.php')) {
          return sendText(respond, 'answer=ok', 'text/plain', 200);
        }
        if (pathname.endsWith('/creatorClips/mark_clips_viewed.php')) {
          return sendText(respond, 'answer=ok', 'text/plain', 200);
        }
        if (pathname.endsWith('/challenges/get_challenge.php')) {
          return sendText(respond, 'answer=ok&challenge_json=%7B%7D', 'text/plain', 200);
        }
        if (pathname.endsWith('/challenges/get_user_challenge_result.php')) {
          return sendText(respond, 'answer=ok&user_challenge_result_json=%7B%7D', 'text/plain', 200);
        }
        if (pathname.endsWith('/challenges/set_user_challenge_result.php')) {
          return sendText(respond, 'answer=ok', 'text/plain', 200);
        }
        if (pathname.endsWith('/quizzes/get_quiz_types.php')) {
          return sendText(respond, 'answer=ok&quiz_types_json=%5B%5D', 'text/plain', 200);
        }
        if (pathname.endsWith('/quizzes/get_quizzes.php')) {
          return sendText(respond, 'answer=ok&quizzes_json=%5B%5D', 'text/plain', 200);
        }
        if (pathname.endsWith('/quizzes/get_user_quiz_results.php')) {
          return sendText(respond, 'answer=ok&user_quiz_results_json=%5B%5D', 'text/plain', 200);
        }
        if (pathname.endsWith('/quizzes/submit_quiz.php')) {
          return sendText(respond, 'answer=ok', 'text/plain', 200);
        }

        // Avatar character embed info endpoint
        if (pathname.endsWith('/get_embedInfo.php')) {
          try {
            // Pop the next profileId from the queue
            let profileId = embedInfoQueue.length > 0 ? embedInfoQueue.shift() : null;

            console.log('[embedInfo] Request received');
            console.log('[embedInfo] Queue before pop:', embedInfoQueue.length + 1);
            console.log('[embedInfo] Popped profileId:', profileId);
            console.log('[embedInfo] profilePreviewData size:', profilePreviewData.size);
            console.log('[embedInfo] Has data for profileId:', profileId !== null && profilePreviewData.has(profileId));

            // If we have profile data for this ID, generate dynamic response
            if (profileId !== null && profilePreviewData.has(profileId)) {
              const profile = profilePreviewData.get(profileId);

              // Generate look string from profile data
              const lookParts = [
                profile.gender,
                profile.skinColor,
                profile.hairColor,
                profile.lineColor,
                profile.eyelidPos,
                profile.eyesFrame,
                profile.marksFrame,
                profile.pantsFrame,
                profile.lineWidth,
                profile.shirtFrame,
                profile.hairFrame,
                profile.mouthFrame,
                profile.itemFrame,
                profile.packFrame,
                profile.facialFrame,
                profile.overshirtFrame,
                profile.overpantsFrame,
                profile.specialAbility
              ];

              const lookString = lookParts.join('%2C'); // URL-encoded comma
              const response = `error=&look=${lookString}&fname=${encodeURIComponent(profile.firstName)}&lname=${encodeURIComponent(profile.lastName)}`;

              console.log(`[embedInfo] Serving profile ${profileId}: ${profile.firstName} ${profile.lastName}`);
              return sendText(respond, response, 'text/plain', 200);
            }

            // Fallback: Try to read static file
            const phpPath = path.join(contentRoot, 'get_embedInfo.php');
            try {
              const content = await fsp.readFile(phpPath, 'utf8');
              return sendText(respond, content, 'text/plain', 200);
            } catch (e) {
              // Fallback with default data if file doesn't exist
              return sendText(respond, 'error=&look=1%2C16777215%2C16763955%2C13421772%2C60%2C1%2C1%2C7%2C4%2C9%2C10%2C11%2C1%2C1%2C1%2C1%2C1%2Cnone&fname=Unknown&lname=Poptropican', 'text/plain', 200);
            }
          } catch (e) {
            console.error('[embedInfo] Error:', e);
            return sendText(respond, 'error=failed', 'text/plain', 500);
          }
        }
        // Avatar Studio: intercept JPEG download and save to disk via Save dialog
        if (/jpg_encoder_download\.php$/i.test(pathname)) {
          try {
            console.log('[avatar] jpg_encoder_download.php request received:', request.method || 'UNKNOWN', request.url);
            // Prefer ProtocolRequest.uploadData, otherwise use cached data from webRequest
            let bodyBuf = null;
            if (Array.isArray(request.uploadData) && request.uploadData.length) {
              const chunks = [];
              for (const p of request.uploadData) {
                if (p.bytes) chunks.push(Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
                else if (p.file) { try { chunks.push(await fsp.readFile(p.file)); } catch(_){} }
              }
              bodyBuf = Buffer.concat(chunks);
              console.log('[avatar] extracted uploadData:', bodyBuf.length, 'bytes');
            }
            if ((!bodyBuf || !bodyBuf.length) && lastAvatarUpload && (Date.now() - (lastAvatarUpload._ts || 0) < 10000)) {
              bodyBuf = lastAvatarUpload.data;
              console.log('[avatar] using cached lastAvatarUpload:', bodyBuf?.length || 0, 'bytes');
            }
            // If we still have no body, try parsing base64 in query string
            let queryB64 = '';
            try {
              const q = new URL(request.url).searchParams;
              queryB64 = q.get('img') || q.get('jpg') || q.get('image') || '';
            } catch(_){}
            if (!bodyBuf || !bodyBuf.length) {
              if (!queryB64) {
                console.warn('[avatar] no upload data found - request.uploadData:', !!request.uploadData, 'lastAvatarUpload:', !!lastAvatarUpload, 'query:', !!queryB64);
                throw new Error('no_upload_data');
              }
              bodyBuf = Buffer.from('img=' + encodeURIComponent(queryB64));
            }

            async function extractImage(buf) {
              if (!buf || !buf.length) return null;
              // Raw JPEG/PNG body
              if ((buf[0] === 0xFF && buf[1] === 0xD8) || (buf[0] === 0x89 && buf[1] === 0x50)) {
                const isPng = buf[0] === 0x89;
                return { data: buf, mime: isPng ? 'image/png' : 'image/jpeg', ext: isPng ? 'png' : 'jpg' };
              }
              const headStr = buf.toString('latin1', 0, Math.min(buf.length, 4096));
              // Multipart form-data
              if (headStr.startsWith('--')) {
                const eol = headStr.indexOf('\r\n');
                const boundary = headStr.slice(0, eol);
                const boundaryBuf = Buffer.from('\r\n' + boundary, 'latin1');
                const sep = Buffer.from('\r\n\r\n', 'latin1');
                const hdrEnd = buf.indexOf(sep);
                if (hdrEnd > 0) {
                  const header = buf.toString('latin1', 0, hdrEnd);
                  const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(header);
                  const mime = ctMatch ? ctMatch[1].trim().toLowerCase() : 'image/jpeg';
                  const start = hdrEnd + sep.length;
                  let end = buf.indexOf(boundaryBuf, start);
                  if (end < 0) end = buf.length;
                  // Drop trailing CRLF
                  if (buf[end-2] === 13 && buf[end-1] === 10) end -= 2;
                  const slice = buf.slice(start, end);
                  const isPng = mime.includes('png') || (slice[0] === 0x89 && slice[1] === 0x50);
                  return { data: slice, mime: isPng ? 'image/png' : 'image/jpeg', ext: isPng ? 'png' : 'jpg' };
                }
              }
              // URL-encoded base64 field
              try {
                const asText = buf.toString('utf8');
                const params = new URLSearchParams(asText);
                let b64 = params.get('img') || params.get('jpg') || params.get('image') || '';
                if (/^data:/i.test(b64)) {
                  const m = /^data:([^;,]+);base64,(.*)$/i.exec(b64);
                  const mime = (m && m[1]) || 'image/jpeg';
                  const data = Buffer.from((m && m[2]) || '', 'base64');
                  const isPng = mime.toLowerCase().includes('png');
                  return { data, mime, ext: isPng ? 'png' : 'jpg' };
                }
                if (b64) {
                  const data = Buffer.from(b64, 'base64');
                  const isPng = (data[0] === 0x89 && data[1] === 0x50);
                  return { data, mime: isPng ? 'image/png' : 'image/jpeg', ext: isPng ? 'png' : 'jpg' };
                }
              } catch (_) {}
              return null;
            }

            const img = await extractImage(bodyBuf);
            if (!img || !img.data || !img.data.length) {
              return sendText(respond, '<!doctype html><meta charset="utf-8"><title>Error</title><body style="background:#139ffd;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">Failed to decode image. <a href=\"/\" style=\"color:#fff;text-decoration:underline\">Return</a></body>', 'text/html', 200);
            }

            const wins = BrowserWindow.getAllWindows();
            const parent = wins.length ? wins[0] : null;
            let defaultName = 'poptropica_avatar.' + img.ext;
            try {
              const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              defaultName = `poptropica_avatar_${stamp}.${img.ext}`;
            } catch(_){}
            console.log('[avatar] Showing save dialog for', img.ext, 'image, size:', img.data.length, 'bytes');
            const result = await dialog.showSaveDialog(parent, {
              title: 'Save Avatar Image',
              defaultPath: defaultName,
              filters: [ { name: 'Image', extensions: img.ext === 'png' ? ['png'] : ['jpg','jpeg'] } ]
            });
            if (result.canceled || !result.filePath) {
              return sendText(respond, '<!doctype html><meta charset="utf-8"><title>Cancelled</title><body style="background:#139ffd;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">Save cancelled. <a href=\"/\" style=\"color:#fff;text-decoration:underline\">Return to game</a></body>', 'text/html', 200);
            }
            try {
              await fsp.writeFile(result.filePath, img.data);
              const escaped = String(result.filePath).replace(/&/g,'&amp;').replace(/</g,'&lt;');
              const html = `<!doctype html><meta charset="utf-8"><title>Saved</title><body style="background:#139ffd;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div>Saved to:<br><code>${escaped}</code><br><br><a href="/" style="color:#fff;text-decoration:underline">Return to game</a></div></body>`;
              return sendText(respond, html, 'text/html', 200);
            } catch (e) {
              console.error('[avatar] Failed to save image:', e);
              return sendText(respond, '<!doctype html><meta charset="utf-8"><title>Error</title><body style="background:#139ffd;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">Failed to save image. <a href=\"/\" style=\"color:#fff;text-decoration:underline\">Return</a></body>', 'text/html', 200);
            }
          } catch (e) {
            console.error('[avatar] jpg_encoder_download.php handler error:', e && e.message);
            // Return error instead of falling through
            const errorMsg = e && e.message === 'no_upload_data'
              ? 'No image data received. The avatar image may not have been properly encoded.'
              : 'An error occurred while processing the image save request.';
            return sendText(respond, `<!doctype html><meta charset="utf-8"><title>Error</title><body style="background:#139ffd;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div><h2>Error</h2><p>${errorMsg}</p><p>Check the console for details.</p><a href="/__avatar_studio" style="color:#fff;text-decoration:underline;display:block;margin-top:20px;">Return to Avatar Studio</a></div></body>`, 'text/html', 200);
          }
        }
        if (pathname.endsWith('/save_image.php') || pathname.endsWith('/avatarstudio/jpg_encoder_download.php')) {
          const html = `<!doctype html><meta charset="utf-8"><title>Save Image</title><body style="font-family: sans-serif; background: #139ffd; color: #fff; display:flex;align-items:center;justify-content:center;height:100vh;"><div><h1>Saving images is not supported</h1><p>This desktop build does not process save_image.php requests.</p><p><a href=\"/\" style=\"color:#fff;text-decoration:underline\">Return to game</a></p></div></body>`;
          return sendText(respond, html, 'text/html', 200);
        }

        // Track char_loader.swf loads and queue them for get_embedInfo.php
        if (pathname.includes('/char_loader.swf')) {
          const profileId = url.searchParams.get('profileId');
          if (profileId !== null) {
            embedInfoQueue.push(parseInt(profileId, 10));
            console.log(`[embedInfo] Queued profile ${profileId} for char_loader.swf load. Queue:`, embedInfoQueue);
          }
        }

        // Serve from local mirror with Global-scene fallback mapping
        const relPathRaw = pathname.replace(/^\/+/, '');
        // Rewrite gameplay.patched.swf -> gameplay.swf to ensure canonical loading
        let relPath = (relPathRaw.toLowerCase() === 'gameplay.patched.swf') ? 'gameplay.swf' : relPathRaw;

        // Debug: Log all SWF requests
        if (relPath.endsWith('.swf')) {
          console.log('[Protocol] SWF request:', relPath);
        }

        // Intercept travelmap.swf requests and serve based on user preference
        if (relPath === 'popups/travelmap.swf') {
          console.log('[TravelMap] Detected travelmap.swf request!');
          try {
            const prefs = getUserPrefsSync();
            console.log('[TravelMap] Read prefs:', prefs);
            const version = prefs.travelMapVersion || 'travelmap.swf';
            console.log('[TravelMap] Request for travelmap.swf, serving:', version);
            relPath = `popups/${version}`;
          } catch (e) {
            console.warn('[TravelMap] Failed to read preference, using default:', e);
          }
        }

        let localPath = path.normalize(path.join(contentRoot, relPath));
        if (!localPath.startsWith(contentRoot)) return sendText(respond, 'Forbidden', 'text/plain', 403);
        // If a Global scene uses a vendor prefix (e.g., vendor__sceneGlobalX.swf), map sceneGlobalX.swf to the prefixed file
        if (/^scenes\/Global\/sceneGlobal[^/]+\.swf$/i.test(relPath)) {
          try {
            await fsp.access(localPath, fs.constants.R_OK);
          } catch {
            try {
              const dir = path.dirname(localPath);
              const base = path.basename(localPath);
              const want = `__${base}`.toLowerCase();
              const entries = await fsp.readdir(dir);
              let found = null;
              for (const name of entries) {
                if (name.toLowerCase().endsWith(want)) { found = path.join(dir, name); break; }
              }
              if (found) return sendFile(respond, found);
            } catch (_) {}
          }
        }
        // Support extensionless SWF URLs (e.g., /avatarstudio/charImageEmbed)
        try {
          await fsp.access(localPath, fs.constants.R_OK);
          return sendFile(respond, localPath);
        } catch (_) {
          try {
            if (!path.extname(localPath)) {
              const swfPath = localPath + '.swf';
              await fsp.access(swfPath, fs.constants.R_OK);
              return sendFile(respond, swfPath);
            }
          } catch (_) {}
        }
        return sendFile(respond, localPath);
      }

      // Ignore external domains
    } catch (err) {}
    return sendText(respond, 'Blocked', 'text/plain', 404);
  });
}

function createWindow() {
  // Set app/dock icon on macOS from SwingingVine.png
  if (process.platform === 'darwin') {
    try {
      const img = nativeImage.createFromPath(iconPngPath);
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch (_) {}
  }
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#139ffd',
    icon: (process.platform === 'win32' ? iconPngPath : undefined),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      plugins: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Poptropica (AS2) – PepperFlash',
    autoHideMenuBar: true,
  });
  mainWindow.loadURL('http://www.poptropica.com/base.php');

  // Intercept in-page navigation to base.php and keep a single page instance.
  // When PepperFlash posts to base.php to change scenes, we cancel the load and
  // call flashpointLoad(island, room, path) in the existing renderer.
  mainWindow.webContents.on('will-navigate', async (event, url) => {
    try {
      const u = new URL(url);
      const host = (u.hostname || '').toLowerCase();
      const p = u.pathname || '';
      const isBase = (p === '/' || p === '/index.php' || p === '/base.php');
      if ((host === 'www.poptropica.com' || host === 'poptropica.com') && isBase) {
        // Allow force reload from Avatar Studio
        if (u.searchParams.has('force_reload')) {
          console.log('[nav] Force reload requested, allowing navigation');
          return; // allow the reload
        }

        // Only intercept if we're already in the game page (avoid first boot)
        let hasGame = false;
        try { hasGame = !!(await mainWindow.webContents.executeJavaScript("!!document.getElementById('game')", true)); } catch (_) {}
        if (!hasGame) return; // allow initial load to renderer base page
        event.preventDefault();

        // Determine target scene from multiple sources
        let post = lastBasePost || {};
        let fresh = post && typeof post === 'object' && (Date.now() - (post._ts || 0) < 3000);

        // Prefer renderer-staged pending scene data (StageSceneExit) regardless of cached POST freshness.
        try {
          const probePending = `(() => { try { var o = (typeof getPendingScene==='function') ? getPendingScene() : (window.__pendingScene||null); if (o && o.island && o.room) return JSON.stringify(o); } catch(e) {} return ''; })()`;
          const jsonP = await mainWindow.webContents.executeJavaScript(probePending, true);
          if (jsonP && typeof jsonP === 'string' && jsonP.length) {
            try {
              const pending = JSON.parse(jsonP);
              const ts = Number(pending && pending.ts);
              const freshPending = Number.isFinite(ts) ? (Date.now() - ts < 5000) : true;
              if (pending && pending.island && pending.room && freshPending) {
                const merged = Object.assign({}, post);
                merged.island = pending.island;
                merged.room = pending.room;
                if (pending.startup_path) merged.startup_path = pending.startup_path;
                merged._ts = Date.now();
                post = merged;
                fresh = true;
              }
            } catch (_) {}
          }
        } catch (_) {}

        if (!fresh) {
          // Ask SWF directly (ExternalInterface callback)
          try {
            const probe = `(() => { try { var g=document.getElementById('game'); if (g && typeof g.GetExitData==='function') { var o=g.GetExitData()||{}; return JSON.stringify(o); } } catch(e) {} return ''; })()`;
            const json = await mainWindow.webContents.executeJavaScript(probe, true);
            if (json && typeof json === 'string' && json.length) {
              try { post = Object.assign({_ts: Date.now()}, JSON.parse(json)); fresh = true; } catch (_) {}
            }
          } catch (_) {}
        }
        // Fallback to last stored scene if necessary
        if (!fresh) {
          try {
            const ls = await mainWindow.webContents.executeJavaScript("localStorage.getItem('lastScene')||''", true);
            if (ls) { try { const o = JSON.parse(ls); if (o && o.island && o.scene) { post = { island:o.island, room:o.scene, startup_path:'gameplay', _ts:Date.now() }; fresh = true; } } catch(_){} }
          } catch(_){}
        }
        // Compute JSON-based ad override in main process to avoid race conditions
        let island = (post && (post.island || post['exit.island'])) || null;
        let room = (post && (post.room || post.desc || post['exit.room'])) || null;
        let sp = (post && (post.startup_path || post['exit.startup_path'])) || 'gameplay';

        const js = `(() => { try {
          var island = ${JSON.stringify(island || 'Home')};
          var room = ${JSON.stringify(room || 'Home')};
          var sp = ${JSON.stringify(sp || 'gameplay')};
          if (typeof window.smoothSceneSwitch === 'function') { window.smoothSceneSwitch(island, room, sp); return 'js:smooth'; }
          var game = document.getElementById('game');
          if (game) {
            if (typeof game.NavigateScene === 'function') { try { game.NavigateScene(island, room, sp); return 'ei:method'; } catch(e) {} }
            if (typeof game.navigateScene === 'function') { try { game.navigateScene(island, room, sp); return 'ei:method-lower'; } catch(e) {} }
            if (typeof game.CallFunction === 'function') {
              var xml = '<invoke name=\"NavigateScene\" returntype=\"xml\"><arguments><string>' + island + '</string><string>' + room + '</string><string>' + sp + '</string></arguments></invoke>';
              try { game.CallFunction(xml); return 'npapi:callfunction'; } catch(e) {}
              var xml2 = '<invoke name=\"navigateScene\" returntype=\"xml\"><arguments><string>' + island + '</string><string>' + room + '</string><string>' + sp + '</string></arguments></invoke>';
              try { game.CallFunction(xml2); return 'npapi:callfunction-lower'; } catch(e) {}
            }
          }
          if (typeof window.NavigateScene === 'function') { try { window.NavigateScene(island, room, sp); return 'js:navigate'; } catch(e) {} }
          if (typeof window.navigateScene === 'function') { try { window.navigateScene(island, room, sp); return 'js:navigate-lower'; } catch(e) {} }
          if (typeof window.flashpointLoad === 'function') { try { window.flashpointLoad(island, room, sp); return 'js:flashpoint'; } catch(e) {} }
          return '';
        } catch(e) { return ''; } })()`;
        try { await mainWindow.webContents.executeJavaScript(js, true); } catch (_) {}
        // Clear cached POST
        lastBasePost = null;
      }
    } catch (_) { /* ignore */ }
  });

  // Auto-zoom when maximized or fullscreen; revert on restore.
  function setZoomFactorSafe(factor) {
    try {
      if (typeof mainWindow.webContents.setZoomFactor === 'function') {
        mainWindow.webContents.setZoomFactor(factor);
      }
      const level = Math.log(factor) / Math.log(1.2); // Chromium zoom scale used by View menu
      if (typeof mainWindow.webContents.setZoomLevel === 'function') {
        mainWindow.webContents.setZoomLevel(level);
      }
    } catch (_) {}
  }

  function applyZoomForState() {
    if (mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const fullscreen = mainWindow.isFullScreen();
    setZoomFactorSafe((maximized || fullscreen) ? 1.5 : 1.0);
  }

  // macOS often uses full-screen rather than maximize
  mainWindow.on('maximize', () => setZoomFactorSafe(1.5));
  mainWindow.on('unmaximize', () => setZoomFactorSafe(1.0));
  mainWindow.on('enter-full-screen', () => setZoomFactorSafe(1.5));
  mainWindow.on('leave-full-screen', () => setZoomFactorSafe(1.0));
  mainWindow.on('resize', () => applyZoomForState());
  mainWindow.on('ready-to-show', () => applyZoomForState());
  mainWindow.webContents.on('did-finish-load', applyZoomForState);

  // Prompt user to save on window close
  let savePromptPending = false;
  mainWindow.on('close', async (event) => {
    const currentProfileName = profileManager.getCurrentProfileName();

    if (!currentProfileName) {
      console.log('[AutoSave] No profile loaded, skipping save prompt');
      return; // Allow close to proceed
    }

    // Prevent default close behavior
    event.preventDefault();

    // Prevent multiple simultaneous prompts
    if (savePromptPending) {
      console.log('[AutoSave] Save prompt already showing, ignoring duplicate close event');
      return;
    }
    savePromptPending = true;

    try {
      // Export profile data BEFORE showing dialog (while renderer is still active)
      console.log('[AutoSave] Pre-fetching profile data before showing dialog...');

      const exportScript = `
        (function(){
          try {
            var game = document.getElementById('game');
            if (!game) {
              console.log('[AutoSave] No game element found');
              return null;
            }

            // Try CallFunction method first (more robust for large data)
            if (typeof game.CallFunction === 'function') {
              console.log('[AutoSave] Using CallFunction method...');
              try {
                var xml = '<invoke name="ExportCurrentProfile" returntype="xml"></invoke>';
                var xmlResult = game.CallFunction(xml);
                console.log('[AutoSave] CallFunction returned:', typeof xmlResult);

                // Extract string from XML wrapper
                if (xmlResult && typeof xmlResult === 'string') {
                  // Check if it's XML-wrapped
                  if (xmlResult.indexOf('<string>') > -1) {
                    var match = xmlResult.match(/<string[^>]*>([\\s\\S]*?)<\\/string>/i);
                    if (match && match[1]) {
                      var result = match[1];
                      console.log('[AutoSave] Extracted from XML, length:', result.length);
                      if (!result || result === '{}' || result === 'null') {
                        console.warn('[AutoSave] Export returned empty/null data');
                        return null;
                      }
                      return result;
                    }
                  } else {
                    // Direct string return
                    console.log('[AutoSave] Direct string, length:', xmlResult.length);
                    if (!xmlResult || xmlResult === '{}' || xmlResult === 'null') {
                      console.warn('[AutoSave] Export returned empty/null data');
                      return null;
                    }
                    return xmlResult;
                  }
                }
              } catch (callFuncError) {
                console.warn('[AutoSave] CallFunction failed:', callFuncError.message);
              }
            }

            // Fallback to direct call
            if (typeof game.ExportCurrentProfile === 'function') {
              console.log('[AutoSave] Trying direct function call...');
              try {
                var res = game.ExportCurrentProfile();
                console.log('[AutoSave] Direct call returned:', typeof res, 'length:', res ? res.length : 0);
                if (!res || res === '{}' || res === 'null') {
                  console.warn('[AutoSave] Export returned empty/null data');
                  return null;
                }
                return (typeof res === 'string') ? res : null;
              } catch (directError) {
                console.error('[AutoSave] Direct call error:', directError);
                return null;
              }
            }

            console.warn('[AutoSave] No export method available');
            return null;
          } catch (e) {
            console.error('[AutoSave] Export error:', e);
            return null;
          }
        })()
      `;

      let exportedData = null;
      try {
        exportedData = await mainWindow.webContents.executeJavaScript(exportScript, true);
        if (exportedData) {
          console.log('[AutoSave] Successfully pre-fetched profile data, length:', exportedData.length);
          console.log('[AutoSave] First 100 chars:', exportedData.substring(0, 100));
        } else {
          console.warn('[AutoSave] Pre-fetch returned null, will use fallback if needed');
          console.warn('[AutoSave] Check the renderer console (F12) for detailed export logs');
        }
      } catch (err) {
        console.warn('[AutoSave] Pre-fetch failed:', err.message);
      }

      // Now show save dialog
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Save and Quit', 'Quit Without Saving', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Save Game',
        message: 'Before you quit, do you want to save your game?',
        detail: `Profile: ${currentProfileName}`
      });

      if (choice.response === 2) {
        // Cancel - don't close
        console.log('[AutoSave] User cancelled quit');
        savePromptPending = false;
        return;
      }

      if (choice.response === 1) {
        // Quit without saving
        console.log('[AutoSave] User chose to quit without saving');
        mainWindow.destroy();
        return;
      }

      // Save and quit (response === 0)
      console.log('[AutoSave] User chose to save and quit');

      try {
        if (exportedData) {
          // Use the pre-fetched data
          try {
            // Decode HTML entities that may be present in XML-wrapped data
            const decodedData = exportedData
              .replace(/&quot;/g, '"')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&apos;/g, "'");

            const profileData = JSON.parse(decodedData);
            profileData.Registred = true;
            const success = await profileManager.saveProfile(currentProfileName, profileData);
            if (success) {
              console.log(`[AutoSave] Successfully saved profile from pre-fetched data: ${currentProfileName}`);
            } else {
              console.error('[AutoSave] Failed to save profile');
            }
          } catch (e) {
            console.error('[AutoSave] Failed to parse pre-fetched data:', e.message);
            // Fall through to fallback
            exportedData = null;
          }
        }

        if (!exportedData) {
          // Fallback: Use last known profile state
          console.warn('[AutoSave] Using fallback (last known profile state)');
          const last = profileManager.currentProfile;
          if (last) {
            last.Registred = true;
            const ok = await profileManager.saveProfile(currentProfileName, last);
            if (ok) console.log('[AutoSave] Fallback saved last known profile state');
          }
        }
      } catch (err) {
        console.error('[AutoSave] Error during save:', err.message);
      } finally {
        // Always proceed with close after save attempt
        mainWindow.destroy();
      }
    } catch (err) {
      console.error('[AutoSave] Error in close handler:', err.message);
      mainWindow.destroy();
    }
  });

  // =============================================================================
  // Profile System
  // =============================================================================

  // IPC: Close profile selector
  // NOTE: Disabled - profile selector is now an in-page overlay, no longer a separate window
  // ipcMain.on('close-profile-selector', () => {
  //   if (profileWindow && !profileWindow.isDestroyed()) {
  //     profileWindow.close();
  //   }
  // });

  // IPC: Load user preferences
  ipcMain.handle('userprefs-load', async () => {
    try {
      const data = await fsp.readFile(userPrefsPath, 'utf8');
      const prefs = JSON.parse(data);
      console.log('[UserPrefs] Loaded preferences:', prefs);
      return { success: true, prefs };
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File doesn't exist, return defaults and create file
        console.log('[UserPrefs] No preferences file found, using defaults');
        try {
          await fsp.writeFile(userPrefsPath, JSON.stringify(defaultUserPrefs, null, 2), 'utf8');
          console.log('[UserPrefs] Created default preferences file');
        } catch (writeErr) {
          console.error('[UserPrefs] Failed to create default preferences file:', writeErr);
        }
        return { success: true, prefs: defaultUserPrefs };
      }
      console.error('[UserPrefs] Failed to load preferences:', err);
      return { success: false, error: err.message, prefs: defaultUserPrefs };
    }
  });

  // IPC: Save user preferences
  ipcMain.handle('userprefs-save', async (event, prefs) => {
    try {
      await fsp.writeFile(userPrefsPath, JSON.stringify(prefs, null, 2), 'utf8');
      console.log('[UserPrefs] Saved preferences:', prefs);
      return { success: true };
    } catch (err) {
      console.error('[UserPrefs] Failed to save preferences:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: Set fullscreen
  ipcMain.handle('set-fullscreen', async (event, isFullscreen) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFullScreen(isFullscreen);
        console.log('[Fullscreen] Set to:', isFullscreen);
        return { success: true };
      }
      return { success: false, error: 'Window not available' };
    } catch (err) {
      console.error('[Fullscreen] Failed to set fullscreen:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: Get fullscreen state
  ipcMain.handle('get-fullscreen', async () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const isFullscreen = mainWindow.isFullScreen();
        console.log('[Fullscreen] Current state:', isFullscreen);
        return { success: true, isFullscreen };
      }
      return { success: false, error: 'Window not available' };
    } catch (err) {
      console.error('[Fullscreen] Failed to get fullscreen state:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: List all profiles
  ipcMain.handle('profile-list', async () => {
    try {
      const profiles = await profileManager.listProfiles();
      return profiles;
    } catch (err) {
      console.error('[ProfileIPC] profile-list error:', err);
      return [];
    }
  });

  // IPC: Load profile
  ipcMain.handle('profile-load', async (event, filename) => {
    try {
      console.log(`[ProfileIPC] Loading profile: ${filename}`);

      // Auto-save current profile before switching
      const currentProfileName = profileManager.getCurrentProfileName();
      if (currentProfileName && currentProfileName !== filename) {
        console.log(`[ProfileIPC] Auto-saving current profile (${currentProfileName}) before switching to ${filename}`);

        try {
          const exportResult = await mainWindow.webContents.executeJavaScript(
            `
            (function() {
              try {
                var game = document.getElementById('game');
                if (!game) return null;

                if (typeof game.ExportCurrentProfile === 'function') {
                  return game.ExportCurrentProfile();
                }

                if (typeof game.CallFunction === 'function') {
                  var xml = '<invoke name="ExportCurrentProfile" returntype="xml"></invoke>';
                  return game.CallFunction(xml);
                }

                return null;
              } catch (e) {
                console.error('[ProfileSwitch] Export failed:', e);
                return null;
              }
            })()
            `,
            true
          );

          if (exportResult) {
            const profileData = JSON.parse(exportResult);
            profileData.Registred = true;
            await profileManager.saveProfile(currentProfileName, profileData);
            console.log(`[ProfileIPC] Auto-saved ${currentProfileName} before switching`);
          }
        } catch (err) {
          console.warn('[ProfileIPC] Auto-save before switch failed:', err.message);
          // Don't block the profile switch if auto-save fails
        }
      }

      const profileData = await profileManager.loadProfile(filename);

      // Force membership status to active (desktop version always has membership)
      if (profileData.rawSO) {
        profileData.rawSO.mem_status = 'active-renew';
        profileData.rawSO.mem_date = new Date().toISOString().split('T')[0] + ' 00:00:00';
        profileData.rawSO.mem_timestamp = new Date().getTime();
      }

      // Convert profile data to JSON string
      const profileJSON = JSON.stringify(profileData);

      // Call Flash to load profile data
      const gameElement = await mainWindow.webContents.executeJavaScript(
        `document.getElementById('game')`,
        true
      );

      if (!gameElement) {
        throw new Error('Game element not found');
      }

      // Try different methods to call Flash function
      const callResult = await mainWindow.webContents.executeJavaScript(
        `
        (function() {
          try {
            var game = document.getElementById('game');
            if (!game) return { success: false, error: 'no_game_element' };

            var profileData = ${JSON.stringify(profileJSON)};

            // Method 1: Direct function call (PepperFlash)
            if (typeof game.LoadProfileData === 'function') {
              try {
                var result = game.LoadProfileData(profileData);
                return { success: result === 'ok', error: result, method: 'direct' };
              } catch (e) {
                console.error('[Profile] Direct call failed:', e);
              }
            }

            // Method 2: CallFunction (NPAPI-style)
            if (typeof game.CallFunction === 'function') {
              try {
                var xml = '<invoke name="LoadProfileData" returntype="xml"><arguments><string>' +
                          profileData.replace(/</g, '&lt;').replace(/>/g, '&gt;') +
                          '</string></arguments></invoke>';
                var result = game.CallFunction(xml);
                return { success: true, result: result, method: 'callfunction' };
              } catch (e) {
                console.error('[Profile] CallFunction failed:', e);
              }
            }

            return { success: false, error: 'no_method_available' };
          } catch (e) {
            return { success: false, error: e.toString() };
          }
        })()
        `,
        true
      );

      console.log('[ProfileIPC] Flash call result:', callResult);

      if (callResult && callResult.success) {
        // Navigate to the profile's last scene
        const island = profileData.lastIsland || profileData.island || 'Early';
        const room = profileData.lastScene || profileData.lastRoom || profileData.room || 'City2';
        const startup_path = 'gameplay';

        console.log(`[ProfileIPC] Navigating to ${island}:${room}`);

        // Navigate to the scene using the same logic as the base.php interception
        await mainWindow.webContents.executeJavaScript(
          `
          (function() {
            try {
              var island = ${JSON.stringify(island)};
              var room = ${JSON.stringify(room)};
              var sp = ${JSON.stringify(startup_path)};

              var game = document.getElementById('game');
              if (game) {
                if (typeof game.NavigateScene === 'function') {
                  game.NavigateScene(island, room, sp);
                  return 'navigated';
                }
                if (typeof game.CallFunction === 'function') {
                  var xml = '<invoke name="NavigateScene" returntype="xml"><arguments><string>' + island + '</string><string>' + room + '</string><string>' + sp + '</string></arguments></invoke>';
                  game.CallFunction(xml);
                  return 'navigated_cf';
                }
              }
              return 'no_method';
            } catch (e) {
              return 'error: ' + e.toString();
            }
          })()
          `,
          true
        );

        // Notify renderer that profile is loaded
        mainWindow.webContents.executeJavaScript(`
          if (typeof window.onProfileLoaded === 'function') {
            window.onProfileLoaded();
          }
        `);

        return { success: true };
      } else {
        return { success: false, error: callResult.error || 'Unknown error' };
      }
    } catch (err) {
      console.error('[ProfileIPC] profile-load error:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: Create new profile
  ipcMain.handle('profile-create', async (event, name) => {
    try {
      console.log(`[ProfileIPC] Creating profile: ${name}`);
      const result = await profileManager.createProfile(name);
      return { success: true, filename: result.filename };
    } catch (err) {
      console.error('[ProfileIPC] profile-create error:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: Create new profile with data from current game state
  ipcMain.handle('profile-create-with-data', async (event, name) => {
    try {
      console.log(`[ProfileIPC] Creating profile with current data: ${name}`);

      // First, export current profile data from Flash
      const exportResult = await mainWindow.webContents.executeJavaScript(
        `
        (function() {
          try {
            var game = document.getElementById('game');
            if (!game) return null;

            // Method 1: Direct function call
            if (typeof game.ExportCurrentProfile === 'function') {
              return game.ExportCurrentProfile();
            }

            // Method 2: CallFunction
            if (typeof game.CallFunction === 'function') {
              var xml = '<invoke name="ExportCurrentProfile" returntype="xml"></invoke>';
              return game.CallFunction(xml);
            }

            return null;
          } catch (e) {
            console.error('[Profile] Export failed:', e);
            return null;
          }
        })()
        `,
        true
      );

      if (!exportResult) {
        throw new Error('Failed to export profile from Flash');
      }

      const profileData = JSON.parse(exportResult);

      // Add profile metadata
      profileData.profileName = name;
      profileData.created = new Date().toISOString();
      profileData.lastSaved = new Date().toISOString();

      // Mark profile as registered
      profileData.Registred = true;

      // Create filename
      const filename = `${profileManager.sanitizeFilename(name)}.json`;

      // Save directly using saveProfile
      const success = await profileManager.saveProfile(filename, profileData);

      if (success) {
        console.log(`[ProfileIPC] Created profile with data: ${filename}`);
        return { success: true, filename };
      } else {
        throw new Error('Failed to save profile');
      }
    } catch (err) {
      console.error('[ProfileIPC] profile-create-with-data error:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: Delete profile
  ipcMain.handle('profile-delete', async (event, filename) => {
    try {
      console.log(`[ProfileIPC] Deleting profile: ${filename}`);
      const success = await profileManager.deleteProfile(filename);
      return { success };
    } catch (err) {
      console.error('[ProfileIPC] profile-delete error:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: Import profile with dialog
  ipcMain.handle('profile-import-dialog', async () => {
    try {
      const result = await dialog.showOpenDialog(profileWindow || mainWindow, {
        title: 'Import Profile',
        filters: [{ name: 'JSON Profile', extensions: ['json'] }],
        properties: ['openFile']
      });

      if (result.canceled || !result.filePaths.length) {
        return { success: false, canceled: true };
      }

      const imported = await profileManager.importProfile(result.filePaths[0]);
      console.log(`[ProfileIPC] Imported profile: ${imported.filename}`);
      return { success: true, filename: imported.filename };
    } catch (err) {
      console.error('[ProfileIPC] profile-import error:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: Export profile with dialog
  ipcMain.handle('profile-export-dialog', async (event, filename) => {
    try {
      const profileData = await profileManager.loadProfile(filename);
      const defaultName = (profileData.profileName || 'profile') + '.json';

      const result = await dialog.showSaveDialog(profileWindow || mainWindow, {
        title: 'Export Profile',
        defaultPath: defaultName,
        filters: [{ name: 'JSON Profile', extensions: ['json'] }]
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      const success = await profileManager.exportProfile(filename, result.filePath);
      console.log(`[ProfileIPC] Exported profile to: ${result.filePath}`);
      return { success };
    } catch (err) {
      console.error('[ProfileIPC] profile-export error:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: Save current game state to profile
  ipcMain.handle('profile-save-current', async (event, filename) => {
    try {
      // IMPORTANT: Save to the currently LOADED profile, not the selected one
      // This prevents overwriting the wrong profile if user selects a different profile without loading it
      const currentProfileName = profileManager.getCurrentProfileName();

      if (!currentProfileName) {
        throw new Error('No profile is currently loaded. Please load a profile before saving.');
      }

      console.log(`[ProfileIPC] Saving current state (loaded profile: ${currentProfileName}, UI selection: ${filename})`);

      // Call Flash to export current state
      const exportResult = await mainWindow.webContents.executeJavaScript(
        `
        (function() {
          try {
            var game = document.getElementById('game');
            if (!game) return null;

            // Method 1: Direct function call
            if (typeof game.ExportCurrentProfile === 'function') {
              return game.ExportCurrentProfile();
            }

            // Method 2: CallFunction
            if (typeof game.CallFunction === 'function') {
              var xml = '<invoke name="ExportCurrentProfile" returntype="xml"></invoke>';
              return game.CallFunction(xml);
            }

            return null;
          } catch (e) {
            console.error('[Profile] Export failed:', e);
            return null;
          }
        })()
        `,
        true
      );

      if (!exportResult) {
        throw new Error('Failed to export profile from Flash');
      }

      const profileData = JSON.parse(exportResult);

      // Mark profile as registered when saving
      profileData.Registred = true;

      // Save to the currently loaded profile, not the UI-selected profile
      const success = await profileManager.saveProfile(currentProfileName, profileData);

      console.log(`[ProfileIPC] Saved current state to: ${currentProfileName}`);
      return { success, savedTo: currentProfileName };
    } catch (err) {
      console.error('[ProfileIPC] profile-save-current error:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: Register profile preview data for get_embedInfo.php
  ipcMain.handle('profile-register-previews', async (event, profiles) => {
    try {
      profilePreviewData.clear();
      embedInfoQueue.length = 0; // Clear the queue
      profiles.forEach(p => {
        profilePreviewData.set(p.profileId, p);
      });
      console.log(`[ProfileIPC] Registered ${profiles.length} profile previews`);
      return { success: true };
    } catch (err) {
      console.error('[ProfileIPC] profile-register-previews error:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: Fetch profile from live Poptropica API
  ipcMain.handle('profile-fetch-from-api', async (event, { username, password }) => {
    try {
      console.log(`[ProfileIPC] Fetching profile from live server using /login.php for user: ${username}`);

      // Hash password with MD5 (matching original game behavior)
      const passwordHash = crypto.createHash('md5').update(password).digest('hex');

      // Make POST request to /login.php (exactly how the original game does it)
      const postData = querystring.stringify({
        login: username,
        pass_hash: passwordHash
      });

      console.log('[ProfileIPC] Sending POST request to https://www.poptropica.com/login.php');

      const loginData = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'www.poptropica.com',
          port: 443,
          path: '/login.php',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
          }
        };

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              // Response format: answer=ok&json={...}
              const parsed = querystring.parse(data);

              if (parsed.answer === 'ok' && parsed.json) {
                const jsonData = JSON.parse(parsed.json);
                console.log('[ProfileIPC] Login successful, received profile data');
                console.log('[ProfileIPC] Profile keys:', Object.keys(jsonData));
                console.log('[ProfileIPC] credits:', jsonData.credits);
                console.log('[ProfileIPC] games:', jsonData.games);
                console.log('[ProfileIPC] pickedItems:', jsonData.pickedItems);
                resolve(jsonData);
              } else {
                reject(new Error(parsed.answer || 'Invalid login credentials'));
              }
            } catch (e) {
              reject(new Error(`Failed to parse login response: ${e.message}`));
            }
          });
        });

        req.on('error', (e) => {
          reject(new Error(`Login request failed: ${e.message}`));
        });

        req.write(postData);
        req.end();
      });

      // Parse look string from login response
      const lookParts = (loginData.look || '').replace(/:$/, '').split(',');

      // Parse userData (it's an escaped JSON string)
      let userData = {};
      if (loginData.userData) {
        try {
          userData = JSON.parse(unescape(loginData.userData));
          console.log('[ProfileIPC] Parsed userData:', Object.keys(userData));
        } catch (e) {
          console.warn('[ProfileIPC] Failed to parse userData:', e.message);
        }
      }

      // Parse scores string (format: "game;score;wins;losses*...")
      const scoresData = {};
      if (loginData.scores) {
        const scoresList = loginData.scores.split('*');
        for (const scoreEntry of scoresList) {
          const parts = scoreEntry.split(';');
          if (parts.length >= 4) {
            const gameName = parts[0];
            scoresData[`${gameName}Score`] = parts[1];
            scoresData[`${gameName}Wins`] = parts[2];
            scoresData[`${gameName}Losses`] = parts[3];
          }
        }
      }

      // Check if we need to redirect from AS3 Embassy to AS2 Early Island
      // (matching original game behavior from doLogin function)
      let lastIsland = loginData.island || 'Early';
      let lastRoom = loginData.last_room || 'City2';
      let lastScene = loginData.last_room || 'City2';

      if (lastRoom === 'GlobalAS3Embassy') {
        console.log('[ProfileIPC] Last scene was GlobalAS3Embassy, redirecting to Early Island City2');
        lastIsland = 'Early';
        lastRoom = 'City2';
        lastScene = 'City2';
      }

      // Build flat data structure that matches SharedObject format
      const flatData = {
        // Basic user info
        firstName: loginData.firstname || 'Unknown',
        lastName: loginData.lastname || 'Poptropican',
        login: loginData.login || username,
        dbid: loginData.dbid || "",
        age: parseInt(loginData.age) || 10,
        Registred: true,  // They logged in successfully
        password: passwordHash,

        // Character appearance from look string
        gender: parseInt(lookParts[0]) || 1,
        skinColor: parseInt(lookParts[1]) || 5878232,
        hairColor: parseInt(lookParts[2]) || 2238750,
        lineColor: parseInt(lookParts[3]) || 4689324,
        eyelidPos: parseInt(lookParts[4]) || 0,
        eyelidsPos: parseInt(lookParts[4]) || 0,
        eyesFrame: lookParts[5] || 5,
        marksFrame: lookParts[6] || 1,
        pantsFrame: lookParts[7] || 7,
        lineWidth: parseInt(lookParts[8]) || 2,
        shirtFrame: lookParts[9] || 9,
        hairFrame: lookParts[10] || 10,
        mouthFrame: lookParts[11] || 11,
        itemFrame: lookParts[12] || 1,
        packFrame: lookParts[13] || 1,
        facialFrame: lookParts[14] || 1,
        overshirtFrame: lookParts[15] || 1,
        overpantsFrame: lookParts[16] || 1,
        specialAbility: lookParts[17] || 'none',
        specialAbilityParams: [['']],

        // Location data
        lastIsland: lastIsland,
        lastRoom: lastRoom,
        lastScene: lastScene,
        island: lastIsland,
        desc: lastRoom,
        enteringNewIsland: false,

        // Position data (save as room-specific positions)
        [`${lastRoom}xPos`]: loginData.lastx || 0,
        [`${lastRoom}yPos`]: loginData.lasty || 0,

        // Progress data
        visited: loginData.map || '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0',
        games: loginData.games || '',
        pickedItems: loginData.pickedItems || '',

        // Game scores
        ...scoresData,

        // Membership (always active for local desktop version)
        mem_status: 'active-renew',
        mem_date: new Date().toISOString().split('T')[0] + ' 00:00:00',
        mem_timestamp: new Date().getTime(),

        // userData (island-specific data, inventory, etc.)
        userData: userData,

        // Economy
        credits: parseInt(loginData.credits) || 0,
        credit_change: loginData.credit_change || '',
        recent: loginData.recent || '',

        // Parent email
        parentEmail: loginData.parent_email || '',
        parentEmailStatus: loginData.has_parent_email || false,

        // Flashpoint compatibility
        flashpointReady: true,
        removedItems: {},
        StorePage: 0
      };

      console.log('[ProfileIPC] Built profile data from login.php response');

      // Now fetch additional data from get_island_info.php
      console.log('[ProfileIPC] Fetching island info from /get_island_info.php');

      try {
        const islandInfoData = querystring.stringify({
          login: username,
          pass_hash: passwordHash,
          dbid: loginData.dbid || '',
          'island_names[0]': 'Early',
          'island_names[1]': 'Shark',
          'island_names[2]': 'Time',
          'island_names[3]': 'Carrot',
          'island_names[4]': 'Super',
          'island_names[5]': 'Spy',
          'island_names[6]': 'Nabooti',
          'island_names[7]': 'BigNate',
          'island_names[8]': 'Astro',
          'island_names[9]': 'Counter',
          'island_names[10]': 'Reality',
          'island_names[11]': 'Myth',
          'island_names[12]': 'Trade',
          'island_names[13]': 'Steam',
          'island_names[14]': 'Peanuts',
          'island_names[15]': 'Cryptid',
          'island_names[16]': 'West',
          'island_names[17]': 'Wimpy'
        });

        const islandInfo = await new Promise((resolve, reject) => {
          const options = {
            hostname: 'www.poptropica.com',
            port: 443,
            path: '/get_island_info.php',
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(islandInfoData)
            }
          };

          const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const parsed = querystring.parse(data);
                if (parsed.answer === 'ok' && parsed.json) {
                  const jsonData = JSON.parse(parsed.json);
                  console.log('[ProfileIPC] Island info received:', Object.keys(jsonData));
                  resolve(jsonData);
                } else {
                  console.warn('[ProfileIPC] Island info request returned:', parsed.answer);
                  resolve(null);
                }
              } catch (e) {
                console.warn('[ProfileIPC] Failed to parse island info:', e.message);
                resolve(null);
              }
            });
          });

          req.on('error', (e) => {
            console.warn('[ProfileIPC] Island info request failed:', e.message);
            resolve(null);
          });

          req.write(islandInfoData);
          req.end();
        });

        // Merge island inventory data if we got it
        if (islandInfo && islandInfo.items) {
          console.log('[ProfileIPC] Merging island inventory data');
          flatData.inventory = flatData.inventory || {};
          flatData.removedItems = flatData.removedItems || {};
          flatData.completedEvents = flatData.completedEvents || {};

          for (const island in islandInfo.items) {
            const fullIslandInventory = islandInfo.items[island];
            const currentIslandInventory = [];
            const removedItems = [];

            for (const itemId in fullIslandInventory) {
              // Convert itemId to number (game expects numbers, not strings)
              const itemIdNum = parseInt(itemId, 10);

              if (Number(fullIslandInventory[itemId]) === 0) {
                removedItems.push(itemIdNum);
              } else {
                currentIslandInventory.push(itemIdNum);
              }
            }

            flatData.inventory[island] = currentIslandInventory;
            flatData.removedItems[island] = removedItems;
          }

          // Add completed events
          if (islandInfo.event) {
            for (const island in islandInfo.event) {
              flatData.completedEvents[island] = islandInfo.event[island];
            }
          }
        }
      } catch (e) {
        console.warn('[ProfileIPC] Error fetching island info:', e.message);
      }

      // Fetch Skullduggery data
      try {
        console.log('[ProfileIPC] Fetching Skullduggery data from server');
        const skullPostData = querystring.stringify({
          login: username,
          pass_hash: passwordHash,
          dbid: loginData.dbid || ''
        });

        const skullData = await new Promise((resolve, reject) => {
          const options = {
            hostname: 'www.poptropica.com',
            port: 443,
            path: '/get_skullduggery.php',
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(skullPostData)
            }
          };

          const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const parsed = querystring.parse(data);
                if (parsed.answer === 'ok') {
                  // Parse all the fields and convert back to proper types
                  const skullData = {
                    gold: parseInt(parsed.gold) || 0,
                    ship_id: parseInt(parsed.ship_id) || 0,
                    current_port: parseInt(parsed.current_port) || 0,
                    last_port: parseInt(parsed.last_port) || 0,
                    voyage_days: parseInt(parsed.voyage_days) || 0,
                    insurance: parseInt(parsed.insurance) || 0,
                    level: parseInt(parsed.level) || 0,
                    port_prices: parsed.port_prices ? JSON.parse(parsed.port_prices) : [],
                    cargo: parsed.cargo ? JSON.parse(parsed.cargo) : [],
                    crew_roster: parsed.crew_roster ? JSON.parse(parsed.crew_roster) : [],
                    loc: parsed.loc ? JSON.parse(parsed.loc) : [],
                    loan: parsed.loan || ''
                  };
                  console.log('[ProfileIPC] Skullduggery data received:', skullData);
                  resolve(skullData);
                } else {
                  console.warn('[ProfileIPC] Skullduggery request returned:', parsed.answer);
                  resolve(null);
                }
              } catch (e) {
                console.warn('[ProfileIPC] Failed to parse skullduggery data:', e.message);
                resolve(null);
              }
            });
          });

          req.on('error', (e) => {
            console.warn('[ProfileIPC] Skullduggery request failed:', e.message);
            resolve(null);
          });

          req.write(skullPostData);
          req.end();
        });

        if (skullData) {
          flatData.skullData = skullData;
          console.log('[ProfileIPC] Added skullData to profile');
        }
      } catch (e) {
        console.warn('[ProfileIPC] Error fetching skullduggery data:', e.message);
      }

      // Now try to fetch getUserInfo via AMFPHP for credits/games/pickedItems
      console.log('[ProfileIPC] Attempting to fetch getUserInfo via AMFPHP');

      try {
        // AMFPHP uses AMF binary format, but we can try the JSON plugin endpoint
        const userInfoData = querystring.stringify({
          method: 'getUserInfo',
          login: username,
          pass_hash: passwordHash,
          dbid: loginData.dbid || ''
        });

        const userInfo = await new Promise((resolve, reject) => {
          const options = {
            hostname: 'www.poptropica.com',
            port: 443,
            path: '/AMFPHP/callRouter.php/PlayerService/fetch',
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(userInfoData)
            }
          };

          const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const jsonData = JSON.parse(data);
                console.log('[ProfileIPC] getUserInfo response:', jsonData);
                resolve(jsonData);
              } catch (e) {
                console.warn('[ProfileIPC] Failed to parse getUserInfo:', e.message);
                resolve(null);
              }
            });
          });

          req.on('error', (e) => {
            console.warn('[ProfileIPC] getUserInfo request failed:', e.message);
            resolve(null);
          });

          req.write(userInfoData);
          req.end();
        });

        // Merge user info if we got it
        if (userInfo) {
          if (userInfo.credits !== undefined) {
            flatData.credits = parseInt(userInfo.credits) || 0;
            console.log('[ProfileIPC] Updated credits from getUserInfo:', flatData.credits);
          }
          if (userInfo.games !== undefined) {
            flatData.games = userInfo.games;
            console.log('[ProfileIPC] Updated games from getUserInfo:', flatData.games);
          }
          if (userInfo.pickedItems !== undefined) {
            flatData.pickedItems = userInfo.pickedItems;
            console.log('[ProfileIPC] Updated pickedItems from getUserInfo:', flatData.pickedItems);
          }
        }
      } catch (e) {
        console.warn('[ProfileIPC] Error fetching getUserInfo:', e.message);
      }

      console.log('[ProfileIPC] Profile fetch complete with all available data');

      // Return minimal flat data - it will be loaded into the game's SharedObject,
      // then we'll export the complete SO to get the proper v2 format with rawSO
      return { success: true, profileData: flatData, username };
    } catch (err) {
      console.error('[ProfileIPC] profile-fetch-from-api error:', err);
      return { success: false, error: err.message };
    }
  });

  // Handler: Save fetched profile (after conflict resolution)
  // Writes directly in v2 format (with rawSO) using fetched data
  ipcMain.handle('profile-save-fetched', async (event, { profileData, username, action, existingFilename }) => {
    try {
      // Determine destination filename
      let filename;
      if (action === 'overwrite' && existingFilename) {
        filename = existingFilename; // trust existing full filename
        console.log(`[ProfileIPC] Overwriting existing profile: ${filename}`);
      } else {
        // Sanitize username and add .json extension
        const safe = (username || 'profile').toLowerCase().replace(/[^a-z0-9]/g, '');
        filename = `${safe || 'profile'}.json`;
        console.log(`[ProfileIPC] Saving as new profile: ${filename}`);
      }
      // Build v2 container immediately from fetched flat data
      const rawSO = { ...(profileData || {}) };

      // Normalize appearance data in rawSO to ensure proper types
      if (rawSO.gender !== undefined) rawSO.gender = typeof rawSO.gender === 'number' ? rawSO.gender : parseInt(rawSO.gender) || 1;
      if (rawSO.skinColor !== undefined) rawSO.skinColor = typeof rawSO.skinColor === 'number' ? rawSO.skinColor : parseInt(rawSO.skinColor) || 5878232;
      if (rawSO.hairColor !== undefined) rawSO.hairColor = typeof rawSO.hairColor === 'number' ? rawSO.hairColor : parseInt(rawSO.hairColor) || 2238750;
      if (rawSO.lineColor !== undefined) rawSO.lineColor = typeof rawSO.lineColor === 'number' ? rawSO.lineColor : parseInt(rawSO.lineColor) || 4689324;
      if (rawSO.lineWidth !== undefined) rawSO.lineWidth = typeof rawSO.lineWidth === 'number' ? rawSO.lineWidth : parseInt(rawSO.lineWidth) || 4;
      if (rawSO.eyelidsPos !== undefined) rawSO.eyelidsPos = typeof rawSO.eyelidsPos === 'number' ? rawSO.eyelidsPos : parseInt(rawSO.eyelidsPos) || 0;
      if (rawSO.eyelidPos !== undefined) rawSO.eyelidPos = typeof rawSO.eyelidPos === 'number' ? rawSO.eyelidPos : parseInt(rawSO.eyelidPos) || 0;

      // Normalize frame fields (convert numeric strings to numbers, keep named strings as-is)
      const frameFields = ['eyesFrame', 'marksFrame', 'pantsFrame', 'shirtFrame', 'hairFrame', 'mouthFrame', 'itemFrame', 'packFrame', 'facialFrame', 'overshirtFrame', 'overpantsFrame'];
      for (const field of frameFields) {
        if (rawSO[field] !== undefined && typeof rawSO[field] !== 'number') {
          const parsed = parseInt(rawSO[field]);
          if (!isNaN(parsed)) {
            rawSO[field] = parsed;
          }
          // else keep as string (like "fisherman", "poptropicon_wizard", etc.)
        }
      }

      // Normalize specialAbility (should be string, not array)
      if (Array.isArray(rawSO.specialAbility)) {
        rawSO.specialAbility = rawSO.specialAbility[0] || 'none';
      }

      // Force membership status to active (desktop version always has membership)
      rawSO.mem_status = 'active-renew';
      rawSO.mem_date = new Date().toISOString().split('T')[0] + ' 00:00:00';
      rawSO.mem_timestamp = new Date().getTime();

      // Derive lastCharX/Y from room-specific keys or known fields
      let lastIsland = rawSO.lastIsland || rawSO.island || 'Home';
      let lastRoom = rawSO.lastRoom || rawSO.desc || 'Home';
      let lastCharX = null;
      let lastCharY = null;
      try {
        const rx = rawSO[`${lastRoom}xPos`];
        const ry = rawSO[`${lastRoom}yPos`];
        if (rx != null) lastCharX = Number(rx);
        if (ry != null) lastCharY = Number(ry);
      } catch(_) {}

      const v2 = {
        // Human-readable organization (optional but helpful)
        user: {
          login: rawSO.login || username || '',
          dbid: rawSO.dbid || '',
          firstName: rawSO.firstName || '',
          lastName: rawSO.lastName || '',
          age: typeof rawSO.age === 'number' ? rawSO.age : (parseInt(rawSO.age) || 10),
          Registred: !!rawSO.Registred,
        },
        appearance: {
          // Normalize numeric fields
          gender: typeof rawSO.gender === 'number' ? rawSO.gender : parseInt(rawSO.gender) || 1,
          skinColor: typeof rawSO.skinColor === 'number' ? rawSO.skinColor : parseInt(rawSO.skinColor) || 5878232,
          hairColor: typeof rawSO.hairColor === 'number' ? rawSO.hairColor : parseInt(rawSO.hairColor) || 2238750,
          lineColor: typeof rawSO.lineColor === 'number' ? rawSO.lineColor : parseInt(rawSO.lineColor) || 4689324,
          eyelidsPos: typeof rawSO.eyelidsPos === 'number' ? rawSO.eyelidsPos : (typeof rawSO.eyelidPos === 'number' ? rawSO.eyelidPos : (parseInt(rawSO.eyelidsPos) || parseInt(rawSO.eyelidPos) || 0)),
          lineWidth: typeof rawSO.lineWidth === 'number' ? rawSO.lineWidth : parseInt(rawSO.lineWidth) || 4,
          // Frame fields can be strings or numbers (e.g., "1", "fisherman", 1)
          eyesFrame: typeof rawSO.eyesFrame === 'number' ? rawSO.eyesFrame : (isNaN(parseInt(rawSO.eyesFrame)) ? rawSO.eyesFrame : parseInt(rawSO.eyesFrame)),
          marksFrame: typeof rawSO.marksFrame === 'number' ? rawSO.marksFrame : (isNaN(parseInt(rawSO.marksFrame)) ? rawSO.marksFrame : parseInt(rawSO.marksFrame)),
          pantsFrame: typeof rawSO.pantsFrame === 'number' ? rawSO.pantsFrame : (isNaN(parseInt(rawSO.pantsFrame)) ? rawSO.pantsFrame : parseInt(rawSO.pantsFrame)),
          shirtFrame: typeof rawSO.shirtFrame === 'number' ? rawSO.shirtFrame : (isNaN(parseInt(rawSO.shirtFrame)) ? rawSO.shirtFrame : parseInt(rawSO.shirtFrame)),
          hairFrame: typeof rawSO.hairFrame === 'number' ? rawSO.hairFrame : (isNaN(parseInt(rawSO.hairFrame)) ? rawSO.hairFrame : parseInt(rawSO.hairFrame)),
          mouthFrame: typeof rawSO.mouthFrame === 'number' ? rawSO.mouthFrame : (isNaN(parseInt(rawSO.mouthFrame)) ? rawSO.mouthFrame : parseInt(rawSO.mouthFrame)),
          itemFrame: typeof rawSO.itemFrame === 'number' ? rawSO.itemFrame : (isNaN(parseInt(rawSO.itemFrame)) ? rawSO.itemFrame : parseInt(rawSO.itemFrame)),
          packFrame: typeof rawSO.packFrame === 'number' ? rawSO.packFrame : (isNaN(parseInt(rawSO.packFrame)) ? rawSO.packFrame : parseInt(rawSO.packFrame)),
          facialFrame: typeof rawSO.facialFrame === 'number' ? rawSO.facialFrame : (isNaN(parseInt(rawSO.facialFrame)) ? rawSO.facialFrame : parseInt(rawSO.facialFrame)),
          overshirtFrame: typeof rawSO.overshirtFrame === 'number' ? rawSO.overshirtFrame : (isNaN(parseInt(rawSO.overshirtFrame)) ? rawSO.overshirtFrame : parseInt(rawSO.overshirtFrame)),
          overpantsFrame: typeof rawSO.overpantsFrame === 'number' ? rawSO.overpantsFrame : (isNaN(parseInt(rawSO.overpantsFrame)) ? rawSO.overpantsFrame : parseInt(rawSO.overpantsFrame)),
          // specialAbility should be a string, not an array
          specialAbility: Array.isArray(rawSO.specialAbility) ? (rawSO.specialAbility[0] || 'none') : (rawSO.specialAbility || 'none'),
          // specialAbilityParams can be null or nested array
          specialAbilityParams: rawSO.specialAbilityParams || null,
        },
        progress: {
          visited: rawSO.visited || '',
          games: rawSO.games || '',
          inventory: rawSO.inventory || {},
          removedItems: rawSO.removedItems || {},
          completedEvents: rawSO.completedEvents || {},
          islandCompletions: rawSO.islandCompletions || {},
          islandTimes: rawSO.islandTimes || {},
          updatedIslands: rawSO.updatedIslands || {},
        },
        economy: {
          credits: typeof rawSO.credits === 'number' ? rawSO.credits : (parseInt(rawSO.credits) || 0),
        },
        // Raw SharedObject backup used by loader
        rawSO,
        // Useful top-level fields
        lastCharX: lastCharX != null ? lastCharX : rawSO.lastCharX,
        lastCharY: lastCharY != null ? lastCharY : rawSO.lastCharY,
        lastRoom: lastRoom,
        lastIsland: lastIsland,
        version: 2,
        exported_date: new Date().toString(),
        profileName: username || rawSO.profileName || rawSO.login || 'profile',
        lastSaved: new Date().toISOString(),
      };

      const success = await profileManager.saveProfile(filename, v2);
      if (!success) throw new Error('Failed to save profile');

      return { success: true, filename };
    } catch (err) {
      console.error('[ProfileIPC] profile-save-fetched error:', err);
      return { success: false, error: err.message };
    }
  });

  // IPC: Upgrade an existing saved profile to v2 (export via Flash)
  ipcMain.handle('profile-upgrade-to-v2', async (event, filename) => {
    try {
      if (!filename) throw new Error('No filename provided');
      // Load existing profile (supports v1/v2)
      const data = await profileManager.loadProfile(filename);

      // Ensure window/Flash is available
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window not available');

      // Helper to call Flash (duplicate of inline helper above)
      async function callFlash(fnName, ...fnArgs) {
        const script = `
          (function(){
            try {
              var game = document.getElementById('game');
              if (!game) return { ok:false, error:'Flash element not found' };
              var _fn = ${JSON.stringify('')};
              _fn = ${JSON.stringify('')} + ${JSON.stringify('')}; // no-op to avoid minifier quirks
              _fn = ${JSON.stringify(fnName)};
              var _args = ${JSON.stringify(fnArgs)};
              if (typeof game[_fn] === 'function') {
                var res = game[_fn].apply(game, _args);
                return { ok:true, result: res };
              }
              if (typeof game.CallFunction === 'function') {
                function esc(s){return String(s).replace(/[<>&]/g, function(c){return ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])});}
                var xmlArgs = '';
                for (var i=0;i<_args.length;i++) {
                  var a = _args[i];
                  if (typeof a === 'number') xmlArgs += '<number>'+a+'</number>';
                  else if (typeof a === 'boolean') xmlArgs += '<'+(a?'true':'false')+'/>';
                  else xmlArgs += '<string>'+esc(String(a))+'</string>';
                }
                var xml = '<invoke name="'+_fn+'" returntype="xml"><arguments>'+xmlArgs+'</arguments></invoke>';
                var res2 = game.CallFunction(xml);
                return { ok:true, result: res2 };
              }
              return { ok:false, error:'ExternalInterface not available' };
            } catch(e) {
              return { ok:false, error: (e && e.message) || String(e) };
            }
          })()
        `;
        return await mainWindow.webContents.executeJavaScript(script, true);
      }

      // Load and export
      const loadRes = await callFlash('LoadProfileData', JSON.stringify(data));
      if (!loadRes || !loadRes.ok || String(loadRes.result).toLowerCase().indexOf('ok') < 0) {
        throw new Error('LoadProfileData failed');
      }
      const exportRes = await Promise.race([
        (async () => await callFlash('ExportCurrentProfile'))(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Export timeout')), 5000))
      ]);
      if (!exportRes || !exportRes.ok || !exportRes.result) throw new Error('ExportCurrentProfile failed');
      const v2 = JSON.parse(String(exportRes.result));
      v2.profileName = v2.profileName || (data.profileName || data.login || filename.replace(/\.json$/i, ''));
      v2.lastSaved = new Date().toISOString();

      const ok = await profileManager.saveProfile(filename, v2);
      if (!ok) throw new Error('Failed to save upgraded profile');
      return { success: true, filename };
    } catch (err) {
      console.error('[ProfileIPC] profile-upgrade-to-v2 error:', err);
      return { success: false, error: err.message };
    }
  });

  return mainWindow;
}


// Set PepperFlash switches before app ready
try {
  const rawPepper = resolvePepperFlashPath();
  const pepperPath = normalizePepperPath(rawPepper);
  if (pepperPath) {
    app.commandLine.appendSwitch('ppapi-flash-path', pepperPath);
    app.commandLine.appendSwitch('ppapi-flash-version', '32.0.0.465');
    console.log('[pepper] Using plugin at:', pepperPath);
  } else {
    console.warn('[pepper] No PepperFlash plugin found. Place it under electron-pepper/pepper/<platform>/');
  }
} catch (e) {
  console.warn('[pepper] Failed to configure plugin path:', e && e.message);
}

// Enable Chrome DevTools Protocol on port 9222 for remote control
app.commandLine.appendSwitch('remote-debugging-port', '9222');
console.log('[cdp] Enabled remote debugging on port 9222');

app.whenReady().then(() => {
  // Ensure exports directory exists
  (async () => { try { await fsp.mkdir(exportsRoot, { recursive: true }); } catch (_) {} })();
  console.log('[pepper] platform:', process.platform, 'arch:', process.arch);

  setupHttpInterception();
  console.log('[Profile] About to create window...');
  createWindow();
  console.log('[Profile] Window created, registering shortcuts...');

  // Initialize auto-updater for GitHub-based updates
  console.log('[AutoUpdater] Initializing...');
  const autoUpdater = new AutoUpdater({
    updateCheckUrl: 'https://raw.githubusercontent.com/andrewleewiles/poptropica-as2-desktop/main/version.json',
    checkInterval: 3600000, // Check every hour
    autoDownload: true,
    autoInstall: false // Prompt user before installing updates
  });
  autoUpdater.start();
  console.log('[AutoUpdater] Started - will check for updates periodically');

  // Register global shortcut for profile selector
  // NOTE: Disabled - profile selector is now an in-page overlay handled by base-pepper.html
  // The Shift+P keyboard shortcut is now registered within the renderer process
  // const registered = globalShortcut.register('Shift+P', () => {
  //   console.log('[Profile] Shift+P pressed - opening profile selector');
  //   if (profileWindow && !profileWindow.isDestroyed()) {
  //     profileWindow.focus();
  //     return;
  //   }
  //   profileWindow = new BrowserWindow({
  //     width: 800,
  //     height: 700,
  //     title: 'Profile Selector',
  //     parent: mainWindow,
  //     modal: true,
  //     webPreferences: {
  //       nodeIntegration: true,
  //       contextIsolation: false,
  //       webSecurity: false,
  //       allowRunningInsecureContent: true,
  //       plugins: true,
  //     }
  //   });
  //   profileWindow.loadFile(path.join(rendererRoot, 'profile-selector.html'));
  //   profileWindow.on('closed', () => {
  //     profileWindow = null;
  //   });
  // });
  //
  // if (registered) {
  //   console.log('[Profile] Shift+P shortcut registered successfully');
  // } else {
  //   console.error('[Profile] Failed to register Shift+P shortcut');
  // }

  // F12 global shortcut removed to allow browser DevTools to work normally
  // The in-game dev console (password-protected overlay) uses F12 and Ctrl+`
  // in the renderer process (base-pepper.html), and doesn't need a global shortcut.
  // Removing this global shortcut allows F12 to open browser DevTools via Electron's default behavior.

  // Old code (commented out):
  // const devToolsRegistered = globalShortcut.register('F12', () => {
  //   console.log('[DevTools] F12 pressed - toggling DevTools');
  //   if (mainWindow && !mainWindow.isDestroyed()) {
  //     if (mainWindow.webContents.isDevToolsOpened()) {
  //       mainWindow.webContents.closeDevTools();
  //     } else {
  //       mainWindow.webContents.openDevTools();
  //     }
  //   }
  // });

  // if (devToolsRegistered) {
  //   console.log('[DevTools] F12 shortcut registered successfully');
  // } else {
  //   console.error('[DevTools] Failed to register F12 shortcut');
  // }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Handle Command+Q on macOS - trigger window close event instead
app.on('before-quit', async (event) => {
  const currentProfileName = profileManager.getCurrentProfileName();

  // If no profile loaded or window already destroyed, allow quit
  if (!currentProfileName || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  // Only intercept the first quit attempt
  if (!global.savePromptShown) {
    event.preventDefault();
    global.savePromptShown = true;

    // Trigger the window close event which will show the save dialog
    mainWindow.close();
  }
});

// IPC handler for Save & Quit button from renderer
ipcMain.on('request-save-and-quit', () => {
  console.log('[IPC] Save & Quit requested from renderer');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
});

app.on('window-all-closed', () => {
  // Unregister global shortcuts
  globalShortcut.unregisterAll();
  console.log('[DevTools] Unregistered all global shortcuts');

  if (process.platform !== 'darwin') app.quit();
});
