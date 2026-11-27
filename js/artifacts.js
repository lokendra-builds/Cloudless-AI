// Artifacts: HTML pages, SVG images, Markdown documents and code files the user keeps, inside a
// project or on their own. Stored in this browser like notes.
//
// Sharing needs no server. The whole artifact is compressed into the link itself, after the "#":
//   https://…/Cloudless-AI/#/share/<deflate + base64url of {v, t, k, l, c}>
// Browsers never send the part after "#" to any server (not even GitHub Pages), so the content
// travels only inside the link. Whoever opens it decodes it in their own browser.

export const KINDS = Object.freeze({
  html: { label: 'HTML page', ext: 'html', mime: 'text/html' },
  svg: { label: 'SVG image', ext: 'svg', mime: 'image/svg+xml' },
  markdown: { label: 'Document', ext: 'md', mime: 'text/markdown' },
  code: { label: 'Code', ext: 'txt', mime: 'text/plain' },
});
export const KIND_IDS = Object.keys(KINDS);

const CODE_EXT = {
  python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', jsx: 'jsx', tsx: 'tsx', css: 'css',
  json: 'json', bash: 'sh', sh: 'sh', shell: 'sh', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs',
  go: 'go', rust: 'rs', rs: 'rs', ruby: 'rb', rb: 'rb', php: 'php', sql: 'sql', yaml: 'yml', yml: 'yml', toml: 'toml',
  xml: 'xml', kotlin: 'kt', swift: 'swift', dart: 'dart', r: 'r', lua: 'lua', text: 'txt', txt: 'txt',
};

/** Which kind of artifact a code block is, from its language tag (and content when untagged). */
export function kindFromLang(lang, code = '') {
  const l = String(lang || '').trim().toLowerCase();
  if (['html', 'htm', 'xhtml'].includes(l)) return 'html';
  if (l === 'svg') return 'svg';
  if (['md', 'markdown'].includes(l)) return 'markdown';
  if (!l && /^\s*(<!doctype html|<html[\s>])/i.test(code)) return 'html';
  if (!l && /^\s*<svg[\s>]/i.test(code)) return 'svg';
  return 'code';
}

export function fileName(a) {
  const base = String(a.title || 'artifact').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'artifact';
  const ext = a.kind === 'code' ? (CODE_EXT[String(a.lang || '').toLowerCase()] || 'txt') : KINDS[a.kind]?.ext || 'txt';
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

/** A short title: the page's <title>, the first heading, or the first line. */
export function titleFrom(kind, content, lang = '') {
  const s = String(content || '');
  const pick = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (kind === 'html') { const t = pick(/<title>([^<]*)<\/title>/i.exec(s)?.[1] || /<h1[^>]*>([^<]*)</i.exec(s)?.[1]); if (t) return t; }
  if (kind === 'svg') { const t = pick(/<title>([^<]*)<\/title>/i.exec(s)?.[1]); return t || 'Image'; }
  if (kind === 'markdown') { const t = pick(/^#{1,3}\s+(.+)$/m.exec(s)?.[1]); if (t) return t; }
  if (kind === 'code') {
    const t = pick(/^\s*(?:#|\/\/|--)\s*(.{3,})$/m.exec(s)?.[1]?.replace(/^[^\w]+/, ''));
    if (t) return t;
    return `${lang ? `${lang[0].toUpperCase()}${lang.slice(1)} code` : 'Code'}`;
  }
  return pick(s.replace(/<[^>]*>/g, ' ').split('\n').find((x) => x.trim())) || KINDS[kind]?.label || 'Artifact';
}

// ---------------------------------------------------------------- share links

export const SHARE_PREFIX = '#/share/';
/** Links longer than this may be cut by some chat apps and e-mail clients. */
export const LONG_LINK = 8_000;
/** Longer than this and browsers or apps start to refuse the link: download the file instead. */
export const MAX_LINK = 120_000;
/** A shared artifact never unpacks to more than this (a tiny link cannot hide a huge payload). */
const MAX_UNPACKED = 2_000_000;

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipeBytes(bytes, stream, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { reader.cancel().catch(() => {}); throw new Error('too big'); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The part of a share link after "#/share/". */
export async function encodeShare(a) {
  const payload = { v: 1, t: String(a.title || ''), k: a.kind, c: String(a.content || '') };
  if (a.kind === 'code' && a.lang) payload.l = String(a.lang);
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  return toBase64Url(await pipeBytes(raw, new CompressionStream('deflate-raw')));
}

/** Read a shared artifact back. Throws a friendly Error when the link is broken or cut short. */
export async function decodeShare(data) {
  let json;
  try {
    const clean = decodeURIComponent(String(data || '')).replace(/[^A-Za-z0-9_-]/g, '');
    if (!clean) throw new Error('empty');
    const bytes = await pipeBytes(fromBase64Url(clean), new DecompressionStream('deflate-raw'), MAX_UNPACKED);
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error(e?.message === 'too big'
      ? 'This shared artifact is too big to open.'
      : 'This link is broken or was cut short. Ask for the full link again.');
  }
  if (!json || json.v !== 1 || !KINDS[json.k] || typeof json.c !== 'string') throw new Error('This link was made by a newer or different app and cannot be opened.');
  return {
    title: String(json.t || '').slice(0, 120) || titleFrom(json.k, json.c, json.l),
    kind: json.k,
    lang: json.k === 'code' ? String(json.l || '').slice(0, 30) : '',
    content: json.c,
  };
}

/** A full link to send: this app's own address plus the encoded artifact. */
export async function shareLink(a, base = location.origin + location.pathname) {
  return `${base}${SHARE_PREFIX}${await encodeShare(a)}`;
}

// ---------------------------------------------------------------- showing HTML safely

/**
 * HTML runs in a sandboxed iframe without allow-same-origin, so it gets an opaque origin: it
 * cannot read this app's chats, storage or cookies. A strict CSP also blocks every network
 * request, so a page (even one from a shared link) cannot send anything anywhere.
 */
export function sandboxedDoc(code) {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const src = String(code || '');
  if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  if (/^\s*<svg[\s>]/i.test(src)) return `<!doctype html><html><head>${meta}<style>body{margin:0;display:grid;place-items:center;min-height:100vh}</style></head><body>${src}</body></html>`;
  return `<!doctype html><html><head>${meta}<meta charset="utf-8"></head><body>${src}</body></html>`;
}

export function sandboxedFrame(code, title) {
  const frame = document.createElement('iframe');
  frame.className = 'sp-frame';
  frame.title = title;
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = sandboxedDoc(code);
  return frame;
}
