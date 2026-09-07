#!/bin/sh
set -e
cd "$(dirname "$0")"
GOOS=wasip1 GOARCH=wasm go build -trimpath -ldflags='-s -w' -o ../wasitest.wasm .
ls -la ../wasitest.wasm
