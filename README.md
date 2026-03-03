# worktree-kit

CLI tool to simplify git-worktree workflow with automatic config file copying.

## Why worktree-kit?

Git worktrees let you work on multiple branches simultaneously, but the built-in tooling leaves gaps:

- **Config copying** — `.env`, local configs, and other untracked files must be copied manually to each new worktree
- **Worktree management** — no convenient way to list, remove, or bulk-manage worktrees
- **Staying in sync** — keeping feature branches rebased on the default branch requires repetitive manual work
- **Stale cleanup** — worktrees and branches for deleted remote branches pile up over time

worktree-kit fills these gaps with a single CLI.

## Features

- Interactive branch selection with local and remote branch support
- Automatic file and directory copying with glob patterns
- Symlinks from root repo for sharing gitignored content across worktrees
- Post-create, pre-remove, and post-update hooks with environment variables
- Smart update: fetch, fast-forward default branch, rebase feature branches in correct order
- Parent branch detection via merge-base for proper rebase ordering
- Automatic cleanup of worktrees with deleted remote branches
- Dry-run mode for safe operation preview
- Non-interactive mode for CI/scripts/AI agents (`--non-interactive` or `WT_NON_INTERACTIVE=1`)
- Verbose logging (`--verbose` or `WT_VERBOSE=1`)

## Installation

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/epodivilov/worktree-kit/main/scripts/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/epodivilov/worktree-kit/main/scripts/install.ps1 | iex
```

### Build from source

```bash
pnpm install
pnpm build
cp ./dist/wt ~/.local/bin/
```

## Quick Start

```bash
# 1. Initialize config in your project
wt init

# 2. Create a worktree
wt create feature/my-feature

# 3. See all worktrees
wt list
```

## Global Options

These flags apply to all commands:

| Flag | Env Variable | Description |
|------|-------------|-------------|
| `--verbose` | `WT_VERBOSE=1` | Enable detailed debug logging |
| `--non-interactive` | `WT_NON_INTERACTIVE=1` | Disable all interactive prompts |

**Non-interactive mode** — when active, all prompts are resolved automatically:

- Required selection prompts (branch name) exit with an error if the value is not provided via CLI arguments
- Optional confirmation prompts use safe defaults (typically "no" for destructive actions)
- `wt cleanup` proceeds automatically without confirmation

This is useful for CI pipelines, shell scripts, and AI agents.

## Commands

### `wt init`

Create `.worktreekit.jsonc` configuration file in the repository root.

```bash
wt init [options]
```

| Flag | Alias | Description |
|------|-------|-------------|
| `--force` | `-f` | Overwrite existing config |
| `--migrate` | `-m` | Rename legacy `.worktreekitrc` to `.worktreekit.jsonc` |

### `wt create`

Create a new worktree with automatic config file copying and hook execution.

```bash
wt create [branch] [options]
```

| Flag | Alias | Description |
|------|-------|-------------|
| `--base` | `-b` | Base branch to create from |
| `--dry-run` | | Show what would be done without making changes |

**Examples:**

```bash
# Interactive mode — select from local/remote branches or create new
wt create

# Create worktree for an existing branch
wt create feature/my-feature

# Create worktree from a specific base branch
wt create feature/my-feature --base develop
```

**Interactive mode** (no branch argument):

- Shows a menu of available local branches (excluding those already with worktrees)
- "Create new branch" option — prompts for a branch name, then asks for a source branch
- "Remote branches..." submenu — lists available remote branches

**Base branch selection** for new branches (priority order):

1. `--base` flag
2. `create.base` config option
3. `defaultBase` config behavior: `"current"` uses current branch, `"default"` uses main/master, `"ask"` shows interactive prompt

After creation, files from the `copy` config are copied, `symlinks` are created, and `post-create` hooks are executed.

### `wt list`

List all worktrees in the repository.

```bash
wt list
```

Output shows each worktree with its path. Badges: `(main)` for the main worktree, `(current)` for the active one.

### `wt remove`

Remove worktree(s) and optionally delete their branches.

```bash
wt remove [branch] [options]
```

| Flag | Description |
|------|-------------|
| `--delete-branch` | Delete local branch after removal |
| `--delete-remote-branch` | Delete remote branch |
| `--force` | Force delete unmerged branches |
| `--dry-run` | Show what would be done without making changes |

**Examples:**

```bash
# Interactive selection
wt remove

# Remove specific worktree
wt remove feature/old-feature

# Remove and delete branch
wt remove feature/old-feature --delete-branch

# Preview what would happen
wt remove --dry-run
```

**Interactive mode** (no branch argument):

- Shows a multi-select menu of removable worktrees (main worktree excluded)
- Select one or more worktrees to remove in a single operation

**Branch deletion** — when not specified via flags, behavior is controlled by `remove.deleteBranch` / `remove.deleteRemoteBranch` config options. If those are also not set, prompts interactively. Unmerged branches require `--force` or interactive confirmation.

Runs `pre-remove` hooks before removal. Automatically removes empty `rootDir` after the last worktree is deleted.

### `wt update`

Fetch from remotes, fast-forward the default branch, and rebase feature branches.

```bash
wt update [branch] [options]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be done without making changes |

**Examples:**

```bash
# Update all worktrees
wt update

# Update a specific branch and its sub-branches
wt update feature/parent

# Preview what would happen
wt update --dry-run
```

**How it works:**

1. Fetches all remotes
2. Fast-forwards the default branch (or updates its ref if no worktree exists for it)
3. Detects parent branches via merge-base
4. Rebases feature branches in correct order — parents before children

If a worktree has uncommitted changes, a temporary WIP commit is created before rebase and reset afterwards. On rebase conflict, the rebase is aborted and the issue is reported.

After each successful rebase, `post-update` hooks are executed for that branch. This is useful for auto-pushing rebased branches:

```jsonc
{
  "hooks": {
    "post-update": ["git push --force-with-lease"]
  }
}
```

### `wt cleanup`

Remove worktrees and branches whose remote tracking branch has been deleted.

```bash
wt cleanup [options]
```

| Flag | Description |
|------|-------------|
| `--force` | Delete branches even if they have unmerged changes |
| `--dry-run` | Show what would be done without making changes |

**Examples:**

```bash
# Interactive cleanup
wt cleanup

# Force delete unmerged branches
wt cleanup --force

# Preview what would happen
wt cleanup --dry-run
```

Runs `git fetch --prune`, finds branches with gone remotes, shows candidates, and asks for confirmation. Skips dirty worktrees and unmerged branches unless `--force` is used.

## Configuration

Create a `.worktreekit.jsonc` file in the project root (or use `wt init`). JSONC format supports comments:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/epodivilov/worktree-kit/main/schema/worktreekit.schema.json",
  // Directory for new worktrees (relative to main worktree)
  "rootDir": "../worktrees",
  "copy": [
    ".env",
    ".env.local",
    "config/*.json"
  ],
  "symlinks": [
    ".claude",
    ".idea"
  ],
  "defaultBase": "ask",
  "create": {
    "base": "main"
  },
  "remove": {
    "deleteBranch": false,
    "deleteRemoteBranch": false
  },
  "hooks": {
    "post-create": [
      "pnpm install --frozen-lockfile"
    ],
    "pre-remove": [],
    "post-update": [
      "git push --force-with-lease"
    ]
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rootDir` | `string` | `"../worktrees"` | Directory for new worktrees (relative to main worktree) |
| `copy` | `string[]` | `[]` | Files to copy. Supports exact paths, directories, and glob patterns |
| `symlinks` | `string[]` | `[]` | Paths to symlink from root repo. Supports exact paths and glob patterns |
| `defaultBase` | `"current"` \| `"default"` \| `"ask"` | `"ask"` | Base branch selection strategy when creating new branches |
| `create.base` | `string` | — | Fixed base branch for all new worktrees (overrides `defaultBase`) |
| `remove.deleteBranch` | `boolean` | — | Auto-delete local branch on removal. Prompts if not set |
| `remove.deleteRemoteBranch` | `boolean` | — | Auto-delete remote branch on removal. Prompts if not set |
| `hooks.post-create` | `string[]` | `[]` | Commands to run after creating a worktree |
| `hooks.pre-remove` | `string[]` | `[]` | Commands to run before removing a worktree |
| `hooks.post-update` | `string[]` | `[]` | Commands to run after each branch is successfully rebased |

### Copy vs Symlinks

Both `copy` and `symlinks` support exact paths and glob patterns. The difference is how files end up in the worktree:

| | `copy` | `symlinks` |
|---|--------|------------|
| **Mechanism** | Physical copy | Symbolic link to root repo |
| **Independence** | Each worktree has its own copy | All worktrees share the same file |
| **Edits** | Local to the worktree | Reflected in root repo (commit from there) |
| **Use case** | `.env`, local overrides | IDE configs, shared tooling configs |

**Important:** symlinks only work for gitignored content. Tracked files already exist in the worktree after checkout, so symlink creation will fail with "already exists". When symlinking directories, make sure your `.gitignore` uses patterns **without** a trailing slash (`.claude` not `.claude/`) — git treats symlinks as files, so directory-only patterns won't match them.

### Hook Environment Variables

All hooks receive the following environment variables:

| Variable | Description | Hooks |
|----------|-------------|-------|
| `WORKTREE_PATH` | Absolute path to the worktree | all |
| `WORKTREE_BRANCH` | Branch name | all |
| `REPO_ROOT` | Repository root path | all |
| `BASE_BRANCH` | Base branch (create: `--base` value; update: parent branch) | `post-create`, `post-update` |

## Migration from `.worktreekitrc`

If you have an existing `.worktreekitrc` config, run:

```bash
wt init --migrate
```

This renames `.worktreekitrc` to `.worktreekit.jsonc` and automatically injects the `$schema` field for editor autocompletion and validation. Comments in the file are preserved.

The old `.worktreekitrc` is still supported as a fallback — commands will show a warning suggesting migration.

## Development

```bash
pnpm install      # Install dependencies
pnpm dev          # Run in development mode
pnpm build        # Build binary
pnpm typecheck    # Type checking
pnpm lint         # Lint with Biome
pnpm format       # Format with Biome
pnpm test         # Run tests
```

## License

MIT
