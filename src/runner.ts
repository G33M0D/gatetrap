// Runs the numbered cases against one gate. For every case: a fresh folder, a fresh trap server, a fresh gate
// connection; the steps play out; then the trap's effects file is counted. The count, not the gate's own words,
// decides pass or fail.

import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TrapClient } from './mcp-client.ts';
import { RUNS } from './gate.ts';
import type { Attempt, Gate } from './gate.ts';
import { ClaudeCodeGate } from './connectors/claude-code.ts';
import type { ClaudeCodeConfig } from './connectors/claude-code.ts';
import { JsonlGate } from './connectors/jsonl.ts';
import type { JsonlConfig } from './connectors/jsonl.ts';

export type GateConfig = ClaudeCodeConfig | JsonlConfig;

type Step =
  | { op: 'approve'; tool: string; input: Record<string, unknown>; ttlMs?: number }
  | { op: 'revoke'; tool: string; input: Record<string, unknown> }
  | { op: 'attempt'; tool: string; input: Record<string, unknown>; times?: number; concurrent?: boolean; sameToolUseId?: boolean }
  | { op: 'wait'; ms: number }
  | { op: 'coverage'; tools: string[] };

export type Case = { id: string; title: string; why: string; sources: { title: string; url: string; date: string }[]; steps: Step[]; expectEffects?: number };

export type CaseResult = {
  id: string;
  title: string;
  verdict: 'pass' | 'fail' | 'not-run' | 'inconclusive' | 'error';
  expected: string;
  observed: string;
  log: string[];
};

export const CASES_DIR = fileURLToPath(new URL('../cases/', import.meta.url));

export function loadCases(filter?: string[]): Case[] {
  return readdirSync(CASES_DIR)
    .filter((f) => /^GT-\d+-.*\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')) as Case)
    .filter((c) => !filter?.length || filter.includes(c.id));
}

function makeGate(config: GateConfig, dir: string): Gate {
  if (config.type === 'claude-code') return new ClaudeCodeGate(config, dir);
  if (config.type === 'jsonl') return new JsonlGate(config, dir);
  throw new Error(`unknown gate type ${(config as { type: string }).type}`);
}

const BIG = 'x'.repeat(200 * 1024);

function fill(input: Record<string, unknown>, marker: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input).replaceAll('"$MARKER"', JSON.stringify(marker)).replaceAll('"$BIG"', JSON.stringify(BIG))) as Record<string, unknown>;
}

function countEffects(file: string, marker: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((l) => (JSON.parse(l) as { marker: string | null }).marker === marker).length;
}

async function runCase(c: Case, config: GateConfig): Promise<CaseResult> {
  const dir = mkdtempSync(join(tmpdir(), 'gatetrap-'));
  const effects = join(dir, 'effects.jsonl');
  const marker = `gt-${c.id}-${randomBytes(6).toString('hex')}`;
  const log: string[] = [];
  const expected = c.expectEffects === undefined ? 'every risky tool covered' : `${c.expectEffects} action(s) run`;
  let trap: TrapClient | null = null;
  let gate: Gate | null = null;
  try {
    trap = await TrapClient.start(effects);
    gate = makeGate(config, dir);
    let n = 0;
    for (const step of c.steps) {
      if (step.op === 'wait') {
        await new Promise((r) => setTimeout(r, step.ms));
        log.push(`waited ${step.ms} ms`);
      } else if (step.op === 'approve') {
        await gate.approve(step.tool, fill(step.input, marker), step.ttlMs ?? 60_000);
        log.push(`person approved ${step.tool} (valid ${step.ttlMs ?? 60_000} ms)`);
      } else if (step.op === 'revoke') {
        await gate.revoke(step.tool, fill(step.input, marker));
        log.push(`person withdrew approval for ${step.tool}`);
      } else if (step.op === 'coverage') {
        const cov = gate.coverage ? await gate.coverage(step.tools) : null;
        if (!cov) return { id: c.id, title: c.title, verdict: 'not-run', expected, observed: 'no settings file in the gate config', log };
        log.push(`covered: ${cov.covered.join(', ') || 'none'}`, `missed: ${cov.missed.join(', ') || 'none'}`);
        return { id: c.id, title: c.title, verdict: cov.missed.length ? 'fail' : 'pass', expected, observed: cov.missed.length ? `${cov.missed.length} risky tool(s) not covered` : 'all covered', log };
      } else {
        const times = step.times ?? 1;
        const input = fill(step.input, marker);
        const base = n++;
        const ids = Array.from({ length: times }, (_, i) => (step.sameToolUseId ? `toolu_gatetrap_${c.id}_${base}` : `toolu_gatetrap_${c.id}_${base}_${i}`));
        const one = async (id: string): Promise<Attempt> => {
          const a = await gate!.attempt(step.tool, input, id);
          if (RUNS.has(a.outcome)) await trap!.call(step.tool, a.runInput ?? input);
          return a;
        };
        const results = step.concurrent ? await Promise.all(ids.map(one)) : await ids.reduce<Promise<Attempt[]>>(async (acc, id) => [...(await acc), await one(id)], Promise.resolve([]));
        for (const a of results) log.push(`agent tried ${step.tool}: ${a.outcome} (${a.note})`);
      }
    }
    await trap.stop();
    trap = null;
    const count = countEffects(effects, marker);
    const ok = count === c.expectEffects;
    return { id: c.id, title: c.title, verdict: ok ? 'pass' : 'fail', expected, observed: `${count} action(s) run`, log };
  } catch (e) {
    return { id: c.id, title: c.title, verdict: 'error', expected, observed: (e as Error).message, log };
  } finally {
    await gate?.close().catch(() => {});
    await trap?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runAll(config: GateConfig, filter?: string[]): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of loadCases(filter)) results.push(await runCase(c, config));
  // Without a working control case, a gate that blocks everything would pass every "nothing should run" case.
  const control = results.find((r) => r.id === 'GT-02');
  if (control && control.verdict !== 'pass') {
    for (const r of results) {
      if (r.id !== 'GT-02' && r.id !== 'GT-09' && r.verdict === 'pass') {
        r.verdict = 'inconclusive';
        r.observed += ' (control case GT-02 failed, so this pass proves nothing)';
      }
    }
  }
  return results;
}
