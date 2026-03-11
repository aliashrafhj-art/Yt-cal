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

// ========== JOBS ==========
const jobs = {};
function createJob() {
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  jobs[id] = { status: 'pending', log: [] };
  return id;
}
function jlog(id, msg) {
  console.log(msg);
  if (jobs[id]) jobs[id].log = [...jobs[id].log, msg];
}
app.get('/api/job/:id', (req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ========== CONFIG ==========
const CFG_FILE = path.join(__dirname, 'config.json');
const Q_FILE = path.join(__dirname, 'queue.json');
const TKN_FILE = path.join(__dirname, 'tokens.json');

function loadCfg() {
  try { if (fs.existsSync(CFG_FILE)) return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch {}
  return { phonkList: [], skullPath: null, textOverlay: '', textTime: 2, freezeSec: 3, scheduleDays: [], scheduleTime: '08:00', driveFolderId: '', driveAudioFolderId: '', enabled: false, clientId: '', clientSecret: '' };
}
function saveCfg(c) { fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2)); }
function loadQ() {
  try { if (fs.existsSync(Q_FILE)) return JSON.parse(fs.readFileSync(Q_FILE, 'utf8')); } catch {}
  return { usedVideos: [], remainingVideos: [], usedPhonk: [], remainingPhonk: [] };
}
function saveQ(q) { fs.writeFileSync(Q_FILE, JSON.stringify(q, null, 2)); }
function loadTkn() {
  try { if (fs.existsSync(TKN_FILE)) return JSON.parse(fs.readFileSync(TKN_FILE, 'utf8')); } catch {}
  return {};
}
function saveTkn(t) { fs.writeFileSync(TKN_FILE, JSON.stringify(t, null, 2)); }

// ========== TOKEN REFRESH ==========
async function refreshTkn(refreshToken, type) {
  try {
    const cfg = loadCfg();
    const cid = cfg.clientId || process.env.YT_CLIENT_ID;
    const csec = cfg.clientSecret || process.env.YT_CLIENT_SECRET;
    if (!refreshToken || !cid || !csec) return null;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ refresh_token: refreshToken, client_id: cid, client_secret: csec, grant_type: 'refresh_token' })
    });
    const d = await r.json();
    if (d.access_token) { const t = loadTkn(); t[type + '_access_token'] = d.access_token; saveTkn(t); return d.access_token; }
  } catch(e) {}
  return null;
}
async function getYT() { const t = loadTkn(); return await refreshTkn(t.yt_refresh_token, 'yt') || t.yt_access_token || null; }
async function getDrive() { const t = loadTkn(); return await refreshTkn(t.drive_refresh_token, 'drive') || t.drive_access_token || null; }

// ========== OAUTH ==========
app.get('/api/auth/status', (_, res) => { const t = loadTkn(); res.json({ youtube: !!t.yt_access_token, drive: !!t.drive_access_token }); });

app.get('/auth/youtube', (req, res) => {
  const cfg = loadCfg(); const base = process.env.BASE_URL || 'http://localhost:' + PORT;
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?client_id=' + (cfg.clientId || process.env.YT_CLIENT_ID) + '&redirect_uri=' + base + '/auth/youtube/callback&response_type=code&scope=https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube&access_type=offline&prompt=consent');
});
app.get('/auth/youtube/callback', async (req, res) => {
  try {
    const cfg = loadCfg(); const base = process.env.BASE_URL || 'http://localhost:' + PORT;
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code: req.query.code, client_id: cfg.clientId || process.env.YT_CLIENT_ID, client_secret: cfg.clientSecret || process.env.YT_CLIENT_SECRET, redirect_uri: base + '/auth/youtube/callback', grant_type: 'authorization_code' }) });
    const tkns = await r.json();
    if (!tkns.access_token) throw new Error(JSON.stringify(tkns));
    saveTkn({ ...loadTkn(), yt_access_token: tkns.access_token, yt_refresh_token: tkns.refresh_token });
    res.send('<html><body style="background:#0a0a0f;color:#06d6a0;font-family:sans-serif;text-align:center;padding:60px"><h2>YouTube সংযুক্ত ✓</h2><script>setTimeout(()=>window.close(),2000)</script></body></html>');
  } catch(e) { res.send('<html><body style="background:#0a0a0f;color:red;padding:40px"><h2>' + e.message + '</h2></body></html>'); }
});
app.get('/auth/drive', (req, res) => {
  const cfg = loadCfg(); const base = process.env.BASE_URL || 'http://localhost:' + PORT;
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?client_id=' + (cfg.clientId || process.env.YT_CLIENT_ID) + '&redirect_uri=' + base + '/auth/drive/callback&response_type=code&scope=https://www.googleapis.com/auth/drive&access_type=offline&prompt=consent');
});
app.get('/auth/drive/callback', async (req, res) => {
  try {
    const cfg = loadCfg(); const base = process.env.BASE_URL || 'http://localhost:' + PORT;
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code: req.query.code, client_id: cfg.clientId || process.env.YT_CLIENT_ID, client_secret: cfg.clientSecret || process.env.YT_CLIENT_SECRET, redirect_uri: base + '/auth/drive/callback', grant_type: 'authorization_code' }) });
    const tkns = await r.json();
    if (!tkns.access_token) throw new Error(JSON.stringify(tkns));
    saveTkn({ ...loadTkn(), drive_access_token: tkns.access_token, drive_refresh_token: tkns.refresh_token });
    res.send('<html><body style="background:#0a0a0f;color:#06d6a0;font-family:sans-serif;text-align:center;padding:60px"><h2>Drive সংযুক্ত ✓</h2><script>setTimeout(()=>window.close(),2000)</script></body></html>');
  } catch(e) { res.send('<html><body style="background:#0a0a0f;color:red;padding:40px"><h2>' + e.message + '</h2></body></html>'); }
});

// ========== CONFIG API ==========
app.get('/api/config', (_, res) => res.json(loadCfg()));
app.post('/api/config/save', (req, res) => { saveCfg({ ...loadCfg(), ...req.body }); res.json({ ok: true }); });
app.post('/api/skull/upload', upload.single('skull'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const dest = path.join(__dirname, 'skull.png');
  fs.copyFileSync(req.file.path, dest); fs.unlinkSync(req.file.path);
  const cfg = loadCfg(); cfg.skullPath = dest; saveCfg(cfg);
  res.json({ ok: true });
});

// ========== DRIVE LIST ==========
app.get('/api/drive/videos', async (_, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const tok = await getDrive(); if (!tok) return res.status(401).json({ error: 'Drive সংযুক্ত নয়' });
    const cfg = loadCfg(); if (!cfg.driveFolderId) return res.json({ files: [] });
    const r = await fetch('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent("'" + cfg.driveFolderId + "' in parents and mimeType contains 'video/' and trashed=false") + '&fields=files(id,name,size)&pageSize=100', { headers: { Authorization: 'Bearer ' + tok } });
    res.json({ files: (await r.json()).files || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/drive/audios', async (_, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const tok = await getDrive(); if (!tok) return res.status(401).json({ error: 'Drive সংযুক্ত নয়' });
    const cfg = loadCfg(); if (!cfg.driveAudioFolderId) return res.json({ files: [] });
    const r = await fetch('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent("'" + cfg.driveAudioFolderId + "' in parents and mimeType contains 'audio/' and trashed=false") + '&fields=files(id,name,size)&pageSize=100', { headers: { Authorization: 'Bearer ' + tok } });
    res.json({ files: (await r.json()).files || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ========== YT DOWNLOAD → DRIVE ==========
function driveUpload(fetch, tok, name, mimeType, folderId, buffer) {
  const b = 'bnd_' + Date.now();
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([Buffer.from('--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + b + '\r\nContent-Type: ' + mimeType + '\r\n\r\n'), buffer, Buffer.from('\r\n--' + b + '--')]);
  return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'multipart/related; boundary=' + b, 'Content-Length': String(body.length) }, body });
}

app.post('/api/yt/save-video', async (req, res) => {
  const { url } = req.body; if (!url) return res.status(400).json({ error: 'url required' });
  const jobId = createJob(); res.json({ jobId });
  (async () => {
    const fetch = (await import('node-fetch')).default;
    jobs[jobId] = { status: 'running', log: [] }; const log = (m) => jlog(jobId, m);
    const tmp = path.join(TEMP_DIR, 'ytv_' + jobId + '.mp4');
    try {
      const tok = await getDrive(); if (!tok) throw new Error('Drive সংযুক্ত নয়');
      const cfg = loadCfg(); if (!cfg.driveFolderId) throw new Error('Drive video folder ID নেই');
      log('Video নামানো হচ্ছে...');
      await execAsync('yt-dlp -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]" --merge-output-format mp4 --no-playlist -o "' + tmp + '" "' + url + '"', { maxBuffer: 200*1024*1024, timeout: 600000 });
      log('Drive-এ পাঠানো হচ্ছে...');
      const name = 'video_' + Date.now() + '.mp4';
      const r = await driveUpload(fetch, tok, name, 'video/mp4', cfg.driveFolderId, fs.readFileSync(tmp));
      const d = await r.json(); if (!d.id) throw new Error('Drive upload failed');
      fs.unlinkSync(tmp); log('সেভ হয়েছে: ' + name + ' ✓');
      jobs[jobId] = { status: 'done', log: jobs[jobId].log };
    } catch(e) { try { if(fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {} log('Error: ' + e.message); jobs[jobId] = { status: 'error', error: e.message, log: jobs[jobId].log }; }
  })();
});

app.post('/api/yt/save-audio', async (req, res) => {
  const { url } = req.body; if (!url) return res.status(400).json({ error: 'url required' });
  const jobId = createJob(); res.json({ jobId });
  (async () => {
    const fetch = (await import('node-fetch')).default;
    jobs[jobId] = { status: 'running', log: [] }; const log = (m) => jlog(jobId, m);
    const tmp = path.join(TEMP_DIR, 'yta_' + jobId);
    try {
      const tok = await getDrive(); if (!tok) throw new Error('Drive সংযুক্ত নয়');
      const cfg = loadCfg(); if (!cfg.driveAudioFolderId) throw new Error('Drive audio folder ID নেই');
      const { stdout: titleOut } = await execAsync('yt-dlp --get-title --no-playlist "' + url + '"', { timeout: 30000 });
      const title = titleOut.trim().replace(/[<>:"/\\|?*]/g, '').substring(0, 80) || 'audio_' + Date.now();
      log('নামানো হচ্ছে: ' + title);
      await execAsync('yt-dlp -x --audio-format mp3 --audio-quality 0 --no-playlist -o "' + tmp + '.%(ext)s" "' + url + '"', { maxBuffer: 100*1024*1024, timeout: 300000 });
      const mp3 = tmp + '.mp3'; if (!fs.existsSync(mp3)) throw new Error('MP3 তৈরি হয়নি');
      const name = title + '.mp3';
      const r = await driveUpload(fetch, tok, name, 'audio/mpeg', cfg.driveAudioFolderId, fs.readFileSync(mp3));
      const d = await r.json(); if (!d.id) throw new Error('Drive upload failed');
      fs.unlinkSync(mp3); log('সেভ হয়েছে: ' + name + ' ✓');
      jobs[jobId] = { status: 'done', log: jobs[jobId].log };
    } catch(e) { ['mp3','m4a','webm'].forEach(ext => { try { const f = tmp+'.'+ext; if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} }); log('Error: ' + e.message); jobs[jobId] = { status: 'error', error: e.message, log: jobs[jobId].log }; }
  })();
});

// ========== HELPERS ==========
async function ytUpload(videoPath, title, desc, tags) {
  const fetch = (await import('node-fetch')).default;
  const tok = await getYT(); if (!tok) throw new Error('YouTube সংযুক্ত নয়');
  if (!fs.existsSync(videoPath)) throw new Error('Video file নেই');
  const buf = fs.readFileSync(videoPath);
  const meta = JSON.stringify({ snippet: { title: title.substring(0,100), description: desc, tags: tags || ['shorts','viral'], categoryId: '22' }, status: { privacyStatus: 'public' } });
  const b = 'ytup_' + Date.now();
  const body = Buffer.concat([Buffer.from('--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + b + '\r\nContent-Type: video/mp4\r\n\r\n'), buf, Buffer.from('\r\n--' + b + '--')]);
  const r = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'multipart/related; boundary=' + b, 'Content-Length': String(body.length) }, body });
  const txt = await r.text(); if (!r.ok) throw new Error('YT upload: ' + txt);
  return JSON.parse(txt);
}

async function dlPhonk(fileId, dest) {
  const fetch = (await import('node-fetch')).default;
  const tok = await getDrive(); if (!tok) throw new Error('Drive সংযুক্ত নয়');
  const r = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error('Phonk download failed');
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

// ========== TROLL EDIT REALTIME ==========
app.post('/api/run/realtime', async (req, res) => {
  const { ytUrl, phonkFileId, dropTime, freezeSec, introText, introSize, introPos, textTime, climaxText, climaxSize, climaxPos, skullSize, skullPos, colorBrightness, colorContrast, colorSaturation, colorPreset } = req.body;
  if (!ytUrl || !phonkFileId) return res.status(400).json({ error: 'ytUrl and phonkFileId required' });
  const jobId = createJob(); res.json({ jobId });
  (async () => {
    jobs[jobId] = { status: 'running', log: [] }; const log = (m) => jlog(jobId, m);
    const tmp = [];
    try {
      const cfg = loadCfg();
      if (!cfg.skullPath || !fs.existsSync(cfg.skullPath)) throw new Error('Skull PNG নেই');
      const vidP = path.join(TEMP_DIR, 'rtv_' + jobId + '.mp4'); tmp.push(vidP);
      log('Video নামানো হচ্ছে...');
      await execAsync('yt-dlp -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]" --merge-output-format mp4 --no-playlist -o "' + vidP + '" "' + ytUrl + '"', { maxBuffer: 100*1024*1024, timeout: 300000 });
      const phP = path.join(TEMP_DIR, 'rtp_' + jobId + '.mp3'); tmp.push(phP);
      log('Phonk নামানো হচ্ছে...');
      await dlPhonk(phonkFileId, phP);

      const { stdout: pb } = await execAsync('ffprobe -v error -select_streams v:0 -show_entries stream=width,height -show_entries format=duration -of json "' + vidP + '"');
      const pd = JSON.parse(pb); const dur = parseFloat(pd.format.duration);
      const vw = (pd.streams[0] || {}).width || 720, vh = (pd.streams[0] || {}).height || 1280;
      const tw = vw > vh ? 1920 : 1080, th = vw > vh ? 1080 : 1920;
      const fSec = Math.min(parseFloat(freezeSec) || 3, dur * 0.8);
      const fStart = Math.max(0.1, dur - fSec);
      const drop = parseFloat(dropTime) || 0;
      log('Duration: ' + dur.toFixed(1) + 's | Freeze: ' + fSec + 's');

      let br = parseFloat(colorBrightness) || 0, ct = parseFloat(colorContrast) || 1, st = parseFloat(colorSaturation) || 1;
      if (colorPreset === 'dark') { br = -0.1; ct = 1.3; st = 0.8; }
      else if (colorPreset === 'phonk_red') { br = -0.05; ct = 1.4; st = 1.2; }
      else if (colorPreset === 'cold_blue') { br = 0; ct = 1.2; st = 0.7; }

      const ss = parseInt(skullSize) || 280;
      const sp = skullPos || 'center';
      const sx = sp === 'left' ? '20' : sp === 'right' ? 'W-w-20' : '(W-w)/2';
      const sy = sp === 'top' ? '20' : sp === 'bottom' ? 'H-h-20' : '(H-h)/2';
      const py = (p) => p === 'top' ? 'h*0.08' : p === 'bottom' ? 'h*0.85' : 'h*0.5-text_h/2';
      const sc = 'scale=' + tw + ':' + th + ':force_original_aspect_ratio=decrease,pad=' + tw + ':' + th + ':(ow-iw)/2:(oh-ih)/2:black';
      const it = (introText || '').replace(/[':]/g, '');
      const ct2 = (climaxText || 'YOU ARE COOKED').replace(/[':]/g, '');
      const iSz = parseInt(introSize) || 40, iTm = parseFloat(textTime) || 2;
      const cSz = parseInt(climaxSize) || 48;

      let bef = '[0:v]' + sc + ',eq=brightness=' + br + ':contrast=' + ct + ':saturation=' + st;
      if (it) bef += ',drawtext=text=\'' + it + '\':fontcolor=white:fontsize=' + iSz + ':x=(w-text_w)/2:y=' + py(introPos||'top') + ':enable=\'between(t\\,' + 0 + '\\,' + iTm + ')\':box=1:boxcolor=black@0.5:boxborderw=6';
      bef += ',trim=end=' + fStart + ',setpts=PTS-STARTPTS[before]';
      const frz = '[0:v]' + sc + ',eq=brightness=' + (br-0.2) + ':contrast=' + (ct+0.2) + ':saturation=0.15,trim=start=' + fStart + ',setpts=PTS-STARTPTS,select=\'eq(n\\,0)\',loop=loop=-1:size=1,trim=duration=' + fSec + '[frz_raw]';
      const fc = bef + ';' + frz + ';[1:v]scale=' + ss + ':' + ss + '[sk];[frz_raw][sk]overlay=' + sx + ':' + sy + '[wsk];[wsk]drawtext=text=\'' + ct2 + '\':fontcolor=white:fontsize=' + cSz + ':x=(w-text_w)/2:y=' + py(climaxPos||'bottom') + ':box=1:boxcolor=black@0.6:boxborderw=8[frz];[2:a]atrim=start=' + drop + ',asetpts=PTS-STARTPTS,volume=1.5,atrim=end=' + dur + ',asetpts=PTS-STARTPTS[outa];[before][frz]concat=n=2:v=1:a=0[outv]';

      const outP = path.join(TEMP_DIR, 'rt_out_' + jobId + '.mp4');
      log('ffmpeg চলছে...');
      await execAsync('ffmpeg -y -i "' + vidP + '" -i "' + cfg.skullPath + '" -i "' + phP + '" -filter_complex "' + fc + '" -map "[outv]" -map "[outa]" -c:v libx264 -preset ultrafast -crf 23 -threads 2 -c:a aac -shortest "' + outP + '"', { maxBuffer: 100*1024*1024, timeout: 600000 });
      try { fs.unlinkSync(vidP); fs.unlinkSync(phP); } catch {}
      log('Edit সম্পন্ন! Preview দেখুন');
      jobs[jobId] = { status: 'preview', log: jobs[jobId].log, result: { previewUrl: '/temp/rt_out_' + jobId + '.mp4', outPath: outP, jobId } };
    } catch(e) { tmp.forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} }); log('Error: ' + e.message); jobs[jobId] = { status: 'error', error: e.message, log: jobs[jobId].log }; }
  })();
});

app.post('/api/run/upload', async (req, res) => {
  const { jobId, caption, description } = req.body;
  const job = jobs[jobId];
  if (!job || !job.result || !job.result.outPath) return res.status(404).json({ error: 'not found' });
  const upId = createJob(); res.json({ jobId: upId });
  (async () => {
    jobs[upId] = { status: 'running', log: [] }; const log = (m) => jlog(upId, m);
    try {
      const d = await ytUpload(job.result.outPath, caption || 'Troll Edit 💀', description || '#shorts #viral #phonk #trolledit', ['shorts','viral','phonk','troll edit','skull edit']);
      try { fs.unlinkSync(job.result.outPath); } catch {}
      log('আপলোড সফল: https://youtu.be/' + d.id + ' ✓');
      jobs[upId] = { status: 'done', log: jobs[upId].log, result: { url: 'https://youtu.be/' + d.id } };
    } catch(e) { log('Error: ' + e.message); jobs[upId] = { status: 'error', error: e.message, log: jobs[upId].log }; }
  })();
});

// ========== TROLL EDIT DRIVE (SCHEDULED) ==========
app.post('/api/run', async (req, res) => {
  const { videoFileId, phonkFileId, dropTime } = req.body;
  if (!videoFileId) return res.status(400).json({ error: 'videoFileId required' });
  const jobId = createJob(); res.json({ jobId });
  runTrollDrive(videoFileId, jobId, phonkFileId, parseFloat(dropTime) || 0);
});

async function runTrollDrive(videoFileId, jobId, overridePhonkId, overrideDropTime) {
  const fetch = (await import('node-fetch')).default;
  const cfg = loadCfg();
  jobs[jobId] = { status: 'running', log: [] }; const log = (m) => jlog(jobId, m);
  const drTok = await getDrive(); const ytTok = await getYT();
  if (!drTok) { jobs[jobId] = { status: 'error', error: 'Drive সংযুক্ত নয়', log: jobs[jobId].log }; return; }
  if (!ytTok) { jobs[jobId] = { status: 'error', error: 'YouTube সংযুক্ত নয়', log: jobs[jobId].log }; return; }
  if (!cfg.skullPath || !fs.existsSync(cfg.skullPath)) { jobs[jobId] = { status: 'error', error: 'Skull PNG নেই', log: jobs[jobId].log }; return; }
  const tmp = [];
  try {
    let phId = overridePhonkId, drop = overrideDropTime || 0;
    if (!phId) {
      const q = loadQ();
      let rem = (q.remainingPhonk || []).filter(n => cfg.phonkList.find(p => p.name === n));
      if (!rem.length) rem = cfg.phonkList.map(p => p.name);
      const name = rem.shift();
      saveQ({ ...q, remainingPhonk: rem, usedPhonk: [...(q.usedPhonk || []), name] });
      const info = cfg.phonkList.find(p => p.name === name) || cfg.phonkList[0];
      drop = parseFloat(info.dropTime) || 0;
      const aq = encodeURIComponent("'" + cfg.driveAudioFolderId + "' in parents and name='" + name.replace(/'/g, "\\'") + "' and trashed=false");
      const ar = await fetch('https://www.googleapis.com/drive/v3/files?q=' + aq + '&fields=files(id,name)&pageSize=5', { headers: { Authorization: 'Bearer ' + drTok } });
      const ad = await ar.json();
      if (!ad.files || !ad.files[0]) throw new Error('Phonk পাওয়া যায়নি: ' + name);
      phId = ad.files[0].id;
      log('Phonk: ' + name + ' | Drop: ' + drop + 's');
    }

    const vidP = path.join(TEMP_DIR, 'drv_' + jobId + '.mp4'); tmp.push(vidP);
    log('Video নামানো হচ্ছে...');
    const vr = await fetch('https://www.googleapis.com/drive/v3/files/' + videoFileId + '?alt=media', { headers: { Authorization: 'Bearer ' + drTok } });
    if (!vr.ok) throw new Error('Video download failed');
    fs.writeFileSync(vidP, Buffer.from(await vr.arrayBuffer()));

    const phP = path.join(TEMP_DIR, 'drph_' + jobId + '.mp3'); tmp.push(phP);
    log('Phonk নামানো হচ্ছে...');
    await dlPhonk(phId, phP);

    const { stdout: dout } = await execAsync('ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + vidP + '"');
    const dur = parseFloat(dout.trim());
    const fSec = Math.min(parseFloat(cfg.freezeSec) || 3, dur * 0.8);
    const fStart = Math.max(0.1, dur - fSec);
    log('Duration: ' + dur.toFixed(1) + 's | Freeze: ' + fSec.toFixed(1) + 's');

    const outP = path.join(TEMP_DIR, 'drout_' + jobId + '.mp4'); tmp.push(outP);
    const sc = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black';
    const txt = (cfg.textOverlay || '').replace(/[':]/g, '');
    const tT = parseFloat(cfg.textTime) || 2;
    let fc;
    if (txt) {
      fc = '[0:v]' + sc + '[s];[s]trim=end=' + fStart + ',setpts=PTS-STARTPTS[before];[0:v]' + sc + '[s2];[s2]trim=start=' + fStart + ',setpts=PTS-STARTPTS,select=\'eq(n\\,0)\',loop=loop=-1:size=1,trim=duration=' + fSec + '[frz];[frz]eq=brightness=-0.25:saturation=0.2:contrast=1.5[dark];[1:v]scale=280:280[sk];[dark][sk]overlay=(W-w)/2:(H-h)/2[wsk];[wsk]drawtext=text=\'' + txt + '\':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=h*0.15:enable=\'between(t\\,0\\,' + tT + ')\':box=1:boxcolor=black@0.5:boxborderw=8[wt];[before][wt]concat=n=2:v=1:a=0[outv];[2:a]atrim=start=' + drop + ',asetpts=PTS-STARTPTS,volume=1.5,atrim=end=' + dur + ',asetpts=PTS-STARTPTS[outa]';
    } else {
      fc = '[0:v]' + sc + '[s];[s]trim=end=' + fStart + ',setpts=PTS-STARTPTS[before];[0:v]' + sc + '[s2];[s2]trim=start=' + fStart + ',setpts=PTS-STARTPTS,select=\'eq(n\\,0)\',loop=loop=-1:size=1,trim=duration=' + fSec + '[frz];[frz]eq=brightness=-0.25:saturation=0.2:contrast=1.5[dark];[1:v]scale=280:280[sk];[dark][sk]overlay=(W-w)/2:(H-h)/2[wsk];[before][wsk]concat=n=2:v=1:a=0[outv];[2:a]atrim=start=' + drop + ',asetpts=PTS-STARTPTS,volume=1.5,atrim=end=' + dur + ',asetpts=PTS-STARTPTS[outa]';
    }
    log('ffmpeg চলছে...');
    await execAsync('ffmpeg -y -i "' + vidP + '" -i "' + cfg.skullPath + '" -i "' + phP + '" -filter_complex "' + fc + '" -map "[outv]" -map "[outa]" -c:v libx264 -preset ultrafast -crf 23 -threads 2 -c:a aac -shortest "' + outP + '"', { maxBuffer: 100*1024*1024, timeout: 600000 });
    log('Edit হয়েছে, upload হচ্ছে...');
    const yt = await ytUpload(outP, 'Troll Edit', '#shorts #viral #phonk #trolledit #skulledit', ['shorts','viral','phonk','troll edit']);
    tmp.forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
    log('আপলোড সফল: https://youtu.be/' + yt.id + ' ✓');
    jobs[jobId] = { status: 'done', log: jobs[jobId].log, result: { url: 'https://youtu.be/' + yt.id } };
  } catch(e) { tmp.forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} }); log('Error: ' + e.message); jobs[jobId] = { status: 'error', error: e.message, log: jobs[jobId].log }; }
}

// ========== MOVIE EDIT ==========
const PRESETS = {
  believer:    { b: -0.08, c: 1.5, s: 0.25, vig: true,  brd: true,  tone: 'cold' },
  dark_cinema: { b: -0.15, c: 1.4, s: 0.6,  vig: true,  brd: true,  tone: 'warm' },
  phonk_red:   { b: -0.05, c: 1.6, s: 0.8,  vig: true,  brd: true,  tone: 'red'  },
  cold_blue:   { b:  0.0,  c: 1.3, s: 0.5,  vig: false, brd: true,  tone: 'blue' },
  original:    { b:  0.0,  c: 1.0, s: 1.0,  vig: false, brd: false, tone: 'none' },
};
function colorFilter(preset) {
  const p = PRESETS[preset] || PRESETS.believer;
  const f = ['scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black'];
  if (p.brd) f.push('scale=960:1760,pad=1080:1920:60:80:black');
  f.push('eq=brightness=' + p.b + ':contrast=' + p.c + ':saturation=' + p.s);
  if (p.tone === 'cold') f.push('colorbalance=rs=-0.1:gs=-0.05:bs=0.15:rm=-0.1:gm=-0.05:bm=0.1');
  else if (p.tone === 'warm') f.push('colorbalance=rs=0.1:gs=0.05:bs=-0.1:rm=0.08:gm=0.03:bm=-0.08');
  else if (p.tone === 'red')  f.push('colorbalance=rs=0.2:gs=-0.1:bs=-0.1:rm=0.15:gm=-0.08:bm=-0.08');
  else if (p.tone === 'blue') f.push('colorbalance=rs=-0.15:gs=0:bs=0.2:rm=-0.1:gm=0:bm=0.15');
  if (p.vig) f.push('vignette=PI/4');
  return f.join(',');
}
function fmt(s) { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=Math.floor(s%60); return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0'); }

app.post('/api/movie/download', async (req, res) => {
  const { url } = req.body; if (!url) return res.status(400).json({ error: 'url required' });
  const jobId = createJob(); res.json({ jobId });
  (async () => {
    jobs[jobId] = { status: 'running', log: [] }; const log = (m) => jlog(jobId, m);
    const out = path.join(TEMP_DIR, 'mv_' + jobId + '.mp4');
    try {
      log('নামানো হচ্ছে (720p)...');
      await execAsync('yt-dlp -f "bestvideo[height<=720][ext=mp4]+bestaudio/best[height<=720]/best" --merge-output-format mp4 --no-playlist -o "' + out + '" "' + url + '"', { maxBuffer: 500*1024*1024, timeout: 1800000 });
      const { stdout } = await execAsync('ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + out + '"');
      const dur = parseFloat(stdout.trim());
      log('নামানো হয়েছে! ' + Math.floor(dur/60) + 'm ' + Math.floor(dur%60) + 's');
      jobs[jobId] = { status: 'done', log: jobs[jobId].log, result: { moviePath: out, duration: dur, jobId } };
    } catch(e) { try { if(fs.existsSync(out)) fs.unlinkSync(out); } catch {} log('Error: ' + e.message); jobs[jobId] = { status: 'error', error: e.message, log: jobs[jobId].log }; }
  })();
});

app.post('/api/movie/scenes', async (req, res) => {
  const { jobId, threshold } = req.body;
  const job = jobs[jobId];
  if (!job || !job.result || !job.result.moviePath) return res.status(404).json({ error: 'Movie not found' });
  const scId = createJob(); res.json({ jobId: scId });
  (async () => {
    jobs[scId] = { status: 'running', log: [] }; const log = (m) => jlog(scId, m);
    try {
      const thresh = parseFloat(threshold) || 0.35;
      const mp = job.result.moviePath, dur = job.result.duration;
      log('Scene খোঁজা হচ্ছে (thresh=' + thresh + ')...');
      const scOut = path.join(TEMP_DIR, 'sc_' + scId + '.txt');
      await execAsync('ffmpeg -i "' + mp + '" -vf "select=\'gt(scene,' + thresh + ')\',showinfo" -f null - 2>&1 | grep "pts_time:" | sed \'s/.*pts_time://; s/ //\' | head -80 > "' + scOut + '"', { maxBuffer: 50*1024*1024, timeout: 600000, shell: true });
      const txt = fs.existsSync(scOut) ? fs.readFileSync(scOut, 'utf8') : '';
      const times = [0, ...txt.trim().split('\n').filter(Boolean).map(t => parseFloat(t)).filter(t => !isNaN(t) && t > 0)];
      const scenes = [];
      for (let i = 0; i < times.length; i++) {
        const st = times[i], en = times[i+1] || Math.min(st + 60, dur), cd = en - st;
        if (cd >= 5 && cd <= 90) scenes.push({ index: scenes.length+1, start: parseFloat(st.toFixed(2)), end: parseFloat(en.toFixed(2)), duration: parseFloat(cd.toFixed(2)), startFmt: fmt(st), endFmt: fmt(en) });
      }
      try { fs.unlinkSync(scOut); } catch {}
      log(scenes.length + ' টি scene পাওয়া গেছে ✓');
      jobs[scId] = { status: 'done', log: jobs[scId].log, result: { scenes, movieJobId: jobId } };
    } catch(e) { log('Error: ' + e.message); jobs[scId] = { status: 'error', error: e.message, log: jobs[scId].log }; }
  })();
});

app.post('/api/movie/process', async (req, res) => {
  const { movieJobId, colorPreset, phonkFileId, dropTime, phonkVolume, origVolume, watermark, customStart, customEnd } = req.body;
  if (!movieJobId) return res.status(400).json({ error: 'movieJobId required' });
  const job = jobs[movieJobId];
  if (!job || !job.result || !job.result.moviePath) return res.status(404).json({ error: 'Movie not found' });
  const pId = createJob(); res.json({ jobId: pId });
  (async () => {
    jobs[pId] = { status: 'running', log: [] }; const log = (m) => jlog(pId, m);
    const tmp = [];
    try {
      const mp = job.result.moviePath;
      const cs = parseFloat(customStart) || 0, ce = parseFloat(customEnd) || (cs + 30), cd = Math.max(1, ce - cs);
      const clipP = path.join(TEMP_DIR, 'clip_' + pId + '.mp4'); tmp.push(clipP);
      log('Clip cut: ' + fmt(cs) + ' → ' + fmt(ce) + ' (' + cd.toFixed(1) + 's)');
      await execAsync('ffmpeg -y -ss ' + cs + ' -i "' + mp + '" -t ' + cd + ' -c copy "' + clipP + '"', { maxBuffer: 50*1024*1024, timeout: 120000 });

      // Whisper subtitle
      const srtP = path.join(TEMP_DIR, 'sub_' + pId + '.srt');
      log('Whisper subtitle তৈরি হচ্ছে...');
      try {
        await execAsync('whisper "' + clipP + '" --model small --language auto --output_format srt --output_dir "' + TEMP_DIR + '" 2>&1', { maxBuffer: 100*1024*1024, timeout: 300000 });
        const bn = path.basename(clipP, path.extname(clipP));
        const wo = path.join(TEMP_DIR, bn + '.srt');
        if (fs.existsSync(wo)) { fs.renameSync(wo, srtP); log('Subtitle তৈরি ✓'); }
        else log('Subtitle skip');
      } catch(e) { log('Whisper skip: ' + e.message.slice(0, 80)); }

      // Phonk
      let phP = null;
      if (phonkFileId) {
        phP = path.join(TEMP_DIR, 'mvph_' + pId + '.mp3'); tmp.push(phP);
        log('Phonk নামানো হচ্ছে...');
        await dlPhonk(phonkFileId, phP); log('Phonk ✓');
      }

      const oVol = parseFloat(origVolume) || 0.7, pVol = parseFloat(phonkVolume) || 1.2, dp = parseFloat(dropTime) || 0;
      const wm = (watermark || '').replace(/[':]/g, '');
      let vf = colorFilter(colorPreset || 'believer');
      if (fs.existsSync(srtP)) {
        const es = srtP.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
        vf += ',subtitles=\'' + es + '\':force_style=\'FontName=Impact,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2,MarginV=80\'';
      }
      if (wm) vf += ',drawtext=text=\'' + wm + '\':fontcolor=red:fontsize=13:x=(w-text_w)/2:y=h-45:bold=1:alpha=0.85';

      const outP = path.join(TEMP_DIR, 'mvout_' + pId + '.mp4');
      log('ffmpeg processing...');
      if (phP) {
        await execAsync('ffmpeg -y -i "' + clipP + '" -i "' + phP + '" -filter_complex "[0:v]' + vf + '[outv];[0:a]volume=' + oVol + '[oa];[1:a]atrim=start=' + dp + ',asetpts=PTS-STARTPTS,volume=' + pVol + ',atrim=end=' + cd + ',asetpts=PTS-STARTPTS[pa];[oa][pa]amix=inputs=2:duration=first[outa]" -map "[outv]" -map "[outa]" -c:v libx264 -preset ultrafast -crf 22 -threads 2 -c:a aac -shortest "' + outP + '"', { maxBuffer: 100*1024*1024, timeout: 600000 });
      } else {
        await execAsync('ffmpeg -y -i "' + clipP + '" -filter_complex "[0:v]' + vf + '[outv];[0:a]volume=' + oVol + '[outa]" -map "[outv]" -map "[outa]" -c:v libx264 -preset ultrafast -crf 22 -threads 2 -c:a aac "' + outP + '"', { maxBuffer: 100*1024*1024, timeout: 600000 });
      }
      tmp.forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
      try { if(fs.existsSync(srtP)) fs.unlinkSync(srtP); } catch {}
      log('সম্পন্ন! Preview দেখুন ✓');
      jobs[pId] = { status: 'preview', log: jobs[pId].log, result: { previewUrl: '/temp/mvout_' + pId + '.mp4', outPath: outP, procJobId: pId } };
    } catch(e) { tmp.forEach(f => { try { if(fs.existsSync(f)) fs.unlinkSync(f); } catch {} }); log('Error: ' + e.message); jobs[pId] = { status: 'error', error: e.message, log: jobs[pId].log }; }
  })();
});

app.post('/api/movie/upload', async (req, res) => {
  const { procJobId, caption, description } = req.body;
  const job = jobs[procJobId];
  if (!job || !job.result || !job.result.outPath) return res.status(404).json({ error: 'not found' });
  const upId = createJob(); res.json({ jobId: upId });
  (async () => {
    jobs[upId] = { status: 'running', log: [] }; const log = (m) => jlog(upId, m);
    try {
      const d = await ytUpload(job.result.outPath, caption || 'Movie Edit 🤯🔥', description || '#shorts #viral #movieedit #cinematic', ['shorts','viral','movie edit','cinematic']);
      try { fs.unlinkSync(job.result.outPath); } catch {}
      log('আপলোড সফল: https://youtu.be/' + d.id + ' ✓');
      jobs[upId] = { status: 'done', log: jobs[upId].log, result: { url: 'https://youtu.be/' + d.id } };
    } catch(e) { log('Error: ' + e.message); jobs[upId] = { status: 'error', error: e.message, log: jobs[upId].log }; }
  })();
});

// ========== SCHEDULER ==========
function startScheduler() {
  setInterval(async () => {
    try {
      const cfg = loadCfg(); if (!cfg.enabled) return;
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
      const day = ['sun','mon','tue','wed','thu','fri','sat'][now.getDay()];
      const time = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
      if (!(cfg.scheduleDays || []).includes(day) || time !== cfg.scheduleTime) return;
      const fetch = (await import('node-fetch')).default;
      const tok = await getDrive(); if (!tok) return;
      const q = encodeURIComponent("'" + cfg.driveFolderId + "' in parents and mimeType contains 'video/' and trashed=false");
      const r = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name)&pageSize=100', { headers: { Authorization: 'Bearer ' + tok } });
      const vids = (await r.json()).files || []; if (!vids.length) return;
      const queue = loadQ();
      let rem = (queue.remainingVideos || []).filter(id => vids.find(v => v.id === id));
      if (!rem.length) rem = vids.map(v => v.id).sort(() => Math.random() - 0.5);
      const next = rem.shift();
      saveQ({ ...loadQ(), remainingVideos: rem, usedVideos: [...(queue.usedVideos || []), next] });
      const jId = createJob();
      runTrollDrive(next, jId, null, 0).catch(e => console.error('[SCHED]', e.message));
    } catch(e) { console.error('[SCHED]', e.message); }
  }, 60000);
}
startScheduler();

// ========== SSE ==========
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const orig = console.log.bind(console);
  console.log = (...a) => { orig(...a); res.write('data: ' + JSON.stringify({ msg: a.join(' ') }) + '\n\n'); };
  req.on('close', () => { console.log = orig; });
});

app.listen(PORT, () => console.log('Troll Edit Pro on port ' + PORT));
