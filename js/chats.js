// Pure helpers for conversations (no DOM, no storage): easy to test.

/** Split a reply into its hidden reasoning and the visible answer. An unclosed <think> is all thinking. */
export function splitThinking(text) {
  const s = String(text ?? '');
  const thoughts = [];
  const answer = s.replace(/<think>([\s\S]*?)(<\/think>|$)/gi, (_, t) => { thoughts.push(t.trim()); return ''; });
  const open = /<think>(?![\s\S]*<\/think>)/i.test(s);
  return { thinking: thoughts.join('\n\n').trim(), answer: answer.trim(), thinkingOpen: open };
}

/** A short chat title from the first user message. */
export function titleFrom(text, max = 40) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export const DEFAULT_SYSTEM = 'You are Cloudless, a helpful, friendly assistant that runs entirely inside the user\'s web browser. '
  + 'Answer clearly and concisely. Use Markdown (lists, **bold**, code blocks with a language) when it helps.';

/** A user message's text for the model, with any attached files placed before it. */
export function userContent(m, maxFileChars = 6000) {
  const files = (m.files || []).map((f) => {
    if (f.pdf) return `[The user attached a PDF named "${f.name}". You cannot see its contents; if they ask about it, say so and ask them to paste the text they need.]`;
    const t = String(f.text ?? '');
    const body = t.length > maxFileChars ? `${t.slice(0, maxFileChars)}\n[… file cut to fit the model's memory …]` : t;
    return `File: ${f.name}\n\`\`\`\n${body}\n\`\`\``;
  });
  return [...files, String(m.content ?? '')].filter((x) => x.trim()).join('\n\n');
}

/**
 * Messages to send to the model: the system prompt plus as much recent history as fits.
 * Small in-browser models have a ~4k token window, so older turns are dropped first
 * (budget in characters, ~4 chars per token). Thinking is stripped from past replies.
 */
export const PROMPT_BUDGET_CHARS = 9000; // ~2,250 tokens, leaving room for the reply in a 4k window

/**
 * Character budgets for a context window: the chat history the model is sent, and the part of
 * it project knowledge files may use. 4K tokens keeps the original 9,000 / 4,000; they scale with it.
 */
export function budgetsFor(ctx = 4096) {
  const k = (Number(ctx) || 4096) / 4096;
  return { prompt: Math.round(PROMPT_BUDGET_CHARS * k), knowledge: Math.round(KNOWLEDGE_BUDGET * k) };
}

export function buildPrompt(history, { systemPrompt = '', budgetChars = PROMPT_BUDGET_CHARS } = {}) {
  const system = { role: 'system', content: (systemPrompt || '').trim() || DEFAULT_SYSTEM };
  const turns = history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && (String(m.content ?? '').trim() || m.files?.length))
    .map((m) => ({ role: m.role, content: m.role === 'assistant' ? splitThinking(m.content).answer : userContent(m) }));
  const kept = [];
  let used = system.content.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    const len = turns[i].content.length;
    if (kept.length && used + len > budgetChars) break;
    kept.unshift(turns[i]);
    used += len;
  }
  while (kept.length && kept[0].role !== 'user') kept.shift(); // a chat must start with the user
  return [system, ...kept];
}

/** Group chats for the sidebar: Today, Yesterday, Previous 7 days, Older. */
export function groupChats(chats, now = Date.now()) {
  const day = 86400000;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const groups = [['Today', []], ['Yesterday', []], ['Previous 7 days', []], ['Older', []]];
  for (const c of chats) {
    const t = c.updatedAt || c.createdAt || 0;
    const idx = t >= today ? 0 : t >= today - day ? 1 : t >= today - 7 * day ? 2 : 3;
    groups[idx][1].push(c);
  }
  return groups.filter(([, list]) => list.length);
}

/** "Good morning" / "Good afternoon" / "Good evening" for the start screen. */
export function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function newId() {
  return (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
}

/** Characters of project knowledge (files) a small model can take next to the chat itself. */
export const KNOWLEDGE_BUDGET = 4000;

/**
 * The system prompt for a chat: the user's global instructions, then (in a project) the
 * project's instructions and as much of its knowledge files as fits KNOWLEDGE_BUDGET.
 * Returns { text, used, total } so the UI can warn when files were cut.
 */
export function composeSystem({ base = '', project = null, budget = KNOWLEDGE_BUDGET } = {}) {
  const parts = [(base || '').trim() || DEFAULT_SYSTEM];
  let used = 0;
  let total = 0;
  if (project) {
    parts.push(`You are working inside the project "${project.name}".${project.description ? ` About it: ${project.description}` : ''}`);
    if ((project.instructions || '').trim()) parts.push(`Project instructions:\n${project.instructions.trim()}`);
    const docs = [];
    for (const f of project.files || []) {
      const t = String(f.text ?? '');
      total += t.length;
      const room = budget - used;
      if (room <= 200) continue;
      const body = t.length > room ? `${t.slice(0, room)}\n[… cut to fit the model's memory …]` : t;
      used += Math.min(t.length, room);
      docs.push(`File: ${f.name}\n\`\`\`\n${body}\n\`\`\``);
    }
    if (docs.length) parts.push(`Project knowledge (use it to answer):\n\n${docs.join('\n\n')}`);
  }
  return { text: parts.join('\n\n'), used, total };
}

/** A note title from free text: its first non-empty line, without Markdown marks. */
export function noteTitleFrom(text, max = 60) {
  const line = String(text ?? '').split('\n').map((l) => l.replace(/^[#>*\-\s`]+/, '').replace(/[*_`]/g, '').trim()).find(Boolean) || 'Untitled note';
  const colon = line.indexOf(':');
  if (colon >= 8 && colon <= max) return line.slice(0, colon).trim(); // "Topic: details" → "Topic"
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * A chat as a Markdown document: title, date and project, then each turn with its time.
 * Thinking is left out; attached files are listed by name.
 */
export function chatToMarkdown(chat, { projectName = '', userName = 'You' } = {}) {
  const when = (t) => (t ? new Date(t).toLocaleString() : '');
  const lines = [`# ${chat.title || 'Chat'}`, ''];
  const meta = [`Exported from Cloudless-AI on ${new Date().toLocaleString()}`];
  if (projectName) meta.push(`Project: ${projectName}`);
  lines.push(`_${meta.join(' · ')}_`, '');
  for (const m of chat.messages || []) {
    if (m.role === 'user') {
      lines.push('---', '', `**${userName}**${m.at ? ` · ${when(m.at)}` : ''}`, '');
      if (m.files?.length) lines.push(`Attached: ${m.files.map((f) => `\`${f.name}\``).join(', ')}`, '');
      if (String(m.content || '').trim()) lines.push(String(m.content).trim(), '');
    } else if (m.role === 'assistant') {
      const answer = splitThinking(m.content).answer;
      lines.push('---', '', `**Cloudless-AI**${m.model ? ` (${m.model})` : ''}${m.at ? ` · ${when(m.at)}` : ''}`, '', answer || '_(no answer)_', '');
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

/** A safe file name from a chat title: "Plan my week!" -> "plan-my-week.md" */
export function fileNameFor(title, ext = 'md') {
  const base = String(title || 'chat').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\u0900-\u097f]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';
  return `${base}.${ext}`;
}

/**
 * How full the model's memory is for the next message: { used, budget, pct, dropped, full }.
 * `dropped` counts saved messages that no longer fit and are left out of the prompt.
 */
export function memoryUse(history, draft = '', { systemPrompt = '', budgetChars = PROMPT_BUDGET_CHARS } = {}) {
  const next = draft && (draft.content || draft.files?.length) ? [...history, { role: 'user', ...draft }] : history;
  const prompt = buildPrompt(next, { systemPrompt, budgetChars });
  const sent = prompt.reduce((n, m) => n + m.content.length, 0);
  const all = next.filter((m) => (m.role === 'user' || m.role === 'assistant') && (String(m.content ?? '').trim() || m.files?.length)).length;
  const dropped = Math.max(0, all - (prompt.length - 1));
  const used = Math.min(sent, budgetChars);
  return { used, budget: budgetChars, pct: Math.min(100, Math.round((used / budgetChars) * 100)), dropped, full: dropped > 0 };
}
