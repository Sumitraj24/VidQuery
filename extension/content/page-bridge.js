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
      const resp = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
      videoId = resp?.videoDetails?.videoId || null;
      tracks = (resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).map((t) => ({
        baseUrl: t.baseUrl,
        lang: t.languageCode,
        kind: t.kind || '',
        name: t.name?.simpleText || '',
      }));
    } catch (err) {
      tracks = [];
    }
    window.postMessage({ source: 'vq-bridge', id: e.data.id, videoId, tracks }, location.origin);
  });
})();
