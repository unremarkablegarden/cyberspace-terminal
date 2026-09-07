// Prototypes wasi-libc leaves out, force-included into every Vim translation
// unit with -include so the unmodified sources compile. Definitions are in
// os_wasi.c. Includes nothing: a header pulled in here would also reach
// configure's link probes, whose `char f(void)` declarations conflict with any
// real prototype in scope. Types are spelled as wasi-libc defines them.
#ifndef OS_WASI_H
#define OS_WASI_H

// Window size request and struct; wasi-libc's sys/ioctl.h has neither.
#ifndef TIOCGWINSZ
#define TIOCGWINSZ 0x5413
struct winsize {
    unsigned short ws_row;
    unsigned short ws_col;
    unsigned short ws_xpixel;
    unsigned short ws_ypixel;
};
#endif

int fork(void);
int waitpid(int pid, int *status, int options);
int execvp(const char *file, char *const argv[]);
int execv(const char *path, char *const argv[]);
int kill(int pid, int sig);
unsigned alarm(unsigned seconds);
unsigned umask(unsigned mask);
int setsid(void);
int setpgid(int pid, int pgid);
unsigned getuid(void);
unsigned geteuid(void);
unsigned getgid(void);
unsigned getegid(void);

// POSIX timers and their sigevent, guarded off in wasi-libc's headers.
// timer_t is void * and clockid_t a pointer to struct __clockid there.
#ifndef SIGEV_THREAD
union sigval { int sival_int; void *sival_ptr; };
struct sigevent {
    union sigval sigev_value;
    int sigev_signo;
    int sigev_notify;
    void (*sigev_notify_function)(union sigval);
    void *sigev_notify_attributes;
};
#define SIGEV_SIGNAL 0
#define SIGEV_NONE 1
#define SIGEV_THREAD 2
#endif
struct itimerspec;
struct __clockid;
int timer_create(const struct __clockid *clockid, struct sigevent *sevp, void **timerid);
int timer_settime(void *timerid, int flags, const struct itimerspec *value, struct itimerspec *ovalue);
int timer_delete(void *timerid);

// wait.h macros Vim uses on a waitpid() status.
#ifndef WIFEXITED
#define WIFEXITED(s) (((s) & 0x7f) == 0)
#define WEXITSTATUS(s) (((s) >> 8) & 0xff)
#define WIFSIGNALED(s) (((s) & 0x7f) != 0 && ((s) & 0x7f) != 0x7f)
#define WTERMSIG(s) ((s) & 0x7f)
#define WNOHANG 1
#endif

#endif
