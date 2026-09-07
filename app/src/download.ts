// download(1): writes a file on the machine to the real disk.
//
// Lives in the faceplate rather than coreutils because the save is a DOM
// download; the kernel and userland stay DOM-free so the same kernel can run
// behind ssh. The host supplies the save itself (main.ts).

import { fs, paths, type Program } from '@cyberspace/kernel'
import { strerror } from '@cyberspace/coreutils'

export type SaveFile = (name: string, bytes: Uint8Array, type: string) => void

const TYPES: Record<string, string> = {
  js: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  txt: 'text/plain',
  wasm: 'application/wasm',
}

const HAS_EXT = /\.[A-Za-z0-9]{1,8}$/

/** Any execute bit. A program in ~/bin is JavaScript, so it leaves as .js. */
const EXEC = 0o111

function filename(base: string, mode: number): string {
  if (HAS_EXT.test(base)) return base
  return base + (mode & EXEC ? '.js' : '.txt')
}

export function downloadProgram(save: SaveFile): Program {
  return async p => {
    const arg = p.argv[1]
    if (!arg) {
      p.err('usage: download file\n')
      return 1
    }
    const path = paths.resolve(p.cwd, arg.replace(/^~(?=\/|$)/, p.env.HOME ?? '/'))

    let bytes: Uint8Array
    let name: string
    try {
      const st = await fs.promises.stat(path)
      if (st.isDirectory()) {
        p.err(`download: ${arg}: Is a directory\n`)
        return 1
      }
      bytes = await fs.promises.readFile(path)
      name = filename(paths.basename(path), st.mode)
    } catch (e) {
      p.err(`download: ${arg}: ${strerror(e)}\n`)
      return 1
    }

    const ext = HAS_EXT.test(name) ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    const type = TYPES[ext] ?? 'application/octet-stream'
    save(name, bytes, type.startsWith('text/') ? `${type};charset=utf-8` : type)

    p.out(`${name}  ${bytes.length} bytes\n`)
    return 0
  }
}
