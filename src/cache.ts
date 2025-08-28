import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CACHE_DIR = path.join(process.cwd(), ".aicr");
const CACHE_PATH = path.join(CACHE_DIR, "cache.json");

type CacheEntry = {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  ts: number; // epoch ms
};

type CacheShape = Record<string, CacheEntry>;

export function ensureCache(): CacheShape {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (!fs.existsSync(CACHE_PATH)) fs.writeFileSync(CACHE_PATH, "{}");
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export function saveCache(obj: CacheShape) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(obj));
  } catch {}
}

export function hashKey(model: string, messages: Array<{ role: "system"|"user"; content: string }>) {
  const h = crypto.createHash("sha1");
  h.update(model);
  for (const m of messages) { h.update(m.role); h.update("\x00"); h.update(m.content); h.update("\x00"); }
  return h.digest("hex");
}

export function getFresh(cache: CacheShape, key: string, ttlHours: number) {
  const hit = cache[key];
  if (!hit) return null;
  const ageH = (Date.now() - hit.ts) / 3600000;
  if (ageH > ttlHours) return null;
  return hit;
}

export function put(cache: CacheShape, key: string, entry: Omit<CacheEntry, "ts">) {
  cache[key] = { ...entry, ts: Date.now() };
}