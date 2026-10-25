import os
import json
import urllib.request
import httpx
from fastapi import FastAPI, Request, Form, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv
from supabase import create_client, Client

# Global monkey patch for httpx to bypass Sophos SSL interception
_original_client_init = httpx.Client.__init__
def _patched_client_init(self, *args, **kwargs):
    kwargs['verify'] = False
    _original_client_init(self, *args, **kwargs)
httpx.Client.__init__ = _patched_client_init

_original_async_client_init = httpx.AsyncClient.__init__
def _patched_async_client_init(self, *args, **kwargs):
    kwargs['verify'] = False
    _original_async_client_init(self, *args, **kwargs)
httpx.AsyncClient.__init__ = _patched_async_client_init

load_dotenv()

app = FastAPI(title="VidQuery")

app.mount("/static", StaticFiles(directory="static"), name="static")

templates = Jinja2Templates(directory="templates")

# Helper function to handle API fallbacks automatically
def generate_ai_response(user_prompt: str, system_prompt: str = None, json_mode: bool = False):
    import json
    from openai import OpenAI
    import httpx
    import requests
    
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})
    
    kwargs = {}
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
        
    # Attempt 1: Groq API (Fastest)
    try:
        print("Attempting Groq API...")
        groq_client = OpenAI(
            base_url="https://api.groq.com/openai/v1",
            api_key=os.environ.get("GROQ_API_KEY", ""),
            http_client=httpx.Client(verify=False)
        )
        kwargs_groq = kwargs.copy()
        kwargs_groq["max_tokens"] = 800  # Prevent Groq 1000 OTPM limit error
        
        completion = groq_client.chat.completions.create(
            model="qwen/qwen3.8-27b",
            messages=messages,
            **kwargs_groq
        )
        print("Groq API Success!")
        return completion.choices[0].message.content.strip()
    except Exception as e:
        print(f"Groq API Failed: {e}. Falling back to OpenRouter...")
        
    # Attempt 2: OpenRouter API (Auto-Router Fallback)
    try:
        print("Attempting OpenRouter API...")
        or_client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=os.environ.get("OPENROUTER_API_KEY", ""),
            http_client=httpx.Client(verify=False)
        )
        completion = or_client.chat.completions.create(
            model="openrouter/free",
            messages=messages,
            **kwargs
        )
        print("OpenRouter API Success!")
        return completion.choices[0].message.content.strip()
    except Exception as e:
        print(f"OpenRouter API Failed: {e}. Falling back to Gemini...")
        
    # Attempt 3: Gemini API (Final Fallback)
    try:
        print("Attempting Gemini API...")
        api_key = os.environ.get("GEMINI_API_KEY", "")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
        headers = {'Content-Type': 'application/json'}
        
        # Convert messages to Gemini format
        gemini_contents = []
        for msg in messages:
            gemini_contents.append({"role": "user" if msg["role"] == "user" else "model", "parts": [{"text": msg["content"]}]})
            
        data = {"contents": gemini_contents}
        if json_mode:
            data["generationConfig"] = {"responseMimeType": "application/json"}
            
        response = requests.post(url, headers=headers, json=data, verify=False)
        response.raise_for_status()
        res_json = response.json()
        print("Gemini API Success!")
        return res_json["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception as e:
        print(f"Gemini API Failed: {e}.")
        
    raise Exception("All configured AI APIs failed or hit limits.")

def parse_llm_json(text: str):
    """Safely extracts and parses JSON from LLM output, handling markdown code fences."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return json.loads(text)

# Initialize Supabase (requires SUPABASE_URL and SUPABASE_KEY in .env)
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
supabase: Client = None
if SUPABASE_URL and SUPABASE_KEY:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

def get_current_user(request: Request):
    token = request.cookies.get("access_token")
    if not supabase:
        return None
    if token:
        try:
            res = supabase.auth.get_user(token)
            return res.user
        except Exception:
            return None
    return None

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    user = get_current_user(request)
    return templates.TemplateResponse(
        request,
        "home.html",
        {"request": request, "user": user}
    )

@app.get("/login", response_class=HTMLResponse)
async def login_get(request: Request):
    return RedirectResponse(url="/?show_modal=login", status_code=303)

@app.post("/login", response_class=HTMLResponse)
async def login_post(request: Request, response: Response, email: str = Form(...), password: str = Form(...)):


    if not supabase:
        return templates.TemplateResponse(request, "home.html", {"request": request, "error": "Supabase not configured.", "show_modal": "login"})
    try:
        auth_res = supabase.auth.sign_in_with_password({"email": email, "password": password})
        if auth_res.session:
            token = auth_res.session.access_token
            redirect_res = RedirectResponse(url="/dashboard?welcome=true", status_code=303)
            redirect_res.set_cookie("access_token", token, httponly=True)
            return redirect_res
        return templates.TemplateResponse(request, "home.html", {"request": request, "error": "Login failed.", "show_modal": "login"})
    except Exception as e:
        return templates.TemplateResponse(request, "home.html", {"request": request, "error": str(e), "show_modal": "login"})

@app.get("/register", response_class=HTMLResponse)
async def register_get(request: Request):
    return RedirectResponse(url="/?show_modal=register", status_code=303)

@app.post("/register", response_class=HTMLResponse)
async def register_post(request: Request, response: Response, email: str = Form(...), password: str = Form(...), full_name: str = Form(""), education_level: str = Form("")):


    if not supabase:
        return templates.TemplateResponse(request, "home.html", {"request": request, "error": "Supabase not configured.", "show_modal": "register"})
    try:
        auth_res = supabase.auth.sign_up({
            "email": email, 
            "password": password,
            "options": {
                "data": {
                    "full_name": full_name,
                    "institution_category": education_level
                }
            }
        })
        if auth_res.session:
            token = auth_res.session.access_token
            redirect_res = RedirectResponse(url="/dashboard?welcome=true", status_code=303)
            redirect_res.set_cookie("access_token", token, httponly=True)
            return redirect_res
        else:
            return templates.TemplateResponse(request, "home.html", {"request": request, "error": "Check your email to verify your account.", "show_modal": "register"})
    except Exception as e:
        return templates.TemplateResponse(request, "home.html", {"request": request, "error": str(e), "show_modal": "register"})

@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse(url="/?show_modal=login", status_code=303)
    return templates.TemplateResponse(request, "dashboard.html", {"request": request, "user": user})

@app.get("/profile", response_class=HTMLResponse)
async def profile(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse(url="/?show_modal=login", status_code=303)
    return templates.TemplateResponse(request, "profile.html", {"request": request, "user": user})

@app.get("/logout")
async def logout_get(request: Request):
    token = request.cookies.get("access_token")
    if token and supabase:
        try:
            supabase.auth.set_session(token, "dummy")
            supabase.auth.sign_out()
        except:
            pass
    response = RedirectResponse(url="/", status_code=303)
    response.set_cookie("access_token", "", max_age=0, expires=0, path="/", httponly=True)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response

@app.post("/logout")
async def logout_post(request: Request):
    token = request.cookies.get("access_token")
    if token and supabase:
        try:
            supabase.auth.set_session(token, "dummy")
            supabase.auth.sign_out()
        except:
            pass
    response = RedirectResponse(url="/", status_code=303)
    response.set_cookie("access_token", "", max_age=0, expires=0, path="/", httponly=True)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response

@app.post("/profile/update")
async def profile_update(request: Request, full_name: str = Form(""), institution_category: str = Form(""), phone: str = Form("")):
    token = request.cookies.get("access_token")
    
    if not token or not supabase:
        return RedirectResponse(url="/?show_modal=login", status_code=303)
        
    try:
        supabase.auth.set_session(token, "dummy")
        supabase.auth.update_user({
            "data": {
                "full_name": full_name,
                "institution_category": institution_category,
                "phone": phone
            }
        })
        return RedirectResponse(url="/profile?updated=true", status_code=303)
    except Exception as e:
        return templates.TemplateResponse(request, "profile.html", {"request": request, "user": get_current_user(request), "error": str(e)})


from pydantic import BaseModel
import urllib.parse as urlparse
from youtube_transcript_api import YouTubeTranscriptApi
import json
import re
import ssl
import html

class YTRequest(BaseModel):
    url: str

class ChatRequest(BaseModel):
    query: str
    video_id: str
    transcript_text: str

class KeyMomentsRequest(BaseModel):
    video_id: str
    raw_text: str

def extract_video_id(url):
    if "youtu.be" in url:
        return url.split("/")[-1].split("?")[0]
    if "youtube.com" in url:
        parsed = urlparse.urlparse(url)
        if "v" in urlparse.parse_qs(parsed.query):
            return urlparse.parse_qs(parsed.query)["v"][0]
    return None

def fetch_transcript_fallback(video_id):
    import yt_dlp
    import requests
    ydl_opts = {
        'skip_download': True,
        'writesubtitles': True,
        'writeautomaticsub': True,
        'subtitlesformat': 'json3',
        'quiet': True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=False)
        subs = info.get('requested_subtitles') or info.get('automatic_captions') or info.get('subtitles')
        if not subs: return None
        
        url = None
        for lang in ['en', 'hi', 'en-IN', list(subs.keys())[0]]:
            if lang in subs:
                sub_info = subs[lang]
                if isinstance(sub_info, dict):
                    url = sub_info.get('url')
                elif isinstance(sub_info, list):
                    for s in sub_info:
                        if s.get('ext') == 'json3':
                            url = s['url']
                            break
                    if not url: url = sub_info[0].get('url')
                if url: break
                
        if not url: return None
        
        r = requests.get(url, verify=False)
        r.raise_for_status()
        data = r.json()
        
        formatted = []
        for ev in data.get('events', []):
            if 'segs' not in ev: continue
            text = "".join([seg.get('utf8', '') for seg in ev['segs']])
            if not text.strip(): continue
            formatted.append({
                'text': text.strip(),
                'start': ev.get('tStartMs', 0) / 1000.0,
                'duration': ev.get('dDurationMs', 0) / 1000.0
            })
        return formatted

@app.post("/api/process_youtube")
def process_youtube(req: YTRequest):
    video_id = extract_video_id(req.url)
    if not video_id:
        return {"error": "Invalid YouTube URL"}
        
    video_title = "YouTube Video Analysis"
    try:
        url = f"https://www.youtube.com/watch?v={video_id}"
        req_obj = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        context = ssl._create_unverified_context()
        with urllib.request.urlopen(req_obj, context=context) as response:
            html_content = response.read().decode('utf-8', errors='ignore')
            match = re.search(r'<title>(.*?)</title>', html_content)
            if match:
                raw_title = match.group(1).replace(' - YouTube', '').strip()
                video_title = html.unescape(raw_title)
    except Exception as e:
        print("Could not fetch title:", e)
    
    try:
        try:
            api = YouTubeTranscriptApi()
            transcript_list = api.list(video_id)
            try:
                t = transcript_list.find_transcript(['hi', 'en', 'en-IN'])
            except:
                t = transcript_list.find_generated_transcript(['hi', 'en', 'en-IN'])
                
            # If the video is in Hindi (or another language), translate the transcript to English!
            if t.language_code != 'en' and getattr(t, 'is_translatable', True):
                try:
                    t = t.translate('en')
                except Exception as trans_err:
                    print("Translation to English failed:", trans_err)
                    
            transcript = t.fetch()
        except Exception as e:
            print("Primary transcript API failed, trying yt-dlp fallback:", e)
            try:
                transcript = fetch_transcript_fallback(video_id)
                if not transcript:
                    raise Exception("Fallback returned no subtitles")
            except Exception as fallback_e:
                return {"error": f"Could not fetch transcript (IP might be blocked). Fallback also failed: {str(fallback_e)}"}
            
        # Format raw transcript for LLMs
        raw_text = ""
        transcript_data = []
        for t in transcript:
            if isinstance(t, dict):
                start_sec = float(t.get('start', 0.0))
                text_content = str(t.get('text', ''))
            else:
                start_sec = float(getattr(t, 'start', 0.0))
                text_content = str(getattr(t, 'text', ''))
            raw_text += f"[{start_sec:.1f}s] {text_content}\n"
            transcript_data.append({"start": start_sec, "text": text_content})
            
        return {
            "success": True, 
            "video_id": video_id, 
            "video_title": video_title,
            "transcript": transcript_data,
            "raw_text": raw_text,
            "key_moments": None
        }
        
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/key_moments")
def generate_key_moments(req: KeyMomentsRequest):
    prompt = f"""
    Analyze this video transcript and extract 5 to 8 'Key Moments'.
    For each moment, provide the start time (formatted as MM:SS), a short title, and a 1-sentence description.
    Return ONLY valid JSON in this exact structure:
    {{
        "key_moments": [
            {{"time": "00:00", "title": "Introduction", "desc": "The speaker introduces the topic."}}
        ]
    }}
    
    Transcript snippet (first 30000 chars):
    {req.raw_text}
    """
    
    try:
        res_text = generate_ai_response(prompt, json_mode=True)
        parsed = parse_llm_json(res_text)
        if isinstance(parsed, dict):
            key_moments = parsed.get("key_moments", parsed.get("moments", []))
        elif isinstance(parsed, list):
            key_moments = parsed
        else:
            key_moments = []
        if not key_moments:
            key_moments = [{"time": "00:00", "title": "Introduction", "desc": "Video begins."}]
    except Exception as api_err:
        print("All AI APIs failed:", api_err)
        key_moments = [
            {"time": "00:00", "title": "Introduction", "desc": "Video begins."}
        ]
        
    return {"key_moments": key_moments}
@app.get("/health")
async def health():
    return {"status": "VidQuery is running"}

@app.post("/api/chat")
def chat_with_video(req: ChatRequest, request: Request):
    user_id = None
    user = get_current_user(request)
    if user:
        user_id = user.id
    system_prompt = f"""You are VidQuery, an AI study assistant.
You can answer general conversational questions (like "hi", "how are you", "what can you do") normally and politely.
If the user asks about the video, answer their question based ONLY on the following transcript with timestamps:

{req.transcript_text}

Return your response strictly in valid JSON format:
{{
    "answer": "Your detailed answer here...",
    "citation": {{
        "start_time": "18:27",
        "end_time": "21:03",
        "title": "Topic Name"
    }}
}}
If no specific citation is relevant (for example, if it's a general greeting), set citation to null. Do not include markdown blocks like ```json.
"""
    try:
        res_text = generate_ai_response(req.query, system_prompt=system_prompt, json_mode=True)
        response_data = parse_llm_json(res_text)
        
        # Save to Supabase Chat History
        if supabase and user_id:
            try:
                # Use JWT to bypass RLS for this user
                token = request.cookies.get("access_token")
                if token and token != "dummy_token":
                    supabase.auth.set_session(token, "dummy")
                
                # We assume a chat_history table with these standard columns
                supabase.table("chat_history").insert({
                    "user_id": user_id,
                    "video_id": req.video_id,
                    "query": req.query,
                    "response": json.dumps(response_data)
                }).execute()
            except Exception as db_err:
                print(f"Supabase Chat Save Error (table might not be configured correctly): {db_err}")
                
        return response_data
    except Exception as e:
        print(f"Chat API Error (All fallbacks failed): {e}")
        return {"answer": "I'm sorry, I couldn't process that request right now.", "citation": None}

@app.get("/api/history/{video_id}")
def get_chat_history(video_id: str, request: Request):
    user_id = None
    user = get_current_user(request)
    if user:
        user_id = user.id
        
    if not supabase:
        return {"history": []}
        
    try:
        token = request.cookies.get("access_token")
        if token and token != "dummy_token":
            supabase.auth.set_session(token, "dummy")
            
        res = supabase.table("chat_history").select("*").eq("video_id", video_id).eq("user_id", user_id).order("created_at").execute()
        return {"history": res.data}
    except Exception as e:
        print(f"Failed to fetch history: {e}")
        return {"history": []}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)