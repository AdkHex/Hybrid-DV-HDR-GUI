import { useEffect } from 'react'
import { useSettingsStore } from '@/store/settings-store'

/** Applies the `dark` class from the preference, following the OS on "system". */
export function useTheme() {
  const theme = useSettingsStore(s => s.theme)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}
