#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO_ROOT"
exec go run ./cmd/mtgdata parse -db data/mtgdata.db -resume=true "$@"
