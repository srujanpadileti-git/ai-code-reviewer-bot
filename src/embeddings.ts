export type Embedding = number[];

function truncateForEmbed(s: string, maxChars = 8000) {
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

export async function getEmbedding(text: string): Promise<Embedding> {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  if (!key) throw new Error("OPENAI_API_KEY is missing for embeddings.");
  const body = { model, input: truncateForEmbed(text) };

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Embeddings HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding as number[] | undefined;
  if (!vec) throw new Error("No embedding returned");
  return vec;
}

export function cosineSim(a: Embedding, b: Embedding) {
  let dot = 0, na = 0, nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) { dot += a[i] * b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}