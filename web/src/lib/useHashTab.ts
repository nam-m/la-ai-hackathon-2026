import { useCallback, useEffect, useState } from 'react'

export type Tab = 'today' | 'facts' | 'settings'
const TABS: Tab[] = ['today', 'facts', 'settings']
const read = (): Tab => (TABS as string[]).includes(location.hash.slice(1)) ? location.hash.slice(1) as Tab : 'today'

/** The current tab lives in the URL hash, so links, Back and refresh all work. */
export function useHashTab() {
  const [tab, setTab] = useState<Tab>(read)
  useEffect(() => {
    const onChange = () => setTab(read())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  useEffect(() => { document.title = `Rewind · ${tab[0].toUpperCase()}${tab.slice(1)}` }, [tab])
  const go = useCallback((t: Tab) => { location.hash = t; window.scrollTo(0, 0) }, [])
  return [tab, go] as const
}
