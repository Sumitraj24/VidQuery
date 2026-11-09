// Tiny, XSS-safe Markdown renderer for assistant answers and notes.
// Everything is escaped first; only a small, known set of formatting is added back.

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function parseTime(str) {
  const parts = String(str ?? '').trim().split(':').map((n) => parseInt(n, 10));
  if (!parts.length || parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const TS = /\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[-–]\s*(\d{1,2}:\d{2}(?::\d{2})?))?\]|\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;

function inline(text, opts) {
  let out = text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  if (opts.seekable) {
    out = out.replace(TS, (match, a, b, c) => {
      const t = a || c;
      const secs = parseTime(t);
      if (secs === null || (opts.duration && secs > opts.duration + 5)) return match;
      const label = b ? `${t}–${b}` : t;
      return `<button type="button" class="ts" data-seek="${secs}" title="Jump to ${t}">▶ ${label}</button>`;
    });
  }
  return out;
}

export function renderMarkdown(src, opts = {}) {
  const lines = esc(String(src ?? '').replace(/\r/g, '')).split('\n');
  let html = '';
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      html += `<p>${para.map((l) => inline(l, opts)).join('<br>')}</p>`;
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html += `</${list}>`;
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if (!line) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { flushPara(); flushList(); html += `<h4>${inline(m[1], opts)}</h4>`; continue; }
    if (/^(-{3,}|\*{3,})$/.test(line)) { flushPara(); flushList(); html += '<hr>'; continue; }
    if ((m = line.match(/^[-*•]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(m[1], opts)}</li>`;
      continue;
    }
    if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(m[1], opts)}</li>`;
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return html;
}
