CYBER/OS — YOUR PROGRAMS                                ~/bin/docs/README.txt

WHAT THIS IS

~/bin holds programs written here and programs installed from the
gallery. ~/bin is on PATH, so either runs by name.

The directory lives in this browser and nowhere else. It is not backed
up. It does not follow to another machine. Nothing in it reaches the
network until it is published.


THE COMMANDS

  edit ~/bin/mine       write one             ^O writes, ^X exits
  mine                  run it                Ctrl-C stops it
  ls -l ~/bin           list
  less ~/bin/mine       read one              SPACE pages, Q quits
  rm ~/bin/mine         delete one
  import                take a file off this computer

  publish               put a program in the gallery
  browse                open the gallery
  install author/name   fetch a copy into ~/bin
  recall name           take a program out of the gallery

In the gallery: RETURN installs, S shows the source, T runs it once
without installing, SPACE opens the description, ESC leaves.


THE EXAMPLES

  ls ~/bin/examples     six programs
  ./examples/clock      run one where it sits

  hello   printing, arguments, sound, Ctrl-C
  roll    one call to a service on ctx
  clock   taking the whole grid
  river   the grid as a 160x100 bitmap
  news    reading the feed
  count   argv, stdin, exit codes, pipelines

The examples are rewritten at every boot. Work on a copy:

  cp ~/bin/examples/clock ~/bin/clock
  edit ~/bin/clock


THREE KINDS

  web    an object with a run(). A JS program: a cell grid, the tui
         widgets, sound, pictures, and the API as the member. For
         anything interactive or on the network. Most programs.
  term   a function on the pty: argv, stdin, stdout, an exit code. For
         tools that sit in a pipeline or a script. No API; the one kind
         that resumes after a reload.
  wasm   a wasm32-wasi binary: stdio, the files named on its command
         line, the tty. For compiled code (C, Rust); built elsewhere,
         brought in with import.

The default export decides which; nothing is declared. Programs
published from the old cyberspace.online/terminal are the object kind
and still run.


PUBLISHING

~/bin is private until something is published.

publish puts a program in the gallery under the author's name, where any
member can read its source, run it once, or install a copy.

A description is required, 256 characters at most. It is read out of the
source, and it is the one line the gallery shows:

  export const description = 'what it does'       term
  description: 'what it does',                    web

Versions are assigned, one per publish, and each replaces the last.
recall takes a program out of the gallery; a copy already installed
belongs to whoever installed it and stays. delete removes the record.


LIMITS

Twenty programs, 128 KB each. Supporters get a hundred at 1 MB.


  less ~/bin/docs/API.txt        how to write one
  less ~/bin/docs/TUI.txt        how one draws
  less ~/bin/docs/NETWORK.txt    the Cyberspace API
