// Generic connector for any gate: one long-running process per test case that reads one JSON line per step on
// standard input and answers one JSON line on standard output.
//
//   request:  {"protocol":"gatetrap/v1","op":"approve"|"revoke"|"attempt","tool":"delete_record",
//              "input":{...},"ttlMs":60000,"toolUseId":"..."}
//   response: {"decision":"allow"|"deny"|"ask"|"error","reason":"..."}   (approve and revoke answer {"ok":true})
//
// The gate never runs the action itself: on "allow", gatetrap calls the trap tool. An "error", a crash or no answer
// within the timeout is reported as fail-open only if the config says the platform runs actions on gate failure.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Attempt, Gate } from '../gate.ts';

export type JsonlConfig = {
  type: 'jsonl';
  name?: string;
  command: string;
  args?: string[];
  timeoutSec?: number;
  /** What the platform around the gate does when the gate fails: "run" (fail-open) or "block" (the default). */
  onFailure?: 'run' | 'block';
};

export class JsonlGate implements Gate {
  private child: ChildProcessWithoutNullStreams;
  private config: JsonlConfig;
  private queue: ((line: string | null) => void)[] = [];
  private dead = false;

  constructor(config: JsonlConfig, caseDir: string) {
    this.config = config;
    this.child = spawn(config.command, config.args ?? [], { cwd: caseDir, env: { ...process.env, GATETRAP_CASE_DIR: caseDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.child.stdout }).on('line', (l) => this.queue.shift()?.(l));
    this.child.on('exit', () => {
      this.dead = true;
      for (const w of this.queue.splice(0)) w(null);
    });
    this.child.stdin.on('error', () => {});
  }

  private send(msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (this.dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), (this.config.timeoutSec ?? 30) * 1000);
      this.queue.push((line) => {
        clearTimeout(timer);
        if (line === null) return resolve(null);
        try {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } catch {
          resolve(null);
        }
      });
      this.child.stdin.write(`${JSON.stringify({ protocol: 'gatetrap/v1', ...msg })}\n`);
    });
  }

  async approve(tool: string, input: Record<string, unknown>, ttlMs: number): Promise<void> {
    const r = await this.send({ op: 'approve', tool, input, ttlMs });
    if (!r?.ok) throw new Error(`gate did not accept the approval: ${JSON.stringify(r)}`);
  }

  async revoke(tool: string, input: Record<string, unknown>): Promise<void> {
    await this.send({ op: 'revoke', tool, input });
  }

  async attempt(tool: string, input: Record<string, unknown>, toolUseId: string): Promise<Attempt> {
    const r = await this.send({ op: 'attempt', tool, input, toolUseId });
    const failed = (why: string): Attempt =>
      this.config.onFailure === 'run' ? { outcome: 'fail-open', note: `${why}; the platform runs actions when the gate fails`, runInput: input } : { outcome: 'block', note: why };
    if (!r) return failed('no valid answer from the gate');
    const reason = String(r.reason ?? '').slice(0, 160);
    switch (r.decision) {
      case 'allow':
        return { outcome: 'allow', note: reason || 'allowed', runInput: input };
      case 'deny':
        return { outcome: 'block', note: reason || 'denied' };
      case 'ask':
        return { outcome: 'ask', note: reason || 'asked a person' };
      default:
        return failed(`gate answered ${JSON.stringify(r.decision)}`);
    }
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise((r) => setTimeout(r, 50));
    if (!this.dead) this.child.kill();
  }
}
