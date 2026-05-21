import type { ReactNode } from 'react'
import { Header } from './Header'

interface LayoutProps {
  children: ReactNode
}

export function Layout({ children }: LayoutProps) {
  return (
    // Full-screen dark background so the centred panel has breathing room on wide screens
    <div className="min-h-screen bg-black/60 font-sans flex justify-center">
      <div className="relative w-full max-w-[520px] min-h-screen bg-background flex flex-col shadow-2xl shadow-black/50">
        <Header />
        <main className="flex-1 flex flex-col">
          {children}
        </main>
      </div>
    </div>
  )
}
