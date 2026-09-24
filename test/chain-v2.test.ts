/**
 * The chain layer for the program's second upgrade: the circuit breaker, the
 * checker, night fills and the opening cross.
 *
 * Every instruction here is checked against what `idl.json` implies rather
 * than against a list written for the test: the arguments are re-encoded from
 * the IDL's own argument list, each account's flags come from the IDL, and each
 * account with seeds in the IDL is re-derived from those seeds. So a builder
 * that drifts from the program in order, width, flag or address fails here.
 * The accounts and events are decoded from bytes laid out, field by field,
 * from the IDL's type definitions, which the program's state.rs generates.
 *
 * The browser's Buffer polyfill has no BigInt methods (see
 * portability.test.ts), and all of this also runs on the page, so they are
 * removed before anything is imported. Node gives each test file its own
 * process, which keeps that here.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

for (const m of ['writeBigUInt64LE', 'readBigUInt64LE', 'writeBigInt64LE', 'readBigInt64LE'] as const) {
  Object.defineProperty(Buffer.prototype, m, {
    configurable: true,
    value() {
      throw new TypeError(`${m} is not a function — absent from the browser Buffer polyfill`)
    },
  })
}

const { PublicKey, SystemProgram } = await import('@solana/web3.js')
type PublicKey = InstanceType<typeof PublicKey>
type TransactionInstruction = import('@solana/web3.js').TransactionInstruction
const idl = (await import('../src/chain/idl.json', { with: { type: 'json' } })).default
const codec = await import('../src/chain/codec.ts')
const client = await import('../src/chain/client.ts')
const fills = await import('../src/chain/fills.ts')
const tape = await import('../web/lib/tape.ts')
const notify = await import('../src/notify.ts')
const { symbolSeed } = await import('../src/config.ts')
type BellOrder = import('../src/chain/codec.ts').BellOrder
type RpcTransaction = import('../src/chain/fills.ts').RpcTransaction
type RowContext = import('../web/lib/tape.ts').RowContext
type Listing = import('../src/listings.ts').Listing

// ------------------------------------------------------------ the IDL, read

type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } }
interface IdlField { name: string; type: IdlType }
interface IdlSeed { kind: 'const' | 'arg' | 'account'; value?: number[]; path?: string; account?: string }
interface IdlAccount { name: string; signer?: boolean; writable?: boolean; address?: string; pda?: { seeds: IdlSeed[] } }
interface IdlInstruction { name: string; discriminator: number[]; args: IdlField[]; accounts: IdlAccount[] }

const ixIdl = (name: string): IdlInstruction => {
  const found = (idl.instructions as unknown as IdlInstruction[]).find((i) => i.name === name)
  assert.ok(found, `${name} missing from the IDL`)
  return found
}
const typeIdl = (name: string) => {
  const found = (idl.types as unknown as { name: string; type: { kind: string; fields?: IdlField[]; variants?: { name: string }[] } }[]).find(
    (t) => t.name === name,
  )
  assert.ok(found, `type ${name} missing from the IDL`)
  return found.type
}
const constIdl = (name: string): string => {
  const found = idl.constants.find((c) => c.name === name)
  assert.ok(found, `constant ${name} missing from the IDL`)
  return found.value
}
const seedIdl = (name: string) => Uint8Array.from(JSON.parse(constIdl(name)) as number[])
const discIdl = (kind: 'accounts' | 'events', name: string) => {
  const found = (idl[kind] as { name: string; discriminator: number[] }[]).find((x) => x.name === name)
  assert.ok(found, `${name} missing from the IDL ${kind}`)
  return Uint8Array.from(found.discriminator)
}
const sha8 = (preimage: string) => [...createHash('sha256').update(preimage).digest().subarray(0, 8)]

/** Little-endian two's complement, by shifting: no Buffer BigInt method, and no DataView to agree with the code under test. */
const le = (v: bigint, bytes: number, signed = false): number[] => {
  let x = signed && v < 0n ? v + (1n << BigInt(8 * bytes)) : v
  const out: number[] = []
  for (let i = 0; i < bytes; i++) {
    out.push(Number(x & 0xffn))
    x >>= 8n
  }
  return out
}

/** Borsh for the fixed-width types the IDL uses, driven by the IDL's own type names. */
function borsh(type: IdlType, value: unknown): number[] {
  if (typeof type === 'string') {
    switch (type) {
      case 'u8': return [Number(value)]
      case 'bool': return [value ? 1 : 0]
      case 'u16': return le(BigInt(value as number), 2)
      case 'i32': return le(BigInt(value as number), 4, true)
      case 'u64': return le(value as bigint, 8)
      case 'i64': return le(value as bigint, 8, true)
      case 'u128': return le(value as bigint, 16)
      case 'pubkey': return [...(value as PublicKey).toBytes()]
    }
    throw new Error(`no test encoding for ${type}`)
  }
  if ('array' in type) {
    const [inner, n] = type.array
    assert.equal(inner, 'u8')
    const bytes = value as Uint8Array
    assert.equal(bytes.length, n)
    return [...bytes]
  }
  // An enum with unit variants: its discriminant, one byte.
  const t = typeIdl(type.defined.name)
  assert.equal(t.kind, 'enum')
  return [Number(value)]
}

/** A struct's bytes, discriminator first, each field from `values` in the IDL's order. */
function structBytes(disc: Uint8Array, typeName: string, values: Record<string, unknown>): Uint8Array {
  const fields = typeIdl(typeName).fields!
  const out = [...disc]
  for (const f of fields) {
    assert.ok(f.name in values, `${typeName}.${f.name} has no test value`)
    out.push(...borsh(f.type, values[f.name]))
  }
  return Uint8Array.from(out)
}

/** The instruction data the IDL implies: discriminator, then each argument in order. */
function idlData(name: string, args: Record<string, unknown>): number[] {
  const ix = ixIdl(name)
  const out = [...ix.discriminator]
  for (const a of ix.args) {
    assert.ok(a.name in args, `${name}(${a.name}) has no test value`)
    out.push(...borsh(a.type, args[a.name]))
  }
  return out
}

const nonceBytes = (n: bigint) => Uint8Array.from(le(n, 8))
const PROGRAM = new PublicKey(idl.address)

/**
 * The accounts the IDL implies for one instruction: its flags, and its address
 * from the IDL's seeds where it gives them, from a fixed `address` where it
 * gives one, and otherwise from `given`.
 */
function idlMetas(
  name: string,
  ctx: {
    args?: Record<string, unknown>
    orders?: Record<string, BellOrder>
    given?: Record<string, PublicKey>
    writableByChoice?: string[]
  },
) {
  const resolved: Record<string, PublicKey> = {}
  const seedBytes = (s: IdlSeed): Uint8Array => {
    if (s.kind === 'const') return Uint8Array.from(s.value!)
    if (s.kind === 'arg') return ctx.args![s.path!] as Uint8Array
    const [account, field] = s.path!.split('.')
    if (!field) return resolved[account!]!.toBytes()
    const o = ctx.orders?.[account!]
    assert.ok(o, `${name}: no order given for ${account}`)
    switch (field) {
      case 'owner': return o.owner.toBytes()
      case 'mint': return o.mint.toBytes()
      case 'symbol': return symbolSeed(o.symbol)
      case 'nonce': return nonceBytes(o.nonce)
    }
    throw new Error(`${name}: no seed for ${s.path}`)
  }
  return ixIdl(name).accounts.map((a) => {
    let key: PublicKey
    if (a.address) key = new PublicKey(a.address)
    else if (a.pda) key = PublicKey.findProgramAddressSync(a.pda.seeds.map(seedBytes), PROGRAM)[0]
    else {
      assert.ok(ctx.given?.[a.name], `${name}.${a.name}: the IDL gives no address, and the test none`)
      key = ctx.given![a.name]!
    }
    resolved[a.name] = key
    return {
      name: a.name,
      pubkey: key,
      isSigner: Boolean(a.signer),
      isWritable: Boolean(a.writable) || (ctx.writableByChoice ?? []).includes(a.name),
    }
  })
}

/** The instruction, byte for byte and account for account, as the IDL says it must be. */
function assertIx(ix: TransactionInstruction, name: string, data: number[], metas: ReturnType<typeof idlMetas>) {
  assert.ok(ix.programId.equals(PROGRAM), `${name}: program`)
  assert.deepEqual([...ix.data], data, `${name}: data`)
  assert.equal(ix.keys.length, metas.length, `${name}: account count`)
  metas.forEach((m, i) => {
    const got = ix.keys[i]!
    assert.equal(got.pubkey.toBase58(), m.pubkey.toBase58(), `${name}.${m.name} address`)
    assert.equal(got.isSigner, m.isSigner, `${name}.${m.name} signer`)
    assert.equal(got.isWritable, m.isWritable, `${name}.${m.name} writable`)
  })
}

// ------------------------------------------------------------------ fixtures

const key = (b: number) => new PublicKey(new Uint8Array(32).fill(b))
const BUYER = key(11)
const SELLER = key(12)
const CRANKER = key(13)
const CHECKER = key(14)
const MINT = new PublicKey('AFrGCsmPc3WeUAEM3jw8Ec3M6BrKrJGDQeX2g1Ctrrwx') // the SPYx mirror
const QUOTE = new PublicKey('8QhSxevJerJq8khpNsfW69bUPvcBjMRTXPKrxYQAtAaX') // demo-USDC
const SHARE = 100_000_000n
const DOLLAR = 1_000_000n
/** test_cross.rs's AAPLx mark: 299,401 stock raw per 1,000,000 quote raw. */
const AAPL_RATE = (299_401n << 64n) / 1_000_000n

const order = (owner: PublicKey, over: Partial<BellOrder> = {}): BellOrder => ({
  owner,
  symbol: 'SPYx',
  mint: MINT,
  quoteMint: QUOTE,
  payerIn: key(owner.toBytes()[0]! + 100),
  payeeOut: key(owner.toBytes()[0]! + 150),
  amountIn: 200n * DOLLAR,
  filledIn: 0n,
  minFillIn: 1n,
  expectedMultiplierBits: 4_607_208_154_891_593_168n,
  maxSlipBps: 30,
  maxConfBps: 50,
  floorRateQ64: 0n,
  notBefore: 0n,
  expiresAt: 1_790_600_000n,
  nonce: 1_790_000_000_123n,
  createdAt: 1_790_000_000n,
  bump: 254,
  authBump: 253,
  ...over,
})
const BUY = order(BUYER)
const SELL = order(SELLER, { amountIn: SHARE, nonce: 77n })

// ---------------------------------------------------------------- the IDL copy

test('the IDL copy carries the discriminators Anchor derives for everything this upgrade added', () => {
  for (const name of ['open_check', 'push_check', 'opt_in_night', 'opt_out_night', 'cross_orders', 'fill_order', 'fill_sell_order', 'push_mark']) {
    assert.deepEqual(ixIdl(name).discriminator, sha8(`global:${name}`), name)
  }
  for (const name of ['SymbolCheck', 'NightOptIn']) {
    assert.deepEqual([...codec.accountDiscriminator(name)], sha8(`account:${name}`), name)
  }
  for (const name of ['MarkTripped', 'OrdersCrossed']) assert.deepEqual([...discIdl('events', name)], sha8(`event:${name}`), name)
})

test('the new refusals and the framework errors a stale client meets have names', () => {
  const want: [number, string][] = [
    [6027, 'MarkPaused'],
    [6028, 'NotAuthority'],
    [6029, 'NotChecker'],
    [6030, 'CheckStale'],
    [6031, 'CheckerDisagrees'],
    [6032, 'MarkOffReference'],
    [6033, 'SelfCross'],
    [101, 'InstructionFallbackNotFound'],
    [2006, 'ConstraintSeeds'],
    [2012, 'ConstraintAddress'],
    [3005, 'AccountNotEnoughKeys'],
    [3012, 'AccountNotInitialized'],
  ]
  for (const [code, name] of want) assert.equal(codec.errorName(code), name, String(code))
  // The IDL's own numbering, not only this file's.
  for (const [code, name] of want.filter(([c]) => c >= 6000)) {
    assert.equal(idl.errors.find((e) => e.code === code)?.name, name)
  }
  // Nothing that was named before changed its name.
  assert.equal(codec.errorName(6000), idl.errors.find((e) => e.code === 6000)!.name)
  assert.equal(codec.errorName(4), 'OwnerRevoked')
  assert.equal(codec.errorName(4242), 'custom 4242')
})

test('the new bounds are read from the IDL, and are the ones the program was built with', () => {
  const want = {
    MAX_MARK_STEP_BPS: 500,
    MAX_MARK_STEP_AGE_SECONDS: 300,
    MAX_CHECK_AGE_SECONDS: 120,
    MAX_SESSION_REF_AGE_SECONDS: 300,
    MAX_NIGHT_REF_AGE_SECONDS: 43_200,
    MAX_SESSION_GAP_BPS: 300,
    MAX_NIGHT_GAP_BPS: 150,
  } as const
  for (const [name, value] of Object.entries(want)) {
    assert.equal(codec.LIMITS[name], value, name)
    assert.equal(Number(constIdl(name)), value, name)
    assert.equal((codec as unknown as Record<string, number>)[name], value, `${name} exported`)
  }
})

// ---------------------------------------------------------------- instructions

test('the check and the night opt-in live where the IDL’s seeds put them', () => {
  assert.equal(Buffer.from(seedIdl('CHECK_SEED')).toString(), 'check')
  assert.equal(Buffer.from(seedIdl('NIGHT_SEED')).toString(), 'night')
  assert.equal(
    client.checkPda('SPYx').toBase58(),
    PublicKey.findProgramAddressSync([seedIdl('CHECK_SEED'), symbolSeed('SPYx')], PROGRAM)[0].toBase58(),
  )
  assert.equal(
    client.nightPda(BUYER).toBase58(),
    PublicKey.findProgramAddressSync([seedIdl('NIGHT_SEED'), BUYER.toBytes()], PROGRAM)[0].toBase58(),
  )
  assert.notEqual(client.nightPda(BUYER).toBase58(), client.nightPda(SELLER).toBase58())
  // The loader's own derivation of this program's ProgramData account.
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
  assert.equal(client.programDataPda().toBase58(), PublicKey.findProgramAddressSync([PROGRAM.toBytes()], loader)[0].toBase58())
})

test('a fill names seventeen accounts: the fifteen it always did, then the check and the owner’s night address', () => {
  const fillerIn = key(21)
  const fillerOut = key(22)
  for (const [name, build] of [
    ['fill_order', client.ixFillOrder],
    ['fill_sell_order', client.ixFillSellOrder],
  ] as const) {
    const o = name === 'fill_order' ? BUY : SELL
    const ix = build({ filler: CRANKER, order: o, fillerIn, fillerOut, amountInLeg: 2n ** 64n - 1n, amountOut: 123n })
    const metas = idlMetas(name, {
      orders: { order: o },
      given: {
        filler: CRANKER,
        owner: o.owner,
        payer_in: o.payerIn,
        payee_out: o.payeeOut,
        filler_in: fillerIn,
        filler_out: fillerOut,
        quote_mint: o.quoteMint,
        stock_mint: o.mint,
        quote_token_program: client.TOKEN_PROGRAM,
        stock_token_program: client.TOKEN_2022,
        // The IDL carries no seeds for `night`: the program reads it by owner
        // and discriminator, and the client passes the owner's address.
        night: PublicKey.findProgramAddressSync([seedIdl('NIGHT_SEED'), o.owner.toBytes()], PROGRAM)[0],
      },
      // The filler signs and pays the fee, so it is writable whatever the flag says; see sell.test.ts.
      writableByChoice: ['filler'],
    })
    assertIx(ix, name, idlData(name, { amount_in_leg: 2n ** 64n - 1n, amount_out: 123n }), metas)
    assert.equal(ix.keys.length, 17)
    assert.deepEqual(metas.slice(15).map((m) => m.name), ['check', 'night'])
    assert.ok(!ix.keys[15]!.isWritable && !ix.keys[16]!.isWritable, 'both are read, never written')
  }
})

test('cross_orders names the IDL’s nineteen accounts, every one found from the two orders', () => {
  const ix = client.ixCrossOrders({ cranker: CRANKER, buy: BUY, sell: SELL })
  const metas = idlMetas('cross_orders', {
    orders: { buy: BUY, sell: SELL },
    given: {
      cranker: CRANKER,
      buyer: BUY.owner,
      seller: SELL.owner,
      buyer_quote: BUY.payerIn,
      buyer_stock: BUY.payeeOut,
      seller_stock: SELL.payerIn,
      seller_quote: SELL.payeeOut,
      quote_mint: BUY.quoteMint,
      stock_mint: BUY.mint,
      quote_token_program: client.TOKEN_PROGRAM,
      stock_token_program: client.TOKEN_2022,
    },
  })
  assertIx(ix, 'cross_orders', idlData('cross_orders', {}), metas)
  assert.equal(ix.keys.length, 19)
  // The sell's own order address and delegate authority, not the buy's.
  const at = (n: string) => ix.keys[metas.findIndex((m) => m.name === n)]!.pubkey.toBase58()
  assert.equal(at('sell'), client.sellOrderPda(SELLER, SELL.nonce).toBase58())
  assert.equal(at('sell_auth'), client.authPda(SELLER).toBase58())
  assert.equal(at('buy_auth'), client.authPda(BUYER).toBase58())
  assert.equal(at('check'), client.checkPda('SPYx').toBase58())
  // Token programs can be overridden, as a fill's can.
  const plain = client.ixCrossOrders({ cranker: CRANKER, buy: BUY, sell: SELL, stockTokenProgram: client.TOKEN_PROGRAM })
  assert.equal(plain.keys[18]!.pubkey.toBase58(), client.TOKEN_PROGRAM.toBase58())
})

test('open_check, push_check and the night opt-in encode their IDL arguments and accounts', () => {
  const authority = key(31)
  const payer = key(32)
  const symbol = symbolSeed('SPYx')

  const open = client.ixOpenCheck({ payer, authority, symbol: 'SPYx', checker: CHECKER })
  assertIx(
    open,
    'open_check',
    idlData('open_check', { symbol, checker: CHECKER }),
    idlMetas('open_check', { args: { symbol }, given: { payer, authority, program_data: client.programDataPda() } }),
  )

  // The widest values each field can hold, and negative ones where it is signed.
  const push = {
    checker: CHECKER,
    symbol: 'SPYx',
    openNow: true,
    refRateQ64: 2n ** 128n - 1n,
    refPxNum: 2n ** 64n - 1n,
    refPxExpo: -8,
    refAt: -5n,
    observedAt: 1_790_000_000n,
  }
  assertIx(
    client.ixPushCheck(push),
    'push_check',
    idlData('push_check', {
      symbol,
      open_now: true,
      ref_rate_q64: push.refRateQ64,
      ref_px_num: push.refPxNum,
      ref_px_expo: push.refPxExpo,
      ref_at: push.refAt,
      observed_at: push.observedAt,
    }),
    idlMetas('push_check', { args: { symbol }, given: { checker: CHECKER } }),
  )
  assert.equal(codec.encodePushCheck({ ...push, symbol, openNow: false })[20], 0, 'open_now false is a zero byte')

  for (const name of ['opt_in_night', 'opt_out_night'] as const) {
    const ix = name === 'opt_in_night' ? client.ixOptInNight(BUYER) : client.ixOptOutNight(BUYER)
    assertIx(ix, name, idlData(name, {}), idlMetas(name, { given: { owner: BUYER } }))
    assert.equal(ix.keys[1]!.pubkey.toBase58(), client.nightPda(BUYER).toBase58())
  }
})

// -------------------------------------------------------------------- accounts

const CHECK_VALUES = {
  symbol: symbolSeed('SPYx'),
  mint: MINT,
  checker: CHECKER,
  open_now: true,
  ref_rate_q64: 2n ** 127n + 5n,
  ref_px_num: 772_617_876n,
  ref_px_expo: -6,
  ref_at: 1_790_170_500n,
  observed_at: 1_790_170_506n,
  bump: 251,
  _reserved: new Uint8Array(32).fill(9),
}
const checkBytes = () => structBytes(codec.accountDiscriminator('SymbolCheck'), 'SymbolCheck', CHECK_VALUES)
const nightBytes = (owner: PublicKey) =>
  structBytes(codec.accountDiscriminator('NightOptIn'), 'NightOptIn', {
    owner,
    created_at: 1_790_000_000n,
    bump: 250,
    _reserved: new Uint8Array(16),
  })

test('a SymbolCheck and a NightOptIn decode field for field, and nothing else is read as one', () => {
  const bytes = checkBytes()
  assert.equal(bytes.length, 162, 'the size final-interface.md gives')
  assert.deepEqual(codec.decodeSymbolCheck(bytes), {
    symbol: 'SPYx',
    mint: MINT,
    checker: CHECKER,
    openNow: true,
    refRateQ64: 2n ** 127n + 5n,
    refPxNum: 772_617_876n,
    refPxExpo: -6,
    refAt: 1_790_170_500n,
    observedAt: 1_790_170_506n,
    bump: 251,
  })
  const night = nightBytes(BUYER)
  assert.equal(night.length, 65)
  assert.deepEqual(codec.decodeNightOptIn(night), { owner: BUYER, createdAt: 1_790_000_000n, bump: 250 })

  // A mark's bytes are not a check, and a check's are not an opt-in.
  const asMark = Uint8Array.from(bytes)
  asMark.set(codec.accountDiscriminator('SymbolMark'), 0)
  assert.throws(() => codec.decodeSymbolCheck(asMark), /not a SymbolCheck/)
  assert.throws(() => codec.decodeNightOptIn(bytes), /not a NightOptIn/)
})

test('night consent is judged as the program judges it: this program’s, an opt-in, and this owner’s', () => {
  const mine = { owner: PROGRAM, data: nightBytes(BUYER) }
  assert.equal(codec.nightConsent(mine, BUYER), true)
  assert.equal(codec.nightConsent(mine, SELLER), false, 'another owner’s opt-in is not consent')
  assert.equal(codec.nightConsent({ ...mine, owner: SystemProgram.programId }, BUYER), false, 'not this program’s')
  assert.equal(codec.nightConsent({ owner: SystemProgram.programId, data: new Uint8Array(0) }, BUYER), false, 'a closed opt-in')
  assert.equal(codec.nightConsent({ owner: PROGRAM, data: checkBytes() }, BUYER), false, 'another account type')
  assert.equal(codec.nightConsent(null, BUYER), false)
})

// ---------------------------------------------------------------------- events

const MARK = { pxNum: 772_617_876n, pxExpo: -6, observedAt: 1_790_170_506n }
const crossedBytes = (over: Record<string, unknown> = {}) =>
  structBytes(discIdl('events', 'OrdersCrossed'), 'OrdersCrossed', {
    symbol: symbolSeed('SPYx'),
    buyer: BUYER,
    seller: SELLER,
    quote: 200n * DOLLAR,
    stock: 25_741_530n,
    px_num: MARK.pxNum,
    px_expo: MARK.pxExpo,
    source: codec.MarkSource.Jupiter,
    mark_observed_at: MARK.observedAt,
    ...over,
  })

test('MarkTripped and OrdersCrossed decode from the layout the IDL gives, and nothing else does', () => {
  const tripped = structBytes(discIdl('events', 'MarkTripped'), 'MarkTripped', {
    symbol: symbolSeed('TSLAx'),
    held_rate_q64: 2n ** 100n,
    pushed_rate_q64: 2n ** 100n + 2n ** 97n,
    held_observed_at: 1_790_000_000n,
    pushed_observed_at: 1_790_000_045n,
  })
  assert.deepEqual(codec.decodeMarkTrippedEvent(tripped), {
    symbol: 'TSLAx',
    heldRateQ64: 2n ** 100n,
    pushedRateQ64: 2n ** 100n + 2n ** 97n,
    heldObservedAt: 1_790_000_000n,
    pushedObservedAt: 1_790_000_045n,
  })

  const crossed = crossedBytes()
  assert.equal(crossed.length, 121)
  assert.deepEqual(codec.decodeOrdersCrossedEvent(crossed), {
    symbol: 'SPYx',
    buyer: BUYER,
    seller: SELLER,
    quote: 200n * DOLLAR,
    stock: 25_741_530n,
    pxNum: MARK.pxNum,
    pxExpo: -6,
    source: codec.MarkSource.Jupiter,
    markObservedAt: MARK.observedAt,
  })
  // The fills reader gives the same event with wallets as base58 and the source by name.
  assert.deepEqual(fills.decodeOrdersCrossed(crossed), {
    symbol: 'SPYx',
    buyer: BUYER.toBase58(),
    seller: SELLER.toBase58(),
    quote: 200n * DOLLAR,
    stock: 25_741_530n,
    pxNum: MARK.pxNum,
    pxExpo: -6,
    source: 'Jupiter',
    markObservedAt: Number(MARK.observedAt),
  })

  assert.equal(codec.decodeOrdersCrossedEvent(tripped), null, 'another event')
  assert.equal(codec.decodeMarkTrippedEvent(crossed), null, 'another event')
  assert.equal(codec.decodeOrdersCrossedEvent(crossed.subarray(0, 120)), null, 'short')
  assert.equal(fills.decodeOrderFilled(crossed), null, 'a cross is not a fill event')
})

// ---------------------------------------------------------------------- pricing

test('the cross amounts are the ones test_cross.rs works by hand, at three kinds of rate', () => {
  const terms = (amountIn: bigint) => ({ amountIn, filledIn: 0n, minFillIn: 1n, maxSlipBps: 30, floorRateQ64: 0n })
  const aboveOne = (SHARE << 64n) / 25_370_000n
  const pfe = (1n << 64n) / 25n
  const cases: [bigint, bigint, bigint, bigint, bigint][] = [
    // rate, buy, sell, quote, stock
    [AAPL_RATE, 334_000_221n, SHARE, 334_000_221n, SHARE],
    [AAPL_RATE, 500n * DOLLAR, SHARE, 334_000_221n, SHARE],
    [AAPL_RATE, 100n * DOLLAR, SHARE, 100n * DOLLAR, 29_940_099n],
    [AAPL_RATE, 100_000_001n, 2n * SHARE, 100_000_001n, 29_940_100n],
    // Above one, the least quote that buys the whole share buys more than
    // there is, and one unit less is taken.
    [aboveOne, 100n * DOLLAR, SHARE, 25_370_000n, 99_999_999n],
    [aboveOne, 10_000_003n, SHARE, 10_000_003n, 39_416_645n],
    [pfe, 500n * DOLLAR, 10_000_000n, 250_000_001n, 10_000_000n],
    [pfe, 100_000_007n, 10_000_000n, 100_000_007n, 4_000_000n],
  ]
  for (const [rate, buy, sell, quote, stock] of cases) {
    assert.deepEqual(codec.crossAmounts(terms(buy), terms(sell), rate), { quote, stock, refused: null }, `${buy} x ${sell}`)
    // The buyer gets exactly a fill's fair value; the seller at least a sale's.
    assert.equal(stock, codec.fairOut(quote, rate))
    assert.ok(quote >= codec.stockToQuoteCeil(stock, rate))
  }
  assert.equal(codec.buyMinOut(334_000_221n, AAPL_RATE, 30, 0n), 99_700_000n)
  assert.equal(codec.sellMinOut(SHARE, AAPL_RATE, 30, 0n), 332_998_221n)
})

test('a cross is refused for the amounts where the program refuses it', () => {
  const t = (amountIn: bigint, over: object = {}) => ({ amountIn, filledIn: 0n, minFillIn: 1n, maxSlipBps: 30, floorRateQ64: 0n, ...over })
  // One quote unit buys no stock at the AAPLx rate.
  assert.deepEqual(codec.crossAmounts(t(1n), t(SHARE), AAPL_RATE), { quote: 1n, stock: 0n, refused: 'FillTooSmall' })
  // All or nothing: a $500 buy whose minimum fill is all of it cannot take one share.
  assert.equal(codec.crossAmounts(t(500n * DOLLAR, { minFillIn: 500n * DOLLAR }), t(SHARE), AAPL_RATE).refused, 'FillTooSmall')
  // The seller's minimum counts too, capped at its remainder.
  assert.equal(codec.crossAmounts(t(100n * DOLLAR), t(SHARE, { minFillIn: SHARE }), AAPL_RATE).refused, 'FillTooSmall')
  assert.equal(codec.crossAmounts(t(100n * DOLLAR), t(SHARE, { minFillIn: SHARE, filledIn: SHARE - 29_940_099n }), AAPL_RATE).refused, null)
  // A seller's floor a cent above the mark refuses; a buyer's floor likewise.
  const sellFloor = codec.sellLimitFloor(334.01, { num: 334_000_221n, expo: -6 }, AAPL_RATE)
  assert.equal(codec.crossAmounts(t(500n * DOLLAR), t(SHARE, { floorRateQ64: sellFloor }), AAPL_RATE).refused, 'PriceOutOfBand')
  assert.equal(codec.crossAmounts(t(100n * DOLLAR), t(SHARE), AAPL_RATE, ).refused, null)
  assert.equal(codec.crossAmounts(t(100n * DOLLAR, { floorRateQ64: AAPL_RATE + (AAPL_RATE >> 10n) }), t(SHARE), AAPL_RATE).refused, 'PriceOutOfBand')
  // A filled order has nothing left to cross.
  assert.equal(codec.crossAmounts(t(100n * DOLLAR, { filledIn: 100n * DOLLAR }), t(SHARE), AAPL_RATE).refused, 'FillTooSmall')
  assert.equal(codec.crossAmounts(t(1n), t(1n), 0n).refused, 'MarkStale')
})

// ---------------------------------------------------------------- the breaker

test('a push is held, written or ignored by mark.rs’s rules, and only a real hold reads as held', () => {
  const t0 = 1_790_000_000n
  const held = { rateQ64: 10_000n * 1_000_000n, observedAt: t0 }
  const unit = held.rateQ64 / 10_000n
  // At the time on record a push may not move the rate at all.
  assert.equal(codec.markStepAllowance(held, t0), 0n)
  assert.equal(codec.markPushOutcome(held, { rateQ64: held.rateQ64, observedAt: t0 }, t0), 'written')
  assert.equal(codec.markPushOutcome(held, { rateQ64: held.rateQ64 + 1n, observedAt: t0 }, t0), 'held')
  // A minute of observed time earns the whole step, in either direction; half a minute half of it.
  assert.equal(codec.markStepAllowance(held, t0 + 60n), unit * 500n)
  assert.equal(codec.markStepAllowance(held, t0 + 600n), unit * 500n, 'no more than one step, however long')
  assert.equal(codec.markStepAllowance(held, t0 + 30n), unit * 250n)
  assert.equal(codec.markPushOutcome(held, { rateQ64: held.rateQ64 + unit * 500n, observedAt: t0 + 60n }, t0 + 60n), 'written')
  assert.equal(codec.markPushOutcome(held, { rateQ64: held.rateQ64 + unit * 500n + 1n, observedAt: t0 + 60n }, t0 + 60n), 'held')
  assert.equal(codec.markPushOutcome(held, { rateQ64: held.rateQ64 - unit * 500n - 1n, observedAt: t0 + 60n }, t0 + 60n), 'held')
  // Older than the record: ignored, never written.
  assert.equal(codec.markPushOutcome(held, { rateQ64: held.rateQ64, observedAt: t0 - 1n }, t0 + 60n), 'ignored')
  // A first push, and one after the record stopped anchoring, set the price at any rate.
  assert.equal(codec.markPushOutcome({ rateQ64: 0n, observedAt: 0n }, { rateQ64: 1n, observedAt: t0 }, t0), 'written')
  assert.equal(codec.markPushOutcome(held, { rateQ64: held.rateQ64 * 2n, observedAt: t0 + 301n }, t0 + 301n), 'written')
  assert.equal(codec.markPushOutcome(held, { rateQ64: held.rateQ64 * 2n, observedAt: t0 + 300n }, t0 + 300n), 'held')

  assert.equal(codec.MARK_HELD_CONF_BPS, 65_535)
  assert.equal(codec.markHeld({ confBps: 65_535, observedAt: t0 }), true)
  // What open_mark writes into a mark nobody has priced: unpriced, not held.
  assert.equal(codec.markHeld({ confBps: 65_535, observedAt: 0n }), false)
  assert.equal(codec.markHeld({ confBps: 200, observedAt: t0 }), false)
})

test('the check refuses in admit’s order: stale, disagreeing, an old reference, then a distant mark', () => {
  const now = 1_790_000_000n
  const ref = 10_000n * 1_000_000n
  const fresh = { observedAt: now - 10n, openNow: true, refAt: now - 30n, refRateQ64: ref }
  const r = (check: typeof fresh | null, over: { night?: boolean; mark?: bigint } = {}) =>
    codec.checkRefusal({ check, markRateQ64: over.mark ?? ref, night: over.night ?? false, now })
  assert.equal(r(fresh), null)
  assert.equal(r(null), 'AccountNotInitialized')
  assert.equal(r({ ...fresh, observedAt: 0n }), 'CheckStale', 'never pushed')
  assert.equal(r({ ...fresh, observedAt: now - 121n }), 'CheckStale')
  assert.equal(r({ ...fresh, observedAt: now - 121n, openNow: false }), 'CheckStale', 'staleness is asked first')
  assert.equal(r({ ...fresh, openNow: false }), 'CheckerDisagrees')
  assert.equal(r(fresh, { night: true }), 'CheckerDisagrees', 'a night fill needs the checker to say closed')
  assert.equal(r({ ...fresh, refAt: now - 301n }), 'CheckStale', 'a session reference five minutes old')
  assert.equal(r({ ...fresh, openNow: false, refAt: now - 43_200n }, { night: true }), null, 'tonight’s close')
  assert.equal(r({ ...fresh, openNow: false, refAt: now - 43_201n }, { night: true }), 'CheckStale')
  assert.equal(r({ ...fresh, refRateQ64: 0n }), 'CheckStale')
  // 300bps of the reference in session, exactly at the edge and one past it; 150 at night.
  assert.equal(r(fresh, { mark: ref + (ref / 10_000n) * 300n }), null)
  assert.equal(r(fresh, { mark: ref + (ref / 10_000n) * 300n + 1n }), 'MarkOffReference')
  assert.equal(r(fresh, { mark: ref - (ref / 10_000n) * 300n - 1n }), 'MarkOffReference')
  assert.equal(r({ ...fresh, openNow: false }, { night: true, mark: ref + (ref / 10_000n) * 151n }), 'MarkOffReference')
})

// ---------------------------------------------------------------------- readers

test('the board reads each symbol’s check in the same request, and the extras come back where they were', async () => {
  const listings = [{ symbol: 'SPYx', mint: MINT.toBase58() }, { symbol: 'QQQx', mint: key(40).toBase58() }]
  const extra = [key(41), key(42)]
  const calls: number[] = []
  const conn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      calls.push(keys.length)
      return keys.map((k) =>
        k.equals(client.checkPda('SPYx'))
          ? { data: Buffer.from(checkBytes()), owner: PROGRAM, lamports: 1, executable: false }
          : extra.some((e) => e.equals(k))
            ? { data: Buffer.from(k.toBytes()), owner: PROGRAM, lamports: 1, executable: false }
            : null,
      )
    },
  }
  const { symbols, extras } = await client.readBoard(conn, listings, extra)
  assert.deepEqual(calls, [4 * 2 + 2], 'one request: four accounts a symbol, then the extras')
  assert.equal(symbols.get('SPYx')!.check!.checker.toBase58(), CHECKER.toBase58())
  assert.equal(symbols.get('QQQx')!.check, null, 'no check opened yet')
  extras.forEach((info, i) => assert.ok(Buffer.from(extra[i]!.toBytes()).equals(info!.data)))
})

test('lamports sent to a check address before open_check read as no check, not a board that throws', async () => {
  // A plain transfer leaves an empty, system-owned account at the address.
  // Decoded as a check it threw, and the board, and every service reading it,
  // went down with it.
  const SYSTEM = new PublicKey('11111111111111111111111111111111')
  const listings = [{ symbol: 'SPYx', mint: MINT.toBase58() }, { symbol: 'QQQx', mint: key(40).toBase58() }]
  const at = new Map([
    [client.checkPda('SPYx').toBase58(), { data: Buffer.alloc(0), owner: SYSTEM, lamports: 890_880, executable: false }],
    // Not this program's, even with a check's bytes: not a check.
    [client.checkPda('QQQx').toBase58(), { data: Buffer.from(checkBytes()), owner: SYSTEM, lamports: 1, executable: false }],
  ])
  const conn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => at.get(k.toBase58()) ?? null)
    },
    async getAccountInfo(k: PublicKey) {
      return at.get(k.toBase58()) ?? null
    },
  }
  const { symbols } = await client.readBoard(conn, listings)
  assert.equal(symbols.get('SPYx')!.check, null)
  assert.equal(symbols.get('QQQx')!.check, null)
  assert.equal(await client.readCheck(conn as never, 'SPYx'), null)
})

test('night opt-ins are read per owner as consent, or all at once by discriminator', async () => {
  const stranger = key(50)
  const accounts = new Map([
    [client.nightPda(BUYER).toBase58(), { data: Buffer.from(nightBytes(BUYER)), owner: PROGRAM }],
    // An account at the seller's night address naming someone else is not the seller's consent.
    [client.nightPda(SELLER).toBase58(), { data: Buffer.from(nightBytes(stranger)), owner: PROGRAM }],
  ])
  const conn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => accounts.get(k.toBase58()) ?? null)
    },
    async getProgramAccounts(program: PublicKey, config: { filters: { memcmp: { offset: number; bytes: string } }[] }) {
      assert.ok(program.equals(PROGRAM))
      assert.equal(config.filters.length, 1)
      return [...accounts].map(([pubkey, account]) => ({ pubkey: new PublicKey(pubkey), account }))
    },
  } as unknown as Parameters<typeof client.readNightOptIns>[0]

  const some = await client.readNightOptIns(conn, [BUYER, SELLER, CRANKER])
  assert.deepEqual([...some.keys()], [BUYER.toBase58()])
  assert.equal(some.get(BUYER.toBase58())!.createdAt, 1_790_000_000n)
  // Listed without owners, only an opt-in that lives at its own owner's address counts.
  const all = await client.readNightOptIns(conn)
  assert.deepEqual([...all.keys()], [BUYER.toBase58()])

  const one = await client.readNightOptIn({ getAccountInfo: async (k: PublicKey) => accounts.get(k.toBase58()) ?? null } as never, BUYER)
  assert.equal(one!.owner.toBase58(), BUYER.toBase58())
  assert.equal(await client.readNightOptIn({ getAccountInfo: async () => null } as never, SELLER), null)
})

test('every check is read in one request, keyed by symbol', async () => {
  const seen: string[] = []
  const conn = {
    async getProgramAccounts(_p: PublicKey, config: { filters: { memcmp: { offset: number; bytes: string } }[] }) {
      seen.push(config.filters[0]!.memcmp.bytes)
      return [{ pubkey: client.checkPda('SPYx'), account: { data: Buffer.from(checkBytes()) } }]
    },
  } as unknown as Parameters<typeof client.readChecks>[0]
  const checks = await client.readChecks(conn)
  assert.deepEqual([...checks.keys()], ['SPYx'])
  assert.equal(seen.length, 1)
})

// ------------------------------------------------------------------- the tape

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function toBase58(b: Uint8Array): string {
  let n = 0n
  for (const x of b) n = n * 256n + BigInt(x)
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const x of b) {
    if (x !== 0) break
    out = '1' + out
  }
  return out
}

const SPYX_MINT = JSON.parse(readFileSync(new URL('./fixtures/spyx-mirror-mint.json', import.meta.url), 'utf8')) as { data: string }
const spyx: Listing = {
  symbol: 'SPYx',
  mint: MINT.toBase58(),
  mainnetMint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
  underlying: 'SPY',
  exchangeMic: 'ARCX',
  issuer: 'backed',
  note: 'test',
}
const ctx: RowContext = {
  cluster: 'devnet',
  listing: (symbol, stockMint) => (symbol === 'SPYx' && stockMint === MINT.toBase58() ? spyx : null),
  label: (mint) => (mint === QUOTE.toBase58() ? 'demo-USDC' : mint),
  scaled: (mint) => (mint === MINT.toBase58() ? tape.scaledUiOf(Uint8Array.from(Buffer.from(SPYX_MINT.data, 'base64'))) : null),
}

/** The SPYx mark of the recorded 23 September fill, as a rate: $772.617876 a share, multiplier applied, 8 against 6 decimals. */
const SPYX_RATE = codec.rateQ64({ pricePerShare: 772.617876, multiplier: 1.005714560286254, quoteDecimals: 6, stockDecimals: 8 })
const CROSS = codec.crossAmounts(
  { amountIn: 200n * DOLLAR, filledIn: 0n, minFillIn: 1n, maxSlipBps: 30, floorRateQ64: 0n },
  { amountIn: SHARE, filledIn: 0n, minFillIn: 1n, maxSlipBps: 30, floorRateQ64: 0n },
  SPYX_RATE,
)
const CROSS_SIG = '4CRoSSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const CROSS_TIME = 1_790_170_524

/**
 * A `cross_orders` transaction as `getTransaction` (json) returns one: the
 * accounts in the IDL's order, the two token legs as inner instructions and
 * log frames (stock first, then quote, as cross.rs moves them), and the
 * `OrdersCrossed` payload in the layout the IDL gives.
 */
function crossTx(opts: { instruction?: string; payload?: Uint8Array } = {}): RpcTransaction {
  const B = PROGRAM.toBase58()
  const T22 = client.TOKEN_2022.toBase58()
  const TOK = client.TOKEN_PROGRAM.toBase58()
  const byName: Record<string, string> = {
    cranker: CRANKER.toBase58(),
    buy: client.orderPda(BUY.owner, BUY.nonce).toBase58(),
    sell: client.sellOrderPda(SELL.owner, SELL.nonce).toBase58(),
    symbol_state: client.symbolPda('SPYx').toBase58(),
    risk: client.riskPda(MINT).toBase58(),
    mark: client.markPda('SPYx').toBase58(),
    check: client.checkPda('SPYx').toBase58(),
    buy_auth: client.authPda(BUYER).toBase58(),
    sell_auth: client.authPda(SELLER).toBase58(),
    buyer: BUYER.toBase58(),
    seller: SELLER.toBase58(),
    buyer_quote: BUY.payerIn.toBase58(),
    buyer_stock: BUY.payeeOut.toBase58(),
    seller_stock: SELL.payerIn.toBase58(),
    seller_quote: SELL.payeeOut.toBase58(),
    quote_mint: QUOTE.toBase58(),
    stock_mint: MINT.toBase58(),
    quote_token_program: TOK,
    stock_token_program: T22,
  }
  const accountKeys = [...Object.values(byName), B]
  const at = (k: string) => accountKeys.indexOf(k)
  const ix = opts.instruction ?? 'cross_orders'
  // A fill instruction has other accounts; only the discriminator matters to the reader here.
  const accounts = ixIdl('cross_orders').accounts.map((a) => at(byName[a.name]!))
  const payload = opts.payload ?? crossedBytes({ quote: CROSS.quote, stock: CROSS.stock })
  const balance = (i: number, mint: PublicKey, decimals: number, amount: bigint) => ({
    accountIndex: i,
    mint: mint.toBase58(),
    uiTokenAmount: { amount: amount.toString(), decimals },
  })
  return {
    slot: 470_000_000,
    blockTime: CROSS_TIME,
    meta: {
      err: null,
      logMessages: [
        `Program ${B} invoke [1]`,
        'Program log: Instruction: CrossOrders',
        `Program ${T22} invoke [2]`,
        'Program log: Instruction: TransferChecked',
        `Program ${T22} consumed 3224 of 177128 compute units`,
        `Program ${T22} success`,
        `Program ${TOK} invoke [2]`,
        'Program log: Instruction: TransferChecked',
        `Program ${TOK} consumed 112 of 171636 compute units`,
        `Program ${TOK} success`,
        `Program data: ${Buffer.from(payload).toString('base64')}`,
        `Program ${B} consumed 45016 of 200000 compute units`,
        `Program ${B} success`,
      ],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            { programIdIndex: at(T22), accounts: [at(byName.seller_stock!), at(byName.stock_mint!), at(byName.buyer_stock!), at(byName.sell_auth!)], data: '2' },
            { programIdIndex: at(TOK), accounts: [at(byName.buyer_quote!), at(byName.quote_mint!), at(byName.seller_quote!), at(byName.buy_auth!)], data: '2' },
          ],
        },
      ],
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [balance(at(byName.buyer_quote!), QUOTE, 6, 1_000n * DOLLAR), balance(at(byName.seller_stock!), MINT, 8, SHARE)],
      postTokenBalances: [
        balance(at(byName.buyer_quote!), QUOTE, 6, 1_000n * DOLLAR - CROSS.quote),
        balance(at(byName.seller_stock!), MINT, 8, SHARE - CROSS.stock),
      ],
    } as unknown as RpcTransaction['meta'],
    transaction: {
      signatures: [CROSS_SIG],
      message: { accountKeys, instructions: [{ programIdIndex: at(B), accounts, data: toBase58(Uint8Array.from(ixIdl(ix).discriminator)) }] },
    },
  }
}

test('a cross_orders transaction reads as one cross with both parties, and as no fill', () => {
  assert.equal(CROSS.refused, null)
  assert.equal(CROSS.quote, 200n * DOLLAR, 'the buy binds')
  const tx = crossTx()
  const [c, ...rest] = fills.crossesOf(tx)
  assert.equal(rest.length, 0)
  assert.deepEqual(c, {
    side: 'cross',
    event: {
      symbol: 'SPYx',
      buyer: BUYER.toBase58(),
      seller: SELLER.toBase58(),
      quote: CROSS.quote,
      stock: CROSS.stock,
      pxNum: MARK.pxNum,
      pxExpo: -6,
      source: 'Jupiter',
      markObservedAt: Number(MARK.observedAt),
    },
    buyOrder: client.orderPda(BUYER, BUY.nonce).toBase58(),
    sellOrder: client.sellOrderPda(SELLER, SELL.nonce).toBase58(),
    buyer: BUYER.toBase58(),
    seller: SELLER.toBase58(),
    cranker: CRANKER.toBase58(),
    quoteMint: QUOTE.toBase58(),
    stockMint: MINT.toBase58(),
  })
  assert.deepEqual(fills.tradesOf(tx), [c])
  // The per-wallet alerts read fills alone, so a cross is not mistaken for a buy or a sale.
  assert.deepEqual(fills.fillsOf(tx), [])
})

test('a cross is only believed from cross_orders, and only when its event names the instruction’s parties', () => {
  // An OrdersCrossed logged inside a fill is a payload the program never writes there.
  assert.deepEqual(fills.tradesOf(crossTx({ instruction: 'fill_order' })), [])
  // A fill's event inside cross_orders is not a cross, nor a fill.
  const filled = Uint8Array.from(crossedBytes())
  filled.set(discIdl('events', 'OrderFilled'), 0)
  assert.deepEqual(fills.tradesOf(crossTx({ payload: filled })), [])
  // An event whose parties are not the instruction's is refused, not attributed to either.
  assert.throws(() => fills.crossesOf(crossTx({ payload: crossedBytes({ seller: CRANKER }) })), /other parties/)
  // Nor from another program in the same transaction.
  const forged = crossTx()
  const fake = 'Fake1111111111111111111111111111111111111111'
  forged.transaction.message.accountKeys.push(fake)
  forged.transaction.message.instructions.push({ programIdIndex: forged.transaction.message.accountKeys.length - 1, accounts: [], data: '' })
  forged.meta!.logMessages!.push(`Program ${fake} invoke [1]`, `Program data: ${Buffer.from(crossedBytes()).toString('base64')}`, `Program ${fake} success`)
  assert.equal(fills.crossesOf(forged).length, 1, 'only the real one')
  // A failed cross crossed nothing.
  const failed = crossTx()
  failed.meta!.err = { InstructionError: [0, { Custom: 6033 }] }
  assert.deepEqual(fills.crossesOf(failed), [])
})

test('a cross is one tape row: both wallets, both orders, the pool’s price and no spread', () => {
  const { rows, excluded } = tape.tapeRows(crossTx(), ctx)
  assert.equal(excluded, 0)
  assert.equal(rows.length, 1)
  const r = rows[0]!
  assert.equal(r.direction, 'cross')
  assert.equal(r.time, '2026-09-23T13:35:24Z')
  // Told from the buyer's side, as the quote leads.
  assert.equal(r.contributed, 'demo-USDC')
  assert.equal(r.withdrawn, 'SPYx')
  assert.equal(r.quoteRaw, CROSS.quote.toString())
  assert.equal(r.stockRaw, CROSS.stock.toString())
  assert.equal(r.notionalUsd, 200)
  assert.equal(r.realizedBps, 0)
  assert.equal(r.markPriceUsd, 772.617876)
  // At the mark, with no filler's spread: the price is the mark's, to the rounding of one raw unit.
  assert.ok(Math.abs(r.priceUsd! - r.markPriceUsd) < 0.0001, `${r.priceUsd} against ${r.markPriceUsd}`)
  assert.equal(r.order, client.orderPda(BUYER, BUY.nonce).toBase58())
  assert.equal(r.sellOrder, client.sellOrderPda(SELLER, SELL.nonce).toBase58())
  assert.equal(r.filler, CRANKER.toBase58())
  assert.equal(r.buyer, BUYER.toBase58())
  assert.equal(r.seller, SELLER.toBase58())
  assert.equal(r.explorer, `https://explorer.solana.com/tx/${CROSS_SIG}?cluster=devnet`)

  // One trade, counted once.
  assert.deepEqual(tape.volume24h(rows, CROSS_TIME + 60), [
    { symbol: 'SPYx', paired: 'demo-USDC', trades: 1, shares: r.shares, notionalUsd: 200 },
  ])
  assert.match(tape.toCsv(rows), /\r\n2026-09-23T13:35:24Z,SPYx,SPY,demo-USDC,cross,demo-USDC,SPYx,/)
  // An unlisted symbol's cross stays off the tape and is counted, as a fill's does.
  assert.deepEqual(tape.tapeRows(crossTx(), { ...ctx, listing: () => null }), { rows: [], excluded: 1 })
})

test('the public tape names neither party to a cross, and each party finds it and sees only its own side', () => {
  const [r] = tape.tapeRows(crossTx(), ctx).rows
  const buy = { ...r!, direction: 'buy' as const, buyer: 'SomeBuyer', seller: undefined }
  delete (buy as { seller?: string }).seller
  const rows = [r!, buy]

  const pub = tape.rowsFor(rows, {})
  assert.equal(pub.length, 2)
  for (const p of pub) assert.ok(!('buyer' in p) && !('seller' in p))
  assert.ok(!JSON.stringify(pub).includes(BUYER.toBase58()) && !JSON.stringify(pub).includes(SELLER.toBase58()))

  const asBuyer = tape.rowsFor(rows, { buyer: BUYER.toBase58() })
  assert.equal(asBuyer.length, 1)
  assert.equal(asBuyer[0]!.buyer, BUYER.toBase58())
  assert.ok(!('seller' in asBuyer[0]!), 'the buyer is not told who sold')

  const asSeller = tape.rowsFor(rows, { seller: SELLER.toBase58() })
  assert.equal(asSeller.length, 1)
  assert.equal(asSeller[0]!.seller, SELLER.toBase58())
  assert.ok(!('buyer' in asSeller[0]!), 'the seller is not told who bought')

  // A wallet asking for both its purchases and its sales gets the cross once.
  assert.equal(tape.rowsFor(rows, { buyer: SELLER.toBase58(), seller: SELLER.toBase58() }).length, 1)
  assert.deepEqual(tape.rowsFor(rows, { buyer: CRANKER.toBase58() }), [])
  // Buy and sell rows are returned exactly as the route has always returned them.
  assert.equal(tape.rowsFor(rows, { buyer: 'SomeBuyer' })[0], buy)
})

test('a held push is read from push_mark’s own event', () => {
  const B = PROGRAM.toBase58()
  const attestor = key(60).toBase58()
  const payload = structBytes(discIdl('events', 'MarkTripped'), 'MarkTripped', {
    symbol: symbolSeed('SPYx'),
    held_rate_q64: SPYX_RATE,
    pushed_rate_q64: SPYX_RATE * 2n,
    held_observed_at: 1_790_170_500n,
    pushed_observed_at: 1_790_170_545n,
  })
  const accountKeys = [attestor, client.symbolPda('SPYx').toBase58(), client.markPda('SPYx').toBase58(), B]
  const tx: RpcTransaction = {
    slot: 1,
    blockTime: 1_790_170_546,
    meta: {
      err: null,
      logMessages: [`Program ${B} invoke [1]`, 'Program log: Instruction: PushMark', `Program data: ${Buffer.from(payload).toString('base64')}`, `Program ${B} success`],
    },
    transaction: {
      signatures: ['sig'],
      message: { accountKeys, instructions: [{ programIdIndex: 3, accounts: [0, 1, 2], data: toBase58(Uint8Array.from(ixIdl('push_mark').discriminator)) }] },
    },
  }
  const [t] = fills.trippedOf(tx)
  assert.equal(t!.mark, client.markPda('SPYx').toBase58())
  assert.equal(t!.attestor, attestor)
  assert.equal(t!.event.pushedRateQ64, SPYX_RATE * 2n)
  assert.deepEqual(fills.tradesOf(tx), [], 'a push is not a trade')
})

// --------------------------------------------------------------- notifications

const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'

test('a cross is worded as one: at the pool’s price, no filler spread, from each side or both', () => {
  const cross = {
    kind: 'cross' as const,
    symbol: 'SPYx',
    amount: 200,
    quote: 'demo-USDC',
    shares: 0.290294,
    minutesAfterBell: 0,
    buyer: BUYER.toBase58(),
    seller: SELLER.toBase58(),
    signature: SIG,
  }
  const channel = notify.formatEvent(cross, 'devnet')
  assert.match(channel, /^Crossed: 0\.290294 SPYx for 200\.00 demo-USDC, 688\.96 demo-USDC a share, at the pool's price, no filler spread, 0 min after the bell\.\n/)
  assert.ok(channel.includes(`Buyer ${notify.shortKey(BUYER.toBase58())}, seller ${notify.shortKey(SELLER.toBase58())}`))
  assert.ok(channel.includes(`https://explorer.solana.com/tx/${SIG}?cluster=devnet`))
  assert.ok(!/fair/i.test(channel), 'the mark is an ask, so a cross is never called fair')

  const bought = notify.formatEvent({ ...cross, side: 'buy' }, 'devnet')
  assert.match(bought, /^Crossed: bought 0\.290294 SPYx for 200\.00 demo-USDC/)
  assert.ok(bought.includes(`Owner ${notify.shortKey(BUYER.toBase58())}`) && !bought.includes(notify.shortKey(SELLER.toBase58())))
  const sold = notify.formatEvent({ ...cross, side: 'sell' }, 'devnet')
  assert.match(sold, /^Crossed: sold 0\.290294 SPYx for 200\.00 demo-USDC/)
  assert.ok(sold.includes(`Owner ${notify.shortKey(SELLER.toBase58())}`) && !sold.includes(notify.shortKey(BUYER.toBase58())))

  assert.match(notify.formatEvent({ ...cross, shares: null, minutesAfterBell: null }, 'devnet'), /^Crossed: SPYx for 200\.00 demo-USDC, at the pool's price, no filler spread\.\n/)
})

test('the breaker is announced when it holds a mark and when a push releases it, once each', () => {
  const memo = notify.announced()
  const at = 1_790_170_546
  const base = { at, open: 9, total: 9, transitions: [], windows: null, guardSeconds: 900, markStep: { bps: 500, resetSeconds: 300 } }
  const step = (breakers: { symbol: string; held: boolean; heldPrice?: number; pushedPrice?: number }[] | null) =>
    notify.keeperEvents(memo, { ...base, breakers })

  assert.deepEqual(step([{ symbol: 'SPYx', held: false }]), [], 'the first reading only records')
  const held = step([{ symbol: 'SPYx', held: true, heldPrice: 772.617876, pushedPrice: 1545.23 }])
  assert.deepEqual(held, [
    { kind: 'breaker', symbol: 'SPYx', held: true, heldPrice: 772.617876, pushedPrice: 1545.23, stepBps: 500, resetSeconds: 300 },
  ])
  assert.equal(
    notify.formatEvent(held[0]!, 'devnet'),
    'SPYx: price mark held. A push moved further than 5% a minute allows (772.62 on record, 1545.23 pushed), so BELL refuses its fills (MarkPaused) until a push lands within the step or the held price is 5 minutes old; queued orders wait.',
  )
  assert.deepEqual(step([{ symbol: 'SPYx', held: true }]), [], 'still held is not news')
  assert.deepEqual(step(null), [], 'an unreadable tick changes nothing')
  const released = step([{ symbol: 'SPYx', held: false }])
  assert.deepEqual(released, [{ kind: 'breaker', symbol: 'SPYx', held: false, stepBps: 500, resetSeconds: 300 }])
  assert.equal(notify.formatEvent(released[0]!, 'devnet'), 'SPYx: the price mark is no longer held, and fills can price against it again.')

  // Without the program's numbers the message says what it can.
  assert.match(
    notify.formatEvent({ kind: 'breaker', symbol: 'QQQx', held: true }, 'devnet'),
    /^QQQx: price mark held\. A push moved further than one step allows, so BELL refuses its fills \(MarkPaused\) until a push lands within the step or the held price ages out;/,
  )
})
