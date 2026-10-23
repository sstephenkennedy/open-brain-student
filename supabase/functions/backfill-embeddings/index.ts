// backfill-embeddings — one-time catch-up for thoughts saved BEFORE Level 6.
// Each call embeds one small batch of thoughts that have no embedding yet.
// Call it in a loop until "remaining" reaches 0.
//
// Input:  POST { batch_size?: number, offset?: number }
// Output: { processed, embedded, failed, offset_next, remaining }
//
// Why "offset" only moves forward by the number of FAILURES: every success
// drops out of the "embedding is null" list on its own, so the next batch
// starts at the front again. Only failures stay in the list, and the offset
// steps past them so the loop can't get stuck retrying the same broken row.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // Deployed with --no-verify-jwt, so check the caller here: service role key
  // only. Supabase has two formats of that key (the older long "eyJ..." one and
  // the newer "sb_secret_..." one), so instead of comparing text we ask
  // Supabase itself whether the key it was handed is a real admin key.
  const provided = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided) return json({ error: "Unauthorized: no key sent" }, 401);
  if (provided !== SERVICE_KEY) {
    const probe = createClient(SUPABASE_URL, provided);
    const { error: authError } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (authError) return json({ error: "Unauthorized: that is not the service role key" }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(body.batch_size) || 5, 1), 20);
    const offset = Math.max(Number(body.offset) || 0, 0);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: thoughts, error } = await supabase
      .from("thoughts")
      .select("id, content")
      .is("embedding", null)
      .order("created_at", { ascending: true })
      .range(offset, offset + batchSize - 1);
    if (error) return json({ error: error.message }, 500);

    let embedded = 0;
    let failed = 0;

    for (const t of thoughts ?? []) {
      try {
        const text = String(t.content ?? "").trim();
        if (!text) { failed++; continue; }

        const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify({ text }),
        });
        const { embedding, error: embError } = await res.json().catch(() => ({}));
        if (!embedding) {
          console.log(`No embedding for ${t.id}: ${embError ?? res.status}`);
          failed++;
          continue;
        }

        const { error: upError } = await supabase
          .from("thoughts")
          .update({ embedding })
          .eq("id", t.id);
        if (upError) {
          console.log(`Could not save embedding for ${t.id}: ${upError.message}`);
          failed++;
          continue;
        }
        embedded++;
      } catch (e) {
        console.log(`Error on ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
        failed++;
      }
    }

    const offsetNext = offset + failed;
    const { count } = await supabase
      .from("thoughts")
      .select("id", { count: "exact", head: true })
      .is("embedding", null);
    const remaining = Math.max((count ?? 0) - offsetNext, 0);

    return json({
      processed: thoughts?.length ?? 0,
      embedded,
      failed,
      offset_next: offsetNext,
      remaining,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
