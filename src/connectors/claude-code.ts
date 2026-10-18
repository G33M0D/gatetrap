// Claude Code hook connector. Runs a gate's PreToolUse hook command the way Claude Code's hooks reference describes
// (code.claude.com/docs/en/hooks, "Exit code output", read 2026-10-18) and maps the answer to an Outcome.
//
// Parsing stdout (exit code 0 rules): one JSON object, with only whitespace around it, is JSON output; output that does
// not start with "{", or starts with "{" and does not end with "}", is plain text; several lines that each parse are
// plain text unless one of them sets an output field; anything else starting with "{" and ending with "}" is a parse
// failure. A parsed object is checked against the documented PreToolUse fields.
//
// Outcome by exit code and stdout:
//                     exit 0                 exit 2   any other exit code
//   valid JSON        its fields decide      block    its fields decide (a failure when onFailure is "block")
//   invalid JSON      failure                block    failure
//   plain text, none  no decision            block    failure
// A hook that cannot start or times out is a failure. A failure lets the tool run (fail-open) unless the config sets
// onFailure "block". Fields: continue:false blocks; permissionDecision allow, deny or ask decides (the deprecated
// top-level decision "approve" or "block" maps to allow or deny when permissionDecision is absent); defer means the
// tool does not run in a non-interactive run, which is what gatetrap models, so it counts like ask; updatedInput
// replaces the tool's arguments on allow (and, an assumption the reference does not document, with no decision).
// A hook that prints an allow and leaves a process holding its output open is blocked ("suspect capture").
//
// When the config names a settings file, the hook only runs for tools one of its gating PreToolUse handlers covers
// (see matcher.ts), as in Claude Code; for any other tool the normal permission flow applies (pass-through).
//
// Approving and revoking are not part of Claude Code: every gate has its own way for a person to say yes. The gate's
// config names a command for each; it receives {"tool_name", "tool_input", "ttl_ms"} as JSON on standard input.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Attempt, Gate } from '../gate.ts';
import { claudeToolName, SERVER_NAME } from '../trap-server.ts';
import { matcherMatches, preToolUseHooks } from '../matcher.ts';

export type ClaudeCodeConfig = {
  type: 'claude-code';
  name?: string;
  /** The PreToolUse hook command, run through the shell as Claude Code does. */
  hook: { command: string; timeoutSec?: number; onFailure?: 'block' | 'continue' };
  approve: { command: string };
  revoke?: { command: string };
  /** The Claude Code settings.json whose PreToolUse matchers decide which tools the hook runs for (and GT-09). */
  settingsFile?: string;
};

type Run = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string; pipesHeld?: boolean };

/** Runs a shell command with input on stdin; on timeout the whole process group is killed. */
export function run(command: string, input: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: Run) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const killGroup = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      killGroup();
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => finish({ code: null, stdout, stderr, timedOut: false, spawnError: e.message }));
    child.on('exit', (code) => {
      // A process the hook left behind can keep its output open; give the pipes a moment, then stop waiting.
      setTimeout(() => {
        killGroup();
        finish({ code, stdout, stderr, timedOut: false, pipesHeld: true });
      }, 200).unref();
    });
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }));
    child.stdin.on('error', () => {}); // a hook that exits without reading its input is not our failure
    child.stdin.end(input);
  });
}

/** The fields a JSON output object can set; a line that sets one makes several JSON lines a parse failure. */
const OUTPUT_FIELDS = ['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'decision', 'reason', 'hookSpecificOutput', 'terminalSequence'];
const DECISIONS = ['allow', 'deny', 'ask', 'defer'];

export type Parsed = { kind: 'json'; value: Record<string, unknown> } | { kind: 'plain' } | { kind: 'invalid'; why: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** How Claude Code reads a hook's stdout (the "Exit code 0" parsing rules). */
export function parseStdout(raw: string): Parsed {
  const text = raw.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return { kind: 'plain' };
  try {
    const value = JSON.parse(text) as unknown;
    if (isObject(value)) return { kind: 'json', value };
  } catch {
    // fall through to the several-lines rule
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const parsed: unknown[] = [];
    for (const l of lines) {
      try {
        parsed.push(JSON.parse(l));
      } catch {
        return { kind: 'invalid', why: 'output starts with { and ends with } but is not valid JSON' };
      }
    }
    const setsField = parsed.some((p) => isObject(p) && OUTPUT_FIELDS.some((f) => f in p));
    return setsField ? { kind: 'invalid', why: 'several JSON lines, one of which sets an output field' } : { kind: 'plain' };
  }
  return { kind: 'invalid', why: 'output starts with { and ends with } but is not valid JSON' };
}

/** Checks the documented PreToolUse output fields; returns the problem, or null. Unknown extra fields are ignored. */
export function validateOutput(v: Record<string, unknown>): string | null {
  const types: [string, string][] = [['continue', 'boolean'], ['stopReason', 'string'], ['suppressOutput', 'boolean'], ['systemMessage', 'string']];
  for (const [k, t] of types) if (k in v && typeof v[k] !== t) return `${k} must be a ${t}`;
  if (!('hookSpecificOutput' in v)) return null;
  const h = v.hookSpecificOutput;
  if (!isObject(h)) return 'hookSpecificOutput must be an object';
  if (h.hookEventName !== 'PreToolUse') return 'hookSpecificOutput.hookEventName must be "PreToolUse"';
  if ('permissionDecision' in h && !DECISIONS.includes(h.permissionDecision as string)) return `unknown permissionDecision ${JSON.stringify(h.permissionDecision)}`;
  if ('permissionDecisionReason' in h && typeof h.permissionDecisionReason !== 'string') return 'permissionDecisionReason must be a string';
  if ('updatedInput' in h && !isObject(h.updatedInput)) return 'updatedInput must be an object';
  if ('additionalContext' in h && typeof h.additionalContext !== 'string') return 'additionalContext must be a string';
  return null;
}

/** The decision a valid JSON output makes: permissionDecision, else the deprecated top-level decision. */
function decisionOf(v: Record<string, unknown>): { decision: unknown; reason: string } {
  const h = (isObject(v.hookSpecificOutput) ? v.hookSpecificOutput : {}) as Record<string, unknown>;
  if (h.permissionDecision !== undefined) return { decision: h.permissionDecision, reason: String(h.permissionDecisionReason ?? '') };
  if (v.decision === 'block') return { decision: 'deny', reason: String(v.reason ?? '') };
  if (v.decision === 'approve') return { decision: 'allow', reason: String(v.reason ?? '') };
  return { decision: undefined, reason: '' };
}

/** What Claude Code does with valid JSON output fields. */
function applyFields(v: Record<string, unknown>, input: Record<string, unknown>, prefix: string): Attempt {
  if (v.continue === false) return { outcome: 'block', note: `${prefix}continue:false ${String(v.stopReason ?? '')}`.trim() };
  const h = (isObject(v.hookSpecificOutput) ? v.hookSpecificOutput : {}) as Record<string, unknown>;
  const { decision, reason: why } = decisionOf(v);
  const reason = why.slice(0, 160);
  const updated = isObject(h.updatedInput) ? h.updatedInput : undefined;
  switch (decision) {
    case 'allow':
      return { outcome: 'allow', note: `${prefix}${reason || 'allowed'}${updated ? ' (with updatedInput)' : ''}`, runInput: updated ?? input };
    case 'deny':
      return { outcome: 'block', note: `${prefix}${reason || 'denied'}` };
    case 'ask':
      return { outcome: 'ask', note: `${prefix}${reason || 'asked a person'}` };
    case 'defer':
      return { outcome: 'ask', note: `${prefix}deferred: in a non-interactive run the tool does not run and the calling app decides later` };
    default:
      return { outcome: 'pass-through', note: `${prefix}no decision: the normal permission flow applies${updated ? ' (with updatedInput)' : ''}`, runInput: updated ?? input };
  }
}

export class ClaudeCodeGate implements Gate {
  readonly kind = 'claude-code' as const;
  private config: ClaudeCodeConfig;
  private dir: string;
  private env: NodeJS.ProcessEnv;
  private matchers: (string | undefined)[] | null = null;

  constructor(config: ClaudeCodeConfig, caseDir: string) {
    this.config = config;
    this.dir = caseDir;
    // Each case gets its own project folder, so a gate that keeps state in the project starts clean every time.
    this.env = { ...process.env, CLAUDE_PROJECT_DIR: caseDir };
  }

  private ignored: string[] = [];

  private settingsMatchers(): (string | undefined)[] | null {
    if (!this.config.settingsFile) return null;
    if (!this.matchers) {
      let settings: unknown;
      try {
        settings = JSON.parse(readFileSync(this.config.settingsFile, 'utf8'));
      } catch (e) {
        throw new Error(`cannot read settingsFile ${this.config.settingsFile}: ${(e as Error).message}`);
      }
      const report = preToolUseHooks(settings);
      this.matchers = report.matchers;
      this.ignored = report.ignored;
    }
    return this.matchers;
  }

  private async admin(which: 'approve' | 'revoke', tool: string, input: Record<string, unknown>, ttlMs: number): Promise<boolean> {
    const cmd = which === 'approve' ? this.config.approve?.command : this.config.revoke?.command;
    if (!cmd) {
      if (which === 'revoke') return false; // a gate without revocation simply cannot pass the revocation case
      throw new Error('the gate config has no approve command');
    }
    const r = await run(cmd, JSON.stringify({ tool_name: claudeToolName(tool), tool_input: input, ttl_ms: ttlMs }), this.dir, this.env, 30_000);
    if (r.code !== 0) throw new Error(`${which} command failed (${r.timedOut ? 'timed out after 30 s' : `exit ${r.code}`}): ${r.stderr.trim().slice(0, 200)}`);
    return true;
  }

  async approve(tool: string, input: Record<string, unknown>, ttlMs: number): Promise<void> {
    await this.admin('approve', tool, input, ttlMs);
  }

  revoke(tool: string, input: Record<string, unknown>): Promise<boolean> {
    return this.admin('revoke', tool, input, 0);
  }

  async attempt(tool: string, input: Record<string, unknown>, toolUseId: string): Promise<Attempt> {
    const toolName = claudeToolName(tool);
    const matchers = this.settingsMatchers();
    if (matchers && !matchers.some((m) => matcherMatches(m, toolName))) {
      return { outcome: 'pass-through', note: 'no PreToolUse matcher in the settings file covers this tool, so Claude Code would not run the hook', runInput: input };
    }
    const event = {
      session_id: 'gatetrap-session',
      prompt_id: randomUUID(),
      transcript_path: '/dev/null',
      cwd: this.dir,
      scratchpad_dir: this.dir,
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: input,
      tool_use_id: toolUseId,
      mcp_server: { name: SERVER_NAME, source: 'project' },
    };
    const timeoutMs = (this.config.hook.timeoutSec ?? 600) * 1000;
    const r = await run(this.config.hook.command, JSON.stringify(event), this.dir, this.env, timeoutMs);
    const blockOnFailure = this.config.hook.onFailure === 'block';
    const failure = (why: string): Attempt =>
      blockOnFailure
        ? { outcome: 'block', note: `${why}; blocked because onFailure is "block"` }
        : { outcome: 'fail-open', note: `${why}; Claude Code runs the tool anyway`, runInput: input };

    if (r.spawnError) return failure(`hook could not start (${r.spawnError})`);
    if (r.timedOut) return failure(`hook timed out after ${timeoutMs / 1000} s`);
    const parsed = parseStdout(r.stdout);
    if (r.code === 2) {
      // The reason is stderr, unless the hook also printed valid JSON that makes a blocking decision.
      let reason = r.stderr.trim();
      if (parsed.kind === 'json' && validateOutput(parsed.value) === null) {
        const d = decisionOf(parsed.value);
        if (parsed.value.continue === false) reason = String(parsed.value.stopReason ?? '') || reason;
        else if (d.decision === 'deny' && d.reason) reason = d.reason;
      }
      return { outcome: 'block', note: `exit 2: ${reason.slice(0, 160) || 'no reason given'}` };
    }
    if (parsed.kind === 'invalid') return failure(`hook printed invalid output (${parsed.why})`);
    if (parsed.kind === 'json') {
      const problem = validateOutput(parsed.value);
      if (problem) return failure(`hook output failed validation (${problem})`);
    }
    let decided: Attempt;
    if (r.code !== 0) {
      if (parsed.kind !== 'json' || blockOnFailure) return failure(`hook exited ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().split('\n')[0]?.slice(0, 160)}` : ''}`);
      decided = applyFields(parsed.value, input, `exit ${r.code} ignored, the JSON decides: `);
    } else if (parsed.kind === 'json') {
      decided = applyFields(parsed.value, input, '');
    } else {
      decided = { outcome: 'pass-through', note: 'exit 0 with no decision: the normal permission flow applies', runInput: input };
    }
    if (decided.outcome === 'allow' && r.pipesHeld) {
      return { outcome: 'block', note: 'the hook allowed, then left a process holding its output open; Claude Code blocks this ("refusing to honor the suspect capture")' };
    }
    return decided;
  }

  async coverage(tools: string[]): Promise<{ covered: string[]; missed: string[]; notes: string[] } | null> {
    const matchers = this.settingsMatchers();
    if (!matchers) return null;
    const names = tools.map(claudeToolName);
    const covered = names.filter((n) => matchers.some((m) => matcherMatches(m, n)));
    return { covered, missed: names.filter((n) => !covered.includes(n)), notes: this.ignored };
  }

  async close(): Promise<void> {}
}
