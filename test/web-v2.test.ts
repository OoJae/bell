/**
 * The page for the program's second upgrade: the gate panel's new rows (the
 * circuit breaker, the second source, the band), the night switch, and a
 * cross on the receipts.
 *
 * The rule these tests hold is that the page says what the program would do,
 * in the program's order, and nothing more. Each row's refusal is compared
 * with `checkRefusal`, the chain layer's copy of `admit`'s step 4, rather
 * than with a list written here, so the panel and the client cannot drift
 * apart. And before any check exists, which is the devnet program today, the
 * new rows must refuse nothing: the live page keeps working across the
 * upgrade.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair, PublicKey, SystemProgram, type AccountInfo, type Connection } from '@solana/web3.js'
import { checkPda, ixOptInNight, ixOptOutNight, nightPda } from '../src/chain/client.ts'
import {
  accountDiscriminator,
  checkRefusal,
  errorName,
  MAX_MARK_STEP_BPS,
  MAX_NIGHT_GAP_BPS,
  MAX_SESSION_GAP_BPS,
  Mode,
  PROGRAM_ID,
  type SymbolCheck,
  type SymbolMark,
  type SymbolState,
  type TokenRisk,
} from '../src/chain/codec.ts'
import { ALLOWLIST } from '../src/config.ts'
import { HaltState } from '../src/policy/reconcile.ts'
import {
  bandText,
  checksLiveOf,
  clearsWhen,
  explain,
  fillSide,
  loadBoard,
  loadSymbol,
  statusOf,
  type GateRow,
  type SymbolView,
} from '../web/lib/bell.ts'
import { NIGHT_OPT_IN_RENT_SOL, optInNightTx, optOutNightTx, QUOTE_MINT, refusalFrom } from '../web/lib/queue.ts'

const listing = ALLOWLIST.find((l) => l.symbol === 'SPYx')!
const mint = new PublicKey(listing.mint)
/** About $334 a share at eight decimals, as in the sell tests. */
const RATE = (299_401n << 64n) / 1_000_000n
/** 1.0 as an f64's bits: the multiplier of a mint that has never rebased. */
const ONE = 0x3ff0000000000000n
const attestor = Keypair.generate().publicKey
const checker = Keypair.generate().publicKey
/** Read once: every age below is set well clear of a bound, so a second passing changes nothing. */
const NOW = Math.floor(Date.now() / 1000)

const state = (over: Partial<SymbolState> = {}): SymbolState => ({
  symbol: listing.symbol,
  mint,
  exchangeMic: 'ARCX',
  hoursMode: 0,
  halt: HaltState.None,
  openNow: true,
  nextChangeAt: BigInt(NOW + 3_600),
  observedAt: BigInt(NOW - 5),
  attestor,
  bump: 255,
  ...over,
})
const risk = (over: Partial<TokenRisk> = {}): TokenRisk => ({
  mint,
  paused: false,
  multiplierBits: ONE,
  pendingMultiplierBits: 0n,
  activatesAt: 0n,
  rebaseKind: 0,
  hook: null,
  permanentDelegate: null,
  verifiedAt: BigInt(NOW - 5),
  attestor,
  bump: 255,
  ...over,
})
const mark = (over: Partial<SymbolMark> = {}): SymbolMark => ({
  symbol: listing.symbol,
  mint,
  quoteMint: QUOTE_MINT,
  rateQ64: RATE,
  pxNum: 334_000_000n,
  pxExpo: -6,
  confBps: 10,
  source: 2,
  observedAt: BigInt(NOW - 10),
  bump: 255,
  ...over,
})
const check = (over: Partial<SymbolCheck> = {}): SymbolCheck => ({
  symbol: listing.symbol,
  mint,
  checker,
  openNow: true,
  refRateQ64: RATE,
  refPxNum: 334_000_000n,
  refPxExpo: -6,
  refAt: BigInt(NOW - 20),
  observedAt: BigInt(NOW - 15),
  bump: 255,
  ...over,
})

/** Nothing here reaches the chain: every account is handed in and the program is not asked. */
const noChain = {} as Connection

async function view(
  a: { state?: SymbolState; risk?: TokenRisk; mark?: SymbolMark | null; check?: SymbolCheck | null },
  checksLive?: boolean,
): Promise<SymbolView> {
  return loadSymbol(
    noChain,
    listing,
    null,
    Mode.Strict,
    { state: a.state ?? state(), risk: a.risk ?? risk(), mark: a.mark === undefined ? mark() : a.mark, check: a.check ?? null },
    false,
    checksLive,
  )
}

const row = (v: SymbolView, label: string): GateRow => {
  const found = v.gates.find((g) => g.label === label)
  assert.ok(found, `no "${label}" row`)
  return found
}
const BREAKER = 'circuit breaker clear'
const SECOND = 'second source agrees'
const BAND = 'within the band of Nasdaq'

// ------------------------------------------------------------ the gate panel

test('the panel keeps every existing row and adds the three new ones in the order the program asks', async () => {
  const v = await view({ check: check() })
  assert.deepEqual(
    v.gates.map((g) => g.label),
    [
      'attestation fresh',
      'not halted',
      'mint read fresh',
      'issuer has not paused the mint',
      'outside a rebase window',
      'pending change identified',
      'no transfer hook armed',
      'market open',
      'price fresh',
      BREAKER,
      'price precise enough',
      SECOND,
      BAND,
      'permanent delegate',
    ],
  )
  // The new rows are a fill's own questions, asked after the gate.
  for (const label of [BREAKER, SECOND, BAND]) assert.equal(row(v, label).fill, true)
  for (const g of v.gates.slice(0, 8)) assert.equal(g.fill, undefined, `${g.label} is a gate row`)
})

test('before any check exists the new rows say "not set up yet" and refuse nothing', async () => {
  // The devnet program today: no check anywhere, and no breaker on the mark.
  const v = await view({ check: null }, false)
  assert.equal(v.allowed, true)
  assert.equal(v.status, 'tradeable')
  assert.equal(v.checked, false)
  for (const label of [BREAKER, SECOND, BAND]) {
    const g = row(v, label)
    assert.equal(g.ok, 'unset', label)
    assert.equal(g.refuses, undefined, `${label} must not vote before the upgrade`)
    assert.match(g.detail, /^not set up yet/, label)
  }
  // The numbers it will hold to are the program's own.
  assert.match(row(v, BAND).detail, new RegExp(`${MAX_SESSION_GAP_BPS}bps .* ${MAX_NIGHT_GAP_BPS}bps at night`))
  assert.match(row(v, BREAKER).detail, new RegExp(`${MAX_MARK_STEP_BPS}bps a minute`))

  // One symbol on its own can say only whether it has a check; with none, the same.
  const alone = await view({ check: null })
  assert.equal(alone.allowed, true)
  assert.equal(row(alone, SECOND).ok, 'unset')
})

test('once checks exist, a symbol without one is refused as AccountNotInitialized', async () => {
  const v = await view({ check: null }, true)
  assert.equal(v.allowed, false)
  assert.equal(v.reason, 'AccountNotInitialized')
  assert.equal(v.status, 'unchecked')
  assert.match(row(v, SECOND).detail, /^not set up yet for this symbol/)
  assert.equal(clearsWhen(v), "the symbol's second check is opened on chain")
  // The band has nothing to measure, and says so without claiming the refusal.
  assert.equal(row(v, BAND).ok, false)
  assert.equal(row(v, BAND).refuses, undefined)
  // The breaker is live on this program, and the price is not held.
  assert.equal(row(v, BREAKER).ok, true)
})

test('a fresh check that agrees, with the price inside the band, leaves the verdict to the gate', async () => {
  const v = await view({ check: check(), mark: mark({ rateQ64: RATE + RATE / 250n }) })
  assert.equal(v.allowed, true)
  assert.equal(v.status, 'tradeable')
  assert.equal(row(v, SECOND).ok, true)
  assert.match(row(v, SECOND).detail, /^agrees the market is open/)
  assert.equal(row(v, BAND).ok, true)
  // More stock per dollar is a lower price: 40bps below the checker's sale.
  assert.match(row(v, BAND).detail, /40bps below the checker's last sale, \$334\.00 at .* ET; a fill needs it within 300bps/)
  assert.deepEqual(v.refGap, { bps: 40, bandBps: MAX_SESSION_GAP_BPS, within: true, night: false })
  assert.equal(v.nightReason, null, 'no night fill while the session is open')
})

test("each refusal from the check is the one the program's admit gives, in its order", async () => {
  const edge = (RATE / 10_000n) * BigInt(MAX_SESSION_GAP_BPS)
  const cases: [string, Partial<SymbolCheck>, bigint, string | null][] = [
    ['never pushed', { observedAt: 0n, refAt: 0n, refRateQ64: 0n }, RATE, 'CheckStale'],
    ['too old to be a view of now', { observedAt: BigInt(NOW - 200) }, RATE, 'CheckStale'],
    ['saying the market is shut in session', { openNow: false }, RATE, 'CheckerDisagrees'],
    ['a stale check that also disagrees reports as stale', { openNow: false, observedAt: BigInt(NOW - 200) }, RATE, 'CheckStale'],
    ['a last sale ten minutes old in session', { refAt: BigInt(NOW - 600) }, RATE, 'CheckStale'],
    ['no price yet', { refRateQ64: 0n }, RATE, 'CheckStale'],
    ['a price exactly at the band edge', {}, RATE + edge, null],
    ['a price one unit past the edge', {}, RATE + edge + 1n, 'MarkOffReference'],
    ['a price past the edge from above', {}, RATE - edge - 1n, 'MarkOffReference'],
  ]
  for (const [what, over, rate, want] of cases) {
    const c = check(over)
    const v = await view({ check: c, mark: mark({ rateQ64: rate }) })
    const program = checkRefusal({ check: c, markRateQ64: rate, night: false, now: BigInt(NOW) })
    assert.equal(program, want, `${what}: the chain layer's own answer`)
    assert.equal(v.reason, want, what)
    assert.equal(v.allowed, want === null, what)
    if (want) {
      assert.equal(v.status, statusOf({ allowed: false, reason: want, halt: HaltState.None, listing }), what)
      assert.notEqual(v.status, 'refused', `${what} has a badge of its own`)
      assert.ok(!explain(want).startsWith('Refused:'), `${what} is explained in words`)
    }
  }
})

test('a price outside the band reads as over it, and one at the edge as within it', async () => {
  const edge = (RATE / 10_000n) * BigInt(MAX_SESSION_GAP_BPS)
  const at = await view({ check: check(), mark: mark({ rateQ64: RATE - edge }) })
  assert.equal(at.refGap?.within, true)
  assert.ok(at.refGap!.bps <= MAX_SESSION_GAP_BPS)
  assert.match(row(at, BAND).detail, /above the checker's last sale/)
  // One raw unit past the program's bound is refused, and a hair over 300bps
  // is never printed as 300 beside that refusal.
  const past = await view({ check: check(), mark: mark({ rateQ64: RATE - edge - 1n }) })
  assert.equal(past.refGap?.within, false)
  assert.match(row(past, BAND).detail, /^the pool's price is just over 300bps above .*: outside the 300bps a fill allows/)
  const wide = await view({ check: check(), mark: mark({ rateQ64: RATE - (RATE / 10_000n) * 420n }) })
  assert.equal(wide.refGap?.bps, 420)
  assert.match(row(wide, BAND).detail, /^the pool's price is 420bps above/)
  const level = await view({ check: check(), mark: mark({ rateQ64: RATE }) })
  assert.match(row(level, BAND).detail, /^the pool's price is level with the checker's last sale/)
  assert.equal(past.status, 'offband')
  assert.equal(clearsWhen(past), "the pool's price is back inside the band")
})

test('the gate still reports first: a halt over a stale check is a halt', async () => {
  const v = await view({ state: state({ halt: HaltState.Luld }), check: check({ observedAt: BigInt(NOW - 500) }) })
  assert.equal(v.reason, 'MarketClosed')
  assert.equal(v.status, 'halted')
  assert.equal(row(v, SECOND).ok, false, 'the row still shows what it saw')
})

// --------------------------------------------------------------- the breaker

test('a price held by the breaker refuses as MarkPaused, after the gate and before the check', async () => {
  const held = mark({ confBps: 0xffff })
  const v = await view({ mark: held, check: check({ observedAt: BigInt(NOW - 500) }) })
  assert.equal(v.reason, 'MarkPaused', 'before CheckStale, as admit asks')
  assert.equal(v.status, 'breaker')
  assert.equal(v.markHeld, true)
  assert.equal(v.priceUsd, null, 'the held price is not shown as the price now')
  const b = row(v, BREAKER)
  assert.equal(b.ok, false)
  assert.match(b.detail, /^price paused by the circuit breaker/)
  assert.match(b.detail, /after .* ET any new price does/)
  // The marker is not a precision anyone attested.
  const p = row(v, 'price precise enough')
  assert.equal(p.ok, null)
  assert.doesNotMatch(p.detail, /65535/)
  assert.equal(clearsWhen(v), 'the circuit breaker releases the price')
  assert.match(explain('MarkPaused'), new RegExp(`${MAX_MARK_STEP_BPS}bps a minute`))

  // A held price shows as held even before any check is seen: only a program
  // with the breaker can write the marker with a time on it.
  const early = await view({ mark: held, check: null }, false)
  assert.equal(early.reason, 'MarkPaused')

  // Under a halt, the halt is the reason.
  const halted = await view({ mark: held, state: state({ halt: HaltState.NewsPending }), check: check() })
  assert.equal(halted.reason, 'MarketClosed')
})

test("open_mark's unpriced mark is not a held one", async () => {
  // Same marker, no time: nobody has priced it yet, which MarkStale answers.
  const v = await view({ mark: mark({ confBps: 0xffff, observedAt: 0n, rateQ64: 0n, pxNum: 0n }), check: check() })
  assert.equal(v.markHeld, false)
  assert.equal(row(v, BREAKER).ok, true)
  assert.notEqual(v.reason, 'MarkPaused')
  assert.equal(row(v, BAND).refuses, undefined, 'no price to measure, so the band claims nothing')
})

test("the program's own answer for the gate, then the fill's rows", async () => {
  const sim = (err: unknown) =>
    ({ simulateTransaction: async () => ({ value: { err, logs: [] } }) }) as unknown as Connection
  const accounts = { state: state(), risk: risk(), mark: mark({ confBps: 0xffff }), check: check() }
  const open = await loadSymbol(sim(null), listing, null, Mode.Strict, accounts, true, true)
  assert.equal(open.allowed, false, 'the gate is open and the price is held: nothing fills')
  assert.equal(open.reason, 'MarkPaused')
  const shut = await loadSymbol(sim({ InstructionError: [0, { Custom: 6000 }] }), listing, null, Mode.Strict, accounts, true, true)
  assert.equal(shut.reason, errorName(6000), "the program's refusal stands")
  const clear = await loadSymbol(sim(null), listing, null, Mode.Strict, { ...accounts, mark: mark() }, true, true)
  assert.equal(clear.allowed, true)
})

// ------------------------------------------------------------------ at night

test('at night the check and the band are judged for a night fill, and the verdict stays the session one', async () => {
  const night = state({ openNow: false })
  const shut = check({ openNow: false, refAt: BigInt(NOW - 3_600) })
  // 120bps off: outside nothing at night, whose band is 150.
  const inside = await view({ state: night, check: shut, mark: mark({ rateQ64: RATE + (RATE / 10_000n) * 120n }) })
  assert.equal(inside.reason, 'MarketClosed', 'an order that has not opted in still waits for the bell')
  assert.equal(inside.status, 'closed')
  assert.equal(row(inside, SECOND).ok, true)
  assert.match(row(inside, SECOND).detail, /^agrees the market is shut/)
  assert.equal(row(inside, BAND).ok, true)
  assert.match(row(inside, BAND).detail, /a fill at night needs it within 150bps/)
  assert.equal(inside.refGap?.night, true)
  assert.equal(inside.refGap?.bandBps, MAX_NIGHT_GAP_BPS)
  assert.equal(inside.nightReason, null, 'an opted-in order may fill now')

  const cases: [string, Partial<SymbolState>, Partial<SymbolCheck>, bigint, string][] = [
    ['200bps off', {}, {}, RATE + (RATE / 10_000n) * 200n, 'MarkOffReference'],
    ['the checker saying open', {}, { openNow: true }, RATE, 'CheckerDisagrees'],
    ['a close thirteen hours old', {}, { refAt: BigInt(NOW - 13 * 3_600) }, RATE, 'CheckStale'],
    ['a halt', { halt: HaltState.Luld }, {}, RATE, 'MarketClosed'],
    ['a stale attestation', { observedAt: BigInt(NOW - 600) }, {}, RATE, 'StateStale'],
  ]
  for (const [what, s, c, rate, want] of cases) {
    const v = await view({ state: state({ openNow: false, ...s }), check: check({ openNow: false, refAt: BigInt(NOW - 3_600), ...c }), mark: mark({ rateQ64: rate }) })
    assert.equal(v.nightReason, want, what)
  }
  // "May fill now" is a stronger claim than the board's verdict, so a price
  // too old or too wide for an order stops it too, as the program would.
  const wide = await view({ state: night, check: shut, mark: mark({ confBps: 200 }) })
  assert.equal(wide.nightReason, 'MarkTooWide')
  const old = await view({ state: night, check: shut, mark: mark({ observedAt: BigInt(NOW - 300) }) })
  assert.equal(old.nightReason, 'MarkStale')
  const held = await view({ state: night, check: shut, mark: mark({ confBps: 0xffff }) })
  assert.equal(held.nightReason, 'MarkPaused')
  const paused = await view({ state: night, check: shut, risk: risk({ paused: true }) })
  assert.equal(paused.nightReason, 'IssuerPaused', 'a paused mint still refuses a night fill')
  const rebase = await view({ state: night, check: shut, risk: risk({ activatesAt: BigInt(NOW + 60) }) })
  assert.equal(rebase.nightReason, 'RebasePending', 'so does a dividend window')
})

// --------------------------------------------------------------- the words

test('every new refusal has a badge, a condition to clear and a sentence', () => {
  const statuses: Record<string, string> = {
    MarkPaused: 'breaker',
    CheckStale: 'unchecked',
    AccountNotInitialized: 'unchecked',
    CheckerDisagrees: 'disputed',
    MarkOffReference: 'offband',
  }
  for (const [reason, status] of Object.entries(statuses)) {
    const s = statusOf({ allowed: false, reason, halt: HaltState.None, listing })
    assert.equal(s, status, reason)
    assert.notEqual(clearsWhen({ reason, status: s }), 'the gate clears', `${reason} says what it waits for`)
  }
  // The program's names for 6027-6033 and Anchor's 3005 and 3012.
  const names = [6027, 6028, 6029, 6030, 6031, 6032, 6033, 3005, 3012].map(errorName)
  assert.deepEqual(names, [
    'MarkPaused',
    'NotAuthority',
    'NotChecker',
    'CheckStale',
    'CheckerDisagrees',
    'MarkOffReference',
    'SelfCross',
    'AccountNotEnoughKeys',
    'AccountNotInitialized',
  ])
  for (const n of names) {
    const text = explain(n)
    assert.ok(text && !text.startsWith('Refused:'), `${n} is said in words`)
  }
  assert.match(explain('MarkOffReference'), /300bps in session, 150bps at night/)
  // CheckStale is also a last sale too old for the fill, which is what a
  // night fill meets over a weekend while the checker still reports every
  // minute, so the words cover the sale's age and not only the checker's.
  assert.match(explain('CheckStale'), /last 2 min/)
  assert.match(explain('CheckStale'), /5 min in session, 12h at night/)
  // Seen in a wallet's error, each arrives by its number.
  assert.equal(refusalFrom(new Error('custom program error: 0x178b')), 'MarkPaused')
  assert.equal(refusalFrom(new Error('custom program error: 0x1791')), 'SelfCross')
  assert.equal(refusalFrom(new Error('custom program error: 0xbbd')), 'AccountNotEnoughKeys')
  // 3012 keeps the meaning the cancel path gives it: the account is gone.
  assert.equal(refusalFrom(new Error('custom program error: 0xbc4')), 'AlreadyClosed')
  assert.equal(bandText(MAX_NIGHT_GAP_BPS), '150bps (1.5%)')
})

// -------------------------------------------------------------- night switch

test('the night switch sends exactly opt_in_night or opt_out_night, signed by the owner alone', () => {
  const owner = Keypair.generate().publicKey
  const on = optInNightTx(owner)
  assert.equal(on.instructions.length, 1, 'one instruction: nothing else rides along')
  const [ix] = on.instructions
  const want = ixOptInNight(owner)
  assert.ok(ix!.programId.equals(PROGRAM_ID))
  assert.ok(ix!.data.equals(want.data))
  assert.deepEqual(
    ix!.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [owner.toBase58(), true, true],
      [nightPda(owner).toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
    ],
  )
  const off = optOutNightTx(owner)
  assert.equal(off.instructions.length, 1)
  assert.ok(off.instructions[0]!.data.equals(ixOptOutNight(owner).data))
  assert.deepEqual(
    off.instructions[0]!.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [owner.toBase58(), true, true],
      [nightPda(owner).toBase58(), false, true],
    ],
  )
  // 65 bytes of account at the rent-exempt rate: (128 + 65) × 6,960 lamports.
  assert.equal(NIGHT_OPT_IN_RENT_SOL, ((128 + 65) * 6_960) / 1e9)
})

// ------------------------------------------------------- the board, one read

/** A NightOptIn's bytes: discriminator, owner, created_at, bump, reserved. */
function nightBytes(owner: PublicKey): Buffer {
  const b = Buffer.alloc(65)
  accountDiscriminator('NightOptIn').copy(b, 0)
  owner.toBuffer().copy(b, 8)
  new DataView(b.buffer, b.byteOffset).setBigInt64(40, BigInt(NOW - 60), true)
  b[48] = 254
  return b
}

/** A SymbolCheck's bytes, freshly opened: nothing pushed yet. */
function checkBytes(symbol: string, forMint: PublicKey): Buffer {
  const b = Buffer.alloc(162)
  accountDiscriminator('SymbolCheck').copy(b, 0)
  Buffer.from(symbol.padEnd(12, '\0')).copy(b, 8)
  forMint.toBuffer().copy(b, 20)
  checker.toBuffer().copy(b, 52)
  b[129] = 253
  return b
}

const info = (owner: PublicKey, data: Buffer, lamports = 1_000_000): AccountInfo<Buffer> => ({
  owner,
  data,
  lamports,
  executable: false,
  rentEpoch: 0,
})

function fakeChain(accounts: Map<string, AccountInfo<Buffer>>) {
  const calls: PublicKey[][] = []
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      calls.push(keys)
      return keys.map((k) => accounts.get(k.toBase58()) ?? null)
    },
  } as unknown as Connection
  return { conn, calls }
}

test("the board reads the wallet's night opt-in in the same request, as the program would count it", async () => {
  const wallet = Keypair.generate().publicKey
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [wallet.toBase58(), info(SystemProgram.programId, Buffer.alloc(0), 2_000_000_000)],
    [nightPda(wallet).toBase58(), info(PROGRAM_ID, nightBytes(wallet))],
  ])
  const { conn, calls } = fakeChain(accounts)
  const board = await loadBoard(conn, QUOTE_MINT, undefined, wallet)
  assert.equal(calls.length, 1, 'one round trip')
  assert.equal(calls[0]!.length, ALLOWLIST.length * 4 + 2 + ALLOWLIST.length * 2 + 1)
  assert.ok(calls[0]!.at(-1)!.equals(nightPda(wallet)), "the opt-in's address rides last")
  assert.ok(board.wallet?.night?.owner.equals(wallet))
  assert.equal(board.wallet?.sol, 2)
  // Unregistered everywhere here, so nothing is checked and nothing is live.
  assert.ok(board.views.every((v) => !v.checked))

  // A stranger's opt-in at this address, or one the system program owns
  // (a closed one), is not this wallet's consent.
  for (const [owner, data] of [
    [PROGRAM_ID, nightBytes(Keypair.generate().publicKey)],
    [SystemProgram.programId, nightBytes(wallet)],
  ] as const) {
    accounts.set(nightPda(wallet).toBase58(), info(owner, data))
    const b = await loadBoard(fakeChain(accounts).conn, QUOTE_MINT, undefined, wallet)
    assert.equal(b.wallet?.night, null)
  }
  accounts.delete(nightPda(wallet).toBase58())
  assert.equal((await loadBoard(fakeChain(accounts).conn, QUOTE_MINT, undefined, wallet)).wallet?.night, null)
})

test('one check anywhere on the board means the program checks every symbol', async () => {
  const [first, second] = ALLOWLIST
  const accounts = new Map([[checkPda(first!.symbol).toBase58(), info(PROGRAM_ID, checkBytes(first!.symbol, new PublicKey(first!.mint)))]])
  const { conn } = fakeChain(accounts)
  const board = await loadBoard(conn, QUOTE_MINT)
  assert.equal(board.views.find((v) => v.listing.symbol === first!.symbol)?.checked, true)
  assert.equal(board.views.find((v) => v.listing.symbol === second!.symbol)?.checked, false)
  assert.equal(checksLiveOf(new Map([['A', { check: null }]])), false)
  assert.equal(checksLiveOf(new Map([['A', { check: null }], ['B', { check: {} as SymbolCheck }]])), true)
})

// ------------------------------------------------------------------ receipts

test("a cross is on the receipts as the side the wallet was named on", () => {
  const me = Keypair.generate().publicKey.toBase58()
  const them = Keypair.generate().publicKey.toBase58()
  assert.equal(fillSide({ direction: 'cross', seller: me }, me), 'sold')
  assert.equal(fillSide({ direction: 'cross', seller: them }, me), 'bought')
  // As the tape route returns it today, with both parties on the row, and as
  // `rowsFor` returns it, with only the asker's side.
  assert.equal(fillSide({ direction: 'cross', seller: undefined }, me), 'bought')
  assert.equal(fillSide({ direction: 'buy' }, me), 'bought')
  assert.equal(fillSide({ direction: 'sell', seller: me }, me), 'sold')
})
