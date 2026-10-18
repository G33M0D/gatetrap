// Turns case results into a plain-text summary and a JSON report. Every report says what a pass does not mean.

import type { CaseResult } from './runner.ts';

export const NOT_PROVEN = [
  'A pass means: for these exact cases, with this exact configuration, the trap saw the expected number of actions run.',
  'It does NOT mean the gate is secure against every attack, that a person was really present, that the agent cannot',
  'reach the action another way (another tool, a shell, a browser), or that people reading approval requests actually',
  'read them. The Claude Code connector models the main documented hook rules; it is not Claude Code itself.',
];

const MARK: Record<CaseResult['verdict'], string> = { pass: 'PASS', fail: 'FAIL', 'not-run': 'SKIP', inconclusive: 'N/A ', error: 'ERR ' };

export function textReport(gateName: string, results: CaseResult[]): string {
  const count = (v: CaseResult['verdict']) => results.filter((r) => r.verdict === v).length;
  const lines = [
    `gatetrap report for: ${gateName}`,
    `passed ${count('pass')}, failed ${count('fail')}, skipped ${count('not-run')}, inconclusive ${count('inconclusive')}, errors ${count('error')}`,
    '',
  ];
  for (const r of results) {
    lines.push(`${MARK[r.verdict]}  ${r.id}  ${r.title}`);
    if (r.verdict !== 'pass') lines.push(`      expected ${r.expected}; observed ${r.observed}`);
  }
  lines.push('', ...NOT_PROVEN);
  return lines.join('\n');
}

export function jsonReport(gateName: string, results: CaseResult[], generatedAt: string): string {
  return JSON.stringify({ tool: 'gatetrap', version: '0.1.0', gate: gateName, generatedAt, results, notProven: NOT_PROVEN.join(' ') }, null, 2);
}
