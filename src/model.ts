type Msg = { role: "system" | "user"; content: string };

export async function callModel(messages: Msg[]): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.CHAT_MODEL || "gpt-4o-mini";
  if (!key) {
    console.log("⚠️  OPENAI_API_KEY not set: skipping model call and returning [].");
    return "[]";
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Model HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content ?? "[]";
  return typeof out === "string" ? out : "[]";
}