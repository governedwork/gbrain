# This fork: GovernedWork's GBrain

Ours (governedwork fork), not upstream GBrain. CLAUDE.md and AGENTS.md are upstream's and stay as upstream writes them
(one pointer line at the top), so an upstream sync does not conflict; the fork's own guidance is this file.

Use `mise run <task>`: `setup` (dependencies), `dev` (the CLI from source: `mise run dev -- --help`), `check` (the
lander's fast check: `typecheck:native`, the typecheck on TypeScript 7's native compiler), `check:full` (upstream's
unit suite), and `deploy`, `rollback`, `status`, which say there is nothing to deploy: captain pins and ships the
GBrain its brains run.

Landing: pull requests target the branch for the upstream version the fork carries (`brains-v<upstream>`; the current
base is `brains-v0.60.737.0`), never `master`, which is upstream's history. Open the PR, then `lander enqueue <pr-url>`
once (the `lander` on PATH) and stop; the lander validates, posts the required `lander/verdict` and merges. Never merge
by hand, set auto-merge or watch in a loop.

Docs: upstream's are CLAUDE.md, AGENTS.md and `docs/`; the fork's CI is the lander's gate (the typecheck) alone.
Upstream's own workflows are not carried, and the fork has no nightly: the suite is upstream's, which upstream runs, and
a public repository runs nothing on the wardrobe (lander profile, `[recipe_exceptions]`).

Gotchas:
- The lander's check is the typecheck alone (`bun run typecheck:native`: TypeScript 7's `tsc`, package
  `typescript-native`, config `tsconfig.native.json`; upstream's `typecheck` and the scripts that import the `typescript`
  API keep 5.9), on Bun 1.4.4. Nothing runs the whole suite after the merge (upstream runs it). Run the tests your
  change can break and `bun run verify` yourself, and say in the PR what you ran.
- The whole suite assumes Linux (flock(1), case-sensitive paths, `ps`): on macOS it is red on bare upstream too.
- Fork-only files say so (`Ours (governedwork fork)`), fork tests are `test/fork-*.test.ts`, and a fork commit is
  `fork(<area>): …`. Upstream's CLAUDE.md is capped at 35,000 bytes (`scripts/check-key-files-current-state.sh`), with
  only a few bytes left: keep fork text out of it.
