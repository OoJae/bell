import type { Metadata } from 'next'
import { Providers } from './providers.tsx'
import './globals.css'

export const metadata: Metadata = {
  title: 'BELL',
  description:
    'BELL refuses trades in tokenized US stocks whenever the real market is closed or halted, or the token is not safe to trade — and parks your order to fill when it can.',
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
