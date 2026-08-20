// Dice notation: NdM, NdM+K, NdM-K, d%. Enough for the roll seed.

export interface RollResult {
  text: string
  error?: string
}

export function roll(notation: string): RollResult {
  const n = notation.trim().toLowerCase().replace(/\s+/g, '')
  const m = /^(\d*)d(%|\d+)([+-]\d+)?$/.exec(n)
  if (!m) return { text: '', error: 'bad notation' }
  const count = Math.min(100, Number(m[1] || 1))
  const sides = m[2] === '%' ? 100 : Number(m[2])
  if (!count || !sides) return { text: '', error: 'bad notation' }
  const mod = Number(m[3] || 0)

  const rolls: number[] = []
  for (let i = 0; i < count; i++) rolls.push(1 + Math.floor(Math.random() * sides))
  const total = rolls.reduce((a, b) => a + b, 0) + mod

  let text = `${n}: ${total}`
  if (count > 1 || mod) text += `  (${rolls.join(' ')}${mod ? (mod > 0 ? ` +${mod}` : ` ${mod}`) : ''})`
  return { text }
}
