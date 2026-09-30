// ============================================================================
// capture-youtube — paste a YouTube link, save what the video actually says.
// ============================================================================
// WHY THIS FILE IS COMPLICATED — worth understanding:
//
// YouTube serves a stripped-down page with no captions when the request comes
// from a datacentre, which is exactly what a Supabase edge function is. Code
// that works perfectly on your laptop fails once deployed. That is not a bug
// in your code; it is YouTube treating servers differently from people.
//
// So we try several routes and take the first that works:
//
//   1. SUPADATA    — a service built for this. Fetches from home internet
//                    connections, so it gets real transcripts. Needs the
//                    SUPADATA_API_KEY secret; skipped if it's missing.
//   2. INNERTUBE   — YouTube's own internal app API. We identify as the
//                    iPhone and Android apps, which YouTube often serves
//                    properly even from a datacentre. Free, no key.
//   3. DESCRIPTION — if no captions exist anywhere, save the title and
//                    description so you still capture something. Clearly
//                    labelled, so you know it's not the real transcript.
//
// For now we save the text as-is. Summarising arrives with Level 5.
// ============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPADATA_KEY = Deno.env.get('SUPADATA_API_KEY') ?? ''   // optional

const MAX_CONTENT = 20_000   // how much text goes on the thought itself

interface VideoContent {
  content: string
  hasTranscript: boolean
  source: 'supadata' | 'innertube' | 'description'
}

// Turn &amp; &#39; etc. back into normal characters
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  }
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m)
}

// Pull the 11-character video id out of any YouTube link shape
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]
  for (const p of patterns) {
    const m = url.trim().match(p)
    if (m) return m[1]
  }
  return null
}

// Title via oEmbed — lightweight, no key, essentially always works
async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.title) return String(data.title)
    }
  } catch { /* fall through */ }
  return `Video ${videoId}`
}

// ── ROUTE 1 — Supadata ────────────────────────────────────────────────────
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  if (!SUPADATA_KEY) return null
  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&lang=en`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(20_000) },
    )
    if (!res.ok) {
      // 402 almost always means the free monthly quota is used up
      console.log(`[youtube] Supadata HTTP ${res.status} — falling through`)
      return null
    }
    const data = await res.json()
    const segments: Array<{ text?: string }> = Array.isArray(data?.content) ? data.content : []
    const transcript = (segments.length
      ? segments.map((s) => s.text ?? '').join(' ')
      : typeof data?.content === 'string' ? data.content : '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!transcript) return null
    console.log(`[youtube] Supadata OK — ${transcript.length} chars`)
    return { content: transcript, hasTranscript: true, source: 'supadata' }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return null
  }
}

// Caption files come in two shapes; handle both.
function parseCaptions(xml: string): string {
  let parts: string[]
  if (xml.includes('<text')) {
    // <text start="1.2" dur="3.4">words here</text>
    parts = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1])
  } else {
    // <p t="1200" d="3400"><s>words</s><s> here</s></p>
    parts = [...xml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1])
  }
  return parts
    .map((p) => decodeEntities(p.replace(/<[^>]+>/g, '')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── ROUTE 2 — Innertube, then ROUTE 3 — description ───────────────────────
// We pose as the iPhone app first, then Android. YouTube hands mobile apps a
// caption list even from a datacentre, where the normal web page gives nothing.
async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    {
      name: 'IOS',
      userAgent: 'com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      context: {
        clientName: 'IOS', clientVersion: '19.29.1',
        deviceMake: 'Apple', deviceModel: 'iPhone17,2',
        osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US',
      },
    },
    {
      name: 'ANDROID',
      userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' },
    },
  ]

  // deno-lint-ignore no-explicit-any
  let best: any = null

  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`)
        continue
      }
      const result = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length > 0) {
        console.log(`[youtube] Innertube ${client.name}: ${tracks.length} caption tracks`)
        best = result
        break
      }
      // Keep the first response — even without captions it has the description.
      if (!best) best = result
      console.log(`[youtube] Innertube ${client.name}: no caption tracks`)
    } catch (err) {
      console.error(`[youtube] Innertube ${client.name} error:`, String(err))
    }
  }

  if (!best) return null

  try {
    const tracks = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (Array.isArray(tracks) && tracks.length > 0) {
      // Prefer human-written English, then auto-generated English, then anything
      // deno-lint-ignore no-explicit-any
      const t = tracks as any[]
      const track =
        t.find((x) => x.languageCode === 'en' && x.kind !== 'asr') ??
        t.find((x) => x.languageCode === 'en') ??
        t.find((x) => String(x.languageCode ?? '').startsWith('en')) ??
        t[0]

      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })
      if (capRes.ok) {
        const transcript = parseCaptions(await capRes.text())
        if (transcript) {
          console.log(`[youtube] Innertube transcript OK — ${transcript.length} chars`)
          return { content: transcript, hasTranscript: true, source: 'innertube' }
        }
      }
    }

    // ROUTE 3 — no captions anywhere. Use the description.
    const details = best?.videoDetails
    const description: string = details?.shortDescription ?? ''
    const keywords: string = Array.isArray(details?.keywords) ? details.keywords.join(', ') : ''
    if (description || keywords) {
      const content = [description, keywords ? `Keywords: ${keywords}` : '']
        .filter(Boolean)
        .join('\n\n')
      console.log(`[youtube] Falling back to description — ${description.length} chars`)
      return { content, hasTranscript: false, source: 'description' }
    }
    return null
  } catch (err) {
    console.error('[youtube] Innertube parse error:', String(err))
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Identify the caller from their login token. Never trust a user id sent
    // in the request body — that would let anyone write into anyone's brain.
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      return json({ ok: false, error: 'A YouTube url is required' }, 400)
    }

    const videoId = extractVideoId(url)
    if (!videoId) {
      return json({
        ok: false,
        error: 'That does not look like a YouTube link. Expected something like https://www.youtube.com/watch?v=...',
      }, 400)
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const title = await fetchTitle(videoUrl, videoId)

    // Try each route in order; first success wins
    const result = (await fromSupadata(videoUrl)) ?? (await fromInnertube(videoId))

    if (!result) {
      return json({
        ok: false,
        error: 'Could not read anything from that video. It may be private, age-restricted, or region-locked. Try a different one.',
      }, 422)
    }

    const label = result.hasTranscript
      ? ''
      : '(No transcript was available — this is the video description.)\n\n'
    const content = `📹 ${title}\n\n${label}${result.content.slice(0, MAX_CONTENT)}`

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        source: 'youtube',
        metadata: {
          title,
          video_id: videoId,
          video_url: videoUrl,
          has_transcript: result.hasTranscript,
          fetched_via: result.source,
        },
      })
      .select('id')
      .single()

    if (insertError) throw insertError

    // Keep the full transcript (or description) too. Non-fatal on failure.
    const { error: sourceError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: result.content,
      source_kind: result.hasTranscript ? 'youtube_transcript' : 'youtube_description',
      char_count: result.content.length,
      truncated: false,
    })
    if (sourceError) console.warn('[youtube] thought_sources insert skipped:', sourceError.message)

    return json({
      ok: true,
      title,
      has_transcript: result.hasTranscript,
      fetched_via: result.source,
      chars: result.content.length,
      preview: content.slice(0, 240) + '…',
    })
  } catch (err) {
    console.error('[youtube] Failed:', err)
    const msg = err instanceof Error ? err.message : JSON.stringify(err)
    return json({ ok: false, error: msg }, 500)
  }
})