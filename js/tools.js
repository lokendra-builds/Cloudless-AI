// Web tools the chat can use: Wikipedia search, DuckDuckGo instant answers, and Jina Reader
// (read any web page as text). All three answer the browser directly (CORS), so no backend is
// needed. They are the only things in Cloudless that send data off the device, so each is off
// until the user turns it on, or asks for it by name with a slash command.

export const TOOLS = Object.freeze({
  wikipedia: { id: 'wikipedia', label: 'Wikipedia', slash: '/wiki', host: 'wikipedia.org', what: 'Search Wikipedia articles', sends: 'your question' },
  duckduckgo: { id: 'duckduckgo', label: 'DuckDuckGo', slash: '/ddg', host: 'duckduckgo.com', what: 'Quick facts and instant answers', sends: 'your question' },
  reader: { id: 'reader', label: 'Read links', slash: '/read', host: 'r.jina.ai', what: 'Read web pages you link, through Jina Reader', sends: 'the link' },
});
export const TOOL_IDS = Object.keys(TOOLS);

const TIMEOUT_MS = 15_000;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const MAX_LINKS = 2;

/** Links in a message, without trailing punctuation. */
export function findUrls(text) {
  return [...new Set((String(text || '').match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, MAX_LINKS);
}

// Question words that confuse an exact-match search ("what is the capital of france" -> "capital of france").
const FILLER = /^(please\s+)?(can you\s+|could you\s+)?(tell me( about)?|explain|describe|search( for)?|look up|find( out)?|who|what|when|where|which|why|how( much| many| old| big| far)?)(\s+(is|are|was|were|did|does|do|was|has|have))?(\s+(the|a|an))?\s+/i;
const HINGLISH = /\s+(kya|kaun|kab|kahan|kaise|kitna|kitne|ke baare me|ke bare mein|ke baare mein|batao|bataiye|hai|tha|thi)\b/gi;

/** The whole question, tidied: Wikipedia's search ranks full questions better than keywords. */
export function wikiQuery(text) {
  const q = String(text || '').replace(URL_RE, ' ').replace(HINGLISH, ' ').replace(/[?!]+/g, ' ').replace(/\s+/g, ' ').trim();
  return q.slice(0, 200);
}

/** A short search query from a chat message (DuckDuckGo instant answers need just the topic). */
export function searchQuery(text) {
  let q = String(text || '').replace(URL_RE, ' ').replace(/[?!.]+/g, ' ').replace(/\s+/g, ' ').trim();
  q = q.replace(FILLER, '').replace(HINGLISH, ' ').replace(/\s+/g, ' ').trim();
  return q.slice(0, 200) || String(text || '').trim().slice(0, 200);
}

/**
 * What to run for a message. A slash command names one tool (and always runs: typing it is the
 * consent); otherwise the enabled tools run, links go to the reader.
 * Returns { calls: [{tool, query}], question } where question is what the model should answer.
 */
export function planTools(text, enabled = {}) {
  const raw = String(text || '').trim();
  const slash = /^\/(wiki|wikipedia|ddg|duckduckgo|read)\b\s*([\s\S]*)$/i.exec(raw);
  if (slash) {
    const cmd = slash[1].toLowerCase();
    const rest = slash[2].trim();
    if (cmd === 'read') {
      const urls = findUrls(rest);
      const ask = rest.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();
      return { calls: urls.map((u) => ({ tool: 'reader', query: u })), question: ask || 'Summarise this page in a few short points.', explicit: true };
    }
    const tool = cmd.startsWith('w') ? 'wikipedia' : 'duckduckgo';
    const query = tool === 'wikipedia' ? wikiQuery(rest) : searchQuery(rest);
    return { calls: query ? [{ tool, query }] : [], question: rest || '', explicit: true };
  }
  const calls = [];
  const urls = findUrls(raw);
  if (enabled.reader) urls.forEach((u) => calls.push({ tool: 'reader', query: u }));
  const query = searchQuery(raw);
  const isOnlyLinks = urls.length && !raw.replace(URL_RE, '').trim();
  if (query && !isOnlyLinks) {
    if (enabled.wikipedia) calls.push({ tool: 'wikipedia', query: wikiQuery(raw) || query });
    if (enabled.duckduckgo) calls.push({ tool: 'duckduckgo', query });
  }
  return { calls, question: raw, explicit: false };
}

async function getJson(url, signal, headers) {
  const res = await fetchWithTimeout(url, signal, headers);
  const body = await res.text();
  // DuckDuckGo sometimes answers 200 with an empty body (it limits automated or rapid requests).
  if (!body.trim()) throw new Error('sent an empty reply, try again in a moment');
  try { return JSON.parse(body); } catch { throw new Error('sent a reply that could not be read'); }
}

async function fetchWithTimeout(url, signal, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException('Timed out', 'TimeoutError')), TIMEOUT_MS);
  const onStop = () => ctl.abort(signal.reason);
  signal?.addEventListener('abort', onStop, { once: true });
  try {
    const res = await fetch(url, { signal: ctl.signal, headers, credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' });
    if (!res.ok) throw new Error(res.status === 429 ? 'too many requests, try again in a minute' : `HTTP ${res.status}`);
    return res;
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    if (e?.name === 'TimeoutError' || ctl.signal.reason?.name === 'TimeoutError') throw new Error('no answer in 15 seconds');
    if (e instanceof TypeError) throw new Error('could not connect (offline?)');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onStop);
  }
}

const clean = (s) => String(s || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Wikipedia: top 3 articles with their intro text. */
export async function wikipedia(query, { signal, lang = 'en' } = {}) {
  const url = `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrlimit: '3', prop: 'extracts|info', exintro: '1',
    explaintext: '1', exchars: '1200', inprop: 'url', redirects: '1', format: 'json', origin: '*',
  })}`;
  const data = await getJson(url, signal);
  const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return pages.filter((p) => p.extract).map((p) => ({ title: p.title, url: p.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`, text: clean(p.extract) }));
}

/** DuckDuckGo Instant Answer: a short abstract, direct answer, facts and related topics. */
export async function duckduckgo(query, { signal } = {}) {
  const url = `https://api.duckduckgo.com/?${new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1', t: 'cloudless' })}`;
  const d = await getJson(url, signal);
  const out = [];
  const facts = (d.Infobox?.content || []).filter((f) => f.label && typeof f.value === 'string').slice(0, 8).map((f) => `${f.label}: ${f.value}`);
  const parts = [d.Answer && `Answer: ${d.Answer}`, d.AbstractText, d.Definition && `Definition: ${d.Definition}`, facts.length && facts.join('\n')].filter(Boolean);
  if (parts.length) {
    out.push({ title: d.Heading || query, url: d.AbstractURL || d.DefinitionURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`, text: clean(parts.join('\n')) });
  }
  const topics = (d.RelatedTopics || []).flatMap((t) => (t.Topics ? t.Topics : [t])).filter((t) => t.Text && t.FirstURL);
  if (!out.length) topics.slice(0, 3).forEach((t) => out.push({ title: t.Text.split(' - ')[0].slice(0, 80), url: t.FirstURL, text: clean(t.Text) }));
  return out;
}

/** Jina Reader: any public web page as clean text. */
export async function reader(pageUrl, { signal } = {}) {
  let target;
  try { target = new URL(pageUrl); } catch { throw new Error('that is not a valid link'); }
  if (!/^https?:$/.test(target.protocol)) throw new Error('only http and https links can be read');
  const res = await fetchWithTimeout(`https://r.jina.ai/${target.href}`, signal, { Accept: 'text/plain' });
  const body = await res.text();
  const title = /^Title:\s*(.+)$/m.exec(body)?.[1]?.trim() || target.hostname;
  const md = body.includes('Markdown Content:') ? body.slice(body.indexOf('Markdown Content:') + 17) : body;
  // Drop image links and bare link targets: they eat the model's small memory and carry no meaning.
  const text = clean(md.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
  return [{ title, url: target.href, text }];
}

const RUNNERS = { wikipedia, duckduckgo, reader };

/**
 * Run the planned calls in parallel. onStep(step) fires as each starts and finishes, so the UI can
 * show "Searching Wikipedia…". Never throws for a failed tool: the step records the error and the
 * model answers without it. Returns { steps, sources } with sources numbered from 1.
 */
export async function runTools(calls, { signal, onStep = () => {} } = {}) {
  const steps = calls.map((c) => ({ tool: c.tool, query: c.query, status: 'running', count: 0, error: '' }));
  steps.forEach((s) => onStep(s, steps));
  const found = await Promise.all(calls.map(async (c, i) => {
    const step = steps[i];
    try {
      const results = await RUNNERS[c.tool](c.query, { signal });
      Object.assign(step, { status: 'done', count: results.length });
      return results.map((r) => ({ ...r, tool: c.tool }));
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      Object.assign(step, { status: 'error', error: e?.message || String(e) });
      return [];
    } finally {
      onStep(step, steps);
    }
  }));
  const seen = new Set();
  const sources = found.flat().filter((s) => /^https?:\/\//i.test(s.url) && !seen.has(s.url) && seen.add(s.url)).map((s, i) => ({ n: i + 1, ...s }));
  return { steps, sources };
}

/**
 * The text the model reads: numbered sources (cut to fit `budget` characters), then the request.
 * Shared between sources so one long page cannot crowd out the rest.
 */
export function withSources(question, sources, { budget = 3600 } = {}) {
  if (!sources.length) return question;
  const each = Math.max(300, Math.floor(budget / sources.length) - 80);
  const blocks = sources.map((s) => {
    const t = s.text.length > each ? `${s.text.slice(0, each).replace(/\s+\S*$/, '')}…` : s.text;
    return `[${s.n}] ${s.title} (${s.url})\n${t}`;
  });
  return `Web results (fetched just now):\n\n${blocks.join('\n\n')}\n\n---\nUsing the web results above where they help, answer the request below. Cite the sources you use like [1]. If the results do not answer it, say so and answer from what you know.\n\nRequest: ${question}`;
}

/** "Searched Wikipedia for “x”" for a finished step. */
export function stepLabel(step) {
  const t = TOOLS[step.tool];
  const what = step.tool === 'reader' ? `${shortUrl(step.query)}` : `“${step.query}”`;
  if (step.status === 'running') return step.tool === 'reader' ? `Reading ${what}…` : `Searching ${t.label} for ${what}…`;
  if (step.status === 'error') return `${t.label}: ${step.error}`;
  if (step.tool === 'reader') return `Read ${what}`;
  return `Searched ${t.label} for ${what} · ${step.count ? `${step.count} result${step.count === 1 ? '' : 's'}` : 'nothing found'}`;
}

export function shortUrl(u) {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '')).slice(0, 60); } catch { return String(u).slice(0, 60); }
}
