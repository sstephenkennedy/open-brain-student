// call-llm — your LLM gateway.
//
// To switch providers, change LLM_PROVIDER in Supabase secrets. Add the new
// provider's API key. No other code changes needed.
//
// Every agent calls THIS function instead of calling an AI directly.
// Request body: { prompt, systemPrompt?, model?, maxTokens?, userId?, source? }
// Response:     { text }

import { createClient } from "jsr:@supabase/supabase-js@2";

const PROVIDER = (Deno.env.get("LLM_PROVIDER") ?? "anthropic").toLowerCase();
const DEFAULT_MODEL = Deno.env.get("LLM_MODEL") ?? "";

// Published prices (US dollars per million tokens), used only to estimate the
// cost written to your llm_usage receipts. Unknown model -> cost logged as 0.
const PRICES: Record<string, (inTok: number, outTok: number) => number> = {
  "claude-haiku-5-5": (i, o) => {
    const long = i > 100_000; // Haiku 5.5 charges more for very long prompts
    return (i * (long ? 0.5 : 0.1) + o * (long ? 2.5 : 0.5)) / 1_000_000;
  },
};

type LlmResult = {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
};

// ---------- Providers ----------

async function callAnthropic(
  prompt: string,
  systemPrompt: string | undefined,
  model: string,
  maxTokens: number,
): Promise<LlmResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in Supabase secrets");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic error ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  }

  const text = (data.content ?? [])
    .filter((block: { type: string }) => block.type === "text")
    .map((block: { text: string }) => block.text)
    .join("");

  return {
    text,
    model: data.model ?? model,
    promptTokens: data.usage?.input_tokens ?? 0,
    completionTokens: data.usage?.output_tokens ?? 0,
  };
}

async function callOpenAI(
  prompt: string,
  systemPrompt: string | undefined,
  model: string,
  maxTokens: number,
): Promise<LlmResult> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set in Supabase secrets");

  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: prompt },
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  }

  return {
    text: data.choices?.[0]?.message?.content ?? "",
    model: data.model ?? model,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ---------- Receipts (never allowed to break a real call) ----------

function logUsage(
  userId: string | undefined,
  source: string | undefined,
  requestedModel: string,
  result: LlmResult,
) {
  if (!userId) return;

  const task = (async () => {
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const priceFn = PRICES[result.model] ?? PRICES[requestedModel];
      const cost = priceFn ? priceFn(result.promptTokens, result.completionTokens) : 0;

      const { error } = await supabase.from("llm_usage").insert({
        user_id: userId,
        model: result.model,
        source: source ?? null,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        cost_usd: cost,
      });
      if (error) console.warn("Usage log failed (ignored):", error.message);
    } catch (e) {
      console.warn("Usage log failed (ignored):", e);
    }
  })();

  // Let the receipt finish in the background without making the caller wait.
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil(task);
  } catch {
    /* ignore */
  }
}

// ---------- Handler ----------

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be JSON" }, 400);
  }

  const prompt = body.prompt as string | undefined;
  const systemPrompt = body.systemPrompt as string | undefined;
  const model = (body.model as string | undefined) || DEFAULT_MODEL;
  const maxTokens = (body.maxTokens as number | undefined) ?? 1024;
  const userId = body.userId as string | undefined;
  const source = body.source as string | undefined;

  if (!prompt || typeof prompt !== "string") {
    return json({ error: "prompt is required" }, 400);
  }
  if (!model) {
    return json({ error: "No model chosen. Set LLM_MODEL in Supabase secrets." }, 500);
  }

  try {
    let result: LlmResult;
    switch (PROVIDER) {
      case "anthropic":
        result = await callAnthropic(prompt, systemPrompt, model, maxTokens);
        break;
      case "openai":
        result = await callOpenAI(prompt, systemPrompt, model, maxTokens);
        break;
      default:
        return json({ error: `Unknown LLM_PROVIDER: ${PROVIDER}` }, 500);
    }

    logUsage(userId, source, model, result); // fire and forget
    return json({ text: result.text });
  } catch (e) {
    console.error("call-llm failed:", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});