import type { Metadata } from 'next'
import { Lookup } from './lookup.tsx'
import styles from './overpay.module.css'

export const metadata: Metadata = {
  title: 'Did you overpay? · BELL',
  description:
    'Paste any Solana wallet: its recent mainnet buys of tokenized US stocks made while New York was shut, each set against the price the real market opened at next.',
}

/**
 * /overpay: a read-only mainnet lookup. The page is static; the reading is done
 * by /api/overpay when someone asks, and the caveats are on the page rather
 * than behind a link because the number means little without them.
 */
export default function Page() {
  return (
    <div className="wrap">
      <header>
        <h1>Did you overpay?</h1>
        <div className="sub">
          Buys of tokenized US stocks made while New York was shut, against the price the real market opened at next.
        </div>
        <p className="what">
          Paste any Solana wallet. This page reads its recent transactions on mainnet, finds the buys of the stocks
          BELL lists that were paid in USDC, and for each one made outside the regular session sets its price per
          share beside the underlying’s next regular-session open. It reads the public chain and Nasdaq’s daily
          history; it signs nothing and needs no wallet. <a href="/">← back to BELL</a>
        </p>
      </header>

      <div className="panel">
        <Lookup />
      </div>

      <div className="panel">
        <p className="verdict">What the gap does and does not say</p>
        <ul className={styles.caveats}>
          <li>
            <strong>It includes genuine overnight news.</strong> If the stock moved between your buy and the open,
            the gap carries that move too. A buy before good news shows a negative gap and one before bad news a
            positive gap, and neither was the pool’s doing. One buy’s gap says little; the median of many says more.
          </li>
          <li>
            <strong>A quote at the open is not a fill.</strong> The open is the first regular-session price on the
            listing exchange, from Nasdaq’s daily history. Nobody could be sure of buying at it, and waiting for it
            has its own risk.
          </li>
          <li>
            <strong>Only recent transactions are read, about 100 at most.</strong> First the latest of each stock
            account the wallet still holds, where every buy into it shows up however busy the wallet is otherwise;
            then the wallet’s own latest transactions, which catches a buy into an account since closed. An older
            buy is not found.
          </li>
          <li>
            <strong>Only buys paid in USDC count</strong>, and only when the transaction moved nothing else the
            wallet holds. Buys paid in SOL or another token are not counted. A transaction that moved a third token
            is counted as mixed and not priced, because its USDC cannot be split. The rule reads balances, not
            intent: repaying a USDC loan while withdrawing stock held as collateral looks the same, and would show
            here as a buy.
          </li>
          <li>
            <strong>The price per share is all-in:</strong> the USDC that left the wallet over the shares that
            arrived, with each token’s scaled-UI multiplier applied, so fees and slippage are inside it. A token’s
            mint records only its latest multiplier step, and an Ondo mint not even the value before that step, so
            a buy older than the step is marked ≈ and left out of the median: it can be a dividend’s worth off, a
            fraction of a percent.
          </li>
          <li>
            <strong>Today’s open appears after today’s close.</strong> Nasdaq adds a day’s row once the session
            ends, so until then a buy made since the last close says “not yet recorded”.
          </li>
        </ul>
        <div className="note">
          BELL’s bell orders are built for this case: an order placed while New York is shut parks, and a filler
          settles it after the open against an attested price, instead of paying whatever a pool quotes overnight.
          BELL itself runs on devnet with demo money for now. <a href="/">Try a bell order on the main page.</a>
        </div>
      </div>

      <footer className="foot">
        <span>
          <a href="/">BELL</a>
        </span>
        <span>
          source{' '}
          <a href="https://github.com/OoJae/bell" target="_blank" rel="noreferrer">
            github.com/OoJae/bell ↗
          </a>
        </span>
      </footer>
    </div>
  )
}
