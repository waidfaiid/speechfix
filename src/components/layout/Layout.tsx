import type { ReactNode } from 'react'
import { Header } from './Header'

interface LayoutProps {
  children: ReactNode
  /** App-Kopfzeile (SpeechFix + Dateien) — nur im Workspace, nicht auf der Startseite. */
  showHeader?: boolean
}

export function Layout({ children, showHeader = true }: LayoutProps) {
  return (
    <div className="min-h-screen bg-black/60 font-sans flex justify-center">
      <div className="relative w-full max-w-md min-h-screen bg-background flex flex-col shadow-2xl shadow-black/50">
        {showHeader && <Header />}
        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          {children}
        </main>
      </div>
    </div>
  )
}
