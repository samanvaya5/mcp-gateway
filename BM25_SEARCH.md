# BM25 Search Implementation

## What Was Implemented

### 1. BM25 Scoring Algorithm (`src/bm25.ts`)

Classical information retrieval ranking with zero dependencies:

```
BM25 Score = Σ IDF(term) × (TF × 2.2) / (TF + 1.2 × (0.25 + 0.75 × docLength/avgDocLength))
```

**Key features:**
- **IDF (Inverse Document Frequency)**: Rare terms score higher
  - "exa" appears in 2 tools → high IDF → ranks first
  - "search" appears in 40 tools → low IDF → lower rank
- **TF (Term Frequency)**: More occurrences = higher score
- **Length normalization**: Longer descriptions don't automatically win
- **Lucene variant**: Always positive IDF, no zero-score issues

### 2. Token Normalization

Handles all naming conventions automatically:

| Input | Tokens |
|-------|--------|
| `web_search_exa` | ["web", "search", "exa"] |
| `webSearchExa` | ["web", "search", "exa"] |
| `WebSearchExa` | ["web", "search", "exa"] |
| `web-search-exa` | ["web", "search", "exa"] |
| `github__list_repos` | ["github", "list", "repos"] |
| `searchV2` | ["search", "v", "2"] |
| `getUserById` | ["get", "user", "by", "id"] |

**Zero dependencies** — pure string manipulation.

### 3. Server-Scoped Search

Restrict search to a specific server:

```json
{"query": "search", "server": "github", "limit": 5}
→ Only returns github tools
```

### 4. Updated API

`search_tools` now accepts:
- `query` (required): Search terms
- `limit` (optional): Max results, default 20
- `server` (optional): Restrict to specific server

## Test Results

```
✅ 74 tests pass, 0 fail
✅ Token normalization: 11 tests
✅ BM25 search: 9 tests  
✅ Existing tools/proxy/e2e: 54 tests
```

## Examples in Action

### Example 1: Rare term ranks higher
```
Query: "exa"
→ Returns only exa2 tools (2 results)
→ "github" search would return 50+ tools
```

### Example 2: camelCase query works
```
Query: "web_search_exa"
→ Returns: exa2__web_search_exa (first)
```

### Example 3: Server-scoped search
```
Query: "search", server: "github"
→ Returns only github search tools (5 results)
→ Ignores exa2, playwright, etc.
```

### Example 4: Natural language
```
Query: "github search repo"
→ Returns: github__search_repositories (ranked by relevance)
```

## Performance

- **Index building**: O(n × avg_tokens) — happens once per search
- **Search**: O(n × query_tokens) — linear in number of tools
- **Memory**: Stores only token counts, not full vectors
- **No external dependencies**: No sqlite-vec, no FAISS, no OpenAI calls

## Comparison with Alternatives

| Approach | Dependencies | RAM | Accuracy | Setup |
|----------|-------------|-----|----------|-------|
| **Our BM25** | None | ~1KB | Good | Instant |
| Vector (FAISS) | FAISS + model | ~100MB | Excellent | 5 min download |
| Vector (OpenAI) | API key + network | 0 | Excellent | API latency |
| BM25 (Lucene) | Java/Elasticsearch | 100MB+ | Excellent | Server setup |

**BM25 wins for local development**: No setup, no downloads, no API keys, works offline.
