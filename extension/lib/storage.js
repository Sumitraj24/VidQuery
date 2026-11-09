// Local persistence. Video analysis is a cache (oldest entries are evicted);
// chats and notes are the student's own data and are never evicted.

const MAX_VIDEOS = 40;
const k = {
  video: (id) => `vq:video:${id}`,
  chat: (id) => `vq:chat:${id}`,
  notes: (id) => `vq:notes:${id}`,
  recent: 'vq:recent',
};

async function get(key, fallback = null) {
  const data = await chrome.storage.local.get(key);
  return data[key] ?? fallback;
}

export async function getVideo(id) {
  return get(k.video(id));
}

export async function saveVideo(video) {
  if (!video?.id) return;
  const recent = (await get(k.recent, [])).filter((r) => r.id !== video.id);
  recent.unshift({ id: video.id, title: video.title || 'YouTube video', at: Date.now() });
  const evicted = recent.splice(MAX_VIDEOS);
  await chrome.storage.local.set({ [k.video(video.id)]: { ...video, savedAt: Date.now() }, [k.recent]: recent });
  if (evicted.length) await chrome.storage.local.remove(evicted.map((r) => k.video(r.id)));
}

export async function recentVideos(limit = 8) {
  return (await get(k.recent, [])).slice(0, limit);
}

export async function getChat(id) {
  return get(k.chat(id), []);
}

export async function saveChat(id, messages) {
  await chrome.storage.local.set({ [k.chat(id)]: messages.slice(-80) });
}

export async function getNotes(id) {
  return get(k.notes(id), '');
}

export async function saveNotes(id, text) {
  await chrome.storage.local.set({ [k.notes(id)]: text });
}

/** Clears cached analysis only; chats and notes are kept. */
export async function clearAnalysisCache() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((key) => key.startsWith('vq:video:')));
}
