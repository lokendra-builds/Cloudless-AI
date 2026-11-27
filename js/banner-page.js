// The Banners page: pick a size and a template, type the text or let the local model write it,
// then download a PNG. Everything happens in this tab.

import { h, createArtifact } from './pages.js';
import { getSettings, saveSettings } from './storage.js';
import {
  SIZES, SIZE_BY_ID, PALETTES, PALETTE_BY_ID, TEMPLATES, bannerSVG, bannerPNG, svgURL, embeddedFonts, fontsReady,
  bannerPrompt, parseBannerText,
} from './banners.js';

const DEFAULT = {
  size: 'yt-thumb', template: 'bold', palette: 'ember',
  data: { tag: 'New video', headline: 'Private AI on your own laptop', subtitle: 'No cloud, no account, no API key. It runs in your browser.', cta: 'Watch now' },
};
const FIELDS = [
  ['tag', 'Small label', 'e.g. New video, Webinar, Sale', 40],
  ['headline', 'Headline', 'The big words', 90],
  ['subtitle', 'Subtitle', 'One short line under the headline', 160],
  ['cta', 'Button', 'e.g. Watch now, Join free', 30],
];

let urls = [];
const keep = (u) => { urls.push(u); return u; };
const freeUrls = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; };

function load() {
  const saved = getSettings().banner || {};
  return {
    size: SIZE_BY_ID[saved.size] ? saved.size : DEFAULT.size,
    template: TEMPLATES.some((t) => t.id === saved.template) ? saved.template : DEFAULT.template,
    palette: PALETTE_BY_ID[saved.palette] ? saved.palette : DEFAULT.palette,
    data: { ...DEFAULT.data, ...(saved.data || {}) },
  };
}

function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function radio(name, value, checked, label, extra = {}) {
  const input = h('input', { type: 'radio', name, value, checked, class: 'sr-radio', id: `bn-${name}-${value}` });
  return h('label', { class: `bn-opt ${extra.class || ''}`, for: input.id, title: extra.title || null }, input, ...(Array.isArray(label) ? label : [label]));
}

export async function renderBanners(root, ctx) {
  ctx.setTitle('Banners');
  const st = load();
  const save = () => saveSettings({ banner: st });
  await fontsReady();
  const fonts = await embeddedFonts();

  // ---- size
  const groups = [...new Set(SIZES.map((s) => s.group))];
  const sizeSet = h('fieldset', { class: 'bn-field' }, h('legend', {}, 'Size'),
    groups.map((g) => h('div', { class: 'bn-group' }, h('span', { class: 'bn-glabel' }, g),
      h('div', { class: 'bn-row' }, SIZES.filter((s) => s.group === g).map((s) => radio('size', s.id, s.id === st.size,
        [h('span', {}, s.name), h('small', {}, `${s.w} × ${s.h}`)]))))));

  // ---- template, with a live thumbnail of each
  const thumbs = {};
  const tplSet = h('fieldset', { class: 'bn-field' }, h('legend', {}, 'Template'),
    h('div', { class: 'bn-tpls' }, TEMPLATES.map((t) => {
      thumbs[t.id] = h('img', { alt: '', class: 'bn-thumb', width: 160, height: 90 });
      return radio('template', t.id, t.id === st.template, [thumbs[t.id], h('span', { class: 'bn-tname' }, t.name), h('small', {}, t.what)], { class: 'tpl' });
    })));

  // ---- colours
  const palSet = h('fieldset', { class: 'bn-field' }, h('legend', {}, 'Colours'),
    h('div', { class: 'bn-row' }, PALETTES.map((p) => radio('palette', p.id, p.id === st.palette,
      [h('span', { class: 'swatch', style: `background:linear-gradient(135deg, ${p.bg1}, ${p.bg2})`, 'aria-hidden': 'true' }), h('span', {}, p.name)], { class: 'pal' }))));

  // ---- text
  const inputs = {};
  const textSet = h('fieldset', { class: 'bn-field' }, h('legend', {}, 'Text'),
    FIELDS.map(([k, label, ph, max]) => {
      inputs[k] = h(k === 'subtitle' ? 'textarea' : 'input', { id: `bn-${k}`, maxlength: max, placeholder: ph, rows: k === 'subtitle' ? 2 : null, autocomplete: 'off' });
      inputs[k].value = st.data[k] || '';
      return h('label', { class: 'field', for: `bn-${k}` }, h('span', {}, label), inputs[k]);
    }),
    h('p', { class: 'muted bn-hint' }, 'Leave a box empty to leave that part out.'));

  // ---- the AI box
  const topic = h('textarea', { id: 'bn-topic', rows: 2, maxlength: 400, placeholder: 'What is it about? e.g. "My cooking channel: a 5 minute paneer recipe"' });
  const aiStatus = h('p', { class: 'bn-status', id: 'bn-ai-status', role: 'status', 'aria-live': 'polite' });
  const aiBtn = h('button', { type: 'button', class: 'btn accent', id: 'bn-write' }, 'Write the text with AI');
  const aiBox = h('div', { class: 'bn-ai card' },
    h('label', { class: 'field', for: 'bn-topic' }, h('span', {}, 'Let the AI write it'), topic),
    h('div', { class: 'bn-ai-row' }, aiBtn, h('span', { class: 'muted bn-model', id: 'bn-model' })), aiStatus);

  // ---- preview and actions
  const img = h('img', { id: 'bn-preview', alt: '', class: 'bn-img' });
  const safeBox = h('div', { class: 'bn-safe', hidden: true, 'aria-hidden': 'true' });
  const stage = h('div', { class: 'bn-stage' }, img, safeBox);
  const meta = h('p', { class: 'bn-meta', id: 'bn-meta' });
  const note = h('p', { class: 'muted bn-note', id: 'bn-note' });
  const safeToggle = h('input', { type: 'checkbox', id: 'bn-show-safe', checked: true });
  const safeLabel = h('label', { class: 'bn-check', for: 'bn-show-safe' }, safeToggle, h('span', {}, 'Show the safe area'));
  const pngBtn = h('button', { type: 'button', class: 'btn primary', id: 'bn-png' }, 'Download PNG');
  const svgBtn = h('button', { type: 'button', class: 'btn', id: 'bn-svg' }, 'Download SVG');
  const artBtn = h('button', { type: 'button', class: 'btn', id: 'bn-artifact' }, 'Save as artifact');

  const form = h('form', { class: 'bn-controls', onsubmit: (e) => e.preventDefault() }, sizeSet, tplSet, palSet, textSet, aiBox);
  root.replaceChildren(h('div', { class: 'page-inner banner-page' },
    h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'Banners')),
    h('p', { class: 'page-sub' }, 'Thumbnails, posts and banners for YouTube, Instagram, LinkedIn and websites. Pick a size and a template, type your text or let the AI write it, then download a PNG. Made in this browser, nothing is uploaded.'),
    h('div', { class: 'bn-grid' }, form,
      h('div', { class: 'bn-side' }, stage, meta, note, safeLabel, h('div', { class: 'bn-actions' }, pngBtn, svgBtn, artBtn)))));

  // ---- drawing
  let timer = 0;
  function draw() {
    freeUrls();
    const size = SIZE_BY_ID[st.size];
    const svg = bannerSVG(st, fonts);
    img.src = keep(svgURL(svg));
    img.width = size.w;
    img.height = size.h;
    img.alt = `${size.group} ${size.name.toLowerCase()} banner: ${[st.data.tag, st.data.headline, st.data.subtitle, st.data.cta].filter(Boolean).join(' · ') || 'no text yet'}`;
    stage.style.aspectRatio = `${size.w} / ${size.h}`;
    meta.textContent = `${size.group} · ${size.name} · ${size.w} × ${size.h} px`;
    note.textContent = size.note || '';
    note.hidden = !size.note;
    safeLabel.hidden = !size.safe;
    safeBox.hidden = !size.safe || !safeToggle.checked;
    if (size.safe) Object.assign(safeBox.style, { left: `${(size.safe.x / size.w) * 100}%`, top: `${(size.safe.y / size.h) * 100}%`, width: `${(size.safe.w / size.w) * 100}%`, height: `${(size.safe.h / size.h) * 100}%` });
    for (const t of TEMPLATES) {
      thumbs[t.id].src = keep(svgURL(bannerSVG({ ...st, template: t.id }, fonts)));
      thumbs[t.id].style.aspectRatio = `${size.w} / ${size.h}`;
    }
  }
  const redraw = () => { clearTimeout(timer); timer = setTimeout(() => { draw(); save(); }, 120); };

  form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'size' || t.name === 'template' || t.name === 'palette') { st[t.name] = t.value; draw(); save(); }
  });
  for (const [k] of FIELDS) inputs[k].addEventListener('input', () => { st.data[k] = inputs[k].value; redraw(); });
  safeToggle.addEventListener('change', draw);

  pngBtn.addEventListener('click', async () => {
    const size = SIZE_BY_ID[st.size];
    pngBtn.disabled = true;
    try {
      download(await bannerPNG(bannerSVG(st, fonts), size), `banner-${size.id}-${size.w}x${size.h}.png`);
      ctx.toast(`PNG saved: ${size.w} × ${size.h}`);
    } catch (e) { ctx.toast(`Could not make the PNG: ${e.message || e}`); } finally { pngBtn.disabled = false; }
  });
  svgBtn.addEventListener('click', () => {
    const size = SIZE_BY_ID[st.size];
    download(new Blob([bannerSVG(st, fonts)], { type: 'image/svg+xml' }), `banner-${size.id}-${size.w}x${size.h}.svg`);
  });
  artBtn.addEventListener('click', async () => {
    // Without the embedded fonts: small enough to share as a link.
    const a = await createArtifact({ kind: 'svg', content: bannerSVG(st, ''), title: st.data.headline || 'Banner' });
    ctx.toast('Saved to Artifacts', { action: { label: 'Open', run: () => ctx.go(`#/a/${a.id}`) } });
  });

  // ---- AI writing (the local model only writes the words)
  const llm = ctx.llm;
  const showModel = () => { root.querySelector('#bn-model').textContent = `with ${llm.label()} on this device`; };
  showModel();
  let controller = null;
  aiBtn.addEventListener('click', async () => {
    if (controller) { controller.abort(); return; } // the button is Stop while writing
    if (!topic.value.trim()) { ctx.toast('Say what the banner is about first'); topic.focus(); return; }
    if (llm.busy()) { ctx.toast('Wait for the chat reply to finish'); return; }
    controller = new AbortController();
    const t0 = performance.now();
    try {
      if (!llm.ready()) {
        const cached = await llm.cached();
        if (!cached && !confirm(`Download ${llm.label()} (${llm.gb()} GB)? It downloads once and then runs on this device.`)) return;
        aiBtn.textContent = 'Stop';
        const tick = setInterval(() => { aiStatus.textContent = `${cached ? 'Loading' : 'Downloading'} ${llm.label()}… ${Math.round(llm.progress() * 100)}%`; }, 250);
        try { await llm.load(); } finally { clearInterval(tick); }
      }
      aiBtn.textContent = 'Stop';
      aiStatus.classList.add('live');
      const t1 = performance.now();
      const tick = setInterval(() => { aiStatus.textContent = `Writing with ${llm.label()}… ${((performance.now() - t1) / 1000).toFixed(1)}s`; }, 200);
      let reply = '';
      try { reply = await llm.ask(bannerPrompt(topic.value, SIZE_BY_ID[st.size]), { signal: controller.signal }); } finally { clearInterval(tick); }
      const got = parseBannerText(reply);
      if (!got) { aiStatus.textContent = 'The model did not give usable text. Try again, or type it yourself.'; return; }
      for (const [k] of FIELDS) { st.data[k] = got[k] || ''; inputs[k].value = st.data[k]; }
      draw();
      save();
      aiStatus.textContent = `Written by ${llm.label()} in ${((performance.now() - t1) / 1000).toFixed(1)}s${t1 - t0 > 500 ? ` (plus ${((t1 - t0) / 1000).toFixed(1)}s to load it)` : ''}. Edit anything you like.`;
    } catch (e) {
      aiStatus.textContent = e?.name === 'AbortError' ? 'Stopped.' : `Could not write it: ${e?.message || e}`;
    } finally {
      controller = null;
      aiBtn.textContent = 'Write the text with AI';
      aiStatus.classList.remove('live');
      showModel();
    }
  });

  draw();
}
