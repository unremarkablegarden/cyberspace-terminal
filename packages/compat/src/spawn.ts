// Kernel file handler for JS programs. The source is not imported here: it runs
// in a dedicated worker (program.worker.ts) so its realm holds no window, no
// page globals and no session token. This side is the broker. It forwards the
// worker's output to the pty, pumps the keyboard into the worker, and answers
// the worker's capability requests (api, feed, image) against the real host,
// re-checking each api path so a forged request cannot reach past /v1/.
//
// A dedicated worker's own script can post any message, so nothing a message
// asks for is trusted more than the capability it names: api stays /v1/, image
// stays behind the host's whitelist, and the token is never on this channel.

import { dec, type Proc, type Program } from '@cyberspace/kernel'
import { PICT_RANGE, type CompatDeps, type CompatPictures } from './host.js'
import type { MainMessage, RunMessage, WorkerMessage } from './program.worker.js'

/** A /v1/ path, or throws. Repeated here because a worker can forge the call. */
function v1(path: unknown): string {
  if (typeof path !== 'string' || !path.startsWith('/v1/')) {
    throw new Error('api: path must start with /v1/')
  }
  return path
}

export function jsFileHandler(deps: CompatDeps): (path: string, data: Uint8Array) => Program | null {
  return (_path, data) => {
    if (data.length < 2 || data[0] === 0) return null
    const head = dec.decode(data.subarray(0, Math.min(data.length, 4096)))
    if (!/export\s+default/.test(head)) return null
    const source = dec.decode(data)

    return async (p) => {
      // A lint, not the boundary: the worker realm is. It still parses the
      // source and refuses the names that reach the credential, so an obvious
      // copy-paste grab fails with a clear message instead of a runtime error.
      // Loaded on demand because the parser is ~130 KB.
      try {
        const { inspect, refusalLines } = await import('./guard.js')
        const hits = inspect(source)
        if (hits.length) {
          for (const line of refusalLines(p.argv[0] ?? '?', hits)) p.err(line.text + '\n')
          return 1
        }
      } catch (e) {
        // Source the guard cannot parse but the engine could would be a bypass,
        // so a parse failure is refused, not run.
        p.err(`${p.argv[0]}: ${(e as Error)?.message ?? e}\n`)
        return 1
      }

      return runInWorker(p, source, deps)
    }
  }
}

async function serve(
  deps: CompatDeps, pictures: CompatPictures | undefined,
  kind: Extract<WorkerMessage, { t: 'cap' }>['kind'], args: unknown[],
): Promise<unknown> {
  switch (kind) {
    case 'api.get': return deps.api ? deps.api.get(v1(args[0])) : Promise.reject(new Error('NO CARRIER'))
    case 'api.post': return deps.api ? deps.api.post(v1(args[0]), args[1]) : Promise.reject(new Error('NO CARRIER'))
    case 'api.del': return deps.api ? deps.api.del(v1(args[0])) : Promise.reject(new Error('NO CARRIER'))
    case 'feed.page': return deps.feed ? deps.feed.page(args[0] as number | undefined, args[1] as string | undefined) : []
    case 'feed.profile': return deps.feed?.profile ? deps.feed.profile(String(args[0])) : null
    case 'image': return deps.image ? deps.image(String(args[0])) : Promise.reject(new Error('NO CARRIER'))
  }
}

/** Bitmaps from a message: one Uint16Array per handle, nothing else. */
function bitmaps(v: unknown): Uint16Array[] {
  if (!Array.isArray(v)) return []
  return v.filter((b): b is Uint16Array => b instanceof Uint16Array)
}

function runInWorker(p: Proc, source: string, deps: CompatDeps): Promise<number> {
  const worker = new Worker(new URL('./program.worker.ts', import.meta.url), { type: 'module' })
  const pictures = deps.pictures?.()

  return new Promise<number>(resolve => {
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      p.signal.removeEventListener('abort', onAbort)
      worker.terminate()
      pictures?.release()
      // Unblock the keyboard pump's pending read (installs a fresh readers pipe).
      p.stdin.interrupt?.()
      resolve(code)
    }
    const onAbort = (): void => {
      worker.postMessage({ t: 'abort' } satisfies MainMessage)
      finish(130)
    }
    p.signal.addEventListener('abort', onAbort)

    worker.onmessage = (e: MessageEvent<WorkerMessage>): void => {
      const m = e.data
      switch (m.t) {
        case 'out': p.out(m.d); return
        case 'err': p.err(m.d); return
        case 'paint': p.tty?.paint(m.d) ?? p.out(m.d); return
        case 'tty':
          if (m.op === 'setRaw') p.tty?.setRaw()
          else if (m.op === 'setCooked') p.tty?.setCooked()
          else if (m.op === 'setPaced') p.tty?.setPaced(m.arg ?? true)
          return
        case 'snd': {
          const s = deps.snd as Record<string, (...a: unknown[]) => void> | undefined
          s?.[m.method]?.(...m.args)
          return
        }
        case 'copy': p.tty?.copy(m.text); return
        case 'pict': pictures?.set(m.codes, bitmaps(m.bits)); return
        case 'cap':
          serve(deps, pictures, m.kind, m.args).then(
            value => worker.postMessage({ t: 'cap-result', id: m.id, ok: true, value } satisfies MainMessage),
            (err: unknown) => worker.postMessage({ t: 'cap-result', id: m.id, ok: false, error: (err as Error)?.message ?? String(err) } satisfies MainMessage),
          )
          return
        case 'exit': finish(m.code); return
        case 'fault':
          p.err(`${p.argv[0]}: ${m.message}\n`)
          return
      }
    }
    worker.onerror = e => {
      p.err(`${p.argv[0]}: ${e.message || 'program failed'}\n`)
      finish(1)
    }

    // Keyboard pump: tty bytes to the worker until EOF or the run ends.
    void (async () => {
      for (;;) {
        const c = await p.stdin.read()
        if (settled) return
        if (c === null) { worker.postMessage({ t: 'stdin-eof' } satisfies MainMessage); return }
        worker.postMessage({ t: 'stdin', d: c } satisfies MainMessage)
      }
    })()

    const msg: RunMessage = {
      t: 'run',
      source,
      argv: [...p.argv],
      env: { ...p.env },
      cwd: p.cwd,
      cols: p.tty?.cols ?? (Number(p.env.COLUMNS) || 80),
      rows: p.tty?.rows ?? (Number(p.env.LINES) || 25),
      version: deps.version,
      username: deps.username?.(),
      caps: { api: !!deps.api, feed: !!deps.feed, image: !!deps.image },
      metrics: pictures?.metrics(),
      pict: pictures?.range(PICT_RANGE),
    }
    worker.postMessage(msg)
  })
}
