import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chunkFileByAst } from "./ast.js";
import { buildConfig } from "./config.js"; // we use its allowFile()
import { getEmbedding, cosineSim, EmbeddingError } from "./embeddings.js";

export type IndexEntry = {
  id: string;                // hash of path+range
  path: string;
  startLine: number;
  endLine: number;
  symbolType: string;
  symbolName: string | null;
  snippet: string;
  fileHash: string;
  embedding: number[];
};

export type RepoIndex = {
  model: string;
  createdAt: string;
  entries: IndexEntry[];
};

const INDEX_DIR = path.join(process.cwd(), ".aicr");
const INDEX_PATH = path.join(INDEX_DIR, "repo_index.json");

function sha1(s: string) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function listAllFiles(root: string): string[] {
  const out: string[] = [];
  const denyDirs = new Set([".git", "node_modules", ".aicr", "dist", "build", "out"]);
  function walk(d: string) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) {
        if (!denyDirs.has(name)) walk(p);
      } else {
        out.push(p);
      }
    }
  }
  walk(root);
  return out;
}

export async function ensureRepoIndex(labels: string[], env: NodeJS.ProcessEnv): Promise<RepoIndex | null> {
  // Allow hard-off switches
  if (env.RAG_DISABLE === "1" || env.RAG_K === "0") {
    console.log("🔕 RAG disabled via env (RAG_K=0 or RAG_DISABLE=1)");
    return null;
  }

  const cfg = buildConfig(labels, env);

  // If an index already exists, try to load it (best-effort)
  if (fs.existsSync(INDEX_PATH)) {
    try {
      const raw = fs.readFileSync(INDEX_PATH, "utf8");
      const parsed = JSON.parse(raw) as RepoIndex;
      return parsed;
    } catch {
      /* continue to rebuild */
    }
  }

  // Build fresh index (best-effort)
  try {
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    const root = process.cwd();
    const files = listAllFiles(root)
      .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".js") || p.endsWith(".jsx"))
      .map((p) => p.replace(root + path.sep, ""))
      .filter(cfg.allowFile);

    const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
    const entries: IndexEntry[] = [];

    for (const rel of files) {
      const full = path.join(root, rel);
      const source = fs.readFileSync(full, "utf8");
      const fileHash = sha1(source);

      const chunks = chunkFileByAst(rel, source).slice(0, 200); // safety cap
      for (const c of chunks) {
        const id = sha1(`${rel}:${c.startLine}-${c.endLine}:${fileHash}`);
        try {
          const vec = await getEmbedding(`${rel}\n${c.symbolType} ${c.symbolName ?? ""}\n${c.snippet}`);
          entries.push({
            id,
            path: rel,
            startLine: c.startLine,
            endLine: c.endLine,
            symbolType: c.symbolType,
            symbolName: c.symbolName,
            snippet: c.snippet,
            fileHash,
            embedding: vec,
          });
        } catch (e: any) {
          if (e instanceof EmbeddingError && e.code === "QUOTA") {
            console.log("⚠️  Embedding quota/rate-limit hit — disabling RAG for this run.");
            return null; // fail-open: no RAG, but keep the review running
          }
          console.log(`⚠️  Embedding error for ${rel}:${c.startLine}-${c.endLine} — skipping chunk: ${String(e?.message || e)}`);
          // continue to next chunk
        }
      }
    }

    const idx: RepoIndex = { model, createdAt: new Date().toISOString(), entries };
    fs.writeFileSync(INDEX_PATH, JSON.stringify(idx));
    return idx;
  } catch (e: any) {
    console.log(`⚠️  Failed to build RAG index — proceeding without RAG. ${String(e?.message || e)}`);
    return null;
  }
}

export async function retrieveSimilar(
  index: RepoIndex | null,
  queryText: string,
  pathHint: string,
  k = 6
) {
  if (!index || index.entries.length === 0) return [];
  const q = await getEmbedding(queryText);
  // Prefer same-file and same-dir entries
  const sameDir = path.dirname(pathHint) || ".";
  const scored = index.entries.map(e => {
    const s = cosineSim(q, e.embedding);
    const bonus =
      e.path === pathHint ? 0.05 :
      path.dirname(e.path) === sameDir ? 0.02 : 0;
    return { e, score: s + bonus };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(s => ({
    path: s.e.path,
    startLine: s.e.startLine,
    endLine: s.e.endLine,
    symbolType: s.e.symbolType,
    symbolName: s.e.symbolName,
    snippet: s.e.snippet
  }));
}