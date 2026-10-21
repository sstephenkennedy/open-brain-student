// enrich-thought — runs automatically every time a new thought is saved.
// Triggered by a Supabase Database Webhook on INSERT into the thoughts table.
// Asks the AI (through YOUR gateway, call-llm) for tags, a category, and a
// one-sentence summary, then writes them back onto the thought.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CATEGORIES = ["idea", "learning", "question", "reference", "plan", "reflection"];
const MAX_CHARS = 12000; // long captures (like video transcripts) get trimmed to keep cost tiny

const SYSTEM_PROMPT = `You label notes in a personal knowledge base.
Reply with ONLY a JSON object, no other text, in exactly this shape:
{"tags": ["tag1", "tag2", "tag3"], "category": "learning", "summary": "One sentence."}
Rules:
- tags: 3 to 5 short lowercase tags, use hyphens instead of spaces
- category: exactly one of: idea, learning, question, reference, plan, reflection
- summary: one sentence, max 25 words, written from the note-taker's point of view`;

function ok(message: string) {
  console.log(message);
  return new Response(JSON.stringify({ ok: true, message }), {
    status: 200, // always 200 — a webhook function should never "fail"
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const record = payload?.record;

    if (!record?.id) return ok("No record in payload — skipping");
    if (record.category) return ok(`Thought ${record.id} already has a category — skipping`);

    const content: string = (record.content ?? "").trim();
    if (content.length < 20) return ok(`Thought ${record.id} too short to enrich — skipping`);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // Who to bill this call to. Use the thought's owner; fall back to the
    // project's single signed-up user if the thoughts table has no user_id.
    let userId: string | undefined = record.user_id ?? undefined;
    if (!userId) {
      try {
        const { data } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
        userId = data?.users?.[0]?.id;
      } catch { /* no receipt is fine */ }
    }

    // Call YOUR gateway — never an AI provider directly.
    const llmRes = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        systemPrompt: SYSTEM_PROMPT,
        prompt: `Note:\n"""\n${content.slice(0, MAX_CHARS)}\n"""`,
        maxTokens: 400,
        userId,
        source: "enrich-thought",
      }),
    });

    const llm = await llmRes.json().catch(() => ({}));
    if (!llmRes.ok || !llm.text) {
      return ok(`call-llm failed (${llmRes.status}): ${llm.error ?? "no text returned"}`);
    }

    // Pull the JSON object out of the reply, even if the AI added extra words.
    const match = String(llm.text).match(/\{[\s\S]*\}/);
    if (!match) return ok(`Could not find JSON in AI reply: ${llm.text}`);

    let parsed: { tags?: unknown; category?: unknown; summary?: unknown };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return ok(`AI reply was not valid JSON: ${match[0]}`);
    }

    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5)
      : [];
    const category = CATEGORIES.includes(String(parsed.category)) ? String(parsed.category) : null;
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : null;

    const { error } = await supabase
      .from("thoughts")
      .update({ tags, category, summary, enriched_at: new Date().toISOString() })
      .eq("id", record.id);

    if (error) return ok(`Failed to update thought ${record.id}: ${error.message}`);
    return ok(`Enriched thought ${record.id}: [${category}] ${tags.join(", ")}`);
  } catch (e) {
    return ok(`enrich-thought error: ${e instanceof Error ? e.message : String(e)}`);
  }
});
