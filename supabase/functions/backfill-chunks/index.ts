// backfill-chunks — a one-time pass that chunks thoughts saved BEFORE Level 7.
// New thoughts are chunked automatically by enrich-thought. This catches up
// everything older, in small batches, biggest documents first, so if it gets
// interrupted the most valuable ones are already done. Safe to re-run: the
// thoughts_needing_chunks view only lists thoughts that have no chunks yet.

import { createClient } from "npm:@supabase/supabase-js@2";
import { saveThoughtChunksSafe } from "../_shared/thought-chunks.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Only an admin key may run this. Rather than comparing against one exact
// string (which breaks when a project has both the older eyJ... service_role
// key and a newer sb_secret_... key), we ask Supabase itself: "can this key
// do an admin-only action?" Only real admin keys can list users.
async function isAdminKey(key: string): Promise<boolean> {
  if (!key) return false;
  if (key === SERVICE_ROLE_KEY) return true;
  try {
    const probe = createClient(SUPABASE_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
    return !error;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const key = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!(await isAdminKey(key))) return reply({ error: "Unauthorized" }, 401);

  let body: { batch_size?: unknown; dry_run?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const rawSize = Number(body?.batch_size ?? 10);
  const batchSize = Math.min(Math.max(Number.isFinite(rawSize) ? Math.floor(rawSize) : 10, 1), 25);

  // How many still need chunks?
  const { count: before, error: countError } = await supabase
    .from("thoughts_needing_chunks")
    .select("id", { count: "exact", head: true });
  if (countError) return reply({ error: countError.message }, 500);

  // Dry run: just report, write nothing.
  if (body?.dry_run === true) return reply({ needs_chunks: before ?? 0 });

  // Next batch, biggest first.
  const { data: batch, error: batchError } = await supabase
    .from("thoughts_needing_chunks")
    .select("id, chars")
    .order("chars", { ascending: false })
    .limit(batchSize);
  if (batchError) return reply({ error: batchError.message }, 500);

  let processed = 0;
  let chunked = 0;
  for (const row of batch ?? []) {
    processed++;
    const { data: thought } = await supabase
      .from("thoughts")
      .select("id, content")
      .eq("id", row.id)
      .single();
    if (!thought?.content) continue;

    const written = await saveThoughtChunksSafe(
      supabase, thought.id, thought.content, "backfill-chunks", "summary",
    );
    if (written > 0) chunked++;
    console.log(`backfill-chunks: ${thought.id} (${row.chars} chars) -> ${written} chunks`);
  }

  // How many are left now?
  const { count: after } = await supabase
    .from("thoughts_needing_chunks")
    .select("id", { count: "exact", head: true });

  // If a whole batch produced nothing, stop the loop instead of retrying the
  // same failing thoughts forever. Check the function's Logs to see why.
  const remaining = processed > 0 && chunked === 0 ? 0 : (after ?? 0);

  return reply({ processed, chunked, remaining, still_unchunked: after ?? 0 });
});