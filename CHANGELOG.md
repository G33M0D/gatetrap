# Changelog
> Last updated: 2026-10-18

All notable changes to this project, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added (2026-10-18: v0.1, private)
- Trap tool server (MCP over stdio, four harmless tools that only write markers), ten numbered cases with sources,
  runner with text and JSON reports and a control case that turns passes inconclusive when the gate blocks everything.
- Claude Code connector following the documented PreToolUse contract (exit codes, decisions, updatedInput, fail-open,
  onFailure "block"), matcher coverage check, and a generic one-line-per-step connector.
- Strict and naive example gates; ten tests; a live check inside Claude Code 2.1.301.

### Added (2026-10-18)
- Project created: tracking documents, git, and the start of the v0.1 build.
