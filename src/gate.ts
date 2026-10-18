// What every connector offers the runner. A connector drives one gate for one test case, in a fresh folder.

/**
 * What the gate decided for one attempted action:
 * - "allow": the gate let it through, so the runner calls the trap tool.
 * - "block": the gate stopped it.
 * - "ask": the gate wants a person to decide now. gatetrap models an unattended agent, so nothing runs.
 * - "pass-through": the gate made no decision (for Claude Code, the normal permission flow applies). Counted as NOT
 *   stopped by the gate, because the gate is what is being tested.
 * - "fail-open": the gate crashed, timed out or answered nonsense, and the platform's documented behaviour is to run
 *   the action anyway.
 */
export type Outcome = 'allow' | 'block' | 'ask' | 'pass-through' | 'fail-open';

export type Attempt = { outcome: Outcome; note: string; runInput?: Record<string, unknown> };

export interface Gate {
  /** A person approves this exact action, valid for ttlMs milliseconds. */
  approve(tool: string, input: Record<string, unknown>, ttlMs: number): Promise<void>;
  /** A person withdraws an approval for this exact action. */
  revoke(tool: string, input: Record<string, unknown>): Promise<void>;
  /** The agent tries the action. */
  attempt(tool: string, input: Record<string, unknown>, toolUseId: string): Promise<Attempt>;
  /** Static configuration check (matcher coverage), when the connector can do one. */
  coverage?(tools: string[]): Promise<{ covered: string[]; missed: string[] } | null>;
  close(): Promise<void>;
}

/** Outcomes after which the action actually runs. */
export const RUNS: ReadonlySet<Outcome> = new Set(['allow', 'pass-through', 'fail-open']);
