CYBER/OS — YOUR PROGRAMS                                ~/bin/README.txt

WHAT THIS IS

~/bin holds programs: the ones written here, and the ones installed from
the gallery. Both run by name, because ~/bin is on PATH.

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

  ls ~/bin/examples     six programs, one idea each
  ./examples/clock      run one where it sits

  hello   printing, arguments, sound, Ctrl-C
  roll    one call to a service on ctx
  clock   taking the whole grid
  river   the grid as a 160x100 bitmap
  news    reading the feed
  count   argv, stdin, exit codes, pipelines

Work on a copy:

  cp ~/bin/examples/clock ~/bin/clock
  edit ~/bin/clock

That copy is yours: editable, runnable, deletable, publishable.


THREE KINDS

  web    an object with a run(). Draws on a cell grid. Runs here and on
         the website terminal.
  term   a function. A process: argv, stdin, stdout, an exit code. Runs
         here only.
  wasm   a wasm32-wasi binary. Standard input, output and error, and no
         filesystem.

What the file exports decides which. There is nothing to declare.


PUBLISHING

~/bin is private until something is published.

publish puts a program in the gallery under the author's name, where any
member can read its source, run it once, or install a copy. The gallery
is one library, shared with the website terminal.

A description is required, 256 characters at most. It is read out of the
source, and it is the one line the gallery shows:

  export const description = 'what it does'       term
  description: 'what it does',                    web

Versions are assigned, one per publish, and each replaces the last.
recall takes a program out of the gallery; a copy already installed
belongs to whoever installed it and stays. delete removes the record.


LIMITS

Twenty programs, 128 KB each. Supporters get a hundred at 1 MB.
Three publishes a minute, forty a day.


  less ~/bin/API.txt        how to write one
  less ~/bin/NETWORK.txt    the Cyberspace API
