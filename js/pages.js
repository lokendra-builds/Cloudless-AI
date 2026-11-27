// Projects, Notes and Artifacts pages. Everything is stored in this browser (IndexedDB), nothing
// is uploaded.
//
// A project groups chats, notes and artifacts and gives every chat inside it the same
// instructions and knowledge files. Each of them can also live on its own, outside any project.

import { putItem, getItem, deleteItem, listItems } from './storage.js?v=9c2e9f4841';
import { renderMarkdown } from './markdown.js?v=b5a8af910b';
import { newId, KNOWLEDGE_BUDGET, noteTitleFrom } from './chats.js?v=7cc0ac7fc7';
import { pdfText } from './pdf-text.js?v=91afa70841';
import { KINDS, KIND_IDS, fileName, titleFrom, shareLink, decodeShare, sandboxedFrame, LONG_LINK, MAX_LINK } from './artifacts.js?v=d8a135c811';

const knowledgeBudget = () => ctx?.knowledgeBudget?.() || KNOWLEDGE_BUDGET;

let ctx = null; // { toast, go, openChat, startChatInProject, refreshSidebar, setTitle }

export function initPages(context) {
  ctx = context;
}

const MAX_FILE_BYTES = 300_000;
const ICON = {
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/></svg>',
  artifact: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/></svg>',
  html: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/></svg>',
  svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 16l-5-5L5 21"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
};
ICON.markdown = ICON.note;
ICON.code = ICON.artifact;

// ---------------------------------------------------------------- small helpers

export function timeAgo(t, now = Date.now()) {
  const s = Math.max(0, Math.round((now - (t || 0)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(t).toLocaleDateString();
}

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function debounce(fn, ms = 400) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function snippet(text, n = 140) {
  const t = String(text || '').replace(/[#>*_`~-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---------------------------------------------------------------- data

export const listProjects = () => listItems('projects');
export const getProject = (id) => (id ? getItem('projects', id) : Promise.resolve(null));
export const listNotes = () => listItems('notes');
export const listArtifacts = () => listItems('artifacts');

export async function createProject({ name, description = '' }) {
  const now = Date.now();
  const p = { id: newId(), name: name.trim() || 'Untitled project', description: description.trim(), instructions: '', files: [], createdAt: now, updatedAt: now };
  await putItem('projects', p);
  return p;
}

export async function saveProject(p) {
  p.updatedAt = Date.now();
  await putItem('projects', p);
}

/** Delete a project. Its chats, notes and artifacts are kept and become unfiled. */
export async function deleteProject(id) {
  for (const store of ['chats', 'notes', 'artifacts']) {
    for (const x of await listItems(store)) if (x.projectId === id) { x.projectId = null; await putItem(store, x); }
  }
  await deleteItem('projects', id);
}

export async function createNote({ title = '', body = '', projectId = null } = {}) {
  const now = Date.now();
  const n = { id: newId(), title: title || (body ? noteTitleFrom(body) : 'Untitled note'), body, projectId, createdAt: now, updatedAt: now };
  await putItem('notes', n);
  return n;
}

const STARTERS = {
  html: '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>My page</title>\n</head>\n<body>\n  <h1>Hello</h1>\n</body>\n</html>\n',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">\n  <circle cx="100" cy="100" r="80" fill="#d97757"/>\n</svg>\n',
  markdown: '# Title\n\nWrite here.\n',
  code: '',
};

export async function createArtifact({ kind = 'html', lang = '', title = '', content, projectId = null, shared = false } = {}) {
  const now = Date.now();
  const body = content ?? STARTERS[kind] ?? '';
  const a = { id: newId(), kind, lang: kind === 'code' ? lang : '', title: title || (content ? titleFrom(kind, body, lang) : `Untitled ${KINDS[kind].label.toLowerCase()}`), content: body, projectId, shared, createdAt: now, updatedAt: now };
  await putItem('artifacts', a);
  return a;
}

// ---------------------------------------------------------------- list pieces

function chatRow(c) {
  return h('button', { type: 'button', class: 'row-item', onclick: () => ctx.openChat(c.id) },
    h('span', { class: 'ri-icon', html: ICON.chat }),
    h('span', { class: 'ri-main' }, h('span', { class: 'ri-title' }, c.title || 'New chat'),
      h('span', { class: 'ri-sub' }, snippet(c.messages?.at(-1)?.content, 90) || 'Empty chat')),
    h('span', { class: 'ri-time' }, timeAgo(c.updatedAt)));
}

function noteRow(n, projects = new Map()) {
  const p = projects.get(n.projectId);
  return h('a', { class: 'row-item', href: `#/n/${n.id}` },
    h('span', { class: 'ri-icon note', html: ICON.note }),
    h('span', { class: 'ri-main' }, h('span', { class: 'ri-title' }, n.title || 'Untitled note'),
      h('span', { class: 'ri-sub' }, snippet(n.body, 110) || 'Empty note')),
    p ? h('span', { class: 'badge', html: ICON.folder }, p.name) : null,
    h('span', { class: 'ri-time' }, timeAgo(n.updatedAt)));
}

function lineLabel(text) {
  const n = String(text || '').replace(/\n$/, '').split('\n').length;
  return `${n} line${n === 1 ? '' : 's'}`;
}

function kindLabel(a) {
  return a.kind === 'code' ? (a.lang ? `Code · ${a.lang}` : 'Code') : KINDS[a.kind]?.label || 'Artifact';
}

function artifactRow(a, projects = new Map()) {
  const p = projects.get(a.projectId);
  return h('a', { class: 'row-item', href: `#/a/${a.id}` },
    h('span', { class: `ri-icon art ${a.kind}`, html: ICON[a.kind] || ICON.artifact }),
    h('span', { class: 'ri-main' }, h('span', { class: 'ri-title' }, a.title || 'Untitled artifact'),
      h('span', { class: 'ri-sub' }, `${kindLabel(a)} · ${lineLabel(a.content)}${a.shared ? ' · from a shared link' : ''}`)),
    p ? h('span', { class: 'badge', html: ICON.folder }, p.name) : null,
    h('span', { class: 'ri-time' }, timeAgo(a.updatedAt)));
}

/** "New artifact" button with a small menu of the four kinds. */
function newArtifactButton(projectId, { id = 'new-artifact', small = false } = {}) {
  const menu = h('div', { class: 'kind-menu', role: 'menu', hidden: true },
    KIND_IDS.map((k) => h('button', { type: 'button', role: 'menuitem', 'data-kind': k, html: `${ICON[k]}<span>${KINDS[k].label}</span>`,
      onclick: async () => { const a = await createArtifact({ kind: k, projectId }); ctx.go(`#/a/${a.id}`); } })));
  const btn = h('button', { type: 'button', class: small ? 'btn sm' : 'btn primary', id, 'aria-haspopup': 'menu', 'aria-expanded': 'false', html: `${ICON.plus}<span>New artifact</span>` });
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) {
      menu.querySelector('button').focus();
      document.addEventListener('click', close, { once: true });
    }
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); }
  });
  return h('div', { class: 'kind-wrap' }, btn, menu);
}

function emptyBox(icon, title, text, action) {
  return h('div', { class: 'empty-box' }, h('span', { class: 'eb-icon', html: icon }), h('strong', {}, title), h('p', {}, text), action || null);
}

// ---------------------------------------------------------------- Projects list

export async function renderProjects(root) {
  ctx.setTitle('Projects');
  const [projects, chats, notes, artifacts] = await Promise.all([listProjects(), listItems('chats'), listNotes(), listArtifacts()]);
  const form = h('form', { class: 'new-project card', hidden: true },
    h('h3', {}, 'Create a project'),
    h('label', { class: 'field' }, h('span', {}, 'What are you working on?'), h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'Name your project', autocomplete: 'off' })),
    h('label', { class: 'field' }, h('span', {}, 'What are you trying to achieve?'), h('textarea', { name: 'description', rows: 3, placeholder: 'Describe your project, goals, subject, etc. (optional)' })),
    h('div', { class: 'row-end' },
      h('button', { type: 'button', class: 'btn', onclick: () => { form.hidden = true; } }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn accent' }, 'Create project')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = await createProject({ name: form.elements.name.value, description: form.elements.description.value });
    ctx.toast('Project created');
    ctx.go(`#/p/${p.id}`);
  });
  const openForm = () => { form.hidden = false; form.elements.name.focus(); };

  const grid = h('div', { class: 'card-grid' });
  for (const p of projects) {
    const nc = chats.filter((c) => c.projectId === p.id).length;
    const nn = notes.filter((n) => n.projectId === p.id).length;
    const na = artifacts.filter((a) => a.projectId === p.id).length;
    grid.append(h('a', { class: 'project-card', href: `#/p/${p.id}` },
      h('span', { class: 'pc-icon', html: ICON.folder }),
      h('strong', {}, p.name),
      h('p', {}, p.description || 'No description'),
      h('span', { class: 'pc-meta' }, `${nc} chat${nc === 1 ? '' : 's'} · ${nn} note${nn === 1 ? '' : 's'} · ${na} artifact${na === 1 ? '' : 's'} · ${(p.files || []).length} file${(p.files || []).length === 1 ? '' : 's'} · updated ${timeAgo(p.updatedAt)}`)));
  }
  root.replaceChildren(h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'Projects'),
      h('button', { type: 'button', class: 'btn primary', id: 'new-project', onclick: openForm, html: `${ICON.plus}<span>New project</span>` })),
    h('p', { class: 'page-sub' }, 'Group chats, notes and artifacts, and give every chat in a project the same instructions and files. All stored in this browser.'),
    form,
    projects.length ? grid : emptyBox(ICON.folder, 'No projects yet', 'Create one to keep related chats, notes and files together.', h('button', { type: 'button', class: 'btn accent', onclick: openForm }, 'Create your first project'))));
}

// ---------------------------------------------------------------- One project

export async function renderProject(root, id) {
  const p = await getProject(id);
  if (!p) { root.replaceChildren(emptyBox(ICON.folder, 'Project not found', 'It may have been deleted.', h('a', { class: 'btn', href: '#/projects' }, 'All projects'))); ctx.setTitle('Projects'); return; }
  ctx.setTitle(p.name, { crumb: { label: 'Projects', href: '#/projects' } });
  const [chats, notes, artifacts] = await Promise.all([listItems('chats'), listNotes(), listArtifacts()]);
  const myChats = chats.filter((c) => c.projectId === id);
  const myNotes = notes.filter((n) => n.projectId === id);
  const myArtifacts = artifacts.filter((a) => a.projectId === id);
  const save = debounce(async () => { await saveProject(p); ctx.refreshSidebar(); saved.textContent = 'Saved'; }, 350);
  const saved = h('span', { class: 'saved' });
  const touch = () => { saved.textContent = 'Saving…'; save(); };

  const name = h('input', { class: 'title-input', value: p.name, 'aria-label': 'Project name', maxlength: 80 });
  name.addEventListener('input', () => { p.name = name.value.trim() || 'Untitled project'; ctx.setTitle(p.name, { crumb: { label: 'Projects', href: '#/projects' } }); touch(); });
  const desc = h('textarea', { class: 'desc-input', rows: 1, placeholder: 'Add a description', 'aria-label': 'Project description' });
  desc.value = p.description || '';
  desc.addEventListener('input', () => { p.description = desc.value; touch(); });

  // Instructions
  const instr = h('textarea', { id: 'project-instructions', rows: 6, placeholder: 'e.g. "You are my study buddy for Class 12 physics. Explain step by step, in Hinglish."' });
  instr.value = p.instructions || '';
  instr.addEventListener('input', () => { p.instructions = instr.value; touch(); });

  // Knowledge files
  const fileList = h('div', { class: 'k-files' });
  const meter = h('div', { class: 'k-meter' });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, id: 'project-file-input', accept: '.txt,.md,.csv,.json,.js,.ts,.py,.html,.css,.java,.c,.cpp,.go,.rs,.rb,.php,.sh,.yml,.yaml,.toml,.xml,.sql,.log,.ini,.pdf,application/pdf,text/*' });
  const renderFiles = () => {
    fileList.replaceChildren(...(p.files || []).map((f, i) => h('div', { class: 'k-file' },
      h('span', { class: 'ri-icon', html: ICON.file }),
      h('span', { class: 'ri-main' }, h('span', { class: 'ri-title' }, f.name), h('span', { class: 'ri-sub' }, `${f.text.length.toLocaleString()} characters`)),
      h('button', { type: 'button', class: 'act', 'aria-label': `Remove ${f.name}`, html: ICON.x, onclick: () => { p.files.splice(i, 1); renderFiles(); touch(); } }))));
    const total = (p.files || []).reduce((a, f) => a + f.text.length, 0);
    const budget = knowledgeBudget();
    const pct = Math.min(100, Math.round((total / budget) * 100));
    meter.replaceChildren(
      h('div', { class: `progress${total > budget ? ' over' : ''}` }, h('i', { style: `width:${pct}%` })),
      h('span', { class: 'ri-sub' }, total > budget
        ? `${total.toLocaleString()} characters: only the first ${budget.toLocaleString()} fit in the model's memory. The rest is skipped. A bigger context window (Settings) fits more.`
        : `${total.toLocaleString()} / ${budget.toLocaleString()} characters the model can read`));
    meter.hidden = !(p.files || []).length;
  };
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        // Only the text is kept: projects hold text the model reads in every chat.
        if (f.size > 15 * 1024 * 1024) { ctx.toast(`${f.name} is too big (max 15 MB)`); continue; }
        ctx.toast(`Reading ${f.name}…`);
        try {
          const r = await pdfText(await f.arrayBuffer());
          if (!r.text) { ctx.toast(`${f.name} has no text to read; it looks like scanned pictures`); continue; }
          (p.files ||= []).push({ name: f.name, size: r.text.length, text: r.text, pages: r.pages });
        } catch (e) { ctx.toast(`${f.name}: ${e.message}`); }
        continue;
      }
      if (f.size > MAX_FILE_BYTES) { ctx.toast(`${f.name} is too big (max 300 KB)`); continue; }
      const text = await f.text();
      if (text.includes('\u0000')) { ctx.toast(`${f.name} is not a text file`); continue; }
      (p.files ||= []).push({ name: f.name, size: f.size, text });
    }
    fileInput.value = '';
    renderFiles();
    touch();
  });
  renderFiles();

  const startChat = h('button', { type: 'button', class: 'start-chat', id: 'project-new-chat', onclick: () => ctx.startChatInProject(p.id) },
    h('span', { class: 'plus-dot', html: ICON.plus }), h('span', {}, `Start a new chat in ${p.name}`));

  const newNote = async () => { const n = await createNote({ projectId: p.id }); ctx.go(`#/n/${n.id}`); };

  root.replaceChildren(h('div', { class: 'page-inner project-page' },
    h('a', { class: 'back', href: '#/projects', html: `${ICON.back}<span>All projects</span>` }),
    h('div', { class: 'project-grid' },
      h('div', { class: 'project-main' },
        h('div', { class: 'title-row' }, name, saved), desc, startChat,
        h('section', { class: 'section' },
          h('div', { class: 'section-head' }, h('h3', {}, `Chats · ${myChats.length}`)),
          myChats.length ? h('div', { class: 'rows', id: 'project-chats' }, myChats.map(chatRow))
            : h('p', { class: 'muted' }, 'No chats yet. Start one above, or move an existing chat here from its title menu.')),
        h('section', { class: 'section' },
          h('div', { class: 'section-head' }, h('h3', {}, `Notes · ${myNotes.length}`),
            h('button', { type: 'button', class: 'btn sm', id: 'project-new-note', onclick: newNote, html: `${ICON.plus}<span>New note</span>` })),
          myNotes.length ? h('div', { class: 'rows', id: 'project-notes' }, myNotes.map((n) => noteRow(n)))
            : h('p', { class: 'muted' }, 'No notes yet. Write one, or save any AI reply as a note.')),
        h('section', { class: 'section' },
          h('div', { class: 'section-head' }, h('h3', {}, `Artifacts · ${myArtifacts.length}`), newArtifactButton(p.id, { id: 'project-new-artifact', small: true })),
          myArtifacts.length ? h('div', { class: 'rows', id: 'project-artifacts' }, myArtifacts.map((a) => artifactRow(a)))
            : h('p', { class: 'muted' }, 'No artifacts yet. Make one, or press "Save" on any code block in a reply.'))),
      h('aside', { class: 'project-side' },
        h('div', { class: 'card' },
          h('h3', {}, 'Instructions'),
          h('p', { class: 'muted' }, 'Every chat in this project follows these.'), instr),
        h('div', { class: 'card' },
          h('div', { class: 'section-head' }, h('h3', {}, 'Knowledge'),
            h('button', { type: 'button', class: 'btn sm', id: 'project-add-file', onclick: () => fileInput.click(), html: `${ICON.plus}<span>Add files</span>` })),
          h('p', { class: 'muted' }, 'Text and code files the model reads in every chat here. They stay in your browser.'),
          fileInput, fileList, meter),
        h('button', { type: 'button', class: 'danger', id: 'project-delete', onclick: async () => {
          if (!confirm(`Delete the project "${p.name}"? Its chats, notes and artifacts are kept and moved out of the project.`)) return;
          await deleteProject(p.id);
          ctx.toast('Project deleted');
          ctx.refreshSidebar();
          ctx.go('#/projects');
        } }, 'Delete project')))));
  autoGrow(desc);
}

function autoGrow(ta) {
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
}

// ---------------------------------------------------------------- Notes list

export async function renderNotes(root, filter = 'all') {
  ctx.setTitle('Notes');
  const [notes, projects] = await Promise.all([listNotes(), listProjects()]);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const shown = notes.filter((n) => filter === 'all' || (filter === 'unfiled' ? !byId.has(n.projectId) : n.projectId === filter));
  const chip = (value, label) => h('button', { type: 'button', class: `chip${filter === value ? ' on' : ''}`, onclick: () => renderNotes(root, value) }, label);
  const newNote = async () => {
    const n = await createNote({ projectId: byId.has(filter) ? filter : null });
    ctx.go(`#/n/${n.id}`);
  };
  root.replaceChildren(h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'Notes'),
      h('button', { type: 'button', class: 'btn primary', id: 'new-note', onclick: newNote, html: `${ICON.plus}<span>New note</span>` })),
    h('p', { class: 'page-sub' }, 'Your own notes, on their own or inside a project. Save any AI reply here with one click.'),
    h('div', { class: 'filter-row' }, chip('all', 'All'), chip('unfiled', 'Not in a project'), projects.map((p) => chip(p.id, p.name))),
    shown.length ? h('div', { class: 'rows', id: 'notes-list' }, shown.map((n) => noteRow(n, byId)))
      : emptyBox(ICON.note, 'No notes here', 'Write your first note, or use "Save as note" under any AI reply.', h('button', { type: 'button', class: 'btn accent', onclick: newNote }, 'Write a note'))));
}

// ---------------------------------------------------------------- One note

export async function renderNote(root, id) {
  const n = await getItem('notes', id);
  if (!n) { root.replaceChildren(emptyBox(ICON.note, 'Note not found', 'It may have been deleted.', h('a', { class: 'btn', href: '#/notes' }, 'All notes'))); ctx.setTitle('Notes'); return; }
  const projects = await listProjects();
  const project = projects.find((p) => p.id === n.projectId);
  const crumb = project ? { label: project.name, href: `#/p/${project.id}` } : { label: 'Notes', href: '#/notes' };
  ctx.setTitle(n.title, { crumb });
  const saved = h('span', { class: 'saved' }, `Edited ${timeAgo(n.updatedAt)}`);
  const save = debounce(async () => { n.updatedAt = Date.now(); await putItem('notes', n); saved.textContent = 'Saved'; }, 350);
  const touch = () => { saved.textContent = 'Saving…'; save(); };

  const title = h('input', { class: 'title-input', id: 'note-title', value: n.title, 'aria-label': 'Note title', maxlength: 120, placeholder: 'Untitled note' });
  title.addEventListener('input', () => { n.title = title.value.trim() || 'Untitled note'; ctx.setTitle(n.title, { crumb }); touch(); });

  const select = h('select', { id: 'note-project', 'aria-label': 'Project' },
    h('option', { value: '' }, 'No project'), projects.map((p) => h('option', { value: p.id, selected: p.id === n.projectId }, p.name)));
  select.addEventListener('change', () => { n.projectId = select.value || null; touch(); ctx.toast(select.value ? 'Moved to project' : 'Removed from project'); });

  const body = h('textarea', { class: 'note-body', id: 'note-body', placeholder: 'Start writing… Markdown works: # heading, **bold**, - lists, ```code```' });
  body.value = n.body || '';
  body.addEventListener('input', () => { n.body = body.value; touch(); });
  const preview = h('div', { class: 'md note-preview', hidden: true });
  const tabEdit = h('button', { type: 'button', class: 'seg on', onclick: () => mode(false) }, 'Edit');
  const tabPrev = h('button', { type: 'button', class: 'seg', id: 'note-preview-btn', onclick: () => mode(true) }, 'Preview');
  function mode(prev) {
    tabEdit.classList.toggle('on', !prev);
    tabPrev.classList.toggle('on', prev);
    body.hidden = prev;
    preview.hidden = !prev;
    if (prev) preview.innerHTML = renderMarkdown(n.body) || '<p class="muted">Nothing written yet.</p>';
  }

  root.replaceChildren(h('div', { class: 'page-inner note-page' },
    h('a', { class: 'back', href: project ? `#/p/${project.id}` : '#/notes', html: `${ICON.back}<span>${project ? project.name : 'All notes'}</span>` }),
    h('div', { class: 'title-row' }, title),
    h('div', { class: 'note-bar' },
      h('label', { class: 'note-proj', html: ICON.folder }, select),
      h('div', { class: 'segmented' }, tabEdit, tabPrev),
      saved,
      h('button', { type: 'button', class: 'act', title: 'Copy note', 'aria-label': 'Copy note', onclick: () => navigator.clipboard?.writeText(n.body || '').then(() => ctx.toast('Copied')),
        html: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>' }),
      h('button', { type: 'button', class: 'danger sm', id: 'note-delete', onclick: async () => {
        if (!confirm('Delete this note?')) return;
        await deleteItem('notes', n.id);
        ctx.toast('Note deleted');
        ctx.go(project ? `#/p/${project.id}` : '#/notes');
      } }, 'Delete')),
    body, preview));
  if (!n.body) title.select();
  else mode(true); // an existing note opens as formatted text; "Edit" switches to the source
}

// ---------------------------------------------------------------- Artifacts list

export async function renderArtifacts(root, filter = 'all') {
  ctx.setTitle('Artifacts');
  const [artifacts, projects] = await Promise.all([listArtifacts(), listProjects()]);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const shown = artifacts.filter((a) => filter === 'all' || (filter === 'unfiled' ? !byId.has(a.projectId) : a.projectId === filter));
  const chip = (value, label) => h('button', { type: 'button', class: `chip${filter === value ? ' on' : ''}`, onclick: () => renderArtifacts(root, value) }, label);
  const projectId = byId.has(filter) ? filter : null;
  root.replaceChildren(h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'Artifacts'), newArtifactButton(projectId)),
    h('p', { class: 'page-sub' }, 'Pages, images, documents and code you keep. Share any of them as a link: the whole artifact travels inside the link, nothing is uploaded.'),
    h('div', { class: 'filter-row' }, chip('all', 'All'), chip('unfiled', 'Not in a project'), projects.map((p) => chip(p.id, p.name))),
    shown.length ? h('div', { class: 'rows', id: 'artifacts-list' }, shown.map((a) => artifactRow(a, byId)))
      : emptyBox(ICON.artifact, 'No artifacts here', 'Make one, or press "Save" on any code block in an AI reply.', newArtifactButton(projectId, { id: 'empty-new-artifact', small: true }))));
}

// ---------------------------------------------------------------- showing one artifact

/** The rendered artifact: a sandboxed page for HTML and SVG, formatted text for the rest. */
function artifactView(a) {
  if (a.kind === 'html' || a.kind === 'svg') {
    return h('div', { class: 'art-stage' }, sandboxedFrame(a.content, `Preview of ${a.title}`));
  }
  const box = h('div', { class: `md art-doc${a.kind === 'code' ? ' art-code' : ''}` });
  box.innerHTML = a.kind === 'markdown'
    ? renderMarkdown(a.content) || '<p class="muted">Nothing written yet.</p>'
    : renderMarkdown(`\`\`\`${(a.lang || '').replace(/[^\w+#.-]/g, '')}\n${String(a.content || '').replace(/```/g, '`​``')}\n\`\`\``);
  return box;
}

function downloadArtifact(a) {
  const link = h('a', { href: URL.createObjectURL(new Blob([a.content], { type: KINDS[a.kind]?.mime || 'text/plain' })), download: fileName(a) });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); } catch {
    // No clipboard permission (or an old browser): copy through a hidden text box.
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) { ctx.toast('Could not copy: select the text and copy it'); return; }
  }
  ctx.toast(what);
}

function projectSelect(projects, value, id) {
  return h('select', { id, 'aria-label': 'Project' },
    h('option', { value: '' }, 'No project'), projects.map((p) => h('option', { value: p.id, selected: p.id === value }, p.name)));
}

/** Make the share link and show it in `box`, with a note on size and privacy. */
async function showShare(a, box) {
  box.hidden = false;
  box.replaceChildren(h('p', { class: 'muted' }, 'Making the link…'));
  let link;
  try { link = await shareLink(a); } catch {
    box.replaceChildren(h('p', { class: 'share-warn' }, 'This browser cannot make share links. Use Download instead.'));
    return;
  }
  if (link.length > MAX_LINK) {
    box.replaceChildren(h('p', { class: 'share-warn', id: 'share-too-big' },
      `Too big for a link (${link.length.toLocaleString()} characters). Download the file and send it instead.`));
    return;
  }
  const input = h('input', { id: 'share-link', class: 'share-input', readonly: true, value: link, 'aria-label': 'Share link', onfocus: (e) => e.target.select() });
  box.replaceChildren(
    h('div', { class: 'share-row' }, input,
      h('button', { type: 'button', class: 'btn accent sm', id: 'share-copy', onclick: () => copy(link, 'Link copied') }, 'Copy link')),
    h('p', { class: 'muted share-note' },
      'Anyone with this link can open this artifact. Everything is inside the link itself: nothing is uploaded, and the part after "#" never reaches any server. ',
      'Edits you make later are not in this link; share again to send them.'),
    ...(link.length > LONG_LINK ? [h('p', { class: 'share-warn', id: 'share-long' }, `Long link (${link.length.toLocaleString()} characters): some chat apps cut links this long. If it does not open, send the downloaded file instead.`)] : []));
  copy(link, 'Link copied');
}

function viewTabs(onPick, labels = ['Preview', 'Code']) {
  const [a, b] = labels.map((label, i) => h('button', { type: 'button', class: `seg${i === 0 ? ' on' : ''}`, 'data-tab': i === 0 ? 'preview' : 'code', 'aria-pressed': String(i === 0), onclick: () => pick(i === 1) }, label));
  function pick(second) {
    a.classList.toggle('on', !second); b.classList.toggle('on', second);
    a.setAttribute('aria-pressed', String(!second)); b.setAttribute('aria-pressed', String(second));
    onPick(second);
  }
  return { node: h('div', { class: 'segmented', role: 'group', 'aria-label': 'View' }, a, b), pick };
}

// ---------------------------------------------------------------- One artifact

export async function renderArtifact(root, id) {
  const a = await getItem('artifacts', id);
  if (!a) { root.replaceChildren(emptyBox(ICON.artifact, 'Artifact not found', 'It may have been deleted.', h('a', { class: 'btn', href: '#/artifacts' }, 'All artifacts'))); ctx.setTitle('Artifacts'); return; }
  const projects = await listProjects();
  const project = projects.find((p) => p.id === a.projectId);
  const crumb = project ? { label: project.name, href: `#/p/${project.id}` } : { label: 'Artifacts', href: '#/artifacts' };
  ctx.setTitle(a.title, { crumb });
  const saved = h('span', { class: 'saved' }, `Edited ${timeAgo(a.updatedAt)}`);
  const save = debounce(async () => { a.updatedAt = Date.now(); await putItem('artifacts', a); saved.textContent = 'Saved'; }, 350);
  const touch = () => { saved.textContent = 'Saving…'; shareBox.hidden = true; save(); };

  const title = h('input', { class: 'title-input', id: 'artifact-title', value: a.title, 'aria-label': 'Artifact title', maxlength: 120, placeholder: 'Untitled artifact' });
  title.addEventListener('input', () => { a.title = title.value.trim() || 'Untitled artifact'; ctx.setTitle(a.title, { crumb }); touch(); });

  const select = projectSelect(projects, a.projectId, 'artifact-project');
  select.addEventListener('change', () => { a.projectId = select.value || null; touch(); ctx.toast(select.value ? 'Moved to project' : 'Removed from project'); });

  const kind = h('select', { id: 'artifact-kind', 'aria-label': 'Type' }, KIND_IDS.map((k) => h('option', { value: k, selected: k === a.kind }, KINDS[k].label)));
  const lang = h('input', { id: 'artifact-lang', class: 'lang-input', value: a.lang || '', placeholder: 'Language, e.g. python', 'aria-label': 'Code language', maxlength: 30, hidden: a.kind !== 'code' });
  kind.addEventListener('change', () => { a.kind = kind.value; lang.hidden = a.kind !== 'code'; if (a.kind !== 'code') a.lang = ''; touch(); show(editing); });
  lang.addEventListener('input', () => { a.lang = lang.value.trim(); touch(); });

  const editor = h('textarea', { class: 'note-body art-editor', id: 'artifact-code', spellcheck: 'false', 'aria-label': 'Artifact content' });
  editor.value = a.content || '';
  editor.addEventListener('input', () => { a.content = editor.value; touch(); });
  const stage = h('div', { class: 'art-view', id: 'artifact-view' });
  let editing = false;
  function show(edit) {
    editing = edit;
    editor.hidden = !edit;
    stage.hidden = edit;
    if (!edit) stage.replaceChildren(artifactView(a));
  }
  const tabs = viewTabs(show, ['Preview', 'Edit']);

  const shareBox = h('div', { class: 'share-box card', id: 'share-box', hidden: true });
  const bar = h('div', { class: 'note-bar art-bar' },
    h('label', { class: 'note-proj', html: ICON.folder }, select),
    kind, lang, tabs.node, saved,
    h('button', { type: 'button', class: 'btn sm accent', id: 'artifact-share', html: `${ICON.share}<span>Share</span>`, onclick: () => showShare(a, shareBox) }),
    h('button', { type: 'button', class: 'act', title: 'Copy', 'aria-label': 'Copy content', html: ICON.copy, onclick: () => copy(a.content) }),
    h('button', { type: 'button', class: 'act', id: 'artifact-download', title: 'Download', 'aria-label': `Download ${fileName(a)}`, html: ICON.download, onclick: () => downloadArtifact(a) }),
    h('button', { type: 'button', class: 'danger sm', id: 'artifact-delete', onclick: async () => {
      if (!confirm('Delete this artifact?')) return;
      await deleteItem('artifacts', a.id);
      ctx.toast('Artifact deleted');
      ctx.go(project ? `#/p/${project.id}` : '#/artifacts');
    } }, 'Delete'));

  root.replaceChildren(h('div', { class: 'page-inner art-page' },
    h('a', { class: 'back', href: project ? `#/p/${project.id}` : '#/artifacts', html: `${ICON.back}<span>${project ? project.name : 'All artifacts'}</span>` }),
    h('div', { class: 'title-row' }, title),
    bar, shareBox, stage, editor));
  // A new, empty artifact opens in the editor; one with content opens as a preview.
  if (a.content.trim() && a.content !== STARTERS[a.kind]) show(false); else { tabs.pick(true); editor.focus(); }
}

// ---------------------------------------------------------------- A shared artifact (from a link)

export async function renderShared(root, data) {
  ctx.setTitle('Shared artifact', { crumb: { label: 'Artifacts', href: '#/artifacts' } });
  let a;
  try { a = await decodeShare(data); } catch (e) {
    root.replaceChildren(h('div', { class: 'page-inner' }, emptyBox(ICON.share, 'Could not open this artifact', e.message, h('a', { class: 'btn', href: '#/artifacts' }, 'My artifacts'))));
    return;
  }
  ctx.setTitle(a.title, { crumb: { label: 'Shared with you', href: location.hash } });
  const projects = await listProjects();
  const select = projectSelect(projects, null, 'shared-project');
  const stage = h('div', { class: 'art-view', id: 'artifact-view' }, artifactView(a));
  const source = h('div', { class: 'md art-doc art-code', hidden: true });
  source.innerHTML = renderMarkdown(`\`\`\`${a.kind === 'code' ? (a.lang || '').replace(/[^\w+#.-]/g, '') : a.kind === 'markdown' ? 'md' : a.kind}\n${a.content.replace(/```/g, '`​``')}\n\`\`\``);
  const tabs = viewTabs((code) => { stage.hidden = code; source.hidden = !code; });

  const saveBtn = h('button', { type: 'button', class: 'btn sm accent', id: 'shared-save', html: `${ICON.plus}<span>Save to my artifacts</span>`, onclick: async () => {
    const mine = await createArtifact({ ...a, projectId: select.value || null, shared: true });
    ctx.toast('Saved to your artifacts');
    ctx.go(`#/a/${mine.id}`);
  } });

  root.replaceChildren(h('div', { class: 'page-inner art-page' },
    h('div', { class: 'shared-banner', role: 'note' },
      h('span', { class: 'sb-icon', html: ICON.share }),
      h('div', {},
        h('strong', {}, 'Shared with you'),
        h('p', {}, `This ${{ html: 'HTML page', svg: 'SVG image', markdown: 'document', code: 'code' }[a.kind]} came inside the link you opened: it was unpacked here in your browser, nothing was downloaded from a server. ${a.kind === 'html' || a.kind === 'svg' ? 'It runs in a locked sandbox: it cannot see your chats or send anything anywhere.' : ''}`))),
    h('h1', { class: 'page-title shared-title' }, a.title),
    h('div', { class: 'note-bar art-bar' },
      h('span', { class: 'badge kind-badge', html: ICON[a.kind] }, kindLabel(a)),
      tabs.node,
      h('span', { class: 'spacer' }),
      h('label', { class: 'note-proj', html: ICON.folder }, select),
      saveBtn,
      h('button', { type: 'button', class: 'act', title: 'Copy', 'aria-label': 'Copy content', html: ICON.copy, onclick: () => copy(a.content) }),
      h('button', { type: 'button', class: 'act', title: 'Download', 'aria-label': `Download ${fileName(a)}`, html: ICON.download, onclick: () => downloadArtifact(a) })),
    stage, source));
}
