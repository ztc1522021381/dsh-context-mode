/**
 * Type surface for dsh-context-mode.
 *
 * The host plugin contributes no services and no model-facing tools; it only
 * registers a prompt section and a `tools/pre-execute` listener. The exports
 * below exist so a TypeScript consumer can import the pure routing helpers
 * (used by the self-test) without pulling in Cordis types.
 */

export interface ContextModeConfig {
  /** Master switch. `false` disables both tiers entirely. */
  enabled?: boolean
  /** Tier 1: tools whose flood-prone calls are denied before execution. */
  denyTools?: string[]
  /** Tier 2: tools whose oversized results are replaced with a summary. */
  truncateTools?: string[]
  /** Tier 2 threshold: rendered content above this is truncated. */
  maxResultBytes?: number
  /** `pwsh` commands shorter than this (UTF-8 bytes) skip Tier 1 evaluation. */
  minCommandBytes?: number
  /** `read` calls on files larger than this get a Tier 1 nudge. */
  readThresholdBytes?: number
  /** Also intercept `subagent` (off by default: high prompt cost). */
  interceptSubagent?: boolean
  /** Sort order of the routing section; `MCP_SERVERS` is 3100. */
  sectionOrder?: number
  /** Override the detected MCP serverName. */
  serverName?: string
}

/** Result of evaluating one shell command: a deny reason, or `null` to allow. */
export type ShellDecision = string | null

/** One rendered tool-result content block, as `tools/post-execute` sees it. */
export interface ToolContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

/** Tier-1 deny: the tool never runs. */
export interface DenyDecision {
  kind: 'deny'
  reason: string
}

/** Tier-2 truncate: the tool ran, but the model sees a summary instead. */
export interface TruncateDecision {
  kind: 'accept'
  content: ToolContentBlock[]
}

/**
 * Whether a shell command's output is structurally bounded (one line, or a
 * silent success) and therefore safe to let through.
 */
export declare function isStructurallyBounded(command: string): boolean

/** Remove heredocs and quoted content so regexes only see command tokens. */
export declare function stripQuotedContent(command: string): string

/**
 * Tier 1: should this command be denied outright? Only covers categories whose
 * sandbox replacement is a strict superset (curl/wget, inline HTTP, build
 * tools). Commands that merely produce large output return `null` so Tier 2
 * can truncate them after they run.
 */
export declare function evaluateDeny(prefix: string, command: string): ShellDecision

/** Legacy alias of {@link evaluateDeny}. */
export declare function evaluateShell(prefix: string, command: string): ShellDecision

/** Build the routing section text for a given MCP tool prefix. */
export declare function buildRoutingBlock(prefix: string): string

/** Detect the live `mcp__<server>__` prefix from a ToolRuntime listing. */
export declare function detectToolPrefix(tools: unknown): string | null

/** UTF-8 byte size of a rendered tool-result content array. */
export declare function measureContent(content: readonly unknown[] | undefined): number

/** Per-tool advice for what to do instead of reading the truncated output. */
export declare function truncateHint(prefix: string, toolName: string): string

/** The summary text that replaces an oversized tool result. */
export declare function truncationSummary(
  prefix: string,
  toolName: string,
  bytes: number,
  hint: string,
): string
