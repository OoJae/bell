import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair, type AccountInfo, type PublicKey } from '@solana/web3.js'
import { MAX_KEYS_PER_READ, readAccounts, readBoard } from '../src/chain/client.ts'
import { ALLOWLIST } from '../src/config.ts'

/** A connection that answers each key with an account naming it, and counts calls. */
function fakeConnection() {
  const calls: number[] = []
  return {
    calls,
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      if (keys.length > MAX_KEYS_PER_READ) throw new Error(`too many keys: ${keys.length}`)
      calls.push(keys.length)
      return keys.map(
        (k) => ({ data: Buffer.from(k.toBytes()), executable: false, lamports: 1, owner: k }) as AccountInfo<Buffer>,
      )
    },
  }
}

test('a read of any length is split under the node limit and comes back in order', async () => {
  // 37 orders was enough to break every crank pass: 27 board keys + 1 clock +
  // 37 funding accounts + 37 inventories = 102 keys in a single call.
  for (const n of [0, 1, 99, 100, 101, 250]) {
    const conn = fakeConnection()
    const keys = Array.from({ length: n }, () => Keypair.generate().publicKey)
    const infos = await readAccounts(conn, keys)
    assert.equal(infos.length, n)
    infos.forEach((info, i) => assert.ok(Buffer.from(keys[i]!.toBytes()).equals(info!.data), `key ${i} out of order`))
    assert.equal(conn.calls.length, Math.ceil(n / MAX_KEYS_PER_READ))
  }
})

test('the crank-shaped board read survives a flooded book', async () => {
  const conn = fakeConnection()
  const listings = ALLOWLIST.map((l) => ({ symbol: l.symbol, mint: l.mint }))
  const extra = Array.from({ length: 1 + 2 * 60 }, () => Keypair.generate().publicKey)
  const { symbols, extras } = await readBoard(
    // The fake data is not a real account layout, so decode would throw. Answer
    // the board keys with nothing and the extras with themselves.
    {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        const infos = await conn.getMultipleAccountsInfo(keys)
        return infos.map((info, i) => (extra.some((e) => e.equals(keys[i]!)) ? info : null))
      },
    },
    listings,
    extra,
  )
  assert.equal(symbols.size, listings.length)
  assert.equal(extras.length, extra.length)
  extras.forEach((info, i) => assert.ok(Buffer.from(extra[i]!.toBytes()).equals(info!.data), `extra ${i} out of order`))
  assert.ok(conn.calls.every((c) => c <= MAX_KEYS_PER_READ))
  assert.equal(conn.calls.length, 2)
})
