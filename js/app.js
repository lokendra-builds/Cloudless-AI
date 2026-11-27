// Cloudless UI: wires the chat screen, the sidebar, the model menu and settings together.
// No server anywhere: chats live in IndexedDB, the model runs in this tab.

import { getSettings, saveSettings, saveChat, getChat, deleteChat, listChats, listItems, clearAll, storageUsage, wipeEverything } from './storage.js';
import { renderMarkdown, isPreviewable } from './markdown.js';
import { splitThinking, titleFrom, buildPrompt, groupChats, greeting, newId, composeSystem, noteTitleFrom, chatToMarkdown, fileNameFor, memoryUse, budgetsFor } from './chats.js';
import { initPages, renderProjects, renderProject, renderNotes, renderNote, renderArtifacts, renderArtifact, renderShared, createArtifact, listProjects, getProject, createProject, createNote } from './pages.js';
import { sandboxedFrame, kindFromLang, titleFrom as artifactTitle, SHARE_PREFIX } from './artifacts.js';
import {
  CPU_MODELS, GPU_MODELS, currentModel, modelReady, modelCached, loadModel, chat as runChat,
  hasWebGPU, gpuHasF16, detectGpu, compatibleModelId, isCpuCached, isGpuCached, cpuMultithread, mockReady, unloadAll, ownModels, ctxOptions, kvGB, DEFAULT_CTX, loadedWithOtherCtx,
} from './llm.js';
import { TOOLS, TOOL_IDS, planTools, runTools, withSources, stepLabel, shortUrl } from './tools.js';
import { escapeHTML } from './escape.js';
import { renderBanners } from './banner-page.js';
import { pdfText } from './pdf-text.js';

const PARAMS = new URLSearchParams(location.search);
const MOCK = PARAMS.get('mock') === '1';
if (MOCK && PARAMS.get('notcached') === '1') window.__mockNotCached = true; // tests: pretend no model is downloaded
const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), main: $('main'), thread: $('thread'), messages: $('messages'), hero: $('hero'), heroSlot: $('hero-slot'),
  dock: $('dock'), composer: $('composer'), input: $('input'), send: $('send'), chatList: $('chat-list'), title: $('chat-title'),
  modelBtn: $('model-btn'), modelMenu: $('model-menu'), modelList: $('model-list'), modelLabel: $('model-label'),
  modelState: $('model-state'), engineNote: $('engine-note'), scrim: $('scrim'), settings: $('settings'),
};

const state = {
  chat: null, // {id, title, createdAt, updatedAt, messages: [{role, content, model?, ms?, stopped?}]}
  chats: [],
  busy: false,
  controller: null,
  loading: null, // promise of the model currently loading
  loadProgress: 0,
  loadingId: '',
  query: '', // sidebar search
  pending: [], // files attached to the next message: [{name, size, text}]
  newProjectId: null, // project for the next new chat (set from a project page)
  view: 'chat', // 'chat' or a page: 'projects' | 'project' | 'notes' | 'note' | 'artifacts' | 'artifact' | 'shared'
};

// ---------------------------------------------------------------- helpers

/**
 * A short notice, centred in the chat window (not the whole screen) and just above the message
 * box, so it never covers what you type. Inside an open dialog it shows in that dialog instead.
 */
function toast(text, { action } = {}) {
  document.querySelectorAll('.toast').forEach((n) => n.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = action.label;
    b.addEventListener('click', () => { t.remove(); action.run(); });
    t.append(' ', b);
    t.classList.add('has-act');
  }
  const dialog = document.querySelector('dialog[open]');
  if (dialog) {
    t.classList.add('in-dialog');
    dialog.appendChild(t);
  } else {
    const dock = $('dock');
    const dockShown = dock && dock.offsetParent !== null;
    t.style.bottom = `${(dockShown ? dock.offsetHeight : 0) + 18}px`;
    el.main.appendChild(t);
  }
  setTimeout(() => t.remove(), action ? 4000 : 1800);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

function model() {
  return currentModel(getSettings(), { mock: MOCK });
}

function nearBottom() {
  const t = el.thread;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || nearBottom()) el.thread.scrollTop = el.thread.scrollHeight;
}

function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, window.innerHeight * 0.4)}px`;
}

function updateSend() {
  el.send.classList.toggle('stop', state.busy);
  el.send.disabled = !state.busy && !el.input.value.trim() && !state.pending.length;
  el.send.setAttribute('aria-label', state.busy ? 'Stop' : 'Send message');
}

function setBusy(b) {
  state.busy = b;
  updateSend();
}

// ---------------------------------------------------------------- profile

const DEFAULT_AVATAR = 'assets/avatar-default.jpg';

/** Put the user's name and photo everywhere they appear (sidebar, messages, settings). */
function applyProfile() {
  const { userName, avatar } = getSettings();
  const src = avatar || DEFAULT_AVATAR;
  document.querySelectorAll('img.avatar').forEach((img) => { img.src = src; });
  $('tpl-user').content.querySelector('img.avatar').src = src;
  document.querySelector('.user-name').textContent = userName.trim() || 'You';
  if (el.main.classList.contains('empty')) placeComposer();
}

/** Shrink a photo to a 160 px square (centre crop) so it fits comfortably in localStorage. */
function resizePhoto(file, size = 160) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image.')); };
    img.src = url;
  });
}

// ---------------------------------------------------------------- theme + sidebar

function applyTheme() {
  const t = getSettings().theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

const narrow = () => window.matchMedia('(max-width: 820px)').matches;

function setSidebar(open, persist = true) {
  el.app.classList.toggle('side-closed', !open);
  el.scrim.hidden = !(open && narrow());
  if (persist && !narrow()) saveSettings({ sidebarOpen: open });
}

// ---------------------------------------------------------------- header + views

/** Header: optional crumb (project or section) › title. `menu` makes the title a chat menu button. */
function setHeader(title, { crumb = null, menu = false } = {}) {
  el.title.textContent = title || '';
  $('crumb').hidden = !crumb;
  $('crumb-sep').hidden = !crumb;
  if (crumb) { $('crumb').textContent = crumb.label; $('crumb').href = crumb.href; }
  const btn = $('title-btn');
  btn.disabled = !menu;
  btn.classList.toggle('has-menu', menu);
  el.main.classList.toggle('has-title', !!title);
  document.title = title ? `${title} · Cloudless-AI` : 'Cloudless-AI: Private AI Chat in Your Browser (Local LLM)';
}

function showView(view) {
  state.view = view;
  const page = view !== 'chat';
  $('view-chat').hidden = page;
  $('view-page').hidden = !page;
  el.main.classList.toggle('on-page', page);
  if (page) el.main.classList.remove('empty');
  document.querySelectorAll('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.nav === view || (view === 'project' && a.dataset.nav === 'projects') || (view === 'note' && a.dataset.nav === 'notes') || (['artifact', 'shared'].includes(view) && a.dataset.nav === 'artifacts')));
  closeTitleMenu();
}

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

/** Show whatever the address says: a chat, a page, or a new chat. */
async function route() {
  const hash = location.hash;
  const m = hash.match(/^#\/(c|p|n|a)\/(.+)$/);
  if (m?.[1] === 'c') { if (m[2] !== state.chat?.id || state.view !== 'chat') await openChat(m[2]); return; }
  if (state.busy) stop();
  const root = $('view-page');
  if (hash === '#/projects') { showView('projects'); await renderProjects(root); } else if (m?.[1] === 'p') { showView('project'); await renderProject(root, m[2]); } else if (hash === '#/notes') { showView('notes'); await renderNotes(root); } else if (m?.[1] === 'n') { showView('note'); await renderNote(root, m[2]); } else if (hash === '#/artifacts') { showView('artifacts'); await renderArtifacts(root); } else if (m?.[1] === 'a') { showView('artifact'); await renderArtifact(root, m[2]); } else if (hash === '#/banners') { showView('banners'); await renderBanners(root, bannerCtx()); } else if (hash.startsWith(SHARE_PREFIX)) { showView('shared'); await renderShared(root, hash.slice(SHARE_PREFIX.length)); } else { newChat(); return; }
  root.scrollTop = 0;
  if (narrow()) setSidebar(false);
  document.querySelectorAll('.chat-item').forEach((n) => n.classList.remove('active'));
}

/** What the Banners page may use: toasts, the title bar, and the local model (words only). */
function bannerCtx() {
  return {
    toast, go, setTitle: (t, o = {}) => setHeader(t, o),
    llm: {
      label: () => model().label,
      gb: () => model().gb,
      ready: () => modelReady(model()),
      cached: () => modelCached(model()),
      progress: () => state.loadProgress,
      busy: () => state.busy,
      load: () => startLoad(model()),
      async ask(messages, { signal } = {}) {
        setBusy(true);
        try {
          return await runChat(model(), messages, { signal, temperature: 0.7, think: false });
        } finally {
          setBusy(false);
          updateModelState();
        }
      },
    },
  };
}

// ---------------------------------------------------------------- projects in chats

async function moveChatToProject(chatId, projectId) {
  const rec = state.chat?.id === chatId ? state.chat : await getChat(chatId);
  if (!rec) return;
  rec.projectId = projectId || null;
  await saveChat(rec);
  if (state.chat?.id === chatId) { await renderChatHeader(); memProject = { id: undefined }; scheduleMemory(); }
  refreshList();
  const p = projectId ? await getProject(projectId) : null;
  toast(p ? `Moved to ${p.name}` : 'Removed from project');
}

/** A menu listing projects (and "New project…") to move a chat into. */
async function projectPicker(menu, chat) {
  const projects = await listProjects();
  menu.replaceChildren();
  const head = document.createElement('div');
  head.className = 'menu-label';
  head.textContent = 'Move to project';
  menu.appendChild(head);
  for (const p of projects) {
    const b = menuButton(p.name, () => moveChatToProject(chat.id, p.id), 'folder');
    if (p.id === chat.projectId) { b.classList.add('current'); b.disabled = true; }
    menu.appendChild(b);
  }
  menu.appendChild(menuButton('New project…', async () => {
    const name = prompt('Name of the new project');
    if (!name?.trim()) return;
    const p = await createProject({ name });
    await moveChatToProject(chat.id, p.id);
  }, 'plus'));
}

const MENU_ICONS = {
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 13h6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  chev: '<svg class="sub" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M6 11l6 6 6-6M5 20h14"/></svg>',
};

function menuButton(label, onClick, icon, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  if (cls) b.className = cls;
  b.innerHTML = `${icon ? MENU_ICONS[icon] : ''}<span></span>`;
  b.querySelector('span').textContent = label;
  b.addEventListener('click', async (e) => { e.stopPropagation(); if (!b.dataset.keep) { closeTitleMenu(); closeItemMenus(); } await onClick(e); });
  return b;
}

async function exportMarkdown(chat) {
  const p = chat.projectId ? await getProject(chat.projectId) : null;
  return chatToMarkdown(chat, { projectName: p?.name || '', userName: getSettings().userName.trim() || 'You' });
}

function downloadText(text, name, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Downloaded ${name}`);
}

function closeTitleMenu() {
  $('title-menu').hidden = true;
  $('title-btn').setAttribute('aria-expanded', 'false');
}

async function openTitleMenu() {
  const chat = state.chat;
  if (!chat?.messages.length) return;
  const menu = $('title-menu');
  menu.replaceChildren();
  const move = menuButton(chat.projectId ? 'Move to another project' : 'Add to project', () => projectPicker(menu, chat), 'folder');
  move.dataset.keep = '1';
  move.insertAdjacentHTML('beforeend', MENU_ICONS.chev);
  menu.appendChild(move);
  if (chat.projectId) menu.appendChild(menuButton('Remove from project', () => moveChatToProject(chat.id, null), 'out'));
  menu.appendChild(menuButton('Rename', renameInHeader, 'edit'));
  menu.appendChild(document.createElement('hr'));
  menu.appendChild(menuButton('Copy chat as Markdown', async () => copyText(await exportMarkdown(chat)), 'copy'));
  menu.appendChild(menuButton('Download as Markdown (.md)', async () => downloadText(await exportMarkdown(chat), fileNameFor(chat.title), 'text/markdown'), 'download'));
  const sep = document.createElement('hr');
  menu.appendChild(sep);
  menu.appendChild(menuButton('Delete chat', () => removeChat(chat.id), 'trash', 'del'));
  menu.hidden = false;
  $('title-btn').setAttribute('aria-expanded', 'true');
}

function renameInHeader() {
  const chat = state.chat;
  const span = el.title;
  const input = document.createElement('input');
  input.className = 'rename-input header-rename';
  input.value = chat.title;
  input.setAttribute('aria-label', 'Chat name');
  $('title-btn').hidden = true;
  $('crumbs').appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (keep) => {
    if (done) return;
    done = true;
    if (keep && input.value.trim()) { chat.title = input.value.trim(); await saveChat(chat); refreshList(); }
    input.remove();
    $('title-btn').hidden = false;
    span.textContent = chat.title;
    document.title = `${chat.title} · Cloudless-AI`;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}

async function renderChatHeader() {
  const chat = state.chat;
  if (!chat?.messages.length) {
    setHeader('', {});
    return;
  }
  const p = chat.projectId ? await getProject(chat.projectId) : null;
  if (state.chat !== chat) return;
  setHeader(chat.title, { crumb: p ? { label: p.name, href: `#/p/${p.id}` } : null, menu: true });
}

async function renderProjectPill() {
  const pill = $('project-pill');
  const p = state.newProjectId ? await getProject(state.newProjectId) : null;
  pill.hidden = !p;
  if (p) $('project-pill-name').textContent = p.name;
}

async function saveReplyAsNote(msg) {
  const body = splitThinking(msg.content).answer;
  const note = await createNote({ title: `${noteTitleFrom(body)}`, body, projectId: state.chat?.projectId || null });
  toast('Saved to Notes');
  return note;
}

/** "Save" on a code block in a reply: keep it as an artifact (in the chat's project, if any). */
async function saveCodeAsArtifact(block) {
  const content = block.querySelector('code').textContent;
  const tag = block.querySelector('.code-head span')?.textContent || '';
  const lang = tag === 'code' ? '' : tag;
  const kind = kindFromLang(lang, content);
  const a = await createArtifact({ kind, lang: kind === 'code' ? lang : '', content, title: artifactTitle(kind, content, lang), projectId: state.chat?.projectId || null });
  toast('Saved to Artifacts', { action: { label: 'Open', run: () => go(`#/a/${a.id}`) } });
  return a;
}

// ---------------------------------------------------------------- chat list

async function refreshList() {
  state.chats = await listChats();
  el.chatList.textContent = '';
  const q = state.query.trim().toLowerCase();
  const shown = q ? state.chats.filter((c) => matchChat(c, q)) : state.chats;
  if (!shown.length) {
    const p = document.createElement('p');
    p.className = 'empty-list';
    p.textContent = q ? `No chats match "${state.query.trim()}".` : 'Your chats will show up here. They stay in this browser.';
    el.chatList.appendChild(p);
    return;
  }
  for (const [label, list] of groupChats(shown)) {
    const h = document.createElement('div');
    h.className = 'group-label';
    h.textContent = label;
    el.chatList.appendChild(h);
    for (const c of list) el.chatList.appendChild(chatItem(c));
  }
}

/** Title or any message contains the query. Returns a short snippet around the hit, or true/false. */
function matchChat(c, q) {
  if ((c.title || '').toLowerCase().includes(q)) return true;
  for (const m of c.messages || []) {
    const t = String(m.content || '');
    const i = t.toLowerCase().indexOf(q);
    if (i >= 0) { c._hit = `…${t.slice(Math.max(0, i - 20), i + q.length + 30).replace(/\s+/g, ' ')}…`; return true; }
  }
  return false;
}

function chatItem(c) {
  const item = document.createElement('div');
  item.className = 'chat-item';
  item.dataset.id = c.id;
  if (state.chat?.id === c.id) item.classList.add('active');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'open';
  open.textContent = c.title || 'New chat';
  open.title = c.title || 'New chat';
  if (state.query.trim() && c._hit) {
    const hit = document.createElement('span');
    hit.className = 'search-hit';
    hit.textContent = c._hit;
    open.appendChild(hit);
  }
  delete c._hit;
  open.addEventListener('click', () => { openChat(c.id); if (narrow()) setSidebar(false); });
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'icon-btn more';
  more.setAttribute('aria-label', `Options for ${c.title}`);
  more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
  more.addEventListener('click', (e) => { e.stopPropagation(); itemMenu(item, c); });
  item.append(open, more);
  return item;
}

function closeItemMenus() {
  document.querySelectorAll('.chat-item .item-menu').forEach((m) => m.remove());
}

function itemMenu(item, c) {
  const had = item.querySelector('.item-menu');
  closeItemMenus();
  if (had) return;
  const menu = document.createElement('div');
  menu.className = 'item-menu';
  menu.innerHTML = '<button type="button" data-a="move">Move to project</button><button type="button" data-a="rename">Rename</button><button type="button" class="del" data-a="delete">Delete</button>';
  menu.addEventListener('click', async (e) => {
    e.stopPropagation();
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'move') { await projectPicker(menu, c); return; }
    if (!a) return;
    closeItemMenus();
    if (a === 'rename') renameInline(item, c);
    if (a === 'delete') await removeChat(c.id);
  });
  item.appendChild(menu);
}

function renameInline(item, c) {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = c.title || '';
  input.setAttribute('aria-label', 'Chat name');
  item.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (keep) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (keep && title) {
      const rec = (state.chat?.id === c.id ? state.chat : await getChat(c.id));
      if (rec) {
        rec.title = title;
        await saveChat(rec);
        if (state.chat?.id === c.id) el.title.textContent = title;
      }
    }
    refreshList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function removeChat(id) {
  if (!confirm('Delete this chat? This cannot be undone.')) return;
  if (state.chat?.id === id) { stop(); newChat(); }
  await deleteChat(id);
  refreshList();
  toast('Chat deleted');
}

// ---------------------------------------------------------------- rendering

function placeComposer() {
  const empty = !state.chat?.messages.length;
  el.main.classList.toggle('empty', empty);
  if (empty) {
    el.heroSlot.appendChild(el.composer);
    const name = getSettings().userName.trim();
    $('greeting-text').textContent = name ? `${greeting()} ${name}, welcome to Cloudless\u2011AI` : `${greeting()}, welcome to Cloudless\u2011AI`; // \u2011: the name never breaks at its hyphen
  } else if (el.composer.parentElement !== el.dock) {
    el.dock.prepend(el.composer);
  }
}

/** "Today, 4:05 PM" / "Yesterday, 9:12 AM" / "24 Nov, 6:30 PM" (+ year when not this year). */
export function formatWhen(t, now = new Date()) {
  if (!t) return '';
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((day - that) / 86400000);
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  const opts = { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) };
  return `${d.toLocaleDateString([], opts)}, ${time}`;
}

function setWhen(node, t) {
  const w = node.querySelector('.when');
  if (!w) return;
  w.textContent = formatWhen(t);
  if (t) w.title = new Date(t).toLocaleString();
}

/** Send a past message again, as a new turn at the end of the chat. */
async function resend(msg) {
  if (state.busy) return;
  state.chat.messages.push({ role: 'user', content: msg.content, at: Date.now(), ...(msg.files?.length ? { files: msg.files } : {}) });
  renderChat();
  await persist();
  respond();
}

function renderUser(msg, index) {
  const node = $('tpl-user').content.firstElementChild.cloneNode(true);
  node.dataset.index = index;
  node.querySelector('.text').textContent = msg.content;
  if (msg.files?.length) {
    const box = document.createElement('div');
    box.className = 'files';
    msg.files.forEach((f) => box.appendChild(fileChip(f)));
    node.prepend(box);
    if (!msg.content) node.querySelector('.bubble').hidden = true;
  }
  node.querySelector('[data-act="copy"]').addEventListener('click', () => copyText(msg.content));
  node.querySelector('[data-act="edit"]').addEventListener('click', () => editMessage(node, index));
  node.querySelector('[data-act="resend"]').addEventListener('click', () => resend(msg));
  setWhen(node, msg.at);
  return node;
}

/** "Thought for 4s" / "Thought for 1m 12s" */
export function thoughtFor(ms) {
  const sec = Math.max(1, Math.round(ms / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function fillAssistant(node, text, { live = false, thinkMs = 0, sources = null } = {}) {
  const { thinking, answer, thinkingOpen } = splitThinking(text);
  const box = node.querySelector('.thinking');
  if (thinking || (live && thinkingOpen)) {
    box.hidden = false;
    box.classList.toggle('live', live && thinkingOpen);
    box.querySelector('.think-label').textContent = live && thinkingOpen
      ? `Thinking${thinkMs >= 1000 ? ` · ${thoughtFor(thinkMs)}` : '…'}`
      : thinkMs ? `Thought for ${thoughtFor(thinkMs)}` : 'Thought process';
    box.querySelector('.think-body').textContent = thinking;
  } else {
    box.hidden = true;
  }
  node.querySelector('.md').innerHTML = renderMarkdown(answer);
  if (sources?.length) linkCitations(node.querySelector('.md'), sources);
}

const TOOL_ICONS = {
  wikipedia: '<path d="M3 6l4.5 12L12 8l4.5 10L21 6"/>',
  duckduckgo: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  reader: '<path d="M4 5h6a3 3 0 0 1 2 1 3 3 0 0 1 2-1h6v14h-6a3 3 0 0 0-2 1 3 3 0 0 0-2-1H4z"/><path d="M12 6v14"/>',
};
const toolIcon = (id) => `<svg viewBox="0 0 24 24" aria-hidden="true">${TOOL_ICONS[id]}</svg>`;

/** Turn "[2]" in a reply into a link to source 2 (outside code). */
function linkCitations(root, sources) {
  const byN = new Map(sources.map((s) => [String(s.n), s]));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('pre, code, a') || !/\[\d{1,2}\]/.test(n.data) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    n.data.replace(/\[(\d{1,2})\]/g, (m, num, at) => {
      const src = byN.get(num);
      if (!src) return m;
      frag.append(n.data.slice(last, at));
      const a = document.createElement('a');
      a.className = 'cite';
      a.href = src.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = src.title;
      a.textContent = num;
      a.setAttribute('aria-label', `Source ${num}: ${src.title}`);
      frag.append(a);
      last = at + m.length;
      return m;
    });
    if (!last) continue;
    frag.append(n.data.slice(last));
    n.replaceWith(frag);
  }
}

/** The "Searched Wikipedia for …" lines at the top of a reply. */
// ---------------------------------------------------------------- live status of a reply
// Every step is something the app really did, timed as it happened: loading the model, reading
// project files and attachments, web searches, reading the prompt, thinking, writing. Nothing is
// shown for show. The finished list is saved with the reply.

const TRACE_ICONS = {
  model: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>',
  memory: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
  read: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  think: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
  write: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  preview: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
};
const traceIcon = (id) => `<svg viewBox="0 0 24 24" aria-hidden="true">${TRACE_ICONS[id] || TOOL_ICONS[id] || TRACE_ICONS.read}</svg>`;

/** "0.4s", "12s", "1m 05s" */
function fmtMs(ms) {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** A live list of steps on a reply that is being made. */
function createTrace(node) {
  const t = { node, steps: [], t0: performance.now(), live: true, said: '' };
  t.add = (step) => { const s = { status: 'running', ...step, start: performance.now() }; t.steps.push(s); renderTrace(t); return s; };
  t.note = (step) => { const s = { status: 'done', ...step }; t.steps.push(s); renderTrace(t); return s; };
  t.end = (s, patch = {}) => {
    if (!s || s.status !== 'running') return;
    Object.assign(s, { status: 'done', ms: performance.now() - s.start }, patch);
    renderTrace(t);
  };
  t.drop = (s) => { t.steps = t.steps.filter((x) => x !== s); renderTrace(t); };
  t.running = () => t.steps.filter((s) => s.status === 'running');
  t.timer = setInterval(() => { if (t.running().length) renderTrace(t); }, 250);
  t.finish = ({ stopped = false } = {}) => {
    clearInterval(t.timer);
    for (const s of t.running()) Object.assign(s, { status: stopped ? 'stopped' : 'done', ms: performance.now() - s.start, ...(stopped ? { label: `${s.live}: stopped by you` } : {}) });
    t.live = false;
    t.total = performance.now() - t.t0;
    t.stopped = stopped;
    renderTrace(t);
  };
  t.toJSON = () => ({ total: Math.round(t.total || 0), stopped: t.stopped || undefined, steps: t.steps.map(({ icon, label, status, ms, tool }) => ({ icon, label, status, ...(ms != null ? { ms: Math.round(ms) } : {}), ...(tool ? { tool } : {}) })) });
  return t;
}

function traceRow(s, now, fresh = false) {
  const running = s.status === 'running';
  const text = running ? `${s.live}…` : s.label;
  const ms = running ? now - s.start : s.ms;
  const cls = `trace-step ${s.status}${s.tool ? ' tool-step' : ''}${fresh ? ' enter' : ''}`;
  return `<li class="${cls}">${running ? '<span class="spin" aria-hidden="true"></span>' : traceIcon(s.status === 'stopped' ? 'stop' : s.status === 'warn' ? 'warn' : s.icon)}<span class="ts-text">${escapeHTML(text)}</span>${ms >= 50 ? `<small class="ts-time">${fmtMs(ms)}</small>` : ''}</li>`;
}

/** Draw a trace: live (open, current step in the header) or finished (one folded line). */
function renderTrace(t) {
  const box = t.node.querySelector('.trace');
  if (!box) return;
  box.hidden = !t.steps.length;
  if (!t.steps.length) return;
  const now = performance.now();
  const current = t.live ? t.running().at(-1) : null;
  const sum = box.querySelector('.trace-sum');
  box.classList.toggle('live', t.live);
  if (current) {
    sum.innerHTML = `<span class="shimmer">${escapeHTML(current.live)}…</span><small>${fmtMs(now - t.t0)}</small>`;
  } else {
    const n = t.steps.length;
    sum.innerHTML = `<span>${t.stopped ? 'Stopped' : t.live ? 'Working' : 'Done'} · ${n} step${n === 1 ? '' : 's'}</span><small>${fmtMs(t.live ? now - t.t0 : t.total || 0)}</small>`;
  }
  const shown = t.shown || 0;
  box.querySelector('.trace-list').innerHTML = t.steps.map((s, i) => traceRow(s, now, t.live && i >= shown)).join('');
  t.shown = t.steps.length; // only rows that are new this time slide in
  // Screen readers hear each new step once, not every tick of the clock.
  const say = current ? `${current.live}` : t.live ? '' : `${t.stopped ? 'Stopped' : 'Done'} in ${fmtMs(t.total || 0)}`;
  if (say && say !== t.said) { t.said = say; t.node.querySelector('.trace-live').textContent = say; }
}

/** The saved steps of a finished reply (older replies only have their web tool steps). */
function renderSavedTrace(node, msg) {
  const saved = msg.trace || (msg.tools?.length ? { total: 0, steps: msg.tools.map((x) => ({ icon: x.tool, tool: x.tool, status: x.status, label: stepLabel(x) })) } : null);
  if (!saved?.steps?.length) { node.querySelector('.trace').hidden = true; return; }
  renderTrace({ node, steps: saved.steps, live: false, total: saved.total, stopped: saved.stopped, running: () => [], said: 'x' });
}

/** Numbered source links under a reply. */
function renderSources(node, sources) {
  const box = node.querySelector('.sources');
  box.hidden = !sources?.length;
  if (!sources?.length) return;
  box.innerHTML = `<span class="sources-label" id="src-${node.dataset.index}">Sources</span><ul aria-labelledby="src-${node.dataset.index}">${sources.map((s) => `<li><a href="${escapeHTML(s.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(s.url)}"><b>${s.n}</b>${toolIcon(s.tool)}<span>${escapeHTML(s.title)}</span><small>${escapeHTML(shortUrl(s.url))}</small></a></li>`).join('')}</ul>`;
}

function renderAssistant(msg, index) {
  const node = $('tpl-assistant').content.firstElementChild.cloneNode(true);
  node.dataset.index = index;
  fillAssistant(node, msg.content, { thinkMs: msg.thinkMs || 0, sources: msg.sources });
  renderSavedTrace(node, msg);
  renderSources(node, msg.sources);
  const meta = [msg.model, msg.ms ? `${(msg.ms / 1000).toFixed(1)}s` : '', msg.stopped ? 'stopped' : ''].filter(Boolean).join(' · ');
  node.querySelector('.meta').textContent = meta;
  node.querySelector('[data-act="copy"]').addEventListener('click', () => copyText(splitThinking(msg.content).answer));
  node.querySelector('[data-act="retry"]').addEventListener('click', () => retry(index));
  node.querySelector('[data-act="note"]').addEventListener('click', () => saveReplyAsNote(msg));
  setWhen(node, msg.at);
  const parts = splitThinking(msg.content);
  if (parts.thinking && !parts.answer && !msg.stopped) {
    const hint = document.createElement('div');
    hint.className = 'empty-answer';
    hint.innerHTML = '<span>The model used up its space while thinking and gave no answer.</span><button type="button" class="btn sm accent">Answer without thinking</button>';
    hint.querySelector('button').addEventListener('click', () => { state.noThinkOnce = true; retry(index); });
    node.querySelector('.md').after(hint);
  }
  return node;
}

function renderChat() {
  el.messages.textContent = '';
  const msgs = state.chat?.messages || [];
  msgs.forEach((m, i) => el.messages.appendChild(m.role === 'user' ? renderUser(m, i) : renderAssistant(m, i)));
  renderChatHeader();
  placeComposer();
  renderProjectPill();
  scheduleMemory();
  document.querySelectorAll('.chat-item').forEach((n) => n.classList.toggle('active', n.dataset.id === state.chat?.id));
  scrollToBottom(true);
}

// ---------------------------------------------------------------- attachments

const MAX_FILE_BYTES = 300_000;
const THINK_LIMIT_MS = 60_000; // longest a model may think before it is asked to answer directly
const MAX_PDF_BYTES = 15 * 1024 * 1024; // PDFs are kept as data in the chat, so keep them reasonable
const PASTE_AS_FILE_CHARS = 1500; // pastes longer than this become a "Pasted text" card

function fileExt(name) {
  return (String(name).match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'txt').slice(0, 4);
}

/** Lines in a text, for file cards ("42 lines"). */
function lineCount(text) {
  const t = String(text || '');
  return t ? t.split('\n').length : 0;
}

/** "120 B", "4.2 KB", "1.3 MB" */
export function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const FILE_ICONS = {
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"/>',
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/>',
  data: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>',
  json: '<path d="M8 4c-2 0-2 1.5-2 3v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 1.5 0 3 2 3M16 4c2 0 2 1.5 2 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 1.5 0 3-2 3"/>',
  web: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  log: '<path d="M5 6h14M5 10h14M5 14h10M5 18h7"/>',
  paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6"/>',
  pdf: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M8.5 17v-4h1.3a1.2 1.2 0 0 1 0 2.4H8.5M13 13v4h1a2 2 0 0 0 0-4z"/>',
};

/** Icon family and colour for a file, by extension. */
export function fileKind(name, pasted = false) {
  if (pasted) return { icon: 'paste', color: '#8b6f47', label: 'Pasted' };
  if (/\.pdf$/i.test(name)) return { icon: 'pdf', color: '#d93025', label: 'PDF' };
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  const table = {
    py: ['code', '#3572a5', 'Python'], js: ['code', '#c9a400', 'JavaScript'], mjs: ['code', '#c9a400', 'JavaScript'], jsx: ['code', '#c9a400', 'React'],
    ts: ['code', '#3178c6', 'TypeScript'], tsx: ['code', '#3178c6', 'React'], java: ['code', '#b07219', 'Java'], kt: ['code', '#a97bff', 'Kotlin'],
    c: ['code', '#555d6b', 'C'], h: ['code', '#555d6b', 'C header'], cpp: ['code', '#f34b7d', 'C++'], go: ['code', '#00add8', 'Go'], rs: ['code', '#b7410e', 'Rust'],
    rb: ['code', '#cc342d', 'Ruby'], php: ['code', '#777bb4', 'PHP'], swift: ['code', '#f05138', 'Swift'],
    html: ['web', '#e34c26', 'HTML'], css: ['web', '#563d7c', 'CSS'], xml: ['web', '#0060ac', 'XML'],
    json: ['json', '#cb7a00', 'JSON'], yml: ['json', '#cb171e', 'YAML'], yaml: ['json', '#cb171e', 'YAML'], toml: ['json', '#9c4221', 'TOML'], ini: ['json', '#6b7280', 'INI'],
    csv: ['data', '#1f8f4e', 'CSV'], tsv: ['data', '#1f8f4e', 'TSV'], sql: ['data', '#e38c00', 'SQL'],
    sh: ['term', '#2f855a', 'Shell'], bash: ['term', '#2f855a', 'Shell'], zsh: ['term', '#2f855a', 'Shell'],
    log: ['log', '#6b7280', 'Log'], md: ['doc', '#c96442', 'Markdown'], txt: ['doc', '#6b7280', 'Text'],
  };
  const [icon, color, label] = table[ext] || ['doc', '#6b7280', ext ? ext.toUpperCase() : 'Text'];
  return { icon, color, label };
}

function fileIconHTML(kind) {
  return `<span class="fc-icon" style="--fc:${kind.color}"><svg viewBox="0 0 24 24" aria-hidden="true">${FILE_ICONS[kind.icon]}</svg></span>`;
}

/**
 * An attachment card: type icon + badge, a peek at the first lines, the file name, size and lines.
 * Click opens the full file; `onRemove` adds a remove button (composer only).
 */
function fileChip(f, onRemove) {
  const kind = fileKind(f.name, f.pasted);
  const card = document.createElement('div');
  card.className = 'file-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open ${f.name}`);
  card.title = `${f.name} · ${kind.label} · ${formatSize(f.size)}`;
  card.innerHTML = `<div class="fc-top">${fileIconHTML(kind)}<span class="fc-type" style="--fc:${kind.color}"></span></div>`
    + '<pre class="fc-peek"></pre><div class="fc-foot"><span class="fc-name"></span><span class="fc-meta"><span class="fc-size"></span><span class="fc-lines"></span></span></div>';
  card.querySelector('.fc-type').textContent = f.pasted ? 'PASTED' : (fileExt(f.name) || 'txt').toUpperCase();
  const peek = f.pdf && f.text ? f.text.replace(/^\[Page 1\]\n/, '') : f.text;
  card.querySelector('.fc-peek').textContent = f.pdf && !f.text ? 'PDF document\nClick to open' : String(peek || '').split('\n').slice(0, 4).join('\n').slice(0, 300);
  card.querySelector('.fc-name').textContent = f.name;
  card.querySelector('.fc-size').textContent = formatSize(f.size);
  const n = lineCount(f.text);
  card.querySelector('.fc-lines').textContent = f.pdf ? (f.pages ? `${f.pages} page${f.pages === 1 ? '' : 's'}` : 'Opens on the right') : `${n} line${n === 1 ? '' : 's'}`;
  const open = () => (f.pdf ? openPanel({ kind: 'pdf', title: f.name, data: f.data, size: f.size }) : isPreviewable(fileExt(f.name), f.text) ? openPanel({ kind: 'html', title: f.name, code: f.text }) : previewFile(f));
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  if (onRemove) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'fc-x';
    x.setAttribute('aria-label', `Remove ${f.name}`);
    x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
    card.appendChild(x);
  }
  return card;
}

/** Show a whole attached file in a dialog, highlighted when it is code. */
function previewFile(f) {
  const dlg = $('file-preview');
  $('fp-name').textContent = f.name;
  const n = lineCount(f.text);
  $('fp-meta').textContent = `${fileKind(f.name, f.pasted).label} · ${n} line${n === 1 ? '' : 's'} · ${formatSize(f.size)}`;
  $('fp-body').innerHTML = renderMarkdown(`\`\`\`${f.pasted ? 'text' : fileExt(f.name)}\n${String(f.text || '').replace(/```/g, '`\u200b``')}\n\`\`\``);
  $('fp-copy').onclick = () => copyText(f.text || '');
  dlg.showModal();
}

function renderPending() {
  const box = $('attachments');
  box.textContent = '';
  state.pending.forEach((f, i) => box.appendChild(fileChip(f, () => { state.pending.splice(i, 1); renderPending(); })));
  box.hidden = !state.pending.length;
  updateSend();
  scheduleMemory();
}

function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Fill a PDF attachment's text (and pages, cut, error) from its bytes, in the browser. */
async function readPdf(f, bytes) {
  try {
    const r = await pdfText(bytes ?? await (await fetch(f.data)).arrayBuffer());
    Object.assign(f, { text: r.text, pages: r.pages, read: r.read, cut: r.cut });
    delete f.error;
  } catch (e) {
    Object.assign(f, { text: '', pages: 0, error: e?.message || 'This PDF could not be read' });
  }
  return f;
}

/** Read text files in the browser (nothing is uploaded). Binary and huge files are refused. */
async function addFiles(list) {
  if (!list.length) return;
  for (const file of list) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      if (file.size > MAX_PDF_BYTES) { toast(`${file.name} is too big (max 15 MB)`); continue; }
      const item = { name: file.name, size: file.size, pdf: true, data: await readDataURL(file), text: '' };
      toast(`Reading ${file.name}…`);
      await readPdf(item, await file.arrayBuffer());
      if (item.error) toast(`${file.name}: ${item.error}. It is attached, but the model can't read it.`);
      else if (!item.text) toast(`${file.name} has no text to read; it looks like scanned pictures`);
      state.pending.push(item);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) { toast(`${file.name} is too big (max 300 KB)`); continue; }
    const text = await file.text();
    if (text.includes('\u0000')) { toast(`${file.name} is not a text file`); continue; }
    state.pending.push({ name: file.name, size: file.size, text });
  }
  renderPending();
  el.input.focus();
}

// ---------------------------------------------------------------- side panel (HTML preview, PDF)

const panel = { kind: '', title: '', code: '', data: '', url: '' };

function dataURLToBlobURL(dataURL) {
  const [head, b64] = String(dataURL).split(',');
  const mime = head.match(/data:([^;]+)/)?.[1] || 'application/octet-stream';
  const bin = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function renderPanelBody(tab = 'preview') {
  const body = $('sp-body');
  body.textContent = '';
  $('sp-tabs').querySelectorAll('.seg').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (panel.kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.className = 'sp-frame pdf';
    frame.title = panel.title;
    frame.src = panel.url;
    body.appendChild(frame);
    return;
  }
  if (tab === 'code') {
    const box = document.createElement('div');
    box.className = 'md sp-code';
    box.innerHTML = renderMarkdown(`\`\`\`html\n${panel.code.replace(/```/g, '`\u200b``')}\n\`\`\``);
    body.appendChild(box);
    return;
  }
  body.appendChild(sandboxedFrame(panel.code, `Preview of ${panel.title}`));
}

/** Open the right-hand panel: { kind: 'html', title, code } or { kind: 'pdf', title, data, size }. */
function openPanel(item) {
  if (panel.url) URL.revokeObjectURL(panel.url);
  Object.assign(panel, { kind: item.kind, title: item.title || 'Preview', code: item.code || '', data: item.data || '', url: '' });
  if (item.kind === 'pdf') panel.url = dataURLToBlobURL(item.data);
  $('sp-title').textContent = panel.title;
  $('sp-sub').textContent = item.kind === 'pdf' ? `PDF · ${formatSize(item.size)}` : `HTML · ${lineCount(panel.code)} lines · sandboxed`;
  const kind = item.kind === 'pdf' ? fileKind('x.pdf') : fileKind('x.html');
  $('sp-icon').innerHTML = fileIconHTML(kind);
  $('sp-tabs').hidden = item.kind === 'pdf';
  $('sp-copy').hidden = item.kind === 'pdf';
  $('side-panel').hidden = false;
  el.app.classList.add('panel-open');
  if (!narrow() && window.innerWidth < 1200) setSidebar(false, false); // make room for the panel
  renderPanelBody('preview');
}

function closePanel() {
  $('side-panel').hidden = true;
  el.app.classList.remove('panel-open');
  $('sp-body').textContent = '';
  if (panel.url) URL.revokeObjectURL(panel.url);
  panel.url = '';
}

function downloadPanel() {
  const a = document.createElement('a');
  if (panel.kind === 'pdf') { a.href = panel.url; a.download = panel.title; } else {
    a.href = URL.createObjectURL(new Blob([panel.code], { type: 'text/html' }));
    a.download = /\.(html?|svg)$/i.test(panel.title) ? panel.title : 'page.html';
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  a.click();
}

/** The first complete HTML document in a reply, if any (```html … ``` with <!doctype or <html>). */
function htmlDocIn(text) {
  for (const m of String(text).matchAll(/```(html|htm)?\s*\n([\s\S]*?)```/gi)) {
    if (/<!doctype html|<html[\s>]/i.test(m[2])) return m[2];
  }
  return '';
}

// ---------------------------------------------------------------- chats

function newChat(projectId = null) {
  if (state.busy) stop();
  closePanel();
  state.chat = null;
  state.newProjectId = projectId;
  showView('chat');
  history.replaceState(null, '', location.pathname + location.search);
  renderChat();
  el.input.value = '';
  autosize();
  updateSend();
  el.input.focus();
}

async function openChat(id) {
  if (state.busy) stop();
  if (id !== state.chat?.id) closePanel();
  const rec = await getChat(id);
  if (!rec) { newChat(); return; }
  state.chat = rec;
  state.newProjectId = null;
  showView('chat');
  history.replaceState(null, '', `#/c/${id}`);
  renderChat();
}

async function persist() {
  if (!state.chat) return;
  state.chat.updatedAt = Date.now();
  await saveChat(state.chat);
  refreshList();
}

async function send(text) {
  text = text.trim();
  const files = state.pending;
  if ((!text && !files.length) || state.busy) return;
  const slash = /^\/(wiki|wikipedia|ddg|duckduckgo|read)\b/i.exec(text);
  if (slash && !planTools(text).calls.length) {
    toast(slash[1].toLowerCase() === 'read' ? 'Add a link to read: /read https://example.com' : `Add what to search: ${slash[0]} Taj Mahal`);
    return;
  }
  if (!state.chat) {
    const now = Date.now();
    state.chat = { id: newId(), title: titleFrom(text || files[0].name), projectId: state.newProjectId || null, createdAt: now, updatedAt: now, messages: [] };
    state.newProjectId = null;
    history.replaceState(null, '', `#/c/${state.chat.id}`);
  }
  state.chat.messages.push({ role: 'user', content: text, at: Date.now(), ...(files.length ? { files } : {}) });
  state.pending = [];
  renderPending();
  el.input.value = '';
  autosize();
  renderChat();
  await persist();
  respond();
}

function retry(index) {
  if (state.busy || !state.chat) return;
  state.chat.messages = state.chat.messages.slice(0, index); // drop this reply and anything after it
  renderChat();
  respond();
}

function editMessage(node, index) {
  if (state.busy) return;
  const msg = state.chat.messages[index];
  const bubble = node.querySelector('.bubble');
  const box = document.createElement('div');
  box.className = 'edit-box';
  box.innerHTML = '<textarea aria-label="Edit message"></textarea><div class="edit-actions"><button type="button" class="btn" data-x="cancel">Cancel</button><button type="button" class="btn primary" data-x="save">Save</button></div>';
  const ta = box.querySelector('textarea');
  ta.value = msg.content;
  bubble.replaceWith(box);
  node.querySelector('.actions').hidden = true;
  ta.focus();
  box.querySelector('[data-x="cancel"]').addEventListener('click', renderChat);
  const save = async () => {
    const t = ta.value.trim();
    if (!t) return;
    state.chat.messages = state.chat.messages.slice(0, index);
    state.chat.messages.push({ role: 'user', content: t, at: Date.now(), ...(msg.files?.length ? { files: msg.files } : {}) });
    if (index === 0) state.chat.title = titleFrom(t);
    renderChat();
    await persist();
    respond();
  };
  box.querySelector('[data-x="save"]').addEventListener('click', save);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } });
}

// ---------------------------------------------------------------- model loading

function card(html, cls = '') {
  const c = document.createElement('div');
  c.className = `msg assistant load-card ${cls}`;
  c.innerHTML = html;
  el.messages.appendChild(c);
  scrollToBottom(true);
  return c;
}

/** Load the model, showing progress in `c`. Shared if a load is already running. */
function startLoad(m) {
  if (!state.loading) {
    state.loadProgress = 0;
    state.loadingId = m.id;
    state.loading = loadModel(m, (p, text) => {
      state.loadProgress = p;
      const pct = Math.round(p * 100);
      updateLoaders();
      document.querySelectorAll('.load-card .progress > i').forEach((i) => { i.style.width = `${pct}%`; });
      document.querySelectorAll('.load-card .ptext').forEach((t) => { t.textContent = `${pct}% · ${text}`; });
    }).finally(() => {
      state.loading = null;
      state.loadingId = '';
      updateModelState();
      if (!el.modelMenu.hidden) renderModelMenu();
    });
    updateModelState();
    if (!el.modelMenu.hidden) renderModelMenu();
  }
  return state.loading;
}

/** A small round progress loader with a percentage, used next to the model name and in the menu. */
function ringHTML() {
  const pct = Math.round(state.loadProgress * 100);
  return `<span class="ring" data-ring style="--p:${pct}" role="progressbar" aria-label="Downloading model" aria-valuenow="${pct}"></span><span class="ring-pct" data-ring-pct>${pct}%</span>`;
}

function updateLoaders() {
  const pct = Math.round(state.loadProgress * 100);
  document.querySelectorAll('[data-ring]').forEach((r) => { r.style.setProperty('--p', pct); r.setAttribute('aria-valuenow', pct); });
  document.querySelectorAll('[data-ring-pct]').forEach((t) => { t.textContent = `${pct}%`; });
}

/** Download + load a model from a button (composer or menu), without sending a message. */
function downloadModel(m) {
  if (state.loading && state.loadingId !== m.id) { toast('Another model is downloading. Wait for it to finish.'); return; }
  startLoad(m).then(() => toast(`${m.label} is ready`)).catch((e) => toast(`Download failed: ${e?.message || e}`));
}

/**
 * Make sure the chosen model is ready. A cached model just loads; a new one first asks
 * the user before downloading (never auto-download gigabytes). Resolves true when ready.
 */
async function ensureModel(signal) {
  const m = model();
  if (modelReady(m)) return true;
  const cached = state.loading ? true : await modelCached(m);
  if (!cached) {
    const c = card(`<h3>Download ${m.label}?</h3>
      <p>This model (${m.gb} GB) runs entirely on this device. It downloads once from Hugging Face${m.engine === 'gpu' ? ' / MLC' : ''}, is saved in your browser, and works offline after that. Your messages never leave this tab.</p>
      <div class="row"><button type="button" class="btn accent" data-x="go">Download ${m.gb} GB</button><button type="button" class="btn" data-x="pick">Choose another model</button></div>`);
    const ok = await new Promise((resolve) => {
      c.querySelector('[data-x="go"]').addEventListener('click', () => resolve(true));
      c.querySelector('[data-x="pick"]').addEventListener('click', () => { resolve(false); openModelMenu(); });
      signal.addEventListener('abort', () => resolve(false), { once: true });
    });
    c.remove();
    if (!ok) return false;
  }
  const resizing = loadedWithOtherCtx(m);
  state.lastLoad = { what: resizing ? 'resized' : cached ? 'loaded' : 'downloaded', start: performance.now() };
  const c = card(`<h3>${resizing ? `Resizing memory to ${fmtCtx(m.ctx)}` : cached ? 'Loading' : 'Downloading'} ${resizing ? '' : m.label}…</h3>
    <div class="progress"><i style="width:${Math.round(state.loadProgress * 100)}%"></i></div><div class="ptext">Starting…</div>`);
  try {
    await Promise.race([startLoad(m), new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('Stopped', 'AbortError')), { once: true }))]);
  } finally {
    c.remove();
  }
  return modelReady(model());
}

// ---------------------------------------------------------------- answering

async function respond() {
  if (state.busy) return;
  const chat = state.chat;
  const controller = new AbortController();
  state.controller = controller;
  setBusy(true);
  const wasReady = modelReady(model());
  state.lastLoad = null;
  try {
    if (!(await ensureModel(controller.signal))) { finishRun(controller); return; }
  } catch (e) {
    if (e?.name !== 'AbortError') showError(e);
    finishRun(controller);
    return;
  }
  const m = model();
  const settings = getSettings();
  const project = chat.projectId ? await getProject(chat.projectId) : null;
  const budgets = budgetsFor(m.ctx);
  const composed = composeSystem({ base: settings.systemPrompt, project, budget: budgets.knowledge });
  const system = composed.text;
  const index = chat.messages.length;
  const node = renderAssistant({ role: 'assistant', content: '' }, index);
  node.classList.add('streaming');
  el.messages.appendChild(node);
  const trace = createTrace(node);
  node.querySelector('.trace').open = true;
  const where = m.engine === 'gpu' ? 'on your GPU' : m.engine === 'cpu' ? 'on your CPU' : 'in demo mode';
  if (!wasReady && state.lastLoad) {
    const ms = performance.now() - state.lastLoad.start;
    trace.note({ icon: 'model', ms, label: state.lastLoad.what === 'downloaded' ? `Downloaded ${m.label} (${m.gb} GB) and loaded it ${where}`
      : state.lastLoad.what === 'resized' ? `Resized the model's memory to ${fmtCtx(m.ctx)}` : `Loaded ${m.label} into memory ${where}` });
  } else {
    trace.note({ icon: 'model', label: `Using ${m.label} ${where} · ${fmtCtx(m.ctx)} memory` });
  }
  if (project) {
    const f = composed.files;
    const parts = [composed.instructions ? 'its instructions' : '', f.length ? `${f.length} file${f.length === 1 ? '' : 's'} (${f.map((x) => x.name).join(', ')})` : ''].filter(Boolean);
    const skipped = (project.files || []).length - f.length;
    const cut = f.filter((x) => x.cut).length;
    trace.note({ icon: 'project', label: `Read project “${project.name}”${parts.length ? `: ${parts.join(' and ')}` : ''}${f.length ? ` · ${composed.used.toLocaleString()} characters` : ''}` });
    if (skipped > 0 || cut) trace.note({ icon: 'warn', status: 'warn', label: `Project files too big for the model's memory: ${[cut ? `${cut} cut short` : '', skipped > 0 ? `${skipped} left out` : ''].filter(Boolean).join(', ')}` });
  }
  const userTurn = chat.messages.findLast((x) => x.role === 'user');
  const attached = userTurn?.files || [];
  const texts = attached.filter((f) => !f.pdf);
  // This turn's PDFs, plus any earlier one saved before PDFs could be read (it is read now).
  const pdfs = [...new Set([...attached, ...chat.messages.flatMap((x) => x.files || [])])].filter((f) => f.pdf && (attached.includes(f) || f.pages === undefined));
  if (texts.length) trace.note({ icon: 'file', label: `Read ${texts.length} attached file${texts.length === 1 ? '' : 's'}: ${texts.map((f) => f.name).join(', ')}${texts.some((f) => String(f.text || '').length > 6000) ? ' (long ones cut to fit)' : ''}` });
  for (const f of pdfs) {
    let step = null;
    if (f.pages === undefined) { // attached before PDFs could be read: read it now (timed, so it shows)
      step = trace.add({ icon: 'file', live: `Reading ${f.name}` });
      await readPdf(f);
      saveChat(chat);
    }
    const len = String(f.text || '').length;
    const done = f.error ? { icon: 'warn', status: 'warn', label: `Couldn't read ${f.name}: ${f.error}` }
      : !len ? { icon: 'warn', status: 'warn', label: `No text in ${f.name}: it looks like scanned pictures, which can't be read yet` }
        : { icon: 'file', label: `Read PDF ${f.name}: ${f.read < f.pages ? `${f.read} of ${f.pages}` : f.pages} page${f.pages === 1 ? '' : 's'} · ${len.toLocaleString()} characters${len > 6000 ? ' (cut to fit the model\'s memory)' : ''}` };
    if (step) trace.end(step, done); else trace.note(done);
  }
  scrollToBottom(true);

  // Web tools run first (only those the user turned on, or named with /wiki, /ddg, /read).
  // Their results go into what the model reads for this turn; the saved message stays as typed.
  let history = chat.messages;
  let steps = [];
  let sources = [];
  const lastUser = chat.messages.findLast((x) => x.role === 'user');
  const plan = planTools(lastUser?.content, settings.tools || {});
  if (plan.calls.length) {
    try {
      const rows = new Map();
      ({ steps, sources } = await runTools(plan.calls, { signal: controller.signal, onStep: (st) => {
        const label = stepLabel(st);
        if (!rows.has(st)) rows.set(st, trace.add({ icon: st.tool, tool: st.tool, live: label.replace(/…$/, '') }));
        const row = rows.get(st);
        if (st.status !== 'running') trace.end(row, { status: st.status, label });
        scrollToBottom();
      } }));
    } catch (e) {
      trace.finish();
      node.remove();
      if (e?.name !== 'AbortError') showError(e);
      finishRun(controller);
      return;
    }
    if (state.chat !== chat) { trace.finish(); node.remove(); finishRun(controller); return; }
    renderSources(node, sources);
  }
  if (plan.calls.length || plan.explicit) {
    const content = sources.length
      ? withSources(plan.question, sources, { budget: Math.round(budgets.prompt * 0.4) })
      : `${plan.calls.length ? '(The web search found nothing for this. Say so, then answer from what you know.)\n\n' : ''}${plan.question}`;
    history = chat.messages.map((x) => (x === lastUser ? { ...x, content } : x));
  }

  let latest = '';
  let frame = 0;
  let thinkStart = 0;
  let thinkMs = 0;
  const trackThinking = (t) => {
    if (!thinkStart && /<think>/i.test(t)) thinkStart = performance.now();
    if (thinkStart && !thinkMs && /<\/think>/i.test(t)) thinkMs = performance.now() - thinkStart;
  };
  const paint = () => {
    frame = 0;
    const stick = nearBottom();
    fillAssistant(node, latest, { live: true, thinkMs: thinkMs || (thinkStart ? performance.now() - thinkStart : 0), sources });
    if (stick) scrollToBottom(true);
  };
  const started = performance.now();
  let reply = '';
  let stoppedEarly = false;
  const prompt = buildPrompt(history, { systemPrompt: system, budgetChars: budgets.prompt });
  const turnsAll = history.filter((x) => (x.role === 'user' || x.role === 'assistant') && (String(x.content ?? '').trim() || x.files?.length)).length;
  const dropped = turnsAll - (prompt.length - 1);
  if (dropped > 0) trace.note({ icon: 'memory', label: `Left out ${dropped} older message${dropped === 1 ? '' : 's'} to fit the model's ${fmtCtx(m.ctx)} memory` });
  const promptChars = prompt.reduce((a, x) => a + x.content.length, 0);
  // Phases of the model's own work, switched by what the stream really contains.
  let phase = null; // 'read' | 'think' | 'write'
  let readRow = null;
  let thinkRow = null;
  let writeRow = null;
  let writeTokens = 0;
  const onStream = (text) => {
    const parts = splitThinking(text);
    if (phase === 'read') {
      trace.end(readRow, { label: `Read the conversation: ${prompt.length - 1} message${prompt.length === 2 ? '' : 's'}, ${promptChars.toLocaleString()} characters` });
      phase = null;
    }
    if (parts.thinkingOpen && !thinkRow && phase !== 'think') {
      phase = 'think';
      thinkRow = trace.add({ icon: 'think', live: 'Thinking' });
    }
    if (!parts.thinkingOpen && phase === 'think') {
      if (parts.thinking.trim()) trace.end(thinkRow, { label: 'Thought it through' }); else trace.drop(thinkRow);
      phase = null;
    }
    if (!parts.thinkingOpen && parts.answer.trim() && phase !== 'write' && !writeRow) {
      phase = 'write';
      writeRow = trace.add({ icon: 'write', live: 'Writing the answer' });
    }
    if (phase === 'write') writeTokens++;
  };
  const startReading = (again = false) => {
    phase = 'read';
    readRow = trace.add({ icon: 'read', live: again ? 'Reading the conversation again, to answer without thinking' : 'Reading the conversation' });
  };
  const think = !!settings.think && !state.noThinkOnce;
  state.noThinkOnce = false;
  // Small reasoning models can think in circles. Past the limit, stop the thinking and ask again
  // without it, so there is always an answer.
  let cutThinking = false;
  const runOnce = async (withThinking, prefix = '') => {
    const inner = new AbortController();
    const onStop = () => inner.abort();
    controller.signal.addEventListener('abort', onStop, { once: true });
    const limit = window.__thinkLimitMs ?? THINK_LIMIT_MS;
    const timer = withThinking ? setInterval(() => {
      if (thinkStart && !thinkMs && performance.now() - thinkStart > limit) { cutThinking = true; inner.abort(); }
    }, 250) : 0;
    try {
      return prefix + await runChat(m, prompt, {
        signal: inner.signal, temperature: Number(settings.temperature), think: withThinking,
        onToken: (t) => { latest = prefix + t; trackThinking(latest); onStream(latest); frame ||= requestAnimationFrame(paint); },
      });
    } finally {
      clearInterval(timer);
      controller.signal.removeEventListener('abort', onStop);
    }
  };
  try {
    try {
      startReading();
      reply = await runOnce(think);
    } catch (e) {
      if (!(e?.name === 'AbortError' && cutThinking && !controller.signal.aborted)) throw e;
      thinkMs = performance.now() - thinkStart;
      trace.end(thinkRow, { status: 'warn', label: `Thinking went on too long: stopped it after ${thoughtFor(thinkMs)}` });
      phase = null;
      startReading(true);
      const thoughts = splitThinking(latest).thinking;
      reply = await runOnce(false, `<think>${thoughts}\n\n(Thinking stopped after ${thoughtFor(thinkMs)}; answered directly.)</think>`);
    }
  } catch (e) {
    if (e?.name === 'AbortError') { stoppedEarly = true; reply = latest; } else {
      trace.finish();
      node.remove();
      showError(e);
      finishRun(controller);
      return;
    }
  }
  if (frame) cancelAnimationFrame(frame);
  if (writeRow?.status === 'running' && !stoppedEarly) {
    const words = (splitThinking(reply).answer.match(/\S+/g) || []).length;
    const secs = (performance.now() - writeRow.start) / 1000;
    trace.end(writeRow, { label: `Wrote the answer: ${words.toLocaleString()} word${words === 1 ? '' : 's'}${secs >= 0.5 && writeTokens > 3 ? ` · ${(writeTokens / secs).toFixed(1)} tokens/s` : ''}` });
  }
  const doc = !stoppedEarly && htmlDocIn(splitThinking(reply).answer);
  const docTitle = doc ? /<title>([^<]{1,60})<\/title>/i.exec(doc)?.[1] || 'page.html' : '';
  if (doc) trace.note({ icon: 'preview', label: `Opened “${docTitle}” in the preview panel` });
  trace.finish({ stopped: stoppedEarly });
  if (state.chat === chat && (reply.trim() || !stoppedEarly)) {
    chat.messages.push({ role: 'assistant', content: reply.trim() || '_(no reply)_', at: Date.now(), model: m.label, ms: Math.round(performance.now() - started), ...(thinkMs ? { thinkMs: Math.round(thinkMs) } : {}), ...(stoppedEarly ? { stopped: true } : {}),
      trace: trace.toJSON(),
      ...(steps.length ? { tools: steps.map(({ tool, query, status, count, error }) => ({ tool, query, status, count, error })) } : {}),
      ...(sources.length ? { sources: sources.map(({ n, tool, title, url }) => ({ n, tool, title, url })) } : {}) });
    await persist();
    if (state.chat === chat) {
      renderChat();
      if (doc) openPanel({ kind: 'html', title: docTitle, code: doc });
    }
  } else {
    node.remove();
  }
  finishRun(controller);
}

function finishRun(controller) {
  if (state.controller === controller) state.controller = null;
  setBusy(false);
  updateModelState();
}

function showError(e) {
  if (e?.code === 'GPU_FAILED') {
    const safeAlready = model().safe || getSettings().gpuSafe;
    const c = card(`<h3>Your GPU couldn't run this model</h3><p class="err"></p>
      <div class="row"><button type="button" class="btn accent" data-x="cpu">Switch to CPU</button>
      ${safeAlready ? '' : '<button type="button" class="btn" data-x="safe">Try GPU-safe version</button>'}
      <button type="button" class="btn" data-x="pick">Choose another model</button></div>`, 'error-card');
    c.querySelector('.err').textContent = 'Some graphics cards and drivers (often NVIDIA on Linux) cannot run the fast "f16" version of WebGPU models. The CPU works on every computer; the GPU-safe version uses a slightly bigger download that most GPUs can run.';
    c.querySelector('[data-x="cpu"]').addEventListener('click', () => { c.remove(); saveSettings({ engine: 'cpu' }); updateModelState(); toast(`Model: ${model().label}`); respond(); });
    c.querySelector('[data-x="safe"]')?.addEventListener('click', () => { c.remove(); saveSettings({ gpuSafe: true }); updateModelState(); respond(); });
    c.querySelector('[data-x="pick"]').addEventListener('click', () => { c.remove(); openModelMenu(); });
    return;
  }
  const c = card(`<h3>Something went wrong</h3><p class="err"></p><div class="row"><button type="button" class="btn" data-x="retry">Try again</button><button type="button" class="btn" data-x="pick">Choose another model</button></div>`, 'error-card');
  c.querySelector('.err').textContent = e?.message || String(e);
  c.querySelector('[data-x="retry"]').addEventListener('click', () => { c.remove(); respond(); });
  c.querySelector('[data-x="pick"]').addEventListener('click', () => { c.remove(); openModelMenu(); });
}

function stop() {
  state.controller?.abort();
}

// ---------------------------------------------------------------- model menu

let f16 = true;

// ---------------------------------------------------------------- memory meter

let memProject = { id: null, value: null };
let memTimer = 0;

/** How full the small model's ~4k-token memory will be for the next message. */
async function updateMemory() {
  const meter = $('mem');
  const history = state.chat?.messages || [];
  const draft = { content: el.input.value.trim(), ...(state.pending.length ? { files: state.pending } : {}) };
  if (!history.length && !draft.content && !state.pending.length) { meter.hidden = true; return; }
  const pid = state.chat ? state.chat.projectId : state.newProjectId;
  if (memProject.id !== pid) memProject = { id: pid, value: pid ? await getProject(pid) : null };
  const budgets = budgetsFor(model().ctx);
  const system = composeSystem({ base: getSettings().systemPrompt, project: memProject.value, budget: budgets.knowledge }).text;
  const m = memoryUse(history, draft, { systemPrompt: system, budgetChars: budgets.prompt });
  const tokens = (n) => `~${Math.round(n / 4).toLocaleString()}`;
  meter.hidden = false;
  meter.classList.toggle('warn', m.pct >= 70 && !m.full);
  meter.classList.toggle('full', m.full);
  meter.setAttribute('aria-valuenow', String(m.pct));
  $('mem-ring').style.setProperty('--p', m.pct);
  $('mem-text').textContent = m.full ? 'Memory full' : `${m.pct}%`;
  $('mem-tip').textContent = m.full
    ? `The model's memory is full. The ${m.dropped} oldest message${m.dropped === 1 ? ' is' : 's are'} left out of what it reads (still saved here). Click to give the model a bigger context window, or start a new chat.`
    : `Model memory: ${tokens(m.used)} of ${tokens(m.budget)} tokens used by instructions, project files and this chat. When it fills up, the oldest messages are left out. Click to change the context window.`;
}

function scheduleMemory() {
  clearTimeout(memTimer);
  memTimer = setTimeout(updateMemory, 120);
}

function renderThinkToggle() {
  const m = model();
  const btn = $('think-btn');
  btn.hidden = !m.thinks;
  const on = !!getSettings().think;
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Thinking is on: slower, better at maths and logic. Click to answer straight away.' : 'Thinking is off: faster answers. Click to let the model think first.';
}

// ---------------------------------------------------------------- web tools

const DISCLAIMER = 'Runs on your device. Small local models can make mistakes; check important answers.';

function toolSettings() {
  return { wikipedia: false, duckduckgo: false, reader: false, ...(getSettings().tools || {}) };
}

function setTool(id, on) {
  saveSettings({ tools: { ...toolSettings(), [id]: on } });
  renderTools();
}

/** The Web button, its menu, and the line under the composer saying what leaves the device. */
function renderTools() {
  const t = toolSettings();
  const on = TOOL_IDS.filter((id) => t[id]);
  const btn = $('tools-btn');
  btn.setAttribute('aria-pressed', String(on.length > 0));
  $('tools-label').textContent = on.length ? `Web · ${on.length}` : 'Web';
  btn.title = on.length ? `Web tools on: ${on.map((id) => TOOLS[id].label).join(', ')}` : 'Web tools are off: nothing leaves this device';
  $('tools-list').innerHTML = TOOL_IDS.map((id) => {
    const x = TOOLS[id];
    return `<label class="tool-opt"><span class="tool-ic">${toolIcon(id)}</span><span class="tool-txt"><b>${x.label}</b><small>${x.what}. Sends ${x.sends} to ${x.host}.</small></span>
      <input type="checkbox" role="switch" class="switch" data-tool="${id}" ${t[id] ? 'checked' : ''} aria-label="${x.label}"><kbd>${x.slash}</kbd></label>`;
  }).join('');
  $('disclaimer').textContent = on.length
    ? `Web tools on: your question is sent to ${on.map((id) => TOOLS[id].host).join(', ')}. Everything else stays on this device.`
    : DISCLAIMER;
  $('disclaimer').classList.toggle('web-on', on.length > 0);
}

function openTools() {
  closeModelMenu();
  renderTools();
  $('tools-menu').hidden = false;
  $('tools-btn').setAttribute('aria-expanded', 'true');
  $('tools-menu').querySelector('input')?.focus();
}

function closeTools({ focus = false } = {}) {
  if ($('tools-menu').hidden) return;
  $('tools-menu').hidden = true;
  $('tools-btn').setAttribute('aria-expanded', 'false');
  if (focus) $('tools-btn').focus();
}

// Typing "/" at the start of a message lists the tool commands.
const SLASH = [
  { cmd: '/wiki ', tool: 'wikipedia', hint: 'Search Wikipedia', example: '/wiki Taj Mahal' },
  { cmd: '/ddg ', tool: 'duckduckgo', hint: 'Instant answer from DuckDuckGo', example: '/ddg Albert Einstein' },
  { cmd: '/read ', tool: 'reader', hint: 'Read a web page (Jina Reader)', example: '/read https://example.com summarise' },
];
const slash = { items: [], active: 0 };

function renderSlash() {
  const v = el.input.value;
  const list = $('slash-list');
  const m = /^\/(\w*)$/.exec(v);
  slash.items = m ? SLASH.filter((x) => x.cmd.startsWith(`/${m[1].toLowerCase()}`)) : [];
  if (!slash.items.length) { closeSlash(); return; }
  slash.active = Math.min(slash.active, slash.items.length - 1);
  list.innerHTML = slash.items.map((x, i) => `<div class="slash-opt${i === slash.active ? ' active' : ''}" role="option" id="slash-${i}" aria-selected="${i === slash.active}" data-i="${i}">
    ${toolIcon(x.tool)}<b>${x.cmd.trim()}</b><span>${x.hint}</span><small>${escapeHTML(x.example)}</small></div>`).join('');
  list.hidden = false;
  el.input.setAttribute('aria-expanded', 'true');
  el.input.setAttribute('aria-activedescendant', `slash-${slash.active}`);
}

function closeSlash() {
  $('slash-list').hidden = true;
  slash.items = [];
  slash.active = 0;
  el.input.setAttribute('aria-expanded', 'false');
  el.input.removeAttribute('aria-activedescendant');
}

function pickSlash(i) {
  const x = slash.items[i];
  if (!x) return;
  el.input.value = x.cmd;
  closeSlash();
  autosize();
  updateSend();
  el.input.focus();
}

async function updateModelState() {
  renderThinkToggle();
  const m = model();
  el.modelLabel.textContent = m.label.replace(/^.*· /, '');
  if (state.loading) {
    if (state.loadingId === m.id) {
      el.modelState.innerHTML = ringHTML();
      el.modelState.title = `Downloading ${m.label}`;
    } else {
      el.modelState.textContent = '';
    }
    return;
  }
  el.modelState.title = '';
  if (modelReady(m)) {
    el.modelState.textContent = m.engine === 'cpu' && !cpuMultithread() && !MOCK ? 'single-thread' : '';
    return;
  }
  if (await modelCached(m)) { el.modelState.textContent = ''; return; }
  if (state.loading || model().id !== m.id) return; // changed while checking
  el.modelState.innerHTML = '<button type="button" class="dl-btn" data-dl><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M6 11l6 6 6-6M5 20h14"/></svg><span></span></button>';
  el.modelState.querySelector('span').textContent = `Download · ${m.gb} GB`;
  el.modelState.querySelector('[data-dl]').addEventListener('click', () => downloadModel(m));
}

async function renderModelMenu() {
  const s = getSettings();
  const engine = MOCK ? 'cpu' : s.engine;
  const gpuOK = hasWebGPU();
  el.modelMenu.querySelectorAll('[data-engine]').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.engine === engine));
    if (b.dataset.engine === 'gpu') b.disabled = !gpuOK;
  });
  el.engineNote.textContent = engine === 'gpu'
    ? 'Runs on your graphics card with WebGPU. Faster replies.'
    : gpuOK ? 'Runs on your processor. Works everywhere, a bit slower.' : 'Runs on your processor. (No WebGPU in this browser, so GPU is off.)';
  const list = engine === 'gpu' ? GPU_MODELS : CPU_MODELS;
  const current = engine === 'gpu' ? s.gpuModel : s.cpuModel;
  el.modelList.textContent = '';
  for (const m of list) {
    const id = engine === 'gpu' ? compatibleModelId(m.id, f16 && !getSettings().gpuSafe) : m.file;
    const row = document.createElement('div');
    row.className = 'model-opt';
    row.setAttribute('role', 'menuitemradio');
    row.dataset.id = id;
    row.setAttribute('aria-checked', String(id.replace('q4f32_1', 'q4f16_1') === String(current).replace('q4f32_1', 'q4f16_1')));
    row.innerHTML = '<button type="button" class="pick"><span class="n"></span><span class="d"></span></button><span class="slot"></span>';
    row.querySelector('.n').textContent = m.label;
    const d = row.querySelector('.d');
    d.textContent = `${m.gb} GB · ${m.note}`;
    row.querySelector('.pick').addEventListener('click', () => pickModel(engine, id));
    el.modelList.appendChild(row);
    const slot = row.querySelector('.slot');
    const info = engine === 'gpu' ? { engine: 'gpu', id, label: m.label, gb: m.gb } : { engine: 'cpu', id, label: m.label, gb: m.gb };
    if (state.loading && state.loadingId === id) { slot.innerHTML = ringHTML(); continue; }
    const cached = MOCK ? Promise.resolve(!window.__mockNotCached || mockReady())
      : (engine === 'gpu' ? isGpuCached(id) : isCpuCached(id));
    cached.then((c) => {
      if (c) { d.textContent = `${m.gb} GB · ${m.note} · downloaded`; slot.textContent = ''; return; }
      slot.innerHTML = '<button type="button" class="dl-btn sm" data-dl><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M6 11l6 6 6-6M5 20h14"/></svg>Download</button>';
      slot.querySelector('[data-dl]').addEventListener('click', () => {
        saveSettings(engine === 'gpu' ? { engine, gpuModel: id.replace('q4f32_1', 'q4f16_1') } : { engine, cpuModel: id });
        downloadModel(MOCK ? model() : info);
      });
    });
  }
}

function pickModel(engine, id) {
  saveSettings(engine === 'gpu' ? { engine, gpuModel: id.replace('q4f32_1', 'q4f16_1') } : { engine, cpuModel: id });
  closeModelMenu();
  updateModelState();
  toast(`Model: ${model().label}`);
}

function openModelMenu() {
  closeTools();
  renderModelMenu();
  el.modelMenu.hidden = false;
  el.modelBtn.setAttribute('aria-expanded', 'true');
}

function closeModelMenu() {
  el.modelMenu.hidden = true;
  el.modelBtn.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------- command palette (Ctrl+K)

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';
export const SHORTCUTS = [
  [`${MOD} K`, 'Open the command palette'],
  [`${MOD} Shift O`, 'New chat'],
  [`${MOD} Shift S`, 'Toggle the sidebar'],
  [`${MOD} ,`, 'Settings'],
  ['Enter', 'Send the message'],
  ['Shift Enter', 'New line in the message'],
  ['Esc', 'Close menus, dialogs and the preview panel'],
];
const PAL_ICON = {
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  action: '<path d="M13 3L4 14h7l-1 7 9-11h-7z"/>',
  artifact: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  key: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
};
const pal = { items: [], index: 0, token: 0 };

function paletteActions() {
  const s = getSettings();
  return [
    { label: 'New chat', hint: `${MOD} Shift O`, run: () => newChat() },
    { label: 'New project', run: () => { go('#/projects'); setTimeout(() => $('new-project')?.click(), 50); } },
    { label: 'New note', run: async () => { const n = await createNote(); go(`#/n/${n.id}`); } },
    { label: 'Go to Projects', run: () => go('#/projects') },
    { label: 'Go to Notes', run: () => go('#/notes') },
    { label: 'New artifact', run: async () => { const a = await createArtifact({ kind: 'html' }); go(`#/a/${a.id}`); } },
    { label: 'Go to Artifacts', run: () => go('#/artifacts') },
    { label: 'Make a banner or thumbnail', run: () => go('#/banners') },
    { label: 'Settings', hint: `${MOD} ,`, run: () => openSettings() },
    { label: `Theme: switch to ${document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches) ? 'light' : 'dark'}`, run: () => {
      const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
      saveSettings({ theme: dark ? 'light' : 'dark' }); applyTheme();
    } },
    { label: `Thinking: turn ${s.think ? 'off' : 'on'}`, run: () => $('think-btn').click() },
    { label: 'Choose a model', run: () => setTimeout(openModelMenu, 0) },
    ...TOOL_IDS.map((id) => ({ label: `Web tool ${TOOLS[id].label}: turn ${toolSettings()[id] ? 'off' : 'on'}`, run: () => { const on = !toolSettings()[id]; setTool(id, on); toast(`${TOOLS[id].label} ${on ? 'on' : 'off'}`); } })),
    { label: 'Keyboard shortcuts', hint: '?', run: () => { $('pal-input').value = '?'; renderPalette(); }, keep: true },
  ];
}

async function renderPalette() {
  const token = ++pal.token; // a newer keystroke wins over a slower, older search
  const q = $('pal-input').value.trim().toLowerCase();
  const list = $('pal-list');
  if (q === '?') {
    pal.items = [];
    list.innerHTML = `<div class="pal-group">Keyboard shortcuts</div>${SHORTCUTS.map(([k, what]) => `<div class="pal-key"><span>${what}</span><span>${k.split(' ').map((x) => `<kbd>${x}</kbd>`).join('')}</span></div>`).join('')}`;
    return;
  }
  const [chats, projects, notes, artifacts] = await Promise.all([listChats(), listProjects(), listItems('notes'), listItems('artifacts')]);
  if (token !== pal.token) return;
  const has = (t) => String(t || '').toLowerCase().includes(q);
  const groups = [
    ['Actions', paletteActions().filter((a) => !q || has(a.label)).slice(0, q ? 6 : 4).map((a) => ({ ...a, icon: 'action' }))],
    ['Chats', (q ? chats.filter((c) => matchChat(c, q)) : chats).slice(0, q ? 8 : 5).map((c) => ({ label: c.title || 'New chat', sub: c._hit || '', icon: 'chat', run: () => go(`#/c/${c.id}`) }))],
    ['Projects', projects.filter((p) => !q || has(p.name) || has(p.description)).slice(0, q ? 5 : 3).map((p) => ({ label: p.name, sub: p.description || '', icon: 'project', run: () => go(`#/p/${p.id}`) }))],
    ['Notes', notes.filter((n) => !q || has(n.title) || has(n.body)).slice(0, q ? 5 : 3).map((n) => ({ label: n.title || 'Untitled note', sub: String(n.body || '').replace(/\s+/g, ' ').slice(0, 80), icon: 'note', run: () => go(`#/n/${n.id}`) }))],
    ['Artifacts', artifacts.filter((a) => !q || has(a.title) || has(a.content)).slice(0, q ? 5 : 3).map((a) => ({ label: a.title || 'Untitled artifact', sub: a.kind === 'code' ? `${a.lang || 'Code'}` : a.kind, icon: 'artifact', run: () => go(`#/a/${a.id}`) }))],
  ].filter(([, items]) => items.length);
  chats.forEach((c) => delete c._hit);
  pal.items = groups.flatMap(([, items]) => items);
  pal.index = Math.min(pal.index, Math.max(0, pal.items.length - 1));
  list.textContent = '';
  if (!pal.items.length) {
    list.innerHTML = '<p class="pal-empty">Nothing found. Try another word, or <kbd>?</kbd> for shortcuts.</p>';
    return;
  }
  let i = 0;
  for (const [name, items] of groups) {
    const g = document.createElement('div');
    g.className = 'pal-group';
    g.textContent = name;
    list.appendChild(g);
    for (const item of items) {
      const idx = i++;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pal-item';
      row.setAttribute('role', 'option');
      row.id = `pal-${idx}`;
      row.innerHTML = `<span class="pal-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${PAL_ICON[item.icon]}</svg></span><span class="pal-text"><span class="pal-label"></span>${item.sub ? '<span class="pal-sub"></span>' : ''}</span>${item.hint ? '<kbd class="pal-hint"></kbd>' : ''}`;
      row.querySelector('.pal-label').textContent = item.label;
      if (item.sub) row.querySelector('.pal-sub').textContent = item.sub;
      if (item.hint) row.querySelector('.pal-hint').textContent = item.hint;
      row.addEventListener('mousemove', () => { if (pal.index !== idx) { pal.index = idx; markPalette(); } });
      row.addEventListener('click', () => runPalette(idx));
      list.appendChild(row);
    }
  }
  markPalette();
}

function markPalette() {
  $('pal-list').querySelectorAll('.pal-item').forEach((r, i) => r.setAttribute('aria-selected', String(i === pal.index)));
  const cur = $(`pal-${pal.index}`);
  cur?.scrollIntoView({ block: 'nearest' });
  $('pal-input').setAttribute('aria-activedescendant', cur ? cur.id : '');
}

function runPalette(idx) {
  const item = pal.items[idx];
  if (!item) return;
  if (!item.keep) $('palette').close();
  item.run();
}

function openPalette() {
  const dlg = $('palette');
  if (dlg.open) { dlg.close(); return; }
  closeModelMenu();
  closeTitleMenu();
  $('pal-input').value = '';
  pal.index = 0;
  dlg.showModal();
  $('pal-input').focus();
  renderPalette();
}

// ---------------------------------------------------------------- settings

// ---------------------------------------------------------------- context window slider

/** 4096 → "4K" */
export function fmtCtx(n) {
  return `${Math.round(n / 1024)}K`;
}

function renderCtxSlider() {
  const m = model();
  const opts = ctxOptions(m);
  const slider = $('set-ctx');
  slider.max = String(opts.length - 1);
  slider.value = String(Math.max(0, opts.indexOf(m.ctx)));
  $('ctx-ticks').innerHTML = opts.map((n) => `<span${n === m.ctx ? ' class="on"' : ''}>${fmtCtx(n)}</span>`).join('');
  $('ctx-val').textContent = `${fmtCtx(m.ctx)} tokens${m.ctx === DEFAULT_CTX ? ' · default' : ''}`;
  const extra = kvGB(m, m.ctx);
  const pages = Math.round((budgetsFor(m.ctx).prompt / 1800)); // ~1,800 characters per page
  const capped = Number(getSettings().ctx) > m.ctx ? ` ${m.label.replace(/^.*· /, '')} goes up to ${fmtCtx(opts.at(-1))} here.` : '';
  $('ctx-note').textContent = `${m.label.replace(/^.*· /, '')}: about ${pages} pages of chat in memory, using ~${extra >= 1 ? `${extra.toFixed(1)} GB` : `${Math.round(extra * 1024)} MB`} of ${m.engine === 'gpu' ? 'GPU memory' : 'RAM'}. Bigger remembers more but answers slower and needs more memory; the model reloads (no new download).${capped}`;
}

async function openSettings(focus = '') {
  const s = getSettings();
  $('set-theme').value = s.theme;
  $('set-name').value = s.userName;
  $('set-system').value = s.systemPrompt;
  $('set-temp').value = s.temperature;
  $('temp-val').textContent = Number(s.temperature).toFixed(1);
  renderCtxSlider();
  el.settings.showModal();
  if (focus === 'ctx') { $('set-ctx').focus(); $('set-ctx').closest('.field').scrollIntoView({ block: 'center' }); }
  const { usage, quota } = await storageUsage();
  $('storage-line').textContent = quota
    ? `This site uses ${(usage / 1e9).toFixed(2)} GB of ${(quota / 1e9).toFixed(0)} GB available in this browser (chats + downloaded models).`
    : 'Storage size is not available in this browser.';
}

// ---------------------------------------------------------------- wiring

function wire() {
  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) stop(); else send(el.input.value);
  });
  el.input.addEventListener('input', () => { autosize(); updateSend(); scheduleMemory(); renderSlash(); });
  el.input.addEventListener('blur', () => setTimeout(closeSlash, 120));
  $('slash-list').addEventListener('mousedown', (e) => {
    const o = e.target.closest('.slash-opt');
    if (o) { e.preventDefault(); pickSlash(Number(o.dataset.i)); }
  });
  // A long paste becomes an attachment card instead of flooding the message box.
  el.input.addEventListener('paste', (e) => {
    if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles([...e.clipboardData.files]); return; }
    const text = e.clipboardData?.getData('text/plain') || '';
    if (text.length < PASTE_AS_FILE_CHARS) return;
    e.preventDefault();
    state.pending.push({ name: `Pasted text ${state.pending.filter((f) => f.pasted).length + 1}`, size: new Blob([text]).size, text, pasted: true });
    renderPending();
  });
  el.input.addEventListener('keydown', (e) => {
    if (slash.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slash.active = (slash.active + (e.key === 'ArrowDown' ? 1 : -1) + slash.items.length) % slash.items.length;
        renderSlash();
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickSlash(slash.active); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.busy) send(el.input.value);
    }
  });
  document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    el.input.value = c.dataset.prompt;
    autosize();
    updateSend();
    el.input.focus();
  }));

  $('new-chat').addEventListener('click', () => { newChat(); if (narrow()) setSidebar(false); });
  $('new-chat-top').addEventListener('click', newChat);
  $('side-toggle').addEventListener('click', () => setSidebar(narrow() ? false : el.app.classList.contains('side-closed')));
  $('side-search').addEventListener('click', () => { if (el.app.classList.contains('side-closed')) { setSidebar(true); $('chat-search').focus(); } });
  $('chat-search').addEventListener('input', (e) => { state.query = e.target.value; refreshList(); });
  $('chat-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; state.query = ''; refreshList(); } });
  $('attach').addEventListener('click', () => $('file-input').click());
  $('tools-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('tools-menu').hidden) openTools(); else closeTools();
  });
  $('tools-menu').addEventListener('click', (e) => e.stopPropagation());
  $('tools-menu').addEventListener('change', (e) => {
    const id = e.target.dataset.tool;
    if (!id) return;
    setTool(id, e.target.checked);
    $('tools-menu').querySelector(`[data-tool="${id}"]`)?.focus();
    toast(`${TOOLS[id].label} ${e.target.checked ? `on: your question will be sent to ${TOOLS[id].host}` : 'off'}`);
  });
  $('tools-menu').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeTools({ focus: true }); } });
  $('think-btn').addEventListener('click', () => {
    const on = !getSettings().think;
    saveSettings({ think: on });
    renderThinkToggle();
    toast(on ? 'Thinking on: slower, more careful answers' : 'Thinking off: faster answers');
  });
  $('file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  // Drag files anywhere over the chat: a full overlay invites the drop.
  const chatView = $('view-chat');
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  chatView.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; chatView.classList.add('dragging'); });
  chatView.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  chatView.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) chatView.classList.remove('dragging'); });
  chatView.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    chatView.classList.remove('dragging');
    addFiles([...e.dataTransfer.files]);
  });
  const toBottom = $('to-bottom');
  el.thread.addEventListener('scroll', () => { toBottom.hidden = !state.chat?.messages.length || nearBottom(); }, { passive: true });
  toBottom.addEventListener('click', () => { el.thread.scrollTo({ top: el.thread.scrollHeight, behavior: 'smooth' }); });
  $('side-open').addEventListener('click', () => setSidebar(true));
  el.scrim.addEventListener('click', () => setSidebar(false));

  el.modelBtn.addEventListener('click', (e) => { e.stopPropagation(); if (el.modelMenu.hidden) openModelMenu(); else closeModelMenu(); });
  el.modelMenu.addEventListener('click', (e) => e.stopPropagation());
  el.modelMenu.querySelectorAll('[data-engine]').forEach((b) => b.addEventListener('click', () => {
    if (MOCK) return;
    saveSettings({ engine: b.dataset.engine });
    renderModelMenu();
    updateModelState();
  }));
  document.addEventListener('click', () => { closeModelMenu(); closeItemMenus(); closeTitleMenu(); closeTools(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModelMenu(); closeItemMenus(); closeTitleMenu(); closeTools(); }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); if ($('palette').open) $('palette').close(); newChat(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); setSidebar(el.app.classList.contains('side-closed')); }
    if (mod && e.key === ',') { e.preventDefault(); openSettings(); }
    if (e.key === 'Escape' && !$('side-panel').hidden && !document.querySelector('dialog[open]')) closePanel();
  });

  // Copy buttons inside rendered code blocks.
  el.messages.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy-code]');
    if (b) copyText(b.closest('.code-block').querySelector('code').textContent);
    const sv = e.target.closest('[data-save-artifact]');
    if (sv) saveCodeAsArtifact(sv.closest('.code-block'));
    const pv = e.target.closest('[data-preview-code]');
    if (pv) {
      const block = pv.closest('.code-block');
      const code = block.querySelector('code').textContent;
      const lang = block.querySelector('.code-head span')?.textContent || 'html';
      openPanel({ kind: 'html', title: lang === 'svg' ? 'image.svg' : /<title>([^<]{1,60})<\/title>/i.exec(code)?.[1] || 'page.html', code });
    }
  });

  $('sp-close').addEventListener('click', closePanel);
  $('sp-copy').addEventListener('click', () => copyText(panel.code));
  $('sp-download').addEventListener('click', downloadPanel);
  $('sp-tabs').querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => renderPanelBody(b.dataset.tab)));
  $('pal-input').addEventListener('input', () => { pal.index = 0; renderPalette(); });
  $('pal-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); pal.index = Math.min(pal.items.length - 1, pal.index + 1); markPalette(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); pal.index = Math.max(0, pal.index - 1); markPalette(); }
    if (e.key === 'Enter') { e.preventDefault(); runPalette(pal.index); }
  });
  $('palette').addEventListener('click', (e) => { if (e.target === $('palette')) $('palette').close(); }); // backdrop
  document.querySelector('.kbd-hint').addEventListener('click', (e) => { e.preventDefault(); openPalette(); });
  $('open-settings').addEventListener('click', () => openSettings());
  $('set-name').addEventListener('input', (e) => { saveSettings({ userName: e.target.value }); applyProfile(); });
  $('set-avatar-btn').addEventListener('click', () => $('set-avatar-file').click());
  $('set-avatar-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { saveSettings({ avatar: await resizePhoto(f) }); applyProfile(); toast('Photo updated'); } catch (err) { toast(err.message); }
  });
  $('set-avatar-reset').addEventListener('click', () => { saveSettings({ avatar: '' }); applyProfile(); });
  $('set-ctx').addEventListener('input', (e) => {
    const opts = ctxOptions(model());
    saveSettings({ ctx: opts[Number(e.target.value)] || DEFAULT_CTX });
    renderCtxSlider();
    scheduleMemory();
  });
  $('mem').addEventListener('click', () => openSettings('ctx'));
  $('mem').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSettings('ctx'); } });
  $('set-theme').addEventListener('change', (e) => { saveSettings({ theme: e.target.value }); applyTheme(); });
  $('set-system').addEventListener('input', (e) => saveSettings({ systemPrompt: e.target.value }));
  $('set-temp').addEventListener('input', (e) => { saveSettings({ temperature: Number(e.target.value) }); $('temp-val').textContent = Number(e.target.value).toFixed(1); });
  $('clear-all').addEventListener('click', async () => {
    if (!confirm('Delete all chats? Projects, notes and downloaded models are kept.')) return;
    stop();
    await clearAll();
    el.settings.close();
    applyTheme();
    newChat();
    refreshList();
    toast('All chats deleted');
  });

  $('wipe-all').addEventListener('click', async (e) => {
    if (!confirm('Delete ALL data?\n\nThis removes every chat, project, note, setting and downloaded model from this browser. Models will need to be downloaded again. This cannot be undone.')) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    stop();
    try { await state.loading; } catch { /* a cancelled load is fine */ }
    await unloadAll();
    const errors = await wipeEverything(ownModels());
    if (errors.length) console.warn('Some data could not be deleted:', errors);
    location.replace(location.pathname + location.search); // fresh start
  });

  window.addEventListener('resize', () => { if (!narrow()) el.scrim.hidden = true; });
  window.addEventListener('hashchange', route);
  $('title-btn').addEventListener('click', (e) => { e.stopPropagation(); if ($('title-menu').hidden) openTitleMenu(); else closeTitleMenu(); });
  $('title-menu').addEventListener('click', (e) => e.stopPropagation());
  $('project-pill').addEventListener('click', () => { state.newProjectId = null; renderProjectPill(); });
  document.querySelectorAll('.nav-link').forEach((a) => a.addEventListener('click', () => { if (narrow()) setSidebar(false); }));
}

async function init() {
  applyTheme();
  wire();
  renderTools();
  applyProfile();
  setSidebar(narrow() ? false : getSettings().sidebarOpen, false);
  if (hasWebGPU() && !MOCK) f16 = await detectGpu(); // before anything picks a GPU model build
  initPages({
    toast, go, refreshSidebar: refreshList, setTitle: (t, o = {}) => setHeader(t, o),
    knowledgeBudget: () => budgetsFor(model().ctx).knowledge,
    openChat: (id) => go(`#/c/${id}`),
    startChatInProject: (id) => { newChat(id); },
  });
  await refreshList();
  await route();
  await updateModelState();
  // A model that is already downloaded loads in the background, so the first reply is quick.
  const m = model();
  if (!MOCK && !modelReady(m) && (m.engine === 'cpu' || hasWebGPU()) && await modelCached(m)) startLoad(m).catch(() => updateModelState());
  requestAnimationFrame(() => requestAnimationFrame(() => el.app.classList.remove('preload')));
  window.__cloudlessReady = true;
}

init();
