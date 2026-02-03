# worktree-kit

CLI tool for simplifying git-worktree workflow.

## Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **Package Manager:** pnpm
- **Linter/Formatter:** Biome
- **CLI:** citty
- **UI:** @clack/prompts + picocolors
- **Validation:** valibot

## Commands

```bash
pnpm install         # Install dependencies
pnpm dev             # Run src/index.ts
pnpm build           # Build to dist/wt
pnpm typecheck       # Type check
pnpm lint            # Biome check
pnpm format          # Biome format
```

## Project Structure

```
src/
├── index.ts           # Entry point, bootstrap
├── cli/               # CLI layer (citty, argument parsing, routing)
├── application/       # Use cases, commands, DTOs
├── domain/            # Entities, port interfaces, schemas
├── infrastructure/    # Adapter implementations
└── shared/            # Result type, common utilities
```

## Conventions

- Use Bun APIs (`Bun.file`, `Bun.$`, etc.)
- Strict TypeScript

### Architecture

- Clean Architecture: cli → application → domain ← infrastructure
- Ports & Adapters: interfaces in `domain/ports/`, implementations in `infrastructure/adapters/`
- External libraries (clack, picocolors) only in `infrastructure/`
- Exception: valibot in `domain/schemas/` (declarative type definitions)
