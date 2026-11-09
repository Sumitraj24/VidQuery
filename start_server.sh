#!/bin/bash
# VidQuery Multi-Device Server & Cloudflare Tunnel Launcher

DIR=""
cd ""

echo "============================================="
echo "  🚀 Starting VidQuery Multi-Device Server   "
echo "============================================="

# 1. Kill any existing process on port 8000
kill -9 $(lsof -t -i:8000) 2>/dev/null

# 2. Start the FastAPI backend
echo "[1/2] Starting Python backend on http://localhost:8000..."
uvicorn app:app --port 8000 &
SERVER_PID=$!

sleep 2

# 3. Start Cloudflare Tunnel
echo "[2/2] Connecting to Cloudflare Tunnel..."
echo "---------------------------------------------"
echo "🌐 YOUR LIVE EXTENSION URL WILL APPEAR BELOW:"
echo "---------------------------------------------"

cloudflared tunnel --url http://localhost:8000

# Cleanup on exit
trap "kill $SERVER_PID 2>/dev/null" EXIT
