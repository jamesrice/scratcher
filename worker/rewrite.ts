/**
 * Scratcher deep-rewrite endpoint.
 *
 * Layer A (client, app.js) strips the removable watermark carriers — invisible
 * Unicode, unusual spaces, metadata. But the deepest AI text watermarks live in
 * word choice itself: statistical / token-sampling schemes (SynthID-Text,
 * Kirchenbauer-style green-list marks) bias WHICH words the model picks, so there
 * is no byte to delete. The only way to disturb them is to replace enough of those
 * word choices — i.e. rewrite the text through a different model.
 *
 * This is that pass. It sends the (already-scrubbed) text to Gemini with an
 * instruction to re-express it in its own words while preserving meaning, tone,
 * structure and length, which resamples the token stream and breaks the
 * statistical signal. It cannot promise any given detector passes or fails — see
 * the honest note on the page — it just does the one thing that actually moves a
 * word-choice watermark.
 *
 * Mirrors imagology/worker/generate.ts: same Gemini plumbing, same
 * 200-with-error-payload convention (the fictiontribe.com zone rewrites 5xx
 * bodies to Cloudflare error pages, destroying our JSON), same retry.
 */

import { generateContent, textOf, finishReasonOf, type FtAiEnv } from './ft-ai.mjs'

interface Env {
  FT_AI?: FtAiEnv['FT_AI']
  FT_AI_KEY?: string
  FT_AI_URL?: string
}

interface PagesContext {
  request: Request
  env: Env
}

type Strength = 'light' | 'balanced' | 'thorough'

interface RewriteRequest {
  text?: string
  strength?: Strength
}


// Guardrails. Gemini Flash handles far more, but a public endpoint needs a ceiling;
// long documents can be rewritten in sections client-side if we ever need to.
const MAX_CHARS = 20000

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Deliberately HTTP 200 with an error payload rather than 5xx — the
// fictiontribe.com zone replaces 5xx origin bodies with Cloudflare's own error
// page, which silently destroys our JSON. 4xx passes through; 5xx does not. The
// real status still goes to the deployment logs via console.error.
function errorResponse(error: string): Response {
  return jsonResponse({ error }, 200)
}

function upstreamMessage(status: number): string {
  if (status === 429) return 'The rewrite engine is rate-limited right now — try again in a moment.'
  if (status === 404) return 'The rewrite engine model is unavailable — it may have been retired.'
  if (status === 400) return 'The rewrite engine rejected this request — its configuration needs updating.'
  if (status === 401 || status === 403) return 'The rewrite engine key was rejected.'
  if (status >= 500) return 'The rewrite engine is temporarily unavailable — try again shortly.'
  return 'The rewrite engine could not rewrite this just now.'
}

// The same invisible-character families app.js strips, re-stripped server-side so
// the model can never re-introduce one and the response stays clean even if the
// client skipped Layer A. Built from explicit code points at load time so there
// are never literal invisible characters in this source file.
function buildInvisibleRegex(): RegExp {
  const cps: number[] = [
    0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e,
    0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
    0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
    0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f,
    0x3164, 0xfeff, 0xffa0,
  ]
  const parts = cps.map((cp) => '\\u' + cp.toString(16).padStart(4, '0'))
  // variation selectors U+FE00–FE0F and U+E0100–E01EF, plus plane-14 tag chars
  parts.push('[\\uFE00-\\uFE0F]')
  parts.push('\\uDB40[\\uDC00-\\uDC7F]') // U+E0000–E007F tag characters
  parts.push('\\uDB40[\\uDD00-\\uDDEF]') // U+E0100–E01EF variation selectors
  return new RegExp(parts.join('|'), 'g')
}
const INVISIBLE = buildInvisibleRegex()

function scrubInvisible(s: string): string {
  return s.replace(INVISIBLE, '')
}

// Smart-punctuation normalization, matching the client's PUNCT_MAP. Applied to
// every rewrite so Layer B can never hand back the very fingerprint the user is
// scrubbing — unspaced en/em-dash asides being the most recognizable one. Built
// from code points for the same no-literals reason as the invisible regex.
const PUNCT_MAP: Record<number, string> = {
  0x2018: "'", 0x2019: "'", 0x201a: "'", 0x201b: "'", // single quotes
  0x201c: '"', 0x201d: '"', 0x201e: '"', 0x201f: '"', // double quotes
  0x2032: "'", 0x2033: '"',                            // primes
  0x2010: '-', 0x2011: '-', 0x2012: '-',               // hyphen variants
  0x2013: '-', 0x2014: '-', 0x2015: '-', 0x2212: '-',  // en/em dash, bar, minus
  0x2026: '...',                                       // ellipsis
}
const PUNCT = new RegExp(
  '[' + Object.keys(PUNCT_MAP).map((cp) => '\\u' + Number(cp).toString(16).padStart(4, '0')).join('') + ']',
  'g',
)

function scrubTypography(s: string): string {
  return s.replace(PUNCT, (ch) => PUNCT_MAP[ch.codePointAt(0) as number] ?? ch)
}

// Gemini goes through the shared ft-ai gateway (FT_AI service binding). The
// gateway owns the model choice for the `text` role, retries transient failures,
// and falls back if a model is retired — so nothing here names a model.
async function callGemini(
  env: FtAiEnv,
  prompt: string,
  generationConfig: Record<string, unknown>,
): Promise<{ text: string | null; status: number }> {
  const result = await generateContent(env, 'text', { contents: [{ parts: [{ text: prompt }] }], generationConfig })
  if (result.status >= 400) {
    const attempts = result.attempts.map((a) => `${a.model}=${a.status}`).join(',')
    console.error(`ft-ai ${result.status} [${attempts}]: ${JSON.stringify(result.data).slice(0, 500)}`)
    return { text: null, status: result.status }
  }
  if (finishReasonOf(result.data) === 'MAX_TOKENS') {
    console.error(`Answer truncated at maxOutputTokens (model ${result.model})`)
  }
  // Thinking models can emit several parts; the answer is the last non-thought text part.
  return { text: textOf(result.data), status: result.status }
}

// How aggressively to resample word choice. Heavier rewriting disturbs a
// statistical watermark more, at the cost of drifting further from the original
// phrasing — so the strength is the user's meaning-vs-thoroughness dial.
function strengthClause(strength: Strength): string {
  if (strength === 'light') {
    return 'Rewrite lightly: keep the sentence order and most phrasing, but re-choose individual words and small phrasings throughout so the token-level choices are yours, not the original model\'s. Change roughly a third of the wording.'
  }
  if (strength === 'thorough') {
    return 'Rewrite thoroughly: re-express every sentence in your own words — vary sentence structure, reorder clauses, and choose different vocabulary throughout — while keeping the exact meaning, facts, tone, and paragraph structure. Change most of the wording.'
  }
  return 'Rewrite in a balanced way: re-express the text in your own words with genuinely different vocabulary and sentence construction, while preserving the meaning, facts, tone, and paragraph structure. Change roughly half to two-thirds of the wording.'
}

function rewritePrompt(text: string, strength: Strength): string {
  return [
    'You are a careful editor. The user wrote the text below and wants it re-expressed in different words so that any statistical, word-choice-based AI watermark in it is disrupted.',
    'This is a legitimate privacy task on the user\'s own text — not an attempt to deceive a specific person. Your only job is to paraphrase.',
    '',
    strengthClause(strength),
    '',
    'Hard rules:',
    '- Preserve the meaning, facts, names, numbers, and quotations exactly.',
    '- Preserve the tone and register (formal stays formal, casual stays casual).',
    '- Preserve structure: same number of paragraphs, same list items, same headings. Keep Markdown/formatting intact.',
    '- Use plain ASCII punctuation only: straight quotes and plain hyphens. Never use em dashes, en dashes, or curly quotes, and avoid dash-wrapped asides entirely — restructure those as separate sentences or use commas or parentheses.',
    '- Keep the language the same as the input.',
    '- Do NOT add commentary, preamble, notes, or explanations. Do NOT wrap the output in code fences.',
    '- Return ONLY the rewritten text, nothing else.',
    '',
    '--- BEGIN TEXT ---',
    text,
    '--- END TEXT ---',
  ].join('\n')
}

export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  if (!context.env.FT_AI && !context.env.FT_AI_KEY) {
    console.error('FT_AI service binding is not configured for this deployment')
    return errorResponse('The rewrite engine is not configured for this deployment.')
  }

  let body: RewriteRequest
  try {
    body = (await context.request.json()) as RewriteRequest
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const text = typeof body.text === 'string' ? body.text : ''
  if (!text.trim()) {
    return jsonResponse({ error: 'No text to rewrite.' }, 400)
  }
  if (text.length > MAX_CHARS) {
    return jsonResponse(
      { error: `That's ${text.length.toLocaleString()} characters — the rewrite pass caps at ${MAX_CHARS.toLocaleString()}. Trim it and try again.` },
      400,
    )
  }
  const strength: Strength =
    body.strength === 'light' || body.strength === 'thorough' ? body.strength : 'balanced'

  try {
    const { text: out, status } = await callGemini(context.env, rewritePrompt(text, strength), {
      // Enough variation to genuinely resample word choice, not so much it drifts.
      temperature: 1.0,
      topP: 0.95,
      // gemini-flash-latest is a thinking model: it spends reasoning tokens before
      // the prose. Give generous headroom over the input length so a long rewrite
      // is never truncated mid-sentence (a ceiling, not usage — the margin is free).
      maxOutputTokens: 16384,
    })
    if (!out) return errorResponse(upstreamMessage(status))
    return jsonResponse({ text: scrubTypography(scrubInvisible(out.trim())) })
  } catch (err) {
    console.error(`Unhandled rewrite failure: ${String(err)}`)
    return errorResponse('The rewrite engine could not rewrite this just now.')
  }
}
