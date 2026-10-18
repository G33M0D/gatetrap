import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, TRAP_TOOLS, claudeToolName } from '../src/trap-server.ts';
import { matcherMatches, preToolUseMatchers } from '../src/matcher.ts';
import { ClaudeCodeGate } from '../src/connectors/claude-code.ts';
import { loadCases, runAll } from '../src/runner.ts';
import type { GateConfig } from '../src/runner.ts';

const EX = fileURLToPath(new URL('../examples/gates/', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'gatetrap-test-'));

function exampleConfig(file: string): GateConfig {
  const text = readFileSync(join(EX, file), 'utf8').replaceAll('${CONFIG_DIR}', EX.replace(/\/$/, ''));
  const c = JSON.parse(text) as GateConfig;
  if (c.type === 'claude-code' && c.settingsFile) c.settingsFile = join(EX, c.settingsFile);
  return c;
}

test('trap server: lists four tools and writes exactly one marker line per call', () => {
  const dir = tmp();
  const file = join(dir, 'effects.jsonl');
  const init = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, file) as { result: { serverInfo: { name: string } } };
  assert.equal(init.result.serverInfo.name, 'gatetrap');
  const list = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, file) as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map((t) => t.name), ['read_record', 'write_record', 'delete_record', 'send_payment']);
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, file), null);
  handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_record', arguments: { id: 'r1', marker: 'm1' } } }, file);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).marker, 'm1');
  const bad = handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf' } }, file) as { error: { code: number } };
  assert.equal(bad.error.code, -32602);
  rmSync(dir, { recursive: true, force: true });
});

test('trap tools are labelled honestly: only read_record is read-only', () => {
  assert.deepEqual(TRAP_TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name), ['read_record']);
  assert.equal(claudeToolName('send_payment'), 'mcp__gatetrap__send_payment');
});

test('matcher rules follow the Claude Code documentation', () => {
  assert.equal(matcherMatches(undefined, 'anything'), true);
  assert.equal(matcherMatches('*', 'anything'), true);
  assert.equal(matcherMatches('', 'anything'), true);
  assert.equal(matcherMatches('Edit|Write', 'Write'), true);
  assert.equal(matcherMatches('Edit,Write', 'Edit'), true);
  assert.equal(matcherMatches('Edit|Write', 'NotebookEdit'), false);
  assert.equal(matcherMatches('Edit.*', 'NotebookEdit'), true); // unanchored regular expression
  assert.equal(matcherMatches('^Edit$', 'NotebookEdit'), false);
  assert.equal(matcherMatches('mcp__gatetrap', 'mcp__gatetrap__delete_record'), false); // exact string: matches nothing
  assert.equal(matcherMatches('mcp__gatetrap__.*', 'mcp__gatetrap__delete_record'), true);
  assert.equal(matcherMatches('mcp__gatetrap__(', 'mcp__gatetrap__x'), false); // invalid expression matches nothing
});

test('preToolUseMatchers only counts entries with a command hook', () => {
  const settings = { hooks: { PreToolUse: [{ matcher: 'A', hooks: [{ type: 'command', command: 'x' }] }, { matcher: 'B', hooks: [] }] } };
  assert.deepEqual(preToolUseMatchers(settings), ['A']);
  assert.deepEqual(preToolUseMatchers({}), []);
});

test('Claude Code connector maps exit codes and decisions as documented', async () => {
  const dir = tmp();
  const script = join(dir, 'hook.mjs');
  // The hook's behaviour is chosen by the record id, so one script covers every branch.
  writeFileSync(
    script,
    `let s='';for await (const c of process.stdin) s+=c; const e=JSON.parse(s); const id=e.tool_input.id;
     const out=(d)=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:d}}));
     if(id==='exit2'){process.stderr.write('no');process.exit(2)}
     if(id==='exit1'){process.exit(1)}
     if(id==='allow')out('allow'); if(id==='deny')out('deny'); if(id==='ask')out('ask'); if(id==='defer')out('defer');
     if(id==='junk')process.stdout.write('{not json');
     if(id==='sleep')await new Promise(r=>setTimeout(r,3000));
     if(id==='update')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{id:'changed'}}}));`,
  );
  const base = { type: 'claude-code' as const, approve: { command: 'true' } };
  const gate = new ClaudeCodeGate({ ...base, hook: { command: `node "${script}"`, timeoutSec: 1 } }, dir);
  const outcome = async (id: string) => (await gate.attempt('delete_record', { id }, 't1')).outcome;
  assert.equal(await outcome('exit2'), 'block');
  assert.equal(await outcome('exit1'), 'fail-open');
  assert.equal(await outcome('allow'), 'allow');
  assert.equal(await outcome('deny'), 'block');
  assert.equal(await outcome('ask'), 'ask');
  assert.equal(await outcome('defer'), 'pass-through');
  assert.equal(await outcome('silent'), 'pass-through');
  assert.equal(await outcome('junk'), 'fail-open');
  assert.equal(await outcome('sleep'), 'fail-open');
  assert.deepEqual((await gate.attempt('delete_record', { id: 'update' }, 't2')).runInput, { id: 'changed' });
  const strict = new ClaudeCodeGate({ ...base, hook: { command: `node "${script}"`, timeoutSec: 1, onFailure: 'block' } }, dir);
  assert.equal((await strict.attempt('delete_record', { id: 'exit1' }, 't3')).outcome, 'block');
  assert.equal((await strict.attempt('delete_record', { id: 'sleep' }, 't4')).outcome, 'block');
  const missing = new ClaudeCodeGate({ ...base, hook: { command: `node "${join(dir, 'does-not-exist.mjs')}"` } }, dir);
  assert.equal((await missing.attempt('delete_record', { id: 'x' }, 't5')).outcome, 'fail-open');
  rmSync(dir, { recursive: true, force: true });
});

test('every case file is well formed, numbered in order and cites a source', () => {
  const cases = loadCases();
  assert.equal(cases.length, 10);
  cases.forEach((c, i) => {
    assert.equal(c.id, `GT-${String(i + 1).padStart(2, '0')}`);
    assert.ok(c.title && c.why, c.id);
    assert.ok(c.sources.length > 0 && c.sources.every((s) => s.url.startsWith('https://')), c.id);
    assert.ok(c.steps.length > 0, c.id);
  });
});

test('the strict example gate passes every case through the Claude Code connector', async () => {
  const results = await runAll(exampleConfig('strict-gate.claude-code.json'));
  assert.deepEqual(results.filter((r) => r.verdict !== 'pass').map((r) => `${r.id}: ${r.observed}`), []);
});

test('the strict example gate passes every case it can run through the generic connector', async () => {
  const results = await runAll(exampleConfig('strict-gate.jsonl.json'));
  assert.deepEqual(results.filter((r) => r.verdict !== 'pass' && r.verdict !== 'not-run').map((r) => r.id), []);
  assert.equal(results.find((r) => r.id === 'GT-09')?.verdict, 'not-run');
});

test('the naive example gate is caught on exactly the mistakes it was given', async () => {
  const results = await runAll(exampleConfig('naive-gate.claude-code.json'));
  const failed = results.filter((r) => r.verdict === 'fail').map((r) => r.id);
  assert.deepEqual(failed, ['GT-01', 'GT-03', 'GT-04', 'GT-05', 'GT-06', 'GT-07', 'GT-08', 'GT-09', 'GT-10']);
  assert.equal(results.find((r) => r.id === 'GT-02')?.verdict, 'pass');
});

test('a gate that blocks everything cannot pass: its passes become inconclusive', async () => {
  const dir = tmp();
  const script = join(dir, 'deny-all.mjs');
  writeFileSync(script, `process.stderr.write('blocked');process.exit(2)`);
  const results = await runAll({ type: 'claude-code', hook: { command: `node "${script}"` }, approve: { command: 'true' } }, ['GT-01', 'GT-02', 'GT-04']);
  assert.deepEqual(results.map((r) => [r.id, r.verdict]), [['GT-01', 'inconclusive'], ['GT-02', 'fail'], ['GT-04', 'inconclusive']]);
  rmSync(dir, { recursive: true, force: true });
});
