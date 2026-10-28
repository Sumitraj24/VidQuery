# 🎬 VidQuery — AI-Powered Video Learning & Study Assistant

**VidQuery** is an intelligent video-study platform designed to transform long lectures and educational videos into interactive, searchable, and structured study material. Search for any concept, get instant AI explanations with direct timestamped video citations, auto-generate key moments, and visualize ideas through notes and mind maps.

---

## ✨ Features

- ⏱ **Deep Concept & Topic Search**: Search for any topic within the video and jump immediately to exact timestamped segments.
- 🤖 **Interactive Video Q&A**: Ask questions directly about lecture content and receive synthesized answers with timestamped references.
- ⚡ **FreeLLMAPI AI Engine**: Powered by FreeLLMAPI unified gateway with automatic model routing and zero rate-limit friction.
- 📌 **Auto-Extracted Key Moments**: Automatically detects 5–8 pivotal sections of the video with start times, titles, and brief summaries.
- 🔒 **Supabase Authentication**: User registration, login, session cookies, and user-specific chat history storage.
- 🎨 **Modern Glassmorphic UI**: Responsive web interface with interactive YouTube player synchronization, live transcript highlights, and smooth animations.

---

## 🛠 Tech Stack

- **Backend**: [FastAPI](https://fastapi.tiangolo.com/), [Uvicorn](https://www.uvicorn.org/) (Python 3.10+)
- **Templates & Frontend**: Jinja2, Vanilla CSS3, JavaScript (ES6+), YouTube IFrame Player API
- **Authentication & Database**: [Supabase](https://supabase.com/)
- **Transcript Extraction**: [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api), [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- **AI / LLM Clients**: [OpenAI Python SDK](https://github.com/openai/openai-python), [FreeLLMAPI](http://127.0.0.1:31415)
- **Deployment**: [Vercel](https://vercel.com/) ready (`vercel.json` included)

---

## 🚀 Getting Started

### 1. Prerequisites

- Python 3.10 or higher
- `git` installed
- FreeLLMAPI running locally (default at `http://127.0.0.1:31415`) or cloud endpoint
- (Optional) Supabase project credentials for authentication and chat history

---

### 2. Clone the Repository

```bash
git clone https://github.com/your-username/VidQuery.git
cd VidQuery
```

---

### 3. Set Up Virtual Environment

```bash
# Create virtual environment
python3 -m venv .venv

# Activate virtual environment
# On macOS / Linux:
source .venv/bin/activate
# On Windows:
# .venv\Scripts\activate
```

---

### 4. Install Dependencies

```bash
pip install -r requirements.txt
```

---

### 5. Configure Environment Variables

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Open `.env` and fill in your keys:

```env
# Supabase Configuration (Optional - basic features work without Supabase)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-supabase-anon-or-service-key

# FreeLLMAPI Gateway Configuration
FREELLMAPI_BASE_URL=http://127.0.0.1:31415/v1
FREELLMAPI_API_KEY=your_freellmapi_unified_key_here
FREELLMAPI_MODEL=auto
```

---

### 6. Run the Application Locally

```bash
# Option 1: Directly using python
python app.py

# Option 2: Using uvicorn with hot-reload
uvicorn app:app --reload --port 8000
```

Open your browser and navigate to:
```
http://localhost:8000
```

#### 🔑 Demo Login Credentials
You can log in without Supabase using the built-in demo account:
- **Email**: `demo@vidquery.com`
- **Password**: `demo123`
*(Or simply click the **"Use Demo"** button on the sign-in modal for 1-click access!)*

---

## 🔌 Offline Mode

If the FreeLLMAPI gateway is not running, VidQuery keeps working. Chat, key moments, summaries, study notes and Q&A fall back to transcript search (`study_offline.py`). When the gateway comes back, AI answers resume automatically.

## 🗄 Chat History Database

To save chat history to Supabase for signed-in users, run [`supabase/chat_history.sql`](supabase/chat_history.sql) in the Supabase SQL editor. It replaces a `chat_history` table whose `user_id` was `bigint` (Supabase user ids are UUIDs, so inserts always failed).

## 📂 Project Structure

```text
VidQuery/
├── app.py                  # Core FastAPI backend & API routes
├── requirements.txt        # Python package dependencies
├── vercel.json             # Vercel serverless deployment config
├── .env.example            # Sample environment variables
├── .gitignore              # Git ignore rules for secrets and build files
├── README.md               # Project documentation
├── static/
│   ├── style.css           # Global stylesheet & landing page styles
│   ├── dashboard.css       # Video workspace & dashboard stylesheet
│   └── images/             # Static graphics and demo assets
└── templates/
    ├── base.html           # Base layout template with auth modal
    ├── home.html           # Landing page with hero section & features
    ├── dashboard.html      # Main study dashboard & interactive video player
    ├── profile.html        # User profile settings page
    ├── login.html          # Standalone sign-in page
    └── register.html       # Standalone registration page
```

---

## 🌐 Deploy to Vercel

VidQuery is configured for serverless deployment on Vercel:

1. Push your code to GitHub (ensure `.env` is NOT committed).
2. Import the repository into your [Vercel Dashboard](https://vercel.com/dashboard).
3. In the project settings, add your Environment Variables (`SUPABASE_URL`, `SUPABASE_KEY`, `FREELLMAPI_BASE_URL`, `FREELLMAPI_API_KEY`, `FREELLMAPI_MODEL`).
4. Click **Deploy**.

---

## 📄 License

This project is licensed under the MIT License — see the LICENSE file for details.
