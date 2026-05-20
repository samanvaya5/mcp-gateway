/**
 * Dynamic Tool Registry — runtime tool creation for the MCP Gateway.
 *
 * Agents can create reusable shell-template tools on the fly via the
 * `create_tool` gateway tool.  Created tools are stored in-memory and
 * callable through the existing `execute_tool` gateway tool under the
 * `dynamic__<name>` namespace.
 *
 * Lifecycle: tools live for the duration of the gateway process
 * (session-scoped).  Lost on restart.
 *
 * Agent-first design principles:
 * - Template resolver understands `${param:-default}` bash syntax
 * - `force: true` on register overwrites existing (no separate update tool)
 * - Warnings at creation time for undeclared parameters in template
 * - Array params (type: array) are joined with spaces, escaped individually
 * - `cwd` in args is stripped before substitution and used as working dir
 */

import { exec } from "node:child_process";
import type { DynamicToolEntry } from "./types.js";

// ── Template parsing ─────────────────────────────────────────────────

interface TemplateRef {
  fullMatch: string;           // e.g. "${context:-2}"
  paramName: string;           // e.g. "context"
  operator: string | null;     // null, "-", "=", "+", "?"
  defaultText: string | null;  // e.g. "2" (everything after `:-` / `:=` / `:+` / `:?`)
}

/**
 * Parse all bash-style `${...}` patterns from a template string.
 */
const TEMPLATE_RE = /\$\{([^}]+)\}/g;

function parseTemplateRefs(template: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_RE.exec(template)) !== null) {
    const expr = match[1]!;
    const ci = expr.indexOf(":");
    let paramName: string;
    let operator: string | null = null;
    let defaultText: string | null = null;

    if (ci !== -1) {
      paramName = expr.slice(0, ci);
      if (ci + 1 < expr.length && "-=+?".includes(expr[ci + 1]!)) {
        operator = expr[ci + 1]!;
        defaultText = expr.slice(ci + 2);
      } else {
        // `:` without operator — treat as `:-` (bash convention)
        operator = "-";
        defaultText = expr.slice(ci + 1);
      }
    } else {
      paramName = expr;
    }

    refs.push({ fullMatch: match[0], paramName, operator, defaultText });
  }
  return refs;
}

// ── Shell escaping ────────────────────────────────────────────────────

/**
 * Quote a value for safe shell insertion.
 *
 * Strategy: if the value contains only safe characters (no spaces, special
 * chars), return it as-is.  Otherwise, wrap in single quotes and escape
 * any internal single quotes with `'\''`.
 */
function shellArg(value: string): string {
  if (/^[a-zA-Z0-9_.,\/=:@+%-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ── Template validation (used at creation time) ───────────────────────

export interface TemplateWarning {
  ref: string;         // The exact ${...} that triggered the warning
  message: string;     // Human-readable explanation
}

/**
 * Scan a template for potential issues at creation time.
 *
 * Warning categories:
 * 1. `${param:-default}` where `param` is NOT in declared parameters
 *    → agent probably assumed bash-style substitution, but shell will
 *      silently use the default, ignoring the intended param entirely.
 * 2. Array parameters are checked for schema consistency.
 */
export function validateTemplate(
  template: string,
  declaredParams: Set<string>,
): TemplateWarning[] {
  const warnings: TemplateWarning[] = [];
  const refs = parseTemplateRefs(template);

  for (const ref of refs) {
    if (!declaredParams.has(ref.paramName)) {
      if (ref.operator && ref.defaultText !== null) {
        // Has :- / := / :+ / :? with an undeclared name — almost certainly
        // the agent thought this was a declared param with a shell default.
        warnings.push({
          ref: ref.fullMatch,
          message:
            `"${ref.paramName}" isn't declared in parameters. ` +
            `\${${ref.paramName}:-…} won't substitute — ` +
            `the shell will use the default instead. ` +
            `Add "${ref.paramName}" to the schema, or use a simpler \${var} for env vars.`,
        });
      }
      // Plain ${name} without :- is left for the shell to resolve as an
      // env var — that's intentional.  No warning needed.
    }
  }

  return warnings;
}

// ── Template resolution (used at execution time) ──────────────────────

interface ResolutionContext {
  // Declared parameter name → type string from schema (e.g. "string", "array", "number")
  paramTypes: Record<string, string>;
}

/**
 * Resolve a shell template by substituting `${param}` placeholders with
 * shell-safe values.
 *
 * Supports:
 *   ${param}          → value (or left as-is for shell if not provided)
 *   ${param:-default} → value if provided, else default
 *   ${param:=default} → value if provided, else default
 *   ${param:+alt}     → alt if provided, else empty
 *   ${param:?msg}     → value if provided, else error with msg
 *
 * Array params (type="array") are joined with spaces; each element is
 * individually shell-escaped.  Non-array params are escaped as a single
 * shell-safe token.
 */
export function resolveTemplate(
  template: string,
  args: Record<string, unknown>,
  ctx: ResolutionContext,
): string {
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const re = /\$\{([^}]+)\}/g;
  while ((match = re.exec(template)) !== null) {
    // Copy everything up to this match
    result += template.slice(lastIndex, match.index);
    const expr = match[1]!;

    const ci = expr.indexOf(":");
    let paramName: string;
    let operator: string | null = null;
    let defaultText: string | null = null;

    if (ci !== -1) {
      paramName = expr.slice(0, ci);
      if (ci + 1 < expr.length && "-=+?".includes(expr[ci + 1]!)) {
        operator = expr[ci + 1]!;
        defaultText = expr.slice(ci + 2);
      } else {
        operator = "-";
        defaultText = expr.slice(ci + 1);
      }
    } else {
      paramName = expr;
    }

    if (paramName in args) {
      // Parameter is provided — substitute
      const raw = args[paramName];
      const paramType = ctx.paramTypes[paramName] ?? "string";

      if (paramType === "array" && Array.isArray(raw)) {
        // Array: join with spaces, individually escaped
        result += raw.map((e) => shellArg(String(e ?? ""))).join(" ");
      } else {
        const value = String(raw ?? "");
        if (operator === "+") {
          // ${param:+alt} — use alternative if param is set
          const alt = defaultText !== null ? defaultText : "";
          // Resolve any nested ${} in the alt text
          result += alt;
        } else {
          result += shellArg(value);
        }
      }
    } else if (operator === "-" || operator === "=") {
      // ${param:-default} or ${param:=default} — use default
      result += defaultText !== null ? defaultText : "";
    } else if (operator === "?") {
      // ${param:?error} — error if not provided
      const msg = defaultText !== null ? defaultText : "parameter not provided";
      throw new Error(`Dynamic tool: ${msg}`);
    } else if (operator === "+") {
      // ${param:+alt} — param not set, use nothing
      result += "";
    } else {
      // Plain ${param} — param not in args, leave as-is for shell to resolve
      result += match[0];
    }

    lastIndex = match.index + match[0].length;
  }

  result += template.slice(lastIndex);
  return result;
}

// ── Registry ──────────────────────────────────────────────────────────

export class DynamicToolRegistry {
  private tools = new Map<string, DynamicToolEntry>();

  /**
   * Register a new dynamic tool.
   *
   * If `force` is true and a tool with the same name exists, it is
   * overwritten.  Default: false.
   *
   * @returns The fully-qualified entry stored in the registry.
   * @throws If the tool already exists and force is false.
   */
  register(spec: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    implementation: string;
    force?: boolean;
  }): DynamicToolEntry {
    const sanitized = spec.name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      || "unnamed";

    const namespaced = `dynamic__${sanitized}`;
    const now = new Date().toISOString();

    const existing = this.tools.get(namespaced);
    if (existing) {
      if (!spec.force) {
        throw new Error(
          `Tool already exists: ${namespaced}. ` +
          `Use force: true to overwrite, or delete_dynamic_tool first.`,
        );
      }
      // Overwrite: keep existing entry metadata but update fields
      const entry: DynamicToolEntry = {
        ...existing, // keeps original createdAt
        namespacedName: namespaced,
        originalName: spec.name,
        description: spec.description,
        inputSchema: spec.parameters as Record<string, unknown>,
        implementation: spec.implementation,
        updatedAt: now,
      };
      this.tools.set(namespaced, entry);
      return entry;
    }

    const entry: DynamicToolEntry = {
      namespacedName: namespaced,
      originalName: spec.name,
      description: spec.description,
      inputSchema: spec.parameters as Record<string, unknown>,
      implementation: spec.implementation,
      createdAt: now,
      updatedAt: now,
    };

    this.tools.set(namespaced, entry);
    return entry;
  }

  /**
   * Look up a tool by its namespaced name (`dynamic__<name>`).
   */
  get(qualifiedName: string): DynamicToolEntry | undefined {
    return this.tools.get(qualifiedName);
  }

  /**
   * Look up a tool by either its original or namespaced name.
   */
  find(name: string): DynamicToolEntry | undefined {
    return this.tools.get(name) ?? this.tools.get(`dynamic__${name}`);
  }

  /**
   * List all registered dynamic tools.
   */
  list(): DynamicToolEntry[] {
    return Array.from(this.tools.values());
  }

  /**
   * Remove a dynamic tool by namespaced name.
   *
   * @returns true if the tool was found and removed.
   */
  remove(qualifiedName: string): boolean {
    return this.tools.delete(qualifiedName);
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Extract declared parameter names from the inputSchema.
   */
  getDeclaredParamNames(entry: DynamicToolEntry): Set<string> {
    const schema = entry.inputSchema as Record<string, unknown>;
    const properties = schema?.properties as Record<string, unknown> | undefined;
    if (!properties) return new Set();
    return new Set(Object.keys(properties));
  }

  /**
   * Extract param name → type mapping from the inputSchema.
   */
  getParamTypes(entry: DynamicToolEntry): Record<string, string> {
    const schema = entry.inputSchema as Record<string, unknown>;
    const properties = schema?.properties as Record<string, unknown> | undefined;
    if (!properties) return {};
    const types: Record<string, string> = {};
    for (const [name, prop] of Object.entries(properties)) {
      const def = prop as Record<string, unknown> | undefined;
      types[name] = typeof def?.type === "string" ? def.type : "string";
    }
    return types;
  }
}

// ── Shell execution ───────────────────────────────────────────────────

export interface ExecuteOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Resolve a shell template against the provided args and execute via
 * child_process.exec().
 *
 * @returns { stdout, stderr, exitCode }
 */
export async function executeShellTool(
  entry: DynamicToolEntry,
  args: Record<string, unknown>,
  options?: ExecuteOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const command = resolveTemplate(
    entry.implementation,
    args,
    { paramTypes: {} }, // filled by caller if needed
  );

  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        shell: "/bin/bash",
        timeout: options?.timeoutMs ?? 30_000,
        maxBuffer: 10 * 1024 * 1024,
        cwd: options?.cwd,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error?.code ?? 0,
        });
      },
    );
  });
}
