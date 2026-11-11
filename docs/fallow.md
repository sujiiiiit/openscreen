# Fallow — codebase intelligence

[Fallow](https://fallow.tools/) is the repo's static analysis layer for TypeScript and
JavaScript. It builds one module graph and reports dead code, import cycles,
duplication, complexity, architecture boundaries, and (opt-in) security
candidates. It is not a linter or a type checker: `pnpm lint`, `pnpm typecheck`,
and Vitest keep their existing jobs.

- Fallow version: `3.42.0` (declared in `package.json` and locked in `pnpm-lock.yaml`).
- Config: [`.fallowrc.json`](../.fallowrc.json).
- Committed baselines: [`fallow-baselines/`](../fallow-baselines/).
- Agent skills: `.agents/skills/fallow/`, `.agents/skills/fallow-setup/`,
  `.claude/skills/fallow/`, `.claude/skills/fallow-setup/`.

## Commands

```bash
pnpm fallow             # full report: dead code + architecture + duplication + health
pnpm fallow:dead-code   # unused files, exports, types, members, dependencies, cycles
pnpm fallow:health      # complexity, hotspots, maintainability, refactoring targets
pnpm fallow:dupes       # clone groups and families
pnpm fallow:audit       # PR/commit gate for changed files (uses the baselines)
```

Useful focused commands:

```bash
pnpm exec fallow dead-code --unused-files
pnpm exec fallow dead-code --trace src/file.ts:exportName
pnpm exec fallow dead-code --trace-dependency lodash
pnpm exec fallow health --hotspots --targets
pnpm exec fallow dupes --trace dup:<fingerprint>
pnpm exec fallow list --entry-points
pnpm exec fallow explain unused-export
```

Agents should use machine output, for example
`pnpm exec fallow dead-code --format json --quiet`. Exit codes `0` and `1` are
normal analysis outcomes (`1` means findings); anything else is a tool/config
failure, not dead code.

## Policy

`.fallowrc.json` models this repository rather than suppressing findings one by
one:

- `entry` / `supportEntry` — `build-resources/**/*.cjs` are electron-builder
  hooks referenced from `electron-builder.yml`; `scripts/**/*.mjs` are manual
  developer tools. Both are `supportEntry`, so they stay reachable in normal
  runs but are excluded from production-only analysis; neither is reachable
  from a TypeScript import.
- `dynamicallyLoaded` — `electron/preload.ts` is loaded by string path from the
  `BrowserWindow` configuration.
- `ignoreExports` — `src/components/ui/**` (shadcn/ui) and
  `src/components/animate-ui/**` are vendored component-library surfaces, so their
  broad exports are intentional.
- `ignoreExportsUsedInFile` — exported constants used only in their own module
  are not dead API.
- `ignoreDependencies` — `node-addon-api` is used by `binding.gyp` and the C++
  headers; `@interactjs/actions` and `@interactjs/core` are subpath packages
  shipped by `interactjs`; `postcss-load-config` is a type-only JSDoc import.
- `boundary-violation` and `policy-violation` are `off` until the team defines
  architecture zones or rule packs. This is an explicit "not configured yet",
  not a claim that the checks passed.
- Everything else keeps the high-confidence default (`error`). The existing
  backlog is recorded in baselines so new code is gated immediately.

## Baselines and the gate

`fallow audit` is the day-to-day gate. It analyzes only the files changed
against the base ref and ignores findings recorded in the committed baselines.
A PR that introduces a new unused export, dependency, cycle, clone group, or
over-threshold function fails; pre-existing debt in touched files does not.

The baselines were saved on **2026-11-11** against the policy above:

| Baseline | Content |
|---|---|
| `fallow-baselines/dead-code.json` | 57 findings: 17 unused exports, 2 unused types, 32 unused class members, 2 import cycles |
| `fallow-baselines/health.json` | 288 functions above the cyclomatic/cognitive/CRAP thresholds (identity mode) |
| `fallow-baselines/dupes.json` | 44 clone groups / 24 families, 1,848 duplicated lines (4.5%) |

Repo health at that snapshot: **76.5 / B**, maintainability 91.3, 2 circular
dependencies (both in the forked `packages/timeline-engine`).

Regenerate **all three** only after an intentional cleanup or a threshold/policy
change, and commit them together:

```bash
pnpm fallow:baselines
```

`dead-code` and `health` exit `1` while the current findings still exist; the
script uses `;` so all three baselines are written anyway. Check the files in
`git status` and commit them together.

Do not regenerate baselines per merge; that quietly records new debt as
"pre-existing". Keep the files outside `.fallow/`, which is the machine-local
cache and is gitignored.

To see what is still on the cleanup list:

```bash
pnpm fallow:dead-code
pnpm fallow:health --hotspots --targets
pnpm fallow:dupes
```

Known cleanup candidates: the two `timeline-engine` import cycles.

## Agent integration

`fallow agent install --without guide --without mcp --without hooks` installed
the version-matched `fallow` and `fallow-setup` skills into both skill
directories. The skills point at the copy inside `node_modules/fallow`, so they
follow the installed CLI version.

For a harness that supports MCP, register the local server:

```bash
fallow-mcp
```

Example client config:

```json
{
  "mcpServers": {
    "fallow": {
      "command": "fallow-mcp"
    }
  }
}
```

There is also a read-only docs MCP server at `https://fallow.tools/docs/mcp`.

The full one-command agent setup (AGENTS.md task map, skill, MCP registration,
and a Claude/Codex commit gate) is available but was intentionally not run
because it writes harness-specific config and a pre-commit gate:

```bash
fallow agent install
```

## CI

No CI workflow is committed yet. The intended GitHub Actions gate, to be added
when the repo has a `.github/workflows/` setup, is:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: pnpm/action-setup@v4
  with:
    version: 10
- uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: pnpm
- run: pnpm install --frozen-lockfile --ignore-scripts
- run: pnpm exec fallow audit --base "origin/${{ github.base_ref }}"
```

`fetch-depth: 0` is required because `audit` compares against the merge base.
Gate on the command exit code (or `verdict == "fail"` in JSON), not on raw
finding counts: `unused-exports: warn` findings must not fail a build that the
verdict calls `warn`.

## Verification

```bash
pnpm exec fallow doctor          # install, config, workspaces, cache
pnpm exec fallow config          # resolved policy
pnpm exec fallow list --entry-points
pnpm exec fallow audit --base HEAD
```

`fallow doctor` should report `Status: ready`. `audit` on an uncommitted tree
sees committed changes only; pass `--diff-file <(git diff HEAD)` (or commit
first) when testing a working tree.
