#!/usr/bin/env node
// Example NAIVE approval gate. It looks reasonable and is the kind of thing that ships, but it has common mistakes on
// purpose so gatetrap has something to catch:
// - approvals are remembered per tool name only, so the details can change and one approval works forever
// - approvals never expire and cannot be withdrawn
// - it logs the payment amount for every request, which throws for tools without an amount; the hook then exits 1,
//   and Claude Code runs the tool anyway (fail-open)
// - its settings file uses the matcher "mcp__gatetrap", which matches no tool at all
//
// Modes: no argument = Claude Code PreToolUse hook; "approve" and "revoke" read {"tool_name","tool_input"} on stdin.

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const home = join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), '.naive-gate');
mkdirSync(home, { recursive: true });

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const msg = JSON.parse(raw);
const mode = process.argv[2];

if (mode === 'approve') {
  writeFileSync(join(home, msg.tool_name), 'approved');
} else if (mode === 'revoke') {
  // not implemented
} else {
  const risky = /write_record|delete_record|send_payment/.test(msg.tool_name);
  appendFileSync(join(home, 'audit.log'), `${msg.tool_name} amount=${msg.tool_input.amount.toFixed(2)}\n`);
  const ok = !risky || existsSync(join(home, msg.tool_name));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: ok ? 'allow' : 'deny', permissionDecisionReason: ok ? 'approved' : 'needs approval' } }));
}
