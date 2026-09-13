import { persistAssistantStatus, renderAssistantStatus } from './agentSentinels'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from './i18n'
import {
  SENTINEL_AGENT_STOPPED,
  SENTINEL_OPENAI_INTERRUPTED,
  isAgentStoppedSentinel,
  isOpenAIInterruptedSentinel,
  renderAgentStopped,
  renderOpenAIInterrupted,
  resolveErrorForDisplay,
  startsWithAgentErrorPrefix,
  stripAgentErrorPrefix,
} from './agentSentinels'

describe('agentSentinels', () => {
  let originalLanguage: string

  beforeEach(() => {
    originalLanguage = i18n.language
  })

  afterEach(async () => {
    await i18n.changeLanguage(originalLanguage)
  })

  describe('isAgentStoppedSentinel', () => {
    it('recognizes the new sentinel token', () => {
      expect(isAgentStoppedSentinel(SENTINEL_AGENT_STOPPED)).toBe(true)
    })

    it('recognizes legacy zh value', () => {
      expect(isAgentStoppedSentinel('已停止生成。')).toBe(true)
    })

    it('recognizes legacy en value', () => {
      expect(isAgentStoppedSentinel('Generation stopped.')).toBe(true)
    })

    it('rejects empty / null / undefined', () => {
      expect(isAgentStoppedSentinel('')).toBe(false)
      expect(isAgentStoppedSentinel(null)).toBe(false)
      expect(isAgentStoppedSentinel(undefined)).toBe(false)
    })

    it('rejects unrelated strings', () => {
      expect(isAgentStoppedSentinel('Some unrelated error')).toBe(false)
      expect(isAgentStoppedSentinel('普通错误信息')).toBe(false)
    })
  })

  describe('isOpenAIInterruptedSentinel', () => {
    it('recognizes the new sentinel token', () => {
      expect(isOpenAIInterruptedSentinel(SENTINEL_OPENAI_INTERRUPTED)).toBe(true)
    })

    it('recognizes legacy zh and en values', () => {
      expect(isOpenAIInterruptedSentinel('请求中断')).toBe(true)
      expect(isOpenAIInterruptedSentinel('Request interrupted')).toBe(true)
    })

    it('rejects empty and unrelated values', () => {
      expect(isOpenAIInterruptedSentinel('')).toBe(false)
      expect(isOpenAIInterruptedSentinel(undefined)).toBe(false)
      expect(isOpenAIInterruptedSentinel('Other error')).toBe(false)
    })
  })

  describe('renderAgentStopped', () => {
    it('returns current-language translation for sentinel value', async () => {
      await i18n.changeLanguage('en')
      expect(renderAgentStopped(SENTINEL_AGENT_STOPPED)).toBe(i18n.t('agent.stopped'))

      await i18n.changeLanguage('zh')
      expect(renderAgentStopped(SENTINEL_AGENT_STOPPED)).toBe(i18n.t('agent.stopped'))
    })

    it('returns translation for legacy values too', async () => {
      await i18n.changeLanguage('en')
      expect(renderAgentStopped('已停止生成。')).toBe(i18n.t('agent.stopped'))
    })

    it('passes through non-sentinel values', () => {
      expect(renderAgentStopped('Custom error message')).toBe('Custom error message')
    })

    it('returns translation when value is empty', async () => {
      await i18n.changeLanguage('zh')
      expect(renderAgentStopped(undefined)).toBe(i18n.t('agent.stopped'))
      expect(renderAgentStopped('')).toBe(i18n.t('agent.stopped'))
    })
  })

  describe('renderOpenAIInterrupted', () => {
    it('translates sentinel and legacy values', async () => {
      await i18n.changeLanguage('en')
      expect(renderOpenAIInterrupted(SENTINEL_OPENAI_INTERRUPTED)).toBe(i18n.t('errors.openaiInterrupted'))
      expect(renderOpenAIInterrupted('请求中断')).toBe(i18n.t('errors.openaiInterrupted'))
    })

    it('passes through unrelated values', () => {
      expect(renderOpenAIInterrupted('HTTP 500')).toBe('HTTP 500')
    })
  })

  describe('resolveErrorForDisplay', () => {
    it('resolves sentinel to current-language translation', async () => {
      await i18n.changeLanguage('en')
      expect(resolveErrorForDisplay(SENTINEL_AGENT_STOPPED)).toBe(i18n.t('agent.stopped'))
      expect(resolveErrorForDisplay(SENTINEL_OPENAI_INTERRUPTED)).toBe(i18n.t('errors.openaiInterrupted'))
    })

    it('resolves legacy zh value when in en mode', async () => {
      await i18n.changeLanguage('en')
      expect(resolveErrorForDisplay('已停止生成。')).toBe(i18n.t('agent.stopped'))
    })

    it('returns fallback for empty values', () => {
      expect(resolveErrorForDisplay(null, 'fallback')).toBe('fallback')
      expect(resolveErrorForDisplay('', 'fallback')).toBe('fallback')
    })

    it('returns the original message for non-sentinel values', () => {
      expect(resolveErrorForDisplay('arbitrary message')).toBe('arbitrary message')
    })
  })

  describe('startsWithAgentErrorPrefix', () => {
    it('detects current-language prefix', async () => {
      await i18n.changeLanguage('zh')
      expect(startsWithAgentErrorPrefix('请求失败：xxx')).toBe(true)

      await i18n.changeLanguage('en')
      expect(startsWithAgentErrorPrefix('Request failed: xxx')).toBe(true)
    })

    it('detects legacy values regardless of current language', async () => {
      await i18n.changeLanguage('en')
      expect(startsWithAgentErrorPrefix('请求失败：legacy zh content')).toBe(true)

      await i18n.changeLanguage('zh')
      expect(startsWithAgentErrorPrefix('Request failed: legacy en content')).toBe(true)
    })

    it('rejects empty / non-error content', () => {
      expect(startsWithAgentErrorPrefix('')).toBe(false)
      expect(startsWithAgentErrorPrefix(undefined)).toBe(false)
      expect(startsWithAgentErrorPrefix('hello world')).toBe(false)
    })
  })

  describe('stripAgentErrorPrefix', () => {
    it('strips current-language prefix', async () => {
      await i18n.changeLanguage('zh')
      expect(stripAgentErrorPrefix('请求失败：detail')).toBe('detail')

      await i18n.changeLanguage('en')
      expect(stripAgentErrorPrefix('Request failed: detail')).toBe('detail')
    })

    it('strips legacy prefixes', async () => {
      await i18n.changeLanguage('en')
      expect(stripAgentErrorPrefix('请求失败：legacy')).toBe('legacy')
    })

    it('returns content unchanged when no prefix matches', () => {
      expect(stripAgentErrorPrefix('hello')).toBe('hello')
    })
  })
})

describe('persisted translated errors after upstream extraction', () => {
  it('stores a key and parameters and renders it in the selected language', async () => {
    const { persistErrorMessage, resolveErrorForDisplay } = await import('./agentSentinels')
    await i18n.changeLanguage('zh')
    const stored = persistErrorMessage(i18n.t('upstreamSync.message51', { value0: 'HTTP 503' }))
    expect(stored).toContain('__sakrylle:i18n:')
    expect(stored).not.toContain('无法继续恢复任务')
    await i18n.changeLanguage('en')
    expect(resolveErrorForDisplay(stored)).toBe('Cannot resume task: HTTP 503')
    expect(persistErrorMessage('provider-specific opaque failure')).toBe('provider-specific opaque failure')
    await i18n.changeLanguage('zh')
  })
})

it('stores assistant application status independently of language and leaves model text intact', async () => {
  await i18n.changeLanguage('zh')
  const stopped = persistAssistantStatus('Model answer\n\n已停止生成。')
  const failed = persistAssistantStatus('请求失败：请求中断')
  expect(stopped).toBe('Model answer\n\n__sakrylle:agent_stopped__')
  expect(failed).toBe('__sakrylle:agent_error:__sakrylle:openai_interrupted__')
  expect(persistAssistantStatus('Normal model text')).toBe('Normal model text')
  await i18n.changeLanguage('en')
  expect(renderAssistantStatus(stopped)).toBe('Model answer\n\nGeneration stopped.')
  expect(renderAssistantStatus(failed)).toBe('Request failed: Request interrupted')
})
