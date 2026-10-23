// generate-embedding — turns a piece of text into its "meaning coordinates":
// a list of 1,536 numbers. Similar meanings get similar numbers.
//
// Input:  POST { text: string }
// Output: { embedding: number[] }  — or { embedding: null } if anything fails,
//         so callers (enrich-thought, the backfill, search) can carry on
//         without crashing.
//
// To switch embedding providers, change the model string. The vector dimension
// must stay 1536 or you need a new migration.

const EMBEDDING_MODEL = Deno.env.get("EMBEDDING_MODEL") ?? "openai/text-embedding-3-small";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";
const TIMEOUT_MS = 15_000;
const MAX_CHARS = 30_000; // the model's input limit is ~8k tokens; stay safely under it

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ embedding: null, error: "POST only" }, 405);

  // Deployed with --no-verify-jwt (same as call-llm), so this function checks
  // the caller itself: only your own server code, holding the service role key,
  // may spend your OpenRouter credits.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey || req.headers.get("Authorization") !== `Bearer ${serviceKey}`) {
    return json({ embedding: null, error: "Unauthorized" }, 401);
  }

  try {
    const { text } = await req.json().catch(() => ({}));
    const input = String(text ?? "").trim().slice(0, MAX_CHARS);
    if (!input) return json({ embedding: null, error: "No text provided" }, 400);

    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY is not set");
      return json({ embedding: null, error: "OPENROUTER_API_KEY is not set" });
    }

    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`Embedding API failed (${res.status}):`, detail.slice(0, 500));
      return json({ embedding: null, error: `Embedding API returned ${res.status}` });
    }

    const data = await res.json();
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== 1536) {
      console.error("Unexpected embedding shape:", embedding?.length);
      return json({ embedding: null, error: "Unexpected embedding shape" });
    }

    return json({ embedding });
  } catch (e) {
    console.error("generate-embedding error:", e);
    return json({ embedding: null, error: e instanceof Error ? e.message : String(e) });
  }
});
