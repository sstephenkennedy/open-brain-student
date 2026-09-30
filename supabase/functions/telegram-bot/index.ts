// telegram-bot — your Open Brain on Telegram
//
// How it works: Telegram sends every message to this function (a "webhook").
// We check it's from YOUR chat, then either save it, search, or list recent.
// We ALWAYS answer Telegram with 200 OK, even on errors, so Telegram
// doesn't keep re-sending the same message.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Secrets come from Supabase (Edge Functions → Secrets), never from this file.
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// The service role key skips Level 2's security rule, so we must set and
// filter user_id ourselves on every query below.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
)

function ok() {
  return new Response('ok', { status: 200, headers: corsHeaders })
}

// Send a message back to the user through Telegram.
async function reply(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  })
}

// Shorten long thoughts so search results stay readable.
function preview(content: string, max = 300) {
  const clean = (content ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

type Row = { content: string; created_at: string }

function formatRows(rows: Row[]) {
  return rows
    .map((r, i) => {
      const date = new Date(r.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
      return `${i + 1}. ${preview(r.content)}\n   — ${date}`
    })
    .join('\n\n')
}

const HELP_TEXT =
  'Your Open Brain is listening.\n\n' +
  '• Send any message → saved as a thought\n' +
  '• /search word  (or ?word) → find thoughts\n' +
  '• /recent → your last 5 thoughts\n' +
  '• /help → this list'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return ok()

  let chatId: number | undefined

  try {
    const update = await req.json()
    const message = update.message ?? update.edited_message
    if (!message?.text) return ok() // photos, stickers, etc. — ignore for now

    chatId = message.chat.id as number
    const text = String(message.text).trim()

    // ── Door check: only YOUR chat gets in ──────────────────────────
    // Read inside the handler so a newly added secret is picked up.
    const allowedChatId = Deno.env.get('TELEGRAM_CHAT_ID')

    if (!allowedChatId) {
      await reply(
        chatId,
        `Almost ready! Your chat ID is:\n\n${chatId}\n\n` +
          'Add it in Supabase → Edge Functions → Secrets as TELEGRAM_CHAT_ID, ' +
          'then message me again. Until then, I won\'t save anything.',
      )
      return ok()
    }

    if (String(chatId) !== allowedChatId.trim()) {
      return ok() // a stranger — ignore silently
    }

    if (!OWNER_USER_ID) {
      await reply(chatId, 'Setup problem: the OWNER_USER_ID secret is missing in Supabase.')
      return ok()
    }

    // ── /help and /start ────────────────────────────────────────────
    if (text === '/start' || text.startsWith('/help')) {
      await reply(chatId, HELP_TEXT)
      return ok()
    }

    // ── /recent ─────────────────────────────────────────────────────
    if (text.startsWith('/recent')) {
      const { data, error } = await supabase
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false })
        .limit(5)

      if (error) throw error
      await reply(
        chatId,
        data && data.length
          ? `Your last ${data.length} thoughts:\n\n${formatRows(data)}`
          : 'Your brain is empty so far. Send me a thought!',
      )
      return ok()
    }

    // ── /search word  or  ?word ─────────────────────────────────────
    if (text.startsWith('/search') || text.startsWith('?')) {
      const query = text.startsWith('?')
        ? text.slice(1).trim()
        : text.replace(/^\/search(@\w+)?/, '').trim()

      if (!query) {
        await reply(chatId, 'What should I search for? Try: /search marketing')
        return ok()
      }

      // Escape characters that have special meaning in a LIKE pattern.
      const safe = query.replace(/[\\%_]/g, (c) => '\\' + c)

      const { data, error } = await supabase
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .ilike('content', `%${safe}%`)
        .order('created_at', { ascending: false })
        .limit(5)

      if (error) throw error
      await reply(
        chatId,
        data && data.length
          ? `Found ${data.length} for "${query}":\n\n${formatRows(data)}`
          : `Nothing found for "${query}".`,
      )
      return ok()
    }

    // ── Unknown command ─────────────────────────────────────────────
    if (text.startsWith('/')) {
      await reply(chatId, `I don't know that command.\n\n${HELP_TEXT}`)
      return ok()
    }

    // ── Everything else: save it as a new thought ───────────────────
    const { error } = await supabase.from('thoughts').insert({
      user_id: OWNER_USER_ID, // without this, the row is invisible to your app
      content: text,
      source: 'telegram',
      metadata: {
        telegram_chat_id: chatId,
        telegram_message_id: message.message_id,
      },
    })

    if (error) throw error
    await reply(chatId, 'Saved to your brain ✅')
    return ok()
  } catch (err) {
    console.error('telegram-bot error:', err)
    // Tell you what broke, so you're not left guessing.
    if (chatId !== undefined) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err)
      try {
        await reply(chatId, `Something went wrong: ${msg}`)
      } catch (_) {
        // even the error reply failed — nothing more we can do
      }
    }
    return ok() // always 200, so Telegram doesn't retry forever
  }
})