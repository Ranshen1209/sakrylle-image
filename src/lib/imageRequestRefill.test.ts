import { describe, it, expect, vi } from 'vitest'
import { runImageRequestsWithRefill, buildPartialFailure, callWithRetry } from './openaiCompatibleImageApi'

describe('Sakrylle paid request limits', () => {
  it('runs six slots concurrently and starts remaining slots only after completion', async () => {
    const releases: Array<() => void> = []
    let active = 0
    let peak = 0
    const run = vi.fn(async (slot: number) => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>(resolve => releases.push(resolve))
      active--
      return { images: [String(slot)] }
    })
    const pending = runImageRequestsWithRefill(8, run)
    expect(run).toHaveBeenCalledTimes(6)
    releases.splice(0).forEach(release => release())
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(8))
    releases.splice(0).forEach(release => release())
    const result = await pending
    expect(peak).toBe(6)
    expect(result.failedCount).toBe(0)
    expect(result.resultsBySlot.map(result => result?.images[0])).toEqual(['0','1','2','3','4','5','6','7'])
  })

  it('does not report partial failure after a successful refill', async () => {
    const run = vi.fn().mockResolvedValueOnce({ images: ['ok'] }).mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({ images: ['refilled'] })
    const result = await runImageRequestsWithRefill(2, run)
    expect(run).toHaveBeenCalledTimes(3)
    expect(result.failedCount).toBe(0)
    expect(buildPartialFailure(result.failedCount, result.firstError)).toBeUndefined()
  })

  it('caps refill plus per-request retries and preserves successful images', async () => {
    vi.useFakeTimers()
    try {
      const failure = Object.assign(new Error('busy'), { httpStatus: 429 })
      const paidRequest = vi.fn().mockResolvedValueOnce({ images: ['saved'] }).mockRejectedValue(failure)
      const pending = runImageRequestsWithRefill(2, () => callWithRetry(paidRequest))
      await vi.runAllTimersAsync()
      const result = await pending
      expect(paidRequest).toHaveBeenCalledTimes(7)
      expect(result.resultsBySlot[0]?.images).toEqual(['saved'])
      expect(result.failedCount).toBe(1)
      expect(buildPartialFailure(result.failedCount, result.firstError)).toEqual({ failedCount: 1, firstErrorMessage: 'busy' })
    } finally { vi.useRealTimers() }
  })
})
