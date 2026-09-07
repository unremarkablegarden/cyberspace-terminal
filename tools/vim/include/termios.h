// termios for wasi-libc, which ships none. The struct and flags are the POSIX
// names Vim's os_unix.c uses; tcsetattr in os_wasi.c reads only ICANON.
#ifndef OS_WASI_TERMIOS_H
#define OS_WASI_TERMIOS_H

typedef unsigned int tcflag_t;
typedef unsigned char cc_t;
typedef unsigned int speed_t;

#define NCCS 32
struct termios {
    tcflag_t c_iflag;
    tcflag_t c_oflag;
    tcflag_t c_cflag;
    tcflag_t c_lflag;
    cc_t c_line;
    cc_t c_cc[NCCS];
    speed_t c_ispeed;
    speed_t c_ospeed;
};

#define VINTR 0
#define VQUIT 1
#define VERASE 2
#define VKILL 3
#define VEOF 4
#define VTIME 5
#define VMIN 6
#define VSTART 8
#define VSTOP 9
#define VSUSP 10
#define VLNEXT 15

#define ICRNL 0000400
#define IXON 0002000
#define OPOST 0000001
#define ONLCR 0000004
#define TAB3 0014000
#define CS8 0000060
#define ISIG 0000001
#define ICANON 0000002
#define ECHO 0000010
#define ECHOE 0000020
#define IEXTEN 0100000

#define TCSANOW 0
#define TCSADRAIN 1
#define TCSAFLUSH 2

int tcgetattr(int fd, struct termios *t);
int tcsetattr(int fd, int actions, const struct termios *t);

#endif
