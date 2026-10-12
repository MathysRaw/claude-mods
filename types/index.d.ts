export type Tally = { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number }
export type Meter = {
  last: Tally | null
  session: Tally
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
  usd: number | null
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  model: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'token-meter': { meter: Meter; isHidden: boolean }
  }
}
