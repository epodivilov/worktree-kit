# worktree-kit

CLI tool to simplify git-worktree workflow with automatic config file copying.

## Problem

When creating a new git worktree, you often need to manually copy configuration files that are not tracked by git (`.env`, local configs, etc.). This tool automates that process.

## Installation

```bash
# Build from source
bun run build

# The binary will be at ./dist/wt
# Move it to your PATH
cp ./dist/wt ~/.local/bin/
```

## Usage

```bash
# Create a new worktree with automatic config copying
wt create feature/my-feature

# Sync configs to an existing worktree
wt sync

# List all worktrees
wt list

# Initialize .worktree.json in current project
wt init
```

## Configuration

Create a `.worktree.json` file in your project root:

```json
{
  "copy": [
    ".env",
    ".env.local",
    "config/local.json"
  ],
  "symlink": [
    "node_modules"
  ],
  "postCreate": [
    "bun install --frozen-lockfile"
  ]
}
```

### Options

- `copy` — Files to copy from the main worktree
- `symlink` — Directories to symlink (saves disk space)
- `postCreate` — Commands to run after creating a worktree

## Development

```bash
# Run in development mode
bun run dev --help

# Build binary
bun run build

# Type checking
bun run typecheck

# Lint
bun run lint

# Format
bun run format
```

## License

MIT
