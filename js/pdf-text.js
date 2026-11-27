/**
 * Read the text inside a PDF, in the browser. Nothing is uploaded.
 * pdf.js (vendor/pdfjs, Apache-2.0) is loaded only the first time a PDF is added,
 * so people who never attach one never download it.
 */

export const MAX_PDF_PAGES = 200;      // read at most this many pages
export const MAX_PDF_CHARS = 200_000;  // and keep at most this much text

let lib = null;
async function pdfjs() {
  if (!lib) {
    lib = import('../vendor/pdfjs/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return m;
    });
    lib.catch(() => { lib = null; }); // try again next time if it failed to load
  }
  return lib;
}

/** Join one page's text items into lines, keeping the reading order pdf.js gives. */
function pageText(items) {
  let out = '';
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    out += it.str;
    if (it.hasEOL) out += '\n';
    else if (it.str && !/\s$/.test(it.str)) out += ' ';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Text of a PDF given as bytes (ArrayBuffer or Uint8Array).
 * Returns { text, pages, read, cut }: `pages` is the page count, `read` how many were read,
 * `cut` whether pages or text were left out. A scanned PDF (only pictures) gives text ''.
 * Throws an Error with a friendly message for a broken or password-protected file.
 */
export async function pdfText(bytes, { maxPages = MAX_PDF_PAGES, maxChars = MAX_PDF_CHARS } = {}) {
  const m = await pdfjs();
  const task = m.getDocument({
    data: new Uint8Array(bytes).slice(), // a copy: pdf.js hands its buffer to the worker
    cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    task.destroy();
    if (e?.name === 'PasswordException') throw new Error('This PDF is locked with a password');
    throw new Error('This PDF could not be read; it may be broken');
  }
  try {
    const pages = doc.numPages;
    const read = Math.min(pages, maxPages);
    const parts = [];
    let size = 0;
    let n = 0;
    for (; n < read && size < maxChars; n++) {
      const page = await doc.getPage(n + 1);
      const t = pageText((await page.getTextContent()).items);
      page.cleanup();
      if (t) { const part = read > 1 ? `[Page ${n + 1}]\n${t}` : t; parts.push(part); size += part.length + 2; }
    }
    let text = parts.join('\n\n');
    const cut = n < pages || text.length > maxChars;
    if (text.length > maxChars) text = text.slice(0, maxChars);
    return { text, pages, read: n, cut };
  } finally {
    task.destroy(); // frees the document and its worker side
  }
}
