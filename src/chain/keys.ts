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
const parse = (json: string): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json)))

/**
 * Load a keypair from a file, or from an environment variable holding the same
 * JSON array.
 *
 * The env form exists for hosted runs: a container has no key file, and writing
 * one to disk at boot just to read it back adds a place for it to leak. The
 * variable is named after the path so a deployment says which key it is
 * supplying — `.attestor.json` becomes `BELL_KEY_ATTESTOR`.
 *
 * The file is preferred when present, so local development is unchanged and a
 * stray variable cannot silently override the key a developer is looking at.
 */
export function loadKeypair(path: string): Keypair {
  const envName = envNameFor(path)
  try {
    return parse(readFileSync(path, 'utf8'))
  } catch {
    const fromEnv = process.env[envName]
    if (fromEnv) return parse(fromEnv)
    throw new Error(
      `no keypair at ${path} and ${envName} is unset. ` +
        `For a hosted run, set ${envName} to the contents of the key file.`,
    )
  }
}

/**
 * The variable `loadKeypair` looks for, derived from the file's *basename*.
 *
 * Basename rather than full path so one key has one name: `.attestor.json` and
 * `/etc/secrets/attestor.json` are both `BELL_KEY_ATTESTOR`. Deriving it from
 * the whole path would mean a deployment's variable silently stopped matching
 * when someone moved the file.
 */
export const envNameFor = (path: string): string => {
  const base = (path.split('/').pop() ?? path).replace(/^\.+/, '').replace(/\.json$/, '')
  return `BELL_KEY_${base.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}
