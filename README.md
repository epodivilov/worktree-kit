# worktree-kit

CLI tool to simplify git-worktree workflow with automatic config file copying.

## Problem

When creating a new git worktree, you often need to manually copy configuration files that are not tracked by git (`.env`, local configs, etc.). This tool automates that process.

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

## Usage

```bash
# Initialize .worktreekitrc in current project
wt init

# Create a new worktree with automatic config copying
wt create feature/my-feature

# Create worktree from specific base branch
wt create feature/my-feature --base develop

# List all worktrees
wt list

# Remove a worktree (interactive selection)
wt remove

# Remove a specific worktree
wt remove feature/old-feature

# Enable verbose logging
wt --verbose create feature/my-feature
```

## Configuration

Create a `.worktreekitrc` file in your project root (or use `wt init`):

```json
{
  "rootDir": "../worktrees",
  "copy": [
    ".env",
    ".env.local",
    "config/local.json"
  ],
  "hooks": {
    "post-create": [
      "bun install --frozen-lockfile"
    ]
  }
}
```

### Options

- `rootDir` — Directory where new worktrees will be created (relative to main worktree)
- `copy` — Files to copy from the main worktree to new worktrees
- `hooks.post-create` — Commands to run after creating a worktree

### Hook Environment Variables

Post-create hooks receive the following environment variables:

- `WORKTREE_PATH` — Path to the new worktree
- `WORKTREE_BRANCH` — Branch name
- `REPO_ROOT` — Repository root path
- `BASE_BRANCH` — Base branch (if specified with `--base`)

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
