// Claude Code's PreToolUse matcher rules, as documented on code.claude.com/docs/en/hooks (read 2026-10-18):
// - "*", "" or no matcher: matches every tool.
// - Only letters, digits, "_", "-", spaces, "," and "|": an exact name, or a list of exact names split on "|" or ",".
// - Any other character: an unanchored JavaScript regular expression tested against the tool name.
// So a bare "mcp__gatetrap" matches nothing, and "Edit.*" also matches "NotebookEdit".

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

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };

/** The PreToolUse matchers in a Claude Code settings object that carry at least one command hook. */
export function preToolUseMatchers(settings: unknown): (string | undefined)[] {
  const entries = ((settings as { hooks?: { PreToolUse?: HookEntry[] } })?.hooks?.PreToolUse ?? []) as HookEntry[];
  return entries.filter((e) => (e.hooks ?? []).some((h) => h.type === 'command' && h.command)).map((e) => e.matcher);
}
