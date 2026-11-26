// Projects and Notes pages. Everything is stored in this browser (IndexedDB), nothing is uploaded.
//
// A project groups chats and notes and gives every chat inside it the same instructions and
// knowledge files. Chats and notes can also live on their own, outside any project.

import { putItem, getItem, deleteItem, listItems } from './storage.js';
import { renderMarkdown } from './markdown.js';
import { newId, KNOWLEDGE_BUDGET, noteTitleFrom } from './chats.js';

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
};

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

function h(tag, attrs = {}, ...children) {
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

/** Delete a project. Its chats and notes are kept and become unfiled. */
export async function deleteProject(id) {
  for (const c of await listItems('chats')) if (c.projectId === id) { c.projectId = null; await putItem('chats', c); }
  for (const n of await listItems('notes')) if (n.projectId === id) { n.projectId = null; await putItem('notes', n); }
  await deleteItem('projects', id);
}

export async function createNote({ title = '', body = '', projectId = null } = {}) {
  const now = Date.now();
  const n = { id: newId(), title: title || (body ? noteTitleFrom(body) : 'Untitled note'), body, projectId, createdAt: now, updatedAt: now };
  await putItem('notes', n);
  return n;
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

function emptyBox(icon, title, text, action) {
  return h('div', { class: 'empty-box' }, h('span', { class: 'eb-icon', html: icon }), h('strong', {}, title), h('p', {}, text), action || null);
}

// ---------------------------------------------------------------- Projects list

export async function renderProjects(root) {
  ctx.setTitle('Projects');
  const [projects, chats, notes] = await Promise.all([listProjects(), listItems('chats'), listNotes()]);
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
    grid.append(h('a', { class: 'project-card', href: `#/p/${p.id}` },
      h('span', { class: 'pc-icon', html: ICON.folder }),
      h('strong', {}, p.name),
      h('p', {}, p.description || 'No description'),
      h('span', { class: 'pc-meta' }, `${nc} chat${nc === 1 ? '' : 's'} · ${nn} note${nn === 1 ? '' : 's'} · ${(p.files || []).length} file${(p.files || []).length === 1 ? '' : 's'} · updated ${timeAgo(p.updatedAt)}`)));
  }
  root.replaceChildren(h('div', { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'Projects'),
      h('button', { type: 'button', class: 'btn primary', id: 'new-project', onclick: openForm, html: `${ICON.plus}<span>New project</span>` })),
    h('p', { class: 'page-sub' }, 'Group chats and notes, and give every chat in a project the same instructions and files. All stored in this browser.'),
    form,
    projects.length ? grid : emptyBox(ICON.folder, 'No projects yet', 'Create one to keep related chats, notes and files together.', h('button', { type: 'button', class: 'btn accent', onclick: openForm }, 'Create your first project'))));
}

// ---------------------------------------------------------------- One project

export async function renderProject(root, id) {
  const p = await getProject(id);
  if (!p) { root.replaceChildren(emptyBox(ICON.folder, 'Project not found', 'It may have been deleted.', h('a', { class: 'btn', href: '#/projects' }, 'All projects'))); ctx.setTitle('Projects'); return; }
  ctx.setTitle(p.name, { crumb: { label: 'Projects', href: '#/projects' } });
  const [chats, notes] = await Promise.all([listItems('chats'), listNotes()]);
  const myChats = chats.filter((c) => c.projectId === id);
  const myNotes = notes.filter((n) => n.projectId === id);
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
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, id: 'project-file-input', accept: '.txt,.md,.csv,.json,.js,.ts,.py,.html,.css,.java,.c,.cpp,.go,.rs,.rb,.php,.sh,.yml,.yaml,.toml,.xml,.sql,.log,.ini,text/*' });
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
            : h('p', { class: 'muted' }, 'No notes yet. Write one, or save any AI reply as a note.'))),
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
          if (!confirm(`Delete the project "${p.name}"? Its chats and notes are kept and moved out of the project.`)) return;
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
