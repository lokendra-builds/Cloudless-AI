// Banners: ready-made templates for YouTube, Instagram, LinkedIn and websites, filled with your
// text (or text the local model writes). The app does the layout, so even a small model on the CPU
// gives a clean banner: it only writes the words. Banners are drawn as SVG and saved as PNG by the
// browser itself, nothing is uploaded.

export const SIZES = Object.freeze([
  { id: 'yt-thumb', group: 'YouTube', name: 'Thumbnail', w: 1280, h: 720 },
  { id: 'yt-banner', group: 'YouTube', name: 'Channel banner', w: 2560, h: 1440, safe: { x: 507, y: 508, w: 1546, h: 423 },
    note: 'Text stays inside the middle 1546 × 423 area, the part YouTube shows on every device.' },
  { id: 'ig-post', group: 'Instagram', name: 'Square post', w: 1080, h: 1080 },
  { id: 'ig-portrait', group: 'Instagram', name: 'Portrait post', w: 1080, h: 1350 },
  { id: 'ig-story', group: 'Instagram', name: 'Story', w: 1080, h: 1920, safe: { x: 80, y: 260, w: 920, h: 1400 },
    note: 'Leaves the top and bottom free for the profile bar and the reply box.' },
  { id: 'li-post', group: 'LinkedIn', name: 'Post', w: 1200, h: 627 },
  { id: 'li-banner', group: 'LinkedIn', name: 'Profile banner', w: 1584, h: 396, safe: { x: 430, y: 40, w: 1110, h: 316 },
    note: 'Keeps the text clear of your profile photo on the left.' },
  { id: 'web-hero', group: 'Website', name: 'Hero banner', w: 1920, h: 600 },
  { id: 'web-og', group: 'Website', name: 'Link preview', w: 1200, h: 630, note: 'The picture shown when your link is shared (Open Graph).' },
]);
export const SIZE_BY_ID = Object.fromEntries(SIZES.map((s) => [s.id, s]));

export const PALETTES = Object.freeze([
  { id: 'ember', name: 'Ember', bg1: '#c96442', bg2: '#7f321b', ink: '#ffffff', sub: '#fde8df', accent: '#ffffff', accentInk: '#7f321b' },
  { id: 'ocean', name: 'Ocean', bg1: '#1565c0', bg2: '#0a2a4a', ink: '#ffffff', sub: '#d6e8ff', accent: '#ffd166', accentInk: '#0a2a4a' },
  { id: 'forest', name: 'Forest', bg1: '#2d6a4f', bg2: '#123524', ink: '#ffffff', sub: '#d8f3dc', accent: '#ffd60a', accentInk: '#123524' },
  { id: 'sunset', name: 'Sunset', bg1: '#ff8a5c', bg2: '#ffc371', ink: '#2b1105', sub: '#4a2412', accent: '#2b1105', accentInk: '#ffffff' },
  { id: 'paper', name: 'Paper', bg1: '#faf9f5', bg2: '#ebe7da', ink: '#141413', sub: '#4a4945', accent: '#c96442', accentInk: '#ffffff' },
  { id: 'night', name: 'Night', bg1: '#2a2650', bg2: '#0e0d17', ink: '#ffffff', sub: '#cfcbe6', accent: '#a78bfa', accentInk: '#0e0d17' },
]);
export const PALETTE_BY_ID = Object.fromEntries(PALETTES.map((p) => [p.id, p]));

export const TEMPLATES = Object.freeze([
  { id: 'bold', name: 'Bold', what: 'Gradient, big headline, button' },
  { id: 'minimal', name: 'Minimal', what: 'Light, serif headline, accent bar' },
  { id: 'split', name: 'Split', what: 'Text panel beside a pattern' },
  { id: 'spotlight', name: 'Spotlight', what: 'Dark, glowing, centred' },
]);

const SANS = 'Inter';
const SERIF = 'Source Serif 4';
const STACK = { [SANS]: "Inter, 'Segoe UI', Roboto, Arial, 'Noto Sans', 'Noto Sans Devanagari', sans-serif", [SERIF]: "'Source Serif 4', Georgia, 'Times New Roman', 'Noto Serif', 'Noto Serif Devanagari', serif" };

// ---------------------------------------------------------------- small helpers

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;
export const escapeXML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

let measureCtx = null;
function measure(text, size, family, weight) {
  measureCtx ||= (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas')).getContext('2d');
  measureCtx.font = `${weight} ${size}px ${STACK[family]}`;
  return measureCtx.measureText(text).width;
}

/** Split text into lines no wider than maxW (long words are broken). */
function wrap(text, size, family, weight, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (measure(tryLine, size, family, weight) <= maxW) { line = tryLine; continue; }
      if (line) lines.push(line);
      if (measure(word, size, family, weight) <= maxW) { line = word; continue; }
      let part = '';
      for (const ch of word) {
        if (measure(part + ch, size, family, weight) > maxW && part) { lines.push(part); part = ch; } else part += ch;
      }
      line = part;
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** The biggest font size (up to maxSize) at which text fits in maxLines lines of maxW. */
export function fitText(text, { family = SANS, weight = 700, maxW, maxSize, minSize = 10, maxLines = 3 }) {
  let size = maxSize;
  let lines = wrap(text, size, family, weight, maxW);
  while ((lines.length > maxLines) && size > minSize) {
    size = Math.max(minSize, size * 0.94);
    lines = wrap(text, size, family, weight, maxW);
  }
  return { size: r1(size), lines };
}

function textBlock(lines, { x, top, size, lh, family, weight, fill, anchor = 'start', spacing = 0 }) {
  const ff = escapeXML(STACK[family]);
  return lines.map((ln, i) => `<text x="${r1(x)}" y="${r1(top + i * size * lh + size * 0.86)}" font-family="${ff}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${r1(spacing)}"` : ''}>${escapeXML(ln)}</text>`).join('');
}

/**
 * Tag, headline, subtitle and button stacked in `box`, shrunk until they fit.
 * Returns { svg, height, top } so templates can place decorations around the text.
 */
function stack(box, d, st) {
  const maxW = box.w * (st.widthFrac || 1);
  const tall = box.h / box.w > 1.2; // stories and portrait posts: use the width, allow more lines
  const unit = tall ? box.w * 0.82 : Math.min(box.h * 1.15, box.w * 0.62);
  const short = box.h / box.w < 0.36; // banner strips: fewer lines, one row
  const x = st.align === 'middle' ? box.x + box.w / 2 : box.x;
  let scale = 1;
  let out = null;
  for (let i = 0; i < 16; i++) {
    const tagSize = clamp(unit * 0.05 * scale, 12, 70);
    const gap = unit * 0.05 * scale;
    const head = d.headline ? fitText(d.headline, { family: st.headFamily, weight: st.headWeight, maxW, maxSize: unit * (short ? 0.3 : tall ? 0.19 : 0.2) * scale, maxLines: short ? 2 : tall ? 4 : 3 }) : null;
    const sub = d.subtitle ? fitText(d.subtitle, { family: SANS, weight: 500, maxW: Math.min(maxW, box.w * 0.9), maxSize: clamp(unit * 0.065 * scale, 12, 90), maxLines: short ? 1 : 3 }) : null;
    const ctaSize = clamp(unit * 0.05 * scale, 12, 70);
    const parts = [];
    let h = 0;
    if (d.tag) parts.push(['tag', h, tagSize]), h += tagSize * 1.2 + gap * 0.8;
    if (head) parts.push(['head', h, head]), h += head.lines.length * head.size * st.headLh + gap * 0.7;
    if (sub) parts.push(['sub', h, sub]), h += sub.lines.length * sub.size * 1.3 + gap;
    if (d.cta) parts.push(['cta', h, ctaSize]), h += ctaSize * 2.3;
    else h -= gap * 0.7;
    out = { parts, h, head, sub };
    if (h <= box.h || scale < 0.4) break;
    scale *= 0.92;
  }
  const top = st.valign === 'end' ? box.y + box.h - out.h : st.valign === 'start' ? box.y : box.y + (box.h - out.h) / 2;
  const anchor = st.align === 'middle' ? 'middle' : 'start';
  let svg = '';
  for (const [kind, at, v] of out.parts) {
    const y = top + at;
    if (kind === 'tag') svg += textBlock([d.tag.toUpperCase()], { x, top: y, size: v, lh: 1.2, family: SANS, weight: 700, fill: st.tagColor, anchor, spacing: v * 0.12 });
    if (kind === 'head') svg += textBlock(v.lines, { x, top: y, size: v.size, lh: st.headLh, family: st.headFamily, weight: st.headWeight, fill: st.ink, anchor, spacing: st.headFamily === SANS ? -v.size * 0.02 : 0 });
    if (kind === 'sub') svg += textBlock(v.lines, { x, top: y, size: v.size, lh: 1.3, family: SANS, weight: 500, fill: st.sub, anchor });
    if (kind === 'cta') {
      const tw = measure(d.cta, v, SANS, 700);
      const bw = tw + v * 2.4;
      const bh = v * 2.2;
      const bx = anchor === 'middle' ? x - bw / 2 : x;
      svg += `<rect x="${r1(bx)}" y="${r1(y)}" width="${r1(bw)}" height="${r1(bh)}" rx="${r1(bh / 2)}" fill="${st.ctaBg}"/>`;
      svg += textBlock([d.cta], { x: bx + bw / 2, top: y + (bh - v) / 2 - v * 0.04, size: v, lh: 1, family: SANS, weight: 700, fill: st.ctaInk, anchor: 'middle' });
    }
  }
  return { svg, top, height: out.h };
}

function frame(size) {
  const pad = Math.round(Math.min(size.w, size.h) * 0.085);
  return size.safe ? { ...size.safe } : { x: pad, y: pad, w: size.w - pad * 2, h: size.h - pad * 2 };
}

// ---------------------------------------------------------------- the four templates

const TEMPLATE_DRAW = {
  bold(size, d, p) {
    const { w, h } = size;
    const box = frame(size);
    const m = Math.max(w, h);
    const deco = `<circle cx="${r1(w * 0.92)}" cy="${r1(h * 0.1)}" r="${r1(m * 0.28)}" fill="${p.accent}" opacity=".10"/>`
      + `<circle cx="${r1(w * 0.98)}" cy="${r1(h * 0.95)}" r="${r1(m * 0.17)}" fill="${p.accent}" opacity=".08"/>`
      + `<circle cx="${r1(w * 0.03)}" cy="${r1(h * 1.02)}" r="${r1(m * 0.12)}" fill="${p.ink}" opacity=".06"/>`;
    const t = stack(box, d, { align: 'start', widthFrac: w / h > 1.2 ? 0.78 : 1, headFamily: SANS, headWeight: 800, headLh: 1.05, ink: p.ink, sub: p.sub, tagColor: p.sub, ctaBg: p.accent, ctaInk: p.accentInk });
    return `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.bg1}"/><stop offset="1" stop-color="${p.bg2}"/></linearGradient></defs>`
      + `<rect width="${w}" height="${h}" fill="url(#g)"/>${deco}${t.svg}`;
  },

  minimal(size, d, p) {
    const { w, h } = size;
    const light = p.id === 'paper' ? '#faf9f5' : mix(p.bg1, '#ffffff', 0.9);
    const accent = p.id === 'paper' ? p.accent : mix(p.bg1, '#000000', 0.12);
    const box = frame(size);
    const bar = Math.max(6, Math.round(Math.min(w, h) * 0.012));
    const inner = { ...box, x: box.x + bar * 3, w: box.w - bar * 3 };
    const t = stack(inner, d, { align: 'start', widthFrac: w / h > 1.4 ? 0.82 : 1, headFamily: SERIF, headWeight: 600, headLh: 1.1, ink: '#141413', sub: '#4a4945', tagColor: accent, ctaBg: accent, ctaInk: '#ffffff' });
    return `<rect width="${w}" height="${h}" fill="${light}"/>`
      + `<rect x="${r1(box.x)}" y="${r1(t.top)}" width="${bar}" height="${r1(t.height)}" rx="${bar / 2}" fill="${accent}"/>`
      + `<rect x="0" y="${h - bar}" width="${w}" height="${bar}" fill="${accent}" opacity=".85"/>${t.svg}`;
  },

  split(size, d, p) {
    const { w, h } = size;
    const wide = w / h >= 1.15;
    const box = frame(size);
    let panel, text, dots;
    if (wide) {
      const cut = size.safe ? box.x + box.w * 0.64 : w * 0.6;
      panel = `<rect width="${r1(cut)}" height="${h}" fill="url(#g)"/>`;
      text = { x: box.x, y: box.y, w: cut - box.x - Math.min(w, h) * 0.06, h: box.h };
      dots = { x: cut, y: 0, w: w - cut, h };
    } else {
      const cut = size.safe ? box.y + box.h * 0.38 : h * 0.4;
      panel = `<rect y="${r1(cut)}" width="${w}" height="${r1(h - cut)}" fill="url(#g)"/>`;
      text = { x: box.x, y: cut + Math.min(w, h) * 0.07, w: box.w, h: box.y + box.h - cut - Math.min(w, h) * 0.07 };
      dots = { x: 0, y: 0, w, h: cut };
    }
    const step = Math.max(24, Math.round(Math.min(dots.w, dots.h) / 7));
    const light = p.id === 'paper'; // a light palette: draw the pattern in its accent colour
    const dotA = light ? p.accent : p.bg1;
    const dotB = light ? p.sub : p.bg2;
    let pattern = '';
    for (let y = dots.y + step / 2; y < dots.y + dots.h; y += step) {
      for (let x = dots.x + step / 2; x < dots.x + dots.w; x += step) {
        const k = ((x * 7 + y * 13) / step) % 5;
        pattern += k < 1.2 ? `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(step * 0.32)}" fill="${dotA}" opacity=".9"/>` : `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(step * 0.1)}" fill="${dotB}" opacity=".45"/>`;
      }
    }
    const ring = `<circle cx="${r1(dots.x + dots.w / 2)}" cy="${r1(dots.y + dots.h / 2)}" r="${r1(Math.min(dots.w, dots.h) * 0.3)}" fill="none" stroke="${dotA}" stroke-width="${r1(Math.min(dots.w, dots.h) * 0.05)}"/>`;
    const t = stack(text, d, { align: 'start', headFamily: SANS, headWeight: 800, headLh: 1.05, valign: wide ? 'middle' : 'start', ink: p.ink, sub: p.sub, tagColor: p.sub, ctaBg: p.accent, ctaInk: p.accentInk });
    const back = light ? '#ffffff' : mix(p.bg1, '#ffffff', 0.86);
    return `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.bg1}"/><stop offset="1" stop-color="${p.bg2}"/></linearGradient></defs>`
      + `<rect width="${w}" height="${h}" fill="${back}"/>${pattern}${ring}${panel}${t.svg}`;
  },

  spotlight(size, d, p) {
    const { w, h } = size;
    const box = frame(size);
    const dark = mix(p.bg2, '#000000', p.id === 'paper' || p.id === 'sunset' ? 0.82 : 0.45);
    const glow = p.id === 'paper' ? p.accent : p.bg1;
    const gridStep = Math.round(Math.min(w, h) / 9);
    let grid = '';
    for (let x = gridStep; x < w; x += gridStep) grid += `<path d="M${x} 0V${h}"/>`;
    for (let y = gridStep; y < h; y += gridStep) grid += `<path d="M0 ${y}H${w}"/>`;
    const t = stack(box, d, { align: 'middle', widthFrac: w / h > 1.4 ? 0.8 : 0.95, headFamily: SANS, headWeight: 800, headLh: 1.06, ink: '#ffffff', sub: '#d9d6e8', tagColor: p.id === 'paper' || p.id === 'sunset' ? '#ffd9c7' : mix(p.accent, '#ffffff', 0.25), ctaBg: p.id === 'paper' ? p.accent : p.accent, ctaInk: p.id === 'paper' ? '#ffffff' : p.accentInk });
    return `<defs><radialGradient id="r" cx=".5" cy=".5" r=".6"><stop offset="0" stop-color="${glow}" stop-opacity=".75"/><stop offset=".55" stop-color="${glow}" stop-opacity=".18"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient></defs>`
      + `<rect width="${w}" height="${h}" fill="${dark}"/><g stroke="#ffffff" stroke-opacity=".05" stroke-width="1.5">${grid}</g>`
      + `<rect width="${w}" height="${h}" fill="url(#r)"/>${t.svg}`;
  },
};

// ---------------------------------------------------------------- whole banners

let fontCSS = null;
/** The app's own fonts as data: URLs, so the SVG looks the same as a picture and as a PNG. */
export async function embeddedFonts() {
  if (fontCSS != null) return fontCSS;
  const files = [['Inter', 'vendor/fonts/inter.woff2'], ['Source Serif 4', 'vendor/fonts/source-serif-4.woff2']];
  try {
    const parts = await Promise.all(files.map(async ([family, path]) => {
      const buf = new Uint8Array(await (await fetch(new URL(`../${path}`, import.meta.url))).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return `@font-face{font-family:'${family}';font-weight:100 900;src:url(data:font/woff2;base64,${btoa(bin)}) format('woff2')}`;
    }));
    fontCSS = parts.join('');
  } catch {
    fontCSS = ''; // system fonts then
  }
  return fontCSS;
}

/** Make sure the fonts are ready before text is measured. */
export async function fontsReady() {
  try { await Promise.all([document.fonts.load(`800 40px ${SANS}`), document.fonts.load(`600 40px "${SERIF}"`), document.fonts.load(`500 40px ${SANS}`)]); } catch { /* system fonts */ }
}

/** The banner as an SVG document. `fonts` is the @font-face CSS to embed ('' for none). */
export function bannerSVG({ size, template, palette, data }, fonts = '') {
  const s = typeof size === 'string' ? SIZE_BY_ID[size] : size;
  const p = typeof palette === 'string' ? PALETTE_BY_ID[palette] : palette;
  const draw = TEMPLATE_DRAW[template] || TEMPLATE_DRAW.bold;
  const d = Object.fromEntries(['tag', 'headline', 'subtitle', 'cta'].map((k) => [k, String(data?.[k] || '').trim().slice(0, k === 'subtitle' ? 220 : 120)]));
  const title = escapeXML(d.headline || 'Banner');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s.w}" height="${s.h}" viewBox="0 0 ${s.w} ${s.h}"><title>${title}</title>`
    + `${fonts ? `<style>${fonts}</style>` : ''}${draw(s, d, p)}</svg>`;
}

export function svgURL(svg) {
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
}

/** Draw the SVG into a canvas at its real size and return a PNG blob. */
export async function bannerPNG(svg, size) {
  const url = svgURL(svg);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    canvas.getContext('2d').drawImage(img, 0, 0, size.w, size.h);
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- text from the model

/** What to ask the local model: short text, as JSON, for this size. */
export function bannerPrompt(topic, size) {
  return [
    { role: 'system', content: 'You write short, catchy text for banners and thumbnails. You reply with JSON only, no other words.' },
    { role: 'user', content: `Write the text for a ${size.group} ${size.name.toLowerCase()} about: ${String(topic).trim().slice(0, 400)}\n\nUse the language of that description. Reply with only this JSON:\n{"tag": "label of 1 to 3 words", "headline": "at most 7 words", "subtitle": "at most 14 words", "cta": "button text of 2 to 4 words"}` },
  ];
}

/** Read the model's reply. Accepts JSON (even inside ``` or after thinking) or "key: value" lines. */
export function parseBannerText(reply) {
  const text = String(reply || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
  const out = {};
  const json = text.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const o = JSON.parse(json[0]);
      for (const k of ['tag', 'headline', 'subtitle', 'cta']) if (typeof o[k] === 'string') out[k] = o[k];
    } catch { /* try lines */ }
  }
  if (!out.headline) {
    for (const k of ['tag', 'headline', 'subtitle', 'cta']) {
      const m = new RegExp(`["']?${k}["']?\\s*[:=]\\s*["']?([^"'\\n}]+)`, 'i').exec(text);
      if (m) out[k] = m[1].trim().replace(/[",]+$/, '');
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/\s+/g, ' ').replace(/^["'*]+|["'*]+$/g, '').trim().slice(0, k === 'subtitle' ? 160 : 80);
  return out.headline ? out : null;
}
