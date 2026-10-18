// Generic connector for any gate: one long-running process per test case that reads one JSON line per step on
// standard input and answers one JSON line on standard output.
//
//   request:  {"protocol":"gatetrap/v1","op":"approve"|"revoke"|"attempt","tool":"delete_record",
//              "input":{...},"ttlMs":60000,"toolUseId":"..."}
//   response: {"decision":"allow"|"deny"|"ask","reason":"..."}   (approve and revoke answer {"ok":true})
//
// The gate never runs the action itself: on "allow", gatetrap calls the trap tool. A crash, an unknown decision or no
// answer within the timeout is a gate failure. By default a failure lets the action run (fail-open), the worst case
// for an unknown platform; set onFailure "block" when the platform around the gate blocks on failure.
//
// Replies are matched to requests in order. A request that timed out keeps its place, so its late reply is read and
// discarded instead of being taken as the answer to the next request.

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
  /** What the platform around the gate does when the gate fails: "run" (fail-open, the default) or "block". */
  onFailure?: 'run' | 'block';
};

type Waiter = { deliver: (line: string | null) => void };

export class JsonlGate implements Gate {
  readonly kind = 'jsonl' as const;
  private child: ChildProcessWithoutNullStreams;
  private config: JsonlConfig;
  private queue: Waiter[] = [];
  private dead = false;

  constructor(config: JsonlConfig, caseDir: string) {
    this.config = config;
    this.child = spawn(config.command, config.args ?? [], { cwd: caseDir, env: { ...process.env, GATETRAP_CASE_DIR: caseDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.child.stdout }).on('line', (l) => this.queue.shift()?.deliver(l));
    this.child.on('exit', () => {
      this.dead = true;
      for (const w of this.queue.splice(0)) w.deliver(null);
    });
    this.child.on('error', () => {
      this.dead = true;
      for (const w of this.queue.splice(0)) w.deliver(null);
    });
    this.child.stdin.on('error', () => {});
  }

  private send(msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (this.dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      let answered = false;
      const timer = setTimeout(() => {
        answered = true; // the waiter stays queued, so a late reply is consumed here and not by the next request
        resolve(null);
      }, (this.config.timeoutSec ?? 30) * 1000);
      this.queue.push({
        deliver: (line) => {
          clearTimeout(timer);
          if (answered) return;
          answered = true;
          if (line === null) return resolve(null);
          try {
            const v = JSON.parse(line) as unknown;
            resolve(typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
          } catch {
            resolve(null);
          }
        },
      });
      this.child.stdin.write(`${JSON.stringify({ protocol: 'gatetrap/v1', ...msg })}\n`);
    });
  }

  async approve(tool: string, input: Record<string, unknown>, ttlMs: number): Promise<void> {
    const r = await this.send({ op: 'approve', tool, input, ttlMs });
    if (!r?.ok) throw new Error(`gate did not accept the approval: ${JSON.stringify(r)}`);
  }

  async revoke(tool: string, input: Record<string, unknown>): Promise<boolean> {
    const r = await this.send({ op: 'revoke', tool, input });
    return r !== null;
  }

  async attempt(tool: string, input: Record<string, unknown>, toolUseId: string): Promise<Attempt> {
    const r = await this.send({ op: 'attempt', tool, input, toolUseId });
    const failed = (why: string): Attempt =>
      this.config.onFailure === 'block' ? { outcome: 'block', note: `${why}; blocked because onFailure is "block"` } : { outcome: 'fail-open', note: `${why}; the platform runs the action when the gate fails`, runInput: input };
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
