# VidQuery for Chrome

Study any YouTube lecture without leaving YouTube. VidQuery opens in Chrome's side panel next to the video and talks to your VidQuery backend.

## Features

- **Chat with the video.** Answers stream in as they're written, with clickable timestamps that jump the real YouTube player. English, Hinglish, or Auto (matches how you type). Follow-up questions remember the conversation.
- **Explain this moment.** One click (or `Alt+Shift+E`) explains whatever is playing right now.
- **Summary, Notes and Quiz** in one click.
- **Key moments.** Shown instantly, then upgraded by the AI in the background. They also appear as **blue markers on YouTube's progress bar**: hover to preview, click to jump.
- **Transcript.** Search with next/previous match, live highlight of the line being spoken, optional follow-along scrolling, copy.
- **Mind map.** Instant map, upgraded to an AI map. Every idea jumps to where it's explained.
- **Notes per video.** Autosaved, one-click timestamps, preview with clickable times, export to Markdown, "Save to notes" on any answer.
- **Right-click → Ask VidQuery** about any selected text on YouTube.
- **VidQuery button in the player controls**, and `Alt+Shift+Q` to open the panel.
- **Ads handled.** While an ad plays, timestamp jumps wait and run as soon as the lecture resumes.
- **Works offline.** If the AI gateway is down, everything still answers from the transcript, labelled "Offline".

## Install (developer mode)

1. Start the backend from the `VidQuery` folder:
   ```bash
   .venv/bin/python -m uvicorn app:app --port 8000
   ```
   For AI answers, also open the **FreeLLMAPI** app.
2. In Chrome, go to `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension` folder.
4. Pin VidQuery from the puzzle-piece menu, open any YouTube video and click the VidQuery icon (or press `Alt+Shift+Q`).

YouTube tabs that were already open are connected automatically; if anything looks stale, refresh the tab.

## Settings

Click the gear in the panel to change the backend URL (default `http://localhost:8000`), the default reply language, progress-bar markers and transcript follow-along. A non-localhost URL asks for permission to reach that server. Shortcuts can be changed at `chrome://extensions/shortcuts`.

## Privacy

Chats, notes and cached analysis are stored only in this browser (`chrome.storage.local`). The transcript and your questions are sent only to the backend URL you configure. Permissions: `sidePanel`, `storage`, `unlimitedStorage` (caching transcripts), `scripting` (connecting already-open YouTube tabs), `contextMenus`, and host access to `youtube.com` and `localhost`.

## How it's built

| Part | File | Job |
| --- | --- | --- |
| Service worker | `background.js` | Opens the side panel, shortcuts, context menu, connects open tabs |
| Content script | `content/content.js` | Video + playback sync, seeking, progress-bar markers, player button, ad handling |
| Page bridge | `content/page-bridge.js` | Reads caption tracks from YouTube's player (MAIN world) |
| Side panel | `sidepanel/*` | The app UI |
| Libraries | `lib/api.js`, `lib/storage.js`, `lib/markdown.js` | Backend client with streaming, local storage, safe Markdown |

Backend endpoints live in `../extension_api.py` under `/api/ext/*`: `status`, `video`, `moments`, `mindmap` and `chat/stream` (NDJSON streaming). AI calls race the fastest FreeLLMAPI models (`FREELLMAPI_FAST_MODELS`) and fall back to transcript-only answers when the gateway is unavailable.
