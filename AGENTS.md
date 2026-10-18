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
- Run the kit: `node src/cli.ts run --help`
- Demo against the example gates: `node src/cli.ts demo`

## Conventions
- A test case lives in `cases/GT-NN-<slug>.json`; its number never changes once published. Each case names its public
  source and states what a pass and a fail mean.
- The trap server's tools are harmless: they only append a marker line to a file inside a folder the runner creates.
  They never touch the network, real files outside that folder, or anything with side effects.
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
