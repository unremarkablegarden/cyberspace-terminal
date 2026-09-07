// The POSIX surface WASI Preview 1 lacks, enough for an unmodified Vim built
// against wasi-libc. Given to configure through LIBS, so its link tests see
// these symbols as present and Vim's normal Unix code paths compile.
//
// Terminal: tcsetattr maps the ICANON bit onto the machine's raw mode through
// the `cyberspace` import module (packages/kernel/src/wasi.worker.ts); ioctl
// answers TIOCGWINSZ from the same module. Processes: fork and friends fail
// with ENOSYS, which Vim reports as "Cannot fork" and survives. Termcap:
// tgetent finds no entry, so Vim falls back to its builtin xterm entry; tgoto
// and tputs are real since Vim formats the builtin cursor strings with them.
// Startup: the working directory follows $PWD, since wasi-libc starts at "/".

#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#include "os_wasi.h"

__attribute__((import_module("cyberspace"), import_name("tty_size")))
int cyberspace_tty_size(unsigned short *cols_rows);
__attribute__((import_module("cyberspace"), import_name("tty_raw")))
void cyberspace_tty_raw(int on);

__attribute__((constructor)) static void chdir_pwd(void)
{
    const char *pwd = getenv("PWD");
    if (pwd != NULL && pwd[0] == '/')
	chdir(pwd);
}

// ---- terminal ---------------------------------------------------------------

// The one terminal's attributes, as last set. Starts cooked.
static struct termios tty_attrs = { .c_iflag = ICRNL | IXON, .c_oflag = OPOST | ONLCR,
    .c_cflag = CS8, .c_lflag = ICANON | ECHO | ISIG | IEXTEN | ECHOE };

int tcgetattr(int fd, struct termios *t)
{
    if (!isatty(fd))
    {
	errno = ENOTTY;
	return -1;
    }
    *t = tty_attrs;
    return 0;
}

int tcsetattr(int fd, int actions, const struct termios *t)
{
    (void)actions;
    if (!isatty(fd))
    {
	errno = ENOTTY;
	return -1;
    }
    tty_attrs = *t;
    cyberspace_tty_raw((t->c_lflag & ICANON) == 0);
    return 0;
}

// Replaces libc's ioctl, which knows no terminal requests. Vim's only use is
// the window size.
int ioctl(int fd, int request, ...)
{
    if (request == TIOCGWINSZ)
    {
	unsigned short size[2];
	va_list ap;
	struct winsize *ws;

	va_start(ap, request);
	ws = va_arg(ap, struct winsize *);
	va_end(ap);
	if (!isatty(fd) || cyberspace_tty_size(size) != 0)
	{
	    errno = ENOTTY;
	    return -1;
	}
	ws->ws_col = size[0];
	ws->ws_row = size[1];
	ws->ws_xpixel = 0;
	ws->ws_ypixel = 0;
	return 0;
    }
    errno = ENOTTY;
    return -1;
}

// ---- files ------------------------------------------------------------------

// wasi-libc reports st_mode with the type bits only, and a file with no
// permission bits is read-only to Vim. Linked with --wrap so these see every
// stat call; the type comes from libc, the permissions are 644 and 755.
int __real_stat(const char *path, struct stat *st);
int __real_lstat(const char *path, struct stat *st);
int __real_fstat(int fd, struct stat *st);

static void with_perms(struct stat *st)
{
    st->st_mode |= S_ISDIR(st->st_mode) ? 0755 : 0644;
}

int __wrap_stat(const char *path, struct stat *st)
{
    int r = __real_stat(path, st);
    if (r == 0)
	with_perms(st);
    return r;
}

int __wrap_lstat(const char *path, struct stat *st)
{
    int r = __real_lstat(path, st);
    if (r == 0)
	with_perms(st);
    return r;
}

int __wrap_fstat(int fd, struct stat *st)
{
    int r = __real_fstat(fd, st);
    if (r == 0)
	with_perms(st);
    return r;
}

// ---- processes and users ----------------------------------------------------

pid_t fork(void) { errno = ENOSYS; return -1; }
pid_t waitpid(pid_t pid, int *status, int options) { (void)pid; (void)status; (void)options; errno = ECHILD; return -1; }
int execvp(const char *file, char *const argv[]) { (void)file; (void)argv; errno = ENOSYS; return -1; }
int execv(const char *path, char *const argv[]) { (void)path; (void)argv; errno = ENOSYS; return -1; }
int kill(pid_t pid, int sig) { (void)pid; (void)sig; errno = ESRCH; return -1; }
unsigned alarm(unsigned seconds) { (void)seconds; return 0; }
mode_t umask(mode_t mask) { (void)mask; return 022; }
pid_t setsid(void) { errno = EPERM; return -1; }
int setpgid(pid_t pid, pid_t pgid) { (void)pid; (void)pgid; errno = EPERM; return -1; }
uid_t getuid(void) { return 0; }
uid_t geteuid(void) { return 0; }
gid_t getgid(void) { return 0; }
gid_t getegid(void) { return 0; }
struct passwd *getpwuid(uid_t uid) { (void)uid; return NULL; }
struct passwd *getpwnam(const char *name) { (void)name; return NULL; }
struct group *getgrgid(gid_t gid) { (void)gid; return NULL; }
struct group *getgrnam(const char *name) { (void)name; return NULL; }

// POSIX timers back Vim's regexp timeout ('redrawtime'). Creation reports
// success and the timer never fires, so searches run without a time limit; a
// failure here is an error message and a hit-enter prompt at startup.
int timer_create(const struct __clockid *clockid, struct sigevent *sevp, void **timerid) { (void)clockid; (void)sevp; *timerid = (void *)1; return 0; }
int timer_settime(void *timerid, int flags, const struct itimerspec *value, struct itimerspec *ovalue) { (void)timerid; (void)flags; (void)value; (void)ovalue; return 0; }
int timer_delete(void *timerid) { (void)timerid; return 0; }

// ---- termcap ----------------------------------------------------------------

int tgetent(char *bp, const char *name) { (void)bp; (void)name; return -1; }
char *tgetstr(const char *id, char **area) { (void)id; (void)area; return NULL; }
int tgetnum(const char *id) { (void)id; return -1; }
int tgetflag(const char *id) { (void)id; return 0; }

int tputs(const char *str, int affcnt, int (*putc)(int))
{
    (void)affcnt;
    if (str == NULL)
	return 0;
    // Termcap padding is a leading number of milliseconds; skipped.
    while (*str >= '0' && *str <= '9')
	str++;
    if (*str == '.')
	str++;
    if (*str == '*')
	str++;
    for (; *str; str++)
	putc((unsigned char)*str);
    return 0;
}

// Termcap cursor addressing: %i %d %2 %3 %. %+c %% %r, the forms in Vim's
// builtin entries. Mirrors the dummy Vim uses without a termcap library.
char *tgoto(const char *cm, int col, int line)
{
    static char buf[64];
    int args[2] = { line, col };
    int which = 0;
    char *p = buf;
    char *end = buf + sizeof(buf) - 1;

    for (; *cm && p < end - 8; cm++)
    {
	if (*cm != '%')
	{
	    *p++ = *cm;
	    continue;
	}
	switch (*++cm)
	{
	    case 'i': args[0]++; args[1]++; break;
	    case 'd': p += sprintf(p, "%d", args[which++ & 1]); break;
	    case '2': p += sprintf(p, "%02d", args[which++ & 1]); break;
	    case '3': p += sprintf(p, "%03d", args[which++ & 1]); break;
	    case '.': *p++ = (char)args[which++ & 1]; break;
	    case '+': *p++ = (char)(args[which++ & 1] + *++cm); break;
	    case 'r': { int t = args[0]; args[0] = args[1]; args[1] = t; break; }
	    case '%': *p++ = '%'; break;
	    case '\0': cm--; break;
	    default: break;
	}
    }
    *p = '\0';
    return buf;
}
