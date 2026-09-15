import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './App.css'
import { useAppStore } from './store/app-store'
import { useSettingsStore } from './store/settings-store'

// Dev only: lets the stores be poked from the devtools console when the UI is
// opened in a plain browser, where no backend events arrive.
if (import.meta.env.DEV) {
  Object.assign(window, { __app: useAppStore, __settings: useSettingsStore })
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
