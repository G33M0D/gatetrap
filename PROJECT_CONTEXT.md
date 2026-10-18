# gatetrap: Project Context
> Status: v0.1 built and tested 2026-10-18 (10 of 10 own tests, one live Claude Code check), public, not yet tagged · Maintainer: Gee (G33M0D) · Last updated: 2026-10-18 · Repo: https://github.com/G33M0D/gatetrap

## What this is
A free, open-source test kit that checks whether an AI agent's approval gate (the "ask a person before acting" step)
really stops what it claims to stop. It sets a harmless trap: a tool server whose tools only leave a marker when they
run, then sends the gate a numbered set of failure cases taken from public reports and documented platform behaviour,
and reports which ones got through. Maintained by Gee; a case study and a checklist post on xmodx.com describe it.

## Current status
- 2026-10-18: v0.1 built on the Mac. Trap server, 10 cases, runner, Claude Code and generic connectors, strict and naive
  example gates. `node --test 'test/**/*.test.ts'`: 10 of 10 pass. `node src/cli.ts demo`: strict gate passes 10 of 10
  (Claude Code connector) and 9 of 9 runnable (generic, GT-09 needs a settings file); naive gate fails 9 of 10 as
  designed. Live check in Claude Code 2.1.301 (docs/live-check-2026-10-18.md): block, allow and a real fail-open all
  matched the connector.
- Public on GitHub since 2026-10-18 (no tagged release yet); main is protected against force pushes and deletion.
- 2026-10-18: README rewritten against a ten-agent read of the code with two independent fact-checks; it now shows an
  overview image (`docs/images/gatetrap-overview.png`, made from `docs/images/gatetrap-overview.prompt.txt`) and
  documents the outcomes, reports, exit codes, `${CONFIG_DIR}`, the generic protocol and the known differences from
  real Claude Code.

## Key files / entry points
- `src/cli.ts` command line (list, run, demo, trap-server)
- `src/trap-server.ts` the trap: an MCP server over stdio whose four tools only append a marker line
- `src/runner.ts` plays each case in a fresh folder and counts markers; `src/report.ts` text and JSON reports
- `src/connectors/claude-code.ts` models the main documented PreToolUse rules; `src/connectors/jsonl.ts` generic protocol
- `src/matcher.ts` Claude Code matcher rules (for GT-09)
- `cases/` the numbered failure cases, one file each
- `examples/gates/` small example gates used to prove the kit catches what it should
- `test/` the kit's own tests
- `docs/` the live check record and the README overview image with its brief

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
- xmodx.com, the maintainer's portfolio: the case study /work/approval-gate-trap-tests/ and the post
  /log/ten-ways-approval-gates-fail/ (published 2026-10-18).

## Open questions / unknowns (TODO)
- [ ] Whether the approval-probe author wants to share a case format: asked 2026-10-18 in
      https://github.com/rheannerazo/approval-probe/issues/1, no reply yet.
- [x] Licence: Apache-2.0 (same as approval-probe, includes a patent grant), chosen 2026-10-18.
- [ ] When to test against real gates (n8n Human Review, Strands, Aegis, phantasm).
- [x] A real run inside Claude Code: done once per path on 2026-10-18 (docs/live-check-2026-10-18.md); not automated.
- [x] Gaps found by the 2026-10-18 code read, fixed the same day (CHANGELOG "Fixed"): the marker file now lives outside
      the gate's folder and every line counts; the Claude Code connector follows the documented rule table; hooks run
      only where the settings matchers fire; timeouts stop the whole hook; the generic connector defaults to fail-open
      and discards late replies; usage errors exit 2; package.json is private.
- [x] Tampering with the trap's marker file or the trap server is detected (counted calls checked against the file)
      and reported as an error; tested 2026-10-18.
