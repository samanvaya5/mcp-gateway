/**
 * BM25 search engine with token normalization.
 *
 * No embeddings, no ML, no external dependencies.
 * Just classical information retrieval with smart tokenization.
 *
 * Features:
 *   - BM25 scoring (term frequency + inverse document frequency)
 *   - Token normalization: camelCase, snake_case, kebab-case splitting
 *   - Server-scoped search
 *   - Configurable k1/b parameters
 */

import type { ToolEntry } from "./types.js";

// ── BM25 Parameters ──────────────────────────────────────────────

const K1 = 1.2;   // Term frequency saturation (higher = less saturation)
const B = 0.75;   // Length normalization (0 = none, 1 = full)

// ── Token Normalization ──────────────────────────────────────────

/**
 * Normalize a raw string into searchable tokens.
 *
 * Handles:
 *   - camelCase:   "webSearch"     → ["web", "search"]
 *   - PascalCase:  "GetUser"       → ["get", "user"]
 *   - snake_case:  "web_search"    → ["web", "search"]
 *   - kebab-case:  "web-search"    → ["web", "search"]
 *   - numbers:     "searchV2"      → ["search", "v2"]
 *   - separators:  "github__repo"  → ["github", "repo"]
 *   - mixed:       "get_userById"  → ["get", "user", "by", "id"]
 */
export function tokenize(text: string): string[] {
  if (!text || text.length === 0) return [];

  // Step 1: Split transitions BEFORE lowercasing
  // camelCase: "getUserById" → "get User By Id"
  // letter→number: "searchV2" → "searchV 2"
  // number→letter: "v2api" → "v2 api"
  let expanded = text
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2");

  // Step 2: Lowercase and split on all separators
  const bySeparators = expanded
    .toLowerCase()
    .replace(/__/g, " ")   // namespaced separator
    .replace(/[^a-z0-9]/g, " ")
    .split(/\s+/);

  return bySeparators.filter((t) => t.length > 0);
}

// ── BM25 Index ───────────────────────────────────────────────────

interface Document {
  tool: ToolEntry;
  tokens: string[];
  length: number;
}

interface BM25Index {
  documents: Document[];
  avgdl: number;
  idf: Map<string, number>;
  tokenToDocs: Map<string, Set<number>>; // token → doc indices
}

/**
 * Build a BM25 index from tools.
 */
export function buildIndex(tools: ToolEntry[]): BM25Index {
  const documents: Document[] = tools.map((tool) => {
    // Combine name and description for document text
    const text = `${tool.name} ${tool.description}`;
    const tokens = tokenize(text);
    return { tool, tokens, length: tokens.length };
  });

  const totalLength = documents.reduce((sum, d) => sum + d.length, 0);
  const avgdl = documents.length > 0 ? totalLength / documents.length : 0;

  // Compute IDF for each unique token
  const idf = new Map<string, number>();
  const tokenToDocs = new Map<string, Set<number>>();

  const N = documents.length;

  for (let i = 0; i < documents.length; i++) {
    const uniqueTokens = new Set(documents[i].tokens);
    for (const token of uniqueTokens) {
      if (!tokenToDocs.has(token)) {
        tokenToDocs.set(token, new Set());
      }
      tokenToDocs.get(token)!.add(i);
    }
  }

  for (const [token, docs] of tokenToDocs) {
    const nq = docs.size;
    // Lucene BM25 IDF: log(1 + (N - n(q) + 0.5) / (n(q) + 0.5))
    // Always positive, rare terms score much higher
    idf.set(token, Math.log(1 + (N - nq + 0.5) / (nq + 0.5)));
  }

  return { documents, avgdl, idf, tokenToDocs };
}

// ── BM25 Scoring ─────────────────────────────────────────────────

/**
 * Score a single document against query tokens.
 */
function scoreDocument(
  doc: Document,
  queryTokens: string[],
  index: BM25Index,
): number {
  if (doc.length === 0 || index.avgdl === 0) return 0;

  let score = 0;

  // Count term frequencies in document
  const tf = new Map<string, number>();
  for (const token of doc.tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  for (const qToken of queryTokens) {
    const idf = index.idf.get(qToken) ?? 0;
    if (idf <= 0) continue; // Skip terms not in corpus

    const f = tf.get(qToken) ?? 0;
    if (f === 0) continue;

    // BM25 term score: IDF * (f * (k1 + 1)) / (f + k1 * (1 - b + b * |D|/avgdl))
    const denom = f + K1 * (1 - B + B * (doc.length / index.avgdl));
    score += idf * ((f * (K1 + 1)) / denom);
  }

  return score;
}

// ── Search ───────────────────────────────────────────────────────

export interface SearchResult {
  tool: ToolEntry;
  score: number;
}

/**
 * Search tools using BM25 scoring with token normalization.
 *
 * @param query   - Search query string
 * @param tools   - All available tools
 * @param options - Optional server filter, limit
 */
export function search(
  query: string,
  tools: ToolEntry[],
  options?: {
    server?: string;      // Filter to specific server
    limit?: number;       // Max results (default: 20)
  },
): SearchResult[] {
  const limit = options?.limit ?? 20;

  // Filter to server if specified
  const filtered = options?.server
    ? tools.filter((t) => t.serverName === options.server)
    : tools;

  if (filtered.length === 0) return [];

  // Tokenize query
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Build BM25 index from filtered tools
  const index = buildIndex(filtered);

  // Score each document
  const scored: SearchResult[] = [];
  for (const doc of index.documents) {
    const score = scoreDocument(doc, queryTokens, index);
    if (score > 0) {
      scored.push({ tool: doc.tool, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}

// ── Convenience: tokenize for testing ────────────────────────────
export { tokenize as normalizeQuery };
