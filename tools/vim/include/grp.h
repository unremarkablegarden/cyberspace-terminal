// grp.h for wasi-libc, which ships none. Vim includes it unconditionally in
// fileio.c; getgrgid and getgrnam in os_wasi.c find nobody.
#ifndef OS_WASI_GRP_H
#define OS_WASI_GRP_H

#include <sys/types.h>

struct group {
    char *gr_name;
    char *gr_passwd;
    gid_t gr_gid;
    char **gr_mem;
};

struct group *getgrgid(gid_t gid);
struct group *getgrnam(const char *name);

#endif
