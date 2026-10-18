import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { takeKeyFromLink } from './api'
import { App } from './App'
import './styles.css'

takeKeyFromLink()
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
