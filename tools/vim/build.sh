#!/bin/sh
# Build vim.wasm (wasm32-wasip1) into the app's public assets.
#
# Needs wasi-sdk unpacked at tools/wasi-sdk (or $WASI_SDK) and upstream Vim
# cloned at tools/vim/vim. Vim itself is not patched: os_wasi.c supplies the
# POSIX calls wasi-libc lacks and is handed to configure through LIBS, and
# os_wasi.h is force-included for the prototypes, include/ adds termios.h.
# Configure's run-time probes cannot run here, so their cache answers are
# given on the command line.
set -e
cd "$(dirname "$0")"
HERE=$(pwd)
SDK=${WASI_SDK:-$HERE/../wasi-sdk}
SRC=$HERE/vim/src
OUT=$HERE/../../app/public/wasm/vim.wasm

test -x "$SDK/bin/clang" || { echo "wasi-sdk not found at $SDK" >&2; exit 1; }
test -d "$SRC" || { echo "vim source not found at $SRC (git clone --depth 1 https://github.com/vim/vim tools/vim/vim)" >&2; exit 1; }

# The include flags ride in CC rather than CFLAGS: osdef.sh preprocesses with
# CC alone to learn which prototypes the headers already provide.
CC="$SDK/bin/clang --target=wasm32-wasip1 --sysroot=$SDK/share/wasi-sysroot -I$HERE/include -include $HERE/os_wasi.h"
# FEAT_XTERM_SAVE: the alt screen (t_ti/t_te), off below the big feature set.
FEATS="-DFEAT_XTERM_SAVE"
EMU="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN"
EMULIBS="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman"

mkdir -p build
$CC $EMU -Os -c os_wasi.c -o build/os_wasi.o

cd "$SRC"
make distclean >/dev/null 2>&1 || true

# vim_cv_*: answers for probes that need to run a program. uname is the build
# host's without the override, and a Darwin answer defines MACOS_X even with
# --disable-darwin. timer_create=yes selects the POSIX-timer timeout code,
# which os_wasi.c stubs; the alternative needs setitimer and sigaction.
# --disable-*: features that need X, another process, or a library not here.
# PKG_CONFIG=false: the host's pkg-config would offer its own cairo and pango.
env \
  PKG_CONFIG=false \
  CC="$CC" \
  CFLAGS="$EMU $FEATS -Os" \
  LDFLAGS="$EMULIBS -Wl,-z,stack-size=1048576 -Wl,--wrap=stat,--wrap=lstat,--wrap=fstat" \
  LIBS="$HERE/build/os_wasi.o" \
  vim_cv_uname_output=WASI \
  vim_cv_uname_r_output=1 \
  vim_cv_uname_m_output=wasm32 \
  vim_cv_toupper_broken=no \
  vim_cv_terminfo=no \
  vim_cv_tgetent=non-zero \
  vim_cv_getcwd_broken=no \
  vim_cv_stat_ignores_slash=no \
  vim_cv_memmove_handles_overlap=yes \
  vim_cv_bcopy_handles_overlap=yes \
  vim_cv_memcpy_handles_overlap=no \
  vim_cv_timer_create=yes \
  vim_cv_timer_create_with_lrt=no \
  ac_cv_sizeof_int=4 \
  ac_cv_sizeof_long=4 \
  ac_cv_sizeof_time_t=8 \
  ac_cv_sizeof_off_t=8 \
  ./configure \
    --host=wasm32-wasi \
    --with-features=normal \
    --with-vim-name=vim.wasm \
    --enable-gui=no --with-x=no \
    --disable-darwin --disable-selinux --disable-smack --disable-xattr \
    --disable-xsmp --disable-xsmp-interact \
    --disable-netbeans --disable-channel --disable-cscope \
    --disable-rightleft --disable-arabic \
    --disable-nls --disable-acl --disable-gpm --disable-sysmouse \
    --disable-canberra --disable-libsodium --disable-hardcopy-pango \
    --with-tlib= \
    > "$HERE/build/configure.log" 2>&1 || { tail -30 "$HERE/build/configure.log"; exit 1; }

make -j8 vim.wasm > "$HERE/build/make.log" 2>&1 || { tail -40 "$HERE/build/make.log"; exit 1; }

cp vim.wasm "$OUT"
ls -la "$OUT"
