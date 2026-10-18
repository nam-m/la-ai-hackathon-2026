import type { Tab } from '../lib/useHashTab'
import { Bubble, Gear, Sun } from './Icons'

const TABS: { id: Tab; label: string; Icon: typeof Sun }[] = [
  { id: 'today', label: 'Today', Icon: Sun },
  { id: 'facts', label: 'Facts', Icon: Bubble },
  { id: 'settings', label: 'Settings', Icon: Gear },
]

export function Brand() {
  return <div className="brand"><span className="mark" aria-hidden="true" /><span>Rewind</span></div>
}

export function Header({ tab, name }: { tab: Tab; name: string | null }) {
  return (
    <header className="top">
      <Brand />
      <nav className="tabs" aria-label="Sections">
        {TABS.map(({ id, label, Icon }) => (
          <a key={id} href={`#${id}`} aria-current={tab === id ? 'page' : undefined}><Icon size={18} />{label}</a>
        ))}
      </nav>
      <div className="account">
        {name && <><span>{name}</span><span className="initial" aria-hidden="true">{name[0].toUpperCase()}</span></>}
      </div>
    </header>
  )
}
