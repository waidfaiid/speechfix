import { create } from 'zustand'

interface Toast {
  id: string
  message: string
  type: 'info' | 'success' | 'error' | 'warning'
}

interface UIStore {
  showEQPro: boolean
  showExport: boolean
  toasts: Toast[]

  setShowEQPro: (v: boolean) => void
  setShowExport: (v: boolean) => void
  addToast: (message: string, type?: Toast['type']) => void
  removeToast: (id: string) => void
}

export const useUIStore = create<UIStore>((set) => ({
  showEQPro: false,
  showExport: false,
  toasts: [],

  setShowEQPro: (v) => set({ showEQPro: v }),
  setShowExport: (v) => set({ showExport: v }),

  addToast: (message, type = 'info') => {
    const id = Math.random().toString(36).slice(2)
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }))
    // Error toasts stay until manually dismissed — the user may need to
    // read or copy a long message before it disappears.
    if (type !== 'error') {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, 4000)
    }
  },

  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
