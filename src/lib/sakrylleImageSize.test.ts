import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile } from '../types'
import { getSakrylleImageRequestParams } from './sakrylleImageSize'

vi.mock('./sakrylleAuth', () => {
  const state: { token: any } = { token: null }
  return {
    __esModule: true,
    OIDC_ENABLED: false,
    __setToken(value: any) { state.token = value },
    getStoredToken: () => state.token,
  }
})

import * as sakrylleAuth from './sakrylleAuth'

const authMock = sakrylleAuth as typeof sakrylleAuth & { __setToken: (t: any) => void }

function createMockStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
  }
}

function createProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    transparentBackgroundMethod: 'api',
    id: 'test',
    name: 'Test',
    provider: 'openai',
    baseUrl: 'https://api.sakrylle.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-image-2',
    timeout: 600,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    ...overrides,
  }
}

describe('getSakrylleImageRequestParams', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMockStorage())
    authMock.__setToken(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    authMock.__setToken(null)
  })

  it('caps Sakrylle GPT-Image sizes above the 1K tier', () => {
    const params = getSakrylleImageRequestParams(
      { ...DEFAULT_PARAMS, size: '2048x2048' },
      createProfile(),
    )

    expect(params.size).toBe('1248x1248')
  })

  it('keeps auto size untouched', () => {
    const params = getSakrylleImageRequestParams(
      { ...DEFAULT_PARAMS, size: 'auto' },
      createProfile(),
    )

    expect(params.size).toBe('auto')
  })

  it('does not cap non-Sakrylle profiles', () => {
    const params = getSakrylleImageRequestParams(
      { ...DEFAULT_PARAMS, size: '2048x2048' },
      createProfile({ baseUrl: 'https://api.openai.com/v1' }),
    )

    expect(params.size).toBe('2048x2048')
  })

  it('does not cap when OAuth selection points at a higher-tier image group', () => {
    authMock.__setToken({
      accessToken: 'sk_oauth_group5',
      expiresAt: Date.now() + 3_600_000,
      group: { id: 5, name: 'GPT-Image' },
      additionalTokens: [
        { accessToken: 'sk_oauth_group9', expiresAt: Date.now() + 3_600_000, group: { id: 9, name: 'GPT-Image-4K' } },
      ],
    })
    localStorage.setItem('sakrylle-image-playground.selected-groups', JSON.stringify({ images: 9 }))

    const params = getSakrylleImageRequestParams(
      { ...DEFAULT_PARAMS, size: '2048x2048' },
      createProfile({ apiKey: '' }),
    )

    expect(params.size).toBe('2048x2048')
  })
})
