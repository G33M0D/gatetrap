// A minimal MCP client for the runner: starts the trap server as a child process and calls its tools over standard
// input and output, exactly as an agent would after its gate let a call through.
//
// If the trap server dies, every waiting and later request fails at once with the reason, so a case can never pass,
// hang or end silently because its trap disappeared.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

export class TrapClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (msg: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private exited: string | null = null;
  private stderr = '';

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (text) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return; // not a JSON-RPC line
      }
      const w = this.waiting.get(msg.id as number);
      if (w) {
        this.waiting.delete(msg.id as number);
        w.resolve(msg);
      }
    });
    child.stderr.on('data', (d) => (this.stderr = (this.stderr + String(d)).slice(-2000)));
    child.stdin.on('error', () => {});
    child.on('exit', (code, signal) => {
      this.exited = `trap server exited (${signal ?? `code ${code}`})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n')[0]}` : ''}`;
      for (const w of this.waiting.values()) w.reject(new Error(this.exited));
      this.waiting.clear();
    });
  }

  static async start(effectsFile: string): Promise<TrapClient> {
    const child = spawn(process.execPath, [CLI, 'trap-server'], {
      env: { ...process.env, GATETRAP_EFFECTS: effectsFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new TrapClient(child);
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gatetrap-runner', version: VERSION } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return client;
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(new Error(this.exited));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`trap server did not answer ${method} within 10 s`));
      }, 10_000);
      this.waiting.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async call(tool: string, args: Record<string, unknown>): Promise<void> {
    const msg = await this.request('tools/call', { name: tool, arguments: args });
    if (msg.error) throw new Error(`trap tool ${tool} failed: ${JSON.stringify(msg.error)}`);
    if ((msg.result as { isError?: boolean } | undefined)?.isError) throw new Error(`trap tool ${tool} reported an error`);
  }

  /** The reason the trap server stopped, if it stopped on its own; null while it runs. */
  get died(): string | null {
    return this.exited;
  }

  stop(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.stdin.end();
      setTimeout(() => this.child.kill('SIGKILL'), 2000).unref();
    });
  }
}
