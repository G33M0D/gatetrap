# gatetrap: Plan
> Last updated: 2026-10-18

## Goal
A small, trustworthy kit that anyone can run against their AI agent's approval gate to see which known failure cases
get through, maintained by Gee and linked from xmodx.com.

## Phases / roadmap
- [x] **v0.1 build**, done 2026-10-18: tests 10 of 10, demo as expected, one live Claude Code check
  - [x] Trap tool server (speaks the Model Context Protocol over standard input and output, zero dependencies)
  - [x] Ten numbered failure cases, each with why it matters, its source and its expected count
  - [x] Runner with JSON and plain-text reports
  - [x] Claude Code hook connector modelling the main documented hook rules
  - [x] Generic connector (one JSON line per step) for any gate
  - [x] Example strict gate (should pass) and naive gate (should fail some cases), with tests proving it
  - [x] README with a "what a pass does not mean" section and credit to approval-probe
- [x] **Go public** (2026-10-18): public GitHub repository under G33M0D, Apache-2.0
- [x] **Portfolio**: case study and checklist post on xmodx.com (owner-signed, released 2026-10-18)
- [x] **README overview image** and a README checked against the code (2026-10-18)
- [ ] **Hardening**: close the gaps listed in PROJECT_CONTEXT.md open questions, then tag v0.1.0
- [ ] **First real targets**: the maintainer's own secure-minimal-agent, then Aegis and phantasm (results sent to maintainers
      privately first)
- [ ] **Launch**: Show HN, the n8n approval thread, awesome-claude-code after 14 days and real users

## Done (validated)
- v0.1 (2026-10-18): own tests 10 of 10; strict example passes all cases, naive example fails 9 of 10 as designed;
  live Claude Code 2.1.301 check of block, allow and fail-open (docs/live-check-2026-10-18.md).
- Survey of existing projects and scope (2026-10-18).

## Next up
- Wait for a reply on approval-probe issue 1 (posted 2026-10-18).
- Run against the maintainer's secure-minimal-agent.
- Hardening of the known gaps (PROJECT_CONTEXT.md), on the maintainer's go.

## Out of scope / parked
- Another approval gate, audit-trail library or scanner (crowded, research 2026-10-18).
- Anything that needs a paid model or service.
- Audit-log tamper checks (roadmap after v0.1).

## Risks & open questions
- Demand for testing gates is inferred, not measured. Stop rule: if nobody outside uses, links or searches for it
  within 90 days of launch, freeze it as interview proof.
- A wrong pass or fail on someone's named project costs credibility; results go to maintainers privately first.
- The Claude Code connector models the main documented rules and was checked once per path in a live session
  (docs/live-check-2026-10-18.md); edge cases differ (README, "Known differences from real Claude Code").
