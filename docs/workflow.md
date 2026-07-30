# Development workflow

How AI agents and the human developer collaborate on this repository. Complements the
root `AGENTS.md` rules (especially: agents never commit).

## The loop

1. **Initial work** — one agent implements a task in a **clean working tree** (fresh
   from the last human commit). Scope comes from [plan.md](plan.md) checkboxes.
2. **Review passes** — other agents review and iterate on the in-flight changes,
   **one agent at a time** (serial, never parallel — there is one working tree and
   uncommitted state is shared). Each reviewer either improves the change or reports
   findings for the next iteration.
3. **Human gate** — iteration continues until the developer is satisfied; the developer
   commits. Nothing is ever committed by an agent. The human operates at the level of
   direction: managing agents, making product decisions, guiding reviews, and scanning
   changes and results — not reading every line before commit. Line-level review is the
   job of the AI review passes.

## Rules that make the loop work

- **One stream of work at a time.** Don't start unrelated task B while task A's changes
  are uncommitted, and never assume the tree is clean — check `git status` first; if
  there are changes you didn't make, you are probably an iteration/review agent in
  step 2, not the initial agent in step 1.
- **Leave the tree explainable.** Every agent ends its turn with a summary of what
  changed and why, plus what it verified. The next agent (or the human) must be able
  to pick up from the message alone.
- **Scratch files stay out of the tree.** Temporary scripts/outputs go to the session
  scratchpad, not the repo.
- **Docs move with code:** plan checkboxes, decision log, and affected docs are
  updated within the same in-flight change, so the human commit is coherent.
- **Verification before handoff:** the initial agent runs the repo's checks (see the
  README for the check commands once the toolchain lands) before declaring work
  review-ready; reviewers re-run them when the change affects verified behavior.

## Milestone work: tech-lead mode

A prompt like "start work on M2" makes you the **tech lead** for that milestone. That
means:

- **Scope a task-sized unit of work.** Pick the next unblocked plan.md task in
  dependency order and take it whole — a full task is the default unit; a full
  milestone is acceptable when its tasks are tightly coupled. Don't fragment work into
  small chunks to fit a human line-by-line reader (review is AI-led), and don't sprawl
  the working tree across unrelated tasks; the human gate still closes each unit.
- **Delegate deliberately.** Spawn subagents for well-scoped pieces, choosing each
  subagent's model and reasoning effort to match its task. The working tree is shared:
  subagents that write must run serially or own disjoint files; parallelize freely only
  for read-only work (research, code reading, verification).
- **You own acceptance.** Review every subagent's output and don't accept it until it
  meets the bar. Acceptance means evidence, not reading: run the checks yourself. A
  subagent reporting success is an assertion, not a measurement.
- **You own the cross-cutting rules.** Decision-log entries, rough-edges findings, docs
  moving with code — delegating work never delegates these.
- **Adversarial review before handoff.** When you believe the unit is complete, run a
  fresh-context review over the full working-tree diff, briefed to find problems —
  correctness, rule breaches, missing docs — not to summarize or approve. For
  task-sized-or-larger diffs, use the multi-agent review structure from reviewer mode
  below. Address every finding worth addressing, re-verify, and re-review if the fixes
  were substantial.
- **End with the handoff summary** (rule above): what changed and why, what was
  verified and how, what remains open.

## Review passes: reviewer mode

Any prompt requesting a review of uncommitted modifications (e.g., "review the current
changes", "take a look at the changes") triggers **reviewer mode** (step 2 of the
loop). The unit under review is the **entire uncommitted working tree** — the diff
against the last commit plus untracked files — including whether the docs that should
have moved with the change actually did.

- **Do not simply summarize the changes.** Perform an active, critical review looking
  for correctness bugs, logic errors, quality issues, and rule compliance.
- **Read-only by default.** You report; the agent that did the work owns the fixes.
  Don't edit the tree unless the human explicitly asks you to fix directly.
- **Structure the review as a team.** For task-sized or larger diffs, act as the
  **review lead**:
  1. Partition the diff into pieces sized for one subagent to review deeply.
  2. Spawn a reviewer subagent per piece (read-only, so run them in parallel).
  3. Merge and deduplicate their findings, then **verify each surviving finding
     yourself** — subagent findings are claims, not facts.
  4. Spawn an **adversarial challenge subagent** against the merged review, briefed to
     attack it from both sides: refute findings that don't hold up, and hunt for what
     the piecewise reviewers missed — especially cross-cutting issues that span piece
     boundaries.
  5. Fold the challenge results in before writing the final report.

  A diff small enough for one deep read may skip the fan-out (steps 1–3) but never the
  adversarial challenge.
- **Review thoroughly, not just for bugs:** AGENTS.md rule violations, missing
  decision-log or rough-edges entries, and better approaches (reported as suggestions,
  clearly distinct from defects).
- **Verify before you report.** Run the repo checks instead of guessing.
- **Write findings for handback.** The report goes verbatim to the implementing agent,
  who has the tree but not your conversation — each finding must be self-contained:
  location (file:lines), details (what/why/severity), a concrete suggestion phrased as
  a claim to **verify** ("X appears to break Y when Z — verify and fix, or rebut with
  evidence"), ranked most-severe first.
- **A clean review is a valid result.** If nothing survives verification, say so
  plainly — don't manufacture findings to look thorough.

## Findings handback: fix-pass mode

A prompt that hands you review results ("here are the review findings — address them")
makes you the **fix-pass agent**: the findings came from a reviewer, and you now own
the tree.

- **Verify independently before fixing.** Each finding is a claim, not an order.
  Confirm the problem yourself before changing anything.
- **Fix what's confirmed** at the root cause, with docs moving alongside, and re-run
  the relevant checks afterward.
- **Push back where appropriate.** A finding that doesn't survive verification gets a
  rebuttal with concrete evidence, not a grudging fix. "Won't fix" carries the same
  burden of proof as a fix.
- **End with a per-finding disposition:** fixed (what changed, how verified) or
  rebutted (the evidence). Write it self-contained — it goes verbatim to a
  verification pass that has the tree and your report but not your conversation.

## Fix verification: verify-pass mode

Any prompt requesting to check or verify fixes ("verify the fixes") triggers
**verify-pass mode**: evaluate the fix-pass agent's changes and disposition report
against the current working tree.

- **Retrieve the context first.** If the original findings and disposition report
  aren't in the prompt, recover them from session logs; if you can't, ask the human
  rather than guessing.
- **Verify each fix against the tree, not the report.** Run the actual checks.
- **Adjudicate each pushback independently** on the evidence.
- **Read-only by default** — report, don't fix.
- **Report a per-finding verdict:** `fix verified` · `fix incomplete or wrong (with
  evidence)` · `pushback accepted` · `pushback rejected (why the finding stands)`.
  All-positive is a valid result — don't manufacture disputes.
