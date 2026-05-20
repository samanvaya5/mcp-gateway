import { describe, test, expect } from "bun:test";
import { tokenize, search, buildIndex } from "../src/bm25.js";
import type { ToolEntry } from "../src/types.js";

function makeTool(overrides?: Partial<ToolEntry>): ToolEntry {
  return {
    name: "test__tool",
    description: "A test tool",
    inputSchema: {},
    serverName: "test",
    originalName: "tool",
    versionHash: "abc",
    ...overrides,
  };
}

// ── Token Normalization Tests ────────────────────────────────────

describe("tokenize", () => {
  test("splits plain words", () => {
    expect(tokenize("hello world")).toEqual(["hello", "world"]);
  });

  test("splits snake_case", () => {
    expect(tokenize("web_search_exa")).toEqual(["web", "search", "exa"]);
  });

  test("splits camelCase", () => {
    expect(tokenize("webSearchExa")).toEqual(["web", "search", "exa"]);
  });

  test("splits PascalCase", () => {
    expect(tokenize("WebSearchExa")).toEqual(["web", "search", "exa"]);
  });

  test("splits kebab-case", () => {
    expect(tokenize("web-search-exa")).toEqual(["web", "search", "exa"]);
  });

  test("splits numbers from letters", () => {
    expect(tokenize("searchV2")).toEqual(["search", "v", "2"]);
    expect(tokenize("getUserById")).toEqual(["get", "user", "by", "id"]);
  });

  test("splits namespaced tools", () => {
    expect(tokenize("github__list_repos")).toEqual(["github", "list", "repos"]);
  });

  test("handles mixed conventions", () => {
    expect(tokenize("get_userById-v2")).toEqual(["get", "user", "by", "id", "v", "2"]);
  });

  test("handles empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  test("lowercases everything", () => {
    expect(tokenize("github")).toEqual(["github"]);
  });
});

// ── BM25 Search Tests ────────────────────────────────────────────

describe("search", () => {
  test("finds tools by exact name match", () => {
    const tools = [
      makeTool({ name: "github__search_repos", description: "Search GitHub repos" }),
      makeTool({ name: "github__list_issues", description: "List GitHub issues" }),
      makeTool({ name: "exa2__web_search", description: "Web search with Exa" }),
    ];

    const results = search("search repos", tools);
    expect(results).toHaveLength(2);
    expect(results[0].tool.name).toBe("github__search_repos");
  });

  test("finds tools by description", () => {
    const tools = [
      makeTool({ name: "github__get_file", description: "Get file contents" }),
      makeTool({ name: "github__search_code", description: "Search code across GitHub" }),
      makeTool({ name: "slack__send_msg", description: "Send a Slack message" }),
    ];

    const results = search("send message", tools);
    expect(results[0].tool.name).toBe("slack__send_msg");
  });

  test("handles camelCase query", () => {
    const tools = [
      makeTool({ name: "github__searchRepos", description: "Search repos" }),
      makeTool({ name: "github__listIssues", description: "List issues" }),
    ];

    const results = search("searchRepos", tools);
    expect(results).toHaveLength(1);
    expect(results[0].tool.name).toBe("github__searchRepos");
  });

  test("handles snake_case query", () => {
    const tools = [
      makeTool({ name: "github__search_repos", description: "Search repos" }),
      makeTool({ name: "github__list_issues", description: "List issues" }),
    ];

    const results = search("search_repos", tools);
    expect(results).toHaveLength(1);
    expect(results[0].tool.name).toBe("github__search_repos");
  });

  test("rare terms rank higher", () => {
    const tools = [
      makeTool({ name: "github__get_file", description: "Get a file" }),
      makeTool({ name: "github__search_code", description: "Search code" }),
      makeTool({ name: "exa2__web_search", description: "Web search with exa" }),
      makeTool({ name: "slack__send_msg", description: "Send message" }),
    ];

    // "exa" appears in only 1 tool → should rank highest
    const results = search("exa", tools);
    expect(results[0].tool.name).toBe("exa2__web_search");
  });

  test("respects limit", () => {
    const tools = Array.from({ length: 10 }, (_, i) =>
      makeTool({ name: `srv__tool${i}`, description: `Tool ${i}` })
    );

    const results = search("tool", tools, { limit: 3 });
    expect(results).toHaveLength(3);
  });

  test("filters by server", () => {
    const tools = [
      makeTool({ name: "github__search", description: "Search", serverName: "github" }),
      makeTool({ name: "github__list", description: "List", serverName: "github" }),
      makeTool({ name: "exa2__search", description: "Search", serverName: "exa2" }),
    ];

    const results = search("search", tools, { server: "github" });
    expect(results).toHaveLength(1);
    expect(results[0].tool.name).toBe("github__search");
    expect(results.every((r) => r.tool.serverName === "github")).toBe(true);
  });

  test("returns empty for no match", () => {
    const tools = [makeTool({ name: "github__get", description: "Get something" })];
    const results = search("nonexistent xyz", tools);
    expect(results).toEqual([]);
  });

  test("returns empty for empty query", () => {
    const tools = [makeTool()];
    const results = search("", tools);
    expect(results).toEqual([]);
  });
});

// ── BM25 Index Tests ─────────────────────────────────────────────

describe("buildIndex", () => {
  test("computes IDF correctly", () => {
    const tools = [
      makeTool({ name: "a__tool", description: "common common common" }),
      makeTool({ name: "b__tool", description: "common rare" }),
      makeTool({ name: "c__tool", description: "common rare" }),
    ];

    const index = buildIndex(tools);

    // "common" appears in all 3 docs → low IDF
    const commonIdf = index.idf.get("common")!;
    // "rare" appears in 2 docs → higher IDF
    const rareIdf = index.idf.get("rare")!;

    expect(rareIdf).toBeGreaterThan(commonIdf);
  });

  test("tracks which docs contain each token", () => {
    const tools = [
      makeTool({ name: "a__get", description: "get data" }),
      makeTool({ name: "b__get", description: "get info" }),
    ];

    const index = buildIndex(tools);
    const getDocs = index.tokenToDocs.get("get")!;
    expect(getDocs.size).toBe(2);
  });
});
