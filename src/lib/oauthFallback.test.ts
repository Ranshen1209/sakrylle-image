import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { canUseChatCompletionsImagePath, canUseOAuthForProfile, resolveBearerToken } from './oauthFallback'
import type { ApiProfile } from '../types'
import * as sakrylleAuth from './sakrylleAuth'
import * as sakrylleAccount from './sakrylleAccount'

vi.mock('./sakrylleAuth', () => ({
  OIDC_ENABLED: false,
  getStoredToken: vi.fn(),
  refreshIfNeeded: vi.fn(),
  refreshWithGroupId: vi.fn(),
}))

vi.mock('./sakrylleAccount', () => ({
  fetchMe: vi.fn(async () => null),
}))

vi.mock('./runtimeEnv', () => ({
  readRuntimeEnv: (val: string | undefined) => val,
}))

const SAKRYLLE_BASE = 'https://api.sakrylle.com/v1'

function createProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    transparentBackgroundMethod: 'api',
    id: 'test',
    name: 'Test',
    provider: 'openai',
    baseUrl: SAKRYLLE_BASE,
    apiKey: '',
    model: 'gpt-image-2',
    timeout: 120,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    ...overrides,
  }
}

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

describe('oauthFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('canUseOAuthForProfile', () => {
    it('returns false when provider is not openai', () => {
      const profile = createProfile({ provider: 'openai' as any })
      profile.provider = 'custom-provider' as any
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    it('returns false when baseUrl is not Sakrylle', () => {
      const profile = createProfile({ baseUrl: 'https://api.openai.com/v1' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    it('returns false when no token is stored', () => {
      const profile = createProfile()
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue(null)
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    it('returns true for images mode with images:create scope', () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('returns true for images mode with legacy image_generation scope', () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'image_generation balance:read',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('returns true for responses mode with responses:create scope', () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'responses:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('returns false for responses mode when token only has images:create scope', () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    it('returns false for images mode when token only has responses:create scope', () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'responses:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    it('handles missing scope field gracefully', () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
      })
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    it('returns true when primary token scope contains responses:create', () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'sk_oauth_responses',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('returns false for Responses mode when primary token only has images:create even with unrelated additionalTokens', () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'sk_oauth_images',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
        additionalTokens: [
          {
            accessToken: 'sk_oauth_other',
            expiresAt: Date.now() + 3600000,
            scope: 'other:scope',
          },
        ],
      })
      expect(canUseOAuthForProfile(profile)).toBe(false)
    })

    // Chat/completions image path is the transport for Sakrylle Images mode;
    // canonical image OAuth grants use images:create.
    it('accepts images:create for the chat image path', () => {
      const profile = createProfile({ apiMode: 'images', streamChatCompletionsImage: true })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('accepts legacy image_generation for the chat image path', () => {
      const profile = createProfile({ apiMode: 'images', streamChatCompletionsImage: true })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'image_generation balance:read',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('returns true for the chat image path when chat.completions:create is granted', () => {
      const profile = createProfile({ apiMode: 'images', streamChatCompletionsImage: true })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create chat.completions:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })

    it('still accepts images:create for the non-chat images path (streamChatCompletionsImage off)', () => {
      const profile = createProfile({ apiMode: 'images', streamChatCompletionsImage: false })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      expect(canUseOAuthForProfile(profile)).toBe(true)
    })
  })

  describe('resolveBearerToken', () => {
    it('returns explicit apiKey when present', async () => {
      const profile = createProfile({ apiKey: 'sk-explicit' })
      const token = await resolveBearerToken(profile)
      expect(token).toBe('sk-explicit')
      expect(sakrylleAuth.refreshIfNeeded).not.toHaveBeenCalled()
    })

    it('returns OAuth token when apiKey is empty and OAuth is available', async () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'sk_oauth_abc',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue({
        accessToken: 'sk_oauth_abc',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
      })
      const token = await resolveBearerToken(profile)
      expect(token).toBe('sk_oauth_abc')
    })

    it('throws when apiKey is empty and OAuth is not available', async () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'token',
        expiresAt: Date.now() + 3600000,
        scope: 'balance:read',
      })
      await expect(resolveBearerToken(profile)).rejects.toThrow('missing_credentials')
    })

    it('throws when no token exists', async () => {
      const profile = createProfile()
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue(null)
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue(null)
      await expect(resolveBearerToken(profile)).rejects.toThrow('missing_credentials')
    })

    it('returns primary token only when metadata shows it is a Responses group', async () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'sk_oauth_responses',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
        group: { id: 4, name: 'GPT-Plus' },
      })
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue({
        accessToken: 'sk_oauth_responses',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
        group: { id: 4, name: 'GPT-Plus' },
      })
      const token = await resolveBearerToken(profile)
      expect(token).toBe('sk_oauth_responses')
    })

    it('does not use a metadata-less primary token for Responses requests', async () => {
      const profile = createProfile({ apiMode: 'responses' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'sk_oauth_unknown_group',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
      })
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue({
        accessToken: 'sk_oauth_unknown_group',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
      })
      vi.mocked(sakrylleAccount.fetchMe).mockResolvedValue(null)

      await expect(resolveBearerToken(profile)).rejects.toThrow('missing_credentials')
      expect(sakrylleAuth.refreshWithGroupId).not.toHaveBeenCalled()
    })

    it('uses primary token when it matches', async () => {
      const profile = createProfile({ apiMode: 'images' })
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue({
        accessToken: 'sk_oauth_images',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
        additionalTokens: [
          {
            accessToken: 'sk_oauth_responses',
            expiresAt: Date.now() + 3600000,
            scope: 'responses:create',
          },
        ],
      })
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue({
        accessToken: 'sk_oauth_images',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create',
        additionalTokens: [
          {
            accessToken: 'sk_oauth_responses',
            expiresAt: Date.now() + 3600000,
            scope: 'responses:create',
          },
        ],
      })
      const token = await resolveBearerToken(profile)
      expect(token).toBe('sk_oauth_images')
    })

    it('returns the token for the selected API-mode group', async () => {
      vi.stubGlobal('localStorage', createMockStorage())
      localStorage.setItem('sakrylle-image-playground.selected-groups', JSON.stringify({ images: 9 }))
      const profile = createProfile({ apiMode: 'images' })
      const oauthToken = {
        accessToken: 'sk_oauth_group5',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
        group: { id: 5, name: 'GPT-Image' },
        additionalTokens: [
          {
            accessToken: 'sk_oauth_group9_4k',
            expiresAt: Date.now() + 3600000,
            scope: 'images:create',
            group: { id: 9, name: 'GPT-Image-4K' },
          },
        ],
      }
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue(oauthToken)
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue(oauthToken)

      const token = await resolveBearerToken(profile)

      expect(token).toBe('sk_oauth_group9_4k')
    })

    it('does not fall back to an image group token for Responses requests', async () => {
      const profile = createProfile({ apiMode: 'responses' })
      const oauthToken = {
        accessToken: 'sk_oauth_image_group',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
        group: { id: 11, name: 'GPT-Image-2-4K' },
      }
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue(oauthToken)
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue(oauthToken)
      vi.mocked(sakrylleAccount.fetchMe).mockResolvedValue(null)

      await expect(resolveBearerToken(profile)).rejects.toThrow('missing_credentials')
      expect(sakrylleAuth.refreshWithGroupId).not.toHaveBeenCalled()
    })

    it('refreshes for a selected Responses group when the exact token is missing', async () => {
      vi.stubGlobal('localStorage', createMockStorage())
      localStorage.setItem('sakrylle-image-playground.selected-groups', JSON.stringify({ responses: 9 }))
      const profile = createProfile({ apiMode: 'responses' })
      const oauthToken = {
        accessToken: 'sk_oauth_image_group',
        refreshToken: 'rt',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
        group: { id: 5, name: 'GPT-Image' },
      }
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue(oauthToken)
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue(oauthToken)
      vi.mocked(sakrylleAccount.fetchMe).mockResolvedValue({
        granted_scopes: [],
        effective_capabilities: [],
        allowed_groups: [
          { id: 5, name: 'GPT-Image', capabilities: ['images:create'] },
          { id: 9, name: 'GPT-Pro', capabilities: ['responses:create'] },
        ],
      })
      vi.mocked(sakrylleAuth.refreshWithGroupId).mockResolvedValue({
        accessToken: 'sk_oauth_responses_group',
        refreshToken: 'rt-next',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
        group: { id: 9, name: 'GPT-Pro' },
      })

      await expect(resolveBearerToken(profile)).resolves.toBe('sk_oauth_responses_group')
      expect(sakrylleAuth.refreshWithGroupId).toHaveBeenCalledWith(9)
    })
  })

  describe('canUseChatCompletionsImagePath', () => {
    it('returns false when the selected image group token only has images:create', async () => {
      vi.stubGlobal('localStorage', createMockStorage())
      localStorage.setItem('sakrylle-image-playground.selected-groups', JSON.stringify({ images: 5 }))
      const token = {
        accessToken: 'sk_oauth_images',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create responses:create',
        group: { id: 5, name: 'GPT-Image' },
      }
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue(token)
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue(token)

      await expect(canUseChatCompletionsImagePath(createProfile())).resolves.toBe(false)
    })

    it('returns true when the selected image group token has chat.completions:create', async () => {
      vi.stubGlobal('localStorage', createMockStorage())
      localStorage.setItem('sakrylle-image-playground.selected-groups', JSON.stringify({ images: 5 }))
      const token = {
        accessToken: 'sk_oauth_images',
        expiresAt: Date.now() + 3600000,
        scope: 'images:create chat.completions:create',
        group: { id: 5, name: 'GPT-Image' },
      }
      vi.mocked(sakrylleAuth.getStoredToken).mockReturnValue(token)
      vi.mocked(sakrylleAuth.refreshIfNeeded).mockResolvedValue(token)

      await expect(canUseChatCompletionsImagePath(createProfile())).resolves.toBe(true)
    })

    it('returns true for explicit API keys because the server validates the key', async () => {
      await expect(canUseChatCompletionsImagePath(createProfile({ apiKey: 'sk-explicit' }))).resolves.toBe(true)
      expect(sakrylleAuth.refreshIfNeeded).not.toHaveBeenCalled()
    })
  })
})
