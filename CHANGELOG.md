# Changelog
> Last updated: 2026-10-18

All notable changes to this project, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed (2026-10-18: the gaps found by the code read)
- The count can no longer be hidden by the gate: the trap's marker file lives in a separate folder the gate is not
  given, and every line in a case's file counts whatever arguments the gate passed on (rewritten arguments are noted in
  the log). Tested with a gate that strips the marker and one that empties its own folder.
- The Claude Code connector follows the rule table in Claude Code's hooks reference: a valid JSON decision stands on
  any exit code except 2 (a failure when onFailure is "block"); plain text and broken JSON are told apart by the
  documented rules; the documented PreToolUse fields are checked; defer ignores updatedInput; onFailure "continue" is
  accepted. The event now carries mcp_server, prompt_id and scratchpad_dir.
- With a settings file, the hook runs only for tools its PreToolUse matchers cover, as in Claude Code.
- A hook that times out is stopped with everything it started, so a leftover process cannot stall a run.
- Generic connector: a late reply is discarded instead of answering the next request; a gate failure now defaults to
  fail-open (onFailure "run"), the worst case for an unknown platform.
- Trap server: negotiates the protocol version, answers a marker write failure instead of crashing, refuses to start
  when the effects folder does not exist. A trap server that dies mid-case makes the case an error at once.
- Command line: an unreadable config, an unknown case id or an unknown command exits 2 with a message; help goes to
  standard output; a run without GT-02 prints a reminder; `${CONFIG_DIR}` is escaped; reports are named
  `<name>.report.json` and `<name>.report.txt` and the JSON adds `connector` and `summary`; logs show the home folder
  as `~`; the report footer names the connector that ran.
- package.json is private and no longer points a bin entry at a .ts file; the version has one source.
- From a second, adversarial check against the hooks reference: the deprecated top-level decision "approve" or
  "block" counts as allow or deny; defer counts like ask (the tool does not run in a non-interactive run); a hook that
  allows and leaves a process holding its output is blocked ("suspect capture"); on exit 2 a blocking JSON decision's
  reason is reported; disableAllHooks, async, asyncRewake and if-filtered handlers never count as a gate.
- gatetrap counts its own trap calls and checks the marker file against them: a gate that changes the file from
  outside its folder, or kills the trap server, now turns the case into an error. A config with an unknown type and an
  unknown case id exit 2 before anything runs; a config without a name is named after its file.
- Tests: 27 (was 10), including gates that strip the marker, empty their folder, wipe the marker file elsewhere and
  kill the trap.

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
