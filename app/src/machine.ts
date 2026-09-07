// Boots the kernel: registers every program, mounts the filesystems, and seeds
// the files a fresh machine needs.

import { InMemory, fs } from '@zenfs/core'
import { Kernel, mountAll, type Program } from '@cyberspace/kernel'
import { coreutils } from '@cyberspace/coreutils'
import { shellMain } from '@cyberspace/shell'
import {
  type ApiClient, circProgram, cmailProgram, cyberspacePrograms, registryPrograms,
  mountPages, umountPages, type CsHooks,
} from '@cyberspace/apps'
import { jsFileHandler } from '@cyberspace/compat'
import type { Sound } from '@cyberspace/crt/audio'
import type { ChatPictures } from './image'
import { viewProgram } from './view'
import { OpfsHome } from './opfs'
import { changelog, VERSION } from './changelog'
import { ENV, HOME, IMAGE_HOSTS, RTDB_URL, homeOf } from './config'
import { writeMotd } from './motd'
import { installSkel } from './skel'
import { installBin } from './bin'

/** Programs the faceplate must supply, because they end the session. */
export interface HostPrograms {
  shutdown: Program
  reboot: Program
  /** Guest only, unlisted: wipe every trace of the machine on this browser. */
  reset: Program
  /** The saver picker. Lives on the faceplate: it draws on the CRT grid, not the pty. */
  screensaver: Program
}

export interface MachineDeps {
  api: ApiClient
  snd: Sound
  host: HostPrograms
  /**
   * One picture scope per program run. Image decoding needs the DOM, so a host
   * without it (an ssh host, for example) omits this and attachments are named
   * in text rather than drawn. See image.ts.
   */
  pictures?: () => ChatPictures
  /** The host's file chooser, for upload(1). Absent on a host without one. */
  pickFile?: (accept: string) => Promise<File | null>
}

/** Register every program. A later registration replaces an earlier one of the same name. */
function registerPrograms(kernel: Kernel, { api, snd, host, pictures }: MachineDeps, hooks: CsHooks): void {
  kernel.registerAll(coreutils)
  kernel.register('sh', shellMain)
  kernel.register('changelog', changelog)
  kernel.register('shutdown', host.shutdown)
  kernel.register('reboot', host.reboot)
  kernel.register('reset', host.reset)
  kernel.register('screensaver', host.screensaver)
  // Registered after coreutils so the network whoami, which reports the logged-in
  // user, replaces the local one.
  // The chat screens request sounds through this; they hold no audio bus themselves.
  const chatSnd = {
    tick: () => snd.tick(),
    beep: (hz?: number, dur?: number) => snd.beep(hz, dur),
    blip: (hz?: number, dur?: number, jitter?: number) => snd.blip(hz, dur, jitter),
  }
  kernel.registerAll(cyberspacePrograms(api, hooks, chatSnd))
  kernel.register('circ', circProgram(api, RTDB_URL, chatSnd, pictures))
  kernel.register('cmail', cmailProgram(api, RTDB_URL, chatSnd, pictures))
  if (pictures) kernel.register('view', viewProgram(pictures))
  kernel.registerAll(registryPrograms(api, chatSnd))

  // JS programs, dispatched by what their default export turns out to be:
  // a function runs as a process, an object with run() on the grid.
  kernel.fileHandlers.push(jsFileHandler({
    username: () => api.username ?? ENV.USER,
    version: VERSION,
    api: {
      get: path => api.get(path),
      post: (path, body) => api.post(path, body),
      del: path => api.delete(path),
    },
    snd: {
      blip: (hz, dur, jitter) => snd.blip(hz, dur, jitter),
      beep: (freq, dur) => snd.beep(freq, dur),
      tick: () => snd.tick(),
      seek: n => snd.seek(n),
      hiss: (dur, gain) => snd.hiss(dur, gain),
    },
    feed: {
      page: async (limit = 10) => {
        const posts = await api.get<Record<string, unknown>[]>(`/v1/posts?limit=${Math.min(50, limit)}`)
        return posts.map(post => ({
          username: post.authorUsername ?? '?',
          title: post.title ?? '',
          words: typeof post.content === 'string' ? post.content.split(/\s+/).filter(Boolean).length : 0,
          replies: post.replyCount ?? post.repliesCount ?? 0,
          at: post.createdAt,
        }))
      },
    },
    image: async (url: string): Promise<Uint8Array> => {
      let u: URL
      try { u = new URL(url) } catch { throw new Error('image: bad url') }
      if (u.protocol !== 'https:') throw new Error('image: https only')
      const host = u.hostname.toLowerCase()
      if (!IMAGE_HOSTS.some(s => host === s || host.endsWith('.' + s))) {
        throw new Error(`image: host not allowed (${host})`)
      }
      const res = await fetch(u.href, { mode: 'cors' })
      if (!res.ok) throw new Error(`image ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    },
  }))
}

/**
 * Fetch the wasm programs into /bin. Runs in the background; failures are
 * ignored.
 *
 * Fetched rather than bundled: megabytes of wasm in the JS bundle would be
 * paid for on every boot. The service worker precaches them, so an offline
 * machine has them.
 */
async function seedCargo(): Promise<void> {
  const install = (name: string, links: string[] = []): Promise<void> =>
    fetch(`/wasm/${name}.wasm`)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then(buf => fs.promises.writeFile(`/bin/${name}`, new Uint8Array(buf), { mode: 0o755 }))
      .then(() => Promise.all(links.map(l => fs.promises.symlink(`/bin/${name}`, `/bin/${l}`))))
      .then(() => {}, () => {})
  void install('cowsay')
  void install('vim', ['vi'])
}

/** The skeleton and the manual, into a home that may already have them. */
const installHome = async (home: string): Promise<void> => {
  await fs.promises.mkdir(home, { recursive: true }).catch(() => {})
  await installSkel(home)
  await installBin(home)
}

/**
 * A member's home is set up on login and on a boot resume, as guest's is at
 * boot. ~/public_html exists under it only while a supporter is logged in: the
 * mount creates it, and umount removes it again when empty. Every save goes to
 * the server. login(1) waits for the home and the mount and says so; a boot
 * resume is quiet.
 */
function wireHome(api: ApiClient): { onAuth: CsHooks['onAuth']; up(): void } {
  // Set once the filesystems are mounted; a resume can finish before then.
  let fsUp = false
  // The home the mount went under: the user is already null when umount runs.
  let mounted = HOME
  let installed: Promise<void> = Promise.resolve()
  const wanted = () => fsUp && api.authed && api.pagesAllowed
  const mount = () => {
    mounted = homeOf(api.username)
    return mountPages(api, mounted, wanted).catch(() => false)
  }
  const arrive = () => {
    if (!fsUp || !api.username) return
    installed = installHome(homeOf(api.username))
    if (wanted()) void mount()
  }
  const previous = api.onAuthChange
  api.onAuthChange = user => {
    previous?.(user)
    if (user) arrive()
    else umountPages(mounted)
  }
  return {
    onAuth: async user => {
      await installed
      if (!user || !api.pagesAllowed) return
      return (await mount()) ? `~/public_html on pages.cyberspace.online/${user}/` : undefined
    },
    up: () => {
      fsUp = true
      arrive()
    },
  }
}

/** Bring the kernel up: programs, mounts, seed files. Never touches the grid. */
export async function bootMachine(deps: MachineDeps): Promise<Kernel> {
  const kernel = new Kernel()
  kernel.release = VERSION
  const home = wireHome(deps.api)
  registerPrograms(kernel, deps, { onAuth: home.onAuth, pickFile: deps.pickFile })

  // OPFS exists only in a secure context: https, or http on localhost. A LAN
  // address or 127.0.0.1 over plain http has no navigator.storage at all.
  if (!navigator.storage?.getDirectory) {
    throw new Error('no origin private file system: serve over https or from localhost')
  }
  const opfs = await navigator.storage.getDirectory()
  await mountAll({
    '/': InMemory,
    '/bin': InMemory,
    '/tmp': InMemory,
    '/home': { backend: OpfsHome, handle: opfs },
  })
  await kernel.seed()

  await writeMotd(deps.api.username)
  await installHome(HOME)
  home.up()
  await seedCargo()

  return kernel
}
