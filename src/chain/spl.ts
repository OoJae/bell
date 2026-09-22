/**
 * The SPL instructions and account layout BELL needs, built by hand and portable.
 *
 * These live here rather than in a script because the browser needs the *same*
 * `approve` and `revoke` the keeper-side tooling uses. A user who cancels from
 * the web page and a user who cancels from the CLI must be sending identical
 * bytes; two encoders would eventually disagree, and the one that disagrees
 * would be the cancel path — the last thing that should ever be subtly wrong.
 *
 * Hand-rolling is the same trade made in `codec.ts`: these payloads are one to
 * ten bytes with a wire format that has not changed since 2020, against a
 * dependency that would have to agree with anchor about which `Pubkey` type is
 * which. Discriminants are from `spl_token::instruction::TokenInstruction`.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

/** `TokenInstruction::ApproveChecked` — 13, then a u64 amount and the decimals. */
export function ixApproveChecked(args: {
  source: PublicKey
  mint: PublicKey
  delegate: PublicKey
  owner: PublicKey
  amount: bigint
  decimals: number
  tokenProgram?: PublicKey
}): TransactionInstruction {
  const data = new Uint8Array(10)
  data[0] = 13
  new DataView(data.buffer).setBigUint64(1, args.amount, true)
  data[9] = args.decimals
  return new TransactionInstruction({
    programId: args.tokenProgram ?? TOKEN_PROGRAM,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.delegate, isSigner: false, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

/**
 * `TokenInstruction::Revoke` — a single byte, and the entire cancel path.
 *
 * Worth being explicit about why this matters: revoking needs nothing from
 * BELL. No PDA, no program account, no keeper. If this program were frozen,
 * upgraded maliciously or simply abandoned, this one instruction still makes
 * every order against the account unfillable, because the fill moves the
 * user's tokens by delegation and there is no longer a delegation.
 */
export function ixRevoke(
  source: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([5]),
  })
}

/** The associated token account for a mint and owner. */
export const ataFor = (
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM,
): PublicKey =>
  PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0]

/**
 * `CreateIdempotent` — discriminant 1, no payload.
 *
 * Idempotent rather than `Create` so a user who already holds the stock is not
 * refused for it. The browser cannot know whether the destination exists
 * without an extra round trip, and a failed order because the *receiving*
 * account was missing would be a refusal that says nothing about risk.
 */
export function ixCreateAtaIdempotent(args: {
  payer: PublicKey
  owner: PublicKey
  mint: PublicKey
  tokenProgram?: PublicKey
}): TransactionInstruction {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: ataFor(args.owner, args.mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: false, isWritable: false },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  })
}

/**
 * `TokenInstruction::TransferChecked` — 12, then a u64 amount and the decimals.
 *
 * Checked rather than plain `Transfer` so the mint and its decimals are part of
 * what is signed: a wrong mint fails instead of moving a different asset.
 */
export function ixTransferChecked(args: {
  source: PublicKey
  mint: PublicKey
  destination: PublicKey
  owner: PublicKey
  amount: bigint
  decimals: number
  tokenProgram?: PublicKey
}): TransactionInstruction {
  const data = new Uint8Array(10)
  data[0] = 12
  new DataView(data.buffer).setBigUint64(1, args.amount, true)
  data[9] = args.decimals
  return new TransactionInstruction({
    programId: args.tokenProgram ?? TOKEN_PROGRAM,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

/** The fields of an SPL token account the page and the faucet read. */
export interface TokenAccountView {
  mint: PublicKey
  owner: PublicKey
  amount: bigint
  delegate: PublicKey | null
  delegatedAmount: bigint
}

/**
 * Decode the base layout shared by SPL Token and Token-2022 accounts.
 *
 * Offsets from `spl_token::state::Account`: mint 0, owner 32, amount 64,
 * delegate as a `COption<Pubkey>` (4-byte tag, then the key) at 72,
 * delegated_amount 121. Token-2022 appends extensions *after* byte 165, so the
 * same offsets hold for both. DataView, not Buffer's BigInt readers, because
 * this runs in the browser (see test/portability.test.ts).
 */
export function decodeTokenAccount(data: Uint8Array): TokenAccountView {
  if (data.length < 165) throw new Error(`not a token account: ${data.length} bytes`)
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const hasDelegate = d.getUint32(72, true) === 1
  return {
    mint: new PublicKey(data.subarray(0, 32)),
    owner: new PublicKey(data.subarray(32, 64)),
    amount: d.getBigUint64(64, true),
    delegate: hasDelegate ? new PublicKey(data.subarray(76, 108)) : null,
    delegatedAmount: d.getBigUint64(121, true),
  }
}
