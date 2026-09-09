# Jobs

A job is a pipeline the shell started and has not yet seen exit. It is in the foreground, stopped, or parked.

## Stopped

`^Z` or the switcher (`CMD-K`, `CTRL-K` off a Mac) stops the foreground job. Stopping is cooperative: each process in the job gets `onStop`, and a program that holds streams or timers closes them there and keeps its state in memory. `fg`, or choosing the job in the switcher, calls `onCont`; the program reconnects and repaints. A program without the hooks is frozen by the terminal alone: its reads block, its stdout is held (64 KiB, oldest dropped) and written out on foreground, and its frames are dropped, so it comes back blank until it draws.

Nothing listens while stopped. `circ` leaves the room as far as the server knows and rejoins on foreground; `cmail` and `feed` drop their streams and polls; `globe` stops its clock.

## The terminal

Each job has its own view of the terminal (`JobTty`): mode, silenced keys, pacing, caret and alt-screen flag. `Tty.foreground()` moves the device from one view to another, leaving the alt screen for the outgoing job and re-entering it for the incoming one. The shell's scrollback lives under the alt screen in the terminal's main buffer, so nothing on screen is saved.

A view holds the terminal from before its processes start (`Jobs.start`), not from the moment the shell waits on them: a program paints its first frame in the synchronous part of its run, a view outside the foreground drops frames, and the frames after it are drawn as a diff against it.

## Parked

A reload keeps the table: each job's resume line and state blob, and which job held the terminal. The jobs come back parked, with no process; the first foreground runs the line again and the program claims its state, as a single program did before. `ps` lists a parked job without a pid.

## Rules

- One job per program name. Typing a name that has a job foregrounds it; arguments go to the job (`cmail @user` opens that thread, `globe @user` turns to the member).
- `exit` with jobs in the table is refused once. A second `exit` kills them and goes through.
- `logout`, `shutdown` and `reboot` kill every job.
- A nested `sh` runs without job control.
- `&` is not accepted.

## Where

- `packages/kernel/src/jobs.ts` the table, `tty.ts` the views, `proc.ts` the hooks.
- `packages/shell/src/run.ts` runs a pipeline as a job; `index.ts` takes the switcher's requests at the prompt.
- `app/src/palette.ts` the switcher overlay, `app/src/config.ts` the platform modifier it is bound to; `app/src/session.ts` the parked table.
