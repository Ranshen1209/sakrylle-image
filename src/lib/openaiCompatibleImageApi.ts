import { DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type CustomProviderDefinition, type CustomProviderPollMapping, type CustomProviderResultMapping, type CustomProviderSubmitMapping, type ImageApiResponse, type ImageResponseItem, type ResponsesApiResponse, type ResponsesOutputItem, type TaskParams } from '../types'
import { dataUrlToBlob, imageDataUrlToPngBlob, maskDataUrlToPngBlob } from './canvasImage'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import i18n from './i18n'
import {
  applyGptImage26Params,
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  appendStreamingFormatHint,
  createRequestTimeoutError,
  maybeAppendStreamingHint,
  type CallApiOptions,
  type CallApiResult,
  fetchImageUrlAsDataUrl,
  ImageDownloadError,
  getApiErrorMessage,
  getDataUrlDecodedByteSize,
  getDataUrlEncodedByteSize,
  getResponsesImageResultBase64,
  isDataUrl,
  isHttpUrl,
  mergeActualParams,
  mergeConcurrentApiResults,
  maybeAppendTransparentBackgroundHint,
  maybeAppendImageToolDroppedHint,
  MIME_MAP,
  normalizeBase64Image,
  pickActualParams,
  PROMPT_REWRITE_GUARD_PREFIX,
} from './imageApiShared'
import { canUseChatCompletionsImagePath, canUseOAuthForProfile, resolveBearerToken } from './oauthFallback'
import { getSakrylleImageRequestParams } from './sakrylleImageSize'
import { callImagesApiViaChat } from './chatCompletionsImageApi'
import { DEFAULT_IMAGES_MODEL, getImageGenerationModel, getImageModelFamily, isVectorOrAnimatedFormat, usesGrokSizeParams } from './imageModels'
import { getImageModelParams } from './imageModelParams'
import { OPENAI_IMAGE_TASK_PROVIDER, resolveCustomProviderModel } from './imageProviderMappings'
import { apiFetch, FetchConnectError } from './platform'
import { isEventStreamResponse, readJsonServerSentEvents } from './serverSentEvents'
import { prependCodexCliSizePrompt } from './size'

export { PROMPT_REWRITE_GUARD_PREFIX } from './imageApiShared'
export { readJsonServerSentEvents } from './serverSentEvents'

function isSakrylleApiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.sakrylle.com'
  } catch {
    return baseUrl.toLowerCase().includes('api.sakrylle.com')
  }
}

function getStreamPartialImages(profile: ApiProfile): number {
  return profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
}

export function shouldUseChatImagePath(profile: ApiProfile): boolean {
  return profile.provider === 'openai' &&
    profile.apiMode === 'images' &&
    profile.model === DEFAULT_IMAGES_MODEL &&
    !profile.codexCli &&
    profile.streamChatCompletionsImage === true &&
    isSakrylleApiBaseUrl(profile.baseUrl)
}

/** Sakrylle single-image requests share a fixed six-request concurrency limit. */
const MAX_CONCURRENT_IMAGE_REQUESTS = 6
/** 可重试错误的重试次数 */
const IMAGE_REQUEST_MAX_RETRIES = 1
/** 重试前的退避时长（毫秒） */
const IMAGE_REQUEST_RETRY_DELAY_MS = 800
/** "凑满 N" 的额外补发预算系数：最多额外补发 N 次（总请求 ≤ 2N），防止持续失败时无限烧钱 */
const IMAGE_REQUEST_REFILL_BUDGET_FACTOR = 1

function createOpenAICompatiblePaths() {
  return {
    generationPath: 'images/generations',
    editPath: 'images/edits',
  }
}

function appendQuery(path: string, query?: Record<string, string>): string {
  if (!query || !Object.keys(query).length) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) params.set(key, value)
  return `${path}${path.includes('?') ? '&' : '?'}${params.toString()}`
}

function getByPath(source: unknown, path: string | undefined): unknown {
  if (!path) return source
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (current == null) return undefined
    if (/^\d+$/.test(key) && Array.isArray(current)) return current[Number(key)]
    if (typeof current === 'object') return (current as Record<string, unknown>)[key]
    return undefined
  }, source)
}

function getAllByPath(source: unknown, path: string | undefined): unknown[] {
  if (!path) return [source]
  const parts = path.split('.').filter(Boolean)
  let current: unknown[] = [source]

  for (const key of parts) {
    const next: unknown[] = []
    for (let item of current) {
      if (item == null) continue
      // 部分任务接口把结果对象编码成 JSON 字符串。
      if (typeof item === 'string' && /^[\[{]/.test(item.trim())) {
        try { item = JSON.parse(item) } catch { continue }
      }
      if (key === '*') {
        if (Array.isArray(item)) next.push(...item)
        else if (typeof item === 'object') next.push(...Object.values(item as Record<string, unknown>))
        continue
      }
      if (/^\d+$/.test(key) && Array.isArray(item)) {
        next.push(item[Number(key)])
        continue
      }
      if (typeof item === 'object') next.push((item as Record<string, unknown>)[key])
    }
    current = next
  }

  return current.flatMap((item) => Array.isArray(item) ? item : [item]).filter((item) => item != null)
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** worker-pool 并发限流：最多 limit 个同时在飞，结果按输入顺序返回 */
export async function runWithConcurrency<T>(
  factories: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(factories.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(limit, factories.length))

  async function worker() {
    while (nextIndex < factories.length) {
      const current = nextIndex++
      try {
        results[current] = { status: 'fulfilled', value: await factories[current]() }
      } catch (reason) {
        results[current] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

/** 判定错误是否值得重试：空闲超时可重试，整体超时和用户取消不可重试 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ImageDownloadError) return false
  // 空闲超时:上游卡死,重试可能换账号成功 → 可重试
  if (err instanceof Error && err.name === 'IdleTimeout') return true
  // 整体超时:有字节流动但到 600s,真太慢,重试只是再烧时间和钱 → 不可重试
  if (err instanceof Error && err.name === 'OverallTimeout') return false
  // 用户主动取消:绝不重试
  if (err instanceof DOMException && err.name === 'AbortError') return false
  if (err instanceof TypeError) return true
  const status = (err as { httpStatus?: unknown } | null)?.httpStatus
  if (typeof status === 'number') {
    return status === 429 || status >= 500
  }
  return false
}

const ACCOUNT_POOL_EXHAUSTED_MARKER = 'No available compatible accounts'

function isAccountPoolExhausted(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return message.includes(ACCOUNT_POOL_EXHAUSTED_MARKER)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 包裹单次子请求：可重试错误退避后重试，不可重试错误立即抛 */
export async function callWithRetry<T>(fn: () => Promise<T>, maxRetries = IMAGE_REQUEST_MAX_RETRIES): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableError(err)) throw err
      attempt++
      await delay(IMAGE_REQUEST_RETRY_DELAY_MS)
    }
  }
}

/** 从失败数 + 首个错误聚合部分失败信息（凑满 N 后仍有缺口时透出） */
export function buildPartialFailure(
  failedCountOrResults: number | PromiseSettledResult<unknown>[],
  firstErrorOrSuccessCount: unknown,
): CallApiResult['partialFailure'] {
  if (Array.isArray(failedCountOrResults)) {
    const results = failedCountOrResults
    const successCount = typeof firstErrorOrSuccessCount === 'number' ? firstErrorOrSuccessCount : 0
    if (successCount === 0 || successCount === results.length) return undefined
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    const reason = firstError?.reason
    const firstErrorMessage = reason instanceof Error ? reason.message : String(reason ?? '')
    return { failedCount: results.length - successCount, firstErrorMessage }
  }

  const failedCount = failedCountOrResults
  const firstError = firstErrorOrSuccessCount
  if (failedCount <= 0) return undefined
  const firstErrorMessage = firstError instanceof Error ? firstError.message : String(firstError ?? '')
  return { failedCount, firstErrorMessage }
}

/** 构造带 HTTP status 的错误（供 isRetryableError 分类），同时保留流式提示文案。 */
async function makeApiError(response: Response, streamImages?: boolean): Promise<Error> {
  const errorMessage = await getApiErrorMessage(response)
  const err = new Error(maybeAppendStreamingHint(maybeAppendImageToolDroppedHint(errorMessage), response.status, streamImages))
  ;(err as { httpStatus?: number }).httpStatus = response.status
  return err
}

/**
 * 拆分 + 凑满 N：上游 gpt-image-2 不支持单请求 n>1（实测忽略 n 永远回 1 张），
 * 必须拆成 n 个 n:1 请求。失败的子请求（含 429 并发墙）补发直到凑满 N 张或耗尽补发预算。
 * - 每个 slot 固定 [0, n-1]，补发复用失败 slot，保证预览槽位稠密不留空洞
 * - 并发受 MAX_CONCURRENT_IMAGE_REQUESTS（贴网关并发墙）限流
 * - 本轮全为不可重试失败（4xx/moderation）且无成功 → 立即停止（补发也没用，省钱）
 * runSingle(slot) 必须自带 callWithRetry + 成功后 onPartialImage({final}) 推槽位
 */
export async function runImageRequestsWithRefill(
  n: number,
  runSingle: (slot: number) => Promise<CallApiResult>,
): Promise<{ resultsBySlot: Array<CallApiResult | undefined>; failedCount: number; firstError: unknown; failedImageUrls: string[] }> {
  const resultsBySlot = new Array<CallApiResult | undefined>(n).fill(undefined)
  const maxAttempts = n + n * IMAGE_REQUEST_REFILL_BUDGET_FACTOR
  let attempts = 0
  const downloadFailedSlots = new Set<number>()
  const failedImageUrls = new Set<string>()
  let firstError: unknown

  while (attempts < maxAttempts) {
    const unfilledSlots: number[] = []
    for (let slot = 0; slot < n; slot++) {
      if (!resultsBySlot[slot] && !downloadFailedSlots.has(slot)) unfilledSlots.push(slot)
    }
    if (unfilledSlots.length === 0) break

    const batchSlots = unfilledSlots.slice(0, maxAttempts - attempts)
    attempts += batchSlots.length

    const results = await runWithConcurrency(
      batchSlots.map((slot) => () => runSingle(slot)),
      MAX_CONCURRENT_IMAGE_REQUESTS,
    )

    let roundSuccess = 0
    let roundRetryable = 0
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        resultsBySlot[batchSlots[idx]] = r.value
        roundSuccess++
      } else {
        if (r.reason instanceof ImageDownloadError) {
          downloadFailedSlots.add(batchSlots[idx])
          r.reason.rawImageUrls.forEach((url: string) => failedImageUrls.add(url))
        }
        if (firstError === undefined) firstError = r.reason
        // 503 账号池枯竭秒回,补发也是空转烧钱 → 不计入可重试
        if (isRetryableError(r.reason) && !isAccountPoolExhausted(r.reason)) roundRetryable++
      }
    })

    // 本轮零成功且失败全不可重试 → 补发无意义，停止
    if (roundSuccess === 0 && roundRetryable === 0) break
  }

  if (firstError instanceof Error && failedImageUrls.size) {
    Object.assign(firstError, { rawImageUrls: [...failedImageUrls] })
  }
  return { resultsBySlot, failedCount: resultsBySlot.filter((r) => !r).length, firstError, failedImageUrls: [...failedImageUrls] }
}


function normalizeImageApiPayload(value: unknown): ImageApiResponse {
  if (Array.isArray(value)) return { data: value as ImageApiResponse['data'] }
  if (value && typeof value === 'object') return value as ImageApiResponse
  return { data: [] }
}

async function createRequestHeaders(profile: ApiProfile): Promise<Record<string, string>> {
  if (!profile.apiKey.trim() && !canUseOAuthForProfile(profile)) return {}
  return {
    Authorization: `Bearer ${await resolveBearerToken(profile)}`,
  }
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function getStreamEventErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error
  if (isRecordValue(error)) {
    const message = getStringValue(error, 'message')
    if (message) return message
  }
  if (typeof error === 'string' && error.trim()) return error

  const type = getStringValue(event, 'type')
  if (type?.endsWith('.failed')) {
    return getStringValue(event, 'message') ?? i18n.t('errors.imagesStreamFailed')
  }
  return null
}

function createResponsesImageTool(
  params: TaskParams,
  isEdit: boolean,
  profile: ApiProfile,
  maskDataUrl?: string,
  nativeTransparentBackground?: boolean,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    output_format: params.output_format,
    moderation: params.moderation,
  }
  const imageModel = getImageGenerationModel(profile)
  if (imageModel) tool.model = imageModel

  if (!profile.codexCli) {
    tool.size = params.size
  }

  if (profile.streamImages) {
    tool.partial_images = getStreamPartialImages(profile)
  }

  if (!profile.codexCli) {
    tool.quality = params.quality
  }
  applyGptImage26Params(tool, params, profile)

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }

  if (nativeTransparentBackground) {
    tool.background = 'transparent'
  }

  if (maskDataUrl) {
    tool.input_image_mask = {
      image_url: maskDataUrl,
    }
  }

  return tool
}

function createResponsesInput(prompt: string, inputImageDataUrls: string[], allowPromptRewrite: boolean): unknown {
  const text = allowPromptRewrite ? prompt : `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
  if (!inputImageDataUrls.length) return text

  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...inputImageDataUrls.map((dataUrl) => ({
          type: 'input_image',
          image_url: dataUrl,
        })),
      ],
    },
  ]
}

function parseResponsesImageResults(payload: ResponsesApiResponse, fallbackMime: string): Array<{
  image: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
}> {
  const output = payload.output
  if (!Array.isArray(output) || !output.length) {
    const err = new Error(i18n.t('errors.imageDataMissing'))
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const results: Array<{ image: string; actualParams?: Partial<TaskParams>; revisedPrompt?: string }> = []

  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue

    const b64 = getResponsesImageResultBase64(item.result)
    if (b64) {
      results.push({
        image: normalizeBase64Image(b64, fallbackMime),
        actualParams: mergeActualParams(pickActualParams(item)),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      })
    }
  }

  if (!results.length) {
    const err = new Error(i18n.t('errors.unrecognizedImagePayload'))
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  return results
}

async function parseImagesApiResponse(payload: ImageApiResponse, mime: string, signal?: AbortSignal): Promise<CallApiResult> {
  const data = payload.data
  if (!Array.isArray(data) || !data.length) {
    const err = new Error(i18n.t('errors.noImagePayload'))
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const images: string[] = []
  const rawImageUrls = data.map((item) => item.url).filter(isHttpUrl)
  const revisedPrompts: Array<string | undefined> = []
  try {
    for (const item of data) {
      const b64 = item.b64_json
      if (b64) {
        images.push(normalizeBase64Image(b64, mime))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
        continue
      }

      if (isHttpUrl(item.url) || isDataUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
      }
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      (err as any).rawImageUrls = rawImageUrls
    }
    throw err
  }

  if (!images.length) {
    const err = new Error(i18n.t('errors.unrecognizedImagePayload'))
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const actualParams = mergeActualParams(
    pickActualParams(payload),
  )
  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

function eventToImageResponseItem(event: Record<string, unknown>): ImageResponseItem {
  return {
    b64_json: getStringValue(event, 'b64_json'),
    url: getStringValue(event, 'url'),
    revised_prompt: getStringValue(event, 'revised_prompt'),
    size: getStringValue(event, 'size'),
    quality: getStringValue(event, 'quality'),
    output_format: getStringValue(event, 'output_format'),
    output_compression: getNumberValue(event, 'output_compression'),
    moderation: getStringValue(event, 'moderation'),
  }
}

async function parseImagesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallApiOptions['onPartialImage'],
  signal?: AbortSignal,
): Promise<CallApiResult> {
  const completedItems: ImageResponseItem[] = []
  let resultPayload: ImageApiResponse | null = null

  await readJsonServerSentEvents(response, (event) => {
    const type = getStringValue(event, 'type')
    const object = getStringValue(event, 'object')
    if (type === 'image_generation.partial_image' || type === 'image_edit.partial_image') {
      const b64 = getStringValue(event, 'b64_json')
      if (b64) {
        onPartialImage?.({
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
        })
      }
      return
    }

    if (object === 'image.generation.result' || object === 'image.edit.result') {
      resultPayload = normalizeImageApiPayload(event)
      return
    }

    if (type === 'image_generation.completed' || type === 'image_edit.completed') {
      completedItems.push(eventToImageResponseItem(event))
    }
  }, {
    signals: [signal],
    formatErrorMessage: appendStreamingFormatHint,
    getEventErrorMessage: getStreamEventErrorMessage,
  })

  if (resultPayload) {
    return parseImagesApiResponse(resultPayload, mime)
  }

  if (!completedItems.length) {
    throw new Error(i18n.t('errors.imagesStreamNoFinal'))
  }

  const images: string[] = []
  const rawImageUrls = completedItems.map((item) => item.url).filter(isHttpUrl)
  try {
    for (const item of completedItems) {
      if (item.b64_json) {
        images.push(normalizeBase64Image(item.b64_json, mime))
        continue
      }
      if (isHttpUrl(item.url) || isDataUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal))
      }
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      (err as any).rawImageUrls = rawImageUrls
    }
    throw err
  }
  if (!images.length) throw new Error(i18n.t('errors.imagesStreamNoUsable'))

  const actualParamsList = completedItems.map((item) => mergeActualParams(pickActualParams(item)))
  const actualParams = mergeActualParams(
    actualParamsList[0],
    images.length > 1 ? { n: images.length } : undefined,
  )
  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts: completedItems.map((item) => item.revised_prompt),
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

function getResponsesStreamPayload(event: Record<string, unknown>): ResponsesApiResponse | null {
  const response = event.response
  if (isRecordValue(response)) return response as ResponsesApiResponse

  const item = event.item
  if (isRecordValue(item) && item.type === 'image_generation_call') {
    return { output: [item as ResponsesOutputItem] }
  }

  return null
}

async function parseResponsesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallApiOptions['onPartialImage'],
): Promise<CallApiResult> {
  let completedPayload: ResponsesApiResponse | null = null
  const outputItems: ResponsesOutputItem[] = []

  await readJsonServerSentEvents(response, (event) => {
    const type = getStringValue(event, 'type')
    if (type === 'response.image_generation_call.partial_image') {
      const b64 = getStringValue(event, 'partial_image_b64')
      if (b64) {
        onPartialImage?.({
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
        })
      }
      return
    }

    const payload = getResponsesStreamPayload(event)
    if (!payload) return

    if (type === 'response.output_item.done' && Array.isArray(payload.output)) {
      outputItems.push(...payload.output)
      return
    }

    completedPayload = payload
  }, {
    formatErrorMessage: appendStreamingFormatHint,
    getEventErrorMessage: getStreamEventErrorMessage,
  })

  const payload = completedPayload ?? (outputItems.length ? { output: outputItems } : null)
  if (!payload) throw new Error(i18n.t('errors.imagesStreamNoFinal'))

  let imageResults: ReturnType<typeof parseResponsesImageResults>
  try {
    imageResults = parseResponsesImageResults(payload, mime)
  } catch (err) {
    const collectedImageItems = outputItems.filter((item) => getResponsesImageResultBase64(item.result))
    if (collectedImageItems.length === 0) throw err
    imageResults = parseResponsesImageResults({ output: collectedImageItems }, mime)
  }
  const actualParams = mergeActualParams(imageResults[0]?.actualParams ?? {})
  return {
    images: imageResults.map((result) => result.image),
    actualParams,
    actualParamsList: imageResults.map((result) => mergeActualParams(result.actualParams ?? {})),
    revisedPrompts: imageResults.map((result) => result.revisedPrompt),
  }
}

export async function callOpenAICompatibleImageApi(opts: CallApiOptions, profile: ApiProfile, customProvider?: CustomProviderDefinition | null): Promise<CallApiResult> {
  const family = getImageModelFamily(profile)
  if (family) {
    if (opts.maskDataUrl) throw new Error('此模型不支持遮罩编辑，请使用参考图和提示词描述修改内容')
    opts = { ...opts, nativeTransparentBackground: false }
  }
  if (customProvider) {
    customProvider = resolveCustomProviderModel(customProvider, profile.model)
    const n = opts.params.n > 0 ? opts.params.n : 1
    const submitMapping = opts.inputImageDataUrls.length > 0 && customProvider.editSubmit
      ? customProvider.editSubmit
      : customProvider.submit
    const isAsync = Boolean(submitMapping.taskIdPath)
    // SVG 每次请求只能生成一张
    if ((profile.codexCli || opts.params.output_format === 'svg') && n > 1 && !isAsync) return callCustomHttpImageApiConcurrent(opts, profile, customProvider, n)
    return callCustomHttpImageApi(opts, profile, customProvider)
  }

  if (family) return callModelImagesApi(opts, profile)

  // SVG 和 GIF 不支持流式和中间图
  const requestProfile = isVectorOrAnimatedFormat(opts.params.output_format) ? { ...profile, streamImages: false } : profile
  return requestProfile.apiMode === 'responses'
    ? callResponsesImageApi(opts, requestProfile)
    : callImagesApi(opts, requestProfile)
}

async function callModelImagesApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const family = getImageModelFamily(profile)
  const params = getImageModelParams(profile, opts.params)
  const isEdit = opts.inputImageDataUrls.length > 0
  const grokSizeParams = usesGrokSizeParams(profile)
  const body: Record<string, unknown> = { model: profile.model, prompt: opts.prompt, n: opts.params.n > 0 ? opts.params.n : 1 }
  if (family === 'gemini') {
    body.size = params.aspect_ratio
    body.resolution = params.resolution
    if (isEdit) body.image_urls = opts.inputImageDataUrls
  } else if (grokSizeParams) {
    if (params.aspect_ratio !== 'auto') body.size = params.aspect_ratio
    if (isEdit) {
      const urls = opts.inputImageUrls?.filter(isHttpUrl) ?? []
      if (urls.length !== opts.inputImageDataUrls.length) throw new Error('此模型只接受链接参考图，请通过图片链接添加参考图')
      if (urls.length > 5) throw new Error('此模型每次最多接受 5 张参考图')
      body.image_urls = urls
    }
  } else {
    if (params.aspect_ratio !== 'auto') body.aspect_ratio = params.aspect_ratio
    body.resolution = params.resolution?.toLowerCase()
    if (params.quality !== undefined) body.quality = params.quality
    const images = opts.inputImageDataUrls.map((url) => ({ type: 'image_url', url }))
    if (images.length === 1) body.image = images[0]
    if (images.length > 1) body.images = images
    if (profile.provider === 'xai' && images.length > 5) throw new Error('xAI 每次最多接受 5 张参考图')
  }
  if (profile.responseFormatB64Json) body.response_format = 'b64_json'
  assertImageInputPayloadSize(opts.inputImageDataUrls.reduce((sum, url) => sum + url.length, 0))
  const proxyConfig = readClientDevProxyConfig()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)
  try {
    const response = await apiFetch(buildApiUrl(profile.baseUrl, family === 'grok' && !grokSizeParams && isEdit ? 'images/edits' : 'images/generations', proxyConfig, profile.provider === 'openai' && shouldUseApiProxy(profile.apiProxy, proxyConfig)), {
      method: 'POST',
      headers: { ...(await createRequestHeaders(profile)), 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    const payload = await response.json()
    const taskId = getByPath(payload, 'data.0.task_id') ?? (getByPath(payload, 'data.object') === 'generation.task' ? getByPath(payload, 'data.id') : undefined)
    if (typeof taskId === 'string' && taskId.trim()) {
      opts.onCustomTaskEnqueued?.({ taskId })
      clearTimeout(timeoutId)
      return await pollCustomTaskResult(profile, OPENAI_IMAGE_TASK_PROVIDER.poll!, taskId, family === 'grok' ? 'image/jpeg' : 'image/png', controller.signal)
    }
    return await parseImagesApiResponse(payload, family === 'grok' ? 'image/jpeg' : 'image/png', controller.signal)
  } catch (err) {
    console.warn('图像请求失败', err)
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}

async function callImagesApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  // SVG 每次请求只能生成一张；Sakrylle gpt-image-2 也忽略单请求 n>1
  if ((profile.codexCli || profile.streamImages || isSakrylleApiBaseUrl(profile.baseUrl) || opts.params.output_format === 'svg') && n > 1) {
    return callImagesApiConcurrent(opts, profile, n)
  }

  return callImagesApiSingle(opts, profile)
}

async function callImagesApiConcurrent(opts: CallApiOptions, profile: ApiProfile, n: number): Promise<CallApiResult> {
  const singleOpts = {
    ...opts,
    params: {
      ...opts.params,
      n: 1,
      ...(profile.codexCli ? { quality: 'auto' as const } : {}),
    },
  }

  // codexCli mode: simple Promise.allSettled, no retry/refill, returns failedRequests per slot
  if (profile.codexCli) {
    const results = await Promise.allSettled(
      Array.from({ length: n }).map((_, requestIndex) => callImagesApiSingle({
        ...singleOpts,
        onPartialImage: opts.onPartialImage
          ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
          : undefined,
      }, profile)),
    )

    const successfulResults = results
      .filter((r): r is PromiseFulfilledResult<CallApiResult> => r.status === 'fulfilled')
      .map((r) => r.value)
    const failedRequests = results.flatMap((r, requestIndex) =>
      r.status === 'rejected' ? [{ requestIndex, error: getErrorMessage(r.reason) }] : [],
    )

    if (successfulResults.length === 0) {
      const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (firstError) throw firstError.reason
      throw new Error(i18n.t('errors.concurrentAllFailed'))
    }

    const images = successfulResults.flatMap((r) => r.images)
    const actualParamsList = successfulResults.flatMap((r) =>
      r.actualParamsList?.length ? r.actualParamsList : r.images.map(() => r.actualParams),
    )
    const revisedPrompts = successfulResults.flatMap((r) =>
      r.revisedPrompts?.length ? r.revisedPrompts : r.images.map(() => undefined),
    )
    const rawImageUrls = successfulResults.flatMap((r) => r.rawImageUrls ?? [])
    const actualParams = mergeActualParams(
      successfulResults[0]?.actualParams ?? {},
      { n: images.length },
    )

    return {
      images,
      actualParams,
      actualParamsList,
      revisedPrompts,
      ...(rawImageUrls.length ? { rawImageUrls } : {}),
      ...(failedRequests.length ? { failedRequests } : {}),
    }
  }

  // Sakrylle streaming split: runImageRequestsWithRefill with retry/refill, returns partialFailure
  const { resultsBySlot, failedCount, firstError, failedImageUrls } = await runImageRequestsWithRefill(n, (slot) =>
    callWithRetry(() => callImagesApiSingle({
      ...singleOpts,
      onPartialImage: opts.onPartialImage
        ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex: slot })
        : undefined,
    }, profile)).then((result) => {
      // 子请求完成即把成品图推进对应预览槽位，无需等其余子请求
      const finalImage = result.images[0]
      if (finalImage) opts.onPartialImage?.({ image: finalImage, requestIndex: slot, final: true })
      return result
    }),
  )

  const successfulResults = resultsBySlot.filter((r): r is CallApiResult => Boolean(r))

  if (successfulResults.length === 0) {
    if (firstError) throw firstError
    throw new Error(i18n.t('errors.concurrentAllFailed'))
  }

  const images = successfulResults.flatMap((r) => r.images)
  const actualParamsList = successfulResults.flatMap((r) =>
    r.actualParamsList?.length ? r.actualParamsList : r.images.map(() => r.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((r) =>
    r.revisedPrompts?.length ? r.revisedPrompts : r.images.map(() => undefined),
  )
  const rawImageUrls = [...successfulResults.flatMap((r) => r.rawImageUrls ?? []), ...failedImageUrls]
  const actualParams = mergeActualParams(
    successfulResults[0]?.actualParams ?? {},
    { n: images.length },
  )
  const partialFailure = buildPartialFailure(failedCount, firstError)

  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
    ...(partialFailure ? { partialFailure } : {}),
  }
}

async function callImagesApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  if (paramsForNativeBackground(opts) && !useApiProxy && shouldUseChatImagePath(profile) && await canUseChatCompletionsImagePath(profile)) {
    return callImagesApiViaChat(opts, profile)
  }

  const { prompt: originalPrompt, inputImageDataUrls } = opts
  const params = getSakrylleImageRequestParams(opts.params, profile)
  const sizePrompt = profile.codexCli && !opts.skipCodexCliSizePrompt ? prependCodexCliSizePrompt(originalPrompt, params.size) : originalPrompt
  const prompt = profile.codexCli && !opts.settings.allowPromptRewrite
    ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${sizePrompt}`
    : sizePrompt
  const isEdit = inputImageDataUrls.length > 0
  const shouldStreamImages = profile.streamImages && !(isEdit && isSakrylleApiBaseUrl(profile.baseUrl))
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const requestHeaders = await createRequestHeaders(profile)
  const paths = createOpenAICompatiblePaths()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)

  try {
    let response: Response

    if (isEdit) {
      const formData = new FormData()
      formData.append('model', profile.model)
      formData.append('prompt', prompt)
      if (!profile.codexCli) {
        formData.append('size', params.size)
      }
      formData.append('output_format', params.output_format)
      formData.append('moderation', params.moderation)
      if (opts.nativeTransparentBackground) {
        formData.append('background', 'transparent')
      }

      if (!profile.codexCli) {
        formData.append('quality', params.quality)
      }
      // 与生成接口共用同一份 2.6 参数；编辑接口不支持 SVG，不会出现对象字段
      const gptImage26Params: Record<string, unknown> = {}
      applyGptImage26Params(gptImage26Params, params, profile)
      for (const [key, value] of Object.entries(gptImage26Params)) {
        if (typeof value !== 'object') formData.append(key, String(value))
      }

      if (params.output_format !== 'png' && params.output_compression != null) {
        formData.append('output_compression', String(params.output_compression))
      }
      if (params.n > 1) {
        formData.append('n', String(params.n))
      }
      if (profile.responseFormatB64Json) {
        formData.append('response_format', 'b64_json')
      }
      if (shouldStreamImages) {
        formData.append('stream', 'true')
        formData.append('partial_images', String(getStreamPartialImages(profile)))
      }

      const imageBlobs: Blob[] = []
      for (let i = 0; i < inputImageDataUrls.length; i++) {
        const dataUrl = inputImageDataUrls[i]
        const blob = opts.maskDataUrl && i === 0
          ? await imageDataUrlToPngBlob(dataUrl)
          : await dataUrlToBlob(dataUrl)
        imageBlobs.push(blob)
      }

      const maskBlob = opts.maskDataUrl ? await maskDataUrlToPngBlob(opts.maskDataUrl) : null
      if (opts.maskDataUrl) {
        assertMaskEditFileSize(i18n.t('errors.maskMainFile'), imageBlobs[0]?.size ?? 0)
        assertMaskEditFileSize(i18n.t('errors.maskFile'), maskBlob?.size ?? 0)
      }
      const markupBlob = opts.markupDataUrl ? await dataUrlToBlob(opts.markupDataUrl, 'image/png') : null
      if (markupBlob) assertMaskEditFileSize('标注文件', markupBlob.size)
      assertImageInputPayloadSize(
        imageBlobs.reduce((sum, blob) => sum + blob.size, 0) + (maskBlob?.size ?? 0) + (markupBlob?.size ?? 0),
      )

      for (let i = 0; i < imageBlobs.length; i++) {
        const blob = imageBlobs[i]
        const ext = blob.type.split('/')[1] || 'png'
        formData.append('image[]', blob, `input-${i + 1}.${ext}`)
      }

      if (maskBlob) {
        formData.append('mask', maskBlob, 'mask.png')
      }
      if (markupBlob) {
        formData.append('markup', markupBlob, 'markup.png')
      }

      response = await apiFetch(buildApiUrl(profile.baseUrl, paths.editPath, proxyConfig, useApiProxy), {
        method: 'POST',
        headers: requestHeaders,
        cache: 'no-store',
        body: formData,
        signal: controller.signal,
      })
    } else {
      const body: Record<string, unknown> = {
        model: profile.model,
        prompt,
        output_format: params.output_format,
        moderation: params.moderation,
      }

      if (opts.nativeTransparentBackground) {
        body.background = 'transparent'
      }

      if (!profile.codexCli) {
        body.size = params.size
      }

      if (!profile.codexCli) {
        body.quality = params.quality
      }
      applyGptImage26Params(body, params, profile)

      if (params.output_format !== 'png' && params.output_compression != null) {
        body.output_compression = params.output_compression
      }
      if (params.n > 1) {
        body.n = params.n
      }
      if (profile.responseFormatB64Json) {
        body.response_format = 'b64_json'
      }
      if (shouldStreamImages) {
        body.stream = true
        body.partial_images = getStreamPartialImages(profile)
      }

      response = await apiFetch(buildApiUrl(profile.baseUrl, paths.generationPath, proxyConfig, useApiProxy), {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    }

    if (!response.ok) {
      throw await makeApiError(response, profile.streamImages)
    }

    if (shouldStreamImages && isEventStreamResponse(response)) {
      return await parseImagesApiStreamResponse(response, mime, opts.onPartialImage, controller.signal)
    }

    return await parseImagesApiResponse(await response.json() as ImageApiResponse, mime, controller.signal)
  } finally {
    clearTimeout(timeoutId)
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

function getTaskState(payload: unknown, poll: CustomProviderPollMapping): 'success' | 'failure' | 'pending' {
  const status = getByPath(payload, poll.statusPath)
  const statusText = typeof status === 'string' ? status : String(status ?? '')
  if (poll.successValues.includes(statusText)) return 'success'
  if (poll.failureValues.includes(statusText)) return 'failure'
  return 'pending'
}

function isRecoverablePollingError(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof FetchConnectError) return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isRetryablePollingStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function buildTaskPath(path: string, taskId: string): string {
  return path
    .replace(/\{task_id\}/g, encodeURIComponent(taskId))
    .replace(/\{taskId\}/g, encodeURIComponent(taskId))
}

function resolveTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    return getByPath(context, value.slice(1))
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, context)).filter((item) => item !== undefined && item !== null)
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, resolveTemplateValue(item, context)] as const)
      .filter(([, item]) => item !== undefined && item !== null && (!Array.isArray(item) || item.length > 0))
    return Object.fromEntries(entries)
  }
  return value
}

function createCustomProviderContext(opts: CallApiOptions, profile: ApiProfile) {
  const sizePrompt = profile.codexCli && !opts.skipCodexCliSizePrompt
    ? prependCodexCliSizePrompt(opts.prompt, opts.params.size)
    : opts.prompt
  const prompt = profile.codexCli && !opts.settings.allowPromptRewrite
    ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${sizePrompt}`
    : sizePrompt
  // 2.6 参数与原生接口同样处理：不适用的字段为 undefined，模板中自动省略
  const gptImage26Params: Record<string, unknown> = {}
  applyGptImage26Params(gptImage26Params, opts.params, profile)
  const params = {
    ...opts.params,
    complexity: undefined,
    frame_count: undefined,
    frame_duration_ms: undefined,
    ...gptImage26Params,
    ...(profile.codexCli ? { size: undefined, quality: undefined } : {}),
    ...(opts.nativeTransparentBackground ? { background: 'transparent' } : {}),
  }
  const modelParams = getImageModelFamily(profile) ? getImageModelParams(profile, opts.params) : null

  const inputImageUrls = opts.inputImageUrls?.filter(isHttpUrl) ?? []

  return {
    profile,
    prompt,
    params: { ...params, ...(modelParams ? { ...modelParams, size: modelParams.aspect_ratio } : {}) },
    mode: opts.inputImageDataUrls.length ? 'image-to-image' : 'text-to-image',
    resolution: modelParams?.resolution ? { upper: modelParams.resolution, lower: modelParams.resolution.toLowerCase() } : undefined,
    inputImages: {
      dataUrls: opts.inputImageDataUrls.length ? opts.inputImageDataUrls : undefined,
      base64: opts.inputImageDataUrls.length ? opts.inputImageDataUrls.map((url) => url.replace(/^data:[^;]+;base64,/, '')) : undefined,
      urls: inputImageUrls.length ? inputImageUrls : undefined,
      count: opts.inputImageDataUrls.length,
    },
    mask: {
      dataUrl: opts.maskDataUrl,
    },
  }
}

function renderQuery(query: Record<string, string> | undefined, context: Record<string, unknown>): Record<string, string> | undefined {
  if (!query) return undefined
  const entries = Object.entries(query)
    .map(([key, value]) => [key, resolveTemplateValue(value, context)] as const)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => [key, String(value)] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

async function createCustomMultipartBody(mapping: CustomProviderSubmitMapping, opts: CallApiOptions, context: Record<string, unknown>): Promise<FormData> {
  const formData = new FormData()
  const body = resolveTemplateValue(mapping.body ?? {}, context)
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        for (const item of value) formData.append(key, String(item))
      } else {
        formData.append(key, String(value))
      }
    }
  }

  const needsInputImages = mapping.files?.some((file) => file.source === 'inputImages')
  const needsMask = mapping.files?.some((file) => file.source === 'mask')
  const imageBlobs: Blob[] = []
  if (needsInputImages) {
    for (let i = 0; i < opts.inputImageDataUrls.length; i++) {
      const dataUrl = opts.inputImageDataUrls[i]
      const blob = opts.maskDataUrl && i === 0 ? await imageDataUrlToPngBlob(dataUrl) : await dataUrlToBlob(dataUrl)
      imageBlobs.push(blob)
    }
  }
  const maskBlob = needsMask && opts.maskDataUrl ? await maskDataUrlToPngBlob(opts.maskDataUrl) : null
  if (opts.maskDataUrl && (needsInputImages || needsMask)) {
    assertMaskEditFileSize(i18n.t("errors.maskMainFile"), imageBlobs[0]?.size ?? 0)
    assertMaskEditFileSize(i18n.t("errors.maskFile"), maskBlob?.size ?? 0)
  }
  assertImageInputPayloadSize(imageBlobs.reduce((sum, blob) => sum + blob.size, 0) + (maskBlob?.size ?? 0))

  for (const file of mapping.files ?? []) {
    if (file.source === 'inputImages') {
      for (let i = 0; i < imageBlobs.length; i++) {
        const blob = imageBlobs[i]
        const ext = blob.type.split('/')[1] || 'png'
        formData.append(file.field, blob, `input-${i + 1}.${ext}`)
      }
    } else if (file.source === 'mask' && maskBlob) {
      formData.append(file.field, maskBlob, 'mask.png')
    }
  }

  return formData
}

async function extractCustomImages(payload: unknown, result: CustomProviderResultMapping, mime: string, signal?: AbortSignal): Promise<CallApiResult> {
  const images: string[] = []
  const imageUrls = (result.imageUrlPaths ?? []).flatMap((path) =>
    getAllByPath(payload, path).filter((value): value is string => isHttpUrl(value) || isDataUrl(value)),
  )
  const rawImageUrls = imageUrls.filter(isHttpUrl)
  try {
    for (const path of result.b64JsonPaths ?? []) {
      for (const value of getAllByPath(payload, path)) {
        if (typeof value === 'string' && value.trim()) images.push(normalizeBase64Image(value, mime))
      }
    }
    for (const url of imageUrls) {
      images.push(await fetchImageUrlAsDataUrl(url, mime, signal))
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      (err as any).rawImageUrls = rawImageUrls
    }
    throw err
  }

  if (!images.length) {
    const err = new Error(i18n.t("upstreamSync.noRecognizableImageDataInspectTheRawResponse"))
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }
  return { images, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

async function submitCustomRequest(mapping: CustomProviderSubmitMapping, opts: CallApiOptions, profile: ApiProfile, controller: AbortController, proxyConfig: ReturnType<typeof readClientDevProxyConfig>, useApiProxy: boolean): Promise<unknown> {
  const requestHeaders = await createRequestHeaders(profile)
  const context = createCustomProviderContext(opts, profile)
  // 只用链接传参考图时，不能把其余参考图静默丢掉；同时用其他方式传参考图时链接只是补充
  const template = JSON.stringify([mapping.body, mapping.query])
  const linkOnly = template.includes('$inputImages.urls')
    && !template.includes('$inputImages.dataUrls')
    && !template.includes('$inputImages.base64')
    && !mapping.files?.some((file) => file.source === 'inputImages')
  const missingUrlCount = context.inputImages.count - (context.inputImages.urls?.length ?? 0)
  if (linkOnly && missingUrlCount > 0) {
    throw new Error(`当前服务商只接受链接参考图，有 ${missingUrlCount} 张参考图不是通过链接添加的。请在输入框的「+ → 添加链接」中添加，或移除这些参考图后重试。`)
  }
  const method = mapping.method ?? 'POST'
  const contentType = mapping.contentType ?? 'json'
  const path = appendQuery(mapping.path.replace(/\{model\}/g, encodeURIComponent(profile.model)), renderQuery(mapping.query, context))
  const headers: Record<string, string> = { ...requestHeaders }
  let body: BodyInit | undefined

  if (method !== 'GET') {
    if (contentType === 'multipart') {
      const formData = await createCustomMultipartBody(mapping, opts, context)
      if (profile.responseFormatB64Json) {
        formData.append('response_format', 'b64_json')
      }
      body = formData
    } else {
      assertImageInputPayloadSize(
        opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
          (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
      )
      headers['Content-Type'] = 'application/json'
      const resolved = resolveTemplateValue(mapping.body ?? {}, context)
      if (profile.responseFormatB64Json && resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
        (resolved as Record<string, unknown>).response_format = 'b64_json'
      }
      body = JSON.stringify(resolved)
    }
  }

  const response = await apiFetch(buildApiUrl(profile.baseUrl, path, proxyConfig, useApiProxy), {
    method,
    headers,
    cache: 'no-store',
    body,
    signal: controller.signal,
  })

  if (!response.ok) {
    const errorMessage = await getApiErrorMessage(response)
    throw new Error(maybeAppendStreamingHint(errorMessage, response.status, profile.streamImages))
  }
  return response.json()
}

async function pollCustomTaskResult(
  profile: ApiProfile,
  poll: CustomProviderPollMapping,
  taskId: string,
  mime: string,
  signal?: AbortSignal,
): Promise<CallApiResult> {
  const proxyConfig = readClientDevProxyConfig()
  const requestHeaders = await createRequestHeaders(profile)
  let isFirstPoll = true

  while (true) {
    if (isFirstPoll) {
      isFirstPoll = false
    } else if (signal) {
      await sleep((poll.intervalSeconds ?? 5) * 1000, signal)
    } else {
      await new Promise((resolve) => setTimeout(resolve, (poll.intervalSeconds ?? 5) * 1000))
    }

    const query = poll.query ? Object.fromEntries(Object.entries(poll.query).map(([key, value]) => [key, value.replace(/\{task_id\}|\{taskId\}/g, () => taskId).replace(/\{model\}/g, () => profile.model)])) : undefined
    const taskPath = appendQuery(buildTaskPath(poll.path.replace(/\{model\}/g, encodeURIComponent(profile.model)), taskId), query)
    let taskPayload: unknown
    try {
      const taskResponse = await apiFetch(buildApiUrl(profile.baseUrl, taskPath, proxyConfig, profile.provider === 'openai' && shouldUseApiProxy(profile.apiProxy, proxyConfig)), {
        method: poll.method ?? 'GET',
        headers: requestHeaders,
        cache: 'no-store',
        signal,
      })

      if (!taskResponse.ok) {
        if (isRetryablePollingStatus(taskResponse.status)) {
          // 不读的响应体要主动取消，否则客户端中连接会保留到服务端发完为止
          void taskResponse.body?.cancel().catch(() => undefined)
          continue
        }
        throw new Error(await getApiErrorMessage(taskResponse))
      }

      taskPayload = await taskResponse.json()
    } catch (err) {
      if (!signal?.aborted && isRecoverablePollingError(err)) continue
      throw err
    }

    const state = getTaskState(taskPayload, poll)
    if (state === 'failure') {
      const message = getByPath(taskPayload, poll.errorPath) || getByPath(taskPayload, 'message') || getByPath(taskPayload, 'data.fail_reason') || getByPath(taskPayload, 'error.message')
      const errorMessage = typeof message === 'string' && message.trim() ? message : i18n.t("upstreamSync.asyncTaskFailed")
      throw new Error(maybeAppendTransparentBackgroundHint(errorMessage))
    }
    if (state === 'success') {
      try {
        return await extractCustomImages(taskPayload, poll.result, mime, signal)
      } catch (err) {
        if (!signal?.aborted && isRecoverablePollingError(err)) continue
        throw err
      }
    }
  }
}

export async function getCustomQueuedImageResult(
  profile: ApiProfile,
  customProvider: CustomProviderDefinition,
  taskId: string,
  params: TaskParams,
): Promise<CallApiResult> {
  customProvider = resolveCustomProviderModel(customProvider, profile.model)
  if (!customProvider.poll) throw new Error(i18n.t("upstreamSync.missingCustomAsyncPollConfiguration"))
  const mime = MIME_MAP[params.output_format] || 'image/png'
  return pollCustomTaskResult(profile, customProvider.poll, taskId, mime)
}

async function callCustomHttpImageApi(opts: CallApiOptions, profile: ApiProfile, customProvider: CustomProviderDefinition): Promise<CallApiResult> {
  const { params, inputImageDataUrls } = opts
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)

  try {
    const proxyConfig = readClientDevProxyConfig()
    const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
    const submitMapping = isEdit && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
    if (useApiProxy && (submitMapping.method ?? 'POST') !== 'POST') {
      throw new Error(i18n.t("upstreamSync.theApiProxyDoesNotSupportCustomGet"))
    }
    if (useApiProxy && (submitMapping.taskIdPath || customProvider.poll)) {
      throw new Error(i18n.t("upstreamSync.theApiProxyDoesNotSupportAsyncCustom"))
    }
    const submitPayload = await submitCustomRequest(submitMapping, opts, profile, controller, proxyConfig, useApiProxy)
    const taskIdValue = submitMapping.taskIdPath ? getByPath(submitPayload, submitMapping.taskIdPath) : undefined
    const taskId = typeof taskIdValue === 'string' ? taskIdValue.trim() : String(taskIdValue ?? '').trim()
    if (submitMapping.taskIdPath && !taskId) {
      const err = new Error(i18n.t("upstreamSync.cannotExtractTheAsyncTaskIdInspectThe"))
      ;(err as any).rawResponsePayload = JSON.stringify(submitPayload, null, 2)
      throw err
    }
    if (!taskId) return await extractCustomImages(submitPayload, submitMapping.result ?? {}, mime, controller.signal)
    if (!customProvider.poll) throw new Error(i18n.t("upstreamSync.theAsyncApiReturnedTaskIdButThe"))
    opts.onCustomTaskEnqueued?.({ taskId })
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    return pollCustomTaskResult(profile, customProvider.poll, taskId, mime, controller.signal)
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function callCustomHttpImageApiConcurrent(
  opts: CallApiOptions,
  profile: ApiProfile,
  customProvider: CustomProviderDefinition,
  n: number,
): Promise<CallApiResult> {
  const results = await Promise.allSettled(Array.from({ length: n }).map(() => callCustomHttpImageApi({
    ...opts,
    params: { ...opts.params, n: 1 },
  }, profile, customProvider)))
  return mergeConcurrentApiResults(results)
}

async function callResponsesImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if (n === 1) {
    return callResponsesImageApiSingle(opts, profile)
  }

  const promises = Array.from({ length: n }).map((_, requestIndex) => callResponsesImageApiSingle({
    ...opts,
    onPartialImage: opts.onPartialImage
      ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
      : undefined,
  }, profile))
  const results = await Promise.allSettled(promises)

  const successfulResults = results
    .filter((r): r is PromiseFulfilledResult<CallApiResult> => r.status === 'fulfilled')
    .map((r) => r.value)
  const failedRequests = results.flatMap((r, requestIndex) =>
    r.status === 'rejected' ? [{ requestIndex, error: getErrorMessage(r.reason) }] : [],
  )

  if (successfulResults.length === 0) {
    const firstRejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (firstRejected) throw firstRejected.reason
    throw new Error(i18n.t('errors.concurrentAllFailed'))
  }

  const images = successfulResults.flatMap((r) => r.images)
  const actualParamsList = successfulResults.flatMap((r) =>
    r.actualParamsList?.length ? r.actualParamsList : r.images.map(() => r.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((r) =>
    r.revisedPrompts?.length ? r.revisedPrompts : r.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((r) => r.rawImageUrls ?? [])
  const actualParams = mergeActualParams(
    successfulResults[0]?.actualParams ?? {},
    images.length === opts.params.n ? { n: opts.params.n } : { n: images.length },
  )

  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
    ...(failedRequests.length ? { failedRequests } : {}),
  }
}

async function callResponsesImageApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const { prompt, inputImageDataUrls } = opts
  const params = getSakrylleImageRequestParams(opts.params, profile)
  const requestPrompt = profile.codexCli && !opts.skipCodexCliSizePrompt ? prependCodexCliSizePrompt(prompt, params.size) : prompt
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const requestHeaders = await createRequestHeaders(profile)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)

  try {
    if (opts.maskDataUrl) {
      assertMaskEditFileSize(i18n.t('errors.maskMainFile'), getDataUrlDecodedByteSize(inputImageDataUrls[0] ?? ''))
      assertMaskEditFileSize(i18n.t('errors.maskFile'), getDataUrlDecodedByteSize(opts.maskDataUrl))
    }
    assertImageInputPayloadSize(
      inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
        (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
    )

    const body: Record<string, unknown> = {
      model: profile.model,
      input: createResponsesInput(requestPrompt, inputImageDataUrls, opts.settings.allowPromptRewrite),
      tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, profile, opts.maskDataUrl, opts.nativeTransparentBackground)],
      tool_choice: 'required',
    }
    if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }
    if (profile.streamImages) {
      body.stream = true
    }

    const response = await apiFetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: {
        ...requestHeaders,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw await makeApiError(response, profile.streamImages)
    }

    if (profile.streamImages && isEventStreamResponse(response)) {
      return await parseResponsesApiStreamResponse(response, mime, opts.onPartialImage)
    }

    const payload = await response.json() as ResponsesApiResponse
    const imageResults = parseResponsesImageResults(payload, mime)
    const actualParams = mergeActualParams(
      imageResults[0]?.actualParams ?? {},
    )
    return {
      images: imageResults.map((result) => result.image),
      actualParams,
      actualParamsList: imageResults.map((result) =>
        mergeActualParams(result.actualParams ?? {}),
      ),
      revisedPrompts: imageResults.map((result) => result.revisedPrompt),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

function paramsForNativeBackground(opts: CallApiOptions) { return !opts.nativeTransparentBackground }
