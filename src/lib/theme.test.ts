// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { switchTheme } from './theme'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('reveals either theme from the supplied button center after the snapshot is ready', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const animate = vi.fn()
  vi.stubGlobal('document', {
    documentElement: { classList: { add: vi.fn(), remove: vi.fn() }, animate },
    startViewTransition: (apply: () => void) => {
      apply()
      return { ready: Promise.resolve(), finished: Promise.resolve() }
    },
  })
  for (const theme of ['light', 'dark'] as const) {
    switchTheme(theme, { origin: { x: 900, y: 36 } })
    await Promise.resolve()
    expect(animate).toHaveBeenLastCalledWith(
      { clipPath: [`circle(0px at 900px 36px)`, `circle(${Math.hypot(Math.max(900, window.innerWidth - 900), Math.max(36, window.innerHeight - 36))}px at 900px 36px)`] },
      { duration: 480, easing: 'linear', fill: 'forwards', pseudoElement: '::view-transition-new(root)' },
    )
  }
})

it('honors reduced motion without starting a snapshot transition', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const start = vi.fn()
  const add = vi.fn()
  vi.stubGlobal('document', { documentElement: { classList: { add } }, startViewTransition: start })
  switchTheme('dark', { origin: { x: 100, y: 24 } })
  expect(add).toHaveBeenCalledWith('dark')
  expect(start).not.toHaveBeenCalled()
})
