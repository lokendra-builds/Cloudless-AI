// Everything stays in this browser: settings in localStorage; chats, projects and notes in IndexedDB.
// Nothing is ever sent to a server. Falls back to memory when storage is blocked.

const SETTINGS_KEY = 'cloudless.settings';
const DB_NAME = 'cloudless';
// chats:    {id, title, projectId|null, createdAt, updatedAt, messages: [{role, content, files?}]}
// projects: {id, name, description, instructions, files: [{name, size, text}], createdAt, updatedAt}
// notes:    {id, title, body (Markdown), projectId|null, createdAt, updatedAt}
const STORES = ['chats', 'projects', 'notes'];

export const DEFAULT_SETTINGS = Object.freeze({
  engine: 'cpu', // 'cpu' (wllama, any computer) or 'gpu' (WebLLM, needs WebGPU)
  cpuModel: 'Qwen3-1.7B-Q4_K_M.gguf',
  gpuModel: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  gpuSafe: false, // true: always use the f32 builds (for GPUs whose drivers fail on f16)
  systemPrompt: '',
  temperature: 0.7,
  think: true, // let reasoning models (Qwen3) think before answering
  tools: { wikipedia: false, duckduckgo: false, reader: false }, // web tools: all off until the user turns one on
  ctx: 4096, // context window in tokens (the slider in Settings); each model may lower it
  theme: 'auto', // 'auto' | 'light' | 'dark'
  sidebarOpen: true,
  userName: '', // shown in the sidebar and the greeting
  avatar: '', // data: URL of the user's own photo (stays in this browser); empty = default avatar
});

let memorySettings = null;
const memory = { chats: new Map(), projects: new Map(), notes: new Map() };

export function getSettings() {
  let saved = memorySettings;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? memorySettings;
  } catch { /* blocked or corrupt: use memory */ }
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  memorySettings = next;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* memory only */ }
  return next;
}

let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 2); // v2 added projects + notes
        req.onupgradeneeded = () => STORES.forEach((name) => {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
        });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

/** Save (insert or replace) one record in `store`. */
export async function putItem(store, item) {
  const copy = JSON.parse(JSON.stringify(item));
  const db = await openDB();
  if (!db) { memory[store].set(copy.id, copy); return; }
  await tx(db, store, 'readwrite', (s) => s.put(copy));
}

export async function getItem(store, id) {
  const db = await openDB();
  if (!db) return memory[store].get(id) ?? null;
  return (await tx(db, store, 'readonly', (s) => s.get(id))) ?? null;
}

export async function deleteItem(store, id) {
  const db = await openDB();
  if (!db) { memory[store].delete(id); return; }
  await tx(db, store, 'readwrite', (s) => s.delete(id));
}

/** Every record in `store`, most recently updated first. */
export async function listItems(store) {
  const db = await openDB();
  const all = db ? ((await tx(db, store, 'readonly', (s) => s.getAll())) || []) : [...memory[store].values()];
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export const saveChat = (c) => putItem('chats', c);
export const getChat = (id) => getItem('chats', id);
export const deleteChat = (id) => deleteItem('chats', id);
export const listChats = () => listItems('chats');

/** Delete every chat (projects, notes and downloaded models are kept). */
export async function clearAll() {
  memory.chats.clear();
  const db = await openDB();
  if (db) await tx(db, 'chats', 'readwrite', (s) => s.clear());
}

/**
 * Factory reset for Cloudless-AI only. Other apps can share this site (on GitHub Pages every
 * repo of an account lives on the same origin), so nothing outside Cloudless-AI is touched:
 *  - the "cloudless" IndexedDB database (chats, projects, notes)
 *  - localStorage / sessionStorage keys that start with "cloudless."
 *  - the model files Cloudless-AI itself downloaded (`models`: [{engine, id}])
 *  - this app's own service worker (by scope)
 * Unload any running model first: open files cannot be removed.
 */
export async function wipeEverything(models = []) {
  const errors = [];
  const step = async (name, fn) => { try { await fn(); } catch (e) { errors.push(`${name}: ${e?.message || e}`); } };
  await step('chats', async () => {
    const db = await openDB();
    db?.close(); // an open connection would block deleting the database
    dbPromise = null;
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  memorySettings = null;
  Object.values(memory).forEach((m) => m.clear());
  const ownKeys = (store) => Object.keys(store).filter((k) => k.startsWith('cloudless.'));
  await step('localStorage', () => ownKeys(localStorage).forEach((k) => localStorage.removeItem(k)));
  await step('sessionStorage', () => ownKeys(sessionStorage).forEach((k) => sessionStorage.removeItem(k)));
  const cpuFiles = models.filter((m) => m.engine === 'cpu').map((m) => m.id);
  const gpuIds = models.filter((m) => m.engine === 'gpu').map((m) => m.id);
  await step('CPU model files', async () => {
    if (!cpuFiles.length) return;
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return;
    let dir;
    try { dir = await root.getDirectoryHandle('cache'); } catch { return; } // nothing cached
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    // wllama stores "<sha1>_<file>" plus metadata files that contain the same name.
    for (const name of names) if (cpuFiles.some((f) => name.endsWith(f) || name.includes(`_${f}`))) await dir.removeEntry(name, { recursive: true });
  });
  await step('GPU model files', async () => {
    if (!gpuIds.length || !('caches' in window)) return;
    for (const cacheName of (await caches.keys()).filter((n) => n.startsWith('webllm/'))) {
      const cache = await caches.open(cacheName);
      for (const req of await cache.keys()) if (gpuIds.some((id) => req.url.includes(`/${id}/`))) await cache.delete(req);
    }
  });
  await step('service worker', async () => {
    const scope = new URL('./', location.href).href;
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.filter((r) => r.scope === scope).map((r) => r.unregister()));
  });
  return errors;
}

/** How much this site stores in the browser (chats + cached models), in bytes. */
export async function storageUsage() {
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return { usage: 0, quota: 0 };
  }
}
