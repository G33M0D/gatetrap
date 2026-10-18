// Turns case results into a plain-text summary and a JSON report. Every report says what a pass does not mean.

import type { CaseResult } from './runner.ts';
import { VERSION } from './version.ts';

const BASE_NOT_PROVEN = [
  'A pass means: for these exact cases, with this exact configuration, the trap saw the expected number of actions run.',
  'It does NOT mean the gate is secure against every attack, that a person was really present, that the agent cannot',
  'reach the action another way (another tool, a shell, a browser), or that people reading approval requests actually',
  'read them.',
];
const CONNECTOR_NOTE: Record<string, string> = {
  'claude-code': 'The Claude Code connector models the documented hook rules; it is not Claude Code itself.',
  jsonl: 'The generic connector reports what your gate answered; the platform around it may behave differently.',
};

export function notProven(kind?: string): string[] {
  const note = kind ? CONNECTOR_NOTE[kind] : undefined;
  return note ? [...BASE_NOT_PROVEN, note] : BASE_NOT_PROVEN;
}

const MARK: Record<CaseResult['verdict'], string> = { pass: 'PASS', fail: 'FAIL', 'not-run': 'SKIP', inconclusive: 'N/A ', error: 'ERR ' };

export function summary(results: CaseResult[]): Record<'passed' | 'failed' | 'skipped' | 'inconclusive' | 'errors', number> {
  const count = (v: CaseResult['verdict']) => results.filter((r) => r.verdict === v).length;
  return { passed: count('pass'), failed: count('fail'), skipped: count('not-run'), inconclusive: count('inconclusive'), errors: count('error') };
}

export function textReport(gateName: string, results: CaseResult[], kind?: string): string {
  const s = summary(results);
  const lines = [
    `gatetrap report for: ${gateName}`,
    `passed ${s.passed}, failed ${s.failed}, skipped ${s.skipped}, inconclusive ${s.inconclusive}, errors ${s.errors}`,
    '',
  ];
  for (const r of results) {
    lines.push(`${MARK[r.verdict]}  ${r.id}  ${r.title}`);
    if (r.verdict !== 'pass') lines.push(`      expected ${r.expected}; observed ${r.observed}`);
  }
  lines.push('', ...notProven(kind));
  return lines.join('\n');
}

export function jsonReport(gateName: string, results: CaseResult[], generatedAt: string, kind?: string): string {
  return JSON.stringify(
    { tool: 'gatetrap', version: VERSION, gate: gateName, connector: kind ?? null, generatedAt, summary: summary(results), results, notProven: notProven(kind).join(' ') },
    null,
    2,
  );
}
