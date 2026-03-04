# 🎬 YT Shorts Automation Tool

## Railway.app-এ Deploy করার নিয়ম

### ধাপ ১: GitHub-এ Code Upload করুন
সব ফাইল একটা GitHub repo-তে push করুন।

### ধাপ ২: Railway-তে Deploy
1. railway.app → New Project → Deploy from GitHub
2. আপনার repo select করুন

### ধাপ ৩: Environment Variables যোগ করুন
Railway Dashboard → Variables-এ এগুলো দিন:

```
SESSION_SECRET = (যেকোনো random string, যেমন: abc123xyz)
GEMINI_API_KEY = AIzaSyA3v5xr8O4KM9Ag7bAl0FYvZORW0T-S288
YOUTUBE_CLIENT_ID = 682704644251-xxx.apps.googleusercontent.com  
YOUTUBE_CLIENT_SECRET = GOCSPX-xxx
DRIVE_FOLDER_ID = (আপনার Drive folder URL)
```

### ধাপ ৪: YouTube OAuth Redirect URI ঠিক করুন
Google Cloud Console → OAuth 2.0 Client → Authorized redirect URIs-এ যোগ করুন:
```
https://আপনার-railway-url/yt_callback
```

### ধাপ ৫: Bot Detection এড়াতে Cookies
যদি YouTube bot block করে:
1. Browser-এ YouTube-এ login করুন
2. EditThisCookie extension দিয়ে cookies export করুন
3. `cookies.txt` নামে save করুন (Netscape format)
4. প্রজেক্টের root-এ রাখুন

## Features
- ✅ YouTube ভিডিও download (yt-dlp)
- ✅ AI segment detection (Gemini)
- ✅ 9:16 crop (FFmpeg)
- ✅ Manual crop (MM:SS)
- ✅ Caption/text overlay
- ✅ YouTube auto upload
- ✅ Schedule (12pm/8pm)
- ✅ Google Drive ZIP integration
- ✅ Auto metadata (title/desc/hashtags)
- ✅ Preview before upload
- ✅ Auto-clean after upload
