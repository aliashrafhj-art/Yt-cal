const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/temp', express.static(TEMP_DIR));

const upload = multer({ dest: TEMP_DIR });

// ========== JOB SYSTEM ==========
const jobs = {};
function createJob() {
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  jobs[id] = { status: 'pending', log: [] };
  return id;
}
app.get('/api/job/:id', (req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ error: 'Job not found' });
  res.json(j);
});
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ========== CONFIG ==========
const CONFIG_FILE = path.join(__dirname, 'config.json');
const QUEUE_FILE = path.join(__dirname, 'queue.json');
const SKULL_FILE = path.join(__dirname, 'skull.png');

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return {
    phonkList: [], skullPath: null, textOverlay: '', textTime: 2,
    freezeSec: 3, scheduleDays: [], scheduleTime: '08:00',
    driveFolderId: '', driveAudioFolderId: '', enabled: false,
    clientId: '', clientSecret: ''
  };
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

function loadQueue() {
  try { if (fs.existsSync(QUEUE_FILE)) return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch {}
  return { usedVideos: [], remainingVideos: [], usedPhonk: [], remainingPhonk: [] };
}
function saveQueue(q) { fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2)); }

// ========== TOKEN STORAGE ==========
const TOKEN_FILE = path.join(__dirname, 'tokens.json');
function saveTokens(t) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2)); }
function loadTokens() {
  try { if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {}
  return {};
}

async function refreshYTToken() {
  try {
    const t = loadTokens();
    if (!t.yt_refresh_token) return null;
    const cfg = loadConfig();
    const clientId = cfg.clientId || process.env.YT_CLIENT_ID;
    const clientSecret = cfg.clientSecret || process.env.YT_CLIENT_SECRET;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ refresh_token: t.yt_refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' })
    });
    const d = await r.json();
    if (d.access_token) { saveTokens({ ...t, yt_access_token: d.access_token }); return d.access_token; }
  } catch(e) { console.warn('[TOKEN] YT refresh failed:', e.message); }
  return null;
}

async function refreshDriveToken() {
  try {
    const t = loadTokens();
    if (!t.drive_refresh_token) return null;
    const cfg = loadConfig();
    const clientId = cfg.clientId || process.env.YT_CLIENT_ID;
    const clientSecret = cfg.clientSecret || process.env.YT_CLIENT_SECRET;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ refresh_token: t.drive_refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' })
    });
    const d = await r.json();
    if (d.access_token) { saveTokens({ ...t, drive_access_token: d.access_token }); return d.access_token; }
  } catch(e) { console.warn('[TOKEN] Drive refresh failed:', e.message); }
  return null;
}

async function getYTToken() {
  const refreshed = await refreshYTToken();
  if (refreshed) return refreshed;
  return loadTokens().yt_access_token || null;
}

async function getDriveToken() {
  const refreshed = await refreshDriveToken();
  if (refreshed) return refreshed;
  return loadTokens().drive_access_token || null;
}

// ========== OAUTH ==========
app.get('/api/auth/status', (req, res) => {
  const t = loadTokens();
  res.json({ youtube: !!t.yt_access_token, drive: !!t.drive_access_token });
});

app.get('/auth/youtube', (req, res) => {
  const cfg = loadConfig();
  const clientId = cfg.clientId || process.env.YT_CLIENT_ID;
  const base = process.env.BASE_URL || `http://localhost:${PORT}`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${base}/auth/youtube/callback&response_type=code&scope=https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube&access_type=offline&prompt=consent`;
  res.redirect(url);
});

app.get('/auth/youtube/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const cfg = loadConfig();
    const clientId = cfg.clientId || process.env.YT_CLIENT_ID;
    const clientSecret = cfg.clientSecret || process.env.YT_CLIENT_SECRET;
    const base = process.env.BASE_URL || `http://localhost:${PORT}`;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: `${base}/auth/youtube/callback`, grant_type: 'authorization_code' })
    });
    const tokens = await r.json();
    if (!tokens.access_token) throw new Error(JSON.stringify(tokens));
    saveTokens({ ...loadTokens(), yt_access_token: tokens.access_token, yt_refresh_token: tokens.refresh_token });
    res.send(`<html><body style="background:#0a0a0f;color:#06d6a0;font-family:sans-serif;text-align:center;padding:60px"><h2>YouTube সংযুক্ত!</h2><script>setTimeout(()=>window.close(),2000)</script></body></html>`);
  } catch(err) { res.send(`<html><body style="background:#0a0a0f;color:red;padding:40px"><h2>${err.message}</h2></body></html>`); }
});

app.get('/auth/drive', (req, res) => {
  const cfg = loadConfig();
  const clientId = cfg.clientId || process.env.YT_CLIENT_ID;
  const base = process.env.BASE_URL || `http://localhost:${PORT}`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${base}/auth/drive/callback&response_type=code&scope=https://www.googleapis.com/auth/drive&access_type=offline&prompt=consent`;
  res.redirect(url);
});

app.get('/auth/drive/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const cfg = loadConfig();
    const clientId = cfg.clientId || process.env.YT_CLIENT_ID;
    const clientSecret = cfg.clientSecret || process.env.YT_CLIENT_SECRET;
    const base = process.env.BASE_URL || `http://localhost:${PORT}`;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: `${base}/auth/drive/callback`, grant_type: 'authorization_code' })
    });
    const tokens = await r.json();
    if (!tokens.access_token) throw new Error(JSON.stringify(tokens));
    saveTokens({ ...loadTokens(), drive_access_token: tokens.access_token, drive_refresh_token: tokens.refresh_token });
    res.send(`<html><body style="background:#0a0a0f;color:#06d6a0;font-family:sans-serif;text-align:center;padding:60px"><h2>Drive সংযুক্ত!</h2><script>setTimeout(()=>window.close(),2000)</script></body></html>`);
  } catch(err) { res.send(`<html><body style="background:#0a0a0f;color:red;padding:40px"><h2>${err.message}</h2></body></html>`); }
});

// ========== CONFIG API ==========
app.get('/api/config', (req, res) => res.json(loadConfig()));
app.post('/api/config/save', (req, res) => {
  const cfg = { ...loadConfig(), ...req.body };
  saveConfig(cfg);
  res.json({ ok: true });
});

// ========== SKULL UPLOAD ==========
app.post('/api/skull/upload', upload.single('skull'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  fs.copyFileSync(req.file.path, SKULL_FILE);
  fs.unlinkSync(req.file.path);
  const cfg = loadConfig();
  cfg.skullPath = SKULL_FILE;
  saveConfig(cfg);
  res.json({ ok: true });
});

// ========== DRIVE API ==========
app.get('/api/drive/videos', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const driveToken = await getDriveToken();
    if (!driveToken) return res.status(401).json({ error: 'Drive সংযুক্ত নয়' });
    const cfg = loadConfig();
    if (!cfg.driveFolderId) return res.json({ files: [] });
    const q = encodeURIComponent(`'${cfg.driveFolderId}' in parents and mimeType contains 'video/' and trashed=false`);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size)&pageSize=100`, {
      headers: { 'Authorization': `Bearer ${driveToken}` }
    });
    const d = await r.json();
    res.json({ files: d.files || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/drive/audios', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const driveToken = await getDriveToken();
    if (!driveToken) return res.status(401).json({ error: 'Drive সংযুক্ত নয়' });
    const cfg = loadConfig();
    if (!cfg.driveAudioFolderId) return res.json({ files: [] });
    const q = encodeURIComponent(`'${cfg.driveAudioFolderId}' in parents and mimeType contains 'audio/' and trashed=false`);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size)&pageSize=100`, {
      headers: { 'Authorization': `Bearer ${driveToken}` }
    });
    const d = await r.json();
    res.json({ files: d.files || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ========== CORE TROLL EDIT ==========
async function processTrollEdit(videoFileId, jobId) {
  const fetch = (await import('node-fetch')).default;
  const cfg = loadConfig();

  jobs[jobId] = { status: 'running', log: ['শুরু হচ্ছে...'] };
  const log = (msg) => {
    console.log('[TROLL]', msg);
    jobs[jobId].log = [...jobs[jobId].log, msg];
  };

  const driveToken = await getDriveToken();
  const ytToken = await getYTToken();

  if (!driveToken) { jobs[jobId] = { status: 'error', error: 'Drive সংযুক্ত নয়', log: jobs[jobId].log }; return; }
  if (!ytToken) { jobs[jobId] = { status: 'error', error: 'YouTube সংযুক্ত নয়', log: jobs[jobId].log }; return; }
  if (!cfg.phonkList || cfg.phonkList.length === 0) { jobs[jobId] = { status: 'error', error: 'Phonk audio নেই', log: jobs[jobId].log }; return; }
  if (!cfg.skullPath || !fs.existsSync(cfg.skullPath)) { jobs[jobId] = { status: 'error', error: 'Skull PNG নেই', log: jobs[jobId].log }; return; }

  const tempFiles = [];
  try {
    // Pick phonk FIFO
    const q = loadQueue();
    let remPhonk = (q.remainingPhonk || []).filter(n => cfg.phonkList.find(p => p.name === n));
    if (remPhonk.length === 0) {
      remPhonk = cfg.phonkList.map(p => p.name);
      log('Phonk queue reset — নতুন cycle শুরু');
    }
    const phonkName = remPhonk.shift();
    saveQueue({ ...q, remainingPhonk: remPhonk, usedPhonk: [...(q.usedPhonk || []), phonkName] });
    const phonkInfo = cfg.phonkList.find(p => p.name === phonkName) || cfg.phonkList[0];
    const dropTime = parseFloat(phonkInfo.dropTime) || 0;
    log(`Phonk: ${phonkName} | Drop: ${dropTime}s`);

    // Download video
    const videoPath = path.join(TEMP_DIR, `vid_${jobId}.mp4`);
    tempFiles.push(videoPath);
    log('Video নামানো হচ্ছে...');
    const vidRes = await fetch(`https://www.googleapis.com/drive/v3/files/${videoFileId}?alt=media`, {
      headers: { 'Authorization': `Bearer ${driveToken}` }
    });
    if (!vidRes.ok) throw new Error('Video download: ' + await vidRes.text());
    fs.writeFileSync(videoPath, Buffer.from(await vidRes.arrayBuffer()));
    log('Video নামানো হয়েছে');

    // Find + download phonk from Drive
    const safeName = phonkName.replace(/'/g, "\\'");
    const aq = encodeURIComponent(`'${cfg.driveAudioFolderId}' in parents and name='${safeName}' and trashed=false`);
    const ar = await fetch(`https://www.googleapis.com/drive/v3/files?q=${aq}&fields=files(id,name)&pageSize=5`, {
      headers: { 'Authorization': `Bearer ${driveToken}` }
    });
    const ad = await ar.json();
    if (!ad.files || !ad.files[0]) throw new Error('Phonk Drive-এ পাওয়া যায়নি: ' + phonkName);

    const phonkPath = path.join(TEMP_DIR, `phonk_${jobId}.mp3`);
    tempFiles.push(phonkPath);
    log('Phonk নামানো হচ্ছে...');
    const pr = await fetch(`https://www.googleapis.com/drive/v3/files/${ad.files[0].id}?alt=media`, {
      headers: { 'Authorization': `Bearer ${driveToken}` }
    });
    fs.writeFileSync(phonkPath, Buffer.from(await pr.arrayBuffer()));
    log('Phonk নামানো হয়েছে');

    // Get duration
    const { stdout: durOut } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`);
    const duration = parseFloat(durOut.trim());
    const freezeSec = Math.min(parseFloat(cfg.freezeSec) || 3, duration * 0.8);
    const freezeStart = Math.max(0.1, duration - freezeSec);
    log(`Duration: ${duration.toFixed(1)}s | Freeze: শেষ ${freezeSec.toFixed(1)}s`);

    // Build ffmpeg filter
    const skullPath = cfg.skullPath;
    const textOverlay = (cfg.textOverlay || '').replace(/[':]/g, '');
    const textTime = parseFloat(cfg.textTime) || 2;
    const outPath = path.join(TEMP_DIR, `out_${jobId}.mp4`);
    tempFiles.push(outPath);

    let fc;
    if (textOverlay) {
      fc = `[0:v]trim=end=${freezeStart},setpts=PTS-STARTPTS[before];[0:v]trim=start=${freezeStart},setpts=PTS-STARTPTS,select='eq(n\\,0)',loop=loop=-1:size=1,trim=duration=${freezeSec}[frozen];[frozen]eq=brightness=-0.25:saturation=0.2:contrast=1.5[dark];[1:v]scale=280:280[skull];[dark][skull]overlay=(W-w)/2:(H-h)/2[withskull];[withskull]drawtext=text='${textOverlay}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=h*0.15:enable='between(t,0,${textTime})':box=1:boxcolor=black@0.5:boxborderw=8[withtext];[before][withtext]concat=n=2:v=1:a=0[outv];[2:a]atrim=start=${dropTime},asetpts=PTS-STARTPTS,volume=1.5[phonk_trim];[phonk_trim]atrim=end=${duration},asetpts=PTS-STARTPTS[outa]`;
    } else {
      fc = `[0:v]trim=end=${freezeStart},setpts=PTS-STARTPTS[before];[0:v]trim=start=${freezeStart},setpts=PTS-STARTPTS,select='eq(n\\,0)',loop=loop=-1:size=1,trim=duration=${freezeSec}[frozen];[frozen]eq=brightness=-0.25:saturation=0.2:contrast=1.5[dark];[1:v]scale=280:280[skull];[dark][skull]overlay=(W-w)/2:(H-h)/2[withskull];[before][withskull]concat=n=2:v=1:a=0[outv];[2:a]atrim=start=${dropTime},asetpts=PTS-STARTPTS,volume=1.5[phonk_trim];[phonk_trim]atrim=end=${duration},asetpts=PTS-STARTPTS[outa]`;
    }

    log('ffmpeg চলছে...');
    await execAsync(`ffmpeg -y -i "${videoPath}" -i "${skullPath}" -i "${phonkPath}" -filter_complex "${fc}" -map "[outv]" -map "[outa]" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -shortest "${outPath}"`);
    log('Video তৈরি হয়েছে');

    // Upload to YouTube
    log('YouTube-এ আপলোড হচ্ছে...');
    const title = (phonkName.replace(/\.[^.]+$/, '') || 'Troll Edit').substring(0, 100);
    const videoBuffer = fs.readFileSync(outPath);
    const metaBody = JSON.stringify({
      snippet: { title, description: 'Wait for the end...\n\n#shorts #viral #phonk #trolledit #skulledit #waitfortheend #satisfying', tags: ['shorts', 'viral', 'phonk', 'troll edit', 'skull edit', 'satisfying', 'wait for end'], categoryId: '22' },
      status: { privacyStatus: 'public' }
    });
    const boundary = `tep${jobId}`;
    const part1 = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaBody}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`);
    const part2 = Buffer.from(`\r\n--${boundary}--`);
    const fullBody = Buffer.concat([part1, videoBuffer, part2]);

    const upRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ytToken}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(fullBody.length) },
      body: fullBody
    });
    const upText = await upRes.text();
    if (!upRes.ok) throw new Error('YT upload: ' + upText);
    const ytData = JSON.parse(upText);
    log(`আপলোড সফল: https://youtu.be/${ytData.id}`);

    tempFiles.forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
    jobs[jobId] = { status: 'done', log: jobs[jobId].log, result: { videoId: ytData.id, url: `https://youtu.be/${ytData.id}`, title } };

  } catch(e) {
    tempFiles.forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
    log('Error: ' + e.message);
    jobs[jobId] = { status: 'error', error: e.message, log: jobs[jobId].log };
  }
}

// Manual run
app.post('/api/run', async (req, res) => {
  const { videoFileId } = req.body;
  if (!videoFileId) return res.status(400).json({ error: 'videoFileId required' });
  const jobId = createJob();
  res.json({ jobId });
  processTrollEdit(videoFileId, jobId).catch(e => console.error('[TROLL] Fatal:', e.message));
});

// ========== SCHEDULER ==========
let scheduler = null;
function startScheduler() {
  if (scheduler) clearInterval(scheduler);
  scheduler = setInterval(async () => {
    try {
      const cfg = loadConfig();
      if (!cfg.enabled) return;
      const now = new Date();
      const bdMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 360) % 1440;
      const bdH = Math.floor(bdMin / 60);
      const bdM = bdMin % 60;
      const currentTime = `${String(bdH).padStart(2,'0')}:${String(bdM).padStart(2,'0')}`;
      const day = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Dhaka' });
      if (!(cfg.scheduleDays || []).includes(day)) return;
      if (currentTime !== cfg.scheduleTime) return;

      const fetch = (await import('node-fetch')).default;
      const driveToken = await getDriveToken();
      if (!driveToken) { console.log('[SCHED] Drive সংযুক্ত নয়'); return; }

      const q = encodeURIComponent(`'${cfg.driveFolderId}' in parents and mimeType contains 'video/' and trashed=false`);
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=100`, {
        headers: { 'Authorization': `Bearer ${driveToken}` }
      });
      const d = await r.json();
      const videos = d.files || [];
      if (!videos.length) { console.log('[SCHED] কোনো video নেই'); return; }

      const queue = loadQueue();
      let remVids = (queue.remainingVideos || []).filter(id => videos.find(v => v.id === id));
      if (remVids.length === 0) remVids = videos.map(v => v.id).sort(() => Math.random() - 0.5);
      const nextId = remVids.shift();
      saveQueue({ ...loadQueue(), remainingVideos: remVids, usedVideos: [...(queue.usedVideos || []), nextId] });

      const jobId = createJob();
      console.log('[SCHED] শুরু হচ্ছে:', nextId);
      processTrollEdit(nextId, jobId).catch(e => console.error('[SCHED] Error:', e.message));
    } catch(e) { console.error('[SCHED] Fatal:', e.message); }
  }, 60000);
}
startScheduler();

// SSE log
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (msg) => res.write(`data: ${JSON.stringify({ msg })}\n\n`);
  const orig = console.log.bind(console);
  console.log = (...args) => { orig(...args); send(args.join(' ')); };
  req.on('close', () => { console.log = orig; });
});

app.listen(PORT, () => console.log(`Troll Edit Pro running on port ${PORT}`));
