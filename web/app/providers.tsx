'use client'

import { useMemo, type ReactNode } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { RPC_URL } from '../lib/bell.ts'
import '@solana/wallet-adapter-react-ui/styles.css'

/**
 * Wallet context.
 *
 * The wallet list is deliberately empty: every major Solana wallet registers
 * itself through the Wallet Standard, so passing adapters explicitly would
 * duplicate what the browser already advertises and would quietly exclude
 * anything not on our list.
 */
export function Providers({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [], [])
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
