/**
 * Everything the browser imports must survive without Node's Buffer.
 *
 * Bundlers replace `Buffer` with the `buffer` npm polyfill, which implements
 * the byte and 32-bit methods but **not** the BigInt ones. So `writeBigUInt64LE`
 * and its siblings exist in every test and are absent on the page — which is
 * how a codec bug shipped twice: once in `codec.ts`, and again in `orderPda`,
 * where the seed is derived rather than encoded and a sweep of the codec
 * missed it.
 *
 * This file removes those four methods before importing anything, so any
 * shared module that reaches for them throws here rather than in front of a
 * judge. Node's test runner gives each file its own process, so the damage is
 * contained to this one.
 *
 * The rule it encodes: code shared across runtimes must be written against the
 * *intersection* of their APIs, and "it passes in Node" does not establish that.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const REMOVED = [
  'writeBigUInt64LE',
  'readBigUInt64LE',
  'writeBigInt64LE',
  'readBigInt64LE',
  'writeDoubleLE',
  'readDoubleLE',
] as const

for (const m of REMOVED) {
  Object.defineProperty(Buffer.prototype, m, {
    configurable: true,
    value() {
      throw new TypeError(`${m} is not a function — absent from the browser Buffer polyfill`)
    },
  })
}

// Imported *after* the methods are removed, so module-level work is covered too.
const { PublicKey } = await import('@solana/web3.js')
const codec = await import('../src/chain/codec.ts')
const client = await import('../src/chain/client.ts')
const spl = await import('../src/chain/spl.ts')

const OWNER = new PublicKey('Dqp6DbUh6j5Jddff9VHPAK1UpByo85NhLVw83S58Ziqs')
const MINT = new PublicKey('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W')

test('the guard actually bites', () => {
  assert.throws(() => Buffer.alloc(8).writeBigUInt64LE(1n), /not a function/)
})

test('PDA derivation needs no Node Buffer', () => {
  // orderPda is the one that shipped broken: its nonce is a u64 seed.
  assert.ok(client.orderPda(OWNER, 1_758_500_000_000n) instanceof PublicKey)
  // The sell side derives its address from the same u64 nonce seed.
  assert.ok(client.sellOrderPda(OWNER, 1_758_500_000_000n) instanceof PublicKey)
  assert.ok(client.symbolPda('SPYx') instanceof PublicKey)
  assert.ok(client.riskPda(MINT) instanceof PublicKey)
  assert.ok(client.markPda('SPYx') instanceof PublicKey)
  assert.ok(client.authPda(OWNER) instanceof PublicKey)
  assert.ok(spl.ataFor(OWNER, MINT) instanceof PublicKey)
})

test('a nonce round-trips through the derived seed', () => {
  // Two nonces one apart must not collide, which they would if the seed were
  // silently zeroed by a failed write.
  const a = client.orderPda(OWNER, 7n)
  const b = client.orderPda(OWNER, 8n)
  assert.notEqual(a.toBase58(), b.toBase58())
  assert.notEqual(client.sellOrderPda(OWNER, 7n).toBase58(), client.sellOrderPda(OWNER, 8n).toBase58())
})

test('every instruction the browser builds encodes', () => {
  const args = {
    owner: OWNER,
    symbol: 'SPYx',
    mint: MINT,
    nonce: 42n,
    amountIn: 200_000_000n,
    minFillIn: 200_000_000n,
    maxSlipBps: 30,
    maxConfBps: 50,
    floorRateQ64: 0n,
    notBefore: 0n,
    expiresAt: 1_758_600_000n,
    payerIn: spl.ataFor(OWNER, MINT),
    payeeOut: spl.ataFor(OWNER, MINT, spl.TOKEN_2022),
  }
  assert.ok(client.ixPlaceOrder(args).data.length > 0)
  assert.ok(client.ixCancelOrder({ signer: OWNER, owner: OWNER, nonce: 42n, payerIn: args.payerIn }).data.length > 0)
  // A sell's legs are the other way round: stock pays, quote is paid.
  const sell = { ...args, payerIn: args.payeeOut, payeeOut: args.payerIn, floorRateQ64: codec.sellLossFloor(1n << 64n) }
  assert.ok(client.ixPlaceSellOrder(sell).data.length > 0)
  assert.ok(client.ixCancelSellOrder({ signer: OWNER, owner: OWNER, nonce: 42n, payerIn: sell.payerIn }).data.length > 0)
  assert.ok(spl.ixApproveChecked({ source: sell.payerIn, mint: MINT, delegate: client.authPda(OWNER), owner: OWNER, amount: 100_000_000n, decimals: 8, tokenProgram: spl.TOKEN_2022 }).data.length === 10)
  assert.ok(spl.ixRevoke(sell.payerIn, OWNER, spl.TOKEN_2022).data.length === 1)
  assert.ok(client.ixAssertTradeable({ symbol: 'SPYx', mint: MINT, mode: codec.Mode.Strict, expectedMultiplierBits: 0n }).data.length > 0)
  assert.ok(spl.ixApproveChecked({ source: args.payerIn, mint: MINT, delegate: client.authPda(OWNER), owner: OWNER, amount: 200_000_000n, decimals: 6 }).data.length === 10)
  assert.ok(spl.ixRevoke(args.payerIn, OWNER).data.length === 1)
  assert.ok(spl.ixCreateAtaIdempotent({ payer: OWNER, owner: OWNER, mint: MINT }).data.length === 1)
})

/** The little-endian bytes a correct writer must have emitted. */
const le = (v: bigint, bytes: number) =>
  Array.from({ length: bytes }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn))

const contains = (hay: Uint8Array, needle: number[]) =>
  Array.from(hay).some((_, i) => needle.every((b, j) => hay[i + j] === b))

test('u64, i64 and u128 reach the wire correctly, at their boundaries', () => {
  // Exercised through the real encoder rather than a test-only helper, so
  // this tests the bytes that are actually sent. A failed BigInt write would
  // leave zeroes, which `contains` would not find.
  for (const amountIn of [1n, 2n ** 63n - 1n, 2n ** 64n - 1n]) {
    for (const floorRateQ64 of [1n, 2n ** 64n, 2n ** 128n - 1n]) {
      const expiresAt = 1_758_600_000n
      const data = codec.encodePlaceOrder({
        symbol: new Uint8Array(12),
        nonce: 42n,
        amountIn,
        minFillIn: amountIn,
        maxSlipBps: 30,
        maxConfBps: 50,
        floorRateQ64,
        notBefore: 0n,
        expiresAt,
      })
      assert.ok(contains(data, le(amountIn, 8)), `u64 ${amountIn} missing from the wire`)
      assert.ok(contains(data, le(floorRateQ64, 16)), `u128 ${floorRateQ64} missing from the wire`)
      assert.ok(contains(data, le(expiresAt, 8)), 'i64 missing from the wire')
    }
  }
})

test('a decoder reads back what the encoder wrote', () => {
  const data = codec.encodeFillOrder({ amountInLeg: 2n ** 63n - 1n, amountOut: 123_456_789n })
  assert.ok(contains(data, le(2n ** 63n - 1n, 8)))
  assert.ok(contains(data, le(123_456_789n, 8)))
  const sell = codec.encodeFillSellOrder({ amountInLeg: 2n ** 64n - 1n, amountOut: 332_998_221n })
  assert.ok(contains(sell, le(2n ** 64n - 1n, 8)))
  assert.ok(contains(sell, le(332_998_221n, 8)))
  const place = codec.encodePlaceSellOrder({
    symbol: new Uint8Array(12), nonce: 42n, amountIn: 2n ** 64n - 1n, minFillIn: 1n, maxSlipBps: 30,
    maxConfBps: 50, floorRateQ64: 2n ** 128n - 1n, notBefore: 0n, expiresAt: 1_758_600_000n,
  })
  assert.ok(contains(place, le(2n ** 128n - 1n, 16)), 'u128 floor missing from the sell wire')
})

test('the scaled-UI multiplier decodes without readDoubleLE', () => {
  // SPYx's live dividend multiplier as f64 bits (0x3ff017682698a5d0). A
  // dividend steps value-per-raw-unit up at a known instant, so reading this
  // wrong is the difference between a fair fill and a drained pool.
  assert.equal(codec.multiplierOf(4_607_208_154_891_593_168n), 1.005714560286254)
  // 1.0 exactly — the no-op multiplier, and the value a zeroed read would
  // *not* produce, so this distinguishes "decoded" from "returned a default".
  assert.equal(codec.multiplierOf(4_607_182_418_800_017_408n), 1)
})

// ------------------------------------------------------------ enum parity
//
// Every place the TypeScript side mirrors an on-chain enum is checked against
// the IDL's own variant order. The UI once held a hand-written copy of
// `RebaseKind` in the wrong order, and during a rebase it would have rendered an
// unclassified change as "pending Dividend" — tradeable on the board, refused by
// the program. A copy that drifts should fail here, not in front of someone.

const idl = (await import('../src/chain/idl.json', { with: { type: 'json' } })).default as {
  types: { name: string; type: { kind: string; variants?: { name: string }[] } }[]
}
const { HaltState } = await import('../src/policy/reconcile.ts')

const variants = (name: string) => {
  const t = idl.types.find((x) => x.name === name)
  assert.ok(t?.type.variants, `${name} missing from the IDL`)
  return t.type.variants.map((v) => v.name)
}

const mirrors: [string, Record<string, number>][] = [
  ['RebaseKind', codec.RebaseKind],
  ['Mode', codec.Mode],
  ['MarkSource', codec.MarkSource],
  ['HaltState', HaltState],
]

for (const [name, mirror] of mirrors) {
  test(`${name} mirrors the IDL's variant order exactly`, () => {
    const onChain = variants(name)
    assert.equal(Object.keys(mirror).length, onChain.length, `${name}: variant count differs`)
    onChain.forEach((variant, discriminant) => {
      assert.equal(mirror[variant], discriminant, `${name}.${variant} should be ${discriminant}`)
    })
  })
}

test('classify_rebase(Dividend) encodes to the bytes the program expects', () => {
  // Anchor discriminator for classify_rebase, then RebaseKind::Dividend as one u8.
  const hex = Buffer.from(codec.encodeClassifyRebase(codec.RebaseKind.Dividend)).toString('hex')
  assert.equal(hex, 'e919f062655350a702')
})

test('a token account decodes without Node Buffer, delegate included', () => {
  // A synthetic 165-byte SPL account with every field set, so each offset is
  // pinned — the delegate in particular, which is how the page tells a live
  // order from one whose owner has revoked it.
  const mint = new PublicKey('8QhSxevJerJq8khpNsfW69bUPvcBjMRTXPKrxYQAtAaX')
  const delegate = client.authPda(OWNER)
  const raw = new Uint8Array(165)
  const d = new DataView(raw.buffer)
  raw.set(mint.toBytes(), 0)
  raw.set(OWNER.toBytes(), 32)
  d.setBigUint64(64, 2n ** 63n + 7n, true)
  d.setUint32(72, 1, true)
  raw.set(delegate.toBytes(), 76)
  d.setBigUint64(121, 250_000_000n, true)

  const v = spl.decodeTokenAccount(raw)
  assert.equal(v.mint.toBase58(), mint.toBase58())
  assert.equal(v.owner.toBase58(), OWNER.toBase58())
  assert.equal(v.amount, 2n ** 63n + 7n)
  assert.equal(v.delegate?.toBase58(), delegate.toBase58())
  assert.equal(v.delegatedAmount, 250_000_000n)

  d.setUint32(72, 0, true) // COption::None
  assert.equal(spl.decodeTokenAccount(raw).delegate, null)
})

test('transfer_checked encodes discriminant, amount and decimals', () => {
  const ix = spl.ixTransferChecked({
    source: OWNER, mint: MINT, destination: OWNER, owner: OWNER, amount: 1_000_000_000n, decimals: 6,
  })
  assert.equal(Buffer.from(ix.data).toString('hex'), '0c00ca9a3b0000000006')
})
