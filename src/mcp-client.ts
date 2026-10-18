// A minimal MCP client for the runner: starts the trap server as a child process and calls its tools over standard
// input and output, exactly as an agent would after its gate let a call through.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

export class TrapClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private waiting = new Map<number, (msg: Record<string, unknown>) => void>();

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (text) => {
      try {
        const msg = JSON.parse(text) as Record<string, unknown>;
        const done = this.waiting.get(msg.id as number);
        if (done) {
          this.waiting.delete(msg.id as number);
          done(msg);
        }
      } catch {
        // ignore anything that is not a JSON-RPC line
      }
    });
  }

  static async start(effectsFile: string): Promise<TrapClient> {
    const child = spawn(process.execPath, [CLI, 'trap-server'], {
      env: { ...process.env, GATETRAP_EFFECTS: effectsFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new TrapClient(child);
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gatetrap-runner', version: '0.1.0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return client;
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`trap server did not answer ${method} within 10 s`));
      }, 10_000);
      this.waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async call(tool: string, args: Record<string, unknown>): Promise<void> {
    const msg = await this.request('tools/call', { name: tool, arguments: args });
    if (msg.error) throw new Error(`trap tool ${tool} failed: ${JSON.stringify(msg.error)}`);
  }

  async listTools(): Promise<string[]> {
    const msg = await this.request('tools/list', {});
    return ((msg.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.stdin.end();
      setTimeout(() => this.child.kill(), 2000).unref();
    });
  }
}
