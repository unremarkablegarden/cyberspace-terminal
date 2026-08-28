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
import { ENV, HOME, RTDB_URL } from './config'
import { writeMotd } from './motd'
import { installSkel } from './skel'
import { installBin } from './bin'

/** Programs the faceplate must supply, because they end the session. */
export interface HostPrograms {
  shutdown: Program
  reboot: Program
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
  // Registered after coreutils so the network whoami, which reports the logged-in
  // user, replaces the local one.
  kernel.registerAll(cyberspacePrograms(api, hooks))
  // The chat screens request sounds through this; they hold no audio bus themselves.
  const chatSnd = {
    tick: () => snd.tick(),
    beep: (hz?: number, dur?: number) => snd.beep(hz, dur),
    blip: (hz?: number, dur?: number, jitter?: number) => snd.blip(hz, dur, jitter),
  }
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
  }))
}

/**
 * Fetch cowsay into /bin. Runs in the background; failures are ignored.
 *
 * Fetched rather than bundled: 2.6 MB of wasm in the JS bundle would be paid for
 * on every boot. The service worker precaches it, so an offline machine has it.
 */
async function seedCargo(): Promise<void> {
  void fetch('/wasm/cowsay.wasm')
    .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then(buf => fs.promises.writeFile('/bin/cowsay', new Uint8Array(buf), { mode: 0o755 }))
    .catch(() => {})
}

/**
 * ~/public_html is an ordinary directory until a supporter is logged in; then
 * the site is mounted over it and every save goes to the server. Unmounted at
 * logout. login(1) waits for the mount and says so; a boot resume is quiet.
 */
function wirePages(api: ApiClient): { onAuth: CsHooks['onAuth']; up(): void } {
  // Set once the filesystems are mounted; a resume can finish before then.
  let fsUp = false
  const wanted = () => fsUp && api.authed && api.pagesAllowed
  const mount = () => mountPages(api, HOME, wanted).catch(() => false)
  const previous = api.onAuthChange
  api.onAuthChange = user => {
    previous?.(user)
    if (user && api.pagesAllowed) void mount()
    else umountPages(HOME)
  }
  return {
    onAuth: async user => {
      if (!user || !api.pagesAllowed) return
      return (await mount()) ? `~/public_html on pages.cyberspace.online/${user}/` : undefined
    },
    up: () => {
      fsUp = true
      if (wanted()) void mount()
    },
  }
}

/** Bring the kernel up: programs, mounts, seed files. Never touches the grid. */
export async function bootMachine(deps: MachineDeps): Promise<Kernel> {
  const kernel = new Kernel()
  kernel.release = VERSION
  const pages = wirePages(deps.api)
  registerPrograms(kernel, deps, { onAuth: pages.onAuth, pickFile: deps.pickFile })

  const opfs = await navigator.storage.getDirectory()
  await mountAll({
    '/': InMemory,
    '/bin': InMemory,
    '/tmp': InMemory,
    '/home': { backend: OpfsHome, handle: opfs },
  })
  await kernel.seed()

  await writeMotd(deps.api.username)
  await installSkel(HOME)
  await installBin(HOME)
  await fs.promises.mkdir(`${HOME}/public_html`).catch(() => {})
  pages.up()
  await seedCargo()

  return kernel
}
