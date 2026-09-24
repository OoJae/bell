/**
 * A `cross_orders` transaction for the tape-route and alerts tests, built from
 * the real buy the way `sell-fill.ts` builds its sell.
 *
 * No cross has landed on devnet yet, so there is none to replay. This takes
 * the hosted crank's buy of 23 September, exactly as `getTransaction` returned
 * it, and changes what a cross changes: the instruction's discriminator (it
 * has no arguments) and its nineteen accounts in the IDL's order, the log line
 * naming the instruction, the authority on the stock transfer, the token
 * balances, and the event. The recorded buyer stays the buyer, with its order,
 * delegate authority and token accounts; the filler's two token accounts
 * become a new seller's; and the crank, which sent the buy, sends the cross.
 * The two transfers keep their recorded order, stock first and then quote,
 * which is the order cross.rs moves them in.
 *
 * The event is `OrdersCrossed` in the layout the IDL gives (121 bytes). Its
 * symbol and its mark (price, exponent, source and observation time) are the
 * recorded payload's own bytes, which sit at the same offsets in both events,
 * so the cross prices at the very mark the buy did.
 *
 * No imports from `src/config.ts`, directly or through the chain client, for
 * the reason `sell-fill.ts` gives.
 */
import { PublicKey } from '@solana/web3.js'
import idl from '../../src/chain/idl.json' with { type: 'json' }
import type { RpcTransaction } from '../../web/lib/tape.ts'
import { BUY, OWNER, toBase58 } from './sell-fill.ts'

/** The buyer: the recorded buy's owner. */
export const BUYER = OWNER
/** A made-up seller, 32 fixed bytes, and its SPYx and demo-USDC accounts. */
export const SELLER = 'EWmDvi3hhz86LYi2NcD6YUp18DeeB5gDkwJzde3MgF9A'
const SELLER_STOCK = '7kuT1dfMhUysWcLEV1eYk8ir7RTjszHmsUdrrPQNThcv'
const SELLER_QUOTE = '549dHb2x3Z6ovzKw34bo77rLM53gwSpyX9ycXBcQaNie'
/** The hosted crank: the recorded buy's filler and fee payer, who sends the cross and takes no part in it. */
export const CRANKER = '4v5r4eSnB7kmnAmJ6ia9X1Mhu7tZKpznLb3x5PdMjtN2'

/**
 * $200 of demo-USDC against the seller's share, at the recorded mark
 * ($772.617876 a share, multiplier 1.005714560286254, 8 decimals against 6).
 * The buy binds, and the buyer receives floor(quote × rate): what
 * `codec.crossAmounts` gives for these two orders, as test_cross.rs works it.
 */
export const CROSS_QUOTE = 200_000_000n
export const CROSS_STOCK = 25_738_931n
export const CROSS_SIG = '4CRoSSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
/** Two minutes after the buy, and a minute after the sell `sell-fill.ts` makes. */
export const CROSS_TIME = BUY.blockTime! + 120

const PROGRAM = new PublicKey(idl.address)
const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0].toBase58()
const text = (s: string) => new TextEncoder().encode(s)
const SYMBOL_SEED = text('SPYx'.padEnd(12, ' '))
/** The seller's sell order, nonce 7, and its delegate authority and the symbol's check, by the program's seeds. */
export const SELL_ORDER = pda(text('sell'), new PublicKey(SELLER).toBytes(), new Uint8Array(8).fill(7))
const SELL_AUTH = pda(text('auth'), new PublicKey(SELLER).toBytes())
const CHECK = pda(text('check'), SYMBOL_SEED)

const DATA = 'Program data: '
const disc = (kind: 'instructions' | 'events', name: string): Uint8Array => {
  const found = (idl[kind] as { name: string; discriminator: number[] }[]).find((x) => x.name === name)
  if (!found) throw new Error(`${name} missing from the IDL`)
  return Uint8Array.from(found.discriminator)
}

/**
 * `OrdersCrossed` for these parties and amounts, on the recorded payload's
 * symbol and mark. `OrderFilled` is discriminator 8, symbol 12, owner 32,
 * filler 32, amount_in and amount_out, then the mark from offset 100;
 * `OrdersCrossed` is discriminator 8, symbol 12, buyer 32, seller 32, quote and
 * stock, then the same mark fields from the same offset.
 */
export function crossEvent(buyer = BUYER, seller = SELLER, quote = CROSS_QUOTE, stock = CROSS_STOCK): string {
  const real = Uint8Array.from(Buffer.from(BUY.meta!.logMessages!.find((l) => l.startsWith(DATA))!.slice(DATA.length), 'base64'))
  const b = new Uint8Array(121)
  b.set(disc('events', 'OrdersCrossed'), 0)
  b.set(real.subarray(8, 20), 8)
  b.set(new PublicKey(buyer).toBytes(), 20)
  b.set(new PublicKey(seller).toBytes(), 52)
  const d = new DataView(b.buffer)
  d.setBigUint64(84, quote, true)
  d.setBigUint64(92, stock, true)
  b.set(real.subarray(100, 121), 100)
  return Buffer.from(b).toString('base64')
}

/** The recorded buy rewritten as a cross of its buyer's order against `SELLER`'s. */
export function crossFill(): RpcTransaction {
  const t = structuredClone(BUY)
  t.blockTime = CROSS_TIME
  t.slot += 300
  t.transaction.signatures[0] = CROSS_SIG

  const keys = t.transaction.message.accountKeys
  const was = t.transaction.message.instructions[1]!
  // The recorded fill_order's accounts by name: filler, order, symbol_state,
  // risk, mark, auth, owner, payer_in, payee_out, filler_in, filler_out,
  // quote_mint, stock_mint and the two token programs. On a buy the filler
  // takes quote in (filler_in) and pays stock out (filler_out).
  const [filler, order, symbolState, risk, mark, auth, owner, payerIn, payeeOut, fillerIn, fillerOut, quoteMint, stockMint, quoteProgram, stockProgram] =
    was.accounts
  // The filler's token accounts become the seller's; the rest are added.
  keys[fillerOut!] = SELLER_STOCK
  keys[fillerIn!] = SELLER_QUOTE
  const add = (k: string) => keys.push(k) - 1
  const at: Record<string, number> = {
    cranker: filler!,
    buy: order!,
    sell: add(SELL_ORDER),
    symbol_state: symbolState!,
    risk: risk!,
    mark: mark!,
    check: add(CHECK),
    buy_auth: auth!,
    sell_auth: add(SELL_AUTH),
    buyer: owner!,
    seller: add(SELLER),
    buyer_quote: payerIn!,
    buyer_stock: payeeOut!,
    seller_stock: fillerOut!,
    seller_quote: fillerIn!,
    quote_mint: quoteMint!,
    stock_mint: stockMint!,
    quote_token_program: quoteProgram!,
    stock_token_program: stockProgram!,
  }
  const ix = idl.instructions.find((i) => i.name === 'cross_orders')!
  was.accounts = ix.accounts.map((a) => {
    const i = at[a.name]
    if (i === undefined) throw new Error(`cross_orders account ${a.name} not placed`)
    return i
  })
  was.data = toBase58(disc('instructions', 'cross_orders'))

  // The stock leg is the seller's, moved by the seller's delegate authority;
  // the quote leg is the buyer's, moved by the buyer's, as it was.
  const [stockLeg] = t.meta!.innerInstructions![0]!.instructions
  stockLeg!.accounts = [at.seller_stock!, at.stock_mint!, at.buyer_stock!, at.sell_auth!]

  t.meta!.logMessages = t.meta!.logMessages!.map((l) =>
    l === 'Program log: Instruction: FillOrder'
      ? 'Program log: Instruction: CrossOrders'
      : l.startsWith(DATA)
        ? `${DATA}${crossEvent()}`
        : l,
  )

  // Balances: the buyer pays the quote and receives the stock, the seller the reverse.
  interface Balance {
    accountIndex: number
    mint: string
    owner: string
    uiTokenAmount: { amount: string; decimals: number; uiAmount: number; uiAmountString: string }
  }
  const moved: Record<number, { owner: string; delta: bigint }> = {
    [at.buyer_quote!]: { owner: BUYER, delta: -CROSS_QUOTE },
    [at.buyer_stock!]: { owner: BUYER, delta: CROSS_STOCK },
    [at.seller_stock!]: { owner: SELLER, delta: -CROSS_STOCK },
    [at.seller_quote!]: { owner: SELLER, delta: CROSS_QUOTE },
  }
  const pre = t.meta!.preTokenBalances as unknown as Balance[]
  const post = t.meta!.postTokenBalances as unknown as Balance[]
  pre.forEach((b, i) => {
    const m = moved[b.accountIndex]
    const after = post[i]
    if (!m || after?.accountIndex !== b.accountIndex) throw new Error(`unexpected balance at ${b.accountIndex}`)
    b.owner = after.owner = m.owner
    const amount = BigInt(b.uiTokenAmount.amount) + m.delta
    const ui = Number(amount) / 10 ** b.uiTokenAmount.decimals
    after.uiTokenAmount = { amount: amount.toString(), decimals: b.uiTokenAmount.decimals, uiAmount: ui, uiAmountString: String(ui) }
  })
  return t
}
