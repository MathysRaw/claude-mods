import { atom, read, update } from 'claude-code'
import type { Register, ModelUsage } from 'claude-code'

import type { Meter, Tally } from '../types'

const LIFETIME = 'lifetime'
const zero = (): Tally => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })
const initial: Meter = {
  last: null, session: zero(), contextTokens: null, contextWindow: null,
  contextPercent: null, usd: null, limits: [], model: null,
}
const meter = atom({ plugin: 'token-meter', key: 'meter' } as const, initial)
const isHidden = atom({ plugin: 'token-meter', key: 'isHidden' } as const, false)

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n}`
const total = (t: Tally) => t.input + t.output + t.cacheRead + t.cacheWrite
const fromUsage = (u: ModelUsage): Tally => ({
  input: u.input_tokens, output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, turns: 1,
})
const add = (a: Tally, b: Tally): Tally => ({
  input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite, turns: a.turns + b.turns,
})
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7j', spend_limit: 'budget' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tokens', description: 'Détail de la consommation de tokens (discussion + cumul)' })
    await $.command.register({ name: 'tokens-toggle', description: 'Afficher / masquer le compteur de tokens' })
    const u = await $.session.usage()
    await update($, meter, m => ({
      ...m, contextTokens: u.context.tokens ?? null, contextWindow: u.context.window,
      contextPercent: u.context.percent ?? null, usd: u.cost?.usd ?? null, limits: u.rateLimits,
    }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const usage = e.usage ?? r.usage
    if (usage && !e.agentId) {
      const t = fromUsage(usage)
      await update($, meter, m => ({ ...m, last: t, session: add(m.session, t), model: usage.model }))
      const life = ((await $.store.get(LIFETIME)) as Tally | undefined) ?? zero()
      await $.store.set(LIFETIME, add(life, t))
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    await update($, meter, m => ({
      ...m, contextTokens: e.context.tokens ?? m.contextTokens, contextWindow: e.context.window,
      contextPercent: e.context.percent ?? m.contextPercent, usd: e.cost?.usd ?? m.usd, limits: e.rateLimits,
    }))
    return next(e)
  })

  on('command.run', { command: 'tokens-toggle' }, async $ => {
    const hidden = await read($, isHidden)
    await update($, isHidden, () => !hidden)
    return { text: hidden ? 'Compteur de tokens affiché.' : 'Compteur de tokens masqué (/tokens-toggle pour le réafficher).' }
  })

  on('command.run', { command: 'tokens' }, async $ => {
    const m = await read($, meter)
    const life = ((await $.store.get(LIFETIME)) as Tally | undefined) ?? zero()
    const s = m.session
    const lines = [
      `**Consommation de tokens**`,
      ``,
      `| | Dernier tour | Cette discussion | Cumul (toutes discussions) |`,
      `|---|---|---|---|`,
      `| Entrée | ${fmt(m.last?.input ?? 0)} | ${fmt(s.input)} | ${fmt(life.input)} |`,
      `| Sortie | ${fmt(m.last?.output ?? 0)} | ${fmt(s.output)} | ${fmt(life.output)} |`,
      `| Cache lu | ${fmt(m.last?.cacheRead ?? 0)} | ${fmt(s.cacheRead)} | ${fmt(life.cacheRead)} |`,
      `| Cache écrit | ${fmt(m.last?.cacheWrite ?? 0)} | ${fmt(s.cacheWrite)} | ${fmt(life.cacheWrite)} |`,
      `| **Total** | **${fmt(m.last ? total(m.last) : 0)}** | **${fmt(total(s))}** | **${fmt(total(life))}** |`,
      `| Tours | ${m.last ? 1 : 0} | ${s.turns} | ${life.turns} |`,
      ``,
      `Contexte : ${m.contextTokens != null ? fmt(m.contextTokens) : '—'} / ${m.contextWindow ? fmt(m.contextWindow) : '—'}${m.contextPercent != null ? ` (${m.contextPercent}%)` : ''}`,
      m.usd != null ? `Coût estimé (discussion) : $${m.usd.toFixed(2)}` : '',
      ...m.limits.map(l => `Limite ${LABELS[l.kind] ?? l.kind} : ${l.percentUsed}%${l.resetsAt ? ` (reset ${l.resetsAt.slice(0, 16).replace('T', ' ')})` : ''}`),
      m.model ? `Modèle : ${m.model}` : '',
    ].filter(Boolean)
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, meter)
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const parts = [
      m.last ? `Dernier tour ${fmt(total(m.last))} (↑${fmt(m.last.input + m.last.cacheRead + m.last.cacheWrite)} ↓${fmt(m.last.output)})` : 'Aucun tour encore',
      `Discussion ${fmt(total(m.session))}`,
      m.contextPercent != null ? `Contexte ${m.contextPercent}%` : '',
      m.usd != null ? `$${m.usd.toFixed(2)}` : '',
      ...m.limits.map(l => `${LABELS[l.kind] ?? l.kind} ${l.percentUsed}%`),
    ].filter(Boolean)
    return (
      <Box>
        <Text dimColor>🔢 {parts.join('  ·  ')}</Text>
      </Box>
    )
  })
}
