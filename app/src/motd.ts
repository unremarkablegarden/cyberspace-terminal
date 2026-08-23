import { fs } from '@zenfs/core'
import { MOBILE } from './config'
import { VERSION } from './changelog'

const motdText = (user: string | null) => `\x1b[1mCYBERSPACE TERMINAL\x1b[0m ${VERSION}

\x1b[1mhelp\x1b[0m — list commands.${user ? '' : '  \n\x1b[1mlogin\x1b[0m — connect to network.'}${MOBILE ? '' : '\n\x1b[1mF1\x1b[0m config'}

`

/** Write /etc/motd. Called again whenever the logged-in user changes. */
export async function writeMotd(user: string | null): Promise<void> {
  await fs.promises.writeFile('/etc/motd', motdText(user)).catch(() => {})
}
