/* ============================================================
   Scratcher — strips hidden Unicode watermarks from text and
   metadata (EXIF / XMP / IPTC / ICC / C2PA) from images.
   Everything runs in the browser. Nothing is uploaded.
   ============================================================ */
'use strict';

/* ------------------------------------------------------------
   Character inventory
   ------------------------------------------------------------ */
const CHAR_NAMES = {
  0x00A0: 'no-break space',
  0x00AD: 'soft hyphen',
  0x034F: 'combining grapheme joiner',
  0x061C: 'arabic letter mark',
  0x1680: 'ogham space mark',
  0x180E: 'mongolian vowel separator',
  0x2000: 'en quad', 0x2001: 'em quad', 0x2002: 'en space', 0x2003: 'em space',
  0x2004: 'three-per-em space', 0x2005: 'four-per-em space', 0x2006: 'six-per-em space',
  0x2007: 'figure space', 0x2008: 'punctuation space', 0x2009: 'thin space',
  0x200A: 'hair space',
  0x200B: 'zero width space',
  0x200C: 'zero width non-joiner',
  0x200D: 'zero width joiner',
  0x200E: 'left-to-right mark',
  0x200F: 'right-to-left mark',
  0x2010: 'hyphen', 0x2011: 'non-breaking hyphen', 0x2012: 'figure dash',
  0x2013: 'en dash', 0x2014: 'em dash', 0x2015: 'horizontal bar',
  0x2018: 'left single quote', 0x2019: 'right single quote',
  0x201A: 'single low quote', 0x201B: 'single reversed quote',
  0x201C: 'left double quote', 0x201D: 'right double quote',
  0x201E: 'double low quote', 0x201F: 'double reversed quote',
  0x2026: 'horizontal ellipsis',
  0x202A: 'left-to-right embedding', 0x202B: 'right-to-left embedding',
  0x202C: 'pop directional formatting', 0x202D: 'left-to-right override',
  0x202E: 'right-to-left override',
  0x202F: 'narrow no-break space',
  0x2032: 'prime', 0x2033: 'double prime',
  0x205F: 'medium mathematical space',
  0x2060: 'word joiner',
  0x2066: 'left-to-right isolate', 0x2067: 'right-to-left isolate',
  0x2068: 'first strong isolate', 0x2069: 'pop directional isolate',
  0x2212: 'minus sign',
  0x3000: 'ideographic space',
  0xFEFF: 'byte order mark / zero width no-break space',
};

const PUNCT_MAP = {
  0x2018: "'", 0x2019: "'", 0x201A: "'", 0x201B: "'",
  0x201C: '"', 0x201D: '"', 0x201E: '"', 0x201F: '"',
  0x2032: "'", 0x2033: '"',
  0x2010: '-', 0x2011: '-', 0x2012: '-', 0x2013: '-', 0x2014: '-', 0x2015: '-',
  0x2212: '-',
  0x2026: '...',
};

const PICTO = /\p{Extended_Pictographic}/u;
const KEYCAP_BASE = /[0-9#*©®™]/;

function charName(cp) {
  if (CHAR_NAMES[cp]) return CHAR_NAMES[cp];
  if (cp >= 0xFE00 && cp <= 0xFE0F) return 'variation selector ' + (cp - 0xFE00 + 1);
  if (cp >= 0xE0100 && cp <= 0xE01EF) return 'variation selector ' + (cp - 0xE0100 + 17);
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'tag character';
  if ((cp >= 0xFDD0 && cp <= 0xFDEF) || (cp & 0xFFFE) === 0xFFFE) return 'noncharacter';
  return 'format character';
}

function classify(cp) {
  // returns a category, or null if the code point is ordinary
  if (cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0x2060 ||
      cp === 0xFEFF || cp === 0x00AD || cp === 0x034F || cp === 0x180E) return 'invisible';
  if (cp === 0x200E || cp === 0x200F || cp === 0x061C ||
      (cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2066 && cp <= 0x2069)) return 'bidi';
  if ((cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF)) return 'invisible'; // variation selectors
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'invisible'; // tag characters
  if ((cp >= 0xFDD0 && cp <= 0xFDEF) || (cp & 0xFFFE) === 0xFFFE) return 'invisible'; // noncharacters
  if (cp === 0x00A0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200A) ||
      cp === 0x202F || cp === 0x205F || cp === 0x3000) return 'space';
  if (PUNCT_MAP[cp] !== undefined) return 'punct';
  return null;
}

/* Emoji-aware guards: some invisible characters are load-bearing
   inside emoji sequences and must survive the scrub. */
function keepForEmoji(cp, prevVisible, inTagRun) {
  if (cp === 0x200D) return PICTO.test(prevVisible);                       // ZWJ inside 👩‍👩‍👧
  if (cp === 0xFE0F) return PICTO.test(prevVisible) || KEYCAP_BASE.test(prevVisible); // emoji presentation
  if (cp >= 0xE0000 && cp <= 0xE007F) return inTagRun;                     // 🏴 flag tag sequences
  return false;
}

function cleanText(input, opts) {
  const findings = new Map(); // cp -> {count, category, action}
  let out = '';
  let previewHtml = ''; // "before": the original, hidden characters marked
  let afterHtml = '';   // "after": the clean text, removals/replacements highlighted
  let removed = 0;
  let prevVisible = '';
  let inTagRun = false;
  const previewCap = 30000;
  let previewLen = 0;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  for (const ch of input) {
    const cp = ch.codePointAt(0);
    let cat = classify(cp);

    if (cat === 'space' && !opts.spaces) cat = null;
    if (cat === 'punct' && !opts.punct) cat = null;

    if ((cat === 'invisible' || cat === 'bidi') && keepForEmoji(cp, prevVisible, inTagRun)) cat = null;

    // track 🏴-style tag runs so their tag characters survive
    if (cp === 0x1F3F4) inTagRun = true;
    else if (cp === 0xE007F) inTagRun = false;
    else if (!(cp >= 0xE0000 && cp <= 0xE007F)) inTagRun = false;

    if (cat === null) {
      out += ch;
      prevVisible = ch;
      if (previewLen < previewCap) {
        previewHtml += esc(ch);
        afterHtml += esc(ch);
        previewLen += ch.length;
      }
      continue;
    }

    let replacement = '';
    let action = 'removed';
    if (cat === 'space') { replacement = ' '; action = 'replaced with space'; }
    if (cat === 'punct') { replacement = PUNCT_MAP[cp]; action = 'replaced with "' + replacement + '"'; }

    out += replacement;
    removed++;
    const f = findings.get(cp) || { count: 0, category: cat, action };
    f.count++;
    findings.set(cp, f);

    if (previewLen < previewCap) {
      const label = cat === 'punct' ? esc(ch) : abbrev(cp);
      previewHtml += `<mark class="m-${cat}" title="U+${hex(cp)} ${charName(cp)}">${label}</mark>`;
      if (replacement) {
        afterHtml += `<mark class="af-chg" title="U+${hex(cp)} ${charName(cp)} — ${action}">${esc(replacement)}</mark>`;
      } else {
        afterHtml += `<mark class="af-del" title="U+${hex(cp)} ${charName(cp)} — removed here">${abbrev(cp)}</mark>`;
      }
      previewLen += ch.length;
    }
  }

  return { out, findings, removed, previewHtml, afterHtml, truncated: input.length > previewCap };
}

function hex(cp) { return cp.toString(16).toUpperCase().padStart(4, '0'); }

function abbrev(cp) {
  const short = {
    0x200B: 'ZWSP', 0x200C: 'ZWNJ', 0x200D: 'ZWJ', 0x2060: 'WJ', 0xFEFF: 'BOM',
    0x00AD: 'SHY', 0x00A0: 'NBSP', 0x202F: 'NNBSP', 0x3000: 'IDSP',
    0x200E: 'LRM', 0x200F: 'RLM', 0x061C: 'ALM',
  };
  if (short[cp]) return short[cp];
  if (cp >= 0xFE00 && cp <= 0xFE0F) return 'VS' + (cp - 0xFE00 + 1);
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'TAG';
  return 'U+' + hex(cp);
}

/* ------------------------------------------------------------
   Header counter (running total, stored locally)
   ------------------------------------------------------------ */
const counterEl = document.getElementById('scratchCount');
function bumpCounter(n) {
  if (!n) return;
  let total = 0;
  try { total = parseInt(localStorage.getItem('scratcher-total') || '0', 10) || 0; } catch (e) {}
  total += n;
  try { localStorage.setItem('scratcher-total', String(total)); } catch (e) {}
  counterEl.textContent = total.toLocaleString();
}
try { counterEl.textContent = (parseInt(localStorage.getItem('scratcher-total') || '0', 10) || 0).toLocaleString(); } catch (e) {}

/* ------------------------------------------------------------
   Text tab wiring
   ------------------------------------------------------------ */
const textInput = document.getElementById('textInput');
const optSpaces = document.getElementById('optSpaces');
const optPunct = document.getElementById('optPunct');
const scratchBtn = document.getElementById('scratchBtn');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const textResults = document.getElementById('textResults');

let lastClean = null;

scratchBtn.addEventListener('click', () => {
  const src = textInput.value;
  if (!src) { textResults.innerHTML = ''; return; }
  const res = cleanText(src, { spaces: optSpaces.checked, punct: optPunct.checked });
  lastClean = res.out;
  bumpCounter(res.removed);
  renderTextResults(res);
  copyBtn.disabled = downloadBtn.disabled = false;
});

copyBtn.addEventListener('click', async () => {
  if (lastClean === null) return;
  try {
    await navigator.clipboard.writeText(lastClean);
    copyBtn.querySelector('span').textContent = 'Copied';
    setTimeout(() => { copyBtn.querySelector('span').textContent = 'Copy clean text'; }, 1600);
  } catch (e) {
    // clipboard can be blocked in some contexts; fall back to select-in-place
    textInput.value = lastClean;
    textInput.select();
  }
});

downloadBtn.addEventListener('click', () => {
  if (lastClean === null) return;
  const blob = new Blob([lastClean], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, 'scratched.txt');
});

// Before/After compare block shared by the scratch preview and the deep
// rewrite. Preview only — the copy/download paths use the raw strings and are
// never touched by this markup.
function compareBlock(beforeHtml, afterHtml, legendHtml, note) {
  return `
    <div class="compare">
      <div class="compare-bar">
        <div class="segmented segmented--sm" role="radiogroup" aria-label="Compare view">
          <button class="seg" type="button" role="radio" data-view="before" aria-checked="false">Before</button>
          <button class="seg" type="button" role="radio" data-view="after" aria-checked="true">After</button>
        </div>
        <span class="legend">${legendHtml}</span>
        <span class="legend-note micro">${note || 'Preview only — downloads are untouched'}</span>
      </div>
      <div class="preview card" data-pane="before" hidden>${beforeHtml}</div>
      <div class="preview card" data-pane="after">${afterHtml}</div>
    </div>`;
}

function wireCompare(root) {
  const compare = root.querySelector('.compare');
  if (!compare) return;
  compare.querySelectorAll('.seg[data-view]').forEach((seg) => seg.addEventListener('click', () => {
    compare.querySelectorAll('.seg[data-view]').forEach((s) => s.setAttribute('aria-checked', s === seg ? 'true' : 'false'));
    compare.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== seg.dataset.view; });
  }));
}

function renderTextResults(res) {
  if (res.removed === 0) {
    textResults.innerHTML = `<p class="result-stat clean"><span class="num">0</span> hidden characters — already clean.</p>`;
    return;
  }
  const rows = [...res.findings.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([cp, f]) => `
      <div class="finding card">
        <span class="cp">U+${hex(cp)}</span>
        <span class="name">${charName(cp)}</span>
        <span class="badge badge--${f.category}">${f.category === 'punct' ? 'normalized' : f.category === 'space' ? 'space' : f.category}</span>
        <span class="count">×${f.count} · ${f.action}</span>
      </div>`).join('');
  const legend = `<span class="lg lg-del">removed</span><span class="lg lg-chg">replaced</span>`;
  const note = `Preview only — downloads are untouched${res.truncated ? ' · first 30,000 characters shown' : ''}`;
  textResults.innerHTML = `
    <p class="result-stat"><span class="num">${res.removed.toLocaleString()}</span> hidden ${res.removed === 1 ? 'character' : 'characters'} scratched off. Clean copy is ready.</p>
    <div class="findings">${rows}</div>
    ${compareBlock(res.previewHtml, res.afterHtml, legend, note)}`;
  wireCompare(textResults);
}

/* ------------------------------------------------------------
   Image cleaning — JPEG & PNG are rebuilt byte-for-byte
   (lossless); other formats are re-encoded through a canvas.
   ------------------------------------------------------------ */
const CAT_BADGE = {
  exif: 'exif', xmp: 'xmp', icc: 'icc', c2pa: 'c2pa',
  iptc: 'other', comment: 'other', text: 'other', time: 'other', other: 'other',
};

function ascii(bytes, start, len) {
  let s = '';
  for (let i = start; i < Math.min(start + len, bytes.length); i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

/* ---- JPEG ---- */
function identifyApp(marker, bytes, off, len) {
  const head = ascii(bytes, off, Math.min(len, 40));
  if (marker === 0xE1) {
    if (head.startsWith('Exif\0')) return { name: 'EXIF metadata', cat: 'exif' };
    if (head.startsWith('http://ns.adobe.com/xap/1.0/')) return { name: 'XMP metadata', cat: 'xmp' };
    if (head.includes('/xmp/extension/')) return { name: 'XMP extension', cat: 'xmp' };
    return { name: 'APP1 segment', cat: 'other' };
  }
  if (marker === 0xE2) {
    if (head.startsWith('ICC_PROFILE')) return { name: 'ICC color profile', cat: 'icc' };
    if (head.startsWith('MPF')) return { name: 'multi-picture metadata', cat: 'other' };
    return { name: 'APP2 segment', cat: 'other' };
  }
  if (marker === 0xEB) {
    const wide = ascii(bytes, off, Math.min(len, 64)).toLowerCase();
    if (wide.includes('jumb') || wide.includes('c2pa') || wide.includes('jp')) {
      return { name: 'C2PA Content Credentials (JUMBF)', cat: 'c2pa' };
    }
    return { name: 'APP11 segment', cat: 'other' };
  }
  if (marker === 0xED && head.startsWith('Photoshop 3.0')) return { name: 'IPTC / Photoshop metadata', cat: 'iptc' };
  if (marker === 0xFE) return { name: 'JPEG comment', cat: 'comment' };
  return { name: 'APP' + (marker - 0xE0) + ' segment', cat: 'other' };
}

function exifOrientation(bytes, off, len) {
  // bytes at off: "Exif\0\0" then TIFF header
  try {
    const t = off + 6;
    const little = ascii(bytes, t, 2) === 'II';
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const ifdOff = view.getUint32(t + 4, little);
    const entries = view.getUint16(t + ifdOff, little);
    for (let i = 0; i < entries; i++) {
      const e = t + ifdOff + 2 + i * 12;
      if (e + 12 > off + len) break;
      if (view.getUint16(e, little) === 0x0112) return view.getUint16(e + 8, little);
    }
  } catch (e) {}
  return 1;
}

function cleanJpeg(bytes) {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  const removedParts = [];
  const kept = [[0, 2]]; // SOI
  let i = 2;
  let orientation = 1;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xFF) break;
    const marker = bytes[i + 1];
    if (marker === 0xDA) { kept.push([i, bytes.length]); break; } // SOS → copy the rest verbatim
    if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const segEnd = i + 2 + len;
    if (segEnd > bytes.length) break;
    const isApp = marker >= 0xE0 && marker <= 0xEF;
    const strip = (isApp && marker !== 0xE0 && marker !== 0xEE) || marker === 0xFE; // keep JFIF + Adobe APP14
    if (strip) {
      const id = identifyApp(marker, bytes, i + 4, len - 2);
      if (id.cat === 'exif') orientation = exifOrientation(bytes, i + 4, len - 2);
      removedParts.push({ ...id, size: len + 2 });
    } else {
      kept.push([i, segEnd]);
    }
    i = segEnd;
  }
  const total = kept.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const [a, b] of kept) { out.set(bytes.subarray(a, b), p); p += b - a; }
  return { out, removedParts, orientation, mime: 'image/jpeg' };
}

/* ---- PNG ---- */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'gAMA', 'cHRM', 'sBIT', 'sRGB',
  'bKGD', 'hIST', 'pHYs', 'IDAT', 'IEND', 'acTL', 'fcTL', 'fdAT']);

function pngChunkInfo(type, bytes, off, len) {
  if (type === 'eXIf') return { name: 'EXIF metadata', cat: 'exif' };
  if (type === 'iCCP') return { name: 'ICC color profile', cat: 'icc' };
  if (type === 'tIME') return { name: 'modification timestamp', cat: 'time' };
  if (type === 'caBX') return { name: 'C2PA Content Credentials', cat: 'c2pa' };
  if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
    let kw = '';
    for (let i = off; i < off + Math.min(len, 79); i++) {
      if (bytes[i] === 0) break;
      kw += String.fromCharCode(bytes[i]);
    }
    if (kw === 'XML:com.adobe.xmp') return { name: 'XMP metadata', cat: 'xmp' };
    return { name: `text metadata "${kw || type}"`, cat: 'text' };
  }
  return { name: `"${type}" chunk`, cat: 'other' };
}

function cleanPng(bytes) {
  const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let k = 0; k < 8; k++) if (bytes[k] !== SIG[k]) return null;
  const removedParts = [];
  const kept = [[0, 8]];
  let i = 8;
  while (i + 12 <= bytes.length) {
    const len = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = ascii(bytes, i + 4, 4);
    const chunkEnd = i + 12 + len;
    if (len < 0 || chunkEnd > bytes.length) break;
    if (PNG_KEEP.has(type)) {
      kept.push([i, chunkEnd]);
    } else {
      const info = pngChunkInfo(type, bytes, i + 8, len);
      removedParts.push({ ...info, size: len + 12 });
    }
    i = chunkEnd;
    if (type === 'IEND') break;
  }
  const total = kept.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const [a, b] of kept) { out.set(bytes.subarray(a, b), p); p += b - a; }
  return { out, removedParts, orientation: 1, mime: 'image/png' };
}

/* ---- generic re-encode fallback ---- */
async function reencode(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  const wantsJpeg = file.type === 'image/jpeg';
  const type = wantsJpeg ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((res) => canvas.toBlob(res, type, wantsJpeg ? 0.92 : undefined));
  return { blob, type };
}

async function processFile(file) {
  const card = document.createElement('div');
  card.className = 'file-card card';
  card.innerHTML = `<div class="top"><span class="fname">${escapeHtml(file.name)}</span><span class="fsize">${fmtSize(file.size)}</span></div><p class="note">Scratching…</p>`;
  document.getElementById('fileCards').prepend(card);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let result = cleanJpeg(bytes) || cleanPng(bytes);
    let note = '';

    if (result && result.orientation !== 1) {
      // EXIF carried a rotation flag; re-encode so the pixels stay upright without it
      const { blob, type } = await reencode(file);
      renderFileCard(card, file, blob, result.removedParts,
        'Rotation flag detected in EXIF — the image was re-encoded so it stays upright without metadata.', type);
      return;
    }

    if (result) {
      const blob = new Blob([result.out], { type: result.mime });
      renderFileCard(card, file, blob, result.removedParts,
        result.removedParts.length ? 'Rebuilt byte-for-byte — image data untouched, zero recompression.' : '', result.mime);
      return;
    }

    // not JPEG/PNG → re-encode through canvas, which drops everything
    const { blob, type } = await reencode(file);
    renderFileCard(card, file, blob,
      [{ name: 'all embedded metadata', cat: 'other', size: Math.max(0, file.size - blob.size) }],
      'This format is re-encoded through a canvas — every embedded field is dropped in the process.', type);
  } catch (err) {
    card.innerHTML = `<div class="top"><span class="fname">${escapeHtml(file.name)}</span></div>
      <p class="note">Couldn’t read this file as an image. Nothing was changed.</p>`;
  }
}

function renderFileCard(card, file, blob, removedParts, note, mime) {
  bumpCounter(removedParts.length);
  const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'img';
  const base = file.name.replace(/\.[^.]+$/, '');
  const outName = `${base}.clean.${ext}`;
  const list = removedParts.length
    ? `<ul>${removedParts.map((r) => `<li><span class="badge badge--${CAT_BADGE[r.cat] || 'other'}">${r.cat}</span> ${escapeHtml(r.name)} <span class="fsize">— ${fmtSize(r.size)}</span></li>`).join('')}</ul>`
    : `<p class="clean-line">Already clean — no embedded metadata found.</p>`;
  card.innerHTML = `
    <div class="top">
      <span class="fname">${escapeHtml(file.name)}</span>
      <span class="fsize">${fmtSize(file.size)} → ${fmtSize(blob.size)}</span>
      <button class="btn btn--sm btn--purple" type="button">Download clean copy</button>
    </div>
    ${list}
    ${note ? `<p class="note">${note}</p>` : ''}`;
  card.querySelector('button').addEventListener('click', () => triggerDownload(blob, outName));
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------
   Dropzone wiring
   ------------------------------------------------------------ */
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { [...fileInput.files].forEach(processFile); fileInput.value = ''; });

['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzone.classList.add('is-over');
}));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzone.classList.remove('is-over');
}));
dropzone.addEventListener('drop', (e) => {
  [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(f.name)).forEach(processFile);
});

/* ------------------------------------------------------------
   Deep rewrite (Layer B) — POSTs the scrubbed text to the Worker,
   which runs a Gemini paraphrase pass to disturb word-choice
   watermarks. Falls back gracefully when the API isn't reachable
   (e.g. opening index.html straight off disk with no Worker).
   ------------------------------------------------------------ */
const rewriteBtn = document.getElementById('rewriteBtn');
const rewriteResults = document.getElementById('rewriteResults');
const segButtons = document.querySelectorAll('.seg');
let strength = 'balanced';

segButtons.forEach((seg) => seg.addEventListener('click', () => {
  segButtons.forEach((s) => s.setAttribute('aria-checked', s === seg ? 'true' : 'false'));
  strength = seg.dataset.strength;
}));

// prefer the just-scratched text; fall back to whatever is in the textarea
function textForRewrite() {
  if (lastClean !== null && lastClean.trim()) return lastClean;
  return textInput.value;
}

// crude word-difference estimate so the result can say how much moved
function wordChangePct(before, after) {
  const norm = (s) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  const a = norm(before), b = new Set(norm(after));
  if (!a.length) return 0;
  let kept = 0;
  for (const w of a) if (b.has(w)) kept++;
  return Math.round((1 - kept / a.length) * 100);
}

rewriteBtn.addEventListener('click', async () => {
  const src = textForRewrite();
  if (!src.trim()) {
    rewriteResults.innerHTML = `<div class="rewrite-error card">Add some text above (and scratch it) before running the deep rewrite.</div>`;
    return;
  }

  const original = rewriteBtn.innerHTML;
  rewriteBtn.disabled = true;
  rewriteBtn.innerHTML = `<span class="spinner"></span> Rewriting…`;
  rewriteResults.innerHTML = '';

  try {
    const res = await fetch('/api/rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: src, strength }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error) {
      rewriteResults.innerHTML = `<div class="rewrite-error card">${escapeHtml(data.error || 'The rewrite engine could not rewrite this just now.')}</div>`;
      return;
    }
    renderRewrite(src, data.text || '');
  } catch (e) {
    // network/API unreachable — most likely running without the Worker
    rewriteResults.innerHTML = `<div class="rewrite-error card">Couldn’t reach the rewrite engine. The deep rewrite runs on the server, so it needs the deployed site (scratcher.fictiontribe.com) or a local <code>wrangler dev</code> — the local Unicode scrub above works anywhere.</div>`;
  } finally {
    rewriteBtn.disabled = false;
    rewriteBtn.innerHTML = original;
  }
});

/* Word-level diff (LCS over word tokens, whitespace-tolerant) so the compare
   view can highlight what the rewrite removed, added, or changed. Returns null
   above the size cap — the panes then render un-highlighted. */
function diffTokens(a, b) {
  const isWS = (t) => /^\s+$/.test(t);
  const ta = a.split(/(\s+)/).filter(Boolean);
  const tb = b.split(/(\s+)/).filter(Boolean);
  const n = ta.length, m = tb.length;
  if (n * m > 4000000) return null;
  const eq = (x, y) => x === y || (isWS(x) && isWS(y));
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = eq(ta[i], tb[j])
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  const push = (op, a2, b2) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) { last.a += a2; last.b += b2; }
    else ops.push({ op, a: a2, b: b2 });
  };
  while (i < n && j < m) {
    if (eq(ta[i], tb[j])) { push('same', ta[i], tb[j]); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { push('del', ta[i], ''); i++; }
    else { push('ins', '', tb[j]); j++; }
  }
  while (i < n) { push('del', ta[i], ''); i++; }
  while (j < m) { push('ins', '', tb[j]); j++; }

  // a deletion next to an insertion (allowing one whitespace run between) is a
  // "changed" pair, not a remove + an add
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].op !== 'del') continue;
    let next = ops[k + 1];
    if (next && next.op === 'same' && isWS(next.a)) next = ops[k + 2];
    if (next && next.op === 'ins') { ops[k].changed = true; next.changed = true; }
  }
  return ops;
}

function diffPanes(before, after) {
  const ops = diffTokens(before, after);
  if (!ops) return { beforeHtml: escapeHtml(before), afterHtml: escapeHtml(after), highlighted: false };
  let beforeHtml = '', afterHtml = '';
  for (const r of ops) {
    if (r.op === 'same') { beforeHtml += escapeHtml(r.a); afterHtml += escapeHtml(r.b); }
    else if (r.op === 'del') beforeHtml += `<mark class="${r.changed ? 'df df-chg' : 'df df-del'}">${escapeHtml(r.a)}</mark>`;
    else afterHtml += `<mark class="${r.changed ? 'df df-chg' : 'df df-add'}">${escapeHtml(r.b)}</mark>`;
  }
  return { beforeHtml, afterHtml, highlighted: true };
}

function renderRewrite(before, after) {
  const pct = wordChangePct(before, after);
  const { beforeHtml, afterHtml, highlighted } = diffPanes(before, after);
  const legend = highlighted
    ? `<span class="lg lg-del">removed</span><span class="lg lg-chg">changed</span><span class="lg lg-add">added</span>`
    : '';
  rewriteResults.innerHTML = `
    <div class="rewrite-out card">
      <div class="rewrite-head">
        <span class="stat"><span class="num">~${pct}%</span> of the wording changed · meaning preserved</span>
        <button class="btn btn--sm btn--purple" id="rwCopy" type="button">Copy rewrite</button>
        <button class="btn btn--sm" id="rwDownload" type="button">Download .txt</button>
      </div>
      ${compareBlock(beforeHtml, afterHtml, legend, 'Preview only — copy &amp; download get the clean rewrite')}
    </div>`;
  wireCompare(rewriteResults);
  rewriteResults.querySelector('#rwCopy').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(after);
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy rewrite'; }, 1600);
    } catch (_) {}
  });
  rewriteResults.querySelector('#rwDownload').addEventListener('click', () => {
    triggerDownload(new Blob([after], { type: 'text/plain;charset=utf-8' }), 'scratched-rewrite.txt');
  });
}

/* ------------------------------------------------------------
   Tabs
   ------------------------------------------------------------ */
const tabs = document.querySelectorAll('.tab');
tabs.forEach((tab) => tab.addEventListener('click', () => {
  tabs.forEach((t) => t.setAttribute('aria-selected', t === tab ? 'true' : 'false'));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== tab.dataset.panel; });
}));
