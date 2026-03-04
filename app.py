import os, json, uuid, zipfile, random, subprocess
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_file, session, redirect
from apscheduler.schedulers.background import BackgroundScheduler
import google.generativeai as genai
import yt_dlp, requests
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
import google.auth.transport.requests

app = Flask(__name__)
app.secret_key = os.environ.get("SESSION_SECRET", "yt-shorts-2024")

UPLOAD_FOLDER = Path("uploads")
OUTPUT_FOLDER = Path("outputs")
UPLOAD_FOLDER.mkdir(exist_ok=True)
OUTPUT_FOLDER.mkdir(exist_ok=True)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
YT_CLIENT_ID = os.environ.get("YOUTUBE_CLIENT_ID", "")
YT_CLIENT_SECRET = os.environ.get("YOUTUBE_CLIENT_SECRET", "")

# cookies.txt — env variable থেকে তৈরি করা হবে
COOKIES_PATH = Path("cookies.txt")
YT_COOKIES = os.environ.get("YT_COOKIES", "")
if YT_COOKIES and not COOKIES_PATH.exists():
    COOKIES_PATH.write_text(YT_COOKIES)

scheduler = BackgroundScheduler(timezone="Asia/Dhaka")
scheduler.start()
scheduled_jobs = {}

# ── Gemini ──────────────────────────────────────────────────────────────────

def get_gemini():
    key = session.get("gemini_key") or GEMINI_API_KEY
    if not key: return None
    genai.configure(api_key=key)
    return genai.GenerativeModel("gemini-1.5-flash")

def default_meta(ctx=""):
    return {
        "title": f"🔥 {ctx[:50] or 'Amazing Short'}",
        "description": "Watch this incredible video! Subscribe for more. Like & Share!",
        "hashtags": ["#shorts","#viral","#trending","#fyp","#youtube"],
        "tags": ["shorts","viral","trending","youtube","amazing"],
        "caption": "Watch till the end! 🔥"
    }

def ai_full_metadata(video_title="", hook=""):
    model = get_gemini()
    if not model: return default_meta(video_title or hook)
    context = hook or video_title or "YouTube Short"
    prompt = f"""Viral YouTube Shorts expert. Generate metadata for: "{context}"
Return ONLY valid JSON no markdown:
{{"title":"catchy title with emoji max 60 chars","description":"2-3 sentence engaging description with CTA","hashtags":["#shorts","#viral","#trending","#fyp","#youtube","#tag1","#tag2"],"tags":["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8"],"caption":"punchy 5-7 word caption for video"}}"""
    try:
        resp = model.generate_content(prompt)
        text = resp.text.strip()
        if "```" in text:
            text = text.split("```")[1]
            if text.startswith("json"): text = text[4:]
        return json.loads(text.strip())
    except:
        return default_meta(context)

# ── Helpers ──────────────────────────────────────────────────────────────────

def run_ffmpeg(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode == 0, r.stderr

def time_to_sec(t):
    parts = [int(x) for x in t.strip().split(":")]
    if len(parts) == 2: return parts[0]*60+parts[1]
    if len(parts) == 3: return parts[0]*3600+parts[1]*60+parts[2]
    return int(parts[0])

def find_video(vid_id):
    for f in UPLOAD_FOLDER.iterdir():
        if f.stem.startswith(vid_id): return f
    return None

def get_duration(path):
    r = subprocess.run(["ffprobe","-v","quiet","-print_format","json","-show_streams",str(path)], capture_output=True, text=True)
    try:
        for s in json.loads(r.stdout).get("streams",[]):
            if s.get("codec_type")=="video": return float(s.get("duration",0))
    except: pass
    return 0

# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html",
        yt_connected=bool(session.get("yt_credentials")),
        gemini_key=session.get("gemini_key", GEMINI_API_KEY),
        drive_folder=session.get("drive_folder", os.environ.get("DRIVE_FOLDER_ID",""))
    )

@app.route("/save_settings", methods=["POST"])
def save_settings():
    d = request.json
    if d.get("gemini_key"): session["gemini_key"] = d["gemini_key"]
    if d.get("drive_folder"): session["drive_folder"] = d["drive_folder"]
    return jsonify({"status":"saved"})

# ── Download ──────────────────────────────────────────────────────────────────

@app.route("/download_video", methods=["POST"])
def download_video():
    url = request.json.get("url","").strip()
    if not url: return jsonify({"error":"URL দেওয়া হয়নি"}), 400
    vid_id = str(uuid.uuid4())[:8]
    ydl_opts = {
        "format": "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "outtmpl": str(UPLOAD_FOLDER / f"{vid_id}.%(ext)s"),
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "extractor_args": {"youtube": {"player_client": ["web","mweb"]}},
        "http_headers": {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"}
    }
    if COOKIES_PATH.exists(): ydl_opts["cookiefile"] = str(COOKIES_PATH)
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title","video")
            duration = info.get("duration",0)
        actual = find_video(vid_id)
        if not actual: return jsonify({"error":"ডাউনলোড হয়নি"}), 500
        return jsonify({"status":"ok","video_id":vid_id,"title":title,"duration":duration})
    except Exception as e:
        return jsonify({"error":str(e)}), 500

# ── AI Segments ───────────────────────────────────────────────────────────────

@app.route("/ai_segments", methods=["POST"])
def ai_segments():
    data = request.json
    vid_id = data.get("video_id")
    count = int(data.get("count", 3))
    title = data.get("title","")
    video_file = find_video(vid_id)
    if not video_file: return jsonify({"error":"ভিডিও পাওয়া যায়নি"}), 404
    duration = get_duration(video_file)
    model = get_gemini()
    if not model: return jsonify({"error":"Gemini API Key সেট করুন"}), 400
    prompt = f"""YouTube Shorts expert. Video: "{title}", duration: {int(duration)}s.
Find exactly {count} most viral segments (30-60s each). Return ONLY JSON array:
[{{"start":"MM:SS","end":"MM:SS","reason":"why viral","hook":"caption text"}}]"""
    try:
        resp = model.generate_content(prompt)
        text = resp.text.strip()
        if "```" in text:
            text = text.split("```")[1]
            if text.startswith("json"): text = text[4:]
        segments = json.loads(text.strip())
        return jsonify({"segments":segments,"duration":duration})
    except:
        step = duration/(count+1)
        segs = []
        for i in range(count):
            s = int(step*(i+0.5))
            e = min(s+55, int(duration))
            segs.append({"start":f"{s//60:02d}:{s%60:02d}","end":f"{e//60:02d}:{e%60:02d}","reason":f"Segment {i+1}","hook":"Watch this! 🔥"})
        return jsonify({"segments":segs,"duration":duration})

# ── Crop + Auto Metadata ──────────────────────────────────────────────────────

@app.route("/crop_video", methods=["POST"])
def crop_video():
    data = request.json
    vid_id = data.get("video_id")
    start = data.get("start","0:00")
    end = data.get("end","1:00")
    hook = data.get("hook","")
    video_title = data.get("video_title","")

    video_file = find_video(vid_id)
    if not video_file: return jsonify({"error":"ভিডিও পাওয়া যায়নি"}), 404

    start_sec = time_to_sec(start)
    end_sec = time_to_sec(end)
    duration = end_sec - start_sec
    if duration <= 0: return jsonify({"error":"End time must be after start time"}), 400
    if duration > 180: return jsonify({"error":"ক্লিপ ১৮০ সেকেন্ডের বেশি হবে না"}), 400

    # AI Metadata
    meta = ai_full_metadata(video_title=video_title, hook=hook)
    caption = meta.get("caption", hook or "Watch till the end! 🔥")
    safe_cap = caption.replace("'","").replace(":","").replace("\\","")[:60]

    out_id = str(uuid.uuid4())[:8]
    out_path = OUTPUT_FOLDER / f"short_{out_id}.mp4"

    vf = (
        f"trim=start={start_sec}:end={end_sec},setpts=PTS-STARTPTS,"
        f"scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
        f"drawtext=text='{safe_cap}':fontsize=52:fontcolor=white:bordercolor=black:borderw=4:"
        f"x=(w-text_w)/2:y=h-200:box=1:boxcolor=black@0.55:boxborderw=12"
    )
    cmd = [
        "ffmpeg","-y","-i",str(video_file),
        "-vf", vf,
        "-af", f"atrim=start={start_sec}:end={end_sec},asetpts=PTS-STARTPTS",
        "-c:v","libx264","-preset","fast","-crf","22",
        "-c:a","aac","-b:a","128k",
        "-t",str(duration),"-movflags","+faststart",
        str(out_path)
    ]
    ok, err = run_ffmpeg(cmd)
    if not ok or not out_path.exists():
        return jsonify({"error":f"FFmpeg ত্রুটি: {err[:300]}"}), 500

    return jsonify({
        "status":"ok","clip_id":out_id,
        "filename":out_path.name,
        "preview_url":f"/preview/{out_path.name}",
        "metadata":meta
    })

# ── Preview / Download ────────────────────────────────────────────────────────

@app.route("/preview/<filename>")
def preview(filename):
    path = OUTPUT_FOLDER / filename
    if not path.exists(): return "Not found", 404
    return send_file(path, mimetype="video/mp4")

@app.route("/download_clip/<filename>")
def download_clip(filename):
    path = OUTPUT_FOLDER / filename
    if not path.exists(): return "Not found", 404
    return send_file(path, as_attachment=True, download_name=filename)

@app.route("/list_clips")
def list_clips():
    clips = []
    for f in sorted(OUTPUT_FOLDER.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if f.suffix == ".mp4":
            clips.append({"filename":f.name,"size_mb":round(f.stat().st_size/1e6,2)})
    return jsonify({"clips":clips})

# ── YouTube OAuth ─────────────────────────────────────────────────────────────

def get_yt_flow():
    redir = request.host_url.rstrip("/")+"/yt_callback"
    cfg = {"web":{"client_id":YT_CLIENT_ID,"client_secret":YT_CLIENT_SECRET,
        "auth_uri":"https://accounts.google.com/o/oauth2/auth",
        "token_uri":"https://oauth2.googleapis.com/token","redirect_uris":[redir]}}
    return Flow.from_client_config(cfg,
        scopes=["https://www.googleapis.com/auth/youtube.upload","https://www.googleapis.com/auth/youtube"],
        redirect_uri=redir)

@app.route("/yt_connect")
def yt_connect():
    try:
        flow = get_yt_flow()
        auth_url, state = flow.authorization_url(access_type="offline")
        session["oauth_state"] = state
        return redirect(auth_url)
    except Exception as e: return f"OAuth error: {e}", 500

@app.route("/yt_callback")
def yt_callback():
    try:
        flow = get_yt_flow()
        flow.fetch_token(authorization_response=request.url)
        c = flow.credentials
        session["yt_credentials"] = {"token":c.token,"refresh_token":c.refresh_token,
            "token_uri":c.token_uri,"client_id":c.client_id,"client_secret":c.client_secret,
            "scopes":list(c.scopes) if c.scopes else []}
        return redirect("/")
    except Exception as e: return f"Callback error: {e}", 500

@app.route("/yt_disconnect")
def yt_disconnect():
    session.pop("yt_credentials", None)
    return redirect("/")

# ── Upload ────────────────────────────────────────────────────────────────────

def do_upload(clip_filename, title, description, hashtags, tags):
    cd = session.get("yt_credentials")
    if not cd: return False, "YouTube সংযুক্ত নেই"
    creds = Credentials(token=cd["token"],refresh_token=cd["refresh_token"],
        token_uri=cd["token_uri"],client_id=cd["client_id"],client_secret=cd["client_secret"],scopes=cd["scopes"])
    if creds.expired and creds.refresh_token:
        creds.refresh(google.auth.transport.requests.Request())
        session["yt_credentials"]["token"] = creds.token
    clip_path = OUTPUT_FOLDER / clip_filename
    if not clip_path.exists(): return False, "ক্লিপ ফাইল নেই"
    yt = build("youtube","v3",credentials=creds)
    all_tags = list(set(tags+[h.lstrip("#") for h in hashtags]))
    body = {
        "snippet":{"title":title,"description":description+"\n\n"+" ".join(hashtags),"tags":all_tags,"categoryId":"22"},
        "status":{"privacyStatus":"public","selfDeclaredMadeForKids":False}
    }
    try:
        media = MediaFileUpload(str(clip_path), mimetype="video/mp4", resumable=True, chunksize=1024*1024*5)
        req = yt.videos().insert(part="snippet,status",body=body,media_body=media)
        response = None
        while response is None: _, response = req.next_chunk()
        vid_id = response["id"]
        clip_path.unlink(missing_ok=True)
        return True, f"https://youtube.com/shorts/{vid_id}"
    except Exception as e: return False, str(e)

@app.route("/upload_clip", methods=["POST"])
def upload_clip():
    d = request.json
    ok, result = do_upload(d.get("filename"), d.get("title","My Short 🔥"),
        d.get("description",""), d.get("hashtags",["#shorts"]), d.get("tags",[]))
    if ok: return jsonify({"status":"uploaded","url":result})
    return jsonify({"error":result}), 500

# ── Drive ─────────────────────────────────────────────────────────────────────

@app.route("/drive_fetch", methods=["POST"])
def drive_fetch():
    folder_url = request.json.get("folder_url") or session.get("drive_folder","")
    if not folder_url: return jsonify({"error":"Drive folder URL দিন"}), 400
    folder_id = folder_url.split("folders/")[-1].split("?")[0] if "folders/" in folder_url else folder_url
    api_key = session.get("gemini_key") or GEMINI_API_KEY
    try:
        resp = requests.get(f"https://www.googleapis.com/drive/v3/files?q='{folder_id}'+in+parents&key={api_key}&fields=files(id,name)", timeout=15)
        files = resp.json().get("files",[])
        zips = [f for f in files if f["name"].endswith(".zip")]
        if not zips: return jsonify({"error":"ZIP ফাইল পাওয়া যায়নি"}), 404
        chosen = random.choice(zips)
        zip_path = UPLOAD_FOLDER / f"drv_{chosen['id'][:8]}.zip"
        r = requests.get(f"https://drive.google.com/uc?export=download&id={chosen['id']}&confirm=t", stream=True, timeout=120)
        with open(zip_path,"wb") as f:
            for chunk in r.iter_content(8192): f.write(chunk)
        with zipfile.ZipFile(zip_path,"r") as zf:
            vids = [n for n in zf.namelist() if n.lower().endswith((".mp4",".mov",".avi",".mkv"))]
            if not vids: return jsonify({"error":"ZIP-এ ভিডিও নেই"}), 404
            cv = random.choice(vids)
            vid_id = str(uuid.uuid4())[:8]
            with zf.open(cv) as src, open(UPLOAD_FOLDER/f"{vid_id}.mp4","wb") as dst: dst.write(src.read())
        zip_path.unlink(missing_ok=True)
        return jsonify({"status":"ok","video_id":vid_id,"source":cv})
    except Exception as e: return jsonify({"error":str(e)}), 500

# ── Schedule ──────────────────────────────────────────────────────────────────

@app.route("/schedule_upload", methods=["POST"])
def schedule_upload():
    data = request.json
    hour = int(data.get("hour",12))
    minute = int(data.get("minute",0))
    drive_folder = data.get("drive_folder") or session.get("drive_folder","")
    job_id = f"auto_{hour}_{minute}"
    creds_data = session.get("yt_credentials")
    gemini_key = session.get("gemini_key") or GEMINI_API_KEY

    if job_id in scheduled_jobs:
        try: scheduler.remove_job(job_id)
        except: pass

    def auto_task():
        try:
            folder_id = drive_folder.split("folders/")[-1].split("?")[0] if "folders/" in drive_folder else drive_folder
            resp = requests.get(f"https://www.googleapis.com/drive/v3/files?q='{folder_id}'+in+parents&key={gemini_key}&fields=files(id,name)", timeout=15)
            files = resp.json().get("files",[])
            zips = [f for f in files if f["name"].endswith(".zip")]
            if not zips: return
            chosen = random.choice(zips)
            zip_path = UPLOAD_FOLDER / f"auto_{chosen['id'][:8]}.zip"
            r = requests.get(f"https://drive.google.com/uc?export=download&id={chosen['id']}&confirm=t", stream=True, timeout=120)
            with open(zip_path,"wb") as f:
                for chunk in r.iter_content(8192): f.write(chunk)
            with zipfile.ZipFile(zip_path,"r") as zf:
                vids = [n for n in zf.namelist() if n.lower().endswith((".mp4",".mov",".avi"))]
                if not vids: return
                cv = random.choice(vids)
                vid_id = str(uuid.uuid4())[:8]
                with zf.open(cv) as src, open(UPLOAD_FOLDER/f"{vid_id}.mp4","wb") as dst: dst.write(src.read())
            zip_path.unlink(missing_ok=True)
            video_file = UPLOAD_FOLDER/f"{vid_id}.mp4"
            dur = get_duration(video_file)
            s = max(0, int(dur/2)-27)
            e = min(int(dur), s+55)
            genai.configure(api_key=gemini_key)
            meta = default_meta(cv)
            try:
                m = genai.GenerativeModel("gemini-1.5-flash")
                p = f'YouTube Shorts metadata for "{cv}". JSON only: {{"title":"...","description":"...","hashtags":["#shorts"],"tags":["tag1"],"caption":"..."}}'
                resp2 = m.generate_content(p)
                t = resp2.text.strip()
                if "```" in t:
                    t = t.split("```")[1]
                    if t.startswith("json"): t = t[4:]
                meta = json.loads(t.strip())
            except: pass
            safe_cap = meta.get("caption","Watch till the end! 🔥").replace("'","").replace(":","")[:60]
            out_id = str(uuid.uuid4())[:8]
            out_path = OUTPUT_FOLDER/f"auto_{out_id}.mp4"
            vf = (f"trim=start={s}:end={e},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
                  f"drawtext=text='{safe_cap}':fontsize=52:fontcolor=white:bordercolor=black:borderw=4:x=(w-text_w)/2:y=h-200:box=1:boxcolor=black@0.55:boxborderw=12")
            subprocess.run(["ffmpeg","-y","-i",str(video_file),"-vf",vf,"-af",f"atrim=start={s}:end={e},asetpts=PTS-STARTPTS",
                "-c:v","libx264","-preset","fast","-crf","22","-c:a","aac","-b:a","128k","-movflags","+faststart",str(out_path)], capture_output=True)
            video_file.unlink(missing_ok=True)
            if not out_path.exists() or not creds_data: return
            creds = Credentials(token=creds_data["token"],refresh_token=creds_data["refresh_token"],
                token_uri=creds_data["token_uri"],client_id=creds_data["client_id"],client_secret=creds_data["client_secret"],scopes=creds_data["scopes"])
            if creds.expired and creds.refresh_token: creds.refresh(google.auth.transport.requests.Request())
            yt = build("youtube","v3",credentials=creds)
            all_tags = list(set(meta.get("tags",[])+[h.lstrip("#") for h in meta.get("hashtags",[])]))
            body = {"snippet":{"title":meta.get("title","Amazing Short 🔥"),"description":meta.get("description","")+"\n\n"+" ".join(meta.get("hashtags",[])),"tags":all_tags,"categoryId":"22"},
                "status":{"privacyStatus":"public","selfDeclaredMadeForKids":False}}
            media = MediaFileUpload(str(out_path), mimetype="video/mp4", resumable=True)
            req = yt.videos().insert(part="snippet,status",body=body,media_body=media)
            response = None
            while response is None: _, response = req.next_chunk()
            out_path.unlink(missing_ok=True)
        except Exception as ex: print(f"Auto task error: {ex}")

    scheduler.add_job(auto_task,"cron",hour=hour,minute=minute,id=job_id)
    scheduled_jobs[job_id] = {"hour":hour,"minute":minute,"id":job_id}
    return jsonify({"status":"scheduled","time":f"{hour:02d}:{minute:02d}"})

@app.route("/delete_schedule", methods=["POST"])
def delete_schedule():
    job_id = request.json.get("job_id")
    try: scheduler.remove_job(job_id)
    except: pass
    scheduled_jobs.pop(job_id, None)
    return jsonify({"status":"deleted"})

@app.route("/list_schedules")
def list_schedules():
    return jsonify({"schedules":list(scheduled_jobs.values())})

if __name__ == "__main__":
    port = int(os.environ.get("PORT",5000))
    app.run(host="0.0.0.0", port=port, debug=False)
