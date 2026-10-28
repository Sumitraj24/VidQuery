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

import time
import study_offline

# When the gateway refuses connections we skip it for a short while instead of
# making every request wait through all candidate models.
_llm_down_until = 0.0
LLM_COOLDOWN_SECONDS = 30

def llm_base_url():
    return os.environ.get("FREELLMAPI_BASE_URL", "http://127.0.0.1:31415/v1").rstrip("/")

# Helper function to generate AI responses using FreeLLMAPI
def generate_ai_response(user_prompt: str, system_prompt: str = None, json_mode: bool = False):
    global _llm_down_until
    from openai import OpenAI, APIConnectionError
    import httpx

    if time.time() < _llm_down_until:
        raise Exception("FreeLLMAPI gateway marked unreachable; skipping")

    base_url = llm_base_url()
    api_key = os.environ.get("FREELLMAPI_API_KEY", "")
    preferred_model = os.environ.get("FREELLMAPI_MODEL", "auto")

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    kwargs = {}
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}

    # Try preferred model first, then solid fallbacks from FreeLLMAPI if needed
    candidate_models = [preferred_model]
    for fallback in ["auto", "gemini-flash", "fusion", "gemini-3.8-flash"]:
        if fallback not in candidate_models:
            candidate_models.append(fallback)

    last_error = None
    client = OpenAI(
        base_url=base_url,
        api_key=api_key,
        http_client=httpx.Client(verify=False),
        timeout=90,
        max_retries=0,
    )

    for model_name in candidate_models:
        try:
            print(f"Attempting FreeLLMAPI (model='{model_name}')...")
            completion = client.chat.completions.create(
                model=model_name,
                messages=messages,
                **kwargs
            )
            content = completion.choices[0].message.content
            if content:
                print(f"FreeLLMAPI Success with model '{model_name}'!")
                return content.strip()
        except APIConnectionError as e:
            print(f"FreeLLMAPI unreachable at {base_url}: {e}")
            _llm_down_until = time.time() + LLM_COOLDOWN_SECONDS
            raise
        except Exception as e:
            print(f"FreeLLMAPI attempt with model '{model_name}' failed: {e}")
            last_error = e

    raise Exception(f"FreeLLMAPI request failed across all candidate models: {last_error}")

def parse_llm_json(text: str):
    """Safely extracts and parses JSON from LLM output, handling markdown code fences."""
    import re
    text = text.strip()
    if "```" in text:
        match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
        if match:
            text = match.group(1).strip()
    try:
        return json.loads(text)
    except Exception:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start:end+1])
        start_list = text.find("[")
        end_list = text.rfind("]")
        if start_list != -1 and end_list != -1 and end_list > start_list:
            return json.loads(text[start_list:end_list+1])
        raise

# Initialize Supabase (requires SUPABASE_URL and SUPABASE_KEY in .env)
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
supabase: Client = None
if SUPABASE_URL and SUPABASE_KEY:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# Demo User configuration
DEMO_EMAIL = os.environ.get("DEMO_EMAIL", "demo@vidquery.com").strip().lower()
DEMO_PASSWORDS = {"demo123", "demopassword123", "demo1234", "demo", os.environ.get("DEMO_PASSWORD", "demo123").strip()}
DEMO_EMAILS = {DEMO_EMAIL, "demo@vidquery.com", "demo@test.com", "demo@example.com"}

class DemoUserState:
    def __init__(self):
        self.id = "demo-user-vidquery"
        self.email = "demo@vidquery.com"
        self.user_metadata = {
            "full_name": "Demo Scholar",
            "institution_category": "University",
            "education_level": "University",
            "phone": "+1 (555) 019-2834"
        }

DEMO_USER = DemoUserState()

def get_current_user(request: Request):
    token = request.cookies.get("access_token")
    if token in ("demo_access_token", "dummy_token"):
        return DEMO_USER
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
    normalized_email = email.strip().lower()
    cleaned_password = password.strip()

    # Check for demo login credentials
    if normalized_email in DEMO_EMAILS and cleaned_password in DEMO_PASSWORDS:
        redirect_res = RedirectResponse(url="/dashboard?welcome=true", status_code=303)
        redirect_res.set_cookie("access_token", "demo_access_token", httponly=True)
        return redirect_res

    if not supabase:
        return templates.TemplateResponse(request, "home.html", {"request": request, "error": "Supabase not configured. Use demo account (demo@vidquery.com / demo123).", "show_modal": "login"})
    try:
        auth_res = supabase.auth.sign_in_with_password({"email": email, "password": password})
        if auth_res.session:
            token = auth_res.session.access_token
            redirect_res = RedirectResponse(url="/dashboard?welcome=true", status_code=303)
            redirect_res.set_cookie("access_token", token, httponly=True)
            return redirect_res
        return templates.TemplateResponse(request, "home.html", {"request": request, "error": "Invalid email or password.", "show_modal": "login"})
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
    
    if not token:
        return RedirectResponse(url="/?show_modal=login", status_code=303)

    if token in ("demo_access_token", "dummy_token"):
        if full_name:
            DEMO_USER.user_metadata["full_name"] = full_name
        if institution_category:
            DEMO_USER.user_metadata["institution_category"] = institution_category
            DEMO_USER.user_metadata["education_level"] = institution_category
        if phone:
            DEMO_USER.user_metadata["phone"] = phone
        return RedirectResponse(url="/profile?updated=true", status_code=303)
        
    if not supabase:
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
    mode: str = "chat"  # chat | summary | notes | qa
    language: str = "auto"  # auto | english | hinglish

class MindMapRequest(BaseModel):
    video_id: str
    title: str = ""
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
    {req.raw_text[:30000]}
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
            raise ValueError("LLM returned no key moments")
        source = "ai"
    except Exception as api_err:
        print("Key moments falling back to offline mode:", api_err)
        key_moments = study_offline.key_moments(study_offline.parse_transcript(req.raw_text))
        source = "offline"

    return {"key_moments": key_moments, "source": source}

@app.get("/api/status")
def ai_status():
    """Lets the UI tell students whether answers come from the AI or offline transcript search."""
    try:
        r = httpx.get(llm_base_url() + "/models", timeout=3)
        online = r.status_code < 500
    except Exception:
        online = False
    return {"ai": online}

@app.post("/api/mindmap")
def generate_mindmap(req: MindMapRequest):
    prompt = f"""Build a study mind map of this lecture transcript.
Return ONLY valid JSON in this exact structure (4 to 7 branches, 2 to 4 children each, short titles):
{{
  "title": "Central topic",
  "branches": [
    {{"title": "Main idea", "time": "MM:SS", "children": [{{"title": "Sub-idea", "time": "MM:SS"}}]}}
  ]
}}
Use times from the transcript where each idea is explained.

Transcript:
{req.transcript_text[:30000]}
"""
    try:
        parsed = parse_llm_json(generate_ai_response(prompt, json_mode=True))
        if not isinstance(parsed, dict) or not parsed.get("branches"):
            raise ValueError("LLM returned no branches")
        parsed.setdefault("title", req.title or "This video")
        return {**parsed, "source": "ai"}
    except Exception as api_err:
        print("Mind map falling back to offline mode:", api_err)
        data = study_offline.mindmap(study_offline.parse_transcript(req.transcript_text), req.title)
        return {**data, "source": "offline"}
@app.get("/health")
async def health():
    return {"status": "VidQuery is running"}

@app.post("/api/chat")
def chat_with_video(req: ChatRequest, request: Request):
    user_id = None
    user = get_current_user(request)
    if user:
        user_id = user.id
    language = study_offline.resolve_language(req.language, req.query)
    language_rule = {
        "english": "Write the \"answer\" in clear, simple English.",
        "hinglish": (
            "Write the \"answer\" in Hinglish: friendly conversational Hindi written ONLY in Roman (English) letters, "
            "mixed naturally with English, the way Indian students talk. Keep technical terms in English. "
            "Example: \"Sigmoid function ek squishing function hai jo kisi bhi number ko 0 aur 1 ke beech le aata hai.\" "
            "Never use Devanagari script. This applies to EVERYTHING you write: questions, answers, headings and bullets. "
            "Example question: \"**Q1.** Input layer mein kitne neurons hote hain?\""
        ),
    }[language]
    mode_rule = {
        "summary": "TASK: a crisp summary. Start with a 1-line 🎯 gist, then 4-6 sections as '### emoji Title' each with 2-3 short bullets and a [MM:SS] timestamp. End with a '✅ Key takeaway' line.",
        "notes": "TASK: exam-ready study notes. Use '### emoji Topic' headings with short bullets; put definitions as '**Term**: meaning'. Include formulas if any. Add [MM:SS] timestamps. End with '📝 Quick revision' (3 bullets).",
        "qa": "TASK: 5 practice questions. Format each as '**Q1.** question' on one line, then '✅ **Answer:** answer in at most 2 short lines [MM:SS]'. No extra notes after answers. Mix easy and tricky questions. Leave a blank line between questions.",
    }.get(req.mode, "TASK: answer the student's question directly. Usually 40-120 words.")
    system_prompt = f"""You are VidQuery, a friendly, expert AI study assistant for students.
LANGUAGE: {language_rule} Citation titles may stay in English.

STYLE (write like ChatGPT at its best: accurate, to the point, engaging):
- Lead with the direct answer in 1-2 short sentences. No filler, no restating the question, no "Great question!".
- Then, only if useful, 2-5 crisp bullet points ("- ") with **bold** key terms.
- Keep paragraphs to 1-2 sentences. Use line breaks (\\n) between paragraphs and bullets.
- Use a few relevant emojis (like 💡 🎯 ✅ 📌 🧠 ⚡) to make it lively, about one per paragraph or heading, never one on every bullet.
- Add [MM:SS] timestamps from the transcript next to the points they support.
- Be precise: use only facts from the transcript; never invent details. If the video doesn't cover it, say so in one line.
- For a simple greeting, reply in one or two friendly lines.
{mode_rule}
You can answer general conversational questions (like "hi", "how are you", "what can you do") normally and politely.
If the user asks about the video, answer their question based ONLY on the following transcript with timestamps:

{req.transcript_text}

Return your response strictly in valid JSON format:
{{
    "answer": "Markdown answer that follows the STYLE rules, with \\n line breaks",
    "citation": {{
        "start_time": "18:27",
        "end_time": "21:03",
        "title": "Topic Name"
    }}
}}
If no specific citation is relevant (for example, if it's a general greeting), set citation to null. Do not include markdown blocks like ```json.

REMEMBER THE LANGUAGE: {language_rule}
"""
    # Repeat the language on the message itself; models follow it far more reliably there.
    user_message = f"{req.query}\n\n(Reply language: {'Hinglish, in Roman script' if language == 'hinglish' else 'English'})"
    try:
        res_text = generate_ai_response(user_message, system_prompt=system_prompt, json_mode=True)
        response_data = parse_llm_json(res_text)
        if not isinstance(response_data, dict):
            response_data = {"answer": response_data, "citation": None}
        response_data["source"] = "ai"
        
        # Save to Supabase Chat History
        if supabase and user_id and user_id != DEMO_USER.id:
            try:
                # Use JWT to bypass RLS for this user
                token = request.cookies.get("access_token")
                if token and token != "dummy_token":
                    supabase.auth.set_session(token, "dummy")
                
                supabase.table("chat_history").insert({
                    "user_id": user_id,
                    "video_id": req.video_id,
                    "user_message": req.query,
                    "ai_response": json.dumps(response_data)
                }).execute()
            except Exception as db_err:
                print(f"Supabase Chat Save Error (table might not be configured correctly): {db_err}")
                
        return response_data
    except Exception as e:
        print(f"Chat falling back to offline mode: {e}")
        transcript = study_offline.parse_transcript(req.transcript_text)
        if not transcript:
            return {"answer": "Import a video first, then ask me anything about it.", "citation": None, "source": "offline"}
        handlers = {"summary": study_offline.summary, "notes": study_offline.notes, "qa": study_offline.quiz}
        handler = handlers.get(req.mode)
        response_data = handler(transcript, language) if handler else study_offline.answer(req.query, transcript, language)
        response_data["source"] = "offline"
        return response_data

@app.get("/api/history/{video_id}")
def get_chat_history(video_id: str, request: Request):
    user_id = None
    user = get_current_user(request)
    if user:
        user_id = user.id
        
    if not supabase or not user_id or user_id == DEMO_USER.id:
        return {"history": []}

    try:
        token = request.cookies.get("access_token")
        if token and token != "dummy_token":
            supabase.auth.set_session(token, "dummy")
            
        res = supabase.table("chat_history").select("*").eq("video_id", video_id).eq("user_id", user_id).order("created_at").execute()
        history = [{"query": row.get("user_message", ""), "response": row.get("ai_response", "")} for row in res.data]
        return {"history": history}
    except Exception as e:
        print(f"Failed to fetch history: {e}")
        return {"history": []}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)