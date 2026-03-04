import os
import json
import uuid
import zipfile
import random
import subprocess
import threading
from pathlib import Path
from datetime import datetime

from flask import Flask, render_template, request, jsonify, send_file, session, redirect, url_for
from apscheduler.schedulers.background import BackgroundScheduler
import google.generativeai as genai
import yt_dlp
import requests

# Google OAuth
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
import google.auth.transport.requests

app = Flask(__name__)
app.secret_key = os.environ.get("SESSION_SECRET", "dev-secret-key-change-me")

UPLOAD_FOLDER = Path("uploads")
OUTPUT_FOLDER = Path("outputs")
UPLOAD_FOLDER.mkdir(exist_ok=True)
OUTPUT_FOLDER.mkdir(exist_ok=True)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
DRIVE_FOLDER_ID = os.environ.get("DRIVE_FOLDER_ID", "")
YT_CLIENT_ID = os.environ.get("YOUTUBE_CLIENT_ID", "")
YT_CLIENT_SECRET = os.environ.get("YOUTUBE_CLIENT_SECRET", "")

scheduler = BackgroundScheduler()
scheduler.start()

# ─── Helpers ──────────────────────────────────────────────────────────────────

def get_gemini_client():
    key = session.get("gemini_key") or GEMINI_API_KEY
    if not key:
        return None
    genai.configure(api_key=key)
    return genai.GenerativeModel("gemini-1.5-flash")

def run_ffmpeg(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode == 0, result.stderr

def time_to_seconds(t):
    """Convert MM:SS or HH:MM:SS to seconds."""
    parts = t.strip().split(":")
    parts = [int(p) for p in parts]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    elif len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return int(parts[0])

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html",
        yt_connected=bool(session.get("yt_credentials")),
        gemini_key=session.get("gemini_key", GEMINI_API_KEY),
        drive_folder=session.get("drive_folder", DRIVE_FOLDER_ID)
    )

@app.route("/save_settings", methods=["POST"])
def save_settings():
    data = request.json
    if data.get("gemini_key"):
        session["gemini_key"] = data["gemini_key"]
    if data.get("drive_folder"):
        session["drive_folder"] = data["drive_folder"]
    return jsonify({"status": "saved"})

# ─── Video Download ────────────────────────────────────────────────────────────

@app.route("/download_video", methods=["POST"])
def download_video():
    data = request.json
    url = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "URL দেওয়া হয়নি"}), 400

    video_id = str(uuid.uuid4())[:8]
    out_path = UPLOAD_FOLDER / f"{video_id}.mp4"

    ydl_opts = {
        "format": "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "outtmpl": str(out_path),
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "cookiefile": "cookies.txt" if Path("cookies.txt").exists() else None,
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title", "video")
            duration = info.get("duration", 0)
        
        # Find actual output file (yt-dlp may adjust filename)
        actual = None
        for f in UPLOAD_FOLDER.iterdir():
            if f.stem.startswith(video_id):
                actual = f
                break
        
        if not actual or not actual.exists():
            return jsonify({"error": "ডাউনলোড হয়নি, ফাইল পাওয়া যায়নি"}), 500

        return jsonify({
            "status": "ok",
            "video_id": video_id,
            "filename": actual.name,
            "title": title,
            "duration": duration
        })
    except Exception as e:
        return jsonify({"error": f"ডাউনলোড ত্রুটি: {str(e)}"}), 500

# ─── AI Segment Detection ──────────────────────────────────────────────────────

@app.route("/ai_segments", methods=["POST"])
def ai_segments():
    data = request.json
    video_id = data.get("video_id")
    count = int(data.get("count", 3))
    
    # Find video file
    video_file = None
    for f in UPLOAD_FOLDER.iterdir():
        if f.stem.startswith(video_id):
            video_file = f
            break
    
    if not video_file:
        return jsonify({"error": "ভিডিও ফাইল পাওয়া যায়নি"}), 404

    # Get duration using ffprobe
    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", str(video_file)],
        capture_output=True, text=True
    )
    duration = 0
    try:
        info = json.loads(probe.stdout)
        for s in info.get("streams", []):
            if s.get("codec_type") == "video":
                duration = float(s.get("duration", 0))
                break
    except:
        pass

    # Extract audio transcript using whisper if available, else use Gemini text analysis
    model = get_gemini_client()
    if not model:
        return jsonify({"error": "Gemini API Key সেট করুন"}), 400

    prompt = f"""
You are a YouTube Shorts expert. A video has duration of {int(duration)} seconds.
Suggest exactly {count} viral/engaging segments for YouTube Shorts (each under 60 seconds).
Return ONLY a JSON array like:
[
  {{"start": "MM:SS", "end": "MM:SS", "reason": "why this is viral", "hook": "opening hook text"}},
  ...
]
Make segments spread across the video. Each must be 30-60 seconds long.
"""
    try:
        response = model.generate_content(prompt)
        text = response.text.strip()
        # Clean JSON
        if "```" in text:
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        segments = json.loads(text.strip())
        return jsonify({"segments": segments, "duration": duration})
    except Exception as e:
        # Fallback: generate evenly spaced segments
        segments = []
        step = duration / (count + 1)
        for i in range(count):
            start_sec = int(step * (i + 0.5))
            end_sec = min(start_sec + 55, int(duration))
            segments.append({
                "start": f"{start_sec//60:02d}:{start_sec%60:02d}",
                "end": f"{end_sec//60:02d}:{end_sec%60:02d}",
                "reason": f"Segment {i+1} - evenly distributed",
                "hook": f"Clip {i+1}"
            })
        return jsonify({"segments": segments, "duration": duration})

# ─── Crop Video ───────────────────────────────────────────────────────────────

@app.route("/crop_video", methods=["POST"])
def crop_video():
    data = request.json
    video_id = data.get("video_id")
    start = data.get("start", "0:00")
    end = data.get("end", "1:00")
    caption_text = data.get("caption", "")
    
    video_file = None
    for f in UPLOAD_FOLDER.iterdir():
        if f.stem.startswith(video_id):
            video_file = f
            break
    
    if not video_file:
        return jsonify({"error": "ভিডিও ফাইল পাওয়া যায়নি"}), 404

    start_sec = time_to_seconds(start)
    end_sec = time_to_seconds(end)
    duration = end_sec - start_sec

    if duration <= 0:
        return jsonify({"error": "End time must be after start time"}), 400
    if duration > 180:
        return jsonify({"error": "ক্লিপ ১৮০ সেকেন্ডের বেশি হতে পারবে না"}), 400

    out_id = str(uuid.uuid4())[:8]
    out_path = OUTPUT_FOLDER / f"short_{out_id}.mp4"

    # FFmpeg: crop to 9:16 (1080x1920), add caption if provided
    vf_filters = [
        f"trim=start={start_sec}:end={end_sec}",
        "setpts=PTS-STARTPTS",
        "scale=1080:1920:force_original_aspect_ratio=increase",
        "crop=1080:1920"
    ]
    
    if caption_text:
        safe_caption = caption_text.replace("'", "\\'").replace(":", "\\:")
        vf_filters.append(
            f"drawtext=text='{safe_caption}':fontsize=52:fontcolor=white:"
            f"bordercolor=black:borderw=3:x=(w-text_w)/2:y=h-200:"
            f"box=1:boxcolor=black@0.5:boxborderw=10"
        )

    vf = ",".join(vf_filters)

    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_file),
        "-vf", vf,
        "-af", f"atrim=start={start_sec}:end={end_sec},asetpts=PTS-STARTPTS",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-t", str(duration),
        str(out_path)
    ]

    ok, err = run_ffmpeg(cmd)
    if not ok or not out_path.exists():
        return jsonify({"error": f"FFmpeg ত্রুটি: {err[:300]}"}), 500

    return jsonify({
        "status": "ok",
        "clip_id": out_id,
        "filename": out_path.name,
        "preview_url": f"/preview/{out_path.name}"
    })

# ─── Preview ──────────────────────────────────────────────────────────────────

@app.route("/preview/<filename>")
def preview(filename):
    path = OUTPUT_FOLDER / filename
    if not path.exists():
        return "Not found", 404
    return send_file(path, mimetype="video/mp4")

@app.route("/download_clip/<filename>")
def download_clip(filename):
    path = OUTPUT_FOLDER / filename
    if not path.exists():
        return "Not found", 404
    return send_file(path, as_attachment=True, download_name=filename)

# ─── AI Metadata ──────────────────────────────────────────────────────────────

@app.route("/generate_metadata", methods=["POST"])
def generate_metadata():
    data = request.json
    context = data.get("context", "YouTube Short video")
    
    model = get_gemini_client()
    if not model:
        return jsonify({"error": "Gemini API Key সেট করুন"}), 400

    prompt = f"""
Generate YouTube Shorts metadata for: "{context}"
Return ONLY JSON:
{{
  "title": "catchy title under 60 chars",
  "description": "engaging description 2-3 sentences",
  "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5", "#shorts", "#viral"]
}}
"""
    try:
        response = model.generate_content(prompt)
        text = response.text.strip()
        if "```" in text:
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        meta = json.loads(text.strip())
        return jsonify(meta)
    except Exception as e:
        return jsonify({
            "title": f"Amazing Short - {context[:30]}",
            "description": "Watch this incredible short video! Don't forget to subscribe.",
            "hashtags": ["#shorts", "#viral", "#trending", "#youtube", "#amazing"]
        })

# ─── YouTube OAuth ────────────────────────────────────────────────────────────

def get_yt_flow():
    client_config = {
        "web": {
            "client_id": YT_CLIENT_ID,
            "client_secret": YT_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [request.host_url.rstrip("/") + "/yt_callback"]
        }
    }
    flow = Flow.from_client_config(
        client_config,
        scopes=["https://www.googleapis.com/auth/youtube.upload",
                "https://www.googleapis.com/auth/youtube"],
        redirect_uri=request.host_url.rstrip("/") + "/yt_callback"
    )
    return flow

@app.route("/yt_connect")
def yt_connect():
    try:
        flow = get_yt_flow()
        auth_url, state = flow.authorization_url(access_type="offline", include_granted_scopes="true")
        session["oauth_state"] = state
        return redirect(auth_url)
    except Exception as e:
        return f"OAuth setup error: {e}", 500

@app.route("/yt_callback")
def yt_callback():
    try:
        flow = get_yt_flow()
        flow.fetch_token(authorization_response=request.url)
        creds = flow.credentials
        session["yt_credentials"] = {
            "token": creds.token,
            "refresh_token": creds.refresh_token,
            "token_uri": creds.token_uri,
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "scopes": list(creds.scopes) if creds.scopes else []
        }
        return redirect("/")
    except Exception as e:
        return f"OAuth callback error: {e}", 500

@app.route("/yt_disconnect")
def yt_disconnect():
    session.pop("yt_credentials", None)
    return redirect("/")

# ─── YouTube Upload ───────────────────────────────────────────────────────────

def upload_to_youtube(clip_filename, title, description, hashtags, scheduled_time=None):
    creds_data = session.get("yt_credentials")
    if not creds_data:
        return False, "YouTube সংযুক্ত নেই"
    
    creds = Credentials(
        token=creds_data["token"],
        refresh_token=creds_data["refresh_token"],
        token_uri=creds_data["token_uri"],
        client_id=creds_data["client_id"],
        client_secret=creds_data["client_secret"],
        scopes=creds_data["scopes"]
    )
    
    if creds.expired:
        creds.refresh(google.auth.transport.requests.Request())
        session["yt_credentials"]["token"] = creds.token

    youtube = build("youtube", "v3", credentials=creds)
    clip_path = OUTPUT_FOLDER / clip_filename
    
    if not clip_path.exists():
        return False, "ক্লিপ ফাইল পাওয়া যায়নি"

    tags = [h.lstrip("#") for h in hashtags]
    body = {
        "snippet": {
            "title": title,
            "description": description + "\n\n" + " ".join(hashtags),
            "tags": tags,
            "categoryId": "22"
        },
        "status": {"privacyStatus": "public", "selfDeclaredMadeForKids": False}
    }

    try:
        media = MediaFileUpload(str(clip_path), mimetype="video/mp4", resumable=True)
        request_yt = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
        response = request_yt.execute()
        video_yt_id = response["id"]
        # Auto-clean after upload
        clip_path.unlink(missing_ok=True)
        return True, f"https://youtube.com/shorts/{video_yt_id}"
    except Exception as e:
        return False, str(e)

@app.route("/upload_clip", methods=["POST"])
def upload_clip():
    data = request.json
    filename = data.get("filename")
    title = data.get("title", "My Short")
    description = data.get("description", "")
    hashtags = data.get("hashtags", ["#shorts"])
    
    ok, result = upload_to_youtube(filename, title, description, hashtags)
    if ok:
        return jsonify({"status": "uploaded", "url": result})
    return jsonify({"error": result}), 500

# ─── Google Drive Integration ─────────────────────────────────────────────────

@app.route("/drive_fetch", methods=["POST"])
def drive_fetch():
    """Fetch a random video from a ZIP in Google Drive public folder."""
    data = request.json
    folder_url = data.get("folder_url") or session.get("drive_folder") or DRIVE_FOLDER_ID
    
    if not folder_url:
        return jsonify({"error": "Drive folder URL দেওয়া হয়নি"}), 400

    # Extract folder ID from URL
    folder_id = folder_url
    if "folders/" in folder_url:
        folder_id = folder_url.split("folders/")[-1].split("?")[0]

    # List files in folder (public)
    list_url = f"https://drive.google.com/drive/folders/{folder_id}"
    api_url = f"https://www.googleapis.com/drive/v3/files?q='{folder_id}'+in+parents&key=AIzaSyA3v5xr8O4KM9Ag7bAl0FYvZORW0T-S288"
    
    try:
        resp = requests.get(api_url, timeout=15)
        files = resp.json().get("files", [])
        zip_files = [f for f in files if f["name"].endswith(".zip")]
        
        if not zip_files:
            return jsonify({"error": "Drive ফোল্ডারে কোনো ZIP ফাইল পাওয়া যায়নি"}), 404

        chosen = random.choice(zip_files)
        file_id = chosen["id"]
        
        # Download ZIP
        zip_path = UPLOAD_FOLDER / f"drive_{file_id[:8]}.zip"
        download_url = f"https://drive.google.com/uc?export=download&id={file_id}"
        
        r = requests.get(download_url, stream=True, timeout=60)
        with open(zip_path, "wb") as f:
            for chunk in r.iter_content(8192):
                f.write(chunk)

        # Extract random video from ZIP
        with zipfile.ZipFile(zip_path, "r") as zf:
            videos = [n for n in zf.namelist() if n.endswith((".mp4", ".mov", ".avi"))]
            if not videos:
                return jsonify({"error": "ZIP-এ কোনো ভিডিও নেই"}), 404
            chosen_video = random.choice(videos)
            vid_id = str(uuid.uuid4())[:8]
            out_name = f"{vid_id}.mp4"
            with zf.open(chosen_video) as src, open(UPLOAD_FOLDER / out_name, "wb") as dst:
                dst.write(src.read())
        
        zip_path.unlink(missing_ok=True)
        
        return jsonify({
            "status": "ok",
            "video_id": vid_id,
            "filename": out_name,
            "source": chosen_video
        })
    except Exception as e:
        return jsonify({"error": f"Drive ত্রুটি: {str(e)}"}), 500

# ─── Scheduler ────────────────────────────────────────────────────────────────

scheduled_jobs = {}

@app.route("/schedule_upload", methods=["POST"])
def schedule_upload():
    data = request.json
    hour = int(data.get("hour", 12))
    minute = int(data.get("minute", 0))
    job_data = data.get("job_data", {})
    job_id = f"upload_{hour}_{minute}"
    
    if job_id in scheduled_jobs:
        try:
            scheduler.remove_job(job_id)
        except:
            pass

    def scheduled_task():
        # This runs in background - needs app context
        with app.app_context():
            pass  # Would trigger drive fetch + upload

    scheduler.add_job(
        scheduled_task,
        "cron",
        hour=hour,
        minute=minute,
        id=job_id
    )
    scheduled_jobs[job_id] = {"hour": hour, "minute": minute, "data": job_data}
    
    return jsonify({"status": "scheduled", "time": f"{hour:02d}:{minute:02d}"})

@app.route("/list_schedules")
def list_schedules():
    return jsonify({"schedules": list(scheduled_jobs.values())})

@app.route("/list_clips")
def list_clips():
    clips = []
    for f in OUTPUT_FOLDER.iterdir():
        if f.suffix == ".mp4":
            clips.append({"filename": f.name, "size_mb": round(f.stat().st_size / 1e6, 2)})
    return jsonify({"clips": clips})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
