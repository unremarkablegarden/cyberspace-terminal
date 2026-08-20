#!/bin/sh
# Build cowsay.wasm into the app's public assets. Requires Go 1.21+.
set -e
cd "$(dirname "$0")"
GOOS=wasip1 GOARCH=wasm go build -trimpath -ldflags='-s -w' -o ../../app/public/wasm/cowsay.wasm .
ls -la ../../app/public/wasm/cowsay.wasm
