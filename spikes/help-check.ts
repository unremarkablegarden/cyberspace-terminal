import { Kernel } from '../packages/kernel/src/kernel.ts'
import { coreutils } from '../packages/coreutils/src/index.ts'
import { help } from '../packages/coreutils/src/sys.ts'

const kernel = new Kernel()
kernel.registerAll(coreutils)
for (const n of ['sh','changelog','shutdown','reboot','login','logout','whoami','finger',
  'feed','upload','pages','circ','cmail','view','browse','install','recall','publish']) {
  kernel.register(n, () => 0)
}
kernel.register('newthing', () => 0)

for (const cols of [80, 44]) {
  let out = ''
  const p: any = { kernel, tty: { cols }, out: (s: string) => { out += s } }
  await help(p)
  console.log(`--- ${cols} cols ---`)
  process.stdout.write(out)
}
