// The slash commands circ and cmail advertise, and the router that gates them.
//
// The API resolves the shared table server-side on POST but passes unknown
// slash verbs through as plain text, so routeSlash refuses them here: a
// /-line whose verb is neither listed nor local never leaves the terminal.
//
// A deliberate subset of what the server accepts. Styles need fonts and
// colours, /song and /gif need players, /art a composer, /img an upload.

export type SlashSurface = 'chat' | 'dm'

const BOTH: SlashSurface[] = ['chat', 'dm']

export interface SlashCommand {
  /** The verb, without the leading slash. */
  name: string
  usage: string
  summary: string
  surfaces: SlashSurface[]
}

export const COMMANDS: SlashCommand[] = [
  { name: 'me', usage: '/me <action>', summary: 'do something instead of saying it', surfaces: BOTH },
  { name: 'poke', usage: '/poke [@user]', summary: 'pokes someone', surfaces: BOTH },
  { name: 'hug', usage: '/hug [@user]', summary: 'hugs someone', surfaces: BOTH },
  { name: 'hi5', usage: '/hi5 [@user]', summary: 'high-fives someone', surfaces: BOTH },
  { name: 'slap', usage: '/slap [@user]', summary: 'slaps someone', surfaces: BOTH },
  { name: 'dice', usage: '/dice <notation>', summary: 'roll dice — 4d6kh3, 2d6+1d4+3, adv, d%', surfaces: BOTH },
  { name: 'fortune', usage: '/fortune', summary: 'open a fortune cookie', surfaces: BOTH },
  { name: '8ball', usage: '/8ball <question>', summary: 'ask the magic 8-ball', surfaces: BOTH },
  { name: 'blink', usage: '/blink <message>', summary: 'say it in blinking text', surfaces: BOTH },
  { name: 'help', usage: '/help', summary: 'this box', surfaces: BOTH },
]

const on = (surface: SlashSurface) => COMMANDS.filter(c => c.surfaces.includes(surface))

/** A command the program handles itself, appended to the shared table. */
export interface LocalCommand {
  name: string
  usage: string
  summary: string
}

/** Every completable name on this surface, local commands included. */
export function slashNames(surface: SlashSurface, local: LocalCommand[] = []): string[] {
  const names = [...local.map(c => c.name), ...on(surface).map(c => c.name)]
  return [...new Set(names)]
}

export type SlashRoute =
  /** Handled by the program itself. */
  | { local: string; args: string[] }
  /** Open the help box. */
  | { help: true }
  /** In the shared table: POST as typed and let the server resolve it. */
  | { server: true }
  /** Not a known verb: report locally and send nothing. */
  | { unknown: string }

/**
 * Route one line of input. Returns null for a line that does not start with
 * `/`, which is sent as typed. Every other line is treated as a command
 * attempt, and a verb offered by neither the surface nor the program is
 * reported unknown, because the server would otherwise post it as prose.
 *
 * `localNames` are the verbs the program dispatches itself, aliases included.
 * The legacy `/dice:N[:M]` forms cannot be listed in the name table but are
 * still accepted by the server, so they route as shared commands.
 */
export function routeSlash(raw: string, surface: SlashSurface, localNames: string[] = []): SlashRoute | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/')) return null
  const parts = trimmed.split(/\s+/)
  const verb = (parts[0] || '').slice(1).toLowerCase()
  const args = parts.slice(1)
  if (!verb) return { unknown: '/' }
  if (localNames.includes(verb)) return { local: verb, args }
  if (verb === 'help') return { help: true }
  if (verb.startsWith('dice:')) return { server: true }
  if (on(surface).some(c => c.name === verb)) return { server: true }
  return { unknown: `/${verb}` }
}

/** Help box body, generated from the table. Omits /help itself. */
export function helpLines(surface: SlashSurface, local: LocalCommand[] = []): string[] {
  const commands = [...local, ...on(surface).filter(c => c.name !== 'help')]
  const width = Math.max(...commands.map(c => c.usage.length))
  const lines = commands.map(c => `${c.usage.padEnd(width)}  ${c.summary}`)
  lines.push('')
  lines.push('Tab completes a command name.')
  return lines
}
