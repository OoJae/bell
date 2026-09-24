/**
 * The filler.
 *
 *   node scripts/crank.ts            # report what it would do
 *   BELL_ARM=1 node scripts/crank.ts # settle due orders
 *   BELL_GC=1                        # also close expired / unfunded orders (rent to their owners)
 *
 * Deliberately not privileged: it re-runs the identical on-chain gate that
 * refused the trade in the first place, and it is paid by the spread rather
 * than by a tip. Anyone can run this, which is the point — the venue does not
 * depend on our server. We happen to run it every five minutes as a Railway
 * cron job, so "filled at the opening bell" is true without anyone at a
 * keyboard; delete that service and nothing else changes.
 *
 * Built to be run unattended: one pass, a watchdog so it can never hang (a
 * cron run still active makes every later run skip), every order in its own
 * try/catch so one rate-limited read cannot end the pass for everybody, and
 * everything knowable is read in one round trip so orders that are certainly
 * refused are never simulated at all.
 *
 * On localnet it settles from inventory conjured at genesis. On devnet from
 * the filler's associated accounts, minted from mirror mints we control. On
 * mainnet the same loop would swap through Jupiter in its own transaction
 * first, which is why the program never needs to CPI a router.
 */
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js'
import {
  authPda,
  connect,
  errorName,
  ixCancelOrder,
  ixFillOrder,
  ixRefreshTokenRisk,
  readBoard,
  readOrders,
  send,
  simulate,
  TOKEN_PROGRAM,
  TOKEN_2022,
} from '../src/chain/client.ts'
import {
  fairOut,
  MAX_MARK_AGE_SECONDS,
  MAX_STATE_AGE_SECONDS,
  multiplierOf,
  type BellOrder,
  type SymbolMark,
} from '../src/chain/codec.ts'
import { loadKeypair } from '../src/chain/keys.ts'
import { ataFor, decodeTokenAccount } from '../src/chain/spl.ts'
import { CLUSTER } from '../src/config.ts'
import { minutesAfterBell, notify, type NotifyEvent } from '../src/notify.ts'

// A pass that is still running when the next cron tick arrives makes Railway
// skip that tick, so a hung RPC call would silently stop filling altogether.
setTimeout(() => {
  console.error('watchdog: pass exceeded 240s, exiting')
  process.exit(2)
}, 240_000).unref()

const FILLER_PATH = process.env.BELL_FILLER_KEYPAIR ?? '.filler.json'
const arm = process.env.BELL_ARM === '1'
const gc = process.env.BELL_GC === '1'

const conn = connect()
const filler = loadKeypair(FILLER_PATH)

/**
 * Where this filler keeps inventory for a given mint.
 *
 * Localnet: a PDA of a nonexistent program, conjured at genesis by
 * `localnet.sh`'s `--account` flags — the real issuers hold the mint authority
 * on the real mints, so there is no way to mint a test holding. That address
 * cannot exist anywhere else. Devnet: an ordinary associated account, because
 * we hold the mirror mint authorities and simply minted the stock.
 */
function inventoryFor(mint: PublicKey): PublicKey {
  if (CLUSTER === 'devnet') return ataFor(filler.publicKey, mint, TOKEN_2022)
  return PublicKey.findProgramAddressSync(
    [Buffer.from('inv'), filler.publicKey.toBytes(), mint.toBytes()],
    new PublicKey('11111111111111111111111111111112'),
  )[0]
}

/** The quote account the filler is paid into; overridable, defaults to its ATA. */
const fillerInFor = (quoteMint: PublicKey) =>
  process.env.BELL_FILLER_QUOTE ? new PublicKey(process.env.BELL_FILLER_QUOTE) : ataFor(filler.publicKey, quoteMint)

const line = (o: BellOrder, what: string) => console.log(`  ${o.symbol.padEnd(7)} ${what}`)

/**
 * Notifications in flight. Sent as each fill lands rather than awaited there,
 * so a slow Telegram never holds up the next order, and awaited once before the
 * process exits so that `process.exit` does not cut them off. `notify` never
 * rejects and gives up after a few seconds, which bounds that last wait.
 */
const notices: Promise<void>[] = []
/**
 * Takes the event as a function so that building it is inside the guard too.
 * It runs after the transaction has landed, inside the order's try, and a throw
 * there would print "error" beneath a fill that happened.
 */
function tell(build: () => NotifyEvent): void {
  try {
    notices.push(notify(build(), { cluster: CLUSTER }))
  } catch (e) {
    console.error(`  notify: skipped: ${(e as Error).message}`)
  }
}
/** What the quote mint is called here; the devnet one is BELL's own token, not USDC. */
const QUOTE = CLUSTER === 'mainnet' ? 'USDC' : 'demo-USDC'

/** Returns the fill's signature, or null when it was refused or this is a dry run. */
async function fillOne(o: BellOrder, deliver: bigint, remaining: bigint): Promise<string | null> {
  // Re-read the mint in the same transaction as the fill, so the gate judges a
  // multiplier, pause or hook as it stands at settlement — not as the last
  // refresh left it.
  const ixs = [
    ixRefreshTokenRisk(o.mint),
    ixFillOrder({
      filler: filler.publicKey,
      order: o,
      fillerIn: fillerInFor(o.quoteMint),
      fillerOut: inventoryFor(o.mint),
      amountInLeg: remaining,
      amountOut: deliver,
      quoteTokenProgram: TOKEN_PROGRAM,
      stockTokenProgram: TOKEN_2022,
    }),
  ]

  // Simulate first: it is the authoritative check, and it costs nothing. The
  // node's own blockhash, so a load-balanced RPC cannot turn a fillable order
  // into "BlockhashNotFound" and skip it until the next pass.
  const sim = await simulate(conn, ixs, filler.publicKey)
  if (sim.value.err) {
    const e = sim.value.err as { InstructionError?: [number, { Custom?: number }] }
    const code = e.InstructionError?.[1]?.Custom
    line(o, `REFUSED  ${code !== undefined ? errorName(code) : JSON.stringify(sim.value.err)}`)
    return null
  }
  if (!arm) {
    line(o, `would fill ${Number(remaining) / 1e6} quote -> ${deliver} raw (${o.maxSlipBps}bps band)`)
    return null
  }
  // `send()` retries transient failures by re-signing. Safe for a fill: an order
  // can only be filled once — a second attempt meets OverFill or a closed
  // account and is rejected in preflight before it costs anything.
  const sig = await send(conn, ixs, [filler])
  line(o, `FILLED ${Number(remaining) / 1e6} quote -> ${deliver} raw  sig=${sig}`)
  return sig
}

async function main() {
  // Orders first. Most passes find none, and then this is a single RPC call.
  const orders = await readOrders(conn)
  console.log(`crank — ${CLUSTER} — ${arm ? 'SETTLING' : 'dry run'} — ${orders.length} order(s)`)
  if (orders.length === 0) return

  // Everything else in one round trip: each symbol in the book, each order's
  // quote account, the filler's inventory, the cluster's clock — time comes
  // from the chain, because that is what the program will judge us by — and
  // each symbol's mint, whose decimals turn a delivered amount into shares for
  // the fill notice.
  const listings = [...new Map(orders.map((o) => [o.symbol, { symbol: o.symbol, mint: o.mint.toBase58() }])).values()]
  const extra = [
    SYSVAR_CLOCK_PUBKEY,
    ...orders.map((o) => o.payerIn),
    ...orders.map((o) => inventoryFor(o.mint)),
    ...listings.map((l) => new PublicKey(l.mint)),
  ]
  const { symbols, extras } = await readBoard(conn, listings, extra)
  const clock = extras[0]
  const now = clock ? Number(new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(32, true)) : Math.floor(Date.now() / 1000)
  const payers = extras.slice(1, 1 + orders.length)
  const inventories = extras.slice(1 + orders.length, 1 + 2 * orders.length)
  // Byte 44 of an SPL mint, Token-2022 included, is its decimals.
  const decimalsOf = new Map(
    listings.map((l, i) => [l.symbol, extras[1 + 2 * orders.length + i]?.data[44]] as const),
  )

  // The pass can outlive a mark, so "now" advances with the wall clock from the
  // chain's reading rather than staying frozen at the start.
  const t0 = Date.now()
  const chainNow = () => now + Math.floor((Date.now() - t0) / 1000)
  // Symbols whose mark this pass already waited on: a later order for the same
  // symbol uses what that wait found instead of sitting out another 70s. Three
  // orders each waiting afresh was enough to hit the watchdog.
  const waited = new Map<string, SymbolMark | null>()

  for (const [i, o] of orders.entries()) {
    try {
      const remaining = o.amountIn - o.filledIn
      const acc = symbols.get(o.symbol)
      const state = acc?.state
      const payer = payers[i] ? decodeTokenAccount(payers[i]!.data) : null
      const inventory = inventories[i] ? decodeTokenAccount(inventories[i]!.data) : null

      const expired = now >= Number(o.expiresAt)
      const defunded =
        !payer ||
        !payer.delegate?.equals(authPda(o.owner)) ||
        payer.delegatedAmount < remaining

      // Dead orders: the owner revoked (their cancel), spent the delegation
      // elsewhere, or let it expire. Anyone may close these, rent returns to
      // the owner, and closing them keeps the book honest.
      if (expired || defunded) {
        const why = expired ? 'expired' : 'no longer funded (revoked or re-approved elsewhere)'
        if (!gc) {
          line(o, `dead — ${why}`)
          continue
        }
        if (!arm) {
          line(o, `would close — ${why}; rent to the owner`)
          continue
        }
        const sig = await send(
          conn,
          [ixCancelOrder({ signer: filler.publicKey, owner: o.owner, nonce: o.nonce, payerIn: o.payerIn })],
          [filler],
        )
        line(o, `CLOSED — ${why}; rent returned to owner  sig=${sig}`)
        tell(() => ({ kind: 'closed', symbol: o.symbol, owner: o.owner.toBase58(), why, signature: sig }))
        continue
      }
      if (now < Number(o.notBefore)) {
        line(o, 'not due yet')
        continue
      }

      // Certain refusals, known from the accounts already in hand. Simulating
      // these would only confirm what the chain already says.
      if (!state) {
        line(o, 'symbol not registered here')
        continue
      }
      const age = now - Number(state.observedAt)
      if (age > MAX_STATE_AGE_SECONDS) {
        line(o, `waiting — attestation ${age}s old (StateStale)`)
        continue
      }
      if (state.halt !== 0) {
        line(o, 'waiting — halted (MarketClosed)')
        continue
      }
      if (!state.openNow) {
        line(o, 'waiting — market closed; parks until the bell (MarketClosed)')
        continue
      }
      // Built against a multiplier that is no longer in force: the gate will
      // refuse it for as long as it lives. Only its owner can close it (it is
      // still funded), so say so rather than simulating it every pass.
      if (acc?.risk && acc.risk.multiplierBits !== o.expectedMultiplierBits) {
        line(o, 'dead — a corporate action changed its size (MultiplierMoved); the owner can cancel to reclaim rent')
        continue
      }
      if (payer && payer.amount < remaining) {
        line(o, 'waiting — the owner no longer holds the funds this order would spend')
        continue
      }

      // A price has to be fresh at settlement, and the keeper's marks land
      // every ~45-60s — so a mark read at a random moment is often most of a
      // minute old. Rather than eat MarkStale, wait for the next one to land.
      let mark = waited.has(o.symbol) ? waited.get(o.symbol) : acc?.mark
      if (!mark || mark.observedAt === 0n) {
        line(o, waited.has(o.symbol) ? 'waiting — no fresh mark arrived this pass' : 'no mark — cannot price, so cannot fill')
        continue
      }
      if (chainNow() - Number(mark.observedAt) > MAX_MARK_AGE_SECONDS - 10) {
        const seenAt = mark.observedAt
        const until = Date.now() + 70_000
        let fresh: SymbolMark | null = null
        while (Date.now() < until) {
          await new Promise((r) => setTimeout(r, 5_000))
          const next = (await readBoard(conn, [listings.find((l) => l.symbol === o.symbol)!])).symbols.get(o.symbol)?.mark
          if (next && next.observedAt !== seenAt) {
            fresh = next
            break
          }
        }
        waited.set(o.symbol, fresh)
        if (!fresh) {
          line(o, 'waiting — no fresh mark arrived this pass')
          continue
        }
        mark = fresh
      }

      // Deliver the band edge, which is why max_slip_bps is the user's maximum
      // cost rather than a tolerance — or the user's own floor, when their
      // limit asks for more stock than the band does. The program takes the
      // larger of the two as its minimum, computed exactly as here.
      const fair = fairOut(remaining, mark.rateQ64)
      const band = (fair * BigInt(10_000 - o.maxSlipBps)) / 10_000n
      const floor = fairOut(remaining, o.floorRateQ64)
      // A limit below the market asks for more stock than the price gives:
      // filling it would sell below the mark, so it waits for the price to
      // come down to it, as a limit order does.
      if (floor > fair) {
        line(o, `waiting — its limit is below the market (asks ${floor} raw; the price gives ${fair})`)
        continue
      }
      const deliver = floor > band ? floor : band

      // A short filler is the filler's problem, and saying so matters: the
      // token program would report it as insufficient funds, which reads as
      // though the *user* were short.
      if (!inventory || inventory.amount < deliver) {
        line(o, `filler short of ${o.symbol} inventory — not the owner's fault`)
        continue
      }

      const sig = await fillOne(o, deliver, remaining)
      if (sig) {
        // Shares as the page counts them: raw ÷ 10^decimals × the scaled-UI
        // multiplier. The order's own multiplier is exact here, because gate 5
        // refuses any fill where the one in force differs from it.
        const decimals = decimalsOf.get(o.symbol)
        tell(() => ({
          kind: 'fill',
          symbol: o.symbol,
          amountIn: Number(remaining) / 1e6,
          quote: QUOTE,
          shares:
            decimals === undefined
              ? null
              : (Number(deliver) / 10 ** decimals) * multiplierOf(o.expectedMultiplierBits),
          minutesAfterBell: minutesAfterBell(chainNow()),
          owner: o.owner.toBase58(),
          signature: sig,
        }))
      }
    } catch (e) {
      // One failure is one order's problem, not the whole pass's.
      line(o, `error — ${(e as Error).message.split('\n')[0]}`)
    }
  }
}

try {
  await main()
  await Promise.all(notices)
  process.exit(0)
} catch (e) {
  console.error(`crank failed: ${(e as Error).message}`)
  await Promise.all(notices)
  process.exit(1)
}
