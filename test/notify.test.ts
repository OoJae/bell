import assert from 'node:assert/strict'
import test from 'node:test'
import {
  announced,
  etDay,
  explorerTx,
  formatEvent,
  formatMessage,
  HALT,
  keeperEvents,
  minutesAfterBell,
  notify,
  notifyConfigured,
  type NotifyEvent,
  type TransitionLike,
} from '../src/notify.ts'
import { HaltState } from '../src/policy/reconcile.ts'

/** Unix seconds from a wall-clock time with its offset spelled out. */
const at = (iso: string) => Date.parse(iso) / 1000

const TOKEN = '123456:SECRET-token-value'
const ENV = { BELL_TELEGRAM_BOT_TOKEN: TOKEN, BELL_TELEGRAM_CHAT_ID: '@bell_devnet' }
const OWNER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'

const fill: NotifyEvent = {
  kind: 'fill',
  symbol: 'SPYx',
  amountIn: 200,
  quote: 'demo-USDC',
  shares: 0.290294,
  minutesAfterBell: 5,
  owner: OWNER,
  signature: SIG,
}

/** A fetch that records what it was asked and answers as told. */
function fakeFetch(answer: () => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return answer()
  }
  return { f, calls }
}

const transition = (symbol: string, over: Partial<TransitionLike>): TransitionLike => ({
  symbol,
  fromOpen: false,
  toOpen: false,
  fromHalt: HaltState.None,
  toHalt: HaltState.None,
  detail: 'test',
  ...over,
})

test('a fill says what was bought, for how much, when, by whom, and links the transaction', () => {
  const text = formatMessage([fill], 'devnet')
  assert.match(text, /^BELL \(devnet\)\n\n/)
  assert.match(text, /Filled: 0\.290294 SPYx for 200\.00 demo-USDC, 688\.96 demo-USDC a share, 5 min after the bell\./)
  assert.match(text, /Owner 7xKX…gAsU/)
  assert.ok(text.includes(`https://explorer.solana.com/tx/${SIG}?cluster=devnet`))
  assert.ok(!text.includes(OWNER), 'the owner is shortened')
})

test('a fill with no share count or no session time leaves those clauses out rather than guessing', () => {
  const text = formatEvent({ ...fill, shares: null, minutesAfterBell: null }, 'devnet')
  assert.match(text, /^Filled: SPYx for 200\.00 demo-USDC\.\n/)
  assert.ok(!text.includes('a share'))
  assert.ok(!text.includes('after the bell'))
})

test('an explorer link names the cluster, and a localnet one is not offered at all', () => {
  assert.equal(explorerTx('abc', 'devnet'), 'https://explorer.solana.com/tx/abc?cluster=devnet')
  assert.equal(explorerTx('abc', 'mainnet'), 'https://explorer.solana.com/tx/abc')
  assert.equal(explorerTx('abc', 'localnet'), null)
  assert.match(formatEvent({ ...fill, signature: 'abc' }, 'localnet'), /\nsig abc$/)
})

test('a dead order closed by the filler says why and where the rent went', () => {
  const text = formatEvent(
    { kind: 'closed', symbol: 'QQQx', owner: OWNER, why: 'expired', signature: SIG },
    'devnet',
  )
  assert.match(text, /^Closed a dead QQQx order: expired\. Its rent went back to the owner, 7xKX…gAsU\./)
  assert.ok(text.includes('?cluster=devnet'))
})

test('halt messages tell entering, leaving and changing apart, and name only a known kind', () => {
  const into = formatEvent(
    { kind: 'halt', symbol: 'TSLAx', fromHalt: HaltState.None, toHalt: HaltState.Luld, toOpen: false, detail: 'halted on the primary listing exchange' },
    'devnet',
  )
  assert.equal(
    into,
    'TSLAx stopped (LULD pause): halted on the primary listing exchange. BELL refuses it until the stop clears; queued orders wait.',
  )
  // Unspecified is a boolean flag or a disagreement, not a kind of halt, so
  // the detail says what it was and no label pretends otherwise.
  const withdrawn = formatEvent(
    {
      kind: 'halt',
      symbol: 'IWMx',
      fromHalt: HaltState.None,
      toHalt: HaltState.Unspecified,
      toOpen: false,
      detail: 'issuer has withdrawn this token; the underlying is not exchange-halted',
    },
    'devnet',
  )
  assert.match(withdrawn, /^IWMx stopped: issuer has withdrawn this token;/)
  const out = formatEvent(
    { kind: 'halt', symbol: 'TSLAx', fromHalt: HaltState.Luld, toHalt: HaltState.None, toOpen: true, detail: 'session open' },
    'devnet',
  )
  assert.equal(out, 'TSLAx: the stop has cleared (was LULD pause) and it trades again. session open.')
  // The issuer's own pause before 16:00 ends at the close, into a closed
  // session, and "cleared" must not read as tradeable (keeper log, 16:00 ET).
  const intoClose = formatEvent(
    {
      kind: 'halt',
      symbol: 'SPYx',
      fromHalt: HaltState.Unspecified,
      toHalt: HaltState.None,
      toOpen: false,
      detail: 'issuer is open 24/5 but the primary market is closed',
    },
    'devnet',
  )
  assert.equal(
    intoClose,
    'SPYx: no longer stopped, but not open either: issuer is open 24/5 but the primary market is closed.',
  )
  const moved = formatEvent(
    { kind: 'halt', symbol: 'TSLAx', fromHalt: HaltState.Luld, toHalt: HaltState.NewsPending, toOpen: false, detail: 'halted on the primary listing exchange' },
    'devnet',
  )
  assert.match(moved, /still stopped, LULD pause -> halt, news pending/)
})

test('rebase messages give the activation in New York time and the window gate 4 enforces', () => {
  const activatesAt = at('2026-09-25T09:30:00-04:00')
  const before = at('2026-09-25T09:15:00-04:00')
  const entering = formatEvent({ kind: 'rebase', symbol: 'SPYx', entering: true, at: before, activatesAt, guardSeconds: 900 }, 'devnet')
  assert.match(entering, /multiplier at 2026-09-25 09:30 ET\. BELL refuses trades and fills for 15 minutes either side of it \(RebasePending\)\./)
  assert.match(entering, /a corporate action changes the token's multiplier/)
  // First seen after it activated (an immediate change, or a keeper that was
  // down): the same window, in the past tense.
  const late = formatEvent(
    { kind: 'rebase', symbol: 'SPYx', entering: true, at: at('2026-09-25T09:35:00-04:00'), activatesAt, guardSeconds: 900 },
    'devnet',
  )
  assert.match(late, /a corporate action changed the token's multiplier/)
  const leaving = formatEvent(
    { kind: 'rebase', symbol: 'SPYx', entering: false, at: at('2026-09-25T09:45:01-04:00'), activatesAt, guardSeconds: 900 },
    'devnet',
  )
  assert.match(leaving, /window around 2026-09-25 09:30 ET has passed/)
  assert.match(leaving, /built against the previous multiplier is refused \(MultiplierMoved\)/)
})

test('the open and the close carry the count and the New York time', () => {
  assert.equal(
    formatEvent({ kind: 'open', at: at('2026-09-24T09:30:40-04:00'), open: 9, total: 9 }, 'devnet'),
    "Market open (09:30 ET): 9 of 9 symbols attested open. Orders queued for the bell fill on the filler's next pass; it runs every five minutes.",
  )
  assert.match(
    formatEvent({ kind: 'close', at: at('2026-09-24T16:00:20-04:00'), total: 9 }, 'devnet'),
    /^Market closed \(16:00 ET\): none of the 9 symbols is attested open\./,
  )
})

test('a message longer than Telegram allows is cut to 4096 characters', () => {
  const many = Array.from({ length: 40 }, () => fill)
  const text = formatMessage(many, 'devnet')
  assert.equal(text.length, 4096)
  assert.ok(text.endsWith('…'))
})

test('minutes after the bell, in New York time across both offsets, and null outside the session', () => {
  assert.equal(minutesAfterBell(at('2026-09-24T09:35:10-04:00')), 5)
  assert.equal(minutesAfterBell(at('2026-12-01T09:30:00-05:00')), 0)
  assert.equal(minutesAfterBell(at('2026-09-24T09:29:59-04:00')), null)
  assert.equal(minutesAfterBell(at('2026-09-24T15:59:00-04:00')), 389)
  assert.equal(minutesAfterBell(at('2026-09-24T16:00:00-04:00')), null)
})

test('the trading day is New York’s, not UTC’s', () => {
  assert.equal(etDay(at('2026-09-24T23:30:00-04:00')), '2026-09-24')
  assert.equal(etDay(at('2026-09-25T00:10:00-04:00')), '2026-09-25')
})

test('the open and the close are each announced once a day, from the whole board', () => {
  const memo = announced()
  const base = { total: 9, windows: null, guardSeconds: 900 }
  const allOpen = Array.from({ length: 9 }, (_, i) => transition(`S${i}`, { fromOpen: false, toOpen: true }))

  // Overnight: nothing moves, nothing is said.
  assert.deepEqual(keeperEvents(memo, { ...base, at: at('2026-09-24T09:29:00-04:00'), open: 0, transitions: [] }), [])

  // The bell.
  const bell = keeperEvents(memo, { ...base, at: at('2026-09-24T09:30:30-04:00'), open: 9, transitions: allOpen })
  assert.deepEqual(bell.map((e) => e.kind), ['open'])
  assert.equal((bell[0] as { open: number }).open, 9)

  // One symbol stops and resumes mid-session: halt messages, never a second open.
  const stop = transition('S3', { fromOpen: true, toOpen: false, toHalt: HaltState.Luld })
  assert.deepEqual(
    keeperEvents(memo, { ...base, at: at('2026-09-24T11:00:00-04:00'), open: 8, transitions: [stop] }).map((e) => e.kind),
    ['halt'],
  )
  const resume = transition('S3', { fromOpen: false, toOpen: true, fromHalt: HaltState.Luld })
  assert.deepEqual(
    keeperEvents(memo, { ...base, at: at('2026-09-24T11:05:00-04:00'), open: 9, transitions: [resume] }).map((e) => e.kind),
    ['halt'],
  )

  // The close, then a flap back open and shut the same evening: said once.
  const allShut = Array.from({ length: 9 }, (_, i) => transition(`S${i}`, { fromOpen: true, toOpen: false }))
  assert.deepEqual(
    keeperEvents(memo, { ...base, at: at('2026-09-24T16:00:30-04:00'), open: 0, transitions: allShut }).map((e) => e.kind),
    ['close'],
  )
  assert.deepEqual(keeperEvents(memo, { ...base, at: at('2026-09-24T16:02:00-04:00'), open: 9, transitions: allOpen }), [])
  assert.deepEqual(keeperEvents(memo, { ...base, at: at('2026-09-24T16:03:00-04:00'), open: 0, transitions: allShut }), [])

  // The next day's bell is a new day.
  assert.deepEqual(
    keeperEvents(memo, { ...base, at: at('2026-09-25T09:30:30-04:00'), open: 9, transitions: allOpen }).map((e) => e.kind),
    ['open'],
  )
})

test('an open or close flip with no halt change is not a halt message', () => {
  const memo = announced()
  memo.open = '2026-09-24'
  const events = keeperEvents(memo, {
    at: at('2026-09-24T09:31:00-04:00'),
    open: 9,
    total: 9,
    transitions: [transition('SPYx', { fromOpen: false, toOpen: true })],
    windows: null,
    guardSeconds: 900,
  })
  assert.deepEqual(events, [])
})

test('rebase windows: the first reading only records, entering and leaving are each said once', () => {
  const memo = announced()
  const activatesAt = at('2026-09-25T09:30:00-04:00')
  const step = (when: string, windows: { symbol: string; activatesAt: number }[] | null) =>
    keeperEvents(memo, { at: at(when), open: 0, total: 9, transitions: [], windows, guardSeconds: 900 })

  assert.deepEqual(step('2026-09-25T09:00:00-04:00', [{ symbol: 'SPYx', activatesAt }]), [])
  const entering = step('2026-09-25T09:15:00-04:00', [{ symbol: 'SPYx', activatesAt }])
  assert.deepEqual(entering.map((e) => [e.kind, (e as { entering: boolean }).entering]), [['rebase', true]])
  assert.deepEqual(step('2026-09-25T09:40:00-04:00', [{ symbol: 'SPYx', activatesAt }]), [])
  // An unreadable tick changes nothing, rather than reading as "left the window".
  assert.deepEqual(step('2026-09-25T09:41:00-04:00', null), [])
  const leaving = step('2026-09-25T09:45:01-04:00', [{ symbol: 'SPYx', activatesAt }])
  assert.deepEqual(leaving.map((e) => [e.kind, (e as { entering: boolean }).entering]), [['rebase', false]])
  // No activation at all is simply outside.
  assert.deepEqual(step('2026-09-25T10:00:00-04:00', [{ symbol: 'QQQx', activatesAt: 0 }]), [])
})

test('with either variable unset, notify does nothing and never calls fetch', async () => {
  const { f, calls } = fakeFetch(() => new Response('{"ok":true}'))
  const logs: string[] = []
  const log = (l: string) => logs.push(l)
  await notify(fill, { cluster: 'devnet', env: {}, fetch: f, log })
  await notify(fill, { cluster: 'devnet', env: { BELL_TELEGRAM_BOT_TOKEN: TOKEN }, fetch: f, log })
  await notify(fill, { cluster: 'devnet', env: { BELL_TELEGRAM_CHAT_ID: '@x' }, fetch: f, log })
  await notify(fill, { cluster: 'devnet', env: { BELL_TELEGRAM_BOT_TOKEN: ' ', BELL_TELEGRAM_CHAT_ID: '@x' }, fetch: f, log })
  assert.equal(calls.length, 0)
  assert.deepEqual(logs, [])
  assert.equal(notifyConfigured({}), false)
  assert.equal(notifyConfigured(ENV), true)
})

test('notify posts one plain-text sendMessage to the channel, with link previews off', async () => {
  const { f, calls } = fakeFetch(() => new Response('{"ok":true,"result":{}}'))
  const logs: string[] = []
  await notify([fill, { kind: 'close', at: at('2026-09-24T16:00:20-04:00'), total: 9 }], {
    cluster: 'devnet',
    env: ENV,
    fetch: f,
    log: (l) => logs.push(l),
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`)
  assert.equal(calls[0]!.init.method, 'POST')
  assert.ok(calls[0]!.init.signal, 'the request carries an abort signal')
  const body = JSON.parse(String(calls[0]!.init.body))
  assert.equal(body.chat_id, '@bell_devnet')
  assert.equal(body.parse_mode, undefined, 'plain text: nothing in a message can break a parser')
  assert.deepEqual(body.link_preview_options, { is_disabled: true })
  assert.match(body.text, /^BELL \(devnet\)\n\nFilled:/)
  assert.match(body.text, /Market closed/)
  assert.deepEqual(logs, [])
})

test('a Telegram that never answers costs the caller the timeout, not more', async () => {
  const { f } = fakeFetch(() => new Promise<Response>(() => {}))
  const logs: string[] = []
  const started = Date.now()
  await notify(fill, { cluster: 'devnet', env: ENV, fetch: f, timeoutMs: 50, log: (l) => logs.push(l) })
  assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started}ms`)
  assert.equal(logs.length, 1)
  assert.match(logs[0]!, /did not answer within 50ms/)
})

test('the abort signal fires on a fetch that honours it', async () => {
  const f = (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
  const logs: string[] = []
  await notify(fill, { cluster: 'devnet', env: ENV, fetch: f, timeoutMs: 30, log: (l) => logs.push(l) })
  assert.equal(logs.length, 1)
  assert.match(logs[0]!, /timeout|did not answer/i)
})

test('notify never throws, and never logs the token', async () => {
  const logs: string[] = []
  const log = (l: string) => logs.push(l)
  const cases: Array<(url: string, init: RequestInit) => Promise<Response>> = [
    // Throws before returning a promise at all.
    () => {
      throw new TypeError(`Failed to parse URL from https://api.telegram.org/bot${TOKEN}/sendMessage`)
    },
    // Node's own shape for a network failure.
    () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })),
    // Telegram refusing: flood control, and a bot that is not a channel admin.
    async () => new Response('{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 7"}', { status: 429 }),
    async () => new Response('{"ok":false,"error_code":403,"description":"Forbidden: bot is not a member of the channel chat"}', { status: 403 }),
    async () => new Response('<html>bad gateway</html>', { status: 502 }),
  ]
  for (const f of cases) {
    await notify(fill, { cluster: 'devnet', env: ENV, fetch: f, timeoutMs: 200, log })
  }
  assert.equal(logs.length, cases.length)
  assert.match(logs[0]!, /<token>/)
  assert.match(logs[1]!, /fetch failed \(ECONNRESET\)/)
  assert.match(logs[2]!, /HTTP 429 Too Many Requests: retry after 7/)
  assert.match(logs[3]!, /HTTP 403 Forbidden: bot is not a member/)
  assert.match(logs[4]!, /HTTP 502 <html>bad gateway<\/html>/)
  for (const l of logs) assert.ok(!l.includes(TOKEN), `token leaked: ${l}`)
  assert.ok(!logs.some((l) => l.includes('SECRET')))

  // A logger that throws is swallowed too.
  await notify(fill, {
    cluster: 'devnet',
    env: ENV,
    fetch: async () => new Response('', { status: 500 }),
    log: () => {
      throw new Error('logger broke')
    },
  })
})

test('the halt kinds copied into notify.ts are reconcile.ts\'s, discriminant for discriminant', () => {
  assert.deepEqual({ ...HALT }, { ...HaltState })
})

test('an empty batch sends nothing', async () => {
  const { f, calls } = fakeFetch(() => new Response('{"ok":true}'))
  await notify([], { cluster: 'devnet', env: ENV, fetch: f })
  assert.equal(calls.length, 0)
})
