// VidQuery content script (isolated world) for youtube.com.
// Responsibilities: report the current video + playback time to the side panel,
// seek the real YouTube player, draw key-moment markers on the progress bar,
// add a VidQuery button to the player controls, and read captions in-page.
(() => {
  if (window.__vqContent) return; // may be injected by both the manifest and on install
  window.__vqContent = true;

  const state = { videoId: null, title: '', moments: [], showMarkers: true, lastSent: 0, adBlocker: true };


  // ---------------------------------------------------------------- ad handling
  // Detects video ads, speeds them up to 16x, mutes them, jumps to end, and clicks skip buttons
  let wasAdPlaying = false;
  let userPlaybackRate = 1.0;
  let userMuted = false;

  function handleAds() {
    if (!state.adBlocker) return;
    const player = document.querySelector("#movie_player");
    const v = video();
    const isAd = !!(player && player.classList.contains("ad-showing")) || !!document.querySelector(".ad-showing, .ad-interrupting");

    if (isAd && v) {
      if (!wasAdPlaying) {
        wasAdPlaying = true;
        userPlaybackRate = v.playbackRate || 1.0;
        userMuted = v.muted;
        v.muted = true;
      }
      // Speed up video to 16x and skip to end of ad
      try {
        v.playbackRate = 16.0;
        if (isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration) {
          v.currentTime = v.duration;
        }
      } catch (e) {}

      // Click skip ad button if present
      const skipSelectors = [
        ".ytp-ad-skip-button",
        ".ytp-ad-skip-button-modern",
        ".ytp-skip-ad-button",
        "button.ytp-ad-skip-button-text",
        ".ytp-ad-overlay-close-button",
      ];
      for (const sel of skipSelectors) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          break;
        }
      }
    } else if (wasAdPlaying && v) {
      // Ad finished - restore student audio and playback rate
      wasAdPlaying = false;
      v.playbackRate = userPlaybackRate || 1.0;
      v.muted = userMuted;
    }
  }

  // Load user ad blocker preference from sync storage
  try {
    chrome.storage.sync.get("vq:settings", (res) => {
      const s = res && res["vq:settings"];
      if (s && typeof s.adBlocker === "boolean") state.adBlocker = s.adBlocker;
    });
  } catch (e) {}

  // ---------------------------------------------------------------- helpers
  const send = (msg) => {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      // Extension was reloaded; this orphaned script should stop quietly.
      teardown();
    }
  };

  function currentVideoId() {
    const url = new URL(location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const shorts = url.pathname.match(/^\/shorts\/([\w-]{11})/);
    return shorts ? shorts[1] : null;
  }

  function video() {
    return document.querySelector('#movie_player video, video.html5-main-video') || document.querySelector('video');
  }

  // During ads YouTube plays the ad in the same <video>: its time and duration are
  // the ad's, so we pause syncing, markers and seeking until the lecture resumes.
  function adShowing() {
    return !!document.querySelector('#movie_player.ad-showing');
  }

  function videoTitle() {
    const h1 = document.querySelector('ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata, #title h1');
    const text = (h1?.textContent || '').trim();
    return text || document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '').trim();
  }

  function playerState() {
    const v = video();
    return {
      videoId: state.videoId,
      title: state.title || videoTitle(),
      ad: adShowing(),
      currentTime: v && !adShowing() ? v.currentTime : null,
      duration: v && !adShowing() && isFinite(v.duration) ? v.duration : 0,
      paused: v ? v.paused || adShowing() : true,
      url: location.href,
    };
  }

  // DOM builders. YouTube enforces Trusted Types, so never assign HTML strings.
  function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    children.forEach((c) => node.appendChild(c));
    return node;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // ---------------------------------------------------------------- navigation
  function checkNavigation() {
    const id = currentVideoId();
    if (id === state.videoId) {
      const t = videoTitle();
      if (id && t && t !== state.title) {
        state.title = t;
        send({ type: 'vq:navigate', ...playerState() });
      }
      return;
    }
    const previousTitle = state.title || videoTitle();
    state.videoId = id;
    state.title = '';
    state.moments = [];
    clearMarkers();
    // After SPA navigation YouTube keeps showing the previous title for a moment;
    // wait until it changes (up to ~4s) so the panel never gets a stale title.
    let tries = 0;
    const waitTitle = () => {
      if (state.videoId !== id) return;
      const t = videoTitle();
      if ((t && t !== 'YouTube' && t !== previousTitle) || tries++ > 26) {
        state.title = t;
        send({ type: 'vq:navigate', ...playerState() });
      } else setTimeout(waitTitle, 150);
    };
    waitTitle();
  }

  // ---------------------------------------------------------------- time sync
  function onTime(force = false) {
    const now = performance.now();
    if (!force && now - state.lastSent < 900) return;
    state.lastSent = now;
    if (state.videoId && !adShowing()) send({ type: 'vq:time', ...playerState() });
  }

  function bindVideo() {
    const v = video();
    if (!v || v.__vqBound) return;
    v.__vqBound = true;
    v.addEventListener('timeupdate', () => onTime(false));
    ['seeked', 'play', 'pause', 'loadedmetadata', 'durationchange'].forEach((ev) =>
      v.addEventListener(ev, () => {
        onTime(true);
        if (ev === 'loadedmetadata' || ev === 'durationchange') renderMarkers();
      })
    );
  }

  // ---------------------------------------------------------------- markers
  function clearMarkers() {
    document.querySelectorAll('.vq-markers').forEach((el) => el.remove());
  }

  function renderMarkers() {
    clearMarkers();
    if (!state.showMarkers || !state.moments.length || adShowing()) return;
    const bar = document.querySelector('#movie_player .ytp-progress-bar');
    const v = video();
    const duration = v && isFinite(v.duration) ? v.duration : 0;
    if (!bar || !duration) return;
    const layer = document.createElement('div');
    layer.className = 'vq-markers';
    state.moments.forEach((m, i) => {
      if (m.seconds > duration) return;
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'vq-marker';
      tick.style.left = `${(m.seconds / duration) * 100}%`;
      tick.setAttribute('aria-label', `${fmt(m.seconds)} ${m.title}`);
      const tip = el('span', 'vq-marker-tip');
      tip.append(el('b', '', fmt(m.seconds)), el('span', '', m.title));
      tick.appendChild(tip);
      tick.addEventListener('mousedown', (e) => e.stopPropagation(), true);
      tick.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (seek(m.seconds, true).ad) toast('An ad is playing. VidQuery will jump there when it ends.');
      });
      if (i === 0) tick.classList.add('vq-first');
      layer.appendChild(tick);
    });
    bar.appendChild(layer);
  }

  // ---------------------------------------------------------------- player button
  function ensureButton() {
    if (!currentVideoId() || document.querySelector('.vq-player-btn')) return;
    const controls = document.querySelector('#movie_player .ytp-right-controls');
    if (!controls) return;
    const btn = document.createElement('button');
    btn.className = 'ytp-button vq-player-btn';
    btn.title = 'Ask VidQuery (Alt+Shift+Q)';
    btn.setAttribute('aria-label', 'Open VidQuery');
    btn.appendChild(svg('svg', { viewBox: '0 0 36 36', width: '100%', height: '100%', 'aria-hidden': 'true' }, [
      // Perfectly centered & enlarged VidQuery logo
      svg('path', {
        d: 'M18 6.5 C10.8 6.5 5 11.6 5 18 C5 21.4 6.8 24.4 9.8 26.3 L8.5 30.5 L14 28.5 C15.3 29.1 16.6 29.5 18 29.5 C25.2 29.5 31 24.4 31 18 C31 11.6 25.2 6.5 18 6.5 Z',
        fill: 'none',
        stroke: '#ffffff',
        'stroke-width': '2.4',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round'
      }),
      // Prominent play arrow in true geometric center (18, 17.5)
      svg('polygon', {
        points: '15.5,13.2 23,17.5 15.5,21.8',
        fill: '#ffffff'
      }),
      // Glowing AI blue spark dot anchored on top-right edge
      svg('circle', {
        cx: '28.5',
        cy: '8.5',
        r: '3',
        fill: '#3b82f6'
      })
    ]));
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'vq:open-panel' }).then((res) => {
        if (!res?.ok) toast('Click the VidQuery icon in the toolbar, or press Alt+Shift+Q');
      }).catch(() => toast('VidQuery was updated. Refresh this page to reconnect.'));
    });
    controls.insertBefore(btn, controls.firstChild);
  }

  // ---------------------------------------------------------------- toast
  function toast(text) {
    document.querySelector('.vq-toast')?.remove();
    const node = el('div', 'vq-toast', text);
    document.body.appendChild(node);
    requestAnimationFrame(() => node.classList.add('show'));
    setTimeout(() => { node.classList.remove('show'); setTimeout(() => node.remove(), 300); }, 3200);
  }

  // ---------------------------------------------------------------- seeking
  let pendingSeek = null;
  function seek(seconds, play = true) {
    const v = video();
    if (!v) return { ok: false };
    if (adShowing()) {
      pendingSeek = { seconds, play }; // applied as soon as the ad ends
      return { ok: false, ad: true };
    }
    v.currentTime = Math.max(0, seconds);
    if (play) v.play().catch(() => {});
    onTime(true);
    return { ok: true };
  }

  // ---------------------------------------------------------------- captions
  // Ask the MAIN-world bridge for the player's caption tracks, then fetch the
  // chosen track as JSON. Returns null when YouTube refuses (the server then
  // fetches the transcript instead).
  function captionTracks() {
    // Single attempt to get caption tracks from the page bridge.
    function attempt(timeout) {
      return new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        const timer = setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, timeout);
        function onMsg(e) {
          if (e.source !== window || e.data?.source !== 'vq-bridge' || e.data.id !== id) return;
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          resolve(e.data);
        }
        window.addEventListener('message', onMsg);
        window.postMessage({ source: 'vq-content', type: 'getCaptionTracks', id }, location.origin);
      });
    }

    // Retry up to 3 times with increasing timeouts. YouTube's SPA navigation
    // sometimes delays the player response, so a short retry loop catches it.
    return (async () => {
      for (const ms of [2000, 3000, 4000]) {
        const info = await attempt(ms);
        if (info?.tracks?.length) return info;
      }
      return null;
    })();
  }

  async function fetchCaptions() {
    let info = await captionTracks();
    if (!info || !info.tracks?.length) {
      // Wait a moment for the player to fully initialize, then try once more.
      await new Promise((r) => setTimeout(r, 1500));
      info = await captionTracks();
    }
    if (!info || !info.tracks?.length) return null;
    const tracks = info.tracks;
    const pick =
      tracks.find((t) => t.lang?.toLowerCase().startsWith('en') && t.kind !== 'asr') ||
      tracks.find((t) => t.lang?.toLowerCase().startsWith('en')) ||
      tracks.find((t) => t.lang?.toLowerCase().startsWith('hi')) ||
      tracks[0];
    if (!pick?.baseUrl) return null;

    // Helper to try fetching a caption url
    async function tryFetch(url) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        // Do not include credentials: 'include' as YouTube's timedtext CDN has wildcard CORS
        const res = await fetch(url, { signal: ctrl.signal });
        const body = await res.text();
        if (!res.ok || !body) return null;
        
        // 1. Try parsing JSON format (json3)
        try {
          const data = JSON.parse(body);
          const out = [];
          for (const ev of data.events || []) {
            if (!ev.segs) continue;
            const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
            if (text) out.push({ start: (ev.tStartMs || 0) / 1000, text });
          }
          if (out.length) return out;
        } catch (je) {}

        // 2. Try parsing XML format (standard YouTube timed text)
        try {
          const parser = new DOMParser();
          const xml = parser.parseFromString(body, 'text/xml');
          const nodes = xml.querySelectorAll('text');
          if (nodes && nodes.length) {
            const out = [];
            nodes.forEach((n) => {
              const text = (n.textContent || '').replace(/\s+/g, ' ').trim();
              const start = parseFloat(n.getAttribute('start') || '0');
              if (text) out.push({ start, text });
            });
            if (out.length) return out;
          }
        } catch (xe) {}
        return null;
      } catch (e) {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    // Try json3 first, then raw baseUrl, then srv3
    let res = await tryFetch(pick.baseUrl + (pick.baseUrl.includes('?') ? '&' : '?') + 'fmt=json3');
    if (res && res.length) return res;

    res = await tryFetch(pick.baseUrl);
    if (res && res.length) return res;

    res = await tryFetch(pick.baseUrl + (pick.baseUrl.includes('?') ? '&' : '?') + 'fmt=srv3');
    if (res && res.length) return res;

    // If pick was not first, try first track
    if (tracks[0] && tracks[0].baseUrl !== pick.baseUrl) {
      res = await tryFetch(tracks[0].baseUrl + (tracks[0].baseUrl.includes('?') ? '&' : '?') + 'fmt=json3');
      if (res && res.length) return res;
      res = await tryFetch(tracks[0].baseUrl);
      if (res && res.length) return res;
    }
    return null;
  }

  // ---------------------------------------------------------------- messages
  function onMessage(msg, sender, sendResponse) {
    switch (msg?.type) {
      case 'vq:setAdBlocker':
        state.adBlocker = msg.enabled !== false;
        sendResponse({ ok: true });
        return false;
      case 'vq:getState':
        checkNavigation();
        sendResponse(playerState());
        return false;
      case 'vq:seek':
        sendResponse(seek(msg.seconds, msg.play !== false));
        return false;
      case 'vq:setMoments':
        if (msg.videoId === state.videoId) {
          state.moments = (msg.moments || []).filter((m) => typeof m.seconds === 'number');
          state.showMarkers = msg.show !== false;
          renderMarkers();
        }
        sendResponse({ ok: true });
        return false;
      case 'vq:togglePlay': {
        const v = video();
        if (v) (v.paused ? v.play() : v.pause());
        sendResponse({ ok: !!v });
        return false;
      }
      case 'vq:getCaptions':
        fetchCaptions().then((captions) => sendResponse({ captions }));
        return true;
      case 'vq:ping':
        sendResponse({ ok: true });
        return false;
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(onMessage);

  // ---------------------------------------------------------------- lifecycle
  const onNav = () => setTimeout(checkNavigation, 50);
  document.addEventListener('yt-navigate-finish', onNav);
  window.addEventListener('popstate', onNav);

  // Light heartbeat: YouTube re-renders its player, so re-attach what it drops.
  const heartbeat = setInterval(() => {
    handleAds();
    checkNavigation();
    bindVideo();
    ensureButton();
    if (state.moments.length && state.showMarkers && !document.querySelector('.vq-markers')) renderMarkers();
    if (pendingSeek && !adShowing()) {
      const { seconds, play } = pendingSeek;
      pendingSeek = null;
      setTimeout(() => seek(seconds, play), 300);
    }
  }, 1000);

  function teardown() {
    clearInterval(heartbeat);
    clearInterval(adInterval);
    document.removeEventListener('yt-navigate-finish', onNav);
    window.removeEventListener('popstate', onNav);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch (e) {}
    document.querySelectorAll('.vq-player-btn, .vq-markers').forEach((el) => el.remove());
    window.__vqContent = false;
  }


  // Fast loop (250ms) for instant ad detection and skipping
  const adInterval = setInterval(handleAds, 250);

  checkNavigation();
  bindVideo();
  ensureButton();
})();
