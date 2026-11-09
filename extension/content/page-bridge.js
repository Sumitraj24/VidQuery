// Runs in YouTube's MAIN world (where the player API lives). It only answers one
// question from VidQuery's content script: which caption tracks does this video have?
(() => {
  if (window.__vqBridge) return;
  window.__vqBridge = true;

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'vq-content' || e.data.type !== 'getCaptionTracks') return;
    let tracks = [];
    let videoId = null;
    try {
      const player = document.getElementById('movie_player');
      const flexy = document.querySelector('ytd-watch-flexy');

      // Try multiple sources for the player response, in order of reliability
      let resp = null;
      
      // 1. Player API (most reliable when player is ready)
      try { resp = player?.getPlayerResponse?.(); } catch (_) {}
      
      // 2. Flexy element's playerData
      if (!resp?.captions) {
        try { resp = flexy?.playerData || resp; } catch (_) {}
      }
      
      // 3. ytInitialPlayerResponse global
      if (!resp?.captions) {
        try { resp = window.ytInitialPlayerResponse || resp; } catch (_) {}
      }
      
      // 4. Try extracting from ytcfg (another YouTube global)
      if (!resp?.captions) {
        try {
          const cfg = window.ytcfg?.get?.('PLAYER_VARS');
          if (cfg?.embedded_player_response) {
            resp = JSON.parse(cfg.embedded_player_response) || resp;
          }
        } catch (_) {}
      }
      
      // 5. Last resort: scan script tags for ytInitialPlayerResponse
      if (!resp?.captions) {
        try {
          const scripts = document.querySelectorAll('script');
          for (const s of scripts) {
            const text = s.textContent || '';
            const match = text.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;/);
            if (match) {
              const parsed = JSON.parse(match[1]);
              if (parsed?.captions) { resp = parsed; break; }
            }
          }
        } catch (_) {}
      }

      videoId = resp?.videoDetails?.videoId || null;

      let rawTracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!rawTracks || !rawTracks.length) {
        rawTracks = player?.getOption?.('captions', 'tracklist') || [];
      }

      tracks = (rawTracks || []).map((t) => ({
        baseUrl: String(t.baseUrl || t.base_url || '').replace(/&amp;/g, '&'),
        lang: t.languageCode || t.lang || t.vssId || '',
        kind: t.kind || '',
        name: t.name?.simpleText || t.languageName || t.displayName || '',
      })).filter(t => !!t.baseUrl);
    } catch (err) {
      tracks = [];
    }
    window.postMessage({ source: 'vq-bridge', id: e.data.id, videoId, tracks }, location.origin);
  });
})();
