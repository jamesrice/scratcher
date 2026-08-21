# Scratcher

**Scratch the watermark off.** Hidden AI fingerprints out of your text and images — all in your browser.

A Fiction Tribe tool, in the same family as [Imagology](https://imagology.fictiontribe.com) and [Shot Vault](https://shotvault.fictiontribe.com).

## What it does

**Text** — paste anything and Scratcher scans every character for invisible Unicode watermarks:

- Zero-width spaces, joiners, word joiners, BOMs, soft hyphens
- Bidirectional control characters
- Variation selectors and tag characters (emoji sequences are preserved)
- Noncharacters
- Unusual spaces (NBSP, thin space, ideographic space, …) → normalized to a plain space
- Optional: smart punctuation (curly quotes, em dashes, ellipses) → plain ASCII

You get a per-character report (code point, name, count) and a highlighted preview showing exactly where each one was hiding.

**Images** — drop JPEG or PNG files and Scratcher strips metadata **losslessly**, rebuilding the file byte-for-byte with zero recompression:

- EXIF (camera, GPS, timestamps — if a rotation flag is present the image is re-encoded so it stays upright)
- XMP and XMP extensions
- IPTC / Photoshop records
- ICC color profiles
- C2PA Content Credentials (JUMBF / `caBX`)
- JPEG comments and PNG text chunks

Other image formats (WebP, GIF, AVIF, …) are re-encoded through a canvas, which drops everything.

**The honest fine print:** statistical AI text watermarks live in word choice itself — there is no byte to delete. Scratcher removes everything that's actually removable and tells you exactly what it did.

## Privacy

100% client-side. No uploads, no analytics, no network calls beyond loading the page. The "Scratched" counter lives in your own `localStorage`.

## Running it

It's a static site — no build step.

```sh
python3 -m http.server 8080
# → http://localhost:8080
```

Deploy anywhere that serves static files (Cloudflare Pages, GitHub Pages, …).

## Stack

- `index.html` — the page
- `styles.css` — Fiction Tribe brand system (beige `#FEF7ED`, ink `#131313`, purple `#4C00FF`, Gilroy + Space Mono)
- `app.js` — the scanning/stripping engines: Unicode cleaner, JPEG segment parser, PNG chunk parser
- `fonts/` — Gilroy woff2 (licensed to Fiction Tribe)
