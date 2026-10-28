"""Transcript-only study tools used when the LLM gateway is unreachable.

Everything here is deterministic and dependency-free: it works from the
timestamped transcript alone, so search, key moments, summaries, notes,
practice questions and mind maps keep working offline.
"""
import math
import re
from collections import Counter

STOPWORDS = set("""
a about above after again against all also am an and any are aren't as at be because been before being below
between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few
for from further get gets getting go going gonna got had hadn't has hasn't have haven't having he he'd he'll he's
her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself
just know let let's like look lot me more most mustn't my myself no nor not now of off okay on once only or other
ought our ours ourselves out over own really right same say says see shan't she she'd she'll she's should
shouldn't so some something such take than that that's the their theirs them themselves then there there's these
they they'd they'll they're they've thing things think this those through to too um uh under until up us very
want was wasn't way we we'd we'll we're we've well were weren't what what's when when's where where's which while
who who's whom why why's will with won't would wouldn't yeah yes you you'd you'll you're you've your yours yourself
yourselves actually basically kind sort mean going one two also just even still back first next make made use used
using will can could would
""".split())

# Common Hinglish (Hindi in Roman script) function words. Used to detect the
# student's language and kept out of keyword search ("sigmoid kya hai" -> "sigmoid").
HINGLISH_WORDS = set("""
kya kyu kyun kyon kaise kese kaisa kaun kab kahan kitna kitne kitni hai hain ho hota hoti hote tha thi the
mein me main mai mujhe mujhko hum humko tum tumhe aap aapko yeh ye woh wo voh is us iska uska iski uski iske uske
ka ki ke ko se par pe aur ya bhi nahi nahin na mat sirf bas toh to ek do teen kuch sab sabhi bahut zyada kam thoda
batao bataiye bataye samjhao samjhaiye samjha samajh samjhna matlab karta karti karte karo kare karna kiya kiye
hua hui hue raha rahi rahe wala wali wale liye lie chahiye sakta sakti sakte jab tab agar lekin kyunki isliye
accha acha theek thik haan ji bhai yaar video lecture topic namaste namaskar shukriya dhanyavaad
""".split())
STOPWORDS |= HINGLISH_WORDS

_LINE = re.compile(r"^\s*\[(?:(\d+(?:\.\d+)?)s|(\d{1,2}(?::\d{2}){1,2}))\]\s*(.*)$")


def fmt(sec):
    sec = max(0, int(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def parse_transcript(text):
    """Parse '[12.3s] words' or '[1:02] words' lines into [{'start', 'text'}]."""
    out = []
    for line in (text or "").splitlines():
        m = _LINE.match(line)
        if not m:
            continue
        secs_raw, clock, words = m.groups()
        if secs_raw is not None:
            start = float(secs_raw)
        else:
            start = 0
            for part in clock.split(":"):
                start = start * 60 + int(part)
        words = words.strip()
        if words:
            out.append({"start": float(start), "text": words})
    return out


def tokens(text):
    return [w for w in re.findall(r"[a-z][a-z0-9'+-]{1,}", text.lower()) if w not in STOPWORDS and len(w) > 2]


def windows(transcript, seconds=30):
    """Merge caption lines into ~`seconds`-long passages."""
    out, cur = [], None
    for t in transcript:
        if cur is None or t["start"] - cur["start"] >= seconds:
            cur = {"start": t["start"], "end": t["start"], "text": t["text"]}
            out.append(cur)
        else:
            cur["text"] += " " + t["text"]
            cur["end"] = t["start"]
    return out


def chunks(transcript, n):
    """Split the transcript into `n` contiguous, roughly equal-duration sections."""
    if not transcript:
        return []
    total = transcript[-1]["start"] or 1
    n = max(1, min(n, len(transcript)))
    buckets = [[] for _ in range(n)]
    for t in transcript:
        buckets[min(n - 1, int(t["start"] / total * n))].append(t)
    return [b for b in buckets if b]


def _sentence(text, words=24):
    text = re.sub(r"\s+", " ", text).strip()
    parts = text.split()
    snippet = " ".join(parts[:words])
    return snippet[:1].upper() + snippet[1:] + ("…" if len(parts) > words else "")


def _top_terms(section_tokens, doc_freq, n_docs, k=3):
    tf = Counter(section_tokens)
    scored = {w: c * math.log(1 + n_docs / doc_freq[w]) for w, c in tf.items()}
    return [w for w, _ in sorted(scored.items(), key=lambda x: -x[1])[:k]]


def key_moments(transcript, n=6):
    sections = chunks(transcript, n)
    toks = [tokens(" ".join(t["text"] for t in s)) for s in sections]
    df = Counter(w for ts in toks for w in set(ts))
    moments = []
    for s, ts in zip(sections, toks):
        terms = _top_terms(ts, df, len(sections))
        title = " · ".join(w.capitalize() for w in terms) or "Section"
        moments.append({
            "time": fmt(s[0]["start"]),
            "title": title,
            "desc": _sentence(" ".join(t["text"] for t in s[:6]), 22),
        })
    if moments:
        moments[0]["title"] = "Introduction" if len(moments) > 1 else moments[0]["title"]
    return moments


def _rank(query, passages):
    q = tokens(query)
    if not q:
        return []
    # BM25: rare query words (e.g. "sigmoid") outweigh common ones (e.g. "function").
    docs = [tokens(p["text"]) for p in passages]
    df = Counter(w for d in docs for w in set(d))
    n = len(passages) or 1
    avg_len = sum(len(d) for d in docs) / n or 1
    k1, b = 1.2, 0.75
    scored = []
    for p, d in zip(passages, docs):
        tf = Counter(d)
        norm = k1 * (1 - b + b * len(d) / avg_len)
        score = sum(
            math.log(1 + (n - df[w] + .5) / (df[w] + .5)) * tf[w] * (k1 + 1) / (tf[w] + norm)
            for w in set(q) if tf[w]
        )
        # Exact phrases from the question ("sigmoid function") mark the defining passage.
        text = " ".join(d)
        score += sum(1.5 for a, b2 in zip(q, q[1:]) if f"{a} {b2}" in text)
        if score > 0:
            scored.append((score, p))
    scored.sort(key=lambda x: -x[0])
    return [p for _, p in scored]


def is_hinglish(text):
    words = re.findall(r"[a-z]+", (text or "").lower())
    if not words:
        return False
    if re.search(r"[\u0900-\u097F]", text or ""):
        return True  # Devanagari Hindi: answer in Hinglish
    hits = sum(1 for w in words if w in HINGLISH_WORDS and w not in ("video", "lecture", "topic", "to", "me", "the", "is", "us", "do", "na"))
    return hits >= 2 or (hits >= 1 and len(words) <= 4)


def resolve_language(setting, query=""):
    """auto -> follow the student's own writing style; otherwise use the chosen language."""
    setting = (setting or "auto").lower()
    if setting in ("english", "hinglish"):
        return setting
    return "hinglish" if is_hinglish(query) else "english"


# Fixed phrases used by the offline answers, in both languages.
TEXT = {
    "english": {
        "greet": "👋 Hi! I'm running in offline mode right now, so I answer by searching the transcript. "
                 "Ask about a topic from the video, or use Summarize, Study notes and Quiz me.",
        "miss": "🤔 I couldn't find that topic in this video's transcript. Try different keywords, "
                "or search the Transcript tab directly.",
        "found": "📌 Here's what the video says about that:",
        "best": "Best matching passage",
        "overview": "🎯 Overview",
        "covers": "This video covers **{terms}** across {n} sections.",
        "sections": "📚 Section by section",
        "key_terms": "💡 Key terms",
        "questions": "🧠 Questions",
        "answers": "✅ Answers",
        "blank": "Fill in the blank",
        "too_short": "There isn't enough transcript to build questions.",
    },
    "hinglish": {
        "greet": "👋 Hi! Abhi main offline mode mein hoon, isliye transcript search karke jawab de raha hoon. "
                 "Video ke kisi bhi topic ke baare mein poochho, ya Summary, Notes aur Q&A use karo.",
        "miss": "🤔 Yeh topic is video ke transcript mein nahi mila. Thode alag keywords try karo, "
                "ya Transcript tab mein seedha search karo.",
        "found": "📌 Video mein iske baare mein yeh bataya gaya hai:",
        "best": "Sabse matching part",
        "overview": "🎯 Overview",
        "covers": "Yeh video **{terms}** ko {n} sections mein cover karta hai.",
        "sections": "📚 Section by section",
        "key_terms": "💡 Important terms",
        "questions": "🧠 Questions",
        "answers": "✅ Answers",
        "blank": "Khaali jagah bharo",
        "too_short": "Questions banane ke liye transcript kaafi nahi hai.",
    },
}


GREETING = re.compile(r"^\s*(hi|hello|hey|yo|thanks|thank you|shukriya|dhanyavaad|namaste|namaskar|good (morning|evening|afternoon))\b", re.I)


def answer(query, transcript, language="english"):
    t = TEXT.get(language, TEXT["english"])
    # Pure greetings get a hello; "namaste, sigmoid kya hai?" still gets answered.
    if not tokens(GREETING.sub("", query)):
        return {"answer": t["greet"], "citation": None}
    passages = windows(transcript)
    hits = _rank(query, passages)[:3]
    if not hits:
        return {"answer": t["miss"], "citation": None}
    lines = [t["found"], ""]
    lines += [f"- [{fmt(p['start'])}] {_sentence(p['text'], 40)}" for p in hits]
    best = hits[0]
    return {
        "answer": "\n".join(lines),
        "citation": {"start_time": fmt(best["start"]), "end_time": fmt(best["end"] + 5),
                     "title": t["best"]},
    }


def summary(transcript, language="english"):
    t = TEXT.get(language, TEXT["english"])
    moments = key_moments(transcript, 6)
    terms = Counter(tokens(" ".join(x["text"] for x in transcript))).most_common(8)
    lines = [f"## {t['overview']}",
             t["covers"].format(terms=", ".join(w for w, _ in terms[:5]), n=len(moments)),
             "", f"## {t['sections']}"]
    lines += [f"- [{m['time']}] **{m['title']}**: {m['desc']}" for m in moments]
    return {"answer": "\n".join(lines), "citation": None}


def notes(transcript, language="english"):
    t = TEXT.get(language, TEXT["english"])
    lines = []
    sections = chunks(transcript, 6)
    toks = [tokens(" ".join(t["text"] for t in s)) for s in sections]
    df = Counter(w for ts in toks for w in set(ts))
    for s, ts in zip(sections, toks):
        terms = _top_terms(ts, df, len(sections), 3)
        lines.append(f"### [{fmt(s[0]['start'])}] {' · '.join(w.capitalize() for w in terms) or 'Section'}")
        for p in windows(s, 45)[:3]:
            lines.append(f"- {_sentence(p['text'], 28)}")
        lines.append("")
    lines.append(f"**{t['key_terms']}:** " + ", ".join(w for w, _ in Counter(tokens(" ".join(x['text'] for x in transcript))).most_common(10)))
    return {"answer": "\n".join(lines), "citation": None}


def quiz(transcript, language="english", n=5):
    t = TEXT.get(language, TEXT["english"])
    passages = [p for p in windows(transcript, 40) if len(p["text"].split()) > 12]
    if not passages:
        return {"answer": t["too_short"], "citation": None}
    df = Counter(w for p in passages for w in set(tokens(p["text"])))
    step = max(1, len(passages) // n)
    picked = passages[::step][:n]
    q_lines, a_lines = [f"## {t['questions']}"], ["", f"## {t['answers']}"]
    i = 0
    for p in picked:
        sentence = _sentence(p["text"], 30)
        terms = _top_terms(tokens(sentence), df, len(passages), 1)
        if not terms:
            continue
        term = terms[0]
        i += 1
        blank = re.sub(rf"\b{re.escape(term)}\b", "_____", sentence, count=1, flags=re.I)
        q_lines.append(f"{i}. {t['blank']}: “{blank}”")
        a_lines.append(f"{i}. **{term}** [{fmt(p['start'])}]")
    return {"answer": "\n".join(q_lines + a_lines), "citation": None}


def mindmap(transcript, title):
    sections = chunks(transcript, 6)
    toks = [tokens(" ".join(t["text"] for t in s)) for s in sections]
    df = Counter(w for ts in toks for w in set(ts))
    branches = []
    for s, ts in zip(sections, toks):
        terms = _top_terms(ts, df, len(sections), 4)
        if not terms:
            continue
        children = []
        for term in terms[1:]:
            hit = next((t for t in s if term in t["text"].lower()), s[0])
            children.append({"title": term.capitalize(), "time": fmt(hit["start"])})
        branches.append({"title": terms[0].capitalize(), "time": fmt(s[0]["start"]), "children": children})
    return {"title": title or "This video", "branches": branches}
