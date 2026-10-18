#!/usr/bin/env node
// gatetrap command line.
//   gatetrap trap-server                         run the trap tool server (MCP over stdio; needs GATETRAP_EFFECTS)
//   gatetrap run --config gate.json [--cases GT-01,GT-03] [--report-dir dir]
//   gatetrap demo                                run every case against the two example gates
//   gatetrap list                                list the cases

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './trap-server.ts';
import { loadCases, runAll } from './runner.ts';
import type { GateConfig } from './runner.ts';
import { jsonReport, textReport } from './report.ts';

const HELP = `gatetrap: harmless trap tests for AI-agent approval gates

  gatetrap list
  gatetrap run --config <gate.json> [--cases GT-01,GT-03] [--report-dir <dir>]
  gatetrap demo
  gatetrap trap-server        (MCP server over stdio; set GATETRAP_EFFECTS to a file)

Exit status: 0 every selected case passed or was skipped, 1 a case failed, errored or was inconclusive,
2 usage error.`;

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Reads a gate config; relative paths inside it are taken from the config file's own folder. */
function readConfig(path: string): GateConfig {
  const base = dirname(resolve(path));
  const text = readFileSync(path, 'utf8').replaceAll('${CONFIG_DIR}', base);
  const config = JSON.parse(text) as GateConfig;
  if (config.type === 'claude-code' && config.settingsFile) config.settingsFile = resolve(base, config.settingsFile);
  return config;
}

async function runOne(configPath: string, cases: string[] | undefined, reportDir: string | undefined): Promise<boolean> {
  const config = readConfig(configPath);
  const name = config.name ?? configPath;
  const results = await runAll(config, cases);
  process.stdout.write(`${textReport(name, results)}\n`);
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString();
    const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    writeFileSync(join(reportDir, `${slug}.json`), jsonReport(name, results, stamp));
    writeFileSync(join(reportDir, `${slug}.txt`), textReport(name, results));
  }
  return results.every((r) => r.verdict === 'pass' || r.verdict === 'not-run');
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
    if (!config) {
      process.stderr.write(`${HELP}\n`);
      return 2;
    }
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
  process.stderr.write(`${HELP}\n`);
  return cmd === '--help' || cmd === '-h' ? 0 : 2;
}

main(process.argv.slice(2)).then((code) => {
  if (code >= 0) process.exitCode = code;
});
