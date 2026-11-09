"""Prompt building blocks shared by the web app (/api/chat) and the Chrome extension (/api/ext/*)."""

LANGUAGE_RULES = {
    "english": "Write in clear, simple English.",
    "hinglish": (
        "Write in Hinglish: friendly conversational Hindi written ONLY in Roman (English) letters, "
        "mixed naturally with English, the way Indian students talk. Keep technical terms in English. "
        "Example: \"Sigmoid function ek squishing function hai jo kisi bhi number ko 0 aur 1 ke beech le aata hai.\" "
        "Never use Devanagari script. This applies to EVERYTHING you write: questions, answers, headings and bullets. "
        "Example question: \"**Q1.** Input layer mein kitne neurons hote hain?\""
    ),
}

STYLE = """STYLE (write like ChatGPT at its best: accurate, to the point, engaging):
- Lead with the direct answer in 1-2 short sentences. No filler, no restating the question, no "Great question!".
- Then, only if useful, 2-5 crisp bullet points ("- ") with **bold** key terms.
- Keep paragraphs to 1-2 sentences, separated by line breaks.
- Use a few relevant emojis (like 💡 🎯 ✅ 📌 🧠 ⚡) to make it lively, about one per paragraph or heading, never one on every bullet.
- Add [MM:SS] timestamps from the transcript next to the points they support.
- Be precise: use only facts from the transcript; never invent details. If the video doesn't cover it, say so in one line.
- For a simple greeting, reply in one or two friendly lines."""

MODE_RULES = {
    "summary": "TASK: a crisp summary. Start with a 1-line 🎯 gist, then 4-6 sections as '### emoji Title' each with 2-3 short bullets and a [MM:SS] timestamp. End with a '✅ Key takeaway' line.",
    "notes": "TASK: exam-ready study notes. Use '### emoji Topic' headings with short bullets; put definitions as '**Term**: meaning'. Include formulas if any. Add [MM:SS] timestamps. End with '📝 Quick revision' (3 bullets).",
    "qa": "TASK: 5 practice questions. Format each as '**Q1.** question' on one line, then '✅ **Answer:** answer in at most 2 short lines [MM:SS]'. No extra notes after answers. Mix easy and tricky questions. Leave a blank line between questions.",
    "moment": "TASK: explain what is happening at the given moment of the video, using the FOCUS excerpt first and the full transcript only for context. 2-4 short bullets, then a one-line 💡 takeaway.",
    "chat": "TASK: answer the student's question directly. Usually 40-120 words.",
}


def mode_rule(mode):
    return MODE_RULES.get(mode or "chat", MODE_RULES["chat"])


def language_rule(language):
    return LANGUAGE_RULES.get(language, LANGUAGE_RULES["english"])


def language_reminder(language):
    """Appended to the user message: models follow the language far more reliably there."""
    return f"(Reply language: {'Hinglish, in Roman script' if language == 'hinglish' else 'English'})"
