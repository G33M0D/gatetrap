// Claude Code's PreToolUse matcher rules, as documented on code.claude.com/docs/en/hooks (read 2026-10-18):
// - "*", "" or no matcher: matches every tool.
// - Only letters, digits, "_", "-", spaces, "," and "|": an exact name, or a list of exact names split on "|" or ",".
// - Any other character: an unanchored JavaScript regular expression tested against the tool name.
// So a bare "mcp__gatetrap" matches nothing, and "Edit.*" also matches "NotebookEdit".
//
// Which handlers can act as a gate: only command hooks that run synchronously. "disableAllHooks": true turns every hook
// off; an async or asyncRewake hook cannot block or decide anything; a handler with an "if" rule runs only when that
// permission rule matches, which gatetrap does not evaluate, so it is never counted as covering a tool. Counting
// uncertain coverage as protection would be the dangerous mistake for a gate tester.

export function matcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((m) => m.trim())
      .filter(Boolean)
      .includes(toolName);
  }
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

type Handler = { type?: string; command?: string; async?: boolean; asyncRewake?: boolean; if?: string };
type HookEntry = { matcher?: string; hooks?: Handler[] };

export type HookReport = { matchers: (string | undefined)[]; ignored: string[] };

/** The PreToolUse matchers that carry at least one handler able to gate a tool call, and why others were ignored. */
export function preToolUseHooks(settings: unknown): HookReport {
  const s = settings as { disableAllHooks?: boolean; hooks?: { PreToolUse?: HookEntry[] } } | null;
  if (s?.disableAllHooks === true) return { matchers: [], ignored: ['disableAllHooks is true, so no hook runs'] };
  const matchers: (string | undefined)[] = [];
  const ignored: string[] = [];
  for (const entry of (s?.hooks?.PreToolUse ?? []) as HookEntry[]) {
    let gating = false;
    for (const h of entry.hooks ?? []) {
      const label = `matcher ${JSON.stringify(entry.matcher ?? '*')}`;
      if (h.type !== 'command' || !h.command) continue;
      if (h.async === true || h.asyncRewake === true) ignored.push(`${label}: an async hook cannot block`);
      else if (typeof h.if === 'string') ignored.push(`${label}: an "if" rule (${h.if}) is not evaluated, so it is not counted`);
      else gating = true;
    }
    if (gating) matchers.push(entry.matcher);
  }
  return { matchers, ignored };
}

/** The matchers of preToolUseHooks, for callers that only need them. */
export function preToolUseMatchers(settings: unknown): (string | undefined)[] {
  return preToolUseHooks(settings).matchers;
}
