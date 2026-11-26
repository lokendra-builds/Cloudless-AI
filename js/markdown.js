// A small, safe Markdown renderer for model replies. Everything is HTML-escaped first, so a reply
// can never inject tags or scripts; only the formatting below is turned into HTML.
// Supports: ``` code fences, `inline code`, # headings, **bold**, *italic*, ~~strike~~,
// - / * / 1. lists, > quotes, --- rules, [links](https://…), | tables |, paragraphs.

import { escapeHTML } from './escape.js';
import { highlight } from './highlight.js';

export { escapeHTML };

/** Only http(s) and mailto links survive; anything else (javascript:, data:) is dropped. */
function safeURL(url) {
  const u = String(url).trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

function inline(text) {
  // Pull inline code out first so its contents are not formatted.
  const codes = [];
  let s = escapeHTML(text).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeURL(url.replace(/&amp;/g, '&'));
    return href ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

/** HTML or SVG that can be shown live in the side panel. */
export function isPreviewable(lang, code) {
  const l = String(lang || '').toLowerCase();
  if (['html', 'htm', 'svg', 'xhtml'].includes(l)) return true;
  return !l && /^\s*(<!doctype html|<html[\s>]|<svg[\s>])/i.test(String(code || ''));
}

function codeBlock(lang, code) {
  const l = escapeHTML(lang || '');
  const preview = isPreviewable(lang, code)
    ? '<button type="button" class="copy-code preview-code" data-preview-code>Preview</button>' : '';
  return `<div class="code-block"><div class="code-head"><span>${l || 'code'}</span><span class="code-actions">${preview}`
    + '<button type="button" class="copy-code" data-copy-code>Copy</button></span></div>'
    + `<pre><code${l ? ` class="language-${l}"` : ''}>${highlight(code, lang)}</code></pre></div>`;
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of a still-streaming reply)
      out.push(codeBlock(fence[1], body.join('\n')));
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }
    const listRe = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
    if (listRe.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && (listRe.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = lines[i].match(listRe);
        if (m && /^\s*\d/.test(lines[i]) === ordered && !/^\s{2,}/.test(lines[i])) items.push(m[2]);
        else items[items.length - 1] += `\n${lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, '• ')}`;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it).replace(/\n/g, '<br>')}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])
      && !listRe.test(lines[i]) && !/^\s*>/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}
