# Scratcher

**Scratch the watermark off.** Hidden AI fingerprints out of your text and images.

A Fiction Tribe tool, in the same family as [Imagology](https://imagology.fictiontribe.com) and [Shot Vault](https://shotvault.fictiontribe.com).

## What it does

Two layers, mirroring how AI watermarks actually work.

### Layer A — the removable carriers (runs in your browser)

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

### Layer B — the deep rewrite (runs on the server, opt-in)

The deepest AI text watermarks live in **which words** the model picked — statistical / token-sampling schemes like SynthID-Text and Kirchenbauer-style green-list marks. There's no character to delete; the only way to disturb them is to replace enough of those word choices.

The **Deep rewrite** button sends the (already-scrubbed) text to a Cloudflare Worker that runs a **Gemini Flash** paraphrase pass — re-expressing the text in different words while preserving meaning, tone, structure, and length, at a Light / Balanced / Thorough strength. This resamples the token stream and disturbs the statistical signal.

**The honest fine print:** no tool — text or image — can promise every detector passes or fails. Scratcher removes everything that's actually removable and is honest about the rest.

## Privacy

Layer A is 100% client-side — no uploads, no analytics. The "Scratched" counter lives in your own `localStorage`. Layer B is opt-in and only fires when you click **Deep rewrite**: that text is sent to the Worker, which calls the Gemini API. Text is not stored or logged (only error statuses are logged for debugging).

## Architecture

Same pipeline as [imagology](https://github.com/jamesrice/imagology): a static site served by a Cloudflare Worker, with an `/api/*` endpoint on the Worker for the Gemini call.

```
public/           static site (served by the Worker's ASSETS binding)
  index.html      the page
  styles.css      Fiction Tribe brand system (beige #FEF7ED, ink #131313, purple #4C00FF, Gilroy + Space Mono)
  app.js          Layer A engines (Unicode cleaner, JPEG segment parser, PNG chunk parser) + Layer B client
  fonts/          Gilroy woff2 (licensed to Fiction Tribe)
worker/
  index.ts        routes /api/rewrite to the handler; everything else → ASSETS
  rewrite.ts      the Gemini deep-rewrite endpoint
wrangler.jsonc    Worker config + scratcher.fictiontribe.com custom domain
```

`run_worker_first: ["/api/*"]` keeps `/api/*` on the Worker; every other path is served from `public/`.

## Develop

```sh
npm install
npm run dev        # wrangler dev — serves public/ and /api/rewrite locally
```

To exercise the deep-rewrite pass locally you need a Gemini key:

```sh
echo 'GEMINI_API_KEY = "your-key"' > .dev.vars   # gitignored
npm run dev
```

Layer A (the Unicode/metadata scrub) works with no key and no server — opening `public/index.html` directly is enough; only the Deep rewrite button needs the Worker.

## Deploy (Cloudflare)

```sh
wrangler secret put GEMINI_API_KEY   # once per environment
npm run deploy                        # wrangler deploy
```

The custom domain `scratcher.fictiontribe.com` is declared in `wrangler.jsonc`. As with imagology, if an old same-named Cloudflare **Pages** project already claims that hostname, delete it in the dashboard first or the route step of `wrangler deploy` will fail.
