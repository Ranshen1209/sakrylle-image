import { OUTPUT_FORMATS, type ApiProfile, type AppSettings, type ImageSearchGrounding, type ResponsesOutputItem, type TaskParams, type TaskRecord } from '../types'
import { blobToDataUrl } from './dataUrl'
import i18n from './i18n'
import { DEFAULT_SVG_MODEL } from './imageModels'
import { apiFetch, isTauri } from './platform'

export const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
}

/** GPT Image 2.6 的 complexity、SVG 和 GIF 字段；Images API 生成请求和 Responses 图像工具格式相同 */
export function applyGptImage26Params(target: Record<string, unknown>, params: TaskParams, profile: ApiProfile) {
  if (params.complexity !== 'auto') target.complexity = params.complexity
  if (params.output_format === 'svg') {
    target.svg = { model: profile.svgModel?.trim() || DEFAULT_SVG_MODEL }
  }
  if (params.output_format === 'gif') {
    target.frame_count = params.frame_count
    target.frame_duration_ms = params.frame_duration_ms
  }
}

export const MAX_MASK_EDIT_FILE_BYTES = 50 * 1024 * 1024
export const MAX_IMAGE_INPUT_PAYLOAD_BYTES = 512 * 1024 * 1024
export const PROMPT_REWRITE_GUARD_PREFIX = 'Treat everything after this line as one complete image-generation prompt, including the resolution instruction. Follow it exactly without rewriting or omitting anything:'

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  nativeTransparentBackground?: boolean
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
  /** 与 inputImageDataUrls 按索引对齐的原链接，不是通过链接添加的为 null */
  inputImageUrls?: (string | null)[]
  maskDataUrl?: string
  /** 第一张输入图上的透明标注层，仅 Images API 编辑接口原生支持 */
  markupDataUrl?: string
  skipCodexCliSizePrompt?: boolean
  onPromptHintsPrepared?: (hints: TaskRecord['promptHints']) => void
  onFalRequestEnqueued?: (request: { requestId: string; endpoint: string }) => void
  onCustomTaskEnqueued?: (task: { taskId: string }) => void
  onPartialImage?: (partial: { image: string; partialImageIndex?: number; requestIndex?: number; final?: boolean }) => void
}

export interface CallApiResult {
  searchGrounding?: ImageSearchGrounding[]
  /** base64 data URL 列表 */
  images: string[]
  /** 并发拆分时的部分失败信息（成功 ≥1 张但有失败时存在），全成功 / 全失败时 undefined */
  partialFailure?: { failedCount: number; firstErrorMessage: string }
  /** API 返回的实际生效参数 */
  actualParams?: Partial<TaskParams>
  /** 每张图片对应的实际生效参数 */
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  /** 每张图片对应的 API 改写提示词 */
  revisedPrompts?: Array<string | undefined>
  /** API 返回的原始图片 HTTP URL（非 base64 时记录） */
  rawImageUrls?: string[]
  /** 并发多图请求中失败的单张请求 */
  failedRequests?: Array<{ requestIndex: number; error: string }>
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

export function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:')
}

export function normalizeBase64Image(value: string, fallbackMime: string): string {
  if (value.startsWith('data:')) return value
  const mime = value.startsWith('/9j/') ? 'image/jpeg' : value.startsWith('iVBORw0KGgo') ? 'image/png' : value.startsWith('UklGR') ? 'image/webp' : fallbackMime
  return `data:${mime};base64,${value}`
}

export function getResponsesImageResultBase64(result: ResponsesOutputItem['result']): string | undefined {
  const b64 = typeof result === 'string'
    ? result
    : result && typeof result === 'object'
    ? typeof result.b64_json === 'string'
      ? result.b64_json
      : typeof result.base64 === 'string'
      ? result.base64
      : typeof result.image === 'string'
      ? result.image
      : typeof result.data === 'string'
      ? result.data
      : ''
    : ''

  return b64.trim() ? b64 : undefined
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function getDataUrlEncodedByteSize(dataUrl: string): number {
  return dataUrl.length
}

export function getDataUrlDecodedByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return dataUrl.length

  const meta = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  if (!/;base64/i.test(meta)) return decodeURIComponent(payload).length

  const normalized = payload.replace(/\s/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

function assertMaxBytes(label: string, bytes: number, maxBytes: number) {
  if (bytes > maxBytes) {
    throw new Error(i18n.t('upstreamSync.message43', { value0: label, value1: formatMiB(bytes), value2: formatMiB(maxBytes) }))
  }
}

export function assertImageInputPayloadSize(bytes: number) {
  assertMaxBytes(i18n.t("errors.imageInputPayload"), bytes, MAX_IMAGE_INPUT_PAYLOAD_BYTES)
}

export function assertMaskEditFileSize(label: string, bytes: number) {
  assertMaxBytes(label, bytes, MAX_MASK_EDIT_FILE_BYTES)
}

export let IMAGE_FETCH_CORS_HINT = i18n.t("errors.imageFetchCorsHint")
export let STREAMING_UNSUPPORTED_HINT = i18n.t("upstreamSync.hintThisApiMayNotSupportStreamingTry")
export let STREAMING_FORMAT_HINT = i18n.t("upstreamSync.hintTheApiReturnedAnUnreadableStreamFormat")
export let TRANSPARENT_BACKGROUND_UNSUPPORTED_HINT = i18n.t("upstreamSync.hintThisApiDoesNotSupportNativeTransparent")
const IMAGE_TOOL_DROPPED_ERROR = /Tool choice 'required' must be specified with 'tools' parameter\./i
export const IMAGE_TOOL_DROPPED_HINT = '提示：当前使用的 API 可能未正确转发图像生成工具，请尝试更换支持该工具的接口或模型。'

const LEGACY_IMAGE_FETCH_CORS_HINTS: ReadonlyArray<string> = [
  IMAGE_FETCH_CORS_HINT,
  ' Use the link button to copy the result link, or enable "Return Base64 image data" to avoid this.',
]

export function getImageFetchCorsHint(): string {
  return i18n.t('errors.imageFetchCorsHint')
}

export function messageContainsImageFetchCorsHint(message: string): boolean {
  if (!message) return false
  if (message.includes(getImageFetchCorsHint())) return true
  return LEGACY_IMAGE_FETCH_CORS_HINTS.some((hint) => message.includes(hint))
}

export function appendStreamingUnsupportedHint(message: string): string {
  return message ? `${message}\n${STREAMING_UNSUPPORTED_HINT}` : STREAMING_UNSUPPORTED_HINT
}

export function appendStreamingFormatHint(message: string): string {
  return message ? `${message}\n${STREAMING_FORMAT_HINT}` : STREAMING_FORMAT_HINT
}

export function maybeAppendTransparentBackgroundHint(message: string): string {
  if (!/transparent background is not supported for this model\.?/i.test(message)) return message
  return `${message}\n${TRANSPARENT_BACKGROUND_UNSUPPORTED_HINT}`
}

/** 部分 API 转发 Responses 请求时会丢弃 image_generation 工具，却保留 tool_choice，服务端因此报错 */
export function maybeAppendImageToolDroppedHint(message: string): string {
  if (!IMAGE_TOOL_DROPPED_ERROR.test(message)) return message
  return `${message}\n${IMAGE_TOOL_DROPPED_HINT}`
}

/** 请求超时中止时使用的原因，替代浏览器默认的英文“signal is aborted without reason”；仍为 AbortError，不改变错误分类 */
export function createRequestTimeoutError(timeoutSeconds: number) {
  return new DOMException(`请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。`, 'AbortError')
}

/** 排除明确与流式无关的状态码后追加提示 */
export function maybeAppendStreamingHint(message: string, status: number, streamImages?: boolean): string {
  const transparentMessage = maybeAppendTransparentBackgroundHint(message)
  if (transparentMessage !== message) return transparentMessage
  if (IMAGE_TOOL_DROPPED_ERROR.test(message)) return message
  if (!streamImages) return message
  if (status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500) {
    return message
  }
  return appendStreamingUnsupportedHint(message)
}

async function probeNoCorsReachability(url: string, timeoutMs = 8000): Promise<'opaque' | 'reachable' | 'failed'> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: controller.signal,
    })
    return response.type === 'opaque' ? 'opaque' : 'reachable'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timeoutId)
  }
}

export class ImageDownloadError extends Error {
  readonly rawImageUrls: string[]
  constructor(url: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ImageDownloadError'
    this.rawImageUrls = [url]
  }
}

export async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal): Promise<string> {
  try {
    return await downloadImageUrlAsDataUrl(url, fallbackMime, signal)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ImageDownloadError(url, error)
  }
}

async function downloadImageUrlAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal): Promise<string> {
  if (isDataUrl(url)) return url

  let response: Response
  try {
    response = await apiFetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    })
  } catch (err) {
    if (err instanceof TypeError) {
      // 客户端由 Rust 侧发出请求，不存在跨域问题，也不需要 no-cors 探测
      if (isTauri) throw new Error(`图片链接下载失败（可能因链接过期或网络异常）。${IMAGE_FETCH_CORS_HINT}`)
      const probe = await probeNoCorsReachability(url)
      if (probe === 'opaque') {
        throw new Error(i18n.t('upstreamSync.message44', { value0: IMAGE_FETCH_CORS_HINT }))
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error(i18n.t('upstreamSync.message45', { value0: IMAGE_FETCH_CORS_HINT }))
      }
      throw new Error(i18n.t('upstreamSync.message46', { value0: IMAGE_FETCH_CORS_HINT }))
    }
    throw err
  }

  if (!response.ok) {
    throw new Error(i18n.t('upstreamSync.message47', { value0: response.status }))
  }

  const blob = await response.blob()
  return blobToDataUrl(blob, fallbackMime)
}

const MODERATION_STAGE_LABELS: Record<string, string> = {
  input: '提示词或参考图',
  output: '生成结果',
}

/** moderation_blocked 错误可能附带拦截阶段和粗粒度类别 */
export function appendModerationDetails(message: string, details: unknown): string {
  if (!details || typeof details !== 'object') return message
  const record = details as Record<string, unknown>
  const stage = typeof record.moderation_stage === 'string' ? MODERATION_STAGE_LABELS[record.moderation_stage] : undefined
  const categories = Array.isArray(record.categories)
    ? record.categories.filter((item): item is string => typeof item === 'string' && Boolean(item))
    : []
  const parts = [
    stage ? `拦截来源：${stage}` : '',
    categories.length ? `类别：${categories.join('、')}` : '',
  ].filter(Boolean)
  return parts.length ? `${message}\n${parts.join('；')}` : message
}

export async function getApiErrorMessage(response: Response): Promise<string> {
  let errorMsg = `HTTP ${response.status}`
  const textResponse = response.clone()
  try {
    const errJson = await response.json()
    if (errJson.error?.message) errorMsg = appendModerationDetails(errJson.error.message, errJson.error.moderation_details)
    else if (typeof errJson.detail === 'string') errorMsg = errJson.detail
    else if (Array.isArray(errJson.detail)) errorMsg = errJson.detail.map((item: unknown) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
    else if (typeof errJson.error === 'string') errorMsg = errJson.error
    else if (errJson.message) errorMsg = errJson.message
  } catch {
    try {
      errorMsg = await textResponse.text()
    } catch {
      /* ignore */
    }
  }
  return errorMsg
}

export function pickActualParams(source: unknown): Partial<TaskParams> {
  if (!source || typeof source !== 'object') return {}
  const record = source as Record<string, unknown>
  const actualParams: Partial<TaskParams> = {}

  if (typeof record.size === 'string') actualParams.size = record.size
  if (record.quality === 'auto' || record.quality === 'low' || record.quality === 'medium' || record.quality === 'high' || record.quality === 'xhigh' || record.quality === 'max') {
    actualParams.quality = record.quality
  }
  if (OUTPUT_FORMATS.includes(record.output_format as TaskParams['output_format'])) {
    actualParams.output_format = record.output_format as TaskParams['output_format']
  }
  if (typeof record.output_compression === 'number') actualParams.output_compression = record.output_compression
  if (record.moderation === 'auto' || record.moderation === 'low') actualParams.moderation = record.moderation
  if (typeof record.n === 'number') actualParams.n = record.n

  return actualParams
}

export function mergeActualParams(...sources: Array<Partial<TaskParams> | undefined>): Partial<TaskParams> | undefined {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}

function refreshErrorHints() {
  IMAGE_FETCH_CORS_HINT = i18n.t("errors.imageFetchCorsHint")
  STREAMING_UNSUPPORTED_HINT = i18n.t("upstreamSync.hintThisApiMayNotSupportStreamingTry")
  STREAMING_FORMAT_HINT = i18n.t("upstreamSync.hintTheApiReturnedAnUnreadableStreamFormat")
  TRANSPARENT_BACKGROUND_UNSUPPORTED_HINT = i18n.t("upstreamSync.hintThisApiDoesNotSupportNativeTransparent")
}
i18n.on("languageChanged", refreshErrorHints)
i18n.on("initialized", refreshErrorHints)

export function mergeConcurrentApiResults(results: PromiseSettledResult<CallApiResult>[]): CallApiResult {
  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<CallApiResult> => result.status === 'fulfilled')
    .map((result) => result.value)
  if (!successfulResults.length) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')!
    throw firstError.reason
  }

  const images = successfulResults.flatMap((result) => result.images)
  const actualParamsList = successfulResults.flatMap((result) =>
    result.actualParamsList?.length ? result.actualParamsList : result.images.map(() => result.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((result) =>
    result.revisedPrompts?.length ? result.revisedPrompts : result.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((result) => result.rawImageUrls ?? [])
  const searchGrounding = successfulResults.flatMap((result) => result.searchGrounding ?? [])
  const failedRequests = results.flatMap((result, requestIndex) =>
    result.status === 'rejected' ? [{ requestIndex, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }] : [],
  )

  return {
    images,
    actualParams: mergeActualParams(successfulResults[0].actualParams ?? {}, { n: images.length }),
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
    ...(searchGrounding.length ? { searchGrounding } : {}),
    ...(failedRequests.length ? { failedRequests } : {}),
  }
}
