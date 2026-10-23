// weekly-digest — reads the last 7 days of thoughts and writes a summary
// of what you've been learning. Called on a schedule by pg_cron.
// Every AI call goes through YOUR gateway, call-llm.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MIN_THOUGHTS = 5;
const DETAIL_CHARS = 600;        // how much of each thought's text to include
const MAX_TOTAL_CHARS = 60000;   // keeps the request small and cheap
const TIMEZONE = "America/Phoenix";

const SYSTEM_PROMPT = `You write a short weekly digest of someone's personal knowledge base.
Write directly to them ("you"), warm but not gushing. Plain text, no markdown headers.
Structure:
1. WHAT YOU WERE LEARNING — 3 to 6 short bullet points, grouped by topic
2. KEY THEMES — 2 to 4 threads that connect several notes, one or two sentences each
3. A QUESTION YOU SEEM TO BE EXPLORING — one question, then one sentence on why
Keep the whole digest under 350 words. Only use what is in the notes.`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-US", { timeZone: TIMEZONE, month: "short", day: "numeric" });
}

Deno.serve(async () => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 1. Last 7 days of thoughts, leaving out earlier digests
    const { data: thoughts, error } = await supabase
      .from("thoughts")
      .select("content, category, summary, tags, created_at, user_id")
      .gte("created_at", start.toISOString())
      .or("category.is.null,category.neq.digest")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Could not read thoughts:", error.message);
      return json({ ok: false, error: error.message }, 500);
    }

    // 2. Not enough to say anything useful this week
    if (!thoughts || thoughts.length < MIN_THOUGHTS) {
      console.log(`Only ${thoughts?.length ?? 0} thoughts this week — skipping digest.`);
      return json({ ok: true, skipped: true, count: thoughts?.length ?? 0 });
    }

    // 3. Group by category
    const groups: Record<string, typeof thoughts> = {};
    for (const t of thoughts) {
      const key = t.category ?? "uncategorized";
      (groups[key] ??= []).push(t);
    }

    let notes = "";
    for (const [category, items] of Object.entries(groups)) {
      notes += `\n=== ${category.toUpperCase()} (${items.length}) ===\n`;
      for (const t of items) {
        const date = fmtDate(new Date(t.created_at));
        const tags = t.tags?.length ? ` [${t.tags.join(", ")}]` : "";
        const detail = String(t.content ?? "").replace(/\s+/g, " ").slice(0, DETAIL_CHARS);
        notes += t.summary
          ? `- ${date}${tags}: ${t.summary}\n  Detail: ${detail}\n`
          : `- ${date}${tags}: ${detail}\n`;
      }
    }
    notes = notes.slice(0, MAX_TOTAL_CHARS);

    // Who this digest belongs to (and who gets billed): the most common owner
    const counts: Record<string, number> = {};
    for (const t of thoughts) if (t.user_id) counts[t.user_id] = (counts[t.user_id] ?? 0) + 1;
    let userId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!userId) {
      const { data } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
      userId = data?.users?.[0]?.id;
    }

    // 4. Ask the AI — through YOUR gateway
    const llmRes = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        systemPrompt: SYSTEM_PROMPT,
        prompt: `Here are my notes from ${fmtDate(start)} to ${fmtDate(end)}, grouped by category:\n${notes}`,
        maxTokens: 1500,
        userId,
        source: "weekly-digest",
      }),
    });

    const llm = await llmRes.json().catch(() => ({}));
    if (!llmRes.ok || !llm.text) {
      console.error(`call-llm failed (${llmRes.status}):`, llm.error ?? "no text");
      return json({ ok: false, error: llm.error ?? "call-llm returned no text" }, 502);
    }

    // 5. Save the digest back into the brain
    const content = `🧠 Weekly Digest — ${fmtDate(start)} to ${fmtDate(end)}\n\n${String(llm.text).trim()}`;

        const { error: insertError } = await supabase.from("thoughts").upsert({
      content,
      category: "digest",
      tags: ["weekly-digest"],
      summary: `Weekly digest of ${thoughts.length} thoughts`,
      enriched_at: new Date().toISOString(),
      user_id: userId,
      metadata: {
        kind: "weekly-digest",
        thought_count: thoughts.length,
        period_start: start.toISOString(),
        period_end: end.toISOString(),
      },
    }, { onConflict: "dedup_key,user_id", ignoreDuplicates: false });

    if (insertError) {
      console.error("Could not save digest:", insertError.message);
      return json({ ok: false, error: insertError.message }, 500);
    }

    console.log(`Digest saved from ${thoughts.length} thoughts.`);
    return json({ ok: true, count: thoughts.length });
  } catch (e) {
    console.error("weekly-digest error:", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
