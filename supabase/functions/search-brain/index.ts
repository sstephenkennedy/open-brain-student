// search-brain — lets YOUR APP use the same hybrid search Claude Desktop uses.
// The browser can't call search_thoughts directly: making an embedding needs
// the OpenRouter key, which must never be in a web page. So the app asks this
// function, which works out WHO is asking from their own login token.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);

  // 1. WHO is asking? Read their login token and have Supabase's auth server
  //    verify it. We NEVER trust a user id sent in the request body: a
  //    browser could put anything there.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "Not signed in" }, 401);

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  const userId = userData?.user?.id;
  if (authError || !userId) return reply({ error: "Not signed in" }, 401);

  // 2. What are they searching for?
  let body: { query?: unknown; limit?: unknown };
  try {
    body = await req.json();
  } catch {
    return reply({ error: "Body must be JSON" }, 400);
  }
  const query = String(body?.query ?? "").trim();
  if (!query) return reply({ results: [] });

  const rawLimit = Number(body?.limit ?? 20);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 1), 50);

  // 3. Turn the search phrase into its "meaning coordinates". If this fails,
  //    we still search: a null embedding just means keyword-only.
  let queryEmbedding: number[] | null = null;
  try {
    const embRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ text: query }),
    });
    const emb = await embRes.json().catch(() => ({}));
    if (Array.isArray(emb?.embedding)) queryEmbedding = emb.embedding;
  } catch { /* keyword-only is fine */ }

  // 4. The same hybrid search as Claude Desktop, limited to THIS person's
  //    thoughts via p_user_id (taken from their verified login, above).
  const { data, error } = await supabase.rpc("search_thoughts", {
    query_text: query,
    p_user_id: userId,
    query_embedding: queryEmbedding,
    match_threshold: 0.3,
    match_count: limit,
  });

  if (error) {
    console.log("search-brain: search_thoughts failed:", error.message);
    return reply({ error: "Search failed" }, 500);
  }

  return reply({ results: data ?? [] });
});