// Settings + typed client for the VidQuery backend (/api/ext/*).

export const DEFAULT_SETTINGS = {
  apiBase: 'http://localhost:8000',
  language: 'auto', // auto | english | hinglish
  markers: true, // key-moment markers on YouTube's progress bar
  follow: true, // transcript follows playback
  adBlocker: true, // auto-skip and mute ads during study
};

export async function loadSettings() {
  const stored = await chrome.storage.sync.get('vq:settings');
  return { ...DEFAULT_SETTINGS, ...(stored['vq:settings'] || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ 'vq:settings': settings });
}

export class ApiError extends Error {
  constructor(message, { status = 0, offline = false } = {}) {
    super(message);
    this.status = status;
    this.offline = offline; // true when the backend could not be reached at all
  }
}

export class Api {
  constructor(base) {
    this.base = String(base || DEFAULT_SETTINGS.apiBase).replace(/\/+$/, '');
  }

  async request(path, { method = 'GET', body, timeout = 30000, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeout);
    const onAbort = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort);
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const timedOut = ctrl.signal.reason?.name === 'TimeoutError';
      throw new ApiError(timedOut ? 'The server took too long to respond.' : `Can't reach the VidQuery server at ${this.base}.`, { offline: !timedOut });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (!res.ok) {
      let detail = `Request failed (${res.status})`;
      try {
        const data = await res.json();
        detail = typeof data.detail === 'string' ? data.detail : detail;
      } catch (e) { /* not JSON */ }
      throw new ApiError(detail, { status: res.status });
    }
    return res;
  }

  async json(path, opts) {
    return (await this.request(path, opts)).json();
  }

  status() {
    return this.json('/api/ext/status', { timeout: 5000 });
  }

  video(body) {
    return this.json('/api/ext/video', { method: 'POST', body, timeout: 60000 });
  }

  moments(body) {
    return this.json('/api/ext/moments', { method: 'POST', body, timeout: body.quality === 'ai' ? 120000 : 15000 });
  }

  mindmap(body) {
    return this.json('/api/ext/mindmap', { method: 'POST', body, timeout: body.quality === 'ai' ? 120000 : 15000 });
  }

  /** Streams an answer. Calls onDelta(text) per chunk; resolves with the final event. */
  async chatStream(body, onDelta, signal) {
    const res = await this.request('/api/ext/chat/stream', { method: 'POST', body, timeout: 120000, signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final = { source: 'ai' };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.t === 'delta') onDelta(ev.d);
        else if (ev.t === 'done') final = ev;
      }
    }
    return final;
  }
}
