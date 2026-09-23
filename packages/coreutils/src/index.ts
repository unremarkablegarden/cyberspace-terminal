import type { Program } from '@cyberspace/kernel'
import { ls, cat, cp, mv, rm, mkdir, rmdir, touch, tree, chmod } from './fsu.js'
import { sudo, sudoProgram, make } from './sudo.js'
import { edit } from './edit.js'
import { less } from './less.js'
import { fortune } from './fortune.js'
import { grep, head, tail, sort, uniq, wc, echo } from './text.js'
import { date, uname, whoami, hostname, env, which, clear, sleep, trueCmd, falseCmd, motd } from './sys.js'
import { help } from './help.js'

export const coreutils: Record<string, Program> = {
  ls, cat, cp, mv, rm, mkdir, rmdir, touch, tree, chmod, edit, less, sudo, make,
  nano: edit,
  pico: edit,
  more: less,
  grep, head, tail, sort, uniq, wc, echo, fortune,
  date, uname, whoami, hostname, env, which, clear, sleep, help, motd,
  true: trueCmd,
  false: falseCmd,
}

export { strerror } from './util.js'
export { sudoProgram }
