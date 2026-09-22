/**
 * A scripted Solana wallet for a real browser, via the Wallet Standard.
 *
 * Injected into the page before any of the page's own code runs, it registers
 * itself exactly as Phantom or Backpack do, so the site's wallet-adapter
 * discovers it through the same path a judge's wallet takes — nothing in the
 * app knows or cares that it is scripted.
 *
 * Signing crosses back into Node through `exposeFunction`: the page hands over
 * the serialized transaction, Node signs it with the keypair and hands it back.
 * The secret key never exists inside the page.
 *
 * What it implements is exactly what `isWalletAdapterCompatibleStandardWallet`
 * requires (checked against the installed @solana/wallet-adapter-base):
 * `standard:connect`, `standard:events`, and `solana:signTransaction`, whose
 * input is `{ account, transaction: Uint8Array }` and whose output is
 * `[{ signedTransaction: Uint8Array }]`.
 */
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js'
import type { BrowserContext } from 'playwright'
import { PROGRAM_ID } from '../../src/chain/codec.ts'

export const WALLET_NAME = 'BELL Demo Wallet'

/** Every transaction the page asked this wallet to sign, for the test to assert on. */
export const signed: { at: Date; bytes: number; programs: string[] }[] = []

const PROGRAM_NAMES: Record<string, string> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'spl-token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'ata',
  '11111111111111111111111111111111': 'system',
  [PROGRAM_ID.toBase58()]: 'bell',
}
const nameOf = (p: string) => PROGRAM_NAMES[p] ?? p.slice(0, 6)

export async function attachWallet(context: BrowserContext, keypair: Keypair): Promise<void> {
  await context.exposeFunction('__bellSign', async (b64: string): Promise<string> => {
    const bytes = Buffer.from(b64, 'base64')
    let out: Uint8Array
    let programs: string[] = []
    try {
      // The page builds legacy transactions; sign as a partial signer so any
      // other signatures already present are kept.
      const tx = Transaction.from(bytes)
      programs = tx.instructions.map((ix) => nameOf(ix.programId.toBase58()))
      tx.partialSign(keypair)
      out = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    } catch {
      const vtx = VersionedTransaction.deserialize(bytes)
      vtx.sign([keypair])
      out = vtx.serialize()
    }
    signed.push({ at: new Date(), bytes: out.length, programs })
    return Buffer.from(out).toString('base64')
  })

  await context.addInitScript(
    ({ address, publicKey, name }) => {
      // Runs in the page. Typed through globalThis because the repo's tsconfig
      // targets Node and carries no DOM lib.
      const page = globalThis as unknown as {
        __bellSign: (b: string) => Promise<string>
        dispatchEvent: (e: Event) => boolean
        addEventListener: (type: string, listener: (e: Event) => void) => void
      }
      const pk = new Uint8Array(publicKey)
      const chains = ['solana:devnet', 'solana:testnet', 'solana:mainnet'] as const
      const account = {
        address,
        publicKey: pk,
        chains,
        features: ['solana:signTransaction'],
        label: name,
      }
      let accounts: (typeof account)[] = []
      const listeners: Record<string, ((p: unknown) => void)[]> = {}
      const emit = () => (listeners.change ?? []).forEach((l) => l({ accounts }))

      const toB64 = (u8: Uint8Array) => {
        let s = ''
        for (const b of u8) s += String.fromCharCode(b)
        return btoa(s)
      }
      const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
      const sign = (b: string) => page.__bellSign(b)

      const icon =
        'data:image/svg+xml;base64,' +
        btoa(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#d6a03c"/><text x="16" y="22" font-family="monospace" font-size="17" text-anchor="middle" fill="#14110b">B</text></svg>',
        )

      const wallet = {
        version: '1.0.0',
        name,
        icon,
        chains,
        get accounts() {
          return accounts
        },
        features: {
          'standard:connect': {
            version: '1.0.0',
            connect: async () => {
              accounts = [account]
              emit()
              return { accounts }
            },
          },
          'standard:disconnect': {
            version: '1.0.0',
            disconnect: async () => {
              accounts = []
              emit()
            },
          },
          'standard:events': {
            version: '1.0.0',
            on: (event: string, listener: (p: unknown) => void) => {
              ;(listeners[event] ??= []).push(listener)
              return () => {
                listeners[event] = listeners[event].filter((x) => x !== listener)
              }
            },
          },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
              Promise.all(
                inputs.map(async (i) => ({ signedTransaction: fromB64(await sign(toB64(i.transaction))) })),
              ),
          },
        },
      }

      // The Wallet Standard registration handshake, as `registerWallet` does it:
      // announce now, and answer the app if it asks later.
      const callback = ({ register }: { register: (w: unknown) => void }) => register(wallet)
      try {
        page.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }))
      } catch {}
      try {
        page.addEventListener('wallet-standard:app-ready', (e: Event) =>
          callback((e as CustomEvent).detail),
        )
      } catch {}
    },
    {
      address: keypair.publicKey.toBase58(),
      publicKey: Array.from(keypair.publicKey.toBytes()),
      name: WALLET_NAME,
    },
  )
}
