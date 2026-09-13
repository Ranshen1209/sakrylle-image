export type Theme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'sakrylle-image-playground.theme'

function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (raw === 'light' || raw === 'dark') return raw
  } catch {
    // ignore
  }
  return getSystemTheme()
}

export function persistTheme(theme: Theme) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // ignore
  }
}

export function applyThemeClass(theme: Theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

interface SwitchOptions {
  origin?: { x: number, y: number }
}

interface ThemeViewTransition {
  finished: Promise<void>
  ready: Promise<void>
  skipTransition?: () => void
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (cb: () => void | Promise<void>) => ThemeViewTransition
}

let activeThemeTransition: ThemeViewTransition | null = null

export function switchTheme(next: Theme, options: SwitchOptions = {}) {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  const { x, y } = options.origin ?? {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  }
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  )

  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const apply = () => {
    applyThemeClass(next)
    persistTheme(next)
  }

  const startViewTransition = (document as DocumentWithViewTransition).startViewTransition

  // No View Transition support (or reduced motion) → swap instantly.
  if (!startViewTransition || reduceMotion) {
    apply()
    return
  }

  // Animate the snapshot with explicit viewport coordinates. Custom properties
  // on html are not reliably inherited by View Transition pseudo-elements.
  activeThemeTransition?.skipTransition?.()
  const transition = startViewTransition.call(document, apply)
  activeThemeTransition = transition
  void transition.ready.then(() => {
    if (activeThemeTransition !== transition) return
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 480, easing: 'linear', fill: 'forwards', pseudoElement: '::view-transition-new(root)' },
    )
  }).catch(() => {})
  void transition.finished
    .catch(() => {})
    .finally(() => {
      if (activeThemeTransition === transition) {
        activeThemeTransition = null
      }
    })
}
