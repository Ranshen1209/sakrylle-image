import i18n from './i18n'

// 这些 sentinel token 会被写入持久化数据（IndexedDB），用于不依赖语言的相等判断。
// 用户切换语言后，旧记录里仍带历史值；因此识别函数同时识别 sentinel 和已知历史字面量。

export const SENTINEL_AGENT_STOPPED = '__sakrylle:agent_stopped__'
export const SENTINEL_OPENAI_INTERRUPTED = '__sakrylle:openai_interrupted__'

// 来自 zh.json / en.json 的历史值（i18n 引入前以及切换语言期间写入的旧记录）
const LEGACY_AGENT_STOPPED: ReadonlyArray<string> = ['已停止生成。', 'Generation stopped.']
const LEGACY_OPENAI_INTERRUPTED: ReadonlyArray<string> = ['请求中断', 'Request interrupted']

// agent.errorMessagePrefix 的历史值，用于检测一条 message.content 是否是错误回复
const LEGACY_AGENT_ERROR_PREFIXES: ReadonlyArray<string> = ['请求失败：', 'Request failed: ']

// 缓存当前语言下的错误前缀，避免在渲染热路径（遍历 messages）反复调用 i18n.t。
// 模块加载时 i18n 可能尚未完成异步 init —— 此时 t() 会回退到 key 字符串，
// 后续 'languageChanged' / 'initialized' 事件会刷新缓存。
let cachedAgentErrorPrefix = i18n.t('agent.errorMessagePrefix')

function refreshCachedAgentErrorPrefix(): void {
  cachedAgentErrorPrefix = i18n.t('agent.errorMessagePrefix')
}

i18n.on('languageChanged', refreshCachedAgentErrorPrefix)
i18n.on('initialized', refreshCachedAgentErrorPrefix)

export function isAgentStoppedSentinel(value: string | undefined | null): boolean {
  if (!value) return false
  if (value === SENTINEL_AGENT_STOPPED) return true
  return LEGACY_AGENT_STOPPED.includes(value)
}

export function isOpenAIInterruptedSentinel(value: string | undefined | null): boolean {
  if (!value) return false
  if (value === SENTINEL_OPENAI_INTERRUPTED) return true
  return LEGACY_OPENAI_INTERRUPTED.includes(value)
}

/** 渲染时翻译 sentinel；非 sentinel 原样返回；空值返回空串 */
export function renderAgentStopped(value?: string | null): string {
  if (value && !isAgentStoppedSentinel(value)) return value
  return i18n.t('agent.stopped')
}

export function renderOpenAIInterrupted(value?: string | null): string {
  if (value && !isOpenAIInterruptedSentinel(value)) return value
  return i18n.t('errors.openaiInterrupted')
}

/** 解析 task.error / round.error 用于显示：是 sentinel 则翻译，否则返回原值或 fallback */
export function resolveErrorForDisplay(value: string | undefined | null, fallback = ''): string {
  if (!value) return fallback
  if (isAgentStoppedSentinel(value)) return i18n.t('agent.stopped')
  if (isOpenAIInterruptedSentinel(value)) return i18n.t('errors.openaiInterrupted')
  return renderPersistedError(value)
}

/** 检查 message.content 是否以错误前缀开头（兼容中英历史值与当前语言） */
export function startsWithAgentErrorPrefix(content: string | undefined | null): boolean {
  if (!content) return false
  if (cachedAgentErrorPrefix && content.startsWith(cachedAgentErrorPrefix)) return true
  return LEGACY_AGENT_ERROR_PREFIXES.some((prefix) => content.startsWith(prefix))
}

/** 去除 message.content 的错误前缀（兼容中英） */
export function stripAgentErrorPrefix(content: string): string {
  if (cachedAgentErrorPrefix && content.startsWith(cachedAgentErrorPrefix)) {
    return content.slice(cachedAgentErrorPrefix.length)
  }
  for (const prefix of LEGACY_AGENT_ERROR_PREFIXES) {
    if (content.startsWith(prefix)) return content.slice(prefix.length)
  }
  return content
}

/** Persist application-generated errors by translation key; preserve provider errors verbatim. */
export function persistErrorMessage(value: string | null | undefined): string | null {
  if (!value) return value ?? null
  if (isAgentStoppedSentinel(value)) return SENTINEL_AGENT_STOPPED
  if (isOpenAIInterruptedSentinel(value)) return SENTINEL_OPENAI_INTERRUPTED
  if (value.startsWith('__sakrylle:i18n:')) return value
  for (const language of ['zh', 'en']) {
    for (const namespace of ['errors', 'upstreamSync']) {
      const messages = i18n.getResource(language, 'translation', namespace) as Record<string, unknown> | undefined
      for (const [key, message] of Object.entries(messages ?? {})) {
        if (typeof message !== 'string') continue
        const names: string[] = []
        const escaped = message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = escaped.replace(/\\\{\\\{([^{}]+)\\\}\\\}/g, (_, name: string) => {
          names.push(name)
          return '([\\s\\S]*?)'
        })
        const match = new RegExp(`^${pattern}$`).exec(value)
        if (!match) continue
        const params = Object.fromEntries(names.map((name, index) => [name, match[index + 1]]))
        return `__sakrylle:i18n:${JSON.stringify({ key: `${namespace}.${key}`, params })}`
      }
    }
  }
  return value
}

function renderPersistedError(value: string): string {
  if (!value.startsWith('__sakrylle:i18n:')) return value
  try {
    const record = JSON.parse(value.slice('__sakrylle:i18n:'.length))
    if (typeof record.key !== 'string' || !/^(errors|upstreamSync)\./.test(record.key)) return value
    return i18n.t(record.key, record.params ?? {}) as string
  } catch {
    return value
  }
}

const AGENT_ERROR_SENTINEL = '__sakrylle:agent_error:'

export function persistAssistantStatus(content: string): string {
  if (content.startsWith(AGENT_ERROR_SENTINEL)) return content
  if (startsWithAgentErrorPrefix(content)) {
    return AGENT_ERROR_SENTINEL + (persistErrorMessage(stripAgentErrorPrefix(content)) ?? '')
  }
  for (const stopped of [...LEGACY_AGENT_STOPPED, SENTINEL_AGENT_STOPPED]) {
    if (content === stopped) return SENTINEL_AGENT_STOPPED
    if (content.endsWith('\n\n' + stopped)) return content.slice(0, -stopped.length) + SENTINEL_AGENT_STOPPED
  }
  return content
}

export function renderAssistantStatus(content: string): string {
  if (content.startsWith(AGENT_ERROR_SENTINEL)) {
    return i18n.t('agent.errorMessagePrefix') + resolveErrorForDisplay(content.slice(AGENT_ERROR_SENTINEL.length))
  }
  return content.split(SENTINEL_AGENT_STOPPED).join(i18n.t('agent.stopped'))
}
