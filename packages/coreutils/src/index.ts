import type { Program } from '@cyberspace/kernel'
import { ls, cat, cp, mv, rm, mkdir, rmdir, touch } from './fsu.js'
import { edit } from './edit.js'
import { grep, head, tail, sort, uniq, wc, echo } from './text.js'
import { date, uname, whoami, hostname, env, which, clear, sleep, trueCmd, falseCmd, help, motd } from './sys.js'

export const coreutils: Record<string, Program> = {
  ls, cat, cp, mv, rm, mkdir, rmdir, touch, edit,
  nano: edit,
  grep, head, tail, sort, uniq, wc, echo,
  date, uname, whoami, hostname, env, which, clear, sleep, help, motd,
  true: trueCmd,
  false: falseCmd,
}
