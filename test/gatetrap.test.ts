import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, TRAP_TOOLS, claudeToolName, PROTOCOL_VERSIONS } from '../src/trap-server.ts';
import { matcherMatches, preToolUseHooks, preToolUseMatchers } from '../src/matcher.ts';
import { ClaudeCodeGate, parseStdout, validateOutput } from '../src/connectors/claude-code.ts';
import { JsonlGate } from '../src/connectors/jsonl.ts';
import { TrapClient } from '../src/mcp-client.ts';
import { loadCases, runAll, UsageError } from '../src/runner.ts';
import type { GateConfig } from '../src/runner.ts';

const EX = fileURLToPath(new URL('../examples/gates/', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'gatetrap-test-'));

function exampleConfig(file: string): GateConfig {
  const text = readFileSync(join(EX, file), 'utf8').replaceAll('${CONFIG_DIR}', EX.replace(/\/$/, ''));
  const c = JSON.parse(text) as GateConfig;
  if (c.type === 'claude-code' && c.settingsFile) c.settingsFile = join(EX, c.settingsFile);
  return c;
}

const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('trap server: lists four tools and writes exactly one marker line per call', () => {
  const dir = tmp();
  const file = join(dir, 'effects.jsonl');
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

test('trap server: negotiates the protocol version and answers a write failure instead of crashing', () => {
  const init = (v: string) => (handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v } }, '/x') as { result: { protocolVersion: string } }).result.protocolVersion;
  assert.equal(init('2025-03-26'), '2025-03-26');
  assert.equal(init('1999-01-01'), PROTOCOL_VERSIONS[0]);
  const r = handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_record', arguments: { id: 'r1' } } }, join(tmpdir(), 'gatetrap-no-such-folder', 'x', 'effects.jsonl')) as { error: { code: number; message: string } };
  assert.equal(r.error.code, -32603);
  assert.match(r.error.message, /could not write the marker line/);
});

test('trap tools are labelled honestly: only read_record is read-only', () => {
  assert.deepEqual(TRAP_TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name), ['read_record']);
  assert.equal(claudeToolName('send_payment'), 'mcp__gatetrap__send_payment');
});

test('trap client: a trap server that dies makes calls fail at once instead of hanging', async () => {
  const dir = tmp();
  const client = await TrapClient.start(join(dir, 'effects.jsonl'));
  (client as unknown as { child: { kill: (s: string) => void } }).child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  assert.match(client.died ?? '', /trap server exited/);
  await assert.rejects(client.call('delete_record', { id: 'r1' }), /trap server exited/);
  await client.stop();
  rmSync(dir, { recursive: true, force: true });
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

test('stdout is parsed by the documented rules', () => {
  assert.equal(parseStdout('').kind, 'plain');
  assert.equal(parseStdout('looks fine').kind, 'plain');
  assert.equal(parseStdout('[1, 2]').kind, 'plain');
  assert.equal(parseStdout('{not json').kind, 'plain'); // starts with { but does not end with }
  assert.equal(parseStdout('  {"continue": true}\n').kind, 'json');
  assert.equal(parseStdout('{bad}').kind, 'invalid');
  assert.equal(parseStdout('{"a":1}\n{"b":2}').kind, 'plain'); // several lines, none sets an output field
  assert.equal(parseStdout('{"a":1}\n{"continue":true}').kind, 'invalid');
});

test('output fields are checked against the documented PreToolUse schema', () => {
  const out = (h: Record<string, unknown>) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...h } });
  assert.equal(validateOutput(out({ permissionDecision: 'allow' })), null);
  assert.match(validateOutput(out({ permissionDecision: 'maybe' })) ?? '', /unknown permissionDecision/);
  assert.match(validateOutput({ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'allow' } }) ?? '', /hookEventName/);
  assert.match(validateOutput(out({ updatedInput: 'x' })) ?? '', /updatedInput/);
  assert.match(validateOutput({ continue: 'no' }) ?? '', /continue/);
  assert.equal(validateOutput({ somethingElse: 1 }), null); // unknown extra fields are ignored
});

test('Claude Code connector maps every documented outcome', async () => {
  const dir = tmp();
  const script = join(dir, 'hook.mjs');
  // The hook's behaviour is chosen by the record id, so one script covers every branch.
  writeFileSync(
    script,
    `let s='';for await (const c of process.stdin) s+=c; const e=JSON.parse(s); const id=e.tool_input.id;
     const out=(d,extra={})=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:d,...extra}}));
     if(id==='exit2'){process.stderr.write('no');process.exit(2)}
     if(id==='exit1'){process.exit(1)}
     if(id==='exit1-deny'){out('deny');process.exit(1)}
     if(id==='exit1-allow'){out('allow');process.exit(1)}
     if(['allow','deny','ask','maybe'].includes(id))out(id);
     if(id==='defer')out('defer',{updatedInput:{id:'changed'}});
     if(id==='update')out('allow',{updatedInput:{id:'changed'}});
     if(id==='open')process.stdout.write('{not json');
     if(id==='broken')process.stdout.write('{bad}');
     if(id==='sleep')await new Promise(r=>setTimeout(r,3000));
     if(id==='legacy-block')process.stdout.write(JSON.stringify({decision:'block',reason:'old style'}));
     if(id==='legacy-approve')process.stdout.write(JSON.stringify({decision:'approve'}));
     if(id==='exit2-json'){out('deny',{permissionDecisionReason:'json reason'});process.stderr.write('stderr reason');process.exit(2)}
     if(id==='event')(await import('node:fs')).writeFileSync(process.env.CLAUDE_PROJECT_DIR+'/event.json',s);`,
  );
  const base = { type: 'claude-code' as const, approve: { command: 'true' } };
  const gate = new ClaudeCodeGate({ ...base, hook: { command: `node "${script}"`, timeoutSec: 1 } }, dir);
  const strict = new ClaudeCodeGate({ ...base, hook: { command: `node "${script}"`, timeoutSec: 1, onFailure: 'block' } }, dir);
  const outcome = async (g: ClaudeCodeGate, id: string) => (await g.attempt('delete_record', { id }, 't')).outcome;
  const table: [string, string, string][] = [
    // id, default outcome, outcome with onFailure "block"
    ['exit2', 'block', 'block'],
    ['exit1', 'fail-open', 'block'],
    ['exit1-deny', 'block', 'block'], // a valid decision stands whatever the exit code
    ['exit1-allow', 'allow', 'block'], // ...unless onFailure is "block", where the exit code is a failure
    ['allow', 'allow', 'allow'],
    ['deny', 'block', 'block'],
    ['ask', 'ask', 'ask'],
    ['defer', 'ask', 'ask'], // in a non-interactive run a deferred tool does not run
    ['silent', 'pass-through', 'pass-through'],
    ['open', 'pass-through', 'pass-through'], // plain text, not a failure
    ['broken', 'fail-open', 'block'],
    ['maybe', 'fail-open', 'block'], // fails schema validation
    ['sleep', 'fail-open', 'block'],
    ['legacy-block', 'block', 'block'], // the deprecated top-level decision still counts
    ['legacy-approve', 'allow', 'allow'],
  ];
  for (const [id, plain, blocking] of table) {
    assert.equal(await outcome(gate, id), plain, `${id} (default)`);
    assert.equal(await outcome(strict, id), blocking, `${id} (onFailure block)`);
  }
  assert.deepEqual((await gate.attempt('delete_record', { id: 'update' }, 't')).runInput, { id: 'changed' });
  assert.equal((await gate.attempt('delete_record', { id: 'defer' }, 't')).runInput, undefined); // nothing runs
  assert.equal((await gate.attempt('delete_record', { id: 'exit2-json' }, 't')).note, 'exit 2: json reason');
  const missing = new ClaudeCodeGate({ ...base, hook: { command: `node "${join(dir, 'does-not-exist.mjs')}"` } }, dir);
  assert.equal(await outcome(missing, 'x'), 'fail-open');
  await gate.attempt('delete_record', { id: 'event' }, 'toolu_1');
  const event = JSON.parse(readFileSync(join(dir, 'event.json'), 'utf8'));
  assert.equal(event.hook_event_name, 'PreToolUse');
  assert.equal(event.tool_name, 'mcp__gatetrap__delete_record');
  assert.equal(event.tool_use_id, 'toolu_1');
  assert.deepEqual(event.mcp_server, { name: 'gatetrap', source: 'project' });
  assert.ok(event.prompt_id && event.scratchpad_dir && event.session_id && event.cwd);
  rmSync(dir, { recursive: true, force: true });
});

test('a hook that leaves a process behind cannot stall the run past its timeout', async () => {
  const dir = tmp();
  const gate = new ClaudeCodeGate({ type: 'claude-code', approve: { command: 'true' }, hook: { command: 'sleep 6 & sleep 6', timeoutSec: 1 } }, dir);
  const started = Date.now();
  const a = await gate.attempt('delete_record', { id: 'x' }, 't');
  assert.equal(a.outcome, 'fail-open');
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  rmSync(dir, { recursive: true, force: true });
});

test('a hook that allows but leaves a process holding its output is blocked, as Claude Code does', async () => {
  const dir = tmp();
  const allow = `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'`;
  const held = new ClaudeCodeGate({ type: 'claude-code', approve: { command: 'true' }, hook: { command: `${allow}; (sleep 3) &` } }, dir);
  const a = await held.attempt('delete_record', { id: 'x' }, 't');
  assert.equal(a.outcome, 'block');
  assert.match(a.note, /suspect capture/);
  const tidy = new ClaudeCodeGate({ type: 'claude-code', approve: { command: 'true' }, hook: { command: `${allow}; (sleep 3) >/dev/null 2>&1 &` } }, dir);
  assert.equal((await tidy.attempt('delete_record', { id: 'x' }, 't')).outcome, 'allow');
  rmSync(dir, { recursive: true, force: true });
});

test('settings: disabled, async and if-filtered hooks never count as a gate', () => {
  const cmd = { type: 'command', command: 'x' };
  assert.deepEqual(preToolUseHooks({ disableAllHooks: true, hooks: { PreToolUse: [{ matcher: '*', hooks: [cmd] }] } }).matchers, []);
  const r = preToolUseHooks({
    hooks: {
      PreToolUse: [
        { matcher: 'A', hooks: [{ ...cmd, async: true }] },
        { matcher: 'B', hooks: [{ ...cmd, asyncRewake: true }] },
        { matcher: 'C', hooks: [{ ...cmd, if: 'Bash(git *)' }] },
        { matcher: 'D', hooks: [cmd] },
      ],
    },
  });
  assert.deepEqual(r.matchers, ['D']);
  assert.equal(r.ignored.length, 3);
});

test('with a settings file, the hook only runs for tools its matchers cover, as in Claude Code', async () => {
  const dir = tmp();
  const settings = join(dir, 'settings.json');
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'mcp__gatetrap__send_payment', hooks: [{ type: 'command', command: 'x' }] }] } }));
  const gate = new ClaudeCodeGate({ type: 'claude-code', approve: { command: 'true' }, hook: { command: 'exit 2' }, settingsFile: settings }, dir);
  assert.equal((await gate.attempt('send_payment', { to: 'a', amount: 1 }, 't')).outcome, 'block');
  const skipped = await gate.attempt('delete_record', { id: 'x' }, 't');
  assert.equal(skipped.outcome, 'pass-through');
  assert.match(skipped.note, /no PreToolUse matcher/);
  rmSync(dir, { recursive: true, force: true });
});

test('generic connector: a reply that comes too late is not taken as the answer to the next request', async () => {
  const dir = tmp();
  const script = join(dir, 'gate.mjs');
  writeFileSync(
    script,
    `import {createInterface} from 'node:readline';
     let chain = Promise.resolve(); // answers strictly in order, as the protocol requires
     createInterface({input:process.stdin}).on('line', (l) => { chain = chain.then(async () => { const m=JSON.parse(l);
       if(m.op==='revoke') await new Promise(r=>setTimeout(r,1500));
       process.stdout.write(JSON.stringify(m.op==='attempt'?{decision:'deny',reason:'no approval'}:{ok:true})+'\\n'); }); });`,
  );
  const gate = new JsonlGate({ type: 'jsonl', command: process.execPath, args: [script], timeoutSec: 1 }, dir);
  try {
    await gate.approve('send_payment', {}, 1000);
    assert.equal(await gate.revoke('send_payment', {}), false); // timed out
    const a = await gate.attempt('send_payment', {}, 't');
    assert.equal(a.outcome, 'block');
    assert.equal(a.note, 'no approval');
  } finally {
    await gate.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generic connector: a gate that crashes fails open by default, and blocks only when configured to', async () => {
  const dir = tmp();
  const crash = { type: 'jsonl' as const, command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSec: 1 };
  const g1 = new JsonlGate(crash, dir);
  const g2 = new JsonlGate({ ...crash, onFailure: 'block' }, dir);
  try {
    assert.equal((await g1.attempt('delete_record', { id: 'x' }, 't')).outcome, 'fail-open');
    assert.equal((await g2.attempt('delete_record', { id: 'x' }, 't')).outcome, 'block');
  } finally {
    await g1.close();
    await g2.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.throws(() => loadCases(['GT-01', 'GT-99']), (e: unknown) => e instanceof UsageError && /GT-99/.test((e as Error).message));
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

test('the naive example gate fails every case except the control', async () => {
  const results = await runAll(exampleConfig('naive-gate.claude-code.json'));
  const failed = results.filter((r) => r.verdict === 'fail').map((r) => r.id);
  assert.deepEqual(failed, ['GT-01', 'GT-03', 'GT-04', 'GT-05', 'GT-06', 'GT-07', 'GT-08', 'GT-09', 'GT-10']);
  assert.equal(results.find((r) => r.id === 'GT-02')?.verdict, 'pass');
});

test('the naive hook, once its matcher is fixed, is still caught by its own mistakes', async () => {
  const dir = tmp();
  const settings = join(dir, 'settings.json');
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'mcp__gatetrap__.*', hooks: [{ type: 'command', command: 'node naive-gate.mjs' }] }] } }));
  const config = { ...exampleConfig('naive-gate.claude-code.json'), settingsFile: settings } as GateConfig;
  const results = await runAll(config);
  const failed = results.filter((r) => r.verdict === 'fail').map((r) => r.id);
  assert.deepEqual(failed, ['GT-01', 'GT-03', 'GT-04', 'GT-05', 'GT-06', 'GT-07', 'GT-08', 'GT-10']);
  assert.match(results.find((r) => r.id === 'GT-01')!.log.join(' '), /fail-open/); // the toFixed crash
  rmSync(dir, { recursive: true, force: true });
});

test('a gate that blocks everything cannot pass: its passes become inconclusive', async () => {
  const dir = tmp();
  const script = join(dir, 'deny-all.mjs');
  writeFileSync(script, `process.stderr.write('blocked');process.exit(2)`);
  const results = await runAll({ type: 'claude-code', hook: { command: `node "${script}"` }, approve: { command: 'true' } }, ['GT-01', 'GT-02', 'GT-04']);
  assert.deepEqual(results.map((r) => [r.id, r.verdict]), [['GT-01', 'inconclusive'], ['GT-02', 'fail'], ['GT-04', 'inconclusive']]);
  rmSync(dir, { recursive: true, force: true });
});

test('a gate that strips the marker from the arguments can no longer hide an action', async () => {
  const dir = tmp();
  const script = join(dir, 'strip.mjs');
  writeFileSync(
    script,
    `let s='';for await (const c of process.stdin) s+=c; const e=JSON.parse(s); const {marker, ...rest}=e.tool_input;
     process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:rest}}));`,
  );
  const results = await runAll({ type: 'claude-code', hook: { command: `node "${script}"` }, approve: { command: 'true' } }, ['GT-01', 'GT-02']);
  const gt01 = results.find((r) => r.id === 'GT-01')!;
  assert.equal(gt01.verdict, 'fail');
  assert.equal(gt01.observed, '1 action(s) run');
  assert.match(gt01.log.join(' '), /arguments the gate rewrote/);
  rmSync(dir, { recursive: true, force: true });
});

test('a gate that deletes files in its own folder cannot erase the count', async () => {
  const dir = tmp();
  const script = join(dir, 'tidy.mjs');
  writeFileSync(
    script,
    `import {readdirSync,rmSync} from 'node:fs'; const d=process.env.CLAUDE_PROJECT_DIR;
     for (const f of readdirSync(d)) rmSync(d+'/'+f,{recursive:true,force:true});
     process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));`,
  );
  const results = await runAll({ type: 'claude-code', hook: { command: `node "${script}"` }, approve: { command: 'true' } }, ['GT-02', 'GT-03']);
  assert.equal(results.find((r) => r.id === 'GT-03')?.observed, '2 action(s) run');
  assert.equal(results.find((r) => r.id === 'GT-03')?.verdict, 'fail');
  rmSync(dir, { recursive: true, force: true });
});

test('a gate that edits the trap marker file from outside its folder is reported, not trusted', async () => {
  const dir = tmp();
  const script = join(dir, 'search.mjs');
  // Allows everything, then hunts for the trap folders and empties every marker file it finds.
  writeFileSync(
    script,
    `import {readdirSync,writeFileSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path';
     setTimeout(()=>{ for (const d of readdirSync(tmpdir()).filter(n=>n.startsWith('gatetrap-trap-'))) for (const f of readdirSync(join(tmpdir(),d))) writeFileSync(join(tmpdir(),d,f),''); }, 0);
     process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));`,
  );
  const results = await runAll({ type: 'claude-code', hook: { command: `node "${script}"` }, approve: { command: 'true' } }, ['GT-02', 'GT-03']);
  const gt03 = results.find((r) => r.id === 'GT-03')!;
  assert.equal(gt03.verdict, 'error');
  assert.match(gt03.observed, /marker file was changed during the case/);
  rmSync(dir, { recursive: true, force: true });
});

test('a gate that kills the trap server turns the case into an error', async () => {
  const dir = tmp();
  const script = join(dir, 'kill.mjs');
  writeFileSync(
    script,
    `import {execSync} from 'node:child_process'; try { execSync("pkill -f 'cli.ts trap-server'") } catch {}
     process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));`,
  );
  const results = await runAll({ type: 'claude-code', hook: { command: `node "${script}"` }, approve: { command: 'true' } }, ['GT-02']);
  assert.equal(results[0].verdict, 'error');
  assert.match(results[0].observed, /trap server exited/);
  rmSync(dir, { recursive: true, force: true });
});

test('the command line: usage errors exit 2 with a message, help goes to standard output', () => {
  const missing = cli(['run', '--config', join(tmpdir(), 'gatetrap-no-such-config.json')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read the config file/);
  const unknown = cli(['run', '--config', join(EX, 'strict-gate.jsonl.json'), '--cases', 'GT-99']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown case id/);
  assert.doesNotMatch(unknown.stderr, /control case/); // the usage error comes before anything runs
  const dir = tmp();
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ type: 'nonsense' }));
  const badType = cli(['run', '--config', join(dir, 'bad.json')]);
  assert.equal(badType.status, 2);
  assert.match(badType.stderr, /must have "type"/);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(cli(['nonsense']).status, 2);
  assert.equal(cli([]).status, 2);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /node src\/cli\.ts list/);
});

test('the command line: reports get their own names, a summary, and a note when the control is left out', () => {
  const out = tmp();
  const r = cli(['run', '--config', join(EX, 'strict-gate.jsonl.json'), '--cases', 'GT-01', '--report-dir', out]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /GT-02, the control case, is not in this run/);
  const files = readdirSync(out).sort();
  assert.deepEqual(files, ['example-strict-gate-generic-protocol.report.json', 'example-strict-gate-generic-protocol.report.txt']);
  const json = JSON.parse(readFileSync(join(out, files[0]), 'utf8'));
  assert.deepEqual(json.summary, { passed: 1, failed: 0, skipped: 0, inconclusive: 0, errors: 0 });
  assert.equal(json.connector, 'jsonl');
  assert.ok(existsSync(join(out, files[1])));
  rmSync(out, { recursive: true, force: true });
});
