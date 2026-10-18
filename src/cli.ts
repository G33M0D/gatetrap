#!/usr/bin/env node
// gatetrap command line (run from a clone with `node src/cli.ts <command>`).
//   list                                         list the cases
//   run --config gate.json [--cases GT-01,GT-03] [--report-dir dir]
//   demo                                         run every case against the example gates
//   trap-server                                  run the trap tool server (MCP over stdio; needs GATETRAP_EFFECTS)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './trap-server.ts';
import { loadCases, runAll, UsageError } from './runner.ts';
import type { GateConfig } from './runner.ts';
import { jsonReport, textReport } from './report.ts';

const HELP = `gatetrap: harmless trap tests for AI-agent approval gates

  node src/cli.ts list
  node src/cli.ts run --config <gate.json> [--cases GT-01,GT-03] [--report-dir <dir>]
  node src/cli.ts demo
  node src/cli.ts trap-server        (MCP server over stdio; set GATETRAP_EFFECTS to a file)

Exit status: 0 every selected case passed or was skipped, 1 a case failed, errored or was inconclusive,
2 usage error (no or unreadable config, unknown case id, unknown command).`;

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value`);
  return v;
}

/** Reads a gate config. ${CONFIG_DIR} becomes the config file's folder, and settingsFile is resolved from there. */
function readConfig(path: string): GateConfig {
  const base = dirname(resolve(path));
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read the config file ${path}: ${(e as Error).message}`);
  }
  let config: GateConfig;
  try {
    // The folder is inserted inside JSON strings, so it is escaped as a JSON string first.
    config = JSON.parse(text.replaceAll('${CONFIG_DIR}', JSON.stringify(base).slice(1, -1))) as GateConfig;
  } catch (e) {
    throw new UsageError(`the config file ${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!config || (config.type !== 'claude-code' && config.type !== 'jsonl')) {
    throw new UsageError(`the config file ${path} must have "type": "claude-code" or "type": "jsonl"`);
  }
  if (config.type === 'claude-code' && config.settingsFile) config.settingsFile = resolve(base, config.settingsFile);
  return config;
}

const slugOf = (name: string): string => name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'gate';

async function runOne(configPath: string, cases: string[] | undefined, reportDir: string | undefined): Promise<boolean> {
  const config = readConfig(configPath);
  const name = config.name ?? basename(configPath);
  loadCases(cases); // an unknown case id is a usage error before anything runs
  if (cases?.length && !cases.includes('GT-02')) {
    process.stderr.write('note: GT-02, the control case, is not in this run, so a gate that blocks everything would pass.\n');
  }
  const results = await runAll(config, cases);
  process.stdout.write(`${textReport(name, results, config.type)}\n`);
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString();
    const slug = slugOf(name);
    writeFileSync(join(reportDir, `${slug}.report.json`), jsonReport(name, results, stamp, config.type));
    writeFileSync(join(reportDir, `${slug}.report.txt`), textReport(name, results, config.type));
  }
  return results.length > 0 && results.every((r) => r.verdict === 'pass' || r.verdict === 'not-run');
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'trap-server') {
    serve();
    return -1; // keeps running
  }
  if (cmd === 'list') {
    for (const c of loadCases()) process.stdout.write(`${c.id}  ${c.title}\n`);
    return 0;
  }
  if (cmd === 'run') {
    const config = arg('--config', rest);
    if (!config) throw new UsageError('run needs --config <gate.json>');
    const cases = arg('--cases', rest)?.split(',').map((s) => s.trim());
    return (await runOne(config, cases, arg('--report-dir', rest))) ? 0 : 1;
  }
  if (cmd === 'demo') {
    const ex = fileURLToPath(new URL('../examples/gates/', import.meta.url));
    let ok = true;
    for (const f of ['strict-gate.claude-code.json', 'naive-gate.claude-code.json', 'strict-gate.jsonl.json']) {
      process.stdout.write(`\n=== ${f}\n`);
      const passed = await runOne(join(ex, f), undefined, undefined);
      if (f.startsWith('strict') && !passed) ok = false;
    }
    process.stdout.write('\nThe strict gate should pass every case; the naive gate is meant to fail several.\n');
    return ok ? 0 : 1;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  throw new UsageError(cmd ? `unknown command: ${cmd}` : 'no command given');
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof UsageError) {
      process.stderr.write(`gatetrap: ${e.message}\n\n${HELP}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`gatetrap: ${(e as Error)?.message ?? String(e)}\n`);
      process.exitCode = 1;
    }
  },
);
