/**
 * Demo funds for a fresh devnet wallet — the only server-side code BELL runs
 * for the page.
 *
 * Without it a judge who connects a wallet can do nothing: devnet, zero SOL,
 * and zero of a demo asset they have no other way to get. It is deliberately
 * not in the order, fill or cancel path; it hands out test money and nothing
 * else.
 *
 * **Custody.** The faucet key owns a *pool* — a token account holding
 * demo-USDC, transferred in from the deploy wallet — and a little SOL. It is
 * not the quote mint's mint authority. `open_mark` welded the quote mint into
 * all nine marks permanently, so a hot key holding the mint authority could, if
 * leaked, reassign it away from us for good. A leaked pool key can lose at most
 * its balance, and the deploy wallet can refill a new pool from offline.
 *
 * **Bounds, without a database.** Eligibility is read from the chain, so it
 * survives restarts: a wallet already holding enough gets nothing. On top of
 * that, in-memory limits per address, per IP and per day, one grant in flight
 * per address, and floors below which the faucet stops rather than empties.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { ataFor, decodeTokenAccount, ixCreateAtaIdempotent, ixTransferChecked } from '../../src/chain/spl.ts'
import { CLUSTER } from '../../src/config.ts'

if (typeof window !== 'undefined') throw new Error('faucet.ts is server-only')

const QUOTE_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_BELL_QUOTE_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
)
const QUOTE_DECIMALS = 6

/** 1,000 demo-USDC: exactly one maximum-size order (`MAX_ORDER_IN`). */
const GRANT_QUOTE = 1_000n * 10n ** BigInt(QUOTE_DECIMALS)
/**
 * 0.012 SOL: three first-time orders in new symbols plus their cancels, over
 * the rent-exempt minimum for the wallet itself. Measured on devnet — a stock
 * account 1.56M lamports, an order account 2.00M, a fee 5k.
 */
const GRANT_LAMPORTS = 12_000_000

/** Below these the wallet is considered already funded. */
const HAS_ENOUGH_QUOTE = 100n * 10n ** BigInt(QUOTE_DECIMALS)
const HAS_ENOUGH_LAMPORTS = 5_000_000

/**
 * What the faucet keeps back for itself — its own rent-exempt minimum plus
 * fees — on top of whatever a grant costs. It is charged per grant, for what
 * that grant actually sends: a flat 0.05 SOL floor used to refuse even a
 * quote-only grant, which costs the faucet a fee and at most one account's
 * rent, whenever it held less than that.
 */
const RESERVE_LAMPORTS = 10_000_000
/** A new quote account's rent, as an upper bound (mainnet's rate; devnet is lower). */
const QUOTE_ACCOUNT_RENT = 2_039_280
const FEE_LAMPORTS = 10_000
const FLOOR_QUOTE = GRANT_QUOTE

const HOUR = 3_600_000
/**
 * No hourly cap: ten grants an hour globally meant one person with a script
 * could lock every judge out for the rest of it. Per address and per IP bound
 * any one visitor; the daily cap bounds the pool.
 */
const LIMITS = {
  perAddress: { n: 1, window: 12 * HOUR },
  perIp: { n: 5, window: 24 * HOUR },
  perDay: { n: 200, window: 24 * HOUR },
}

/** In-memory ledger of recent grants. Resets on redeploy; one replica. */
const seen = new Map<string, number[]>()
/** Addresses with a grant in progress — per address, so one slow grant does not queue everybody. */
const inFlight = new Set<string>()

function allowed(key: string, limit: { n: number; window: number }, now: number): boolean {
  const recent = (seen.get(key) ?? []).filter((t) => now - t < limit.window)
  seen.set(key, recent)
  return recent.length < limit.n
}
function record(keys: string[], now: number) {
  for (const k of keys) seen.set(k, [...(seen.get(k) ?? []), now])
}
/** A grant that certainly did not land should not count against anyone. */
function unrecord(keys: string[], now: number) {
  for (const k of keys) {
    const list = seen.get(k) ?? []
    const i = list.lastIndexOf(now)
    if (i >= 0) list.splice(i, 1)
  }
}

function faucetKey(): Keypair | null {
  const raw = process.env.BELL_KEY_FAUCET
  if (!raw) return null
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
}

export interface GrantResult {
  status: number
  body: { ok: boolean; message: string; signature?: string }
  retryAfter?: number
}

const refuse = (status: number, message: string, retryAfter?: number): GrantResult => ({
  status,
  body: { ok: false, message },
  retryAfter,
})

export async function grant(args: { owner: unknown; ip: string }): Promise<GrantResult> {
  if (CLUSTER !== 'devnet') return refuse(404, 'The faucet only exists on devnet.')
  const faucet = faucetKey()
  if (!faucet) return refuse(503, 'The faucet is not configured right now.')

  let owner: PublicKey
  try {
    owner = new PublicKey(String(args.owner))
  } catch {
    return refuse(400, 'That is not a Solana address.')
  }
  // A wallet address, not a program-derived one, and not the faucet itself.
  if (!PublicKey.isOnCurve(owner.toBytes())) return refuse(400, 'That address is not a wallet.')
  const pool = ataFor(faucet.publicKey, QUOTE_MINT)
  if (owner.equals(faucet.publicKey) || owner.equals(pool)) return refuse(400, 'No.')

  const now = Date.now()
  const addr = `a:${owner.toBase58()}`
  const ip = `i:${args.ip}`
  if (!allowed(addr, LIMITS.perAddress, now)) {
    return refuse(429, 'This wallet was funded recently — once every 12 hours.', 12 * 3600)
  }
  if (!allowed(ip, LIMITS.perIp, now)) return refuse(429, 'Too many grants from here today.', 3600)
  if (!allowed('day', LIMITS.perDay, now)) {
    return refuse(429, 'The faucet has given out all it can today — try again tomorrow.', 3600)
  }
  if (inFlight.has(addr)) return refuse(429, 'A grant to this wallet is already in progress.', 5)
  inFlight.add(addr)
  const keys = [addr, ip, 'day']

  try {
    const conn = new Connection(
      process.env.BELL_RPC_URL ?? process.env.NEXT_PUBLIC_BELL_RPC ?? 'https://api.devnet.solana.com',
      'confirmed',
    )
    const userAta = ataFor(owner, QUOTE_MINT)
    const [ownerInfo, userAtaInfo, faucetInfo, poolInfo] = await conn.getMultipleAccountsInfo([
      owner,
      userAta,
      faucet.publicKey,
      pool,
    ])

    const userQuote = userAtaInfo ? decodeTokenAccount(userAtaInfo.data).amount : 0n
    const poolQuote = poolInfo ? decodeTokenAccount(poolInfo.data).amount : 0n
    const wantQuote = userQuote < HAS_ENOUGH_QUOTE
    const wantSol = (ownerInfo?.lamports ?? 0) < HAS_ENOUGH_LAMPORTS

    if (!wantQuote && !wantSol) {
      return refuse(200, 'This wallet already has demo funds — nothing to send.')
    }
    if (wantQuote && poolQuote < FLOOR_QUOTE) return refuse(503, 'The demo-USDC pool is empty for now.')
    const cost =
      FEE_LAMPORTS + (wantSol ? GRANT_LAMPORTS : 0) + (wantQuote && !userAtaInfo ? QUOTE_ACCOUNT_RENT : 0)
    if ((faucetInfo?.lamports ?? 0) < cost + RESERVE_LAMPORTS) {
      return refuse(503, 'The faucet is out of SOL for now.')
    }

    const tx = new Transaction()
    if (wantQuote) {
      tx.add(
        ixCreateAtaIdempotent({ payer: faucet.publicKey, owner, mint: QUOTE_MINT }),
        ixTransferChecked({
          source: pool,
          mint: QUOTE_MINT,
          destination: userAta,
          owner: faucet.publicKey,
          amount: GRANT_QUOTE,
          decimals: QUOTE_DECIMALS,
        }),
      )
    }
    if (wantSol) {
      tx.add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: owner, lamports: GRANT_LAMPORTS }))
    }

    // Sign ONCE. The keeper's `send()` retries by re-signing with a fresh
    // blockhash after a timeout, which is harmless for a fill (it cannot happen
    // twice) and a double grant here (it can). So the same signed bytes are
    // rebroadcast until they land or the blockhash expires, and the outcome is
    // read from the signature's status rather than from the socket.
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
    tx.feePayer = faucet.publicKey
    tx.recentBlockhash = blockhash
    tx.sign(faucet)
    const raw = tx.serialize()
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: false })
    record(keys, now)

    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })
      const st = value[0]
      if (st?.err) {
        unrecord(keys, now)
        return refuse(502, `The grant failed on chain: ${JSON.stringify(st.err)}`)
      }
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        const parts = [wantQuote ? '1,000 demo-USDC' : null, wantSol ? '0.012 devnet SOL' : null]
        return {
          status: 200,
          body: { ok: true, message: `Sent ${parts.filter(Boolean).join(' and ')}.`, signature: sig },
        }
      }
      if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) {
        // Past its blockhash's last valid height, a transaction that has not
        // landed never will. One last look, then it is certainly nothing.
        const { value: last } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })
        if (!last[0]) {
          unrecord(keys, now)
          return refuse(504, 'The network dropped the grant — nothing was sent. Try again.')
        }
        break
      }
      await conn.sendRawTransaction(raw, { skipPreflight: true }).catch(() => {})
      await new Promise((r) => setTimeout(r, 1_500))
    }
    // Ambiguous: it may yet land, so it still counts against this wallet.
    return refuse(504, `The grant was sent but not confirmed in time — check ${sig.slice(0, 16)}… before retrying.`)
  } catch (e) {
    return refuse(502, `The faucet could not reach the chain: ${(e as Error).message}`)
  } finally {
    inFlight.delete(addr)
  }
}
