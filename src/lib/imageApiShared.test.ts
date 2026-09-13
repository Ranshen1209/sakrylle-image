import { afterEach, expect, it, vi } from 'vitest'
import { fetchImageUrlAsDataUrl, ImageDownloadError } from './imageApiShared'
import { isRetryableError } from './openaiCompatibleImageApi'

afterEach(() => vi.restoreAllMocks())
it('retains the paid result URL on a CORS failure without allowing generation retries', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce({ type: 'opaque' } as Response)
  const url = 'https://images.example/result.png'
  const error = await fetchImageUrlAsDataUrl(url, 'image/png').catch(error => error)
  expect(error).toBeInstanceOf(ImageDownloadError)
  expect(error.rawImageUrls).toEqual([url])
  expect(isRetryableError(error)).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  for (const [target, options] of fetchMock.mock.calls) {
    expect(target).toBe(url)
    expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
  }
})
it('keeps Base64 results local and does not fetch them', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
  const data = 'data:image/png;base64,aW1hZ2U='
  expect(await fetchImageUrlAsDataUrl(data, 'image/png')).toBe(data)
  expect(fetchMock).not.toHaveBeenCalled()
})
it('preserves cancellation without probing or generating again', async () => {
  const error = new DOMException('aborted', 'AbortError')
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(error)
  await expect(fetchImageUrlAsDataUrl('https://images.example/result.png', 'image/png')).rejects.toBe(error)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
