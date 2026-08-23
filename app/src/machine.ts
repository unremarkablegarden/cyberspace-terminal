// Boots the kernel: registers every program, mounts the filesystems, and seeds
// the files a fresh machine needs.

import { InMemory, fs } from '@zenfs/core'
import { Kernel, mountAll, type Program } from '@cyberspace/kernel'
import { coreutils } from '@cyberspace/coreutils'
import { shellMain } from '@cyberspace/shell'
import {
  type ApiClient, circProgram, cmailProgram, cyberspacePrograms, registryPrograms,
} from '@cyberspace/apps'
import { compatFileHandler } from '@cyberspace/compat'
import type { Sound } from '@cyberspace/crt/audio'
import type { ChatPictures } from './image'
import { viewProgram } from './view'
import { OpfsHome } from './opfs'
import { changelog, VERSION } from './changelog'
import { ENV, HOME, RTDB_URL } from './config'
import { writeMotd } from './motd'
import { installSkel } from './skel'

/** Example programs from the original machine, seeded into /bin/examples. */
const EXAMPLES = ['hello', 'roll', 'clock', 'river', 'news']

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
}

/** Register every program. A later registration replaces an earlier one of the same name. */
function registerPrograms(kernel: Kernel, { api, snd, host, pictures }: MachineDeps): void {
  kernel.registerAll(coreutils)
  kernel.register('sh', shellMain)
  kernel.register('changelog', changelog)
  kernel.register('shutdown', host.shutdown)
  kernel.register('reboot', host.reboot)
  // Registered after coreutils so the network whoami, which reports the logged-in
  // user, replaces the local one.
  kernel.registerAll(cyberspacePrograms(api))
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

  // Programs from the original /terminal, dispatched by their default export.
  kernel.fileHandlers.push(compatFileHandler({
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

/** Fetch the bundled examples and cowsay into /bin. Runs in the background; failures are ignored. */
async function seedCargo(): Promise<void> {
  await fs.promises.mkdir('/bin/examples').catch(() => {})
  for (const name of EXAMPLES) {
    void fetch(`/examples/${name}.js`)
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(text => fs.promises.writeFile(`/bin/examples/${name}`, text, { mode: 0o755 }))
      .catch(() => {})
  }

  void fetch('/wasm/cowsay.wasm')
    .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then(buf => fs.promises.writeFile('/bin/cowsay', new Uint8Array(buf), { mode: 0o755 }))
    .catch(() => {})
}

/** Bring the kernel up: programs, mounts, seed files. Never touches the grid. */
export async function bootMachine(deps: MachineDeps): Promise<Kernel> {
  const kernel = new Kernel()
  kernel.release = VERSION
  registerPrograms(kernel, deps)

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
  await seedCargo()

  return kernel
}
