import type { Metadata } from 'next'
import { Providers } from './providers.tsx'
import './globals.css'

export const metadata: Metadata = {
  title: 'BELL',
  description:
    'The safe way to trade US stocks from your own wallet, at any hour. In the regular session BELL trades; when a stock is halted or a dividend is about to change the token, it refuses on-chain; while New York is shut, it holds your order for a real price.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
