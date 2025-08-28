type Msg = { role: "system" | "user"; content: string };

export type ModelCall = {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export async function callModel(messages: Msg[]): Promise<ModelCall> {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.CHAT_MODEL || "gpt-4o-mini";
  if (!key) {
    console.log("⚠️  OPENAI_API_KEY not set: skipping model call and returning [].");
    return { text: "[]", promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    }
  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, temperature: 0.2, messages })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Model HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "[]";
  const usage = data?.usage || {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`    (model: ${model}, tokens: prompt ${promptTokens}, out ${completionTokens}, total ${totalTokens}, ${dt}s)`);
  return { text: typeof text === "string" ? text : "[]", promptTokens, completionTokens, totalTokens };
}