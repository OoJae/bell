/**
 * Composing the gate with someone else's transaction.
 *
 * The integration promise is narrow and has to be exact: the guarded
 * transaction is the caller's transaction with BELL's gate in front of it, and
 * nothing else. Nothing of the caller's may run before the gate answers, and
 * nothing of the caller's may be reordered, copied or re-encoded on the way
 * through — a router whose swap came back subtly different would be right to
 * refuse to integrate at all.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
  type AccountInfo,
} from '@solana/web3.js'
import { composeGuarded, gateInstructions, guardInstructions, guarded, readVerdict } from '../src/chain/guard.ts'
import { PROGRAM_ID, Mode, accountDiscriminator } from '../src/chain/codec.ts'
import { riskPda, symbolPda } from '../src/chain/client.ts'
import { symbolSeed } from '../src/config.ts'
import idl from '../src/chain/idl.json' with { type: 'json' }

const SYMBOL = 'SPYx'
const MINT = new PublicKey('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W')
const ATTESTOR = new PublicKey('EsZp7XusAj9fJ1ntQYCTMEw7h6L9mfZUtAvaXDxi4TcG')
const USER = Keypair.generate().publicKey
const BITS = 4607208154891593168n // SPYx mirror's multiplier, 1.005714560286254
const ASSERT_TRADEABLE = Buffer.from(idl.instructions.find((i) => i.name === 'assert_tradeable')!.discriminator)
const REFRESH_TOKEN_RISK = Buffer.from(idl.instructions.find((i) => i.name === 'refresh_token_risk')!.discriminator)
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

/** Two instructions standing in for a router's swap: a transfer and a memo. */
function swap(): TransactionInstruction[] {
  return [
    SystemProgram.transfer({ fromPubkey: USER, toPubkey: Keypair.generate().publicKey, lamports: 1_000 }),
    new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('the swap goes here') }),
  ]
}

/** A deep snapshot, so a mutation of the caller's objects cannot hide behind identity. */
const snapshot = (ixs: readonly TransactionInstruction[]) =>
  ixs.map((ix) => ({
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data).toString('hex'),
  }))

function assertIsGate(ix: TransactionInstruction) {
  assert.ok(ix.programId.equals(PROGRAM_ID), 'the gate is a BELL instruction')
  assert.ok(Buffer.from(ix.data.subarray(0, 8)).equals(ASSERT_TRADEABLE), 'and it is assert_tradeable')
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [symbolPda(SYMBOL).toBase58(), false, false],
      [riskPda(MINT).toBase58(), false, false],
    ],
    'reads the symbol state and the risk record, signs nothing, writes nothing',
  )
}

test('the gate goes first and the caller\'s instructions follow unchanged', () => {
  const mine = swap()
  const before = snapshot(mine)
  const plan = composeGuarded(gateInstructions({ symbol: SYMBOL, mint: MINT, expectedMultiplierBits: BITS }), mine)

  assert.equal(plan.gateIndex, 0)
  assert.equal(plan.instructions.length, 1 + mine.length)
  assertIsGate(plan.instructions[0]!)
  // The same objects, in the same order: not copies that merely look alike.
  mine.forEach((ix, i) => assert.equal(plan.instructions[1 + i], ix, `instruction ${i} was replaced`))
  assert.deepEqual(snapshot(mine), before, 'the caller\'s instructions were modified')
  assert.equal(mine.length, 2, 'the caller\'s array was modified')
})

test('the gate encodes its symbol, mode and multiplier where the program reads them', () => {
  const [gate] = gateInstructions({ symbol: SYMBOL, mint: MINT, mode: Mode.Guarded, expectedMultiplierBits: BITS })
  const data = Buffer.from(gate!.data)
  // discriminator (8) | symbol [u8; 12] | mode u8 | expected_multiplier_bits u64
  assert.equal(data.length, 29)
  assert.ok(data.subarray(8, 20).equals(Buffer.from(symbolSeed(SYMBOL))))
  assert.equal(data[20], Mode.Guarded)
  assert.equal(new DataView(data.buffer, data.byteOffset).getBigUint64(21, true), BITS)
  // Strict is the default, because the product's promise is the regular session.
  const [strict] = gateInstructions({ symbol: SYMBOL, mint: MINT, expectedMultiplierBits: BITS })
  assert.equal(strict!.data[20], Mode.Strict)
})

test('with a mint re-read, BELL still answers before anything of the caller\'s runs', () => {
  const mine = swap()
  const before = snapshot(mine)
  const plan = composeGuarded(
    gateInstructions({ symbol: SYMBOL, mint: MINT, expectedMultiplierBits: BITS, refreshRisk: true }),
    mine,
  )
  assert.equal(plan.gateIndex, 1)
  const [refresh, gate, ...rest] = plan.instructions
  assert.ok(refresh!.programId.equals(PROGRAM_ID))
  assert.ok(Buffer.from(refresh!.data).equals(REFRESH_TOKEN_RISK))
  assertIsGate(gate!)
  assert.equal(rest.length, mine.length)
  rest.forEach((ix, i) => assert.equal(ix, mine[i]))
  assert.deepEqual(snapshot(mine), before)
})

test('there is no guarded transaction without a gate', () => {
  assert.throws(() => composeGuarded([], swap()), /no gate/)
})

test('a verdict reads the gate, never the caller\'s own failure', () => {
  assert.deepEqual(readVerdict(null, 0), { tradeable: true, reason: null, message: null })

  const closed = readVerdict({ InstructionError: [0, { Custom: 6000 }] }, 0)
  assert.equal(closed.tradeable, false)
  assert.equal(closed.reason, 'MarketClosed')
  assert.equal(closed.message, 'Market is closed or trading in this security is stopped')
  assert.equal(readVerdict({ InstructionError: [0, { Custom: 6026 }] }, 0).reason, 'RiskStale')

  // The caller's swap failing after the gate passed is not a refusal.
  assert.deepEqual(readVerdict({ InstructionError: [1, { Custom: 6000 }] }, 0), {
    tradeable: true,
    reason: null,
    message: null,
  })
  // With a re-read in front, a failure of the re-read is not permission.
  assert.equal(readVerdict({ InstructionError: [0, { Custom: 6007 }] }, 1).reason, 'NotToken2022')
  assert.equal(readVerdict({ InstructionError: [1, { Custom: 6001 }] }, 1).reason, 'StateStale')

  // Accounts that are wrong rather than refused: named, and still not tradeable.
  assert.equal(readVerdict({ InstructionError: [0, { Custom: 3012 }] }, 0).reason, 'AccountNotInitialized')
  assert.equal(readVerdict({ InstructionError: [0, { Custom: 2006 }] }, 0).reason, 'ConstraintSeeds')
  assert.equal(readVerdict({ InstructionError: [0, 'ProgramFailedToComplete'] }, 0).tradeable, false)

  // Nothing ran at all. Not permission either.
  const unrun = readVerdict('AccountNotFound', 0)
  assert.equal(unrun.tradeable, false)
  assert.equal(unrun.reason, '"AccountNotFound"')
})

// ------------------------------------------------------------ with a chain

/** A `SymbolState` account as the program lays it out. */
function symbolStateBytes(o: { mint: PublicKey; attestor: PublicKey; halt: number; openNow: boolean; next: bigint }) {
  const b = Buffer.alloc(108)
  accountDiscriminator('SymbolState').copy(b, 0)
  Buffer.from(symbolSeed(SYMBOL)).copy(b, 8)
  Buffer.from(o.mint.toBytes()).copy(b, 20)
  b.write('ARCX', 52)
  b[56] = 0 // hours mode
  b[57] = o.halt
  b[58] = o.openNow ? 1 : 0
  const d = new DataView(b.buffer, b.byteOffset)
  d.setBigInt64(59, o.next, true)
  d.setBigInt64(67, 1_790_000_000n, true)
  Buffer.from(o.attestor.toBytes()).copy(b, 75)
  b[107] = 255
  return b
}

/** A `TokenRisk` account with no hook and no permanent delegate. */
function tokenRiskBytes(mint: PublicKey, attestor: PublicKey = ATTESTOR) {
  const b = Buffer.alloc(8 + 32 + 1 + 8 + 8 + 8 + 1 + 1 + 1 + 8 + 32 + 1)
  accountDiscriminator('TokenRisk').copy(b, 0)
  Buffer.from(mint.toBytes()).copy(b, 8)
  const d = new DataView(b.buffer, b.byteOffset)
  d.setBigUint64(41, BITS, true)
  // pending (49), activates_at (57), rebase_kind (65), hook: None (66) and
  // permanent delegate: None (67) are all zero.
  d.setBigInt64(68, 1_790_000_000n, true)
  Buffer.from(attestor.toBytes()).copy(b, 76)
  b[108] = 254
  return b
}

const account = (data: Buffer) =>
  ({ data, executable: false, lamports: 1_000_000, owner: PROGRAM_ID }) as AccountInfo<Buffer>

/** A connection that knows one symbol and answers every simulation with `err`. */
function fakeChain(o: {
  err: unknown
  registered?: boolean
  stateMint?: PublicKey
  halt?: number
  simulateThrows?: boolean
  /** No risk record for the mint at all. */
  noRisk?: boolean
  /** The key the risk record names, when it is not the symbol's attestor. */
  riskAttestor?: PublicKey
}) {
  const simulated: VersionedTransaction[] = []
  const conn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => {
        if (k.equals(symbolPda(SYMBOL)) && o.registered !== false) {
          return account(
            symbolStateBytes({
              mint: o.stateMint ?? MINT,
              attestor: ATTESTOR,
              halt: o.halt ?? 0,
              openNow: false,
              next: 1_790_040_000n,
            }),
          )
        }
        if (k.equals(riskPda(MINT)) && !o.noRisk) return account(tokenRiskBytes(MINT, o.riskAttestor))
        return null
      })
    },
    async getAccountInfo(k: PublicKey) {
      return (await conn.getMultipleAccountsInfo([k]))[0]
    },
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }
    },
    async simulateTransaction(tx: VersionedTransaction) {
      if (o.simulateThrows) throw new Error('fetch failed')
      simulated.push(tx)
      return { context: { slot: 1 }, value: { err: o.err, logs: ['Program log: Instruction: AssertTradeable'], unitsConsumed: 6971 } }
    },
  }
  return { conn: conn as unknown as import('@solana/web3.js').Connection, simulated }
}

/** The program ids of a compiled message's instructions, in order. */
const programsOf = (tx: VersionedTransaction) =>
  tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex]!.toBase58())

test('guardInstructions returns the composed transaction and the gate\'s answer', async () => {
  const { conn, simulated } = fakeChain({ err: { InstructionError: [0, { Custom: 6000 }] } })
  const mine = swap()
  const before = snapshot(mine)
  const g = await guardInstructions(conn, { symbol: SYMBOL, mint: MINT, instructions: mine, payer: USER, attestor: ATTESTOR })

  assert.equal(g.gateIndex, 0)
  assertIsGate(g.instructions[0]!)
  mine.forEach((ix, i) => assert.equal(g.instructions[1 + i], ix))
  assert.deepEqual(snapshot(mine), before)

  // The compiled transaction carries the same order, and the user pays for it.
  assert.deepEqual(programsOf(g.transaction), [
    PROGRAM_ID.toBase58(),
    SystemProgram.programId.toBase58(),
    MEMO.toBase58(),
  ])
  assert.ok(g.transaction.message.staticAccountKeys[0]!.equals(USER))
  assert.equal(g.transaction.message.recentBlockhash, g.blockhash)
  // The multiplier the gate was built against is the one the record holds.
  const data = Buffer.from(g.transaction.message.compiledInstructions[0]!.data)
  assert.equal(new DataView(data.buffer, data.byteOffset).getBigUint64(21, true), BITS)

  // Only the gate was simulated for the verdict, with the attestor paying.
  assert.equal(simulated.length, 1)
  assert.deepEqual(programsOf(simulated[0]!), [PROGRAM_ID.toBase58()])
  assert.ok(simulated[0]!.message.staticAccountKeys[0]!.equals(ATTESTOR))

  assert.equal(g.verdict.tradeable, false)
  assert.equal(g.verdict.reason, 'MarketClosed')
  assert.equal(g.verdict.waitsForOpen, true, 'closed with no halt is what a bell order is for')
  assert.equal(g.verdict.session.nextChangeAt, 1_790_040_000)
  assert.equal(g.verdict.unitsConsumed, 6971)
})

test('a halt refuses as MarketClosed but is not a wait for the open', async () => {
  const { conn } = fakeChain({ err: { InstructionError: [0, { Custom: 6000 }] }, halt: 5 })
  const g = await guardInstructions(conn, { symbol: SYMBOL, mint: MINT, instructions: swap(), payer: USER })
  assert.equal(g.verdict.reason, 'MarketClosed')
  assert.equal(g.verdict.waitsForOpen, false)
  assert.equal(g.verdict.session.halt, 5)
})

test('an allowed gate, with a re-read in front of it', async () => {
  const { conn, simulated } = fakeChain({ err: null })
  const g = await guardInstructions(conn, {
    symbol: SYMBOL,
    mint: MINT,
    instructions: swap(),
    payer: USER,
    mode: Mode.Guarded,
    refreshRisk: true,
  })
  assert.equal(g.gateIndex, 1)
  assert.deepEqual(programsOf(g.transaction).slice(0, 2), [PROGRAM_ID.toBase58(), PROGRAM_ID.toBase58()])
  assert.equal(programsOf(simulated[0]!).length, 2, 'the re-read is simulated with the gate it feeds')
  assert.equal(g.verdict.tradeable, true)
  assert.equal(g.verdict.waitsForOpen, false)
})

test('a simulation that cannot run reads not tradeable, and the gate still ships', async () => {
  const { conn } = fakeChain({ err: null, simulateThrows: true })
  const g = await guardInstructions(conn, { symbol: SYMBOL, mint: MINT, instructions: swap(), payer: USER })
  assert.equal(g.verdict.tradeable, false)
  assert.equal(g.verdict.reason, 'Unavailable')
  assert.equal(programsOf(g.transaction)[0], PROGRAM_ID.toBase58())
})

test('it will not build a transaction that guards the wrong thing', async () => {
  const other = Keypair.generate().publicKey
  await assert.rejects(
    guardInstructions(fakeChain({ err: null, registered: false }).conn, {
      symbol: SYMBOL,
      mint: MINT,
      instructions: swap(),
      payer: USER,
    }),
    /not registered/,
  )
  await assert.rejects(
    guardInstructions(fakeChain({ err: null, stateMint: other }).conn, {
      symbol: SYMBOL,
      mint: MINT,
      instructions: swap(),
      payer: USER,
    }),
    /is bound to mint/,
  )
  await assert.rejects(
    guardInstructions(fakeChain({ err: null }).conn, {
      symbol: SYMBOL,
      mint: MINT,
      instructions: swap(),
      payer: USER,
      attestor: other,
    }),
    /you pinned/,
  )
  await assert.rejects(
    guardInstructions(fakeChain({ err: null, noRisk: true }).conn, {
      symbol: SYMBOL,
      mint: MINT,
      instructions: swap(),
      payer: USER,
    }),
    /no risk record/,
  )
  // The symbol's attestor is the pinned one, but the key that labels rebases
  // on the mint's record is not: check 4b would be trusting a stranger.
  await assert.rejects(
    guardInstructions(fakeChain({ err: null, riskAttestor: other }).conn, {
      symbol: SYMBOL,
      mint: MINT,
      instructions: swap(),
      payer: USER,
      attestor: ATTESTOR,
    }),
    /risk record is attested by/,
  )
})

test('guarded() still hands back a legacy transaction with the gate at 0', async () => {
  const { conn } = fakeChain({ err: null })
  const mine = swap()
  const plan = await guarded({ conn, payer: USER, symbol: SYMBOL, mint: MINT, instructions: mine })
  assert.equal(plan.gateIndex, 0)
  assertIsGate(plan.transaction.instructions[0]!)
  assert.equal(plan.transaction.instructions.length, 1 + mine.length)
  mine.forEach((ix, i) => assert.equal(plan.transaction.instructions[1 + i], ix))
})
