// A tiny, dependency-free syntax highlighter for code blocks. It tokenizes the RAW code and
// escapes every piece itself, so the output is safe HTML: only <span class="tok-…"> is added.

import { escapeHTML } from './escape.js';

const KEYWORDS = new Set(`
  abstract and as assert async await break case catch class const continue def default defer del delete do elif else
  enum except export extends false final finally fn for foreach from func function go if impl implements import in
  instanceof interface is lambda let loop match mod module mut new nil none not null of or package pass private
  protected pub public raise return self static struct super switch this throw throws true try type typeof unless
  until use using var void where while with yield None True False echo fi then esac done elif local readonly
  int float double char bool boolean string str long short byte unsigned signed SELECT FROM WHERE GROUP BY ORDER
  INSERT INTO VALUES UPDATE SET DELETE JOIN LEFT RIGHT INNER OUTER ON AS AND OR NOT NULL LIMIT HAVING CREATE TABLE
  select from where group by order insert into values update set join left right inner outer on limit having create table
`.split(/\s+/).filter(Boolean));

const HASH_COMMENT = new Set(['python', 'py', 'bash', 'sh', 'shell', 'zsh', 'ruby', 'rb', 'yaml', 'yml', 'toml', 'r', 'perl', 'dockerfile', 'makefile', 'ini', 'conf']);
const NO_HIGHLIGHT = new Set(['text', 'txt', 'plain', 'plaintext', 'markdown', 'md', 'output', 'console']);

function tokenizer(lang) {
  const hash = HASH_COMMENT.has(lang);
  const sql = lang === 'sql';
  const parts = [
    hash ? '(#[^\\n]*)' : sql ? '(--[^\\n]*)' : '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|<!--[\\s\\S]*?-->)', // 1 comment
    '("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)', // 2 string
    '(\\b(?:0x[\\da-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b)', // 3 number
    '(@[A-Za-z_][\\w.]*)', // 4 decorator / annotation
    '([A-Za-z_$][\\w$]*)(?=\\s*\\()', // 5 function call / definition
    '([A-Za-z_$][\\w$]*)', // 6 word (keyword or plain)
  ];
  return new RegExp(parts.join('|'), 'g');
}

export function highlight(code, lang = '') {
  const l = String(lang || '').toLowerCase();
  const src = String(code ?? '');
  if (NO_HIGHLIGHT.has(l)) return escapeHTML(src);
  const re = tokenizer(l);
  let out = '';
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out += escapeHTML(src.slice(last, m.index));
    const [text, comment, string, number, deco, fn, word] = m;
    let cls = '';
    if (comment) cls = 'com';
    else if (string) cls = 'str';
    else if (number) cls = 'num';
    else if (deco) cls = 'dec';
    else if (fn) cls = KEYWORDS.has(fn) ? 'kw' : 'fn';
    else if (word) cls = KEYWORDS.has(word) ? 'kw' : /^[A-Z][a-z]\w*$/.test(word) ? 'type' : '';
    out += cls ? `<span class="tok-${cls}">${escapeHTML(text)}</span>` : escapeHTML(text);
    last = m.index + text.length;
  }
  return out + escapeHTML(src.slice(last));
}
