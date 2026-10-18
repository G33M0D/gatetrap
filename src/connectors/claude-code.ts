// Claude Code hook connector. Runs a gate's PreToolUse hook command exactly as Claude Code documents it
// (code.claude.com/docs/en/hooks, read 2026-10-18) and maps the answer to an Outcome:
// - exit 2: blocked (stderr is the reason; JSON cannot override it)
// - exit 0 with one JSON object: hookSpecificOutput.permissionDecision allow / deny / ask / defer;
//   updatedInput, if present, replaces the tool's arguments
// - exit 0 without a decision: the normal permission flow applies (pass-through)
// - any other exit code, a timeout, or a hook that cannot start: the tool call proceeds (fail-open),
//   unless the hook is configured with onFailure "block"
//
// Approving and revoking are not part of Claude Code: every gate has its own way for a person to say yes. The gate's
// config names a command for each; it receives {"tool_name", "tool_input", "ttl_ms"} as JSON on standard input.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Attempt, Gate } from '../gate.ts';
import { claudeToolName } from '../trap-server.ts';
import { matcherMatches, preToolUseMatchers } from '../matcher.ts';

export type ClaudeCodeConfig = {
  type: 'claude-code';
  name?: string;
  /** The PreToolUse hook command, run through the shell as Claude Code does. */
  hook: { command: string; timeoutSec?: number; onFailure?: 'block' };
  approve: { command: string };
  revoke?: { command: string };
  /** A Claude Code settings.json to check matcher coverage against the trap tools. */
  settingsFile?: string;
};

type Run = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string };

function run(command: string, input: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {}); // a hook that exits without reading its input is not our failure
    child.stdin.end(input);
  });
}

export class ClaudeCodeGate implements Gate {
  private config: ClaudeCodeConfig;
  private dir: string;
  private env: NodeJS.ProcessEnv;

  constructor(config: ClaudeCodeConfig, caseDir: string) {
    this.config = config;
    this.dir = caseDir;
    // Each case gets its own project folder, so a gate that keeps state in the project starts clean every time.
    this.env = { ...process.env, CLAUDE_PROJECT_DIR: caseDir };
  }

  private async admin(which: 'approve' | 'revoke', tool: string, input: Record<string, unknown>, ttlMs: number): Promise<void> {
    const cmd = which === 'approve' ? this.config.approve?.command : this.config.revoke?.command;
    if (!cmd) {
      if (which === 'revoke') return; // a gate without revocation simply cannot pass the revocation case
      throw new Error('the gate config has no approve command');
    }
    const r = await run(cmd, JSON.stringify({ tool_name: claudeToolName(tool), tool_input: input, ttl_ms: ttlMs }), this.dir, this.env, 30_000);
    if (r.code !== 0) throw new Error(`${which} command failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
  }

  approve(tool: string, input: Record<string, unknown>, ttlMs: number): Promise<void> {
    return this.admin('approve', tool, input, ttlMs);
  }

  revoke(tool: string, input: Record<string, unknown>): Promise<void> {
    return this.admin('revoke', tool, input, 0);
  }

  async attempt(tool: string, input: Record<string, unknown>, toolUseId: string): Promise<Attempt> {
    const event = {
      session_id: 'gatetrap-session',
      transcript_path: '/dev/null',
      cwd: this.dir,
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: claudeToolName(tool),
      tool_input: input,
      tool_use_id: toolUseId,
    };
    const timeoutMs = (this.config.hook.timeoutSec ?? 600) * 1000;
    const r = await run(this.config.hook.command, JSON.stringify(event), this.dir, this.env, timeoutMs);
    const failOpen = (why: string): Attempt =>
      this.config.hook.onFailure === 'block'
        ? { outcome: 'block', note: `${why}; blocked because onFailure is "block"` }
        : { outcome: 'fail-open', note: `${why}; Claude Code runs the tool anyway`, runInput: input };

    if (r.spawnError) return failOpen(`hook could not start (${r.spawnError})`);
    if (r.timedOut) return failOpen(`hook timed out after ${timeoutMs / 1000} s`);
    if (r.code === 2) return { outcome: 'block', note: `exit 2: ${r.stderr.trim().slice(0, 160) || 'no reason given'}` };
    if (r.code !== 0) return failOpen(`hook exited ${r.code}: ${r.stderr.trim().split('\n')[0]?.slice(0, 160) ?? ''}`);

    let out: Record<string, unknown> | null = null;
    const text = r.stdout.trim();
    if (text.startsWith('{')) {
      try {
        out = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return failOpen('hook printed invalid JSON');
      }
    }
    const specific = (out?.hookSpecificOutput ?? {}) as Record<string, unknown>;
    const decision = specific.permissionDecision;
    const reason = String(specific.permissionDecisionReason ?? '').slice(0, 160);
    const runInput = (specific.updatedInput as Record<string, unknown> | undefined) ?? input;
    if (out?.continue === false) return { outcome: 'block', note: `continue:false ${String(out.stopReason ?? '')}` };
    switch (decision) {
      case 'allow':
        return { outcome: 'allow', note: reason || 'allowed', runInput };
      case 'deny':
        return { outcome: 'block', note: reason || 'denied' };
      case 'ask':
        return { outcome: 'ask', note: reason || 'asked a person' };
      case 'defer':
        return { outcome: 'pass-through', note: 'deferred to the normal permission flow', runInput };
      default:
        return { outcome: 'pass-through', note: 'exit 0 with no decision: the normal permission flow applies', runInput };
    }
  }

  async coverage(tools: string[]): Promise<{ covered: string[]; missed: string[] } | null> {
    if (!this.config.settingsFile) return null;
    const settings = JSON.parse(readFileSync(this.config.settingsFile, 'utf8')) as unknown;
    const matchers = preToolUseMatchers(settings);
    const names = tools.map(claudeToolName);
    const covered = names.filter((n) => matchers.some((m) => matcherMatches(m, n)));
    return { covered, missed: names.filter((n) => !covered.includes(n)) };
  }

  async close(): Promise<void> {}
}
