/**
 * Keypair loading — Node only.
 *
 * Kept out of `client.ts` so a browser bundle never reaches for `node:fs`. The
 * front end signs through a wallet adapter and has no business reading key
 * files off a disk it does not have.
 */
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'

/** Solana CLI keypair format: a JSON array of 64 bytes. */
export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}
