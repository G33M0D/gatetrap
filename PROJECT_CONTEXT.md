# gatetrap: Project Context
> Status: v0.1 built and tested 2026-10-18 (10 of 10 own tests, live Claude Code check), public · Maintainer: Gee (G33M0D) · Last updated: 2026-10-18 · Repo: https://github.com/G33M0D/gatetrap

## What this is
A free, open-source test kit that checks whether an AI agent's approval gate (the "ask a person before acting" step)
really stops what it claims to stop. It sets a harmless trap: a tool server whose tools only leave a marker when they
run, then sends the gate a numbered set of failure cases taken from public reports and documented platform behaviour,
and reports which ones got through. Maintained by Gee; related write-ups on xmodx.com.

## Current status
- 2026-10-18: v0.1 built on the Mac. Trap server, 10 cases, runner, Claude Code and generic connectors, strict and naive
  example gates. `node --test 'test/**/*.test.ts'`: 10 of 10 pass. `node src/cli.ts demo`: strict gate passes 10 of 10
  (Claude Code connector) and 9 of 9 runnable (generic, GT-09 needs a settings file); naive gate fails 9 of 10 as
  designed. Live check in Claude Code 2.1.301 (docs/live-check-2026-10-18.md): block, allow and a real fail-open all
  matched the connector.
- Published on GitHub as v0.1 (2026-10-18).

## Key files / entry points
- `src/cli.ts` command line (list, run, demo, trap-server)
- `src/trap-server.ts` the trap: an MCP server over stdio whose four tools only append a marker line
- `src/runner.ts` plays each case in a fresh folder and counts markers; `src/report.ts` text and JSON reports
- `src/connectors/claude-code.ts` documented PreToolUse contract; `src/connectors/jsonl.ts` generic protocol
- `src/matcher.ts` Claude Code matcher rules (for GT-09)
- `cases/` the numbered failure cases, one file each
- `examples/gates/` small example gates used to prove the kit catches what it should
- `test/` the kit's own tests

## Data sources & integrations
- No accounts, keys, network calls or paid services. Everything runs locally with Node.
- Claude Code hook behaviour is taken from the official hooks page (code.claude.com/docs/en/hooks, read 2026-10-18).

## Key decisions & constraints
- Scope chosen on 2026-10-18 after a survey of existing projects: approval gates are widely built, but tools that test
  them are almost absent, and it runs free with no model calls.
- Prior work: rheannerazo/approval-probe (Apache-2.0, v0.1.0, last commit 2026-08-25) tests six approval cases
  through simulated adapters for OpenAI Codex. gatetrap credits it and covers what it lists as future work or does not
  cover: a real tool server any agent can call, Claude Code hooks, retries, fail-open on crash or timeout, matcher
  coverage and scope binding.
- Zero runtime dependencies, so anyone can read and trust it.
- Free only; everything written fresh for this project.
- No machine co-author lines in commits.

## Related projects
- xmodx.com, the maintainer's portfolio: a checklist page and a case study will link here.

## Open questions / unknowns (TODO)
- [ ] Whether the approval-probe author wants to share a case format: asked 2026-10-18 in
      https://github.com/rheannerazo/approval-probe/issues/1, no reply yet.
- [x] Licence: Apache-2.0 (same as approval-probe, includes a patent grant), chosen 2026-10-18.
- [ ] Whether to test against real gates (n8n Human Review, Strands, Aegis, phantasm) in v0.1 or later.
- [ ] Real end-to-end run inside an actual Claude Code session (needs a model call; the v0.1 connector reproduces the
      documented hook contract instead).
