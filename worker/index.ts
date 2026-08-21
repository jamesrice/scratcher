/**
 * Scratcher Worker — serves the static site (assets binding) and the Gemini
 * deep-rewrite endpoint. Mirrors imagology/worker/index.ts: the endpoint logic
 * lives in ./rewrite.ts; this file only routes to it. Everything that isn't
 * /api/* is served from the ./public directory by the ASSETS binding.
 */
import { onRequestPost } from './rewrite'

interface Env {
  GEMINI_API_KEY?: string
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/rewrite') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 })
      }
      return onRequestPost({ request, env })
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
