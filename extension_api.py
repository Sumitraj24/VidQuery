"""API used by the VidQuery Chrome extension (mounted under /api/ext).

Design goals:
- Instant first paint: every analysis has a "fast" tier computed offline from the
  transcript in milliseconds, and an "ai" tier the extension swaps in when ready.
- Streaming chat: answers arrive token by token as NDJSON lines.
- Caching: transcripts and AI results are cached per video, so revisiting a video
  (or a second student opening it) is immediate.
- Graceful degradation: when the LLM gateway is down, every endpoint still answers
  from the transcript (study_offline), and says so via `source`.
"""
import json
import re
import threading
import time
from collections import OrderedDict
from typing import Callable, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import prompts
import study_offline

VIDEO_ID = re.compile(r"^[\w-]{11}$")
# Prompt budgets. Whole-video tasks (summary, notes, quiz) get the full transcript
# up to FULL_CHARS; questions get the most relevant passages only, which is both
# faster (smaller prompt, quicker first token) and more focused.
FULL_CHARS = 45000
QUESTION_CHARS = 12000
WHOLE_VIDEO_MODES = {"summary", "notes", "qa"}


class TTLCache:
    """Small thread-safe LRU cache with per-entry expiry."""

    def __init__(self, maxsize=256, ttl=6 * 3600):
        self.maxsize, self.ttl = maxsize, ttl
        self._data = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            expires, value = item
            if expires < time.time():
                del self._data[key]
                return None
            self._data.move_to_end(key)
            return value

    def set(self, key, value):
        with self._lock:
            self._data[key] = (time.time() + self.ttl, value)
            self._data.move_to_end(key)
            while len(self._data) > self.maxsize:
                self._data.popitem(last=False)

    def __len__(self):
        return len(self._data)


# ---------------------------------------------------------------- request models
class Caption(BaseModel):
    start: float
    text: str


class VideoRequest(BaseModel):
    video_id: str
    title: str = ""
    transcript: Optional[List[Caption]] = None  # captions read in the browser, if available


class AnalysisRequest(BaseModel):
    video_id: str
    title: str = ""
    transcript_text: str
    quality: str = "fast"  # fast | ai


class Turn(BaseModel):
    role: str
    content: str


class ChatStreamRequest(BaseModel):
    query: str
    video_id: str = ""
    title: str = ""
    transcript_text: str = ""
    mode: str = "chat"  # chat | summary | notes | qa | moment
    language: str = "auto"
    at: Optional[float] = None  # playback position for "moment"
    history: List[Turn] = Field(default_factory=list)


# ---------------------------------------------------------------- helpers
def _check_id(video_id):
    if not VIDEO_ID.match(video_id or ""):
        raise HTTPException(status_code=400, detail="Invalid YouTube video id")


def _lines(transcript):
    return "\n".join(f"[{study_offline.fmt(t['start'])}] {t['text']}" for t in transcript)


def _trim_for_prompt(transcript, query, at=None, budget=FULL_CHARS):
    """Full transcript when it fits the budget; otherwise the opening passage (context),
    the passages around `at`, and the passages most relevant to the query, in time order."""
    text = _lines(transcript)
    if len(text) <= budget:
        return text
    passages = study_offline.windows(transcript, 45)
    ranked = study_offline._rank(query, passages) or passages[:: max(1, len(passages) // 30)]
    keep = passages[:1]
    if at is not None:
        keep += [p for p in passages if abs(p["start"] - at) <= 120 and p not in keep]
    size = sum(len(p["text"]) + 12 for p in keep)
    for p in ranked:
        if size > budget:
            break
        if p not in keep:
            keep.append(p)
            size += len(p["text"]) + 12
    keep.sort(key=lambda p: p["start"])
    return "\n".join(f"[{study_offline.fmt(p['start'])}] {p['text']}" for p in keep)


def _clean_moments(raw, duration):
    out, seen = [], set()
    for m in raw if isinstance(raw, list) else []:
        if not isinstance(m, dict):
            continue
        secs = study_offline_time(m.get("time"))
        if secs is None or (duration and secs > duration + 5):
            continue
        key = int(secs // 10)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "time": study_offline.fmt(secs),
            "seconds": secs,
            "title": str(m.get("title") or "Untitled moment")[:80],
            "desc": str(m.get("desc") or m.get("description") or "")[:220],
        })
    return sorted(out, key=lambda m: m["seconds"])


def study_offline_time(value):
    parts = str(value or "").strip().split(":")
    try:
        nums = [int(float(p)) for p in parts]
    except ValueError:
        return None
    secs = 0
    for n in nums:
        secs = secs * 60 + n
    return secs


def _with_seconds(moments):
    for m in moments:
        m.setdefault("seconds", study_offline_time(m.get("time")) or 0)
    return moments


def _ndjson(obj):
    return json.dumps(obj, ensure_ascii=False) + "\n"


def _offline_answer(req, transcript, language):
    if req.mode == "moment" and req.at is not None:
        focus = [t for t in transcript if req.at - 60 <= t["start"] <= req.at + 40]
        t = study_offline.TEXT.get(language, study_offline.TEXT["english"])
        if not focus:
            return t["miss"]
        intro = ("📍 Is moment par video mein yeh chal raha hai:" if language == "hinglish"
                 else "📍 Here's what's happening around this moment:")
        bullets = [f"- [{study_offline.fmt(p['start'])}] {study_offline._sentence(p['text'], 32)}"
                   for p in study_offline.windows(focus, 25)[:4]]
        return "\n".join([intro, ""] + bullets)
    handlers = {"summary": study_offline.summary, "notes": study_offline.notes, "qa": study_offline.quiz}
    if req.mode in handlers:
        data = handlers[req.mode](transcript, language)
    else:
        data = study_offline.answer(req.query, transcript, language)
    text = data["answer"]
    c = data.get("citation")
    if c and c.get("start_time") and f"[{c['start_time']}]" not in text:
        text += f"\n\n📍 Best match: [{c['start_time']}]"
    return text


# ---------------------------------------------------------------- router
def build_router(
    process_youtube: Callable,
    generate_ai_response: Callable,
    generate_ai_stream: Callable,
    parse_llm_json: Callable,
    ai_status: Callable,
):
    router = APIRouter(prefix="/api/ext", tags=["chrome-extension"])
    videos = TTLCache(maxsize=200)
    moments_cache = TTLCache(maxsize=400)
    mindmap_cache = TTLCache(maxsize=400)
    status_cache = {"at": 0.0, "value": None}

    @router.get("/status")
    def status():
        # Cached for a few seconds: the side panel polls this.
        if time.time() - status_cache["at"] > 5:
            status_cache["value"] = bool(ai_status().get("ai"))
            status_cache["at"] = time.time()
        return {"ok": True, "ai": status_cache["value"], "cached_videos": len(videos)}

    @router.post("/video")
    def video(req: VideoRequest):
        _check_id(req.video_id)
        cached = videos.get(req.video_id)
        if cached:
            return {**cached, "cached": True}
        if req.transcript:
            transcript = [{"start": round(c.start, 2), "text": c.text.strip()} for c in req.transcript if c.text.strip()]
            title, source = req.title or "YouTube video", "youtube-captions"
        else:
            data = process_youtube(req.video_id)
            if data.get("error"):
                raise HTTPException(status_code=422, detail=data["error"])
            transcript = data.get("transcript") or []
            # YouTube's own title beats the browser hint (which can lag behind SPA navigation).
            title, source = data.get("video_title") or req.title or "YouTube video", "server"
        if not transcript:
            raise HTTPException(status_code=422, detail="This video has no captions to study from.")
        result = {"video_id": req.video_id, "title": title, "transcript": transcript, "source": source}
        videos.set(req.video_id, result)
        return {**result, "cached": False}

    @router.post("/moments")
    def moments(req: AnalysisRequest):
        _check_id(req.video_id)
        transcript = study_offline.parse_transcript(req.transcript_text)
        if not transcript:
            raise HTTPException(status_code=422, detail="Transcript is empty")
        duration = transcript[-1]["start"]
        cached_ai = moments_cache.get(("ai", req.video_id))
        if cached_ai:
            return {"key_moments": cached_ai, "source": "ai", "cached": True}
        if req.quality != "ai":
            fast = moments_cache.get(("fast", req.video_id))
            if not fast:
                fast = _with_seconds(study_offline.key_moments(transcript, 7))
                moments_cache.set(("fast", req.video_id), fast)
            return {"key_moments": fast, "source": "offline"}
        prompt = f"""Split this lecture into 6 to 8 key moments a student would want to jump to.
Return ONLY JSON: {{"key_moments": [{{"time": "MM:SS", "title": "3-6 word title", "desc": "one short sentence"}}]}}
Times must come from the transcript timestamps, in order, spread across the whole video.

Transcript:
{_trim_for_prompt(transcript, "overview main topics")[:30000]}"""
        try:
            parsed = parse_llm_json(generate_ai_response(prompt, json_mode=True))
            raw = parsed.get("key_moments", parsed.get("moments")) if isinstance(parsed, dict) else parsed
            cleaned = _clean_moments(raw, duration)
            if len(cleaned) < 3:
                raise ValueError("too few valid moments")
            moments_cache.set(("ai", req.video_id), cleaned)
            return {"key_moments": cleaned, "source": "ai"}
        except Exception as err:
            print("Extension moments using offline tier:", err)
            return {"key_moments": _with_seconds(study_offline.key_moments(transcript, 7)), "source": "offline"}

    @router.post("/mindmap")
    def mindmap(req: AnalysisRequest):
        _check_id(req.video_id)
        transcript = study_offline.parse_transcript(req.transcript_text)
        if not transcript:
            raise HTTPException(status_code=422, detail="Transcript is empty")
        cached_ai = mindmap_cache.get(("ai", req.video_id))
        if cached_ai:
            return {**cached_ai, "source": "ai", "cached": True}
        if req.quality != "ai":
            return {**study_offline.mindmap(transcript, req.title), "source": "offline"}
        prompt = f"""Build a study mind map of this lecture.
Return ONLY JSON: {{"title": "central topic (max 6 words)", "branches": [{{"title": "main idea", "time": "MM:SS", "children": [{{"title": "sub-idea", "time": "MM:SS"}}]}}]}}
4 to 7 branches, 2 to 4 children each, titles under 6 words, times from the transcript where each idea is explained.

Transcript:
{_trim_for_prompt(transcript, "main ideas concepts")[:30000]}"""
        try:
            parsed = parse_llm_json(generate_ai_response(prompt, json_mode=True))
            if not isinstance(parsed, dict) or not parsed.get("branches"):
                raise ValueError("no branches")
            data = {"title": parsed.get("title") or req.title or "This video", "branches": parsed["branches"][:8]}
            mindmap_cache.set(("ai", req.video_id), data)
            return {**data, "source": "ai"}
        except Exception as err:
            print("Extension mind map using offline tier:", err)
            return {**study_offline.mindmap(transcript, req.title), "source": "offline"}

    @router.post("/chat/stream")
    def chat_stream(req: ChatStreamRequest):
        transcript = study_offline.parse_transcript(req.transcript_text)
        language = study_offline.resolve_language(req.language, req.query)

        focus = ""
        if req.mode == "moment" and req.at is not None and transcript:
            window = [t for t in transcript if req.at - 75 <= t["start"] <= req.at + 45]
            focus = f"\nFOCUS (the student is at {study_offline.fmt(req.at)}):\n{_lines(window)}\n"

        system = f"""You are VidQuery, a friendly, expert AI study assistant inside YouTube.
LANGUAGE: {prompts.language_rule(language)}

{prompts.STYLE}
{prompts.mode_rule(req.mode)}
Write Markdown directly (no JSON, no code fences around the whole answer).
If the student greets you or asks something general, reply naturally in one or two lines.
Video title: {req.title or "unknown"}
{focus}
Transcript with timestamps{" (most relevant excerpts)" if req.mode not in WHOLE_VIDEO_MODES else ""}:
{_trim_for_prompt(transcript, req.query, req.at, FULL_CHARS if req.mode in WHOLE_VIDEO_MODES else QUESTION_CHARS) if transcript else "(no transcript available)"}

REMEMBER THE LANGUAGE: {prompts.language_rule(language)}"""

        messages = [{"role": "system", "content": system}]
        for turn in req.history[-6:]:
            if turn.role in ("user", "assistant") and turn.content.strip():
                messages.append({"role": turn.role, "content": turn.content[:2000]})
        messages.append({"role": "user", "content": f"{req.query}\n\n{prompts.language_reminder(language)}"})

        def events():
            sent_any = False
            try:
                for delta in generate_ai_stream(messages):
                    sent_any = True
                    yield _ndjson({"t": "delta", "d": delta})
                yield _ndjson({"t": "done", "source": "ai", "language": language})
                return
            except Exception as err:
                print("Extension chat stream falling back:", err)
                if sent_any:
                    yield _ndjson({"t": "done", "source": "ai", "language": language, "truncated": True})
                    return
            if not transcript:
                text = ("👋 Open a YouTube video with captions and I'll help you study it." if language == "english"
                        else "👋 Captions wala koi YouTube video kholo, main use padhne mein help karunga.")
            else:
                text = _offline_answer(req, transcript, language)
            yield _ndjson({"t": "delta", "d": text})
            yield _ndjson({"t": "done", "source": "offline", "language": language})

        return StreamingResponse(
            events(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return router
