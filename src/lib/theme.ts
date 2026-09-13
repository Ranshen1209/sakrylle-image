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
  onApply?: () => void
}

interface ThemeViewTransition {
  finished: Promise<void>
  ready: Promise<void>
  updateCallbackDone?: Promise<void>
  skipTransition?: () => void
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (cb: () => void | Promise<void>) => ThemeViewTransition
}

type TransitionRun = {
  transition: ThemeViewTransition | null
  watchdog: ReturnType<typeof setTimeout> | null
  skipRequested: boolean
}

let activeRun: TransitionRun | null = null
let nativeTransitionsDisabled = false

function clearRun(run: TransitionRun) {
  if (activeRun !== run) return
  if (run.watchdog !== null) clearTimeout(run.watchdog)
  activeRun = null
  const root = document.documentElement
  root.classList.remove('theme-toggling')
  for (const name of ['x', 'y', 'radius']) root.style.removeProperty(`--theme-switch-${name}`)
}

function finishRun(run: TransitionRun) {
  if (activeRun !== run) return
  if (run.watchdog !== null) clearTimeout(run.watchdog)
  run.watchdog = null
  const cooldown = () => setTimeout(() => clearRun(run), 80)
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => window.requestAnimationFrame(cooldown))
  } else {
    cooldown()
  }
}

function requestSkip(run: TransitionRun) {
  if (activeRun !== run || run.skipRequested) return
  run.skipRequested = true
  nativeTransitionsDisabled = true
  try { run.transition?.skipTransition?.() } catch { /* finished still owns the lock */ }
}

// Pointer coordinates remain correct while the responsive header is moving.
// Keyboard clicks have no pointer position, so use the visible button center.
export function getThemeSwitchOrigin(event: { clientX: number; clientY: number; currentTarget: HTMLElement }) {
  const { clientX: x, clientY: y } = event
  if (Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0)
    && x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight) return { x, y }
  const rect = event.currentTarget.getBoundingClientRect()
  const left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right)
  const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom)
  if (right > left && bottom > top) return { x: (left + right) / 2, y: (top + bottom) / 2 }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
}

export function switchTheme(next: Theme, options: SwitchOptions = {}): boolean {
  if (typeof document === 'undefined' || activeRun) return false
  const root = document.documentElement
  const apply = () => {
    applyThemeClass(next)
    persistTheme(next)
    options.onApply?.()
  }
  const start = (document as DocumentWithViewTransition).startViewTransition
  if (!start || nativeTransitionsDisabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    apply()
    return true
  }

  const width = window.innerWidth, height = window.innerHeight
  const { x, y } = options.origin ?? { x: width / 2, y: height / 2 }
  const radius = Math.hypot(Math.max(x, width - x), Math.max(y, height - y))
  const reference = Math.hypot(width, height) / Math.SQRT2
  const run: TransitionRun = { transition: null, watchdog: null, skipRequested: false }
  activeRun = run
  // Set percentage coordinates BEFORE capture. Chromium can mis-scale animated
  // pixel lengths on high-DPI displays, especially on the first snapshot.
  root.style.setProperty('--theme-switch-x', `${x / width * 100}%`)
  root.style.setProperty('--theme-switch-y', `${y / height * 100}%`)
  root.style.setProperty('--theme-switch-radius', `${radius / reference * 100}%`)
  root.classList.add('theme-toggling')
  let committed = false
  try {
    const transition = start.call(document, () => { apply(); committed = true })
    run.transition = transition
    run.watchdog = setTimeout(() => requestSkip(run), 2000)
    void transition.updateCallbackDone?.catch(() => {})
    void transition.ready.catch(() => requestSkip(run))
    // Never release on ready failure or watchdog expiry: Chromium may still
    // own the old snapshots. Only finished plus compositor cooldown unlocks.
    void transition.finished.catch(() => {}).finally(() => finishRun(run))
  } catch {
    nativeTransitionsDisabled = true
    if (!committed) apply()
    clearRun(run)
  }
  return true
}
