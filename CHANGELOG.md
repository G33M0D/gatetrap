# Changelog
> Last updated: 2026-10-18

All notable changes to this project, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Changed (2026-10-18: README and overview image)
- README rewritten against a read of the whole codebase with two independent fact-checks, and given an overview image
  (`docs/images/gatetrap-overview.png`, generated from the brief beside it; every word checked). Corrected: the
  Claude Code connector is described as modelling the main documented hook rules, with a list of known differences,
  instead of "exactly as Claude Code documents it"; the example config now uses `${CONFIG_DIR}` (the old one could not
  find its hook, because commands run in the per-case folder); the control rule exempts GT-09 and needs GT-02 in the
  run; onFailure is read from the gatetrap config only. Added: clone-based quick start, outcome scoring, the
  generic protocol, an MCP client snippet, verdicts, report files, exit codes, gate-writing notes, a responsible
  reporting note and the layout.
- Case sources: GT-01 says "survey respondents"; GT-07, GT-09 and GT-10 are labelled as related sources.
- `docs/live-check-2026-10-18.md` now records the settings, commands and prompts used, and what the check does not show.
- The command help's exit-status line and the report footer now match the code's behaviour.
- AGENTS.md: the run command, the case file description and the trap-server note corrected.

### Changed (2026-10-18)
- Stopped tracking the local `.claude` folder (27ff5f6); recorded the note to approval-probe's author (7d4ba1b).

### Added (2026-10-18: v0.1)
- Trap tool server (MCP over stdio, four harmless tools that only write markers), ten numbered cases with sources,
  runner with text and JSON reports and a control case that turns passes inconclusive when the gate blocks everything.
- Claude Code connector modelling the documented PreToolUse rules (exit codes, decisions, updatedInput, fail-open,
  onFailure "block"), matcher coverage check, and a generic one-line-per-step connector.
- Strict and naive example gates; ten tests; a live check inside Claude Code 2.1.301.

### Added (2026-10-18)
- Project created: tracking documents, git, and the start of the v0.1 build.
