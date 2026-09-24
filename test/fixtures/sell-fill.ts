/**
 * A `fill_sell_order` transaction for the tape tests, built from the real one.
 *
 * The program with sell orders is not on devnet yet, so there is no recorded
 * sell to replay. This takes the hosted crank's buy of 23 September, exactly
 * as `getTransaction` returned it, and changes only what a sell changes: the
 * instruction's discriminator and arguments, the order of the two token
 * transfers (a sell pays quote first, then takes the stock), the log line
 * naming the instruction, the order's address, and the event. The event keeps
 * the real payload's bytes, symbol, owner, filler and mark included, and
 * swaps in `SellOrderFilled`'s discriminator and a sell's amounts, so it is the
 * layout the program emits rather than one written for the test.
 *
 * No imports from `src/config.ts`, directly or through the chain client: the
 * route test sets the cluster before anything reads it, and this module is
 * loaded alongside.
 */
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import idl from '../../src/chain/idl.json' with { type: 'json' }
import type { RpcTransaction } from '../../web/lib/tape.ts'

export const BUY: RpcTransaction = JSON.parse(
  readFileSync(new URL('./fill-2026-09-23-5mj8qK.json', import.meta.url), 'utf8'),
) as RpcTransaction
export const BUY_SIG = BUY.transaction.signatures[0]!
/** The buyer of the recorded fill, and the seller of the made-up one. */
export const OWNER = '9wNeE9MRMa8SwH6BAmYw9cDnvwReGUgnEcxNmpsCbeEJ'

/**
 * The same 25,661,713 raw SPYx the buy received, sold back at that fill's own
 * mark ($772.617876 a share, multiplier 1.005714560286254). Fair value there is
 * 199,399,991 quote raw, rounded up as `fill_sell_order` rounds it; the 30bps
 * band edge, rounded up again, is 198,801,792.
 */
export const STOCK_SOLD = 25_661_713n
export const QUOTE_PAID = 198_801_792n
export const SELL_SIG = '3SeLLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
/** A minute after the buy. */
export const SELL_TIME = BUY.blockTime! + 60
/** A sell order's address: its own seed, so it is not the buy's order. */
export const SELL_ORDER = PublicKey.findProgramAddressSync(
  [Buffer.from('sell'), new PublicKey(OWNER).toBytes(), new Uint8Array(8).fill(7)],
  new PublicKey(idl.address),
)[0].toBase58()

const DATA = 'Program data: '
const disc = (kind: 'instructions' | 'events', name: string): Uint8Array => {
  const found = (idl[kind] as { name: string; discriminator: number[] }[]).find((x) => x.name === name)
  if (!found) throw new Error(`${name} missing from the IDL`)
  return Uint8Array.from(found.discriminator)
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** Base58, as instruction data travels in the RPC's `json` encoding. */
export function toBase58(b: Uint8Array): string {
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

/**
 * The recorded `OrderFilled` payload with another event's discriminator and a
 * sell's amounts. Offsets from state.rs: discriminator 8, symbol 12, owner 32,
 * filler 32, then amount_in at 84, amount_out at 92, and realized_bps at 121.
 */
export function fillEvent(event: 'OrderFilled' | 'SellOrderFilled', amountIn: bigint, amountOut: bigint, realizedBps: number): string {
  const real = BUY.meta!.logMessages!.find((l) => l.startsWith(DATA))!.slice(DATA.length)
  const b = Uint8Array.from(Buffer.from(real, 'base64'))
  if (b.length !== 123) throw new Error(`unexpected event length ${b.length}`)
  b.set(disc('events', event), 0)
  const d = new DataView(b.buffer)
  d.setBigUint64(84, amountIn, true)
  d.setBigUint64(92, amountOut, true)
  d.setUint16(121, realizedBps, true)
  return Buffer.from(b).toString('base64')
}

/**
 * The buy rewritten as a sell. `instruction` and `event` can be set to the buy
 * side's names to build the mismatched pairs the tape must refuse.
 */
export function sellFill(
  opts: { instruction?: 'fill_sell_order' | 'fill_order'; event?: 'SellOrderFilled' | 'OrderFilled' } = {},
): RpcTransaction {
  const t = structuredClone(BUY)
  t.blockTime = SELL_TIME
  t.slot += 150
  t.transaction.signatures[0] = SELL_SIG

  const fill = t.transaction.message.instructions[1]!
  // The order account is named at the same position in both instructions.
  t.transaction.message.accountKeys[fill.accounts[1]!] = SELL_ORDER
  const args = new Uint8Array(16)
  new DataView(args.buffer).setBigUint64(0, STOCK_SOLD, true)
  new DataView(args.buffer).setBigUint64(8, QUOTE_PAID, true)
  const ixDisc = disc('instructions', opts.instruction ?? 'fill_sell_order')
  fill.data = toBase58(Uint8Array.from([...ixDisc, ...args]))

  // A sell delivers quote first (SPL Token) and takes stock second
  // (Token-2022), the reverse of the recorded buy: reverse both the inner
  // instructions and their log frames, so the logs still line up with them.
  t.meta!.innerInstructions![0]!.instructions.reverse()
  const logs = t.meta!.logMessages!
  const at = (prefix: string) => logs.findIndex((l) => l.startsWith(prefix))
  const stock = logs.slice(at('Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke'), at('Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke'))
  const quote = logs.slice(at('Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke'), at(DATA))
  const head = logs.slice(0, at('Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke'))
  const tail = logs.slice(at(DATA) + 1)
  t.meta!.logMessages = [
    ...head.map((l) => (l === 'Program log: Instruction: FillOrder' ? 'Program log: Instruction: FillSellOrder' : l)),
    ...quote,
    ...stock,
    `${DATA}${fillEvent(opts.event ?? 'SellOrderFilled', STOCK_SOLD, QUOTE_PAID, 30)}`,
    ...tail,
  ]
  return t
}
