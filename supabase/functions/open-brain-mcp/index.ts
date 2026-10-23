// =====================================================================
// open-brain-mcp — the MCP server for your Open Brain
// ---------------------------------------------------------------------
// This is the "librarian." AI assistants (like Claude Desktop) send it
// requests, it checks the password, goes to your Supabase database,
// and sends the results back. The AI never touches your database
// directly.
//
// MCP messages use a format called JSON-RPC 2.0. Every request looks
// like: { "jsonrpc": "2.0", "id": 1, "method": "...", "params": {...} }
// and every answer echoes the same id so the AI knows which question
// it belongs to.
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ---------------------------------------------------------------------
// 1. SETTINGS
// Supabase gives every edge function SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY automatically. MCP_ACCESS_KEY is the
// password you created in Step 2.
// ---------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";
// Your own account id (the secret you added in Level 3). Thoughts saved
// through Claude get stamped with it so they show up in your app, and
// (Level 7) search uses it to know whose thoughts to look through.
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? null;

// The database connection. It lives only here, on the server.
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------
// 2. CORS HEADERS
// These tell web browsers this server is allowed to answer requests
// from other places. Claude Desktop doesn't strictly need them, but
// they keep the server friendly to browser-based MCP tools too.
// ---------------------------------------------------------------------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, accept, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// ---------------------------------------------------------------------
// 3. THE TOOL LIST
// This is the "menu" the AI reads to learn what it can ask for.
// The descriptions matter: the AI reads them to decide when and how
// to use each tool.
// ---------------------------------------------------------------------
const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search the user's personal Open Brain (their saved notes, YouTube transcripts, PDFs, articles, and Telegram messages). Finds matches by MEANING and by EXACT WORDS at the same time, so both 'how to get new clients' (finds notes about customer acquisition even if they never use those words) and exact terms like a name or number work. Also searches inside long captures paragraph by paragraph: when a result has 'why_it_matched', that is the specific passage from a long transcript or article that answered the search, so use it. Returns up to 10 matches, best first, each with 'connected_thoughts': other thoughts automatically linked to that result by meaning. Mention relevant connected thoughts to the user too.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, in plain words, e.g. 'ideas for my landscaping business' or 'Tacoma'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description:
      "List the most recent thoughts saved in the user's Open Brain, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many thoughts to return (1 to 50). Defaults to 10.",
        },
      },
    },
  },
  {
    name: "add_thought",
    description:
      "Save a new thought to the user's Open Brain. Only use this when the user asks you to save or remember something.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The text of the thought to save.",
        },
      },
      required: ["content"],
    },
  },
];

// ---------------------------------------------------------------------
// 4. SMALL HELPERS for building responses
// ---------------------------------------------------------------------
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// A successful JSON-RPC answer
function rpcResult(id: unknown, result: unknown): Response {
  return json({ jsonrpc: "2.0", id, result });
}

// A JSON-RPC error answer (the request itself was bad)
function rpcError(id: unknown, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

// Wrap text the way MCP expects tool results to look
function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

// ---------------------------------------------------------------------
// 5. WHAT EACH TOOL ACTUALLY DOES
// This is where the librarian walks into the back room (your
// "thoughts" table) and gets things.
// ---------------------------------------------------------------------
async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    // --- Search: hybrid search (meaning + exact keywords), with chunks ---
    case "search_thoughts": {
      const query = String(args?.query ?? "").trim();
      if (!query) return toolText("Please provide a search query.", true);

      // Level 7: search_thoughts must be told WHOSE thoughts to search.
      // This server uses the service role key (no real sign-in), so
      // row-level security cannot narrow it down for us. OWNER_USER_ID is
      // your own account id, the same secret the Telegram bot uses.
      if (!OWNER_USER_ID) {
        return toolText("The OWNER_USER_ID secret is not set, so I can't tell whose thoughts to search.", true);
      }

      // Turn the question into its "meaning coordinates". If this fails for
      // any reason we still search: a null embedding means keyword-only.
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
      } catch { /* keyword-only search is fine */ }

      const { data, error } = await supabase.rpc("search_thoughts", {
        query_text: query,
        p_user_id: OWNER_USER_ID,
        query_embedding: queryEmbedding,
        match_threshold: 0.3,
        match_count: 10,
      });

      if (!error) {
        if (!data || data.length === 0) {
          return toolText(`No thoughts found related to "${query}".`);
        }

        type Hit = {
          id: string;
          content: string;
          created_at: string;
          similarity: number;
          matched_chunk: string | null;
          match_source: string;
        };
        const hits = data as Hit[];

        // The graph: for each result, also show the thoughts it is wired to
        // in thought_links (in either direction).
        const ids = hits.map((t) => t.id);
        const { data: links } = await supabase
          .from("thought_links")
          .select("source_thought_id, target_thought_id, similarity_score")
          .or(`source_thought_id.in.(${ids.join(",")}),target_thought_id.in.(${ids.join(",")})`);

        const neighbourIds = new Set<string>();
        for (const l of links ?? []) {
          neighbourIds.add(l.source_thought_id);
          neighbourIds.add(l.target_thought_id);
        }
        const { data: neighbours } = neighbourIds.size
          ? await supabase.from("thoughts").select("id, content").in("id", [...neighbourIds])
          : { data: [] };
        const preview = new Map(
          (neighbours ?? []).map((n: { id: string; content: string }) => [
            n.id,
            n.content.length > 200 ? n.content.slice(0, 200) + "…" : n.content,
          ]),
        );

        const results = hits.map((t) => ({
          id: t.id,
          created_at: t.created_at,
          // similarity is 0 when a result was found by keyword only
          similarity: Math.round((t.similarity ?? 0) * 100) / 100,
          matched_by: t.match_source, // "thought" (whole note) or "chunk" (one passage)
          // When the match came from inside a long capture, this is the
          // passage that actually matched: the real answer.
          why_it_matched: t.matched_chunk
            ? `(from partway through a longer capture) ${t.matched_chunk}`
            : undefined,
          // Long captures get a short preview instead of the full transcript.
          content: t.matched_chunk && t.content.length > 400
            ? t.content.slice(0, 400) + "… [long capture; see why_it_matched for the relevant part]"
            : t.content,
          connected_thoughts: (links ?? [])
            .filter((l) => l.source_thought_id === t.id || l.target_thought_id === t.id)
            .map((l) => {
              const otherId = l.source_thought_id === t.id ? l.target_thought_id : l.source_thought_id;
              return {
                id: otherId,
                link_strength: Math.round(l.similarity_score * 100) / 100,
                content: preview.get(otherId) ?? "",
              };
            })
            .sort((a, b) => b.link_strength - a.link_strength),
        }));
        return toolText(JSON.stringify(results, null, 2));
      }
      console.log("search_thoughts RPC failed, falling back to plain keyword search:", error.message);

      // Last-resort fallback: a plain "contains" search, only if the RPC
      // itself failed, so search never goes completely dark. Filtered to
      // your own thoughts, for the same reason as p_user_id above.
      // % and _ are wildcards in database searches; escape them so a
      // search for "50%" means the literal text "50%".
      const escaped = query.replace(/[\\%_]/g, (c) => "\\" + c);

      const { data: fallback, error: fbError } = await supabase
        .from("thoughts")
        .select("id, content, created_at")
        .eq("user_id", OWNER_USER_ID)
        .ilike("content", `%${escaped}%`) // ilike = case-insensitive "contains"
        .order("created_at", { ascending: false })
        .limit(10);

      if (fbError) return toolText(`Database error: ${fbError.message}`, true);
      if (!fallback || fallback.length === 0) {
        return toolText(`No thoughts found containing "${query}". Try a different or shorter keyword.`);
      }
      return toolText(JSON.stringify(fallback, null, 2));
    }

    // --- List recent: the newest thoughts ---
    case "list_recent": {
      // Default to 10, and keep it between 1 and 50
      const raw = Number(args?.limit ?? 10);
      const limit = Math.min(Math.max(Number.isFinite(raw) ? Math.floor(raw) : 10, 1), 50);

      const { data, error } = await supabase
        .from("thoughts")
        .select("id, content, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) return toolText(`Database error: ${error.message}`, true);
      if (!data || data.length === 0) return toolText("The brain is empty so far.");
      return toolText(JSON.stringify(data, null, 2));
    }

    // --- Add: save a new thought ---
    case "add_thought": {
      const content = String(args?.content ?? "").trim();
      if (!content) return toolText("Please provide content to save.", true);

      const { data, error } = await supabase
        .from("thoughts")
        .upsert({ content, user_id: OWNER_USER_ID }, { onConflict: "dedup_key,user_id", ignoreDuplicates: false })
        .select("id, content, created_at")
        .single();

      if (error) return toolText(`Database error: ${error.message}`, true);
      return toolText(`Saved to your brain:\n${JSON.stringify(data, null, 2)}`);
    }

    default:
      return toolText(`Unknown tool: ${name}`, true);
  }
}

// ---------------------------------------------------------------------
// 6. THE FRONT DESK
// Every request arrives here. In order, we:
//   a) answer browser "pre-flight" checks (OPTIONS)
//   b) check the password
//   c) read the JSON-RPC message
//   d) route it to the right handler
// ---------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  // a) Browser pre-flight check: just say "ok"
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // b) Password check. The request must include:
  //    Authorization: Bearer <your MCP_ACCESS_KEY>
  const auth = req.headers.get("Authorization") ?? "";
  if (!MCP_ACCESS_KEY || auth !== `Bearer ${MCP_ACCESS_KEY}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  // This simple server only answers POST requests (no live streaming)
  if (req.method !== "POST") {
    return json({ error: "Method not allowed. Use POST." }, 405);
  }

  // c) Read the message
  let body: any;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error: body must be valid JSON");
  }

  if (!body || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0") {
    return rpcError(body?.id ?? null, -32600, "Invalid JSON-RPC 2.0 request");
  }

  const { id, method, params } = body;

  // Messages with no id are "notifications": the AI is just
  // informing us of something and doesn't expect an answer.
  if (id === undefined || id === null) {
    return new Response(null, { status: 202, headers: corsHeaders });
  }

  // d) Route by method
  try {
    switch (method) {
      // The AI's first hello: we say who we are and that we have tools
      case "initialize":
        return rpcResult(id, {
          protocolVersion: params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "open-brain", version: "1.0.0" },
        });

      // "Are you still there?"
      case "ping":
        return rpcResult(id, {});

      // "What tools do you have?"
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });

      // "Please run this tool"
      case "tools/call": {
        const name = String(params?.name ?? "");
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        return rpcResult(id, await callTool(name, args));
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return rpcError(id, -32603, `Internal error: ${(err as Error).message}`);
  }
});