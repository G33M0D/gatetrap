# Agent Instructions: gatetrap
> Last updated: 2026-10-18

Instructions for any AI coding agent in this repository (Claude Code, Codex, Gemini CLI). This repository is public:
every file must be safe for anyone to read.

## Stack
- Node 24, TypeScript run directly by Node's type stripping (no build step): explicit `.ts` import extensions, no
  enums, no namespaces, no parameter properties.
- Zero runtime and zero development dependencies. Tests use `node --test`.

## Build & test commands
- Tests: `node --test 'test/**/*.test.ts'`
- Run the kit: `node src/cli.ts run --config examples/gates/strict-gate.claude-code.json` (help: `node src/cli.ts --help`)
- Demo against the example gates: `node src/cli.ts demo`

## Conventions
- A test case lives in `cases/GT-NN-<slug>.json`; its number never changes once published. Each case says why it
  matters, cites its public source (marked "Related" when the source is not a direct test) and, except GT-09, how many
  actions must run.
- The trap server's tools are harmless: they only append a marker line to the effects file (inside the per-case folder
  the runner creates, or wherever GATETRAP_EFFECTS points when the server runs on its own). They never touch the
  network or any other file.
- README.md, the overview image and its brief (`docs/images/`) must agree with the code; change them together.
- Every report states what a pass does NOT mean.
- No em or en dashes in any file or comment.

## Do not
- Never add a dependency without the maintainer's agreement.
- Never include anyone's private code, data, names, prompts or hostnames. Write everything fresh.
- Never add a machine co-author trailer or generated-by line to a commit.
- Never publish a result about someone else's gate before it has gone to its maintainer privately.

## Key files
See PROJECT_CONTEXT.md, "Key files / entry points".

## Where output goes
Root Markdown files are the six baseline documents only. Design notes go in `docs/`.
