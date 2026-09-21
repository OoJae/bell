/**
 * The evidence log.
 *
 * BELL's central claim is that refusing a trade is worth something, and that
 * claim is only as good as the record behind it. Every tick is written here
 * with each source's raw reading, so a verdict can be reconstructed after the
 * fact and a disagreement between sources can be explained rather than
 * asserted.
 *
 * It also holds the honest counterfactual: when the gate refuses, what would
 * the trade have cost. If that number turns out small, EVIDENCE.md should say
 * so.
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface TickRow {
  at: number
  symbol: string
  mint: string
  issuer: string
  openNow: boolean
  halt: number
  confidence: string
  detail: string
  /** Raw source readings, so a verdict is always reconstructable. */
  pythOpen: boolean | null
  issuerOpen: boolean | null
  issuerHalted: boolean | null
  exchangeHalt: number | null
  pushed: boolean
  signature: string | null
}

export interface TransitionRow {
  at: number
  symbol: string
  fromOpen: boolean
  toOpen: boolean
  fromHalt: number
  toHalt: number
  detail: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticks (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  mint TEXT NOT NULL,
  issuer TEXT NOT NULL,
  open_now INTEGER NOT NULL,
  halt INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  detail TEXT NOT NULL,
  pyth_open INTEGER,
  issuer_open INTEGER,
  issuer_halted INTEGER,
  exchange_halt INTEGER,
  pushed INTEGER NOT NULL,
  signature TEXT
);
CREATE INDEX IF NOT EXISTS ticks_at ON ticks (at);
CREATE INDEX IF NOT EXISTS ticks_symbol ON ticks (symbol, at);

CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  from_open INTEGER NOT NULL,
  to_open INTEGER NOT NULL,
  from_halt INTEGER NOT NULL,
  to_halt INTEGER NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transitions_at ON transitions (at);
`

export class Recorder {
  private db: Database.Database
  private insertTick: Database.Statement
  private insertTransition: Database.Statement
  private lastState = new Map<string, { openNow: boolean; halt: number }>()

  constructor(path = process.env.BELL_DB ?? 'data/bell.db') {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    // WAL so a reader (the evidence report) never blocks the keeper.
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.insertTick = this.db.prepare(`
      INSERT INTO ticks (at, symbol, mint, issuer, open_now, halt, confidence, detail,
                         pyth_open, issuer_open, issuer_halted, exchange_halt, pushed, signature)
      VALUES (@at, @symbol, @mint, @issuer, @openNow, @halt, @confidence, @detail,
              @pythOpen, @issuerOpen, @issuerHalted, @exchangeHalt, @pushed, @signature)
    `)
    this.insertTransition = this.db.prepare(`
      INSERT INTO transitions (at, symbol, from_open, to_open, from_halt, to_halt, detail)
      VALUES (@at, @symbol, @fromOpen, @toOpen, @fromHalt, @toHalt, @detail)
    `)
    for (const row of this.db
      .prepare(
        `SELECT symbol, open_now, halt FROM ticks WHERE id IN
           (SELECT MAX(id) FROM ticks GROUP BY symbol)`,
      )
      .all() as Array<{ symbol: string; open_now: number; halt: number }>) {
      this.lastState.set(row.symbol, { openNow: row.open_now === 1, halt: row.halt })
    }
  }

  private static bit(v: boolean | null | undefined): number | null {
    return v === null || v === undefined ? null : v ? 1 : 0
  }

  /** Write one tick, and a transition row if the state actually moved. */
  record(rows: TickRow[]): TransitionRow[] {
    const transitions: TransitionRow[] = []
    const write = this.db.transaction((batch: TickRow[]) => {
      for (const r of batch) {
        this.insertTick.run({
          ...r,
          openNow: Recorder.bit(r.openNow),
          pushed: Recorder.bit(r.pushed),
          pythOpen: Recorder.bit(r.pythOpen),
          issuerOpen: Recorder.bit(r.issuerOpen),
          issuerHalted: Recorder.bit(r.issuerHalted),
        })
        const prev = this.lastState.get(r.symbol)
        if (prev && (prev.openNow !== r.openNow || prev.halt !== r.halt)) {
          const t: TransitionRow = {
            at: r.at,
            symbol: r.symbol,
            fromOpen: prev.openNow,
            toOpen: r.openNow,
            fromHalt: prev.halt,
            toHalt: r.halt,
            detail: r.detail,
          }
          this.insertTransition.run({
            ...t,
            fromOpen: Recorder.bit(t.fromOpen),
            toOpen: Recorder.bit(t.toOpen),
          })
          transitions.push(t)
        }
        this.lastState.set(r.symbol, { openNow: r.openNow, halt: r.halt })
      }
    })
    write(rows)
    return transitions
  }

  counts() {
    const t = this.db.prepare('SELECT COUNT(*) n FROM ticks').get() as { n: number }
    const x = this.db.prepare('SELECT COUNT(*) n FROM transitions').get() as { n: number }
    return { ticks: t.n, transitions: x.n }
  }

  close() {
    this.db.close()
  }
}
