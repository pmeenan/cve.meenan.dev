# Development workflow

How AI agents and the human developer collaborate here. This is an MVP/demo
project — one primary user, no SLA, and deploys are a reversible rsync. The
process is sized for that: the default path from idea to commit is **one
agent, one pass, one human scan**. (D-062)

## The loop

1. **Build.** One agent implements the task (scope from [plan.md](plan.md)),
   runs `pnpm check` (and `pnpm e2e` when the change touches the browser data
   path), and ends with a short note: what changed, what was verified.
2. **Commit.** The human scans the note and the diff at whatever depth the
   change warrants, and commits. Agents never commit.

That is the whole gate. There are no mandatory review passes, no multi-agent
review structure, and no verification-of-the-verification.

## Ground rules

- **Agents never commit** — even if a prompt asks. The working tree is the
  handoff.
- **Don't hand off broken.** Checks pass before you end your turn; if they
  don't, say so plainly instead of papering over it.
- **One stream of work at a time.** Check `git status` first; if there are
  changes you didn't make, you're iterating on in-flight work, not starting
  fresh.
- **Scratch files stay out of the tree.**
- **Fix the docs the change makes wrong** (status paragraph, plan checkbox,
  affected doc) in the same change. Nothing more is owed.

## Reviews happen on demand, not by default

The human asks for a review when a change warrants one. When asked:

- One agent, one pass, over the whole uncommitted diff.
- Hunt real defects — data loss or corruption, security, broken behavior —
  not style, ceremony, or missing log entries.
- Findings are file:line claims ranked by severity. A clean review is a valid
  result.
- Fix what you find directly unless the human asked for a report only.

## When to go heavy

A small class of changes can destroy a user's local database, corrupt the
published artifact chain, or open a security hole: crash-safety around
OPFS/SQLite, the publish pipeline's immutable URLs, the chat relay, anything
that renders or prompts with CVE text. For those the human may explicitly ask
for the heavyweight treatment — multi-agent review, adversarial challenge,
fix/verify rounds. That escalation is the human's call to make; agents don't
self-escalate beyond one pass.
