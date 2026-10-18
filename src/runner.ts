// Runs the numbered cases against one gate. For every case: a fresh working folder for the gate, a separate fresh
// folder for the trap's effects file, a fresh trap server and a fresh gate connection; the steps play out; then every
// line in that case's effects file is counted. The count, not the gate's own words, decides pass or fail.
//
// The effects file is never inside the gate's working folder, and every line counts whatever marker it carries, so a
// gate that rewrites arguments with updatedInput or tidies its own folder cannot hide an action that ran. gatetrap also
// counts the trap calls it made itself; if the effects file disagrees with that count afterwards, something changed
// the file during the case, and the case is reported as an error instead of a verdict.

import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

/** A mistake in how gatetrap was called (unknown case ids, an unreadable config): the CLI exits 2. */
export class UsageError extends Error {}

export const CASES_DIR = fileURLToPath(new URL('../cases/', import.meta.url));

const isCoverageOnly = (c: Case): boolean => c.steps.length > 0 && c.steps.every((s) => s.op === 'coverage');

/** Loads and checks every case; with a filter, only those ids, and an id that does not exist is a usage error. */
export function loadCases(filter?: string[]): Case[] {
  const all = readdirSync(CASES_DIR)
    .filter((f) => /^GT-\d+-.*\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')) as Case);
  for (const c of all) {
    if (!isCoverageOnly(c) && typeof c.expectEffects !== 'number') throw new Error(`case ${c.id} has no expectEffects`);
  }
  if (!filter?.length) return all;
  const unknown = filter.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new UsageError(`unknown case id(s): ${unknown.join(', ')} (known: ${all.map((c) => c.id).join(', ')})`);
  return all.filter((c) => filter.includes(c.id));
}

function makeGate(config: GateConfig, dir: string): Gate {
  if (config.type === 'claude-code') return new ClaudeCodeGate(config, dir);
  if (config.type === 'jsonl') return new JsonlGate(config, dir);
  throw new UsageError(`unknown gate type ${(config as { type: string }).type}`);
}

const BIG = 'x'.repeat(200 * 1024);

function fill(input: Record<string, unknown>, marker: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input).replaceAll('"$MARKER"', JSON.stringify(marker)).replaceAll('"$BIG"', JSON.stringify(BIG))) as Record<string, unknown>;
}

/** Every marker line in the case's effects file: each one is an action that ran. */
function readEffects(file: string): { marker: string | null }[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { marker: string | null });
}

const HOME = homedir();
/** Keeps local paths out of logs that people may share. */
function tidy(text: string): string {
  return HOME ? text.replaceAll(HOME, '~') : text;
}

async function runCase(c: Case, config: GateConfig): Promise<CaseResult> {
  const gateDir = mkdtempSync(join(tmpdir(), 'gatetrap-gate-'));
  const trapDir = mkdtempSync(join(tmpdir(), 'gatetrap-trap-'));
  const effects = join(trapDir, `effects-${randomBytes(6).toString('hex')}.jsonl`);
  const marker = `gt-${c.id}-${randomBytes(6).toString('hex')}`;
  const log: string[] = [];
  const expected = c.expectEffects === undefined ? 'every risky tool covered' : `${c.expectEffects} action(s) run`;
  const result = (verdict: CaseResult['verdict'], observed: string): CaseResult => ({ id: c.id, title: c.title, verdict, expected, observed: tidy(observed), log: log.map(tidy) });
  let trap: TrapClient | null = null;
  let gate: Gate | null = null;
  try {
    gate = makeGate(config, gateDir);
    if (!isCoverageOnly(c)) trap = await TrapClient.start(effects);
    let n = 0;
    let calls = 0;
    for (const step of c.steps) {
      if (step.op === 'wait') {
        await new Promise((r) => setTimeout(r, step.ms));
        log.push(`waited ${step.ms} ms`);
      } else if (step.op === 'approve') {
        await gate.approve(step.tool, fill(step.input, marker), step.ttlMs ?? 60_000);
        log.push(`person approved ${step.tool} (valid ${step.ttlMs ?? 60_000} ms)`);
      } else if (step.op === 'revoke') {
        const done = await gate.revoke(step.tool, fill(step.input, marker));
        log.push(done ? `person withdrew approval for ${step.tool}` : `could not withdraw approval for ${step.tool}: the gate has no revoke command or did not answer`);
      } else if (step.op === 'coverage') {
        const cov = gate.coverage ? await gate.coverage(step.tools) : null;
        if (!cov) return result('not-run', 'no settings file in the gate config');
        log.push(`covered: ${cov.covered.join(', ') || 'none'}`, `missed: ${cov.missed.join(', ') || 'none'}`, ...(cov.notes ?? []).map((n) => `not counted: ${n}`));
        return result(cov.missed.length ? 'fail' : 'pass', cov.missed.length ? `${cov.missed.length} risky tool(s) not covered` : 'all covered');
      } else {
        const times = step.times ?? 1;
        const input = fill(step.input, marker);
        const base = n++;
        const ids = Array.from({ length: times }, (_, i) => (step.sameToolUseId ? `toolu_gatetrap_${c.id}_${base}` : `toolu_gatetrap_${c.id}_${base}_${i}`));
        const one = async (id: string): Promise<Attempt> => {
          const a = await gate!.attempt(step.tool, input, id);
          if (RUNS.has(a.outcome)) {
            await trap!.call(step.tool, a.runInput ?? input);
            calls++;
          }
          return a;
        };
        const results = step.concurrent ? await Promise.all(ids.map(one)) : await ids.reduce<Promise<Attempt[]>>(async (acc, id) => [...(await acc), await one(id)], Promise.resolve([]));
        for (const a of results) log.push(`agent tried ${step.tool}: ${a.outcome} (${a.note})`);
      }
    }
    if (trap?.died) throw new Error(trap.died);
    await trap?.stop();
    trap = null;
    let lines: { marker: string | null }[];
    try {
      lines = readEffects(effects);
    } catch {
      return result('error', `the trap's marker file was changed during the case (gatetrap made ${calls} call(s))`);
    }
    if (lines.length !== calls) {
      return result('error', `the trap's marker file was changed during the case: gatetrap made ${calls} call(s) but the file holds ${lines.length} line(s)`);
    }
    const rewritten = lines.filter((l) => l.marker !== marker).length;
    if (rewritten) log.push(`${rewritten} of ${lines.length} action(s) ran with arguments the gate rewrote (marker changed or removed)`);
    return result(calls === c.expectEffects ? 'pass' : 'fail', `${calls} action(s) run`);
  } catch (e) {
    return result('error', (e as Error).message);
  } finally {
    await gate?.close().catch(() => {});
    await trap?.stop().catch(() => {});
    rmSync(gateDir, { recursive: true, force: true });
    rmSync(trapDir, { recursive: true, force: true });
  }
}

export async function runAll(config: GateConfig, filter?: string[]): Promise<CaseResult[]> {
  const cases = loadCases(filter);
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c, config));
  // Without a working control case, a gate that blocks everything would pass every "nothing should run" case.
  const control = results.find((r) => r.id === 'GT-02');
  if (control && control.verdict !== 'pass') {
    for (const r of results) {
      if (r.id !== 'GT-02' && r.id !== 'GT-09' && r.verdict === 'pass') {
        r.verdict = 'inconclusive';
        r.observed += ' (control case GT-02 did not pass, so this pass proves nothing)';
      }
    }
  }
  return results;
}
