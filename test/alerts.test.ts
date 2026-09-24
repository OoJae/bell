/**
 * Per-wallet alerts: the bot's commands, where follows are kept, and the pass
 * that turns the program's new transactions into messages, each transaction
 * messaged about once.
 *
 * Nothing here reaches Telegram or an RPC. Both are stood in for, and the store
 * is a real `Recorder` on a temporary file, since the tables are the thing
 * being tested.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  MAX_FOLLOWS,
  MAX_READS,
  PAGE,
  alertEvent,
  alertEvents,
  alertText,
  createAlerts,
  crossAlertEvents,
  multiplierFromRisk,
  parseCommand,
  pollCommands,
  reply,
  scanFills,
  walletOf,
  type ScanOptions,
} from '../src/alerts.ts'
import { PROGRAM_ADDRESS, fillsOf, tradesOf, type Cross, type RpcTransaction } from '../src/chain/fills.ts'
import { shortKey, type TelegramOutcome } from '../src/notify.ts'
import { Recorder } from '../src/record.ts'
import { CRANKER, CROSS_SIG, CROSS_TIME, SELLER, crossFill } from './fixtures/cross-fill.ts'
import { BUY, BUY_SIG, OWNER, SELL_ORDER, SELL_SIG, SELL_TIME, sellFill } from './fixtures/sell-fill.ts'

const SPYX_MIRROR = 'AFrGCsmPc3WeUAEM3jw8Ec3M6BrKrJGDQeX2g1Ctrrwx'
/** The SPYx mirror mint's multiplier on 23 September, as the tape test reads it from the mint. */
const MULTIPLIER = 1.005714560286254
/** Another real wallet: the recorded fill's filler. */
const OTHER = '4v5r4eSnB7kmnAmJ6ia9X1Mhu7tZKpznLb3x5PdMjtN2'
const SELL = sellFill()
/** The recorded buyer's order crossed against SELLER's, a minute after the sale. */
const CROSS = crossFill()

function tempDb(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'bell-alerts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'bell.db')
}

function store(t: test.TestContext): Recorder {
  const r = new Recorder(tempDb(t))
  t.after(() => r.close())
  return r
}

// ------------------------------------------------------------------ commands

test('commands: /start with one wallet follows it, /start alone asks for one, /stop with or without', () => {
  assert.deepEqual(parseCommand(`/start ${OWNER}`), { kind: 'start', wallet: OWNER })
  // How a deep link or a menu delivers it, and with stray whitespace.
  assert.deepEqual(parseCommand(`/start@Bell_solbot ${OWNER}`), { kind: 'start', wallet: OWNER })
  assert.deepEqual(parseCommand(`  /START   ${OWNER}\n`), { kind: 'start', wallet: OWNER })
  assert.deepEqual(parseCommand('/start'), { kind: 'help' })
  assert.deepEqual(parseCommand('/stop'), { kind: 'stop', wallet: null })
  assert.deepEqual(parseCommand(`/stop ${OWNER}`), { kind: 'stop', wallet: OWNER })
  assert.deepEqual(parseCommand('/list'), { kind: 'list' })
  assert.deepEqual(parseCommand('hello'), { kind: 'help' })
  assert.deepEqual(parseCommand('/buy SPYx'), { kind: 'help' })
  assert.deepEqual(parseCommand(''), { kind: 'help' })
})

test('commands: an argument that is not exactly one wallet address is refused, not guessed at', () => {
  assert.deepEqual(parseCommand('/start nope'), { kind: 'invalid', input: 'nope' })
  // Base58 has no 0, O, I or l.
  assert.deepEqual(parseCommand(`/start ${OWNER.slice(0, -1)}0`), { kind: 'invalid', input: `${OWNER.slice(0, -1)}0` })
  // Two words: the first is a wallet, but the chat did not name only it.
  assert.deepEqual(parseCommand(`/start ${OWNER} please`), { kind: 'invalid', input: `${OWNER} please` })
  assert.deepEqual(parseCommand(`/stop ${OWNER}x`).kind, 'invalid')
})

test('a wallet is base58 of exactly 32 bytes', () => {
  assert.equal(walletOf(OWNER), OWNER)
  assert.equal(walletOf(SELL_ORDER), SELL_ORDER, 'a program address is off the curve, and one can own orders')
  assert.equal(walletOf('11111111111111111111111111111111'), '11111111111111111111111111111111')
  assert.equal(walletOf(OWNER.slice(0, 31)), null, 'too short to be 32 bytes')
  assert.equal(walletOf(`${OWNER}zz`), null)
  assert.equal(walletOf('z'.repeat(44)), null, '44 characters that decode to 33 bytes')
})

// ------------------------------------------------------------------- storage

test('follows are stored per chat and wallet, once each, and survive a reopen', (t) => {
  const path = tempDb(t)
  const r = new Recorder(path)
  assert.equal(r.follow('100', OWNER, 1), true)
  assert.equal(r.follow('100', OWNER, 2), false, 'following twice is one follow')
  assert.equal(r.follow('100', OTHER, 3), true)
  assert.equal(r.follow('-200', OWNER, 4), true)
  assert.deepEqual(r.following('100'), [OWNER, OTHER])
  assert.deepEqual(r.followers(OWNER), ['100', '-200'])
  assert.deepEqual([...r.followed()].sort(), [OTHER, OWNER].sort())
  r.close()

  const again = new Recorder(path)
  assert.deepEqual(again.following('100'), [OWNER, OTHER])
  assert.equal(again.unfollow('100', OTHER), 1)
  assert.equal(again.unfollow('100', OTHER), 0)
  assert.equal(again.unfollow('-200'), 1)
  assert.deepEqual(again.followers(OWNER), ['100'])
  again.close()
})

test('opening a log from before alerts adds their tables and changes nothing else', (t) => {
  const path = tempDb(t)
  const old = new Database(path)
  old.exec(`
    CREATE TABLE ticks (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, symbol TEXT NOT NULL,
      mint TEXT NOT NULL, issuer TEXT NOT NULL, open_now INTEGER NOT NULL, halt INTEGER NOT NULL,
      confidence TEXT NOT NULL, detail TEXT NOT NULL, pyth_open INTEGER, issuer_open INTEGER,
      issuer_halted INTEGER, exchange_halt INTEGER, pushed INTEGER NOT NULL, signature TEXT);
    INSERT INTO ticks (at, symbol, mint, issuer, open_now, halt, confidence, detail, pushed)
      VALUES (1758484196, 'SPYx', 'm', 'backed', 1, 0, 'confirmed', 'from before', 1);
  `)
  const before = old.prepare("SELECT sql FROM sqlite_master WHERE name = 'ticks'").get()
  old.close()

  new Recorder(path).close()
  const r = new Recorder(path)
  assert.deepEqual(r.counts(), { ticks: 1, transitions: 0, marks: 0 })
  r.close()
  const db = new Database(path, { readonly: true })
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((x) => x.name)
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ticks'").get(), before)
  db.close()
  for (const name of ['alert_follows', 'alert_cursors', 'alert_seen']) assert.ok(tables.includes(name), name)
})

test('a cursor is one value per name, and a signature is claimed once', (t) => {
  const r = store(t)
  assert.equal(r.alertCursor('telegram_offset'), null)
  r.setAlertCursor('telegram_offset', '7')
  r.setAlertCursor('telegram_offset', '9')
  assert.equal(r.alertCursor('telegram_offset'), '9')

  assert.equal(r.seen(BUY_SIG), false)
  assert.equal(r.claim(BUY_SIG, 100), true)
  assert.equal(r.claim(BUY_SIG, 200), false, 'the second claim loses')
  assert.equal(r.seen(BUY_SIG), true)
  r.claim(SELL_SIG, 300)
  assert.equal(r.forgetSeen(250), 1, 'only what was claimed before the cutoff')
  assert.equal(r.seen(BUY_SIG), false)
  assert.equal(r.seen(SELL_SIG), true)
})

// ------------------------------------------------------------------- replies

test('following says plainly that anyone can follow any wallet, and stopping undoes it', (t) => {
  const r = store(t)
  const said = reply(r, '100', { kind: 'start', wallet: OWNER }, 1, 'devnet')
  assert.match(said, new RegExp(`Following ${OWNER} on BELL \\(devnet\\)`))
  assert.match(said, /Anyone can follow any wallet\. Fills are public on chain/)
  assert.match(said, /does not mean you own it/)
  assert.deepEqual(r.following('100'), [OWNER])

  reply(r, '100', { kind: 'start', wallet: OWNER }, 2, 'devnet')
  assert.deepEqual(r.following('100'), [OWNER], 'a repeated /start is one follow')
  assert.match(reply(r, '100', { kind: 'list' }, 3, 'devnet'), new RegExp(OWNER))

  assert.equal(reply(r, '100', { kind: 'stop', wallet: OTHER }, 4, 'devnet'), `This chat was not following ${OTHER}.`)
  assert.equal(reply(r, '100', { kind: 'stop', wallet: OWNER }, 5, 'devnet'), `Stopped following ${OWNER}.`)
  reply(r, '100', { kind: 'start', wallet: OWNER }, 6, 'devnet')
  reply(r, '100', { kind: 'start', wallet: OTHER }, 7, 'devnet')
  assert.equal(reply(r, '100', { kind: 'stop', wallet: null }, 8, 'devnet'), 'Stopped. This chat no longer follows any wallet.')
  assert.deepEqual(r.following('100'), [])
  assert.equal(reply(r, '100', { kind: 'stop', wallet: null }, 9, 'devnet'), 'This chat was not following any wallet.')

  const help = reply(r, '100', { kind: 'help' }, 10, 'devnet')
  assert.match(help, /\/start followed by its address/)
  assert.match(help, /Anyone can follow any wallet/)
  assert.match(help, /t\.me\/bellfills/)
  assert.match(reply(r, '100', { kind: 'invalid', input: 'x'.repeat(500) }, 11, 'devnet'), /is not a Solana wallet address/)
  assert.ok(reply(r, '100', { kind: 'invalid', input: 'x'.repeat(500) }, 11, 'devnet').length < 300, 'the input is not echoed whole')
})

test(`one chat follows at most ${MAX_FOLLOWS} wallets`, (t) => {
  const r = store(t)
  const wallets = Array.from({ length: MAX_FOLLOWS + 1 }, (_, i) => walletOf(bs58(new Uint8Array(32).fill(i + 1)))!)
  for (const w of wallets.slice(0, MAX_FOLLOWS)) reply(r, '100', { kind: 'start', wallet: w }, 1, 'devnet')
  assert.match(reply(r, '100', { kind: 'start', wallet: wallets[MAX_FOLLOWS]! }, 2, 'devnet'), /the most one chat can/)
  assert.equal(r.following('100').length, MAX_FOLLOWS)
  // One it already follows is still confirmed.
  assert.match(reply(r, '100', { kind: 'start', wallet: wallets[0]! }, 3, 'devnet'), /^Following /)
})

/** Base58 of bytes, for making addresses. */
function bs58(b: Uint8Array): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = 0n
  for (const x of b) n = n * 256n + BigInt(x)
  let out = ''
  while (n > 0n) {
    out = A[Number(n % 58n)] + out
    n /= 58n
  }
  for (const x of b) {
    if (x !== 0) break
    out = '1' + out
  }
  return out
}

// ------------------------------------------------------------------ polling

type Call = { url: string; body: Record<string, unknown> }

/** A stand-in for Telegram: answers each method from `answers`, and records every call. */
function fakeTelegram(answers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url, body })
    const method = url.split('/').at(-1)!
    const answer = answers[method]?.(body)
    if (answer instanceof Response) return answer
    return Response.json({ ok: true, result: answer ?? true })
  }
  return { calls, fetch }
}

const TOKEN = '123456:SECRET-token'

test('commands are read from private chats only, each once, and answered in the chat that sent them', async (t) => {
  const r = store(t)
  const tg = fakeTelegram({
    getUpdates: (body) =>
      body.offset === 13
        ? []
        : [
            { update_id: 11, message: { chat: { id: 555, type: 'private' }, from: { is_bot: false }, text: `/start ${OWNER}` } },
            // The same command in a group would sign up everyone in it.
            { update_id: 12, message: { chat: { id: -900, type: 'group' }, from: { is_bot: false }, text: `/start ${OTHER}` } },
          ],
  })
  const lines: string[] = []
  const handled = await pollCommands({ token: TOKEN, store: r, cluster: 'devnet', fetch: tg.fetch, log: (l) => lines.push(l), now: () => 1 })
  assert.equal(handled, 1)
  assert.deepEqual(r.following('555'), [OWNER])
  assert.deepEqual(r.following('-900'), [])
  assert.equal(r.alertCursor('telegram_offset'), '13', 'the next update to read')
  const sent = tg.calls.filter((c) => c.url.endsWith('/sendMessage'))
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.body.chat_id, 555)
  assert.match(String(sent[0]!.body.text), /Anyone can follow any wallet/)
  assert.deepEqual(lines, [])

  // The next poll starts after them, so they are not carried out again.
  await pollCommands({ token: TOKEN, store: r, cluster: 'devnet', fetch: tg.fetch, log: () => {}, now: () => 2 })
  const polls = tg.calls.filter((c) => c.url.endsWith('/getUpdates'))
  assert.equal(polls[0]!.body.offset, undefined)
  assert.equal(polls[1]!.body.offset, 13)
  assert.deepEqual(polls[1]!.body.allowed_updates, ['message'])
})

test('a refused getUpdates throws without the token in the reason', async (t) => {
  const r = store(t)
  const tg = fakeTelegram({
    getUpdates: () =>
      Response.json({ ok: false, description: `Conflict: terminated by other getUpdates request ${TOKEN}` }, { status: 409 }),
  })
  await assert.rejects(
    pollCommands({ token: TOKEN, store: r, cluster: 'devnet', fetch: tg.fetch, log: () => {} }),
    (e: Error) => /HTTP 409 Conflict/.test(e.message) && !e.message.includes(TOKEN),
  )
  assert.equal(r.alertCursor('telegram_offset'), null)
})

// --------------------------------------------------------------------- fills

const LISTINGS = [{ symbol: 'SPYx', mint: SPYX_MIRROR }]
const OWN_SIG = '4own1111111111111111111111111111111111111111111111111111111111111111111111111111111111'
const FAILED_SIG = '5fai1111111111111111111111111111111111111111111111111111111111111111111111111111111111'
const OLD_HEAD = '2he4d111111111111111111111111111111111111111111111111111111111111111111111111111111111'

/**
 * A stand-in RPC. `pages` answers each `getSignaturesForAddress` in turn;
 * `getTransaction` serves the recorded buy and the sell built from it.
 */
function fakeRpc(
  pages: unknown[][],
  txs: Record<string, RpcTransaction | null> = { [BUY_SIG]: BUY, [SELL_SIG]: SELL, [CROSS_SIG]: CROSS },
) {
  const calls: { method: string; params: unknown[] }[] = []
  let page = 0
  const rpc = async (method: string, params: unknown[]) => {
    calls.push({ method, params })
    if (method === 'getSignaturesForAddress') return pages[Math.min(page++, pages.length - 1)]
    if (method === 'getTransaction') return txs[params[0] as string] ?? null
    throw new Error(`unexpected ${method}`)
  }
  return { rpc, calls, reads: () => calls.filter((c) => c.method === 'getTransaction').map((c) => c.params[0]) }
}

function scanWith(r: Recorder, rpc: ScanOptions['rpc'], over: Partial<ScanOptions> = {}) {
  const sent: { chat: string; text: string }[] = []
  const lines: string[] = []
  const opts: ScanOptions = {
    rpc,
    store: r,
    own: new Set([OWN_SIG]),
    send: async (chat, text): Promise<TelegramOutcome> => {
      sent.push({ chat, text })
      return { ok: true, result: {} }
    },
    log: (l) => lines.push(l),
    cluster: 'devnet',
    listings: LISTINGS,
    multiplier: () => MULTIPLIER,
    now: () => (SELL_TIME + 120) * 1000,
    sleep: async () => {},
    ...over,
  }
  return { run: () => scanFills(opts), sent, lines }
}

const sig = (signature: string, blockTime: number, err: unknown = null) => ({ signature, err, blockTime })

test('a first pass only finds where the present is: no history is messaged', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  const { rpc, calls, reads } = fakeRpc([[sig(OLD_HEAD, BUY.blockTime! - 60)]])
  const s = scanWith(r, rpc)
  assert.deepEqual(await s.run(), { read: 0, fills: 0, sent: 0, behind: false })
  assert.equal(r.alertCursor('program_signature:devnet'), OLD_HEAD)
  assert.deepEqual(calls[0]!.params, [PROGRAM_ADDRESS, { limit: 1, commitment: 'finalized' }])
  assert.deepEqual(reads(), [])
  assert.deepEqual(s.sent, [])
})

test('a pass reads only what could hold a fill, and messages each follower once, oldest fill first', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.follow('777', OTHER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  // Newest first, as the RPC lists them.
  const page = [
    sig(SELL_SIG, SELL_TIME),
    sig(OWN_SIG, SELL_TIME - 10),
    sig(FAILED_SIG, SELL_TIME - 20, { InstructionError: [0, { Custom: 6000 }] }),
    sig(BUY_SIG, BUY.blockTime!),
  ]
  const { rpc, calls, reads } = fakeRpc([page, page])
  const s = scanWith(r, rpc)
  const report = await s.run()

  assert.deepEqual(calls[0]!.params, [PROGRAM_ADDRESS, { until: OLD_HEAD, limit: PAGE, commitment: 'finalized' }])
  assert.deepEqual(reads(), [BUY_SIG, SELL_SIG], 'the keeper’s own and the failed one are never fetched')
  assert.deepEqual(report, { read: 2, fills: 2, sent: 1, behind: false })
  assert.equal(s.sent.length, 1, 'both fills in one message')
  assert.equal(s.sent[0]!.chat, '555', 'nobody follows the filler’s side of these')
  const text = s.sent[0]!.text
  assert.ok(text.startsWith('BELL (devnet)\n\n'))
  assert.match(text, /Filled: 0\.258084 SPYx for 200\.00 demo-USDC, 774\.94 demo-USDC a share, 5 min after the bell\./)
  assert.match(text, /Sold: 0\.258084 SPYx for 198\.80 demo-USDC/)
  assert.ok(text.indexOf('Filled:') < text.indexOf('Sold:'), 'oldest first')
  assert.match(text, /Owner 9wNe…beEJ/)
  assert.match(text, new RegExp(`https://explorer\\.solana\\.com/tx/${BUY_SIG}\\?cluster=devnet`))
  assert.match(text, /\/stop ends these messages\.$/)
  assert.equal(r.alertCursor('program_signature:devnet'), SELL_SIG)
})

test('a transaction met again is not messaged again, even when the cursor was lost', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const page = [sig(SELL_SIG, SELL_TIME), sig(BUY_SIG, BUY.blockTime!)]
  const { rpc, reads } = fakeRpc([page, page])
  const s = scanWith(r, rpc)
  await s.run()
  assert.equal(s.sent.length, 1)

  // A restart that lost the cursor's last write lists the same signatures again.
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const again = await s.run()
  assert.equal(s.sent.length, 1, 'no second message')
  assert.equal(again.read, 0)
  assert.deepEqual(reads(), [BUY_SIG, SELL_SIG], 'and no second read')
  assert.equal(r.alertCursor('program_signature:devnet'), SELL_SIG)
})

test('with nobody following, a pass reads nothing and only keeps up with the present', async (t) => {
  const r = store(t)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const { rpc, reads } = fakeRpc([[sig(SELL_SIG, SELL_TIME)]])
  const s = scanWith(r, rpc)
  await s.run()
  assert.deepEqual(reads(), [])
  assert.equal(r.alertCursor('program_signature:devnet'), SELL_SIG)
})

test('a pass reads at most its cap, and the next one carries on from where it stopped', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  // Transactions that are not fills: the recorded buy with its fill instruction's logs removed would
  // not line up, so these are unknown signatures the RPC serves as the refresh-only transaction.
  const refresh = structuredClone(BUY)
  refresh.transaction.message.instructions = refresh.transaction.message.instructions.slice(0, 1)
  refresh.meta!.logMessages = refresh.meta!.logMessages!.slice(0, 4)
  refresh.meta!.innerInstructions = []
  // sig000 is the oldest; the RPC lists newest first.
  const names = Array.from({ length: MAX_READS + 3 }, (_, i) => `sig${String(i).padStart(3, '0')}`)
  const txs = Object.fromEntries(names.map((n) => [n, refresh]))
  const page = [...names].reverse().map((n) => sig(n, SELL_TIME))
  const rest = [...names.slice(MAX_READS)].reverse().map((n) => sig(n, SELL_TIME))
  const { rpc, calls, reads } = fakeRpc([page, rest], txs)
  const s = scanWith(r, rpc)
  const first = await s.run()
  assert.equal(first.read, MAX_READS)
  assert.deepEqual(reads(), names.slice(0, MAX_READS))
  assert.equal(r.alertCursor('program_signature:devnet'), names[MAX_READS - 1])
  assert.equal(fillsOf(refresh).length, 0)

  const second = await s.run()
  assert.equal(second.read, 3)
  assert.deepEqual((calls.at(-4)!.params[1] as { until: string }).until, names[MAX_READS - 1])
  assert.deepEqual(reads(), names)
  assert.equal(r.alertCursor('program_signature:devnet'), names.at(-1))
})

test('reading stops at the deadline and at a refused request, and what was read is still sent', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const page = [sig(SELL_SIG, SELL_TIME), sig(BUY_SIG, BUY.blockTime!)]
  let n = 0
  const rpc = async (method: string, params: unknown[]) => {
    if (method === 'getSignaturesForAddress') return page
    if (n++ === 0 && params[0] === BUY_SIG) return BUY
    throw new Error('getTransaction: HTTP 429')
  }
  const s = scanWith(r, rpc)
  const report = await s.run()
  assert.equal(report.error, 'getTransaction: HTTP 429')
  assert.equal(report.read, 1)
  assert.equal(s.sent.length, 1, 'the buy read before the refusal is still messaged')
  assert.equal(r.alertCursor('program_signature:devnet'), BUY_SIG, 'the sale is left for the next pass')

  // Past the deadline, nothing is fetched and the cursor stays.
  const late = store(t)
  late.follow('555', OWNER, 1)
  late.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const { rpc: rpc2, reads } = fakeRpc([page])
  const s2 = scanWith(late, rpc2, { deadline: 0 })
  assert.equal((await s2.run()).read, 0)
  assert.deepEqual(reads(), [])
  assert.equal(late.alertCursor('program_signature:devnet'), OLD_HEAD)
})

test('an unserved transaction is waited for, but not forever', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const page = [sig(SELL_SIG, SELL_TIME), sig(BUY_SIG, BUY.blockTime!)]
  const { rpc } = fakeRpc([page, page], { [SELL_SIG]: SELL })
  // Two minutes after: the buy may yet be served, so the pass stops before it.
  const s = scanWith(r, rpc)
  await s.run()
  assert.equal(r.alertCursor('program_signature:devnet'), OLD_HEAD)
  assert.equal(s.sent.length, 0)
  // An hour after, it is skipped and the sale behind it goes out.
  const later = scanWith(r, rpc, { now: () => (SELL_TIME + 3600) * 1000 })
  await later.run()
  assert.equal(later.sent.length, 1)
  assert.doesNotMatch(later.sent[0]!.text, /Filled:/)
  assert.match(later.sent[0]!.text, /Sold:/)
  assert.ok(later.lines.some((l) => l.includes('not served')))
})

test('a fill of a symbol or mint BELL does not list is not messaged, as it is not on the tape', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const { rpc } = fakeRpc([[sig(BUY_SIG, BUY.blockTime!)]])
  const s = scanWith(r, rpc, { listings: [{ symbol: 'SPYx', mint: OTHER }] })
  const report = await s.run()
  assert.equal(report.read, 1)
  assert.equal(report.fills, 0)
  assert.deepEqual(s.sent, [])
  assert.equal(r.seen(BUY_SIG), true)
})

test('a chat that blocked the bot loses its follows', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.follow('556', OWNER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const { rpc } = fakeRpc([[sig(BUY_SIG, BUY.blockTime!)]])
  const s = scanWith(r, rpc, {
    send: async (chat) =>
      chat === '555'
        ? { ok: false, status: 403, why: 'HTTP 403 Forbidden: bot was blocked by the user' }
        : { ok: true, result: {} },
  })
  const report = await s.run()
  assert.equal(report.sent, 1)
  assert.deepEqual(r.following('555'), [])
  assert.deepEqual(r.following('556'), [OWNER])
})

test('more signatures than one listing holds are said out loud, and the newest are read', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const page = Array.from({ length: PAGE }, (_, i) => sig(`x${i}`, SELL_TIME, { failed: true }))
  const { rpc } = fakeRpc([page])
  const s = scanWith(r, rpc)
  const report = await s.run()
  assert.equal(report.behind, true)
  assert.ok(s.lines.some((l) => l.includes(`${PAGE} or more transactions`)))
  assert.equal(r.alertCursor('program_signature:devnet'), 'x0', 'past every failed one, to the newest')
})

// ------------------------------------------------------------- the message

test('a sale is stated as a sale, with the quote it was paid', () => {
  const [f] = fillsOf(SELL)
  const e = alertEvent(f!, SELL, { cluster: 'devnet', listings: LISTINGS, multiplier: () => MULTIPLIER })
  assert.ok(e && e.kind === 'fill')
  assert.equal(e.side, 'sell')
  assert.equal(e.amountIn, 198.801792)
  assert.equal(e.owner, OWNER)
  assert.equal(e.signature, SELL_SIG)
  assert.equal(e.quote, 'demo-USDC')
  // With no multiplier, no share count rather than a wrong one.
  const bare = alertEvent(f!, SELL, { cluster: 'devnet', listings: LISTINGS, multiplier: () => null })
  assert.ok(bare && bare.kind === 'fill')
  assert.equal(bare.shares, null)
  assert.match(alertText([bare], 'devnet'), /Sold: SPYx for 198\.80 demo-USDC/)
})

test('the multiplier at a fill, from a risk record read after it', () => {
  const bits = (x: number) => {
    const d = new DataView(new ArrayBuffer(8))
    d.setFloat64(0, x, true)
    return d.getBigUint64(0, true)
  }
  // Nothing scheduled.
  assert.equal(multiplierFromRisk({ multiplierBits: bits(1.5), pendingMultiplierBits: 0n, activatesAt: 0n }, 100), 1.5)
  // A change ahead: the old one before it, the new one from it.
  const ahead = { multiplierBits: bits(1.5), pendingMultiplierBits: bits(1.6), activatesAt: 200n }
  assert.equal(multiplierFromRisk(ahead, 199), 1.5)
  assert.equal(multiplierFromRisk(ahead, 200), 1.6)
  // A change passed: the record keeps only the new one, so a fill from before it has none.
  const passed = { multiplierBits: bits(1.6), pendingMultiplierBits: 0n, activatesAt: 200n }
  assert.equal(multiplierFromRisk(passed, 250), 1.6)
  assert.equal(multiplierFromRisk(passed, 150), null)
})

test('a long run of fills is cut to Telegram’s limit and still says how to stop', () => {
  const [f] = fillsOf(BUY)
  const e = alertEvent(f!, BUY, { cluster: 'devnet', listings: LISTINGS, multiplier: () => MULTIPLIER })!
  const text = alertText(Array.from({ length: 40 }, () => e), 'devnet')
  assert.ok(text.length <= 4096)
  assert.match(text, /\/stop ends these messages\.$/)
})

// ------------------------------------------------------------------ switched off

test('without a bot token nothing is read, polled or sent', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  let fetched = 0
  const alerts = createAlerts({
    cluster: 'devnet',
    listings: LISTINGS,
    rpcUrl: 'http://127.0.0.1:1',
    env: { BELL_TELEGRAM_CHAT_ID: '@bellfills' },
    fetch: async () => {
      fetched++
      return Response.json({})
    },
  })
  assert.equal(alerts.enabled, false)
  alerts.afterTick(r, { own: [OWN_SIG], board: null })
  const stop = alerts.listen(() => r)
  stop()
  await alerts.idle()
  assert.equal(fetched, 0)
})

test('with a token, a tick starts one pass at a time and the keeper does not wait on it', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const methods: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const alerts = createAlerts({
    cluster: 'devnet',
    listings: LISTINGS,
    rpcUrl: 'http://rpc.invalid',
    env: { BELL_TELEGRAM_BOT_TOKEN: TOKEN },
    log: () => {},
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body)) as { method?: string; params?: unknown[] }
      if (url.startsWith('https://api.telegram.org/')) {
        methods.push('sendMessage')
        return Response.json({ ok: true, result: {} })
      }
      methods.push(body.method!)
      if (body.method === 'getSignaturesForAddress') {
        await gate
        return Response.json({ jsonrpc: '2.0', id: 1, result: [sig(BUY_SIG, BUY.blockTime!)] })
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result: BUY })
    },
  })
  assert.equal(alerts.enabled, true)
  alerts.afterTick(r, { own: [OWN_SIG, null], board: null })
  alerts.afterTick(r, { own: [], board: null }) // still running: skipped
  assert.deepEqual(methods, ['getSignaturesForAddress'])
  release()
  await alerts.idle()
  assert.deepEqual(methods, ['getSignaturesForAddress', 'getTransaction', 'sendMessage'])
  assert.equal(r.seen(BUY_SIG), true)
})

test('malformed updates are stepped over, not retried forever and not thrown on', async (t) => {
  const r = store(t)
  const tg = fakeTelegram({
    getUpdates: () => [
      null,
      { update_id: 'x' },
      { update_id: 20 },
      { update_id: 21, message: null },
      { update_id: 22, message: { chat: { type: 'private' }, text: '/list' } },
      { update_id: 23, message: { chat: { id: 555, type: 'private' }, text: 42 } },
      { update_id: 24, message: { chat: { id: 555, type: 'private' }, from: { is_bot: true }, text: `/start ${OWNER}` } },
    ],
  })
  const handled = await pollCommands({ token: TOKEN, store: r, cluster: 'devnet', fetch: tg.fetch, log: () => {} })
  assert.equal(handled, 0)
  assert.equal(r.alertCursor('telegram_offset'), '25', 'past every one of them')
  assert.deepEqual(r.following('555'), [])
  assert.equal(tg.calls.filter((c) => c.url.endsWith('/sendMessage')).length, 0)
})

test('a pass never starts reading after the keeper’s readUntil, so it stays off the next tick’s endpoint', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const methods: string[] = []
  const alerts = createAlerts({
    cluster: 'devnet',
    listings: LISTINGS,
    rpcUrl: 'http://rpc.invalid',
    env: { BELL_TELEGRAM_BOT_TOKEN: TOKEN },
    log: () => {},
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body)) as { method?: string }
      methods.push(url.startsWith('https://api.telegram.org/') ? 'sendMessage' : body.method!)
      if (body.method === 'getSignaturesForAddress') {
        // Slower than the deadline below, so the pass is past it once listed.
        await new Promise((resolve) => setTimeout(resolve, 20))
        return Response.json({ jsonrpc: '2.0', id: 1, result: [sig(BUY_SIG, BUY.blockTime!)] })
      }
      return Response.json({ ok: true, jsonrpc: '2.0', id: 1, result: BUY })
    },
  })
  // A tick that ran into the next one's slot: no pass at all.
  alerts.afterTick(r, { own: [], board: null, readUntil: Date.now() - 1 })
  await alerts.idle()
  assert.deepEqual(methods, [])
  // A deadline that falls between the listing and the first read: listed, not read.
  alerts.afterTick(r, { own: [], board: null, readUntil: Date.now() + 5 })
  await alerts.idle()
  assert.deepEqual(methods, ['getSignaturesForAddress'])
  assert.equal(r.seen(BUY_SIG), false, 'left for the next pass')
})

test('a message about several wallets says it follows the owners', () => {
  const [buy] = fillsOf(BUY)
  const e = alertEvent(buy!, BUY, { cluster: 'devnet', listings: LISTINGS, multiplier: () => MULTIPLIER })!
  assert.ok(e.kind === 'fill')
  assert.match(alertText([e], 'devnet'), /follows the owner above\./)
  assert.match(alertText([e, { ...e, owner: OTHER }], 'devnet'), /follows the owners above\./)
})

test('an unserved transaction listed without a block time is not waited for forever either', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const NO_TIME = '3n0t1me11111111111111111111111111111111111111111111111111111111111111111111111111111'
  const page = [sig(SELL_SIG, SELL_TIME), { signature: NO_TIME, err: null, blockTime: null }]
  const { rpc } = fakeRpc([page, page], { [SELL_SIG]: SELL })
  const first = scanWith(r, rpc)
  await first.run()
  assert.equal(r.alertCursor('program_signature:devnet'), OLD_HEAD, 'waited for at first')
  const later = scanWith(r, rpc, { now: () => (SELL_TIME + 3600) * 1000 })
  await later.run()
  assert.equal(later.sent.length, 1, 'then skipped, and the sale behind it goes out')
  assert.equal(r.alertCursor('program_signature:devnet'), SELL_SIG)
})

// ------------------------------------------------------------------- crosses

test('a cross is told to each party’s followers from its own side, and neither is told the other', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1) // the buyer
  r.follow('888', SELLER, 1) // the seller
  r.follow('777', CRANKER, 1) // the crank that sent it, and no party to it
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const { rpc, reads } = fakeRpc([[sig(CROSS_SIG, CROSS_TIME)]])
  const s = scanWith(r, rpc)
  assert.deepEqual(await s.run(), { read: 1, fills: 2, sent: 2, behind: false })
  assert.deepEqual(reads(), [CROSS_SIG])
  assert.deepEqual(s.sent.map((m) => m.chat).sort(), ['555', '888'], 'nothing to the crank’s follower')

  const link = new RegExp(`https://explorer\\.solana\\.com/tx/${CROSS_SIG}\\?cluster=devnet`)
  const toBuyer = s.sent.find((m) => m.chat === '555')!.text
  assert.match(
    toBuyer,
    /Crossed: bought 0\.258860 SPYx for 200\.00 demo-USDC, 772\.62 demo-USDC a share, at the pool's price, no filler spread, 7 min after the bell\./,
  )
  assert.match(toBuyer, /Owner 9wNe…beEJ/)
  assert.match(toBuyer, link)
  assert.match(toBuyer, /follows the owner above\. \/stop ends these messages\.$/)
  assert.ok(!toBuyer.includes(SELLER) && !toBuyer.includes(shortKey(SELLER)), 'the buyer’s followers are not told who sold')

  const toSeller = s.sent.find((m) => m.chat === '888')!.text
  assert.match(toSeller, /Crossed: sold 0\.258860 SPYx for 200\.00 demo-USDC, 772\.62 demo-USDC a share/)
  assert.match(toSeller, new RegExp(`Owner ${shortKey(SELLER)}`))
  assert.match(toSeller, link)
  assert.ok(!toSeller.includes(OWNER) && !toSeller.includes(shortKey(OWNER)), 'the seller’s followers are not told who bought')
  assert.ok(!`${toBuyer}${toSeller}`.includes(shortKey(CRANKER)))
})

test('a chat following both parties gets both sides of the cross, each naming its own owner', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.follow('555', SELLER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const { rpc } = fakeRpc([[sig(CROSS_SIG, CROSS_TIME)]])
  const s = scanWith(r, rpc)
  assert.deepEqual(await s.run(), { read: 1, fills: 2, sent: 1, behind: false })
  const text = s.sent[0]!.text
  assert.match(text, /Crossed: bought [^\n]*\.\nOwner 9wNe…beEJ\n/)
  assert.match(text, new RegExp(`Crossed: sold [^\\n]*\\.\\nOwner ${shortKey(SELLER)}\\n`))
  assert.match(text, /follows the owners above\./)
})

test('fills and a cross of one wallet in one pass make one message, oldest first', async (t) => {
  const r = store(t)
  r.follow('555', OWNER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const page = [sig(CROSS_SIG, CROSS_TIME), sig(SELL_SIG, SELL_TIME), sig(BUY_SIG, BUY.blockTime!)]
  const { rpc, reads } = fakeRpc([page])
  const s = scanWith(r, rpc)
  // The wallet is the cross's buyer; its seller is not followed, so one side is told.
  assert.deepEqual(await s.run(), { read: 3, fills: 3, sent: 1, behind: false })
  assert.deepEqual(reads(), [BUY_SIG, SELL_SIG, CROSS_SIG])
  const text = s.sent[0]!.text
  const at = (x: string) => text.indexOf(x)
  assert.ok(at('Filled:') > 0 && at('Filled:') < at('Sold:') && at('Sold:') < at('Crossed: bought'), text)
  assert.doesNotMatch(text, /Crossed: sold/)
  assert.ok(!text.includes(shortKey(SELLER)))
  assert.equal(r.alertCursor('program_signature:devnet'), CROSS_SIG)
})

test('a cross’s two messages hold only their own party, and a cross BELL does not list makes none', () => {
  const [c, ...rest] = tradesOf(CROSS)
  assert.equal(rest.length, 0)
  assert.equal(c!.side, 'cross')
  const cross = c as Cross
  const ctx = { cluster: 'devnet', listings: LISTINGS, multiplier: () => MULTIPLIER }
  const both = crossAlertEvents(cross, CROSS, ctx)!
  const told = {
    kind: 'cross',
    symbol: 'SPYx',
    amount: 200,
    quote: 'demo-USDC',
    shares: (25_738_931 / 1e8) * MULTIPLIER,
    minutesAfterBell: 7,
    signature: CROSS_SIG,
  }
  assert.deepEqual(both.buyer, { ...told, side: 'buy', buyer: OWNER, seller: '' })
  assert.deepEqual(both.seller, { ...told, side: 'sell', buyer: '', seller: SELLER })
  // Not in the event at all, so no wording can let it slip.
  assert.ok(!JSON.stringify(both.buyer).includes(SELLER))
  assert.ok(!JSON.stringify(both.seller).includes(OWNER))
  assert.deepEqual(alertEvents(cross, CROSS, ctx), [
    { owner: OWNER, event: both.buyer },
    { owner: SELLER, event: both.seller },
  ])
  // A fill is still one message, to its owner.
  const [buy] = fillsOf(BUY)
  assert.deepEqual(alertEvents(buy!, BUY, ctx), [{ owner: OWNER, event: alertEvent(buy!, BUY, ctx) }])

  // The listing pinned to another mint: not a BELL cross, as on the tape.
  const other = { ...ctx, listings: [{ symbol: 'SPYx', mint: CRANKER }] }
  assert.equal(crossAlertEvents(cross, CROSS, other), null)
  assert.deepEqual(alertEvents(cross, CROSS, other), [])
  // With no multiplier, no share count rather than a wrong one.
  const bare = crossAlertEvents(cross, CROSS, { ...ctx, multiplier: () => null })!
  assert.equal(bare.buyer.kind === 'cross' && bare.buyer.shares, null)
  assert.match(alertText([bare.seller], 'devnet'), /Crossed: sold SPYx for 200\.00 demo-USDC, at the pool's price/)
  // Decimals it cannot find are said, not guessed.
  const noBalances = structuredClone(CROSS)
  noBalances.meta!.preTokenBalances = []
  noBalances.meta!.postTokenBalances = []
  assert.throws(() => crossAlertEvents(cross, noBalances, ctx), /decimals unknown/)
})

test('a cross that cannot be stated is logged, and its followers get nothing rather than a guess', async (t) => {
  const r = store(t)
  r.follow('888', SELLER, 1)
  r.setAlertCursor('program_signature:devnet', OLD_HEAD)
  const unstated = structuredClone(CROSS)
  unstated.meta!.preTokenBalances = []
  unstated.meta!.postTokenBalances = []
  const { rpc } = fakeRpc([[sig(CROSS_SIG, CROSS_TIME)]], { [CROSS_SIG]: unstated })
  const s = scanWith(r, rpc)
  assert.deepEqual(await s.run(), { read: 1, fills: 0, sent: 0, behind: false })
  assert.ok(s.lines.some((l) => l.startsWith(`alerts: a cross in ${CROSS_SIG} could not be stated`)))
  assert.equal(r.seen(CROSS_SIG), true)
})
