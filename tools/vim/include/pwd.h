// pwd.h for wasi-libc, which ships none. Vim includes it unconditionally in
// fileio.c; getpwuid and getpwnam in os_wasi.c find nobody.
#ifndef OS_WASI_PWD_H
#define OS_WASI_PWD_H

#include <sys/types.h>

struct passwd {
    char *pw_name;
    char *pw_passwd;
    uid_t pw_uid;
    gid_t pw_gid;
    char *pw_gecos;
    char *pw_dir;
    char *pw_shell;
};

struct passwd *getpwuid(uid_t uid);
struct passwd *getpwnam(const char *name);

#endif
