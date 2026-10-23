// backfill-links — one-time catch-up that builds graph links for thoughts
// that already had embeddings before auto-linking existed.
// Call it in a loop until "remaining" reaches 0.
//
// Input:  POST { batch_size?: number, offset?: number }
// Output: { processed, linked, already_done, offset_next, remaining }
//
// Small batches (default 3) on purpose: Supabase stops functions that use
// too much memory/CPU in one go (a "546" error), and each thought here does
// a similarity search plus several inserts.

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
  // Same caller check as backfill-embeddings: service role key only, in
  // either of Supabase's two key formats.
  const provided = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided) return json({ error: "Unauthorized: no key sent" }, 401);
  if (provided !== SERVICE_KEY) {
    const probe = createClient(SUPABASE_URL, provided);
    const { error: authError } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (authError) return json({ error: "Unauthorized: that is not the service role key" }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(body.batch_size) || 3, 1), 10);
    const offset = Math.max(Number(body.offset) || 0, 0);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: thoughts, error } = await supabase
      .from("thoughts")
      .select("id, user_id, embedding")
      .not("embedding", "is", null)
      .order("created_at", { ascending: true })
      .range(offset, offset + batchSize - 1);
    if (error) return json({ error: error.message }, 500);

    let linked = 0;
    let alreadyDone = 0;

    for (const t of thoughts ?? []) {
      try {
        if (!t.user_id) { console.log(`Thought ${t.id} has no owner — skipping`); continue; }

        // Already searched for its own neighbours? Then skip it. (We only
        // check links it STARTED, so a thought that was merely linked TO by an
        // earlier one still gets its own turn to find its neighbours. Any
        // reverse duplicate it tries to create is refused by the database.)
        const { count } = await supabase
          .from("thought_links")
          .select("id", { count: "exact", head: true })
          .eq("source_thought_id", t.id);
        if ((count ?? 0) > 0) { alreadyDone++; continue; }

        const { data: neighbors, error: rpcError } = await supabase.rpc("find_links_for_thought", {
          source_id: t.id,
          source_embedding: t.embedding,
          p_user_id: t.user_id,
          match_threshold: 0.5,
          match_count: 5,
        });
        if (rpcError) { console.log(`find_links failed for ${t.id}: ${rpcError.message}`); continue; }

        for (const n of neighbors ?? []) {
          const { error: linkError } = await supabase.from("thought_links").upsert({
            source_thought_id: t.id,
            target_thought_id: n.target_id,
            user_id: t.user_id,
            similarity_score: n.similarity,
            link_type: "semantic",
          }, { onConflict: "source_thought_id,target_thought_id", ignoreDuplicates: true });
          if (!linkError) linked++;
        }
      } catch (e) {
        console.log(`Error on ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const offsetNext = offset + (thoughts?.length ?? 0);
    const { count: total } = await supabase
      .from("thoughts")
      .select("id", { count: "exact", head: true })
      .not("embedding", "is", null);

    return json({
      processed: thoughts?.length ?? 0,
      linked,
      already_done: alreadyDone,
      offset_next: offsetNext,
      remaining: Math.max((total ?? 0) - offsetNext, 0),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
