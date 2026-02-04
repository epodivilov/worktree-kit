#!/usr/bin/env bash
set -euo pipefail

pnpm build
pnpm link --global

echo "Linked globally via pnpm. Run 'wt' to test."
