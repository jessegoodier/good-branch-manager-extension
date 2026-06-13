# Branch Manager & PRs

A modern, simple branch view for VS Code (1.107+). Lives in the **Source Control** sidebar as a "Branches" section.

![screenshot](good-branch-manager.png)

## Features

- **Branch list** with the current branch highlighted, sorted by most recent commit.
- **Sync indicators** on every branch:
  - `current` — the checked-out branch (green check)
  - `local only` — never pushed to a remote
  - `synced` — in sync with its upstream
  - `2↑ 1↓` — ahead/behind counts vs. upstream
  - `upstream gone` — remote branch was deleted (likely merged); safe to clean up
- **Local / Remote groups** — remote branches you haven't checked out appear in a collapsible
  group (configurable via `goodBranchManager.branchScope`).
- **Click to checkout** — clicking a branch switches to it; clicking a remote branch creates a
  local tracking branch.
- **Right-click actions**:
  - *Create Branch From This...* — new branch from any branch
  - *Open Branch on GitHub* — disabled (grayed out) for local-only branches
  - *Create Pull Request...* — opens a form pre-filled with a sensible title and a description
    built from your commit messages; pushes the branch and creates the PR via the GitHub API
    using VS Code's built-in GitHub sign-in
  - *Rename Branch...* / *Merge Into Current Branch*
  - *Pull...* — for the checked-out branch with an upstream; choose regular pull,
    `--rebase`, or `--ff-only`
  - *Set Upstream...* / *Remove Upstream...*
  - *Set as Default Branch* / *Clear Default Branch Override*
  - *Delete Branch...* — safe delete with force-delete fallback, optional remote-branch
    deletion, and automatic `remote prune`
- **Refresh button** on the view title bar, plus **auto-refresh** whenever the repository
  changes (commit, push, fetch, checkout). Optional periodic background refresh is controlled
  by `goodBranchManager.refreshIntervalMins`; the default `0` disables periodic refresh.
- **Stale hints** — each branch shows its last-commit age; branches already merged into the
  default branch are tagged `merged`, and branches with no commits in `goodBranchManager.staleAfterDays`
  (default 30) are tagged `stale`.

## Settings

| Setting                      | Default | Description                                                       |
| ---------------------------- | ------- | ----------------------------------------------------------------- |
| `goodBranchManager.branchScope`    | `both`  | Show `both` local and remote branches, or `local` only            |
| `goodBranchManager.staleAfterDays` | `30`    | Days without commits before a branch is tagged stale (0 disables) |
| `goodBranchManager.refreshIntervalMins` | `0` | Background refresh interval in minutes (0 disables)               |
| `goodBranchManager.defaultBranch`  | `""`    | Override the detected default branch used for merge/PR defaults   |

## Development

```sh
npm install
npm run compile   # or: npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host, or package with
`npx @vscode/vsce package` and install the generated `.vsix`.
