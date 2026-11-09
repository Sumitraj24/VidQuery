// VidQuery side panel controller.
import { Api, ApiError, loadSettings, saveSettings } from '../lib/api.js';
import * as store from '../lib/storage.js';
import { esc, fmt, parseTime, renderMarkdown } from '../lib/markdown.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const MM_COLORS = ['#4f46e5', '#0284c7', '#16a34a', '#ef4444', '#9333ea', '#f59e0b', '#0d9488', '#db2777'];
const QUICK = {
  summary: { mode: 'summary', label: '📄 Summarize this video', query: 'Summarize this video.' },
  notes: { mode: 'notes', label: '📝 Make study notes', query: 'Make exam-ready study notes for this video.' },
  qa: { mode: 'qa', label: '🧠 Quiz me', query: 'Give me 5 practice questions with answers.' },
};
const SUGGESTIONS = [
  ['🎯', 'What are the 3 key takeaways?'],
  ['💡', 'Explain the hardest concept simply'],
  ['📚', 'What should I revise before an exam?'],
  ['❓', 'What questions could come from this?'],
];

const S = {
  settings: null,
  api: null,
  windowId: null,
  tabId: null,
  video: null, // { id, title, transcript, moments, momentsSource, mindmap, mindmapSource }
  transcriptText: '',
  live: { currentTime: 0, duration: 0, paused: true },
  view: null,
  tab: 'chat',
  chat: [],
  streaming: null, // AbortController while an answer streams
  ai: null, // true | false | null (unknown)
  serverOk: null,
  loadToken: 0,
  activeMoment: -1,
  activeLine: -1,
  userScrolledAt: 0,
  search: { q: '', hits: [], idx: -1 },
  notesTimer: null,
  momentsUpgrading: false,
  mindmapLoading: false,
};

// =====================================================================
// Utilities
// =====================================================================
function parseVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'www.youtube.com' && u.hostname !== 'youtube.com') return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}
const thumb = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
const cleanTitle = (t) => String(t || '').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '').trim();

function toast(title, sub = '') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  $('#toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 3200);
}

function showView(name) {
  S.view = name;
  for (const v of ['Empty', 'Video', 'Server', 'Settings']) $(`#view${v}`).hidden = v.toLowerCase() !== name;
}

async function tabMessage(msg) {
  if (S.tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(S.tabId, msg);
  } catch (e) {
    return null;
  }
}

// The content script may be missing on tabs opened before install/update.
async function ensureContentScript() {
  if (await tabMessage({ type: 'vq:ping' })) return true;
  await chrome.runtime.sendMessage({ type: 'vq:inject', tabId: S.tabId }).catch(() => {});
  return !!(await tabMessage({ type: 'vq:ping' }));
}

function buildTranscriptText(transcript) {
  return transcript.map((t) => `[${fmt(t.start)}] ${t.text}`).join('\n');
}

const md = (text) => renderMarkdown(text, { seekable: true, duration: S.live.duration || lastStart() + 30 });
const lastStart = () => S.video?.transcript?.at(-1)?.start || 0;

// =====================================================================
// Connection status
// =====================================================================
async function checkStatus() {
  try {
    const st = await S.api.status();
    S.serverOk = true;
    S.ai = !!st.ai;
  } catch (e) {
    S.serverOk = false;
    S.ai = false;
  }
  const chip = $('#statusChip');
  chip.className = 'status ' + (!S.serverOk ? 'down' : S.ai ? 'ok' : 'warn');
  $('#statusText').textContent = !S.serverOk ? 'Server off' : S.ai ? 'AI online' : 'Offline mode';
  chip.title = !S.serverOk
    ? `Can't reach ${S.api.base}`
    : S.ai ? 'AI answers are on' : 'The AI gateway is unreachable. Answers come from the transcript.';
  if (!S.serverOk && S.view === 'video' && !S.video?.transcript) showServerOff();
  if (S.serverOk && S.view === 'server') syncActiveTab(true);
  return S.serverOk;
}

function showServerOff() {
  $('#serverUrl').textContent = S.api.base;
  showView('server');
}

// =====================================================================
// Tab tracking
// =====================================================================
async function syncActiveTab(force = false) {
  const [tab] = await chrome.tabs.query({ active: true, windowId: S.windowId });
  if (!tab) return;
  S.tabId = tab.id;
  const id = parseVideoId(tab.url || '');
  if (!id) {
    if (S.view !== 'settings') renderEmpty();
    S.video = null;
    return;
  }
  if (!force && S.video?.id === id && S.view === 'video') return;
  if (S.view === 'settings' && !force) return;
  loadVideo(id, cleanTitle(tab.title));
}

async function renderEmpty() {
  showView('empty');
  const { 'vq:onboarding': onboarding } = await chrome.storage.local.get('vq:onboarding');
  $('#onboard').hidden = onboarding === false;
  const recent = await store.recentVideos(6);
  $('#recentWrap').hidden = !recent.length;
  $('#recentList').innerHTML = recent.map((r) => `
    <button type="button" class="recent-item" data-open="${esc(r.id)}">
      <img src="${thumb(r.id)}" alt="" loading="lazy"><b>${esc(r.title)}</b>
    </button>`).join('');
}

// =====================================================================
// Loading a video
// =====================================================================
async function loadVideo(id, titleHint) {
  const token = ++S.loadToken;
  abortStream();
  S.video = { id, title: titleHint || 'YouTube video' };
  S.transcriptText = '';
  S.activeMoment = S.activeLine = -1;
  S.search = { q: '', hits: [], idx: -1 };
  $('#searchInput').value = '';
  $('#searchHits').textContent = '';
  showView('video');
  renderCard();
  setStatus('loading', 'Opening video…');
  renderMomentsSkeleton();
  $('#transcript').innerHTML = skeletonLines(8);
  $('#mindmap').innerHTML = '';
  loadChat(id);
  loadNotes(id);
  ensureContentScript().then(async () => {
    const st = await tabMessage({ type: 'vq:getState' });
    if (st && st.videoId === id) applyLive(st);
  });

  const cached = await store.getVideo(id);
  if (token !== S.loadToken) return;
  if (cached?.transcript?.length) {
    S.video = { ...cached, title: cached.title || titleHint };
    afterTranscript();
    renderMoments();
    pushMarkers();
    setStatus('ready');
    if (cached.momentsSource !== 'ai') upgradeMoments(token);
    return;
  }

  try {
    setStatus('loading', 'Reading captions…');
    await ensureContentScript();
    const res = await tabMessage({ type: 'vq:getCaptions' });
    if (token !== S.loadToken) return;
    if (!res?.captions) setStatus('loading', 'Fetching transcript…');
    const data = await S.api.video({ video_id: id, title: titleHint, transcript: res?.captions || undefined });
    if (token !== S.loadToken) return;
    S.video = { id, title: data.title || titleHint, transcript: data.transcript, transcriptSource: data.source };
    afterTranscript();
    setStatus('loading', 'Finding key moments…');
    const fast = await S.api.moments({ video_id: id, transcript_text: S.transcriptText, quality: 'fast' });
    if (token !== S.loadToken) return;
    S.video.moments = fast.key_moments;
    S.video.momentsSource = fast.source;
    renderMoments();
    pushMarkers();
    setStatus('ready');
    store.saveVideo(S.video);
    if (fast.source !== 'ai') upgradeMoments(token);
  } catch (err) {
    if (token !== S.loadToken) return;
    if (err instanceof ApiError && err.offline) {
      showServerOff();
      return;
    }
    setStatus('error', err.message || 'Something went wrong');
    const retry = `<div class="placeholder"><b>Couldn't load this video</b>${esc(err.message || '')}<br><button type="button" class="btn-ghost" data-retry>Try again</button></div>`;
    $('#moments').innerHTML = retry;
    $('#transcript').innerHTML = retry;
  }
}

function afterTranscript() {
  S.transcriptText = buildTranscriptText(S.video.transcript);
  renderCard();
  renderTranscript();
  refreshComposer();
}

function renderCard() {
  const v = S.video;
  $('#vThumb').src = thumb(v.id);
  $('#vTitle').textContent = v.title || 'YouTube video';
  $('#vTitle').title = v.title || '';
}

function setStatus(kind, text = '') {
  const el = $('#vStatus');
  if (kind === 'loading') el.innerHTML = `<span class="spinner"></span>${esc(text)}`;
  else if (kind === 'error') el.innerHTML = `<span style="color:#ef4444">⚠ ${esc(text)}</span>`;
  else {
    const lines = S.video?.transcript?.length || 0;
    el.textContent = lines ? `${lines.toLocaleString()} lines · ${fmt(S.live.duration || lastStart())}` : '';
  }
}

async function upgradeMoments(token) {
  if (S.momentsUpgrading || !S.video?.transcript) return;
  if (S.ai === null) await checkStatus();
  if (!S.ai) { renderMomentsBadge(); return; }
  S.momentsUpgrading = true;
  renderMomentsBadge();
  try {
    const res = await S.api.moments({ video_id: S.video.id, transcript_text: S.transcriptText, quality: 'ai' });
    if (token !== S.loadToken) return;
    if (res.source === 'ai') {
      S.video.moments = res.key_moments;
      S.video.momentsSource = 'ai';
      renderMoments();
      pushMarkers();
      store.saveVideo(S.video);
      if (S.tab === 'moments') toast('✨ AI key moments ready');
    }
  } catch (e) {
    /* keep the fast moments */
  } finally {
    S.momentsUpgrading = false;
    if (token === S.loadToken) renderMomentsBadge();
  }
}

// =====================================================================
// Live playback sync
// =====================================================================
function applyLive(st) {
  if (st.ad || st.currentTime == null) {
    $('#vTime').textContent = 'Ad playing…';
    $('#vLive').classList.add('paused');
    return;
  }
  S.live = { currentTime: st.currentTime || 0, duration: st.duration || S.live.duration, paused: !!st.paused };
  $('#vTime').textContent = `${fmt(S.live.currentTime)}${S.live.duration ? ' / ' + fmt(S.live.duration) : ''}`;
  $('#vLive').classList.toggle('paused', S.live.paused);
  if (st.title && S.video && !S.video.titleLocked && cleanTitle(st.title) && S.video.title !== cleanTitle(st.title) && !S.video.transcript) {
    S.video.title = cleanTitle(st.title);
    renderCard();
  }
  highlightMoment();
  highlightLine();
}

function highlightMoment() {
  const ms = S.video?.moments || [];
  let idx = -1;
  ms.forEach((m, i) => { if (m.seconds <= S.live.currentTime + 0.5) idx = i; });
  if (idx === S.activeMoment) return;
  S.activeMoment = idx;
  $$('.moment').forEach((el, i) => el.classList.toggle('active', i === idx));
}

function highlightLine() {
  const tr = S.video?.transcript;
  if (!tr?.length) return;
  let lo = 0, hi = tr.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tr[mid].start <= S.live.currentTime) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx === S.activeLine) return;
  $(`.tl[data-i="${S.activeLine}"]`)?.classList.remove('now');
  S.activeLine = idx;
  const el = $(`.tl[data-i="${idx}"]`);
  if (!el) return;
  el.classList.add('now');
  const following = S.settings.follow && S.tab === 'transcript' && !S.search.q && !S.live.paused && Date.now() - S.userScrolledAt > 4000;
  if (following) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function seek(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return;
  const res = await tabMessage({ type: 'vq:seek', seconds });
  if (res?.ad) { toast('📺 An ad is playing', `VidQuery will jump to ${fmt(seconds)} as soon as it ends.`); return; }
  if (!res?.ok) {
    await ensureContentScript();
    const again = await tabMessage({ type: 'vq:seek', seconds });
    if (!again?.ok) toast('Couldn’t reach the YouTube player', 'Refresh the YouTube tab and try again.');
  }
}

function pushMarkers() {
  if (!S.video?.moments) return;
  tabMessage({
    type: 'vq:setMoments',
    videoId: S.video.id,
    show: S.settings.markers,
    moments: S.video.moments.map((m) => ({ seconds: m.seconds ?? parseTime(m.time) ?? 0, title: m.title })),
  });
}

// =====================================================================
// Moments
// =====================================================================
function renderMomentsSkeleton() {
  $('#moments').innerHTML = Array.from({ length: 5 }, () => `
    <div class="moment" style="pointer-events:none"><div class="skel" style="width:44px;height:22px"></div>
    <div><div class="skel" style="height:14px;width:70%"></div><div class="skel" style="height:11px;width:92%;margin-top:7px"></div></div></div>`).join('');
  $('#momentsBadge').textContent = '';
}

function renderMoments() {
  const ms = (S.video.moments || []).map((m) => ({ ...m, seconds: m.seconds ?? parseTime(m.time) ?? 0 }));
  S.video.moments = ms;
  S.activeMoment = -1;
  $('#moments').innerHTML = ms.length ? ms.map((m, i) => `
    <button type="button" class="moment" data-seek="${m.seconds}" style="animation-delay:${i * 0.04}s">
      <span class="t">${esc(fmt(m.seconds))}</span>
      <span><b>${esc(m.title)}</b>${m.desc ? `<small>${esc(m.desc)}</small>` : ''}</span>
    </button>`).join('') : '<div class="placeholder"><b>No key moments yet</b>The transcript is still fully searchable.</div>';
  renderMomentsBadge();
  highlightMoment();
}

function renderMomentsBadge() {
  const b = $('#momentsBadge');
  if (!S.video?.moments) { b.textContent = ''; b.className = 'badge'; return; }
  if (S.momentsUpgrading) { b.className = 'badge working'; b.textContent = 'Enhancing with AI…'; return; }
  const ai = S.video.momentsSource === 'ai';
  b.className = 'badge ' + (ai ? 'ai' : 'offline');
  b.textContent = ai ? `✨ ${S.video.moments.length} AI key moments` : `⚡ ${S.video.moments.length} quick moments (offline)`;
}

// =====================================================================
// Transcript + search
// =====================================================================
function skeletonLines(n) {
  return Array.from({ length: n }, (_, i) => `<div class="tl" style="pointer-events:none"><div class="skel" style="height:12px;width:36px"></div><div class="skel" style="height:12px;width:${60 + ((i * 17) % 35)}%"></div></div>`).join('');
}

function renderTranscript() {
  const tr = S.video.transcript || [];
  $('#transcript').innerHTML = tr.length
    ? tr.map((t, i) => `<div class="tl" data-i="${i}" data-seek="${t.start}"><span class="t">${fmt(t.start)}</span><span class="x">${esc(t.text)}</span></div>`).join('')
    : '<div class="placeholder"><b>No transcript</b>This video has no captions.</div>';
  S.activeLine = -1;
  highlightLine();
}

let searchTimer;
function runSearch() {
  const q = $('#searchInput').value.trim().toLowerCase();
  const tr = S.video?.transcript || [];
  // Restore lines highlighted by the previous search.
  for (const i of S.search.hits) {
    const el = $(`.tl[data-i="${i}"] .x`);
    if (el) el.textContent = tr[i].text;
    $(`.tl[data-i="${i}"]`)?.classList.remove('hit-current');
  }
  S.search = { q, hits: [], idx: -1 };
  if (!q) { $('#searchHits').textContent = ''; return; }
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  tr.forEach((t, i) => {
    if (!t.text.toLowerCase().includes(q)) return;
    S.search.hits.push(i);
    const el = $(`.tl[data-i="${i}"] .x`);
    if (el) el.innerHTML = esc(t.text).replace(re, '<mark>$1</mark>');
  });
  if (S.search.hits.length) gotoHit(0);
  else $('#searchHits').textContent = '0 results';
}

function gotoHit(idx) {
  const hits = S.search.hits;
  if (!hits.length) return;
  $(`.tl[data-i="${hits[S.search.idx]}"]`)?.classList.remove('hit-current');
  S.search.idx = (idx + hits.length) % hits.length;
  const el = $(`.tl[data-i="${hits[S.search.idx]}"]`);
  el?.classList.add('hit-current');
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('#searchHits').textContent = `${S.search.idx + 1}/${hits.length}`;
}

// =====================================================================
// Mind map
// =====================================================================
async function loadMindmap(force = false) {
  if (!S.video?.transcript || S.mindmapLoading) return;
  const v = S.video;
  if (v.mindmap && !force) { renderMindmap(); return; }
  S.mindmapLoading = true;
  $('#mindmapRegen').disabled = true;
  const token = S.loadToken;
  try {
    if (!v.mindmap || force) {
      if (!v.mindmap) {
        $('#mindmap').innerHTML = `<div class="mm-root-wrap"><div class="skel" style="width:70%;height:42px;border-radius:14px"></div></div>
          <div class="mm-branches" style="border-top-color:#e2e8f0">${Array.from({ length: 4 }, () => '<div class="skel" style="height:110px;border-radius:14px"></div>').join('')}</div>`;
        const fast = await S.api.mindmap({ video_id: v.id, title: v.title, transcript_text: S.transcriptText, quality: 'fast' });
        if (token !== S.loadToken) return;
        v.mindmap = fast;
        v.mindmapSource = fast.source;
        renderMindmap();
      }
      if (S.ai === null) await checkStatus();
      if (S.ai && (v.mindmapSource !== 'ai' || force)) {
        setBadge('#mindmapBadge', 'working', 'Building an AI mind map…');
        const ai = await S.api.mindmap({ video_id: v.id, title: v.title, transcript_text: S.transcriptText, quality: 'ai' });
        if (token !== S.loadToken) return;
        if (ai.source === 'ai') {
          v.mindmap = ai;
          v.mindmapSource = 'ai';
          renderMindmap();
          if (S.tab === 'mindmap') toast('✨ AI mind map ready');
        }
      }
      store.saveVideo(v);
    }
  } catch (err) {
    if (!v.mindmap) $('#mindmap').innerHTML = `<div class="placeholder"><b>Couldn't build the mind map</b>${esc(err.message || '')}</div>`;
  } finally {
    S.mindmapLoading = false;
    $('#mindmapRegen').disabled = false;
    if (S.video === v) renderMindmapBadge();
  }
}

function setBadge(sel, kind, text) {
  const b = $(sel);
  b.className = `badge ${kind}`;
  b.textContent = text;
}

function renderMindmapBadge() {
  const v = S.video;
  if (!v?.mindmap) return setBadge('#mindmapBadge', '', '');
  if (v.mindmapSource === 'ai') setBadge('#mindmapBadge', 'ai', '✨ AI mind map');
  else setBadge('#mindmapBadge', 'offline', S.ai ? '⚡ Quick map' : '⚡ Quick map (offline)');
}

function mapNode(node, cls, inner) {
  const secs = node.time ? parseTime(node.time) : null;
  const attr = secs != null ? ` data-seek="${secs}"` : '';
  return `<button type="button" class="${cls}"${attr}>${inner}${secs != null ? `<span class="mm-time">${esc(fmt(secs))}</span>` : ''}</button>`;
}

function renderMindmap() {
  const map = S.video.mindmap;
  const branches = (map.branches || []).filter((b) => b && b.title);
  $('#mindmap').innerHTML = `
    <div class="mm-root-wrap"><div class="mm-root">${esc(map.title || S.video.title)}</div></div>
    <div class="mm-branches">
      ${branches.map((b, i) => {
        const c = MM_COLORS[i % MM_COLORS.length];
        return `<div class="mm-branch" style="animation-delay:${0.06 * i + 0.08}s">
          ${mapNode(b, 'mm-main', `<span class="mm-dot" style="background:${c};box-shadow:0 4px 10px ${c}55">${i + 1}</span><span class="mm-title">${esc(b.title)}</span>`)}
          <div class="mm-children">${(b.children || []).filter((x) => x && x.title).map((x) => mapNode(x, 'mm-child', `<span>${esc(x.title)}</span>`)).join('')}</div>
        </div>`;
      }).join('')}
    </div>`;
  renderMindmapBadge();
}

// =====================================================================
// Chat
// =====================================================================
async function loadChat(id) {
  S.chat = await store.getChat(id);
  if (S.video?.id !== id) return;
  renderThread();
}

function renderWelcome() {
  $('#thread').innerHTML = `
    <div class="welcome">
      <div class="orb"><svg class="i" style="width:20px;height:20px"><use href="#i-spark"/></svg></div>
      <h2>Ask this video anything</h2>
      <p>Answers come from the transcript, with timestamps that jump the video. Type in English or Hinglish.</p>
      <div class="suggest">${SUGGESTIONS.map(([e, q]) => `<button type="button" data-suggest="${esc(q)}"><span>${e}</span>${esc(q)}</button>`).join('')}</div>
    </div>`;
}

function renderThread() {
  if (!S.chat.length) { renderWelcome(); return; }
  $('#thread').innerHTML = '';
  S.chat.forEach((m, i) => appendMessage(m, i));
  scrollThread(true);
}

function appendMessage(m, index) {
  const el = document.createElement('div');
  el.className = `msg ${m.role === 'user' ? 'user' : 'ai'}`;
  el.dataset.index = index;
  if (m.role === 'user') {
    el.innerHTML = `<div class="bubble">${esc(m.label || m.content)}</div>`;
  } else {
    el.innerHTML = `<div class="avatar">AI</div><div class="body">
      ${m.source === 'offline' ? '<span class="tag offline" title="The AI gateway is unreachable, so this came from the transcript.">Offline answer · from the transcript</span>' : ''}
      <div class="prose">${m.error ? `<p class="err">${esc(m.error)}</p>` : md(m.content)}</div>
      ${m.error ? '' : actionsHTML()}
    </div>`;
  }
  $('.welcome')?.remove();
  $('#thread').appendChild(el);
  return el;
}

function actionsHTML() {
  return `<div class="msg-actions">
    <button type="button" data-act="copy"><svg class="i"><use href="#i-copy"/></svg>Copy</button>
    <button type="button" data-act="save"><svg class="i"><use href="#i-save"/></svg>Save to notes</button>
    <button type="button" data-act="regen"><svg class="i"><use href="#i-refresh"/></svg>Regenerate</button>
  </div>`;
}

function scrollThread(instant = false) {
  const t = $('#thread');
  if (instant) t.style.scrollBehavior = 'auto';
  t.scrollTop = t.scrollHeight;
  if (instant) requestAnimationFrame(() => (t.style.scrollBehavior = ''));
}

function abortStream() {
  S.streaming?.abort();
  S.streaming = null;
}

async function ask(query, { mode = 'chat', label = null, at = null } = {}) {
  query = String(query || '').trim();
  if (!query || !S.video) return;
  if (!S.video.transcript) { toast('Still loading the video', 'Give it a second and try again.'); return; }
  abortStream();

  const history = S.chat.filter((m) => !m.error).slice(-6).map((m) => ({ role: m.role, content: m.content }));
  const userMsg = { role: 'user', content: query, label, mode, at };
  S.chat.push(userMsg);
  appendMessage(userMsg, S.chat.length - 1);

  const aiMsg = { role: 'assistant', content: '', mode };
  const el = appendMessage({ ...aiMsg, content: '' }, S.chat.length);
  const prose = el.querySelector('.prose');
  el.querySelector('.msg-actions')?.remove();
  prose.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
  scrollThread();

  const ctrl = new AbortController();
  S.streaming = ctrl;
  refreshComposer();

  let pending = false;
  const paint = () => {
    pending = false;
    prose.innerHTML = md(aiMsg.content);
    prose.classList.add('caret');
    const t = $('#thread');
    if (t.scrollHeight - t.scrollTop - t.clientHeight < 140) t.scrollTop = t.scrollHeight;
  };

  try {
    const final = await S.api.chatStream({
      query,
      mode,
      at,
      language: S.settings.language,
      video_id: S.video.id,
      title: S.video.title,
      transcript_text: S.transcriptText,
      history,
    }, (delta) => {
      aiMsg.content += delta;
      if (!pending) { pending = true; requestAnimationFrame(paint); }
    }, ctrl.signal);
    aiMsg.source = final.source;
    if (final.source && (final.source === 'ai') !== S.ai) checkStatus();
  } catch (err) {
    if (ctrl.signal.aborted) {
      aiMsg.content = aiMsg.content || '_Stopped._';
    } else {
      aiMsg.error = err.message || 'Something went wrong. Please try again.';
      if (err instanceof ApiError && err.offline) checkStatus();
    }
  } finally {
    if (S.streaming === ctrl) S.streaming = null;
  }

  S.chat.push(aiMsg);
  const fresh = appendMessage(aiMsg, S.chat.length - 1);
  el.replaceWith(fresh);
  scrollThread();
  refreshComposer();
  if (S.video) store.saveChat(S.video.id, S.chat);
}

async function explainMoment() {
  if (!S.video) return;
  const st = await tabMessage({ type: 'vq:getState' });
  if (st) applyLive(st);
  const at = S.live.currentTime || 0;
  switchTab('chat');
  ask(`Explain what is happening around ${fmt(at)} in the video.`, { mode: 'moment', at, label: `⏱ Explain this moment (${fmt(at)})` });
}

function refreshComposer() {
  const busy = !!S.streaming;
  const btn = $('#sendBtn');
  btn.classList.toggle('stop', busy);
  btn.innerHTML = `<svg class="i"><use href="#${busy ? 'i-stop' : 'i-send'}"/></svg>`;
  btn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  $$('#quick button').forEach((b) => (b.disabled = busy || !S.video?.transcript));
  $('#chatInput').placeholder = S.settings.language === 'hinglish' ? 'Is video ke baare mein kuch bhi poochho…' : 'Ask anything about this video…';
}

function setLanguage(lang, announce = false) {
  S.settings.language = lang;
  saveSettings(S.settings);
  $$('.lang button').forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
  refreshComposer();
  if (announce) toast({ auto: '🌐 Auto: replies in the language you type', english: '🌐 Replies in English', hinglish: '🌐 Replies in Hinglish' }[lang]);
}

function autoGrow() {
  const t = $('#chatInput');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 140) + 'px';
}

// =====================================================================
// Notes
// =====================================================================
async function loadNotes(id) {
  const text = await store.getNotes(id);
  if (S.video?.id !== id) return;
  $('#notesInput').value = text;
  $('#notesSaved').textContent = '';
  setNotesView('write');
}

function saveNotesSoon() {
  $('#notesSaved').textContent = 'Saving…';
  clearTimeout(S.notesTimer);
  S.notesTimer = setTimeout(saveNotesNow, 350);
}

async function saveNotesNow() {
  clearTimeout(S.notesTimer);
  if (!S.video) return;
  await store.saveNotes(S.video.id, $('#notesInput').value);
  $('#notesSaved').textContent = '✓ Saved';
}

function appendToNotes(text) {
  const box = $('#notesInput');
  box.value = (box.value.trim() ? box.value.replace(/\s*$/, '') + '\n\n' : '') + text.trim() + '\n';
  saveNotesNow();
  if (!$('#notesPreview').hidden) setNotesView('preview');
}

function setNotesView(view) {
  $$('[data-notes]').forEach((b) => b.classList.toggle('active', b.dataset.notes === view));
  const preview = view === 'preview';
  $('#notesInput').hidden = preview;
  $('#notesPreview').hidden = !preview;
  if (preview) {
    const text = $('#notesInput').value;
    $('#notesPreview').innerHTML = text.trim() ? md(text) : '<p class="muted">Nothing here yet. Switch to Write to start.</p>';
  }
}

async function insertTimestamp() {
  const st = await tabMessage({ type: 'vq:getState' });
  if (st) applyLive(st);
  setNotesView('write');
  const box = $('#notesInput');
  const stamp = `[${fmt(S.live.currentTime)}] `;
  const at = box.selectionStart ?? box.value.length;
  const before = box.value.slice(0, at);
  const prefix = before && !before.endsWith('\n') ? '\n' : '';
  box.value = before + prefix + stamp + box.value.slice(box.selectionEnd ?? at);
  const pos = (before + prefix + stamp).length;
  box.focus();
  box.setSelectionRange(pos, pos);
  saveNotesSoon();
}

function exportNotes() {
  const text = $('#notesInput').value.trim();
  if (!text) { toast('📝 Your notes are empty', 'Write something or save an answer first.'); return; }
  const title = S.video?.title || 'VidQuery notes';
  const blob = new Blob([`# ${title}\n\nhttps://youtu.be/${S.video.id}\n\n${text}\n`], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'notes'}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

// =====================================================================
// Tabs
// =====================================================================
function switchTab(name) {
  S.tab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'mindmap') loadMindmap(false);
  if (name === 'transcript') {
    S.activeLine = -1;
    highlightLine();
  }
  if (name === 'chat') setTimeout(() => $('#chatInput').focus(), 50);
}

// =====================================================================
// Settings
// =====================================================================
function openSettings() {
  $('#apiBase').value = S.settings.apiBase;
  $('#langSelect').value = S.settings.language;
  $('#setMarkers').checked = S.settings.markers;
  $('#setFollow').checked = S.settings.follow;
  $('#setAdBlocker').checked = S.settings.adBlocker !== false;
  $('#apiResult').className = 'muted';
  $('#apiResult').textContent = 'Where your VidQuery server runs.';
  showView('settings');
}

function normaliseBase(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch (e) {
    throw new Error('Enter a full URL, for example http://localhost:8000');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Use an http:// or https:// URL');
  return url.origin;
}

async function ensureOriginPermission(base) {
  const { hostname } = new URL(base);
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  return chrome.permissions.request({ origins: [`${base}/*`] });
}

async function testApi() {
  const out = $('#apiResult');
  try {
    const base = normaliseBase($('#apiBase').value);
    if (!(await ensureOriginPermission(base))) throw new Error('Permission to reach that server was not granted.');
    out.className = 'muted';
    out.textContent = 'Testing…';
    const st = await new Api(base).status();
    out.className = 'ok';
    out.textContent = st.ai ? '✓ Connected. AI is online.' : '✓ Connected. AI gateway offline (offline mode).';
  } catch (err) {
    out.className = 'bad';
    out.textContent = `✕ ${err.message}`;
  }
}

async function saveSettingsFromForm() {
  try {
    const base = normaliseBase($('#apiBase').value);
    if (!(await ensureOriginPermission(base))) throw new Error('Permission to reach that server was not granted.');
    S.settings = {
      ...S.settings,
      apiBase: base,
      language: $('#langSelect').value,
      markers: $('#setMarkers').checked,
      follow: $('#setFollow').checked,
      adBlocker: $('#setAdBlocker').checked,
    };
    await saveSettings(S.settings);
    S.api = new Api(base);
    setLanguage(S.settings.language);
    syncToggles();
    toast('✓ Settings saved');
    sendToTab({ type: 'vq:setAdBlocker', enabled: S.settings.adBlocker !== false });
    await checkStatus();
    pushMarkers();
    syncActiveTab(true);
  } catch (err) {
    $('#apiResult').className = 'bad';
    $('#apiResult').textContent = `✕ ${err.message}`;
  }
}

function syncToggles() {
  $('#markersToggle').checked = S.settings.markers;
  $('#followToggle').checked = S.settings.follow;
}

// =====================================================================
// Pending actions (shortcut / context menu / player button)
// =====================================================================
async function handlePending() {
  const { 'vq:pending': p } = await chrome.storage.session.get('vq:pending');
  if (!p || Date.now() - p.at > 30000) return;
  await chrome.storage.session.remove('vq:pending');
  // Wait for the video to be ready (up to ~10s).
  for (let i = 0; i < 50 && !S.video?.transcript; i++) await new Promise((r) => setTimeout(r, 200));
  if (!S.video?.transcript) return;
  if (p.type === 'explain') explainMoment();
  if (p.type === 'ask') {
    switchTab('chat');
    ask(`Explain this from the video: "${p.text}"`, { label: `💬 “${p.text.length > 90 ? p.text.slice(0, 90) + '…' : p.text}”` });
  }
}

// =====================================================================
// Events
// =====================================================================
function bindEvents() {
  document.addEventListener('click', (e) => {
    const seekEl = e.target.closest('[data-seek]');
    if (seekEl) { seek(parseFloat(seekEl.dataset.seek)); return; }
    const open = e.target.closest('[data-open]');
    if (open) { chrome.tabs.update(S.tabId, { url: `https://www.youtube.com/watch?v=${open.dataset.open}` }); return; }
    if (e.target.closest('[data-retry]') && S.video) { const id = S.video.id; S.video = null; loadVideo(id, ''); return; }
    const sug = e.target.closest('[data-suggest]');
    if (sug) { ask(sug.dataset.suggest); return; }
    const act = e.target.closest('[data-act]');
    if (act) messageAction(act);
  });

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-quick]');
    if (!b) return;
    if (b.dataset.quick === 'moment') return explainMoment();
    const q = QUICK[b.dataset.quick];
    ask(q.query, { mode: q.mode, label: q.label });
  });

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (S.streaming) { abortStream(); return; }
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoGrow();
    ask(text);
  });
  $('#chatInput').addEventListener('input', autoGrow);
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
    if (e.key === 'Escape' && S.streaming) abortStream();
  });
  $$('.lang button').forEach((b) => b.addEventListener('click', () => setLanguage(b.dataset.lang, true)));
  $('#clearChat').addEventListener('click', () => {
    if (!S.video || !S.chat.length) return;
    abortStream();
    S.chat = [];
    store.saveChat(S.video.id, []);
    renderWelcome();
  });

  $('#markersToggle').addEventListener('change', (e) => {
    S.settings.markers = e.target.checked;
    saveSettings(S.settings);
    pushMarkers();
  });
  $('#followToggle').addEventListener('change', (e) => {
    S.settings.follow = e.target.checked;
    saveSettings(S.settings);
    if (S.settings.follow) { S.userScrolledAt = 0; S.activeLine = -1; highlightLine(); }
  });

  $('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gotoHit(S.search.idx + (e.shiftKey ? -1 : 1)); }
  });
  $('#prevHit').addEventListener('click', () => gotoHit(S.search.idx - 1));
  $('#nextHit').addEventListener('click', () => gotoHit(S.search.idx + 1));
  ['wheel', 'touchmove', 'keydown'].forEach((ev) => $('#transcript').addEventListener(ev, () => (S.userScrolledAt = Date.now()), { passive: true }));
  $('#copyTranscript').addEventListener('click', async () => {
    if (!S.transcriptText) return;
    await navigator.clipboard.writeText(S.transcriptText);
    toast('📋 Transcript copied');
  });

  $('#mindmapRegen').addEventListener('click', () => {
    if (!S.ai) { toast('AI is offline', 'Start FreeLLMAPI for an AI mind map.'); return; }
    loadMindmap(true);
  });

  $$('[data-notes]').forEach((b) => b.addEventListener('click', () => setNotesView(b.dataset.notes)));
  $('#notesInput').addEventListener('input', saveNotesSoon);
  $('#noteStamp').addEventListener('click', insertTimestamp);
  $('#noteExport').addEventListener('click', exportNotes);
  $('#noteCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#notesInput').value);
    toast('📋 Notes copied');
  });

  $('#settingsBtn').addEventListener('click', () => (S.view === 'settings' ? syncActiveTab(true) : openSettings()));
  $('#settingsBack').addEventListener('click', () => syncActiveTab(true));
  $('#saveSettings').addEventListener('click', saveSettingsFromForm);
  $('#testApi').addEventListener('click', testApi);
  $('#shortcutsBtn').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  $('#clearCache').addEventListener('click', async () => {
    await store.clearAnalysisCache();
    toast('🧹 Cached analysis cleared', 'Chats and notes were kept.');
  });
  $('#statusChip').addEventListener('click', checkStatus);
  $('#retryServer').addEventListener('click', async () => { if (await checkStatus()) syncActiveTab(true); });
  $('#serverSettings').addEventListener('click', openSettings);
  $('#openYoutube').addEventListener('click', () => chrome.tabs.update(S.tabId, { url: 'https://www.youtube.com/' }));
  $('#onboardClose').addEventListener('click', () => { chrome.storage.local.set({ 'vq:onboarding': false }); $('#onboard').hidden = true; });
}

async function messageAction(btn) {
  const msgEl = btn.closest('.msg');
  const m = S.chat[Number(msgEl.dataset.index)];
  if (!m) return;
  if (btn.dataset.act === 'copy') {
    await navigator.clipboard.writeText(m.content);
    btn.innerHTML = '<svg class="i"><use href="#i-copy"/></svg>Copied';
  } else if (btn.dataset.act === 'save') {
    const q = S.chat[Number(msgEl.dataset.index) - 1];
    appendToNotes(`### ${q?.label || q?.content || 'From the assistant'}\n${m.content}`);
    btn.innerHTML = '<svg class="i"><use href="#i-save"/></svg>Saved ✓';
    btn.disabled = true;
    toast('📝 Saved to notes');
  } else if (btn.dataset.act === 'regen') {
    const idx = Number(msgEl.dataset.index);
    const q = S.chat[idx - 1];
    if (!q || q.role !== 'user') return;
    S.chat.splice(idx - 1, 2);
    renderThread();
    ask(q.content, { mode: q.mode || 'chat', label: q.label, at: q.at });
  }
}

// =====================================================================
// Boot
// =====================================================================
async function init() {
  S.settings = await loadSettings();
  S.api = new Api(S.settings.apiBase);
  S.windowId = (await chrome.windows.getCurrent()).id;
  $('#version').textContent = `VidQuery v${chrome.runtime.getManifest().version}`;
  bindEvents();
  setLanguage(S.settings.language);
  syncToggles();

  checkStatus();
  setInterval(checkStatus, 20000);
  window.addEventListener('focus', checkStatus);

  chrome.tabs.onActivated.addListener(({ windowId }) => { if (windowId === S.windowId) syncActiveTab(); });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId !== S.tabId) return;
    if (change.url) syncActiveTab();
    else if (change.title && S.video && !S.video.transcript) {
      S.video.title = cleanTitle(change.title);
      renderCard();
    }
  });
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.tab?.id !== S.tabId) return;
    if (msg.type === 'vq:time' && msg.videoId === S.video?.id) applyLive(msg);
    if (msg.type === 'vq:navigate') {
      if (msg.videoId && msg.videoId !== S.video?.id) loadVideo(msg.videoId, cleanTitle(msg.title));
      else if (msg.videoId && msg.videoId === S.video?.id && cleanTitle(msg.title) && cleanTitle(msg.title) !== S.video.title) {
        S.video.title = cleanTitle(msg.title); // late, corrected title after SPA navigation
        renderCard();
        if (S.video.transcript) store.saveVideo(S.video);
      }
      else if (!msg.videoId && S.view === 'video') renderEmpty();
    }
  });
  chrome.storage.session.onChanged.addListener((changes) => { if (changes['vq:pending']?.newValue) handlePending(); });

  await syncActiveTab(true);
  handlePending();
}

init();
