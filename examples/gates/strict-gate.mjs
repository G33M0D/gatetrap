#!/usr/bin/env node
// Example STRICT approval gate, written to pass every gatetrap case. Not a product: a reference for what each case
// expects.
//
// - An approval is bound to the exact tool name and the exact arguments (a hash of both, keys sorted).
// - It is used once: the approval file is renamed away atomically, so two simultaneous attempts cannot both win.
// - It expires, and a person can withdraw it.
// - Any error, including input it does not understand, blocks (exit 2): it fails closed.
//
// Modes:
//   node strict-gate.mjs            Claude Code PreToolUse hook (event JSON on stdin)
//   node strict-gate.mjs approve    record a person's approval   ({"tool_name","tool_input","ttl_ms"} on stdin)
//   node strict-gate.mjs revoke     withdraw it                   (same input)
//   node strict-gate.mjs --jsonl    gatetrap's generic one-line-per-step protocol

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const RISKY = /^mcp__gatetrap__(write_record|delete_record|send_payment)$/;
const home = join(process.env.CLAUDE_PROJECT_DIR ?? process.env.GATETRAP_CASE_DIR ?? process.cwd(), '.strict-gate');
mkdirSync(join(home, 'used'), { recursive: true });

const full = (tool) => (tool.startsWith('mcp__') ? tool : `mcp__gatetrap__${tool}`);
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const key = (tool, input) => createHash('sha256').update(JSON.stringify([full(tool), canonical(input)])).digest('hex');

function approve(tool, input, ttlMs) {
  writeFileSync(join(home, key(tool, input)), JSON.stringify({ expiresAt: Date.now() + Number(ttlMs) }));
}
function revoke(tool, input) {
  rmSync(join(home, key(tool, input)), { force: true });
}
/** Returns null if allowed, or the reason it is not. */
function decide(tool, input) {
  if (typeof tool !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) return 'malformed request';
  if (!RISKY.test(full(tool))) return null;
  const k = key(tool, input);
  const used = join(home, 'used', `${k}-${process.pid}-${Date.now()}`);
  try {
    renameSync(join(home, k), used); // atomic: only one attempt can take this approval
  } catch {
    return 'no unused approval for this exact action';
  }
  const { expiresAt } = JSON.parse(readFileSync(used, 'utf8'));
  if (Date.now() > expiresAt) return 'approval expired';
  return null;
}

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

const mode = process.argv[2];
if (mode === '--jsonl') {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let out;
    try {
      const m = JSON.parse(line);
      if (m.op === 'approve') (approve(m.tool, m.input, m.ttlMs), (out = { ok: true }));
      else if (m.op === 'revoke') (revoke(m.tool, m.input), (out = { ok: true }));
      else {
        const why = decide(m.tool, m.input);
        out = why ? { decision: 'deny', reason: why } : { decision: 'allow' };
      }
    } catch (e) {
      out = { decision: 'deny', reason: `gate error: ${e.message}` };
    }
    process.stdout.write(`${JSON.stringify(out)}\n`);
  });
} else {
  try {
    const msg = JSON.parse(await readStdin());
    if (mode === 'approve') approve(msg.tool_name, msg.tool_input, msg.ttl_ms);
    else if (mode === 'revoke') revoke(msg.tool_name, msg.tool_input);
    else {
      const why = decide(msg.tool_name, msg.tool_input);
      const permissionDecision = why ? 'deny' : 'allow';
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: why ?? 'exact approval used' } }));
    }
  } catch (e) {
    process.stderr.write(`strict gate error, blocking: ${e.message}\n`);
    process.exit(2);
  }
}
