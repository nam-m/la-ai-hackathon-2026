import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

type ToastAction = { label: string; run: () => Promise<void> | void }
type ToastState = { text: string; action?: ToastAction; id: number }
const ToastContext = createContext<(text: string, action?: ToastAction) => void>(() => {})

export const useToast = () => useContext(ToastContext)

/** One message at a time at the bottom of the screen; 8 s when it offers an action (Undo), 4 s otherwise. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const show = useCallback((text: string, action?: ToastAction) => setToast({ text, action, id: Date.now() }), [])

  useEffect(() => {
    if (!toast) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), toast.action ? 8000 : 4000)
    return () => clearTimeout(timer.current)
  }, [toast])

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast" role="status" hidden={!toast}>
        <span>{toast?.text}</span>
        {toast?.action && (
          <button type="button" onClick={async () => {
            const action = toast.action!
            setToast(null)
            try { await action.run() } catch { show('Couldn’t undo that.') }
          }}>{toast.action.label}</button>
        )}
      </div>
    </ToastContext.Provider>
  )
}
