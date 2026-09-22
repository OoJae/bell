import type { Metadata } from 'next'
import { Providers } from './providers.tsx'
import './globals.css'

export const metadata: Metadata = {
  title: 'BELL',
  description: 'The venue for real US securities on Solana that knows what time it is.',
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
