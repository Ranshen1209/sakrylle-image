// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function nativeMock() {
  const ready = deferred(), finished = deferred()
  const skipTransition = vi.fn()
  const start = vi.fn((apply: () => void) => {
    apply()
    return { ready: ready.promise, finished: finished.promise, skipTransition }
  })
  vi.stubGlobal('document', Object.assign(document, { startViewTransition: start }))
  return { ready, finished, skipTransition, start }
}

it('sets percentage origin and radius before the very first capture, without root WAAPI effects', async () => {
  const { switchTheme } = await import('./theme')
  const root = document.documentElement
  const animate = vi.fn()
  root.animate = animate
  const native = nativeMock()
  native.start.mockImplementation((apply) => {
    expect(root.style.getPropertyValue('--theme-switch-x')).toBe(`${900 / innerWidth * 100}%`)
    expect(root.style.getPropertyValue('--theme-switch-y')).toBe(`${36 / innerHeight * 100}%`)
    const radius = Math.hypot(Math.max(900, innerWidth - 900), innerHeight - 36)
    expect(root.style.getPropertyValue('--theme-switch-radius')).toBe(`${radius / (Math.hypot(innerWidth, innerHeight) / Math.SQRT2) * 100}%`)
    expect(root.classList.contains('theme-toggling')).toBe(true)
    apply()
    return { ready: native.ready.promise, finished: native.finished.promise, skipTransition: native.skipTransition }
  })
  switchTheme('dark', { origin: { x: 900, y: 36 } })
  native.ready.resolve()
  await Promise.resolve()
  expect(animate).not.toHaveBeenCalled()
  native.finished.resolve()
  await vi.runAllTimersAsync()
  expect(root.classList.contains('theme-toggling')).toBe(false)
  expect(root.style.getPropertyValue('--theme-switch-x')).toBe('')
})

it('uses the pointer while layout is moving and the visible button center for keyboard clicks', async () => {
  const { getThemeSwitchOrigin } = await import('./theme')
  const button = document.createElement('button')
  button.getBoundingClientRect = () => ({ left: 400, right: 440, top: 10, bottom: 50, width: 40, height: 40 }) as DOMRect
  expect(getThemeSwitchOrigin({ clientX: 950, clientY: 30, currentTarget: button })).toEqual({ x: 950, y: 30 })
  expect(getThemeSwitchOrigin({ clientX: 0, clientY: 0, currentTarget: button })).toEqual({ x: 420, y: 30 })
})

it('ignores 100 rapid clicks through ready, finished, and compositor cooldown', async () => {
  const { switchTheme } = await import('./theme')
  const native = nativeMock(), onApply = vi.fn()
  switchTheme('dark', { onApply })
  for (let i = 0; i < 50; i++) expect(switchTheme('light', { onApply })).toBe(false)
  native.ready.resolve()
  await Promise.resolve()
  for (let i = 0; i < 50; i++) expect(switchTheme('light', { onApply })).toBe(false)
  expect(native.start).toHaveBeenCalledTimes(1)
  expect(native.skipTransition).not.toHaveBeenCalled()
  expect(onApply).toHaveBeenCalledTimes(1)
  native.finished.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(switchTheme('light')).toBe(false)
  await vi.advanceTimersByTimeAsync(111)
  expect(switchTheme('light')).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(switchTheme('light')).toBe(true)
  expect(native.start).toHaveBeenCalledTimes(2)
  await vi.runAllTimersAsync()
})

it.each(['watchdog', 'ready rejection'])('only finished unlocks after %s, then uses instant fallback', async (failure) => {
  const { switchTheme } = await import('./theme')
  const native = nativeMock()
  switchTheme('dark')
  if (failure === 'watchdog') await vi.advanceTimersByTimeAsync(2000)
  else { native.ready.reject(new Error('snapshot failed')); await Promise.resolve() }
  expect(native.skipTransition).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 100; i++) expect(switchTheme('light')).toBe(false)
  await vi.advanceTimersByTimeAsync(5000)
  expect(switchTheme('light')).toBe(false)
  native.finished.resolve()
  await vi.runAllTimersAsync()
  expect(switchTheme('light')).toBe(true)
  expect(native.start).toHaveBeenCalledTimes(1)
  expect(document.documentElement.classList.contains('dark')).toBe(false)
})

it('falls back safely if starting a transition throws', async () => {
  const { switchTheme } = await import('./theme')
  const native = nativeMock()
  native.start.mockImplementation(() => { throw new Error('unsupported') })
  expect(switchTheme('dark')).toBe(true)
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(document.documentElement.classList.contains('theme-toggling')).toBe(false)
  switchTheme('light')
  expect(native.start).toHaveBeenCalledTimes(1)
})

it('honors reduced motion and keeps Image theme persistence', async () => {
  const { switchTheme, readStoredTheme } = await import('./theme')
  const native = nativeMock()
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  switchTheme('dark')
  expect(readStoredTheme()).toBe('dark')
  expect(native.start).not.toHaveBeenCalled()
})
