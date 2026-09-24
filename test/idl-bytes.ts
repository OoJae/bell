/**
 * Account and event bytes laid out from the IDL's own type definitions, for
 * the tests that hand a service a chain made of fakes. A field the program
 * adds, drops or moves shows up here as a missing test value, never as a
 * decoder quietly reading the wrong bytes. Not a test file itself: `node
 * --test test/*.test.ts` does not run it.
 */
import { PublicKey } from '@solana/web3.js'
import idl from '../src/chain/idl.json' with { type: 'json' }

type IdlType =
  | string
  | { array: [IdlType, number] }
  | { defined: { name: string } }
  | { option: IdlType }
interface IdlField {
  name: string
  type: IdlType
}

const types = idl.types as unknown as { name: string; type: { kind: string; fields?: IdlField[] } }[]

/** Little-endian two's complement, by shifting, so no Buffer or DataView method is on trial here. */
function le(v: bigint, bytes: number): number[] {
  let x = v < 0n ? v + (1n << BigInt(8 * bytes)) : v
  const out: number[] = []
  for (let i = 0; i < bytes; i++) {
    out.push(Number(x & 0xffn))
    x >>= 8n
  }
  return out
}

function borsh(type: IdlType, value: unknown, where: string): number[] {
  if (typeof type === 'string') {
    switch (type) {
      case 'u8':
        return [Number(value)]
      case 'bool':
        return [value ? 1 : 0]
      case 'u16':
        return le(BigInt(value as number), 2)
      case 'i32':
        return le(BigInt(value as number), 4)
      case 'u64':
      case 'i64':
        return le(BigInt(value as bigint), 8)
      case 'u128':
        return le(value as bigint, 16)
      case 'pubkey':
        return [...(value as PublicKey).toBytes()]
    }
    throw new Error(`${where}: no test encoding for ${type}`)
  }
  if ('option' in type) return value == null ? [0] : [1, ...borsh(type.option, value, where)]
  if ('array' in type) {
    const [, n] = type.array
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(n)
    if (bytes.length !== n) throw new Error(`${where}: ${bytes.length} bytes, not ${n}`)
    return [...bytes]
  }
  // An enum with unit variants is its discriminant, one byte.
  return [Number(value)]
}

function laid(disc: number[], typeName: string, values: Record<string, unknown>): Uint8Array {
  const t = types.find((x) => x.name === typeName)
  if (!t?.type.fields) throw new Error(`no struct ${typeName} in the IDL`)
  const out = [...disc]
  for (const f of t.type.fields) {
    // Reserved space is zeros; every other field must be given.
    if (!(f.name in values) && !f.name.startsWith('_')) throw new Error(`${typeName}.${f.name} has no test value`)
    out.push(...borsh(f.type, values[f.name], `${typeName}.${f.name}`))
  }
  return Uint8Array.from(out)
}

/** An account of the named type: its discriminator, then each field in the IDL's order. */
export function accountBytes(name: string, values: Record<string, unknown>): Uint8Array {
  const found = (idl.accounts as { name: string; discriminator: number[] }[]).find((a) => a.name === name)
  if (!found) throw new Error(`no account ${name} in the IDL`)
  return laid(found.discriminator, name, values)
}

/** An event's payload as `emit!` logs it: its discriminator, then its fields. */
export function eventBytes(name: string, values: Record<string, unknown>): Uint8Array {
  const found = (idl.events as { name: string; discriminator: number[] }[]).find((e) => e.name === name)
  if (!found) throw new Error(`no event ${name} in the IDL`)
  return laid(found.discriminator, name, values)
}

/** A symbol as the program stores it: twelve bytes, space-padded. */
export const symbolBytes = (s: string): Uint8Array => Uint8Array.from([...s.padEnd(12, ' ')].map((c) => c.charCodeAt(0)))

/** The f64 bits of a multiplier, as TokenRisk stores it. */
export function multiplierBits(m: number): bigint {
  const v = new DataView(new ArrayBuffer(8))
  v.setFloat64(0, m, true)
  return v.getBigUint64(0, true)
}
