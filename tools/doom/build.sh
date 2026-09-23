#!/bin/sh
# Build doom.wasm with sound effects into the app's public assets.
#
# Source: jacobenget/doom.wasm at tag v0.1.0 (GPL-2.0), cloned to tools/doom/doom.wasm and changed by two files here:
#   sound.patch      registers wasm_sound_module in doomgeneric/src/i_sound.c
#   i_wasm_sound.c   the module; passes each effect's DMX lump to the host's `sound` imports
# The steps after compiling repeat upstream's Makefile (wasm-merge x3, wasm-metadce) without its Docker and Python venv.
# Needs wasi-sdk at tools/wasi-sdk (or $WASI_SDK). Binaryen version_119, the upstream source and the shareware WAD are fetched on first run.
set -e
cd "$(dirname "$0")"
HERE=$(pwd)
SDK=${WASI_SDK:-$HERE/../wasi-sdk}
BINARYEN=$HERE/../binaryen
SRC=$HERE/doom.wasm
BUILD=$HERE/build
OUT=$HERE/../../app/public/doom/doom-v0.1.0-sfx.wasm

TAG=v0.1.0
COMMIT=24bb772900cc16f4c62e28ff16ea2d80f99389e6
BINARYEN_VERSION=version_119
# The WAD is taken out of upstream's release binary: the mirror in upstream's Makefile is gone (404 in 2026-09).
RELEASE_URL=https://github.com/jacobenget/doom.wasm/releases/download/$TAG/doom-$TAG.wasm
RELEASE_SHA256=8edfe49a7583fd975199969302d8e9adcf8e714d0af72bf3e672f991fd810faa
# DOOM1.WAD 1.9 shareware.
WAD_SHA1=5b2e249b9c5133ec987b3ea77596381dc0d6bc1d

test -x "$SDK/bin/clang" || { echo "wasi-sdk not found at $SDK" >&2; exit 1; }

if [ ! -x "$BINARYEN/bin/wasm-merge" ]; then
  case $(uname -sm) in
    "Darwin arm64") ARCH=arm64-macos ;;
    "Darwin x86_64") ARCH=x86_64-macos ;;
    "Linux x86_64") ARCH=x86_64-linux ;;
    "Linux aarch64") ARCH=aarch64-linux ;;
    *) echo "no Binaryen release for $(uname -sm)" >&2; exit 1 ;;
  esac
  TGZ=binaryen-$BINARYEN_VERSION-$ARCH.tar.gz
  URL=https://github.com/WebAssembly/binaryen/releases/download/$BINARYEN_VERSION/$TGZ
  mkdir -p "$BINARYEN.tmp"
  curl -fsSL "$URL" -o "$BINARYEN.tmp/$TGZ"
  curl -fsSL "$URL.sha256" -o "$BINARYEN.tmp/$TGZ.sha256"
  (cd "$BINARYEN.tmp" && shasum -a 256 -c "$TGZ.sha256")
  tar -xzf "$BINARYEN.tmp/$TGZ" -C "$BINARYEN.tmp"
  mv "$BINARYEN.tmp/binaryen-$BINARYEN_VERSION" "$BINARYEN"
  mv "$BINARYEN.tmp" "$HERE/../../.trash/binaryen-download-$(date +%s)"
fi

test -d "$SRC" || git clone -q --branch $TAG --depth 1 https://github.com/jacobenget/doom.wasm "$SRC"
test "$(git -C "$SRC" rev-parse HEAD)" = $COMMIT || { echo "$SRC is not $TAG ($COMMIT)" >&2; exit 1; }
# The patch goes onto a clean tree every build.
git -C "$SRC" checkout -q -- .
git -C "$SRC" apply "$HERE/sound.patch"

mkdir -p "$BUILD/obj" "$BUILD/embedded/file_embedded_in_code" "$BUILD/wat"
if [ ! -f "$BUILD/DOOM1.WAD" ]; then
  curl -fsSL "$RELEASE_URL" -o "$BUILD/release.wasm"
  test "$(shasum -a 256 "$BUILD/release.wasm" | cut -d' ' -f1)" = $RELEASE_SHA256 || { echo "release checksum mismatch" >&2; exit 1; }
  # A WAD starts "IWAD", numlumps, infotableofs (little-endian i32); the lump directory (16 bytes a lump) ends the file.
  # "IWAD" also appears as a string in the code, so the first match whose header fits inside the binary is taken.
  python3 - "$BUILD/release.wasm" "$BUILD/DOOM1.WAD" <<'PY'
import re, struct, sys
data = open(sys.argv[1], 'rb').read()
for m in re.finditer(b'IWAD', data):
    count, table = struct.unpack_from('<ii', data, m.start() + 4)
    if 0 < count < 10000 and 0 < table and m.start() + table + count * 16 <= len(data):
        open(sys.argv[2], 'wb').write(data[m.start():m.start() + table + count * 16])
        break
PY
fi
test "$(shasum -a 1 "$BUILD/DOOM1.WAD" | cut -d' ' -f1)" = $WAD_SHA1 || { echo "DOOM1.WAD checksum mismatch" >&2; exit 1; }
python3 "$SRC/utils/generate_code_for_embedded_file.py" --input "$BUILD/DOOM1.WAD" --destination-folder "$BUILD/embedded/file_embedded_in_code"

CC="$SDK/bin/clang --target=wasm32-wasip1 --sysroot=$SDK/share/wasi-sysroot"
CFLAGS="-Os -g -w -DFEATURE_WASM_SOUND"
INC="-I$SRC/doomgeneric -I$SRC/doomgeneric/include -I$BUILD/embedded"

OBJS=""
for f in $(sed -n 's/^SRC_DOOM = //p' "$SRC/Makefile"); do
  $CC $CFLAGS $INC -c "$SRC/doomgeneric/src/$f" -o "$BUILD/obj/${f%.c}.o"
  OBJS="$OBJS $BUILD/obj/${f%.c}.o"
done
$CC $CFLAGS $INC -c "$SRC/src/doom_wasm.c" -o "$BUILD/obj/doom_wasm.o"
# Upstream built with wasi-sdk 24, where unistd.h brought in the __wasi_* types; from wasi-sdk 25 they are in wasi/wasip1.h.
$CC $CFLAGS $INC -include wasi/wasip1.h -c "$SRC/src/internal__wasi-snapshot-preview1.c" -o "$BUILD/obj/internal__wasi-snapshot-preview1.o"
OBJS="$OBJS $BUILD/obj/doom_wasm.o $BUILD/obj/internal__wasi-snapshot-preview1.o"
$CC $CFLAGS $INC -c "$HERE/i_wasm_sound.c" -o "$BUILD/obj/i_wasm_sound.o"
$CC $CFLAGS -c "$BUILD/embedded/file_embedded_in_code/DOOM1.WAD.c" -o "$BUILD/obj/DOOM1.WAD.o"
OBJS="$OBJS $BUILD/obj/i_wasm_sound.o $BUILD/obj/DOOM1.WAD.o"

$CC $CFLAGS -Wl,--export-dynamic -Wl,--import-undefined -mexec-model=reactor $OBJS -s -o "$BUILD/linked.wasm" -lm -lc

B=$BINARYEN/bin
# The features clang 23 emits by default for wasm32; upstream's wasi-sdk 24 needed only bulk memory.
FEATURES="--enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int --enable-mutable-globals --enable-multivalue --enable-reference-types"
for w in wasi_snapshot_preview1-trampolines merge-two-initialization-functions-into-one global-constants; do
  "$B/wasm-as" "$SRC/src/wat/$w.wat" -o "$BUILD/wat/$w.wasm" $FEATURES
done
"$B/wasm-merge" "$BUILD/linked.wasm" wasi-implementation "$BUILD/wat/wasi_snapshot_preview1-trampolines.wasm" wasi_snapshot_preview1 -o "$BUILD/step1.wasm" $FEATURES
"$B/wasm-merge" "$BUILD/step1.wasm" has-two-init-functions "$BUILD/wat/merge-two-initialization-functions-into-one.wasm" merges-init-functions -o "$BUILD/step2.wasm" $FEATURES
"$B/wasm-metadce" "$BUILD/step2.wasm" --graph-file "$SRC/src/reachability_graph_for_wasm-metadce.json" -o "$BUILD/step3.wasm" $FEATURES > /dev/null
"$B/wasm-merge" "$BUILD/step3.wasm" doom "$BUILD/wat/global-constants.wasm" global-constants -o "$OUT" $FEATURES

git -C "$SRC" checkout -q -- .
ls -l "$OUT"
