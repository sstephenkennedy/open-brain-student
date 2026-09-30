// capture-url — paste a link, the server fetches the page and saves its text.
//
// WHY THIS RUNS ON THE SERVER: a web page in your browser is not allowed to
// fetch other websites (that rule is called CORS). A server has no such limit,
// so your app hands the link to this function and this function does the fetch.
//
// For now we save the page's readable text as-is. Summarising needs an AI key,
// which arrives in Level 5 — the enrichment agent there will summarise later.

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

const MAX_BYTES = 3_000_000   // don't try to swallow a 50MB page
const MAX_CONTENT = 20_000    // how much text goes on the thought itself

// Turn &amp; &#39; etc. back into normal characters
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', rsquo: '\u2019', lsquo: '\u2018',
    rdquo: '\u201D', ldquo: '\u201C',
  }
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m)
}

// Strip a web page down to its readable text. Deliberately simple: remove the
// machinery (scripts, menus, footers), then remove the remaining tags.
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : 'Untitled page'

  // If the page marks up its article properly, use just that part
  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t\u00A0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title, text: cleaned }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Who is asking? Read from their login token — never from the request body.
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      return json({ ok: false, error: 'A url is required' }, 400)
    }

    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      return json({ ok: false, error: 'That is not a valid web address' }, 400)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return json({ ok: false, error: 'Only http and https links are supported' }, 400)
    }

    // Fetch the page, identifying as a normal browser — some sites refuse
    // anything that looks automated.
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })

    if (!pageRes.ok) {
      return json({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may require a login or block automated readers.`,
      }, 422)
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return json({
        ok: false,
        error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab instead.`,
      }, 415)
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) {
      return json({ ok: false, error: 'That page is too large to process' }, 413)
    }

    const { title, text } = htmlToText(raw)

    if (text.length < 200) {
      return json({
        ok: false,
        error:
          'Almost no readable text was found. The page probably builds itself ' +
          'with JavaScript after loading, which a server cannot see. Try ' +
          'copying the text in by hand instead.',
      }, 422)
    }

    const content = `🔗 ${title}\n${parsed.hostname}\n\n${text.slice(0, MAX_CONTENT)}`

    // Write with the admin client, but always as the signed-in user.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        source: 'url',
        metadata: { title, url: parsed.toString(), hostname: parsed.hostname },
      })
      .select('id')
      .single()

    if (insertError) throw insertError

    // Keep the full extracted text too. Non-fatal: the thought is already saved.
    const { error: sourceError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: text,
      source_kind: 'web',
      char_count: text.length,
      truncated: false,
    })
    if (sourceError) console.warn('[url] thought_sources insert skipped:', sourceError.message)

    return json({
      ok: true,
      title,
      hostname: parsed.hostname,
      chars: text.length,
      preview: content.slice(0, 240) + '…',
    })
  } catch (err) {
    console.error('[url] Failed:', err)
    const msg = err instanceof Error ? err.message : JSON.stringify(err)
    return json({
      ok: false,
      error: msg.toLowerCase().includes('timeout') ? 'That page took too long to respond.' : msg,
    }, 500)
  }
})