/**
 * Scratcher Worker — serves the static site (assets binding) and the Gemini
 * deep-rewrite endpoint. Mirrors imagology/worker/index.ts: the endpoint logic
 * lives in ./rewrite.ts; this file only routes to it. Everything that isn't
 * /api/* is served from the ./public directory by the ASSETS binding.
 */
import { onRequestPost } from './rewrite'
import { healthResponse } from './ft-ai-health.mjs'
import type { FtAiEnv } from './ft-ai.mjs'

interface Env extends FtAiEnv {
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // AI health for ft-tools/ai-audit.mjs: one tiny real call through FT_AI, cached 60 s.
    if (url.pathname === '/api/health') return healthResponse(request, env, ctx)

    if (url.pathname === '/api/rewrite') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 })
      }
      return onRequestPost({ request, env })
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
