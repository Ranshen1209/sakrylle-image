import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AgentConversation,
  AgentInputDraft,
  AgentMessage,
  AgentRound,
  ApiMode,
  ApiProfile,
  AppSettings,
  AppMode,
  TaskParams,
  InputImage,
  MaskDraft,
  TaskRecord,
  FavoriteCollection,
  ResponsesOutputItem,
  StoredImage,
  StoredImageThumbnail,
} from './types'
import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_PARAMS } from './types'
import { DEFAULT_IMAGES_MODEL, DEFAULT_RESPONSES_MODEL, DEFAULT_SETTINGS, getActiveApiProfile, getAgentImageApiProfile, getAgentTextApiProfile, getCustomProviderDefinition, mergeImportedSettings, mergePresetImportedSettings, normalizeSettings, validateApiProfile } from './lib/apiProfiles'
import { enforcePresetConfigPolicy, getPresetConfig, getPresetProfileIds, getPresetProviderIds, isPresetConfigDeletionPrevented, isPresetConfigOnlyEnabled, isPresetConfigParamsLocked, isPresetProfile, isPresetProviderDeletionPrevented } from './lib/presetConfig'
import { canUseOAuthForProfile } from './lib/oauthFallback'
import { getSelectedGroups, setSelectedGroup, fetchResponsesApiGroups, getGroupsForApiMode } from './lib/groupSelection'
import { dismissAllTooltips } from './lib/tooltipDismiss'
import { remapImageMentionsForOrder, replaceImageMentionsForApi } from './lib/promptImageMentions'
import {
  getAllTasks,
  putTask as dbPutTask,
  deleteTask as dbDeleteTask,
  commitTaskDeletion,
  clearTasks as dbClearTasks,
  getAllAgentConversations,
  putAgentConversation as dbPutAgentConversation,
  replaceAgentConversations,
  clearAgentConversations as dbClearAgentConversations,
  getImage,
  getStoredImageThumbnail,
  getImageThumbnail,
  getAllImageIds,
  putImage,
  putImageThumbnail,
  deleteImage,
  clearImages,
  storeImage,
  storeImageWithSize,
} from './lib/db'
import { callImageApi } from './lib/api'
import { callAgentConversationTitleApi, callAgentResponsesApi, callBatchImageSingle, parseBatchImageCallArguments, type AgentApiResultImage, type BatchImageCallResult } from './lib/agentApi'
import { buildAgentApiInput, buildAgentContinuationInput } from './lib/agentInputBuilder'
import { collectAgentRoundOutputImageSlots, extractAgentReferenceIds, getAgentCurrentReferenceId, getAgentGeneratedImageReferenceId } from './lib/agentImageReferences'
import { showBrowserNotification } from './lib/browserNotification'
import { fetchImageUrlAsDataUrl, isHttpUrl, MIME_MAP, getImageFetchCorsHint, mergeActualParams, messageContainsImageFetchCorsHint } from './lib/imageApiShared'
import { getCustomQueuedImageResult } from './lib/openaiCompatibleImageApi'
import {
  SENTINEL_AGENT_STOPPED,
  SENTINEL_OPENAI_INTERRUPTED,
  isAgentStoppedSentinel,
  startsWithAgentErrorPrefix,
} from './lib/agentSentinels'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { isHeicFile, convertHeicToJpeg } from './lib/heicConvert'
import { orderInputImagesForMask } from './lib/mask'
import { getChangedParams, normalizeParamsForSettings } from './lib/paramCompatibility'
import { createTransparentOutputMeta, getTransparentRequestParams, removeKeyedBackgroundFromDataUrl } from './lib/transparentImage'
import { blobToDataUrl, fileToDataUrl } from './lib/dataUrl'
import { cacheImage, cacheThumbnail, clearImageCaches, deleteCachedImage, deleteImageCacheEntry, ensureImageCached, scheduleThumbnailBackfill } from './lib/imageCache'
import { hasActiveDataOperations } from './lib/dataOperations'
import { formatExportFileTime } from './lib/exportFileName'
import { buildExportZip, createExportBlob, getExportImageEstimatedBytes, getExportZipPlan, MAX_EXPORT_ZIP_BYTES, readExportZip, readExportZipFileAsDataUrl, readExportZipManifest } from './lib/exportZip'
import { deleteAgentRoundFromConversation, getActiveAgentRounds, getAgentRoundPath, normalizeAgentConversations, remapAgentRoundMentionsForPathChange, uniqueIds } from './lib/agentConversationState'
import { canonicalizeBatchFunctionCallArguments, countResponseToolCalls, createReadyAgentRecoveredToolState, getAgentFunctionOutputCallIds, getAgentRecoveredFailureError, getAgentRecoveredToolCallCount, getPersistableAgentConversations, getPersistableRawResponsePayload, mergeResponseOutputItems, scrubResponseOutputForDeletedAgentTasks, scrubTaskRawResponsePayloadForDeletedTasks } from './lib/agentResponseState'
import { cleanStaleAgentInputDrafts, clearInputDraftState, isEmptyAgentInputDraft, normalizeAgentInputDrafts, remapAgentInputDraftMentionsForPathChange, restoreAgentInputDraftState, restoreGalleryInputDraftState, saveActiveAgentInputDrafts, saveGalleryInputDraft, syncActiveInputDraft, updateInputDraftImages } from './lib/inputDraftState'
import { ALL_FAVORITES_COLLECTION_ID, DEFAULT_FAVORITE_COLLECTION_ID, createDefaultFavoriteCollection, deleteFavoriteCollectionState, ensureDefaultFavoriteCollection, getTaskFavoriteCollectionIds, mergeFavoriteCollections, normalizeFavoriteCollectionIds, normalizeFavoriteCollectionName, normalizeFavoriteCollections, normalizeFavoritePatch, normalizeLoadedFavoriteState, resolveDefaultFavoriteCollectionId, sameFavoriteCollectionIds } from './lib/favoriteState'
import { createPersistedState, mergePersistedAgentConversations, migratePersistedState, normalizePersistedState } from './lib/persistedState'
import { addImageSizeParam, createTaskDonePatch, createTaskErrorPatch, deriveAgentImageActualParams, deriveGalleryActualParams, firstActualParams, hasActualParams, hasActualSizeParam, mapActualParamsByImage, mapRevisedPromptsByImage, markInterruptedOpenAIRunningTasks } from './lib/taskState'
import { stripInjectedCodexCliSizePrompt } from './lib/size'

const SUPPORT_PROMPT_IMAGE_THRESHOLD = 50
import i18n from './lib/i18n'
const openAIWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
const CUSTOM_RECOVERY_POLL_MS = 10_000
const customRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const agentRoundControllers = new Map<string, AbortController>()
const agentRecoveryContinuations = new Set<string>()
const deletedActiveAgentTasks = new Map<string, { task: TaskRecord; controller: AbortController }>()
let agentConversationPersistenceReady = false
let agentConversationMigrationPending = false
const AGENT_RECOVERY_PAUSE_ERROR = 'AgentRecoveryPauseError'
const AGENT_CONVERSATION_TITLE_MAX_LENGTH = 28
const ERROR_TOAST_MAX_LENGTH = 80
type ToastType = 'info' | 'success' | 'error'
type AgentDeletionResult = 'deleted' | 'deleted-with-warning' | 'running' | 'not-found'

export function getErrorToastMessage(message: string): string {
  const text = message.trim()
  if (!text) return i18n.t('toast.operationFailed')

  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? ''
  const separatorIndex = firstLine.search(/[：:]/)
  if (separatorIndex > 0) {
    const title = firstLine.slice(0, separatorIndex).trim()
    if (isErrorToastTitle(title)) return title
  }

  if (firstLine.length > ERROR_TOAST_MAX_LENGTH) return i18n.t('toast.operationFailedSeeDetails')
  return firstLine || i18n.t('toast.operationFailed')
}

function getToastMessage(message: string, type: ToastType): string {
  return type === 'error' ? getErrorToastMessage(message) : message
}

function isErrorToastTitle(title: string): boolean {
  // 中文常见错误标题后缀
  if (/(?:失败|错误|异常|报错|无法|不能|超时|中断|断开|请先|请输入|已达上限|不存在|已丢失)$/.test(title)) return true
  // 英文常见错误标题前缀（小写比较）
  const lower = title.toLowerCase()
  return /^(?:failed|error|exception|cannot|can't|unable|timed?\s*out|interrupted|disconnected|missing|invalid|reached|not\s+found|copy\s+failed|please|enter)\b/.test(lower)
    || /(?:\sfailed|\serror|\sexception)$/.test(lower)
}

export type SettingsTab = 'general' | 'agent' | 'api' | 'data' | 'about'

type TimeoutStreamingHintProfile = Pick<ApiProfile, 'provider' | 'streamImages' | 'streamPartialImages' | 'streamChatCompletionsImage'>

function getTimeoutStreamingHint(profile?: TimeoutStreamingHintProfile | null) {
  if (profile?.provider !== 'openai') return ''
  // 走流式 chat 路径时,空闲超时已自动重试,整体超时才到这里
  if (profile.streamChatCompletionsImage) return i18n.t('errors.timeoutHintChatOverall')
  const partialImages = profile.streamPartialImages ?? DEFAULT_SETTINGS.streamPartialImages ?? 0
  if (profile.streamImages !== true) return i18n.t('errors.timeoutHintStreaming')
  if (partialImages === 0) return i18n.t('errors.timeoutHintPartialZero')
  return partialImages < 3 ? i18n.t('errors.timeoutHintPartialLow') : ''
}

function createOpenAITimeoutError(timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  return i18n.t('errors.openaiTimeout', { seconds: timeoutSeconds, hint: getTimeoutStreamingHint(profile) })
}

function orderImagesWithMaskFirst(images: InputImage[], maskTargetImageId: string | null | undefined) {
  if (!maskTargetImageId) return images
  const maskIdx = images.findIndex((img) => img.id === maskTargetImageId)
  if (maskIdx <= 0) return images
  const next = [...images]
  const [maskImage] = next.splice(maskIdx, 1)
  next.unshift(maskImage)
  return next
}

function isAgentTask(task: TaskRecord) {
  return task.sourceMode === 'agent' || Boolean(task.agentConversationId || task.agentRoundId)
}

function showTaskCompletionNotification(title: string, body: string) {
  const settings = normalizeSettings(useStore.getState().settings)
  if (!settings.taskCompletionNotification) return
  showBrowserNotification(title, { body })
}

function countSuccessfulOutputImages(tasks: TaskRecord[]) {
  return tasks.reduce((count, task) => count + (task.status === 'done' && !isAgentTask(task) ? task.outputImages.length : 0), 0)
}

function skipSupportPromptForImportedData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptOpen) return {}
    return { supportPromptSkippedForImportedData: true }
  })
}

function showSupportPromptForExistingLocalData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed || state.supportPromptOpen) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptSkippedForImportedData) return {}
    return { supportPromptOpen: true }
  })
}

function maybeOpenSupportPrompt(previousTasks: TaskRecord[], nextTasks: TaskRecord[], taskId: string) {
  const state = useStore.getState()
  if (state.supportPromptDismissed || state.supportPromptOpen || state.supportPromptSkippedForImportedData) return

  const previousTask = previousTasks.find((task) => task.id === taskId)
  const nextTask = nextTasks.find((task) => task.id === taskId)
  if (!nextTask || previousTask?.status === 'done' || nextTask.status !== 'done' || nextTask.outputImages.length === 0) return

  const previousCount = countSuccessfulOutputImages(previousTasks)
  const nextCount = countSuccessfulOutputImages(nextTasks)
  if (previousCount <= SUPPORT_PROMPT_IMAGE_THRESHOLD && nextCount > SUPPORT_PROMPT_IMAGE_THRESHOLD) {
    useStore.setState({ supportPromptOpen: true })
  }
}

function mergeImportedAgentConversations(current: AgentConversation[], imported: AgentConversation[]) {
  const merged = [...current]
  const indexes = new Map(merged.map((conversation, index) => [conversation.id, index]))

  for (const conversation of imported) {
    const index = indexes.get(conversation.id)
    if (index == null) {
      indexes.set(conversation.id, merged.length)
      merged.push(conversation)
    } else {
      merged[index] = conversation
    }
  }

  return merged
}

function createAgentConversation(now = Date.now()): AgentConversation {
  return {
    id: genId(),
    title: i18n.t('data.newConversationDefault'),
    activeRoundId: null,
    createdAt: now,
    updatedAt: now,
    rounds: [],
    messages: [],
  }
}

function createAgentConversationTitle(prompt: string, fallbackTitle: string) {
  const title = prompt.replace(/\s+/g, ' ').trim()
  if (!title) return fallbackTitle
  const chars = Array.from(title)
  if (chars.length <= AGENT_CONVERSATION_TITLE_MAX_LENGTH) return title
  return `${chars.slice(0, AGENT_CONVERSATION_TITLE_MAX_LENGTH - 3).join('')}...`
}

function isEmptyAgentConversation(conversation: AgentConversation) {
  return conversation.rounds.length === 0 && conversation.messages.length === 0 && !conversation.activeRoundId
}

function getLatestAgentConversation(conversations: AgentConversation[]) {
  return conversations.reduce<AgentConversation | null>((latest, conversation) => {
    if (!latest) return conversation
    if (conversation.updatedAt !== latest.updatedAt) return conversation.updatedAt > latest.updatedAt ? conversation : latest
    return conversation.createdAt > latest.createdAt ? conversation : latest
  }, null)
}

function getPageScrollTop() {
  if (typeof window === 'undefined') return 0
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0
}

function getMaxPageScrollTop() {
  if (typeof window === 'undefined') return 0
  const scrollingElement = document.scrollingElement ?? document.documentElement
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  return Math.max(0, scrollingElement.scrollHeight - viewportHeight)
}

function saveAgentScrollPositionState(state: Pick<AppState, 'appMode' | 'activeAgentConversationId' | 'agentScrollPositions'>) {
  if (state.appMode !== 'agent' || !state.activeAgentConversationId) return state.agentScrollPositions
  return {
    ...state.agentScrollPositions,
    [state.activeAgentConversationId]: getPageScrollTop(),
  }
}

function requestPageScrollRestore(top: number) {
  if (typeof window === 'undefined') return
  let frame = 0
  const maxFrames = 60

  const restore = () => {
    const targetTop = Math.min(Math.max(0, top), getMaxPageScrollTop())
    window.scrollTo({ top: targetTop, behavior: 'auto' })
    frame += 1
    if (frame >= maxFrames) return
    if (Math.abs(getPageScrollTop() - targetTop) <= 2 && getMaxPageScrollTop() >= top) return
    window.requestAnimationFrame(restore)
  }

  window.requestAnimationFrame(restore)
}

export function getPersistedState(state: AppState) {
  return createPersistedState(state, agentConversationMigrationPending && !agentConversationPersistenceReady)
}

async function replaceStoredAgentConversations(conversations: AgentConversation[]) {
  await replaceAgentConversations(conversations.map(getPersistableAgentConversation))
}

function getPersistableAgentConversation(conversation: AgentConversation): AgentConversation {
  return getPersistableAgentConversations([conversation])[0]!
}

function mergePersistedState(persistedState: unknown, currentState: AppState): AppState {
  const plan = normalizePersistedState(persistedState, currentState)
  if (!plan) return currentState
  if (plan.shouldMigrateAgentConversations) agentConversationMigrationPending = true
  return {
    ...currentState,
    ...plan.state,
    activeFavoriteCollectionId: null,
    favoritePickerTaskIds: null,
  }
}

// ===== Store 类型 =====

interface AppState {
  // 模式
  appMode: AppMode
  setAppMode: (mode: AppMode) => void

  // 设置
  settings: AppSettings
  previousPresetConfig: Pick<AppSettings, 'customProviders' | 'profiles'> | null
  setSettings: (s: Partial<AppSettings>) => void
  setPresetImportedSettings: (
    importedSettings: Partial<AppSettings> | unknown,
    transform?: (settings: AppSettings) => Partial<AppSettings>,
  ) => Promise<void>
  dismissedPresetProfileIds: string[]
  dismissPresetProfile: (id: string) => void
  restorePresetProfile: (id: string) => void
  dismissedPresetProviderIds: string[]
  dismissPresetProvider: (id: string) => void
  restorePresetProvider: (id: string) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  replaceInputImage: (idx: number, img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[], options?: { equivalentImageIds?: Record<string, string> }) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void
  galleryInputDraft: AgentInputDraft | null

  // 参数
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  setReusedTaskApiProfile: (profileId: string | null, missing?: boolean, profileName?: string | null) => void

  // Agent
  agentConversations: AgentConversation[]
  agentConversationsLoaded: boolean
  activeAgentConversationId: string | null
  agentInputDrafts: Record<string, AgentInputDraft>
  agentScrollPositions: Record<string, number>
  agentSidebarCollapsed: boolean
  agentAssetTab: 'references' | 'outputs'
  agentAssetPanelCollapsed: boolean
  agentMobileHeaderVisible: boolean
  agentEditingRoundId: string | null
  agentEditingConversationId: string | null
  agentGeneratingTitleIds: Record<string, true>
  createAgentConversation: () => string
  setActiveAgentConversationId: (id: string | null) => void
  setActiveAgentRoundId: (conversationId: string, roundId: string | null) => void
  renameAgentConversation: (id: string, title: string) => void
  deleteAgentConversation: (id: string) => void
  deleteAgentRound: (conversationId: string, roundId: string) => Promise<AgentDeletionResult>
  deleteAgentAssistantMessage: (conversationId: string, messageId: string) => Promise<AgentDeletionResult>
  setAgentSidebarCollapsed: (collapsed: boolean) => void
  setAgentAssetTab: (tab: 'references' | 'outputs') => void
  setAgentAssetPanelCollapsed: (collapsed: boolean) => void
  setAgentMobileHeaderVisible: (visible: boolean) => void
  setAgentEditingRoundId: (id: string | null) => void
  setAgentEditingConversationId: (id: string | null) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void
  favoriteCollections: FavoriteCollection[]
  setFavoriteCollections: (collections: FavoriteCollection[]) => void
  defaultFavoriteCollectionId: string | null
  setDefaultFavoriteCollectionId: (id: string | null) => void
  activeFavoriteCollectionId: string | null
  isManageCollectionsModalOpen: boolean
  setActiveFavoriteCollectionId: (id: string | null) => void
  openManageCollectionsModal: () => void
  closeManageCollectionsModal: () => void
  favoritePickerTaskIds: string[] | null
  openFavoritePicker: (taskIds: string[]) => void
  closeFavoritePicker: () => void
  streamPreviews: Record<string, string>
  streamPreviewSlots: Record<string, Record<string, string>>
  setTaskStreamPreview: (taskId: string, image?: string, requestIndex?: number) => void

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void
  selectedFavoriteCollectionIds: string[]
  setSelectedFavoriteCollectionIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleFavoriteCollectionSelection: (id: string, force?: boolean) => void
  clearFavoriteCollectionSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  setLightboxImageId: (id: string | null, list?: string[]) => void
  showSettings: boolean
  settingsTabRequest: SettingsTab | null
  setShowSettings: (v: boolean, tab?: SettingsTab) => void
  supportPromptOpen: boolean
  supportPromptDismissed: boolean
  supportPromptSkippedForImportedData: boolean
  setSupportPromptOpen: (v: boolean) => void
  dismissSupportPrompt: () => void

  // Toast
  toast: { message: string; type: ToastType } | null
  showToast: (message: string, type?: ToastType) => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    checkbox?: {
      label: string
      defaultChecked?: boolean
      disabled?: boolean
      tone?: 'primary' | 'danger'
    }
    confirmText?: string
    cancelText?: string
    showCancel?: boolean
    buttons?: Array<{
      label: string
      tone?: 'primary' | 'secondary' | 'danger' | 'warning'
      action: (checkboxChecked?: boolean) => void
    }>
    buttonsLayout?: 'row' | 'stack'
    icon?: 'info' | 'copy'
    buttonsScrollable?: boolean
    minConfirmDelayMs?: number
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    awaitAction?: boolean
    action?: (checkboxChecked?: boolean) => void | boolean | Promise<void | boolean>
    cancelAction?: (checkboxChecked?: boolean) => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

function isImageReferencedByState(state: AppState, imageId: string) {
  if (state.inputImages.some((img) => img.id === imageId)) return true
  if (state.galleryInputDraft?.inputImages.some((img) => img.id === imageId)) return true
  if (Object.values(state.agentInputDrafts).some((draft) => draft.inputImages.some((img) => img.id === imageId))) return true
  if (state.tasks.some((task) =>
    task.inputImageIds.includes(imageId) ||
    task.outputImages.includes(imageId) ||
    task.transparentOriginalImages?.includes(imageId) ||
    task.streamPartialImageIds?.includes(imageId) ||
    task.maskTargetImageId === imageId ||
    task.maskImageId === imageId
  )) return true
  return state.agentConversations.some((conversation) =>
    conversation.rounds.some((round) =>
      round.inputImageIds.includes(imageId) ||
      round.maskTargetImageId === imageId ||
      round.maskImageId === imageId
    ) ||
    conversation.messages.some((message) =>
      message.inputImageIds?.includes(imageId) ||
      message.maskTargetImageId === imageId ||
      message.maskImageId === imageId
    ),
  )
}

export async function deleteImageIfUnreferenced(imageId: string) {
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  try {
    await deleteStoredImageIfUnreferenced(imageId)
  } catch {
    // 清理是内存/存储优化，失败不影响替换结果。
  }
}

async function deleteStoredImageIfUnreferenced(imageId: string) {
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  const [image, thumbnail] = await Promise.all([getImage(imageId), getStoredImageThumbnail(imageId)])
  if (isImageReferencedByState(useStore.getState(), imageId)) return

  await deleteImage(imageId)
  if (!isImageReferencedByState(useStore.getState(), imageId)) {
    deleteImageCacheEntry(imageId)
    return
  }

  if (image) {
    await putImage(image)
    cacheImage(image.id, image.dataUrl)
  }
  if (thumbnail) {
    await putImageThumbnail(thumbnail)
    cacheThumbnail(thumbnail.id, {
      dataUrl: thumbnail.thumbnailDataUrl,
      width: thumbnail.width,
      height: thumbnail.height,
      thumbnailVersion: thumbnail.thumbnailVersion,
    })
  }
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Mode
      appMode: 'gallery',
      setAppMode: (appMode) => {
        if (appMode === 'gallery') {
          const state = get()
          const agentInputDrafts = saveActiveAgentInputDrafts(state)
          const galleryInputDraft = saveGalleryInputDraft(state)
          const agentScrollPositions = saveAgentScrollPositionState(state)
          set((state) => ({
            appMode,
            agentInputDrafts,
            galleryInputDraft,
            agentScrollPositions,
            agentMobileHeaderVisible: true,
            selectedTaskIds: [],
            selectedFavoriteCollectionIds: [],
            agentEditingRoundId: null,
            ...(state.appMode === 'agent' ? restoreGalleryInputDraftState(galleryInputDraft) : {}),
          }))
          return
        }

        const state = get()
        const settings = normalizeSettings(state.settings)
        const activeProfile = createAgentResponsesApiProfile(getAgentTextApiProfile(settings) ?? getActiveApiProfile(settings))
        const agentValidationError = getAgentProfileValidationError(settings)

        const supportsResponsesApi = activeProfile.provider === 'openai' && (
          canUseOAuthForProfile(activeProfile) || activeProfile.apiKey.trim() !== ''
        )

        if (!agentValidationError || supportsResponsesApi) {
          const galleryInputDraft = saveGalleryInputDraft(state)
          const savedAgentScrollTop = state.activeAgentConversationId
            ? state.agentScrollPositions[state.activeAgentConversationId]
            : undefined
          set((state) => ({
            appMode: 'agent',
            galleryInputDraft,
            agentMobileHeaderVisible: false,
            agentSidebarCollapsed: true,
            agentAssetPanelCollapsed: true,
            selectedTaskIds: [],
            selectedFavoriteCollectionIds: [],
            ...restoreAgentInputDraftState(state.agentInputDrafts, state.activeAgentConversationId),
          }))
          if (savedAgentScrollTop != null) requestPageScrollRestore(savedAgentScrollTop)
          void (async () => {
            const groups = getGroupsForApiMode('responses', await fetchResponsesApiGroups())
            const selectedGroupId = getSelectedGroups().responses
            if (selectedGroupId && groups.some((group) => group.id === selectedGroupId)) return
            if (groups.length === 1) {
              setSelectedGroup('responses', groups[0].id)
              const { refreshWithGroupId } = await import('./lib/sakrylleAuth')
              await refreshWithGroupId(groups[0].id)
              return
            }
            if (groups.length < 1) return
            const { refreshWithGroupId } = await import('./lib/sakrylleAuth')
            useStore.getState().setConfirmDialog({
              title: i18n.t('agent.selectGroupTitle'),
              message: i18n.t('agent.selectGroupMessage', { count: groups.length }),
              icon: 'info',
              showCancel: true,
              cancelText: i18n.t('common.cancel'),
              buttonsLayout: 'stack',
              buttonsScrollable: groups.length > 4,
              buttons: groups.map((group) => ({
                label: group.name,
                tone: 'primary' as const,
                action: async () => {
                  setSelectedGroup('responses', group.id)
                  await refreshWithGroupId(group.id)
                },
              })),
            })
          })()
          return
        }

        if (activeProfile.provider === 'openai') {
          state.setConfirmDialog({
            title: i18n.t('errors.needResponsesApiTitle'),
            message: i18n.t('errors.needResponsesApiMessage', { name: activeProfile.name }),
            confirmText: i18n.t('errors.goToSettings'),
            cancelText: i18n.t('common.cancel'),
            action: () => {
              useStore.getState().setShowSettings(true, 'api')
            },
          })
          return
        }

        if (settings.agentApiConfigMode !== 'off') {
          state.setConfirmDialog({
            title: i18n.t("upstreamSync.incompleteAgentApiConfiguration"),
            message: i18n.t('upstreamSync.message48', { value0: agentValidationError.message }),
            confirmText: i18n.t("errors.goToSettings"),
            cancelText: i18n.t("size.cancel"),
            action: () => {
              useStore.getState().setShowSettings(true, 'agent')
            },
          })
          return
        }

        state.setConfirmDialog({
          title: i18n.t('errors.providerNotSupportAgentTitle'),
          message: i18n.t('errors.providerNotSupportAgentMessage', { name: activeProfile.name }),
          confirmText: i18n.t('errors.goToSettings'),
          cancelText: i18n.t('common.cancel'),
          action: () => {
            useStore.getState().setShowSettings(true, 'api')
          },
        })
      },

      // Settings
      settings: { ...DEFAULT_SETTINGS },
      previousPresetConfig: null,
      dismissedPresetProfileIds: [],
      dismissPresetProfile: (id) => set((state) => ({
        dismissedPresetProfileIds: state.dismissedPresetProfileIds.includes(id)
          ? state.dismissedPresetProfileIds
          : [...state.dismissedPresetProfileIds, id],
      })),
      restorePresetProfile: (id) => set((state) => ({
        dismissedPresetProfileIds: state.dismissedPresetProfileIds.filter((item) => item !== id),
      })),
      dismissedPresetProviderIds: [],
      dismissPresetProvider: (id) => set((state) => ({
        dismissedPresetProviderIds: state.dismissedPresetProviderIds.includes(id)
          ? state.dismissedPresetProviderIds
          : [...state.dismissedPresetProviderIds, id],
      })),
      restorePresetProvider: (id) => set((state) => ({
        dismissedPresetProviderIds: state.dismissedPresetProviderIds.filter((item) => item !== id),
      })),
      setSettings: (s) => set((st) => {
        const previous = normalizeSettings(st.settings)
        const incoming = s as Partial<AppSettings>
        const hasLegacyOverrides =
          incoming.baseUrl !== undefined ||
          incoming.apiKey !== undefined ||
          incoming.model !== undefined ||
          incoming.timeout !== undefined ||
          incoming.apiMode !== undefined ||
          incoming.codexCli !== undefined ||
          incoming.apiProxy !== undefined ||
          incoming.streamImages !== undefined ||
          incoming.streamPartialImages !== undefined
        const merged = normalizeSettings({ ...previous, ...incoming })
        if (hasLegacyOverrides && incoming.profiles === undefined) {
          merged.profiles = merged.profiles.map((profile) =>
            profile.id === merged.activeProfileId
              ? {
                  ...profile,
                  baseUrl: incoming.baseUrl ?? profile.baseUrl,
                  apiKey: incoming.apiKey ?? profile.apiKey,
                  model: incoming.model ?? profile.model,
                  timeout: incoming.timeout ?? profile.timeout,
                  apiMode: incoming.apiMode === 'images' || incoming.apiMode === 'responses' ? incoming.apiMode : profile.apiMode,
                  codexCli: incoming.codexCli ?? profile.codexCli,
                  apiProxy: incoming.apiProxy ?? profile.apiProxy,
                  streamImages: incoming.streamImages ?? profile.streamImages,
                  streamPartialImages: incoming.streamPartialImages ?? profile.streamPartialImages,
                }
              : profile,
          )
        }
        const effectiveDismissedPresetProviderIds = st.dismissedPresetProviderIds.filter((id) =>
          !isPresetProviderDeletionPrevented(id, previous.profiles),
        )
        const settings = normalizeSettings(enforcePresetConfigPolicy(merged, {
          dismissedPresetProviderIds: effectiveDismissedPresetProviderIds,
        }))
        const shouldClearReusedProfile = st.reusedTaskApiProfileId && settings.activeProfileId === st.reusedTaskApiProfileId
        return {
          settings,
          ...(shouldClearReusedProfile
            ? { reusedTaskApiProfileId: null, reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false }
            : {}),
        }
      }),
      setPresetImportedSettings: async (importedSettings, transform) => {
        set((state) => {
          const presetIds = getPresetProfileIds()
          const presetProviderIds = getPresetProviderIds()
          const dismissedPresetProfileIds = state.dismissedPresetProfileIds.filter((id) => presetIds.has(id))
          const deletionPrevented = isPresetConfigDeletionPrevented()
          const remainingPresetProfiles = (getPresetConfig()?.profiles ?? state.settings.profiles)
            .filter((profile) => !dismissedPresetProfileIds.includes(profile.id))
          const dismissedPresetProviderIds = state.dismissedPresetProviderIds
            .filter((id) => presetProviderIds.has(id))
          const effectiveDismissedPresetProviderIds = dismissedPresetProviderIds
            .filter((id) => !isPresetProviderDeletionPrevented(id, remainingPresetProfiles))
          const merged = mergePresetImportedSettings(state.settings, importedSettings, {
            lockPresetParams: isPresetConfigParamsLocked(),
            dismissedPresetProfileIds: deletionPrevented ? [] : dismissedPresetProfileIds,
            dismissedPresetProviderIds: effectiveDismissedPresetProviderIds,
            previousPresetConfig: state.previousPresetConfig,
            usedPresetProfileIds: state.tasks.flatMap((task) => task.apiProfileId ? [task.apiProfileId] : []),
          })
          const settings = normalizeSettings(enforcePresetConfigPolicy(
            normalizeSettings(transform?.(merged.settings) ?? merged.settings),
            { dismissedPresetProviderIds: effectiveDismissedPresetProviderIds },
          ))
          const shouldClearReusedProfile = state.reusedTaskApiProfileId && settings.activeProfileId === state.reusedTaskApiProfileId
          return {
            settings,
            previousPresetConfig: getPresetConfig() ? merged.presetConfig : null,
            dismissedPresetProfileIds,
            dismissedPresetProviderIds,
            reusedTaskApiProfileId: shouldClearReusedProfile ? null : state.reusedTaskApiProfileId,
            ...(shouldClearReusedProfile
              ? { reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false }
              : {}),
          }
        })
      },
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set((s) => syncActiveInputDraft(s, { prompt })),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return syncActiveInputDraft(s, { inputImages: [...s.inputImages, img] })
        }),
      replaceInputImage: (idx, img) => {
        let removedImageId: string | null = null
        set((s) => {
          if (idx < 0 || idx >= s.inputImages.length) return s
          const previous = s.inputImages[idx]
          if (!previous || previous.id === img.id) return s
          if (s.inputImages.some((item, itemIdx) => itemIdx !== idx && item.id === img.id)) return s
          removedImageId = previous.id
          const inputImages = s.inputImages.map((item, itemIdx) => itemIdx === idx ? img : item)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            equivalentImageIds: { [previous.id]: img.id },
            clearMissingMask: previous.id === s.maskDraft?.targetImageId,
          }))
        })
        if (removedImageId) void deleteImageIfUnreferenced(removedImageId)
      },
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const inputImages = s.inputImages.filter((_, i) => i !== idx)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            clearMissingMask: removed?.id === s.maskDraft?.targetImageId,
          }))
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) deleteCachedImage(img.id)
          return syncActiveInputDraft(s, {
            ...updateInputDraftImages(s, []),
            maskDraft: null,
            maskEditorImageId: null,
          })
        }),
      setInputImages: (imgs, options) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(imgs, s.maskDraft?.targetImageId)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            equivalentImageIds: options?.equivalentImageIds,
          }))
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          const images = [...s.inputImages]
          if (fromIdx < 0 || fromIdx >= images.length) return s
          const maskTargetImageId = s.maskDraft?.targetImageId
          if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return s
          const minTargetIdx = maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
          const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
          const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
          if (insertIdx === fromIdx) return s
          const [moved] = images.splice(fromIdx, 1)
          images.splice(insertIdx, 0, moved)
          return syncActiveInputDraft(s, updateInputDraftImages(s, images, { clearMissingMask: false }))
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(s.inputImages, maskDraft?.targetImageId)
          return syncActiveInputDraft(s, {
            maskDraft,
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
          })
        }),
      clearMaskDraft: () => set((s) => syncActiveInputDraft(s, { maskDraft: null })),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => {
        if (maskEditorImageId) dismissAllTooltips()
        set((s) => syncActiveInputDraft(s, { maskEditorImageId }))
      },
      galleryInputDraft: null,

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      setReusedTaskApiProfile: (profileId, missing = false, profileName = null) => set({
        reusedTaskApiProfileId: profileId,
        reusedTaskApiProfileName: profileName,
        reusedTaskApiProfileMissing: missing,
      }),

      // Agent
      agentConversations: [],
      agentConversationsLoaded: false,
      activeAgentConversationId: null,
      agentInputDrafts: {},
      agentScrollPositions: {},
      agentSidebarCollapsed: true,
      agentAssetTab: 'outputs',
      agentAssetPanelCollapsed: false,
      agentMobileHeaderVisible: false,
      agentEditingRoundId: null,
      agentEditingConversationId: null,
      agentGeneratingTitleIds: {},
      createAgentConversation: () => {
        const now = Date.now()
        const latestConversation = getLatestAgentConversation(get().agentConversations)
        if (latestConversation && isEmptyAgentConversation(latestConversation)) {
          set((state) => {
            const agentInputDrafts = saveActiveAgentInputDrafts(state)
            return {
              agentConversations: state.agentConversations.map((conversation) =>
                conversation.id === latestConversation.id
                  ? { ...conversation, createdAt: now, updatedAt: now }
                  : conversation,
              ),
              activeAgentConversationId: latestConversation.id,
              agentInputDrafts,
              agentSidebarCollapsed: true,
              agentEditingRoundId: null,
              ...restoreAgentInputDraftState(agentInputDrafts, latestConversation.id),
            }
          })
          return latestConversation.id
        }

        const conversation = createAgentConversation(now)
        set((state) => {
          const agentInputDrafts = saveActiveAgentInputDrafts(state)
          return {
            agentConversations: [
              ...state.agentConversations,
              conversation,
            ],
            activeAgentConversationId: conversation.id,
            agentInputDrafts,
            agentSidebarCollapsed: true,
            agentEditingRoundId: null,
            ...restoreAgentInputDraftState(agentInputDrafts, conversation.id),
          }
        })
        return conversation.id
      },
      setActiveAgentConversationId: (id) => set((state) => {
        if (state.activeAgentConversationId === id) {
          return {
            activeAgentConversationId: id,
            agentSidebarCollapsed: true,
            agentAssetPanelCollapsed: true,
            agentEditingRoundId: null,
          }
        }
        const agentInputDrafts = saveActiveAgentInputDrafts(state)
        const agentScrollPositions = saveAgentScrollPositionState(state)
        return {
          activeAgentConversationId: id,
          agentInputDrafts,
          agentScrollPositions,
          agentSidebarCollapsed: true,
          agentAssetPanelCollapsed: true,
          agentEditingRoundId: null,
          ...restoreAgentInputDraftState(agentInputDrafts, id),
        }
      }),
      setActiveAgentRoundId: (conversationId, roundId) => set((state) => ({
        agentConversations: state.agentConversations.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, activeRoundId: roundId, updatedAt: Date.now() } : conversation,
        ),
      })),
      renameAgentConversation: (id, title) => set((state) => ({ agentConversations: state.agentConversations.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c)) })),
      deleteAgentConversation: (id) => set((state) => {
        const agentInputDrafts = { ...state.agentInputDrafts }
        delete agentInputDrafts[id]
        const activeDeleted = state.activeAgentConversationId === id
        return {
          agentConversations: state.agentConversations.filter((c) => c.id !== id),
          activeAgentConversationId: activeDeleted ? null : state.activeAgentConversationId,
          agentInputDrafts,
          ...(activeDeleted ? clearInputDraftState() : {}),
        }
      }),
      deleteAgentRound: (conversationId, roundId) => deleteAgentRoundAndTasks(conversationId, roundId),
      deleteAgentAssistantMessage: (conversationId, messageId) => deleteAgentAssistantMessageAndTasks(conversationId, messageId),
      setAgentSidebarCollapsed: (agentSidebarCollapsed) => set({ agentSidebarCollapsed }),
      setAgentAssetTab: (agentAssetTab) => set({ agentAssetTab }),
      setAgentAssetPanelCollapsed: (agentAssetPanelCollapsed) => set({ agentAssetPanelCollapsed }),
      setAgentMobileHeaderVisible: (agentMobileHeaderVisible) => set({ agentMobileHeaderVisible }),
      setAgentEditingRoundId: (agentEditingRoundId) => set({ agentEditingRoundId }),
      setAgentEditingConversationId: (agentEditingConversationId) => set({ agentEditingConversationId }),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set(() => ({
        tasks,
        ...(countSuccessfulOutputImages(tasks) <= SUPPORT_PROMPT_IMAGE_THRESHOLD
          ? { supportPromptSkippedForImportedData: false }
          : {}),
      })),
      favoriteCollections: [createDefaultFavoriteCollection()],
      setFavoriteCollections: (favoriteCollections) => set((state) => {
        const nextCollections = ensureDefaultFavoriteCollection(normalizeFavoriteCollections(favoriteCollections))
        return {
          favoriteCollections: nextCollections,
          defaultFavoriteCollectionId: resolveDefaultFavoriteCollectionId(nextCollections, state.defaultFavoriteCollectionId),
        }
      }),
      defaultFavoriteCollectionId: DEFAULT_FAVORITE_COLLECTION_ID,
      setDefaultFavoriteCollectionId: (defaultFavoriteCollectionId) => set((state) => (
        defaultFavoriteCollectionId === null || state.favoriteCollections.some((collection) => collection.id === defaultFavoriteCollectionId)
          ? { defaultFavoriteCollectionId }
          : state
      )),
      activeFavoriteCollectionId: null,
      isManageCollectionsModalOpen: false,
      setActiveFavoriteCollectionId: (activeFavoriteCollectionId) => set({ activeFavoriteCollectionId, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),
      openManageCollectionsModal: () => set({ isManageCollectionsModalOpen: true }),
      closeManageCollectionsModal: () => set({ isManageCollectionsModalOpen: false }),
      favoritePickerTaskIds: null,
      openFavoritePicker: (taskIds) => {
        if (!taskIds.length) return
        dismissAllTooltips()
        set({ favoritePickerTaskIds: Array.from(new Set(taskIds)).filter(Boolean) })
      },
      closeFavoritePicker: () => set({ favoritePickerTaskIds: null }),
      streamPreviews: {},
      streamPreviewSlots: {},
      setTaskStreamPreview: (taskId, image, requestIndex = 0) => set((s) => {
        if (image) {
          if (!s.tasks.some((task) => task.id === taskId)) return s
          const slotKey = String(requestIndex)
          const currentSlots = s.streamPreviewSlots[taskId] ?? {}
          if (s.streamPreviews[taskId] === image && currentSlots[slotKey] === image) return s
          return {
            streamPreviews: { ...s.streamPreviews, [taskId]: image },
            streamPreviewSlots: {
              ...s.streamPreviewSlots,
              [taskId]: { ...currentSlots, [slotKey]: image },
            },
          }
        }

        if (!(taskId in s.streamPreviews) && !(taskId in s.streamPreviewSlots)) return s
        const next = { ...s.streamPreviews }
        const nextSlots = { ...s.streamPreviewSlots }
        delete next[taskId]
        delete nextSlots[taskId]
        return { streamPreviews: next, streamPreviewSlots: nextSlots }
      }),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set(filterFavorite ? { filterFavorite, selectedTaskIds: [], selectedFavoriteCollectionIds: [] } : { filterFavorite, activeFavoriteCollectionId: null, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),
      selectedFavoriteCollectionIds: [],
      setSelectedFavoriteCollectionIds: (updater) => set((s) => ({
        selectedFavoriteCollectionIds: typeof updater === 'function' ? updater(s.selectedFavoriteCollectionIds) : updater
      })),
      toggleFavoriteCollectionSelection: (id, force) => set((s) => {
        const isSelected = s.selectedFavoriteCollectionIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedFavoriteCollectionIds: shouldSelect
            ? [...s.selectedFavoriteCollectionIds, id]
            : s.selectedFavoriteCollectionIds.filter((x) => x !== id)
        }
      }),
      clearFavoriteCollectionSelection: () => set({ selectedFavoriteCollectionIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => {
        if (detailTaskId) dismissAllTooltips()
        set({ detailTaskId })
      },
      lightboxImageId: null,
      lightboxImageList: [],
      setLightboxImageId: (lightboxImageId, list) => {
        if (lightboxImageId) dismissAllTooltips()
        set({ lightboxImageId, lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []) })
      },
      showSettings: false,
      settingsTabRequest: null,
      setShowSettings: (showSettings, settingsTabRequest) => {
        if (showSettings) dismissAllTooltips()
        set({
          showSettings,
          ...(settingsTabRequest ? { settingsTabRequest } : {}),
          ...(!showSettings ? { settingsTabRequest: null } : {}),
        })
      },
      supportPromptOpen: false,
      supportPromptDismissed: false,
      supportPromptSkippedForImportedData: false,
      setSupportPromptOpen: (supportPromptOpen) => set({ supportPromptOpen }),
      dismissSupportPrompt: () => set({ supportPromptOpen: false, supportPromptDismissed: true }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        const toastMessage = getToastMessage(message, type)
        const toast = { message: toastMessage, type }
        set({ toast })
        setTimeout(() => {
          set((s) => (s.toast === toast ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => {
        if (confirmDialog) dismissAllTooltips()
        set({ confirmDialog })
      },
    }),
    {
      name: 'sakrylle-image-playground',
      version: 2,
      migrate: migratePersistedState,
      partialize: getPersistedState,
      merge: mergePersistedState,
    },
  ),
)

let lastStoredAgentConversations = useStore.getState().agentConversations
let agentConversationPersistRunning = false
let agentConversationPersistQueued = false

async function flushAgentConversationsToIndexedDB() {
  if (agentConversationPersistRunning) {
    agentConversationPersistQueued = true
    return
  }

  agentConversationPersistRunning = true
  try {
    do {
      agentConversationPersistQueued = false
      const conversations = useStore.getState().agentConversations
      await replaceStoredAgentConversations(conversations)
      lastStoredAgentConversations = conversations
    } while (agentConversationPersistQueued || useStore.getState().agentConversations !== lastStoredAgentConversations)
  } finally {
    agentConversationPersistRunning = false
  }
}

useStore.subscribe((state) => {
  if (state.agentConversations === lastStoredAgentConversations) return
  if (!agentConversationPersistenceReady) {
    agentConversationPersistQueued = true
    return
  }
  void flushAgentConversationsToIndexedDB()
})

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

function getPersistableTask(task: TaskRecord): TaskRecord {
  const rawResponsePayload = getPersistableRawResponsePayload(task.rawResponsePayload)
  return rawResponsePayload === task.rawResponsePayload ? task : { ...task, rawResponsePayload }
}

function putTask(task: TaskRecord): Promise<IDBValidKey> {
  return dbPutTask(getPersistableTask(task))
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  const profile = getActiveApiProfile(settings)
  return `${profile.baseUrl}\n${profile.apiKey}`
}

function isRunningOpenAITask(task: TaskRecord) {
  return task.status === 'running'
}

function isAsyncCustomProviderTask(settings: AppSettings, provider: string, hasInputImages: boolean) {
  const customProvider = getCustomProviderDefinition(settings, provider)
  if (!customProvider?.poll) return false
  const submitMapping = hasInputImages && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
  return Boolean(submitMapping.taskIdPath)
}

function clearOpenAIWatchdogTimer(taskId: string) {
  const timer = openAIWatchdogTimers.get(taskId)
  if (timer) clearTimeout(timer)
  openAIWatchdogTimers.delete(taskId)
}

function failOpenAITaskIfStillRunning(taskId: string, error: string, now = Date.now()) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return false

  updateTaskInStore(taskId, {
    ...createTaskErrorPatch(task, error, now),
    elapsed: Math.max(0, now - task.createdAt),
  })
  return true
}

function scheduleOpenAIWatchdog(taskId: string, timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  clearOpenAIWatchdogTimer(taskId)
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return

  const timeoutMs = Math.max(0, timeoutSeconds * 1000)
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - task.createdAt))
  const timer = setTimeout(() => {
    openAIWatchdogTimers.delete(taskId)
    const failed = failOpenAITaskIfStillRunning(taskId, createOpenAITimeoutError(timeoutSeconds, profile))
    if (failed) useStore.getState().showToast(i18n.t('toast.openaiTimeout'), 'error')
  }, remainingMs)
  openAIWatchdogTimers.set(taskId, timer)
}

function usesConcurrentImageRequests(settings: AppSettings, profile: ApiProfile, params: TaskParams, hasInputImages: boolean) {
  const n = params.n > 0 ? params.n : 1
  if (n <= 1) return false
  if (profile.provider === 'openai') {
    if (profile.apiMode === 'responses') return true
    return profile.apiMode === 'images' && (profile.codexCli || profile.streamImages)
  }
  return profile.codexCli && !isAsyncCustomProviderTask(settings, profile.provider, hasInputImages)
}

export function taskHasOutputErrors(task: Pick<TaskRecord, 'outputErrors'>) {
  return Boolean(task.outputErrors?.length)
}

export function taskMatchesFilterStatus(task: TaskRecord, filterStatus: AppState['filterStatus']) {
  if (filterStatus === 'all') return true
  if (filterStatus === 'error') return task.status === 'error' || taskHasOutputErrors(task)
  return task.status === filterStatus
}

export function taskMatchesSearchQuery(task: TaskRecord, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const prompt = (task.prompt || '').toLowerCase()
  const paramStr = JSON.stringify(task.params).toLowerCase()
  const errorStr = [task.error, ...(task.outputErrors ?? []).map((item) => item.error)].filter(Boolean).join('\n').toLowerCase()
  return prompt.includes(q) || paramStr.includes(q) || errorStr.includes(q)
}

export function showCodexCliPrompt(force = false, reason = i18n.t('errors.codexCliReasonRewritten')) {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return
  const promptRewriteGuardMessage = settings.allowPromptRewrite
    ? i18n.t("upstreamSync.promptRewritingIsAllowedSoNoRewriteGuard")
    : i18n.t("upstreamSync.aShortRewriteGuardWillBeAddedTo")

  state.setConfirmDialog({
    title: i18n.t('errors.codexCliTitle'),
    message: i18n.t('errors.codexCliMessage', { reason }) + promptRewriteGuardMessage,
    confirmText: i18n.t('errors.codexCliEnable'),
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

function getCustomRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile && taskProfile.provider === task.apiProvider && taskProfile.provider !== 'openai') return taskProfile
  return null
}

export function getTaskApiProfile(settings: AppSettings, task: TaskRecord): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  if (!task.apiProfileId) return null
  return normalized.profiles.find((profile) => profile.id === task.apiProfileId) ?? null
}

function createSettingsForApiProfile(settings: AppSettings, profile: ApiProfile): AppSettings {
  const normalized = normalizeSettings(settings)
  const requestSettings = normalizeSettings({
    ...normalized,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    timeout: profile.timeout,
    apiMode: profile.apiMode,
    codexCli: profile.codexCli,
    apiProxy: profile.apiProxy,
    profiles: normalized.profiles.map((item) => item.id === profile.id ? profile : item),
    activeProfileId: profile.id,
  })
  const storedProfile = normalized.profiles.find(item => item.id === profile.id)
  if (storedProfile?.apiMode === 'images' && profile.apiMode === 'responses') {
    return { ...requestSettings, profiles: normalized.profiles }
  }
  return requestSettings
}

function createAgentResponsesApiProfile(profile: ApiProfile): ApiProfile {
  return {
    ...profile,
    apiMode: 'responses',
    model: profile.responsesModel?.trim() || DEFAULT_RESPONSES_MODEL,
    imageProfileId: profile.imageProfileId || (profile.apiMode === 'images' ? profile.id : undefined),
  }
}

function isSakrylleApiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.sakrylle.com'
  } catch {
    return baseUrl.toLowerCase().includes('api.sakrylle.com')
  }
}

function isImagesApiProfile(profile: ApiProfile | null | undefined): profile is ApiProfile {
  return Boolean(profile && profile.apiMode === 'images')
}

function normalizeGalleryImageProfile(profile: ApiProfile): ApiProfile {
  if (profile.provider === 'openai' && profile.model === DEFAULT_RESPONSES_MODEL) {
    return { ...profile, model: DEFAULT_IMAGES_MODEL }
  }
  return profile
}

function resolveGalleryImageApiProfile(settings: AppSettings, preferredProfile: ApiProfile | null | undefined): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  const selectedImageProfile = preferredProfile?.imageProfileId
    ? normalized.profiles.find((profile) => profile.id === preferredProfile.imageProfileId && isImagesApiProfile(profile))
    : null
  const directImageProfile = isImagesApiProfile(preferredProfile) ? preferredProfile : null
  const fallbackImageProfile = normalized.profiles.find(isImagesApiProfile) ?? null
  const profile = selectedImageProfile ?? directImageProfile ?? fallbackImageProfile
  return profile ? normalizeGalleryImageProfile(profile) : null
}

function getAgentProfileValidationError(settings: AppSettings): { profile: ApiProfile | null; message: string } | null {
  const normalized = normalizeSettings(settings)
  const textProfile = getAgentTextApiProfile(normalized)
  if (!textProfile || textProfile.provider !== 'openai' || textProfile.apiMode !== 'responses') {
    return { profile: textProfile, message: i18n.t("upstreamSync.agentModeRequiresAnOpenaiCompatibleTextModel") }
  }
  const textProfileError = validateApiProfile(textProfile, { allowEmptyApiKey: canUseOAuthForProfile(textProfile) })
  if (textProfileError) return { profile: textProfile, message: i18n.t('upstreamSync.message49', { value0: textProfileError }) }

  if (normalized.agentApiConfigMode === 'hybrid') {
    const imageProfile = getAgentImageApiProfile(normalized)
    if (!imageProfile) return { profile: null, message: i18n.t("upstreamSync.imageApiConfigurationMissingSelectAnAvailableConfiguration") }
    const imageProfileError = validateApiProfile(imageProfile, { allowEmptyApiKey: canUseOAuthForProfile(imageProfile) })
    if (imageProfileError) return { profile: imageProfile, message: i18n.t('upstreamSync.message50', { value0: imageProfileError }) }
  }

  return null
}

function getReusedTaskApiProfile(settings: AppSettings, profileId: string | null): ApiProfile | null {
  if (!profileId) return null
  return normalizeSettings(settings).profiles.find((profile) => profile.id === profileId) ?? null
}

function getTaskApiProfileName(task: TaskRecord) {
  return task.apiProfileName || task.apiModel || i18n.t('common.unknownProfile')
}

function getApiModeApiName(apiMode: ApiMode) {
  return apiMode === 'responses' ? 'Responses API' : 'Image API'
}

function isNetworkRecoverableError(err: unknown) {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isApiRequestNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) {
    const message = err.message.toLowerCase()
    return /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(message)
  }
  return false
}

function getApiRequestNetworkErrorHint(
  err: unknown,
  createdAt: number,
  usesApiProxy: boolean,
  profile?: Pick<ApiProfile, 'provider' | 'apiMode' | 'streamImages' | 'streamPartialImages' | 'streamChatCompletionsImage'> | null,
): string | null {
  if (!isApiRequestNetworkError(err)) return null

  const elapsedSeconds = Math.max(0, (Date.now() - createdAt) / 1000)

  if (elapsedSeconds <= 15) {
    if (usesApiProxy) {
      return i18n.t('errors.networkProxyImmediate')
    }
    const unsupportedApiHint = profile?.provider === 'openai'
      ? i18n.t('errors.networkApiUnsupported', { api: getApiModeApiName(profile.apiMode) })
      : ''
    return i18n.t('errors.networkApiUnreachable', { unsupported: unsupportedApiHint })
  }

  if (elapsedSeconds >= 55 && elapsedSeconds <= 75) {
    return i18n.t('errors.networkProxyTimeout60', { hint: getTimeoutStreamingHint(profile) })
  }

  if (elapsedSeconds >= 110 && elapsedSeconds <= 140) {
    return i18n.t('errors.networkProxyTimeout120', { hint: getTimeoutStreamingHint(profile) })
  }

  return i18n.t('errors.networkProxyTimeoutOther', { hint: getTimeoutStreamingHint(profile) })
}

function getRawErrorPayload(err: unknown): Pick<Partial<TaskRecord>, 'rawImageUrls' | 'rawResponsePayload'> {
  if (!(err instanceof Error)) return {}

  const rawImageUrls = 'rawImageUrls' in err ? (err as { rawImageUrls?: unknown }).rawImageUrls : undefined
  const rawResponsePayload = 'rawResponsePayload' in err ? (err as { rawResponsePayload?: unknown }).rawResponsePayload : undefined
  return {
    rawImageUrls: Array.isArray(rawImageUrls) && rawImageUrls.length ? rawImageUrls.filter((url): url is string => typeof url === 'string') : undefined,
    rawResponsePayload: typeof rawResponsePayload === 'string' ? rawResponsePayload : undefined,
  }
}

function clearCustomRecoveryTimer(taskId: string) {
  const timer = customRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  customRecoveryTimers.delete(taskId)
}

function scheduleCustomRecovery(taskId: string, delayMs = CUSTOM_RECOVERY_POLL_MS) {
  if (customRecoveryTimers.has(taskId)) return
  if (!useStore.getState().tasks.some((task) => task.id === taskId)) return
  const timer = setTimeout(() => {
    customRecoveryTimers.delete(taskId)
    recoverCustomTask(taskId)
  }, delayMs)
  customRecoveryTimers.set(taskId, timer)
}

async function readImageSizeParam(dataUrl: string): Promise<Partial<TaskParams> | undefined> {
  if (typeof Image === 'undefined') return undefined

  return new Promise((resolve) => {
    let settled = false
    const image = new Image()
    const finish = (params: Partial<TaskParams> | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(params)
    }
    const timer = setTimeout(() => finish(undefined), 2000)
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
      } else {
        finish(undefined)
      }
    }
    image.onerror = () => finish(undefined)
    image.src = dataUrl
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
    }
  })
}

async function readImageSizeParamsList(images: string[]): Promise<Array<Partial<TaskParams> | undefined>> {
  return Promise.all(images.map((image) => readImageSizeParam(image)))
}

async function resolveImageSizeParamsList(
  images: string[],
  preferred?: Array<Partial<TaskParams> | undefined>,
  sizes?: Array<{ width?: number; height?: number } | undefined>,
): Promise<Array<Partial<TaskParams> | undefined>> {
  const withStoredSizes = images.map((_, index) => addImageSizeParam(preferred?.[index], sizes?.[index]))
  if (withStoredSizes.every(hasActualSizeParam)) {
    return withStoredSizes
  }
  const fallback = await readImageSizeParamsList(images)
  return images.map((_, index) => {
    const params = withStoredSizes[index]
    const fallbackParams = fallback[index]
    if (hasActualSizeParam(params)) return params
    if (fallbackParams?.size) return { ...(params ?? {}), size: fallbackParams.size }
    return hasActualParams(params) ? params : fallbackParams
  })
}

/** 初始化：从 IndexedDB 加载任务，按需恢复输入图片，并清理孤立图片 */
export async function initStore() {
  const legacyAgentConversations = normalizeAgentConversations(useStore.getState().agentConversations)
  const storedTasks = await getAllTasks()
  const storedAgentConversations = normalizeAgentConversations(await getAllAgentConversations())
  let loadedAgentConversations = mergePersistedAgentConversations(storedAgentConversations, legacyAgentConversations)
  const currentAgentConversations = normalizeAgentConversations(useStore.getState().agentConversations)
  loadedAgentConversations = mergePersistedAgentConversations(loadedAgentConversations, currentAgentConversations)
  const activeAgentConversationId = useStore.getState().activeAgentConversationId && loadedAgentConversations.some((conversation) => conversation.id === useStore.getState().activeAgentConversationId)
    ? useStore.getState().activeAgentConversationId
    : loadedAgentConversations[0]?.id ?? null
  if (loadedAgentConversations.length > 0 || legacyAgentConversations.length > 0) {
    useStore.setState((state) => {
      const agentInputDrafts = cleanStaleAgentInputDrafts(
        normalizeAgentInputDrafts(state.agentInputDrafts, loadedAgentConversations),
        activeAgentConversationId,
      )
      return {
        agentConversations: loadedAgentConversations,
        agentConversationsLoaded: true,
        activeAgentConversationId,
        agentInputDrafts,
        ...(state.appMode === 'agent' ? restoreAgentInputDraftState(agentInputDrafts, activeAgentConversationId) : {}),
      }
    })
    await replaceStoredAgentConversations(loadedAgentConversations)
  } else {
    useStore.setState({ agentConversationsLoaded: true })
  }
  const shouldRewritePersistedLocalState = agentConversationMigrationPending
  agentConversationPersistenceReady = true
  agentConversationMigrationPending = false
  if (agentConversationPersistQueued || useStore.getState().agentConversations !== lastStoredAgentConversations) {
    await flushAgentConversationsToIndexedDB()
  }
  if (shouldRewritePersistedLocalState) {
    useStore.setState({})
  }
  const { tasks: markedTasks, interruptedTasks } = markInterruptedOpenAIRunningTasks(storedTasks, Date.now())
  const interruptedTaskIds = new Set(interruptedTasks.map((task) => task.id))
  const favoriteState = useStore.getState()
  const normalizedFavorites = normalizeLoadedFavoriteState(markedTasks.map(getPersistableTask), favoriteState.favoriteCollections, favoriteState.defaultFavoriteCollectionId)
  const tasks = normalizedFavorites.tasks
  if (normalizedFavorites.collections !== favoriteState.favoriteCollections) {
    favoriteState.setFavoriteCollections(normalizedFavorites.collections)
  }
  if (normalizedFavorites.defaultFavoriteCollectionId !== favoriteState.defaultFavoriteCollectionId) {
    useStore.getState().setDefaultFavoriteCollectionId(normalizedFavorites.defaultFavoriteCollectionId)
  }
  await Promise.all(tasks
    .filter((task, index) => normalizedFavorites.changed || interruptedTaskIds.has(task.id) || task.rawResponsePayload !== markedTasks[index]?.rawResponsePayload)
    .map((task) => putTask(task)))
  useStore.getState().setTasks(tasks)
  showSupportPromptForExistingLocalData(tasks)

  // 收集所有任务引用的图片 id
  const referencedIds = new Set<string>()
  const state = useStore.getState()
  const persistedInputImages = state.inputImages
  const galleryInputDraft = state.galleryInputDraft
  const agentConversations = state.agentConversations
  const agentInputDrafts = state.agentInputDrafts
  for (const img of persistedInputImages) referencedIds.add(img.id)
  if (galleryInputDraft) {
    for (const img of galleryInputDraft.inputImages) referencedIds.add(img.id)
  }
  for (const draft of Object.values(agentInputDrafts)) {
    for (const img of draft.inputImages) referencedIds.add(img.id)
  }
  for (const conversation of agentConversations) {
    for (const round of conversation.rounds) {
      for (const id of round.inputImageIds) referencedIds.add(id)
    }
  }
  for (const t of tasks) {
    addTaskReferencedImageIds(referencedIds, t)
  }

  // 只枚举 key 清理孤立图片，避免启动时把所有 4K 原图读进内存。
  const imageIds = await getAllImageIds()
  const referencedImageIds: string[] = []
  for (const imgId of imageIds) {
    if (referencedIds.has(imgId)) {
      referencedImageIds.push(imgId)
    } else {
      await deleteImage(imgId)
    }
  }
  scheduleThumbnailBackfill(referencedImageIds)

  const restoredInputImages: InputImage[] = []
  for (const img of persistedInputImages) {
    if (img.dataUrl) {
      restoredInputImages.push(img)
      cacheImage(img.id, img.dataUrl)
      continue
    }
    const storedImage = await getImage(img.id)
    if (storedImage?.dataUrl) {
      restoredInputImages.push({ ...img, dataUrl: storedImage.dataUrl })
      cacheImage(img.id, storedImage.dataUrl)
    }
  }
  if (restoredInputImages.length !== persistedInputImages.length || restoredInputImages.some((img, index) => img.dataUrl !== persistedInputImages[index]?.dataUrl)) {
    useStore.getState().setInputImages(restoredInputImages)
  }

  if (galleryInputDraft) {
    const restoredGalleryImages: InputImage[] = []
    for (const img of galleryInputDraft.inputImages) {
      if (img.dataUrl) {
        restoredGalleryImages.push(img)
        cacheImage(img.id, img.dataUrl)
        continue
      }
      const storedImage = await getImage(img.id)
      if (storedImage?.dataUrl) {
        restoredGalleryImages.push({ ...img, dataUrl: storedImage.dataUrl })
        cacheImage(img.id, storedImage.dataUrl)
      }
    }
    const restoredGalleryDraft: AgentInputDraft = {
      ...galleryInputDraft,
      ...updateInputDraftImages(galleryInputDraft, restoredGalleryImages),
    }
    const shouldClearMask = galleryInputDraft.maskDraft !== restoredGalleryDraft.maskDraft
    const galleryDraftsChanged =
      restoredGalleryImages.length !== galleryInputDraft.inputImages.length ||
      restoredGalleryImages.some((img, index) => img.dataUrl !== galleryInputDraft.inputImages[index]?.dataUrl) ||
      shouldClearMask
    if (galleryDraftsChanged) {
      const latestState = useStore.getState()
      const nextGalleryInputDraft = isEmptyAgentInputDraft(restoredGalleryDraft) ? null : restoredGalleryDraft
      useStore.setState({
        galleryInputDraft: nextGalleryInputDraft,
        ...(latestState.appMode === 'gallery'
          ? restoreGalleryInputDraftState(nextGalleryInputDraft)
          : {}),
      })
    }
  }

  const restoredAgentInputDrafts: Record<string, AgentInputDraft> = {}
  let agentDraftsChanged = false
  for (const [conversationId, draft] of Object.entries(agentInputDrafts)) {
    const restoredDraftImages: InputImage[] = []
    for (const img of draft.inputImages) {
      if (img.dataUrl) {
        restoredDraftImages.push(img)
        cacheImage(img.id, img.dataUrl)
        continue
      }
      const storedImage = await getImage(img.id)
      if (storedImage?.dataUrl) {
        restoredDraftImages.push({ ...img, dataUrl: storedImage.dataUrl })
        cacheImage(img.id, storedImage.dataUrl)
      }
    }

    const restoredDraft: AgentInputDraft = {
      ...draft,
      ...updateInputDraftImages(draft, restoredDraftImages),
    }
    const shouldClearMask = draft.maskDraft !== restoredDraft.maskDraft
    if (!isEmptyAgentInputDraft(restoredDraft)) restoredAgentInputDrafts[conversationId] = restoredDraft
    if (
      restoredDraftImages.length !== draft.inputImages.length ||
      restoredDraftImages.some((img, index) => img.dataUrl !== draft.inputImages[index]?.dataUrl) ||
      shouldClearMask
    ) {
      agentDraftsChanged = true
    }
  }
  if (agentDraftsChanged) {
    const latestState = useStore.getState()
    useStore.setState({
      agentInputDrafts: restoredAgentInputDrafts,
      ...(latestState.appMode === 'agent'
        ? restoreAgentInputDraftState(restoredAgentInputDrafts, latestState.activeAgentConversationId)
        : {}),
    })
  }

  for (const task of tasks) {
    if (
      task.customTaskId &&
      (task.status === 'running' || task.customRecoverable)
    ) {
      scheduleCustomRecovery(task.id, 0)
    }
  }
}

/** 提交新任务 */
export async function submitTask(options: { allowFullMask?: boolean; useCurrentApiProfileWhenReusedMissing?: boolean } = {}) {
  const { settings, prompt, inputImages, maskDraft, params, reusedTaskApiProfileId, reusedTaskApiProfileName, reusedTaskApiProfileMissing, showToast, setConfirmDialog } =
    useStore.getState()

  const normalizedSettings = normalizeSettings(settings)
  let preferredProfile = getActiveApiProfile(settings)
  if (normalizedSettings.reuseTaskApiProfileTemporarily && (reusedTaskApiProfileId || reusedTaskApiProfileMissing)) {
    const reusedProfile = getReusedTaskApiProfile(normalizedSettings, reusedTaskApiProfileId)
    if (!reusedProfile) {
      if (options.useCurrentApiProfileWhenReusedMissing) {
        useStore.getState().setReusedTaskApiProfile(null)
      } else {
        setConfirmDialog({
          title: i18n.t('errors.profileNotFoundTitle'),
          message: i18n.t('errors.profileNotFoundMessage', { taskProfile: reusedTaskApiProfileName || i18n.t('common.unknownProfile'), currentProfile: preferredProfile.name }),
          confirmText: i18n.t('errors.useCurrentProfile'),
          cancelText: i18n.t('errors.abandonSubmit'),
          action: () => {
            void submitTask({ ...options, useCurrentApiProfileWhenReusedMissing: true })
          },
        })
        return
      }
    } else {
      preferredProfile = reusedProfile
    }
  }

  // Gallery generation must always run through Images API. If the current or
  // temporarily reused profile is an Agent/Responses profile, use its linked
  // imageProfileId first, then fall back to the first Images API profile.
  const activeProfile = resolveGalleryImageApiProfile(normalizedSettings, preferredProfile)
  if (!activeProfile) {
    showToast(i18n.t('errors.noImagesProfile'), 'error')
    useStore.getState().setShowSettings(true)
    return
  }
  const requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)

  const submitValidationOptions = { allowEmptyApiKey: canUseOAuthForProfile(activeProfile) }
  if (validateApiProfile(activeProfile, submitValidationOptions)) {
    showToast(i18n.t('errors.completeApiConfig', { detail: validateApiProfile(activeProfile, submitValidationOptions) }), 'error')
    useStore.getState().setShowSettings(true)
    return
  }

  if (!prompt.trim()) {
    showToast(i18n.t('errors.enterPrompt'), 'error')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: i18n.t('errors.fullMaskTitle'),
          message: i18n.t('errors.fullMaskMessage'),
          confirmText: i18n.t('errors.fullMaskConfirm'),
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  // 持久化输入图片到 IndexedDB（此前只在内存缓存中）
  for (const img of orderedInputImages) {
    await storeImage(img.dataUrl)
  }

  const normalizedParams = normalizeParamsForSettings(params, requestSettings, { hasInputImages: orderedInputImages.length > 0 })
  const shouldUseTransparentOutput = (normalizedParams.output_format === 'png' || normalizedParams.output_format === 'webp') && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const transparentMeta = taskParams.transparent_output && activeProfile.transparentBackgroundMethod === 'local'
    ? createTransparentOutputMeta(prompt.trim())
    : null
  const normalizedParamPatch = getChangedParams(params, taskParams)
  if (Object.keys(normalizedParamPatch).length) {
    useStore.getState().setParams(normalizedParamPatch)
  }

  const taskId = genId()
  const task: TaskRecord = {
    id: taskId,
    prompt: prompt.trim(),
    params: taskParams,
    apiProvider: activeProfile.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeProfile.name,
    apiMode: activeProfile.apiMode,
    apiModel: activeProfile.model,
    inputImageIds: orderedInputImages.map((i) => i.id),
    maskTargetImageId,
    maskImageId,
    transparentOutput: transparentMeta?.transparentOutput,
    transparentPrompt: transparentMeta?.effectivePrompt,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([task, ...latestTasks])
  await putTask(task)
  useStore.getState().showToast(i18n.t('toast.taskSubmitted'), 'success')

  useStore.getState().setPrompt('')
  useStore.getState().clearInputImages()
  useStore.getState().setReusedTaskApiProfile(null)

  // 异步调用 API
  executeTask(taskId)
}

function getActiveAgentConversation(): AgentConversation {
  const state = useStore.getState()
  const existing = state.agentConversations.find((conversation) => conversation.id === state.activeAgentConversationId)
  if (existing) return existing

  const id = state.createAgentConversation()
  return useStore.getState().agentConversations.find((conversation) => conversation.id === id)!
}

function updateAgentConversation(conversationId: string, updater: (conversation: AgentConversation) => AgentConversation) {
  useStore.setState((state) => ({
    agentConversations: state.agentConversations.map((conversation) =>
      conversation.id === conversationId ? updater(conversation) : conversation,
    ),
  }))
}

function getAgentRoundControllerKey(conversationId: string, roundId: string) {
  return `${conversationId}:${roundId}`
}

function getDeletedActiveAgentTasks(conversationId: string, roundId: string, controller: AbortController) {
  return Array.from(deletedActiveAgentTasks.values())
    .filter((entry) => entry.controller === controller && entry.task.agentConversationId === conversationId && entry.task.agentRoundId === roundId)
    .map((entry) => entry.task)
}

function createAgentAbortError() {
  return new DOMException(i18n.t('errors.agentStopped'), 'AbortError')
}

function createAgentRecoveryPauseError() {
  const err = new Error('Agent recovery paused')
  err.name = AGENT_RECOVERY_PAUSE_ERROR
  return err
}

function isAgentRecoveryPauseError(err: unknown) {
  return err instanceof Error && err.name === AGENT_RECOVERY_PAUSE_ERROR
}

function appendAgentStoppedMessage(content: string) {
  const trimmed = content.trimEnd()
  const stoppedText = i18n.t('agent.stopped')
  if (!trimmed) return stoppedText
  // 末尾已是当前语言的停止文案或历史值，则不再追加
  if (trimmed.endsWith(stoppedText)) return trimmed
  if (isAgentStoppedSentinel(trimmed)) return trimmed
  if (trimmed.endsWith('已停止生成。') || trimmed.endsWith('Generation stopped.')) return trimmed
  return `${trimmed}\n\n${stoppedText}`
}

function markAgentRoundTasksStopped(conversationId: string, roundId: string, now = Date.now()) {
  const runningTasks = useStore.getState().tasks.filter((task) =>
    (task.status === 'running' || task.customRecoverable) &&
    task.agentConversationId === conversationId &&
    task.agentRoundId === roundId,
  )

  for (const task of runningTasks) {
    clearCustomRecoveryTimer(task.id)
    updateTaskInStore(task.id, {
      ...createTaskErrorPatch(task, SENTINEL_AGENT_STOPPED, now),
      customRecoverable: false,
      elapsed: Math.max(0, now - task.createdAt),
    })
  }
  return runningTasks.length > 0
}

function markAgentRoundTasksFailed(
  conversationId: string,
  roundId: string,
  error: string,
  rawResponsePayload?: string,
  shouldFailTask: (task: TaskRecord) => boolean = () => true,
  now = Date.now(),
) {
  const runningTasks = useStore.getState().tasks.filter((task) =>
    task.status === 'running' &&
    task.agentConversationId === conversationId &&
    task.agentRoundId === roundId &&
    shouldFailTask(task),
  )

  for (const task of runningTasks) {
    useStore.getState().setTaskStreamPreview(task.id)
    updateTaskInStore(task.id, {
      ...createTaskErrorPatch(task, error, now),
      ...(rawResponsePayload ? { rawResponsePayload } : {}),
      customRecoverable: false,
      elapsed: Math.max(0, now - task.createdAt),
    })
  }
  return runningTasks.length > 0
}

function markAgentRoundStopped(conversationId: string, roundId: string) {
  const now = Date.now()
  const stoppedTasks = markAgentRoundTasksStopped(conversationId, roundId, now)
  let stoppedRound = false
  updateAgentConversation(conversationId, (current) => {
    const round = current.rounds.find((item) => item.id === roundId)
    if (!round || round.status !== 'running') return current

    stoppedRound = true
    const existingAssistantMessage = current.messages.find((message) => message.roundId === roundId && message.role === 'assistant')
    const assistantMessageId = existingAssistantMessage?.id ?? genId()
    return {
      ...current,
      updatedAt: now,
      rounds: current.rounds.map((item) =>
        item.id === roundId
          ? {
              ...item,
              ...(assistantMessageId ? { assistantMessageId } : {}),
              status: 'error',
              error: SENTINEL_AGENT_STOPPED,
              finishedAt: now,
            }
          : item,
      ),
      messages: existingAssistantMessage
        ? current.messages.map((message) =>
            message.id === existingAssistantMessage.id
              ? { ...message, content: appendAgentStoppedMessage(message.content) }
              : message,
          )
        : [
            ...current.messages,
            {
              id: assistantMessageId,
              role: 'assistant',
              content: i18n.t('agent.stopped'),
              roundId,
              createdAt: now,
            },
          ],
    }
  })
  return stoppedRound || stoppedTasks
}

function appendAgentAssistantMessageContent(conversationId: string, messageId: string, delta: string) {
  if (!delta) return
  updateAgentConversation(conversationId, (current) => ({
    ...current,
    updatedAt: Date.now(),
    messages: current.messages.map((message) =>
      message.id === messageId
        ? { ...message, content: `${message.content}${delta}` }
        : message,
    ),
  }))
}

async function generateAgentConversationTitle(
  conversationId: string,
  prompt: string,
  inputImageIds: string[],
  requestSettings: AppSettings,
  activeProfile: ApiProfile,
  fallbackTitle: string,
) {
  useStore.setState((state) => {
    const next = { ...state.agentGeneratingTitleIds, [conversationId]: true as const }
    return { agentGeneratingTitleIds: next }
  })
  try {
    const imageDataUrls = await readAgentImageDataUrls(inputImageIds)
    const title = await callAgentConversationTitleApi({
      settings: requestSettings,
      profile: activeProfile,
      prompt,
      imageDataUrls,
    })
    if (!title || title === fallbackTitle) return

    updateAgentConversation(conversationId, (current) => {
      const firstRound = current.rounds[0]
      if (!firstRound || firstRound.prompt !== prompt || current.title !== fallbackTitle) return current
      return { ...current, title, updatedAt: Date.now() }
    })
  } catch {
    // Title generation is best-effort; keep the local fallback title on failure.
  } finally {
    useStore.setState((state) => {
      const next = { ...state.agentGeneratingTitleIds }
      delete next[conversationId]
      return { agentGeneratingTitleIds: next }
    })
  }
}

export function stopAgentResponse(conversationId = useStore.getState().activeAgentConversationId) {
  if (!conversationId) return
  const conversation = useStore.getState().agentConversations.find((item) => item.id === conversationId)
  if (!conversation) return
  const activeRunningRound = [...getActiveAgentRounds(conversation)].reverse().find((round) => round.status === 'running')
  const runningRound = activeRunningRound ?? conversation.rounds.find((round) => round.status === 'running')
  if (!runningRound) return

  const controller = agentRoundControllers.get(getAgentRoundControllerKey(conversationId, runningRound.id))
  if (controller) {
    controller.abort()
    if (markAgentRoundStopped(conversationId, runningRound.id)) {
      useStore.getState().showToast(i18n.t('toast.stoppedGeneration'), 'info')
    }
    return
  }

  markAgentRoundStopped(conversationId, runningRound.id)
  useStore.getState().showToast(i18n.t('toast.stoppedGeneration'), 'info')
}

function addAgentReferencedImageIds(target: Set<string>, conversations = useStore.getState().agentConversations, inputDrafts = useStore.getState().agentInputDrafts) {
  for (const conversation of conversations) {
    for (const round of conversation.rounds) {
      for (const id of round.inputImageIds) target.add(id)
      if (round.maskImageId) target.add(round.maskImageId)
    }
    for (const message of conversation.messages) {
      if (message.maskImageId) target.add(message.maskImageId)
    }
  }
  for (const draft of Object.values(inputDrafts)) {
    for (const img of draft.inputImages) target.add(img.id)
  }
}

function addInputDraftReferencedImageIds(target: Set<string>, draft: AgentInputDraft | null) {
  if (!draft) return
  for (const img of draft.inputImages) target.add(img.id)
}

function addTaskReferencedImageIds(target: Set<string>, task: TaskRecord) {
  for (const id of task.inputImageIds || []) target.add(id)
  if (task.maskImageId) target.add(task.maskImageId)
  for (const id of task.outputImages || []) target.add(id)
  for (const id of task.transparentOriginalImages || []) {
    if (id) target.add(id)
  }
  for (const id of task.streamPartialImageIds || []) target.add(id)
}

async function storeTaskOutputImages(task: TaskRecord, images: string[]) {
  const outputIds: string[] = []
  const outputDataUrls: string[] = []
  const outputImageSizes: Array<{ width?: number; height?: number }> = []
  const transparentOriginalImageIds: string[] = []
  const storedImageIds: string[] = []

  try {
    for (const dataUrl of images) {
      let outputDataUrl = dataUrl
      if (task.transparentOutput) {
        const original = await storeImageWithSize(dataUrl, 'generated')
        storedImageIds.push(original.id)
        cacheImage(original.id, dataUrl)

        try {
          outputDataUrl = task.params.output_format === 'webp'
            ? await removeKeyedBackgroundFromDataUrl(dataUrl, undefined, 'webp', task.params.output_compression)
            : await removeKeyedBackgroundFromDataUrl(dataUrl)
          transparentOriginalImageIds.push(original.id)
        } catch (err) {
          console.warn(i18n.t("upstreamSync.transparencyProcessingFailedOriginalOutputRetained"), err)
          outputIds.push(original.id)
          outputDataUrls.push(dataUrl)
          outputImageSizes.push(original)
          transparentOriginalImageIds.push('')
          continue
        }
      }

      const stored = await storeImageWithSize(outputDataUrl, 'generated')
      storedImageIds.push(stored.id)
      cacheImage(stored.id, outputDataUrl)
      outputIds.push(stored.id)
      outputDataUrls.push(outputDataUrl)
      outputImageSizes.push(stored)
    }

    return {
      outputIds,
      outputDataUrls,
      outputImageSizes,
      transparentOriginalImageIds: transparentOriginalImageIds.length ? transparentOriginalImageIds : undefined,
    }
  } catch (err) {
    await deleteUnreferencedImageIds(storedImageIds)
    throw err
  }
}

async function deleteUnreferencedImageIds(imageIds: Iterable<string>) {
  const candidates = Array.from(new Set(Array.from(imageIds).filter(Boolean)))
  if (candidates.length === 0) return

  const { tasks, inputImages, galleryInputDraft } = useStore.getState()
  const stillUsed = new Set<string>()
  for (const task of tasks) addTaskReferencedImageIds(stillUsed, task)
  addAgentReferencedImageIds(stillUsed)
  addInputDraftReferencedImageIds(stillUsed, galleryInputDraft)
  for (const img of inputImages) stillUsed.add(img.id)

  for (const imgId of candidates) {
    if (stillUsed.has(imgId)) continue
    await deleteStoredImageIfUnreferenced(imgId)
  }
}

async function persistTaskStreamPartialImage(taskId: string, dataUrl: string) {
  try {
    const imgId = await storeImage(dataUrl, 'generated')
    cacheImage(imgId, dataUrl)

    const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
    if (!latestTask || latestTask.status === 'done') {
      await deleteUnreferencedImageIds([imgId])
      return
    }

    const currentIds = latestTask.streamPartialImageIds || []
    if (currentIds.includes(imgId)) return
    updateTaskInStore(taskId, { streamPartialImageIds: [...currentIds, imgId] })
  } catch (err) {
    console.error(err)
  }
}

async function readAgentImageDataUrls(ids: string[]) {
  const dataUrls: string[] = []
  for (const id of ids) {
    const dataUrl = await ensureImageCached(id)
    if (dataUrl) dataUrls.push(dataUrl)
  }
  return dataUrls
}

function scrubAgentOutputPayloadsForDeletedTasks(deletedTasks: TaskRecord[]) {
  const deletedByRound = new Map<string, TaskRecord[]>()
  const affectedConversationIds = new Set<string>()
  for (const task of deletedTasks) {
    if (task.sourceMode !== 'agent' || !task.agentConversationId || !task.agentRoundId) continue
    const key = getAgentRoundControllerKey(task.agentConversationId, task.agentRoundId)
    deletedByRound.set(key, [...(deletedByRound.get(key) ?? []), task])
    affectedConversationIds.add(task.agentConversationId)
  }
  if (deletedByRound.size === 0) return { updatedTasks: [], updatedConversations: [] }

  const updatedTasks: TaskRecord[] = []
  const updatedConversations: AgentConversation[] = []
  useStore.setState((state) => {
    const tasksByRound = new Map<string, TaskRecord[]>()
    for (const task of [...state.tasks, ...deletedTasks]) {
      if (!task.agentConversationId || !task.agentRoundId) continue
      const key = getAgentRoundControllerKey(task.agentConversationId, task.agentRoundId)
      if (!deletedByRound.has(key)) continue
      tasksByRound.set(key, [...(tasksByRound.get(key) ?? []), task])
    }
    const roundsByKey = new Map<string, AgentRound>()
    let conversationsChanged = false
    const agentConversations = state.agentConversations.map((conversation) => {
      if (!affectedConversationIds.has(conversation.id)) return conversation
      let changed = false
      const rounds = conversation.rounds.map((round) => {
        const key = getAgentRoundControllerKey(conversation.id, round.id)
        const roundDeletedTasks = deletedByRound.get(key)
        if (!roundDeletedTasks) return round
        roundsByKey.set(key, round)
        if (!round.responseOutput?.length) return round
        const responseOutput = scrubResponseOutputForDeletedAgentTasks(round, round.responseOutput, roundDeletedTasks, tasksByRound.get(key) ?? roundDeletedTasks)
        if (responseOutput === round.responseOutput) return round
        changed = true
        return { ...round, responseOutput }
      })
      if (!changed) return conversation
      conversationsChanged = true
      const updated = { ...conversation, rounds }
      updatedConversations.push(updated)
      return updated
    })
    const tasks = state.tasks.map((task) => {
      if (!task.agentConversationId || !task.agentRoundId) return task
      const key = getAgentRoundControllerKey(task.agentConversationId, task.agentRoundId)
      const roundDeletedTasks = deletedByRound.get(key)
      if (!roundDeletedTasks) return task
      const round = roundsByKey.get(key)
      if (!round) return task
      const scrubbed = scrubTaskRawResponsePayloadForDeletedTasks(task, round, roundDeletedTasks, tasksByRound.get(key) ?? roundDeletedTasks)
      if (scrubbed.rawResponsePayload === task.rawResponsePayload) return task
      updatedTasks.push(scrubbed)
      return scrubbed
    })
    if (!conversationsChanged && updatedTasks.length === 0) return state
    return {
      ...(conversationsChanged ? { agentConversations } : {}),
      ...(updatedTasks.length > 0 ? { tasks } : {}),
    }
  })
  return { updatedTasks, updatedConversations }
}

async function persistTaskDeletionCleanup(deletedTaskIds: string[], cleanup: ReturnType<typeof scrubAgentOutputPayloadsForDeletedTasks>) {
  const tasks = cleanup.updatedTasks.map(getPersistableTask)
  const conversations = cleanup.updatedConversations.map(getPersistableAgentConversation)
  try {
    await commitTaskDeletion(deletedTaskIds, tasks, conversations)
  } catch (err) {
    console.warn(i18n.t("upstreamSync.atomicTaskCleanupFailedPersistingItemsIndividually"), err)
    await Promise.all([
      ...deletedTaskIds.map((taskId) => dbDeleteTask(taskId)),
      ...tasks.map((task) => dbPutTask(task)),
      ...conversations.map((conversation) => dbPutAgentConversation(conversation)),
    ])
  }
}

function appendAgentRecoveredToolOutputs(conversationId: string, roundId: string, additions: ResponsesOutputItem[]) {
  updateAgentConversation(conversationId, (current) => ({
    ...current,
    updatedAt: Date.now(),
    rounds: current.rounds.map((round) => {
      if (round.id !== roundId) return round
      const output = round.responseOutput ?? []
      const existingOutputCallIds = getAgentFunctionOutputCallIds(output)
      const nextAdditions = additions.filter((item) => item.call_id && !existingOutputCallIds.has(item.call_id))
      return nextAdditions.length > 0
        ? { ...round, responseOutput: [...output, ...nextAdditions] }
        : round
    }),
  }))
}

async function continueRecoveredAgentRound(taskId: string) {
  const state = useStore.getState()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task?.agentConversationId || !task.agentRoundId) return

  const key = getAgentRoundControllerKey(task.agentConversationId, task.agentRoundId)
  if (agentRoundControllers.has(key) || agentRecoveryContinuations.has(key)) return

  agentRecoveryContinuations.add(key)
  try {
    const latestState = useStore.getState()
    const conversation = latestState.agentConversations.find((item) => item.id === task.agentConversationId)
    const round = conversation?.rounds.find((item) => item.id === task.agentRoundId)
    if (!conversation || !round || round.status === 'done' || round.error === SENTINEL_AGENT_STOPPED) return

    const failRound = (error: string) => {
      updateAgentConversation(conversation.id, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((currentRound) =>
          currentRound.id === round.id
            ? { ...currentRound, status: 'error', error, finishedAt: Date.now() }
            : currentRound,
        ),
      }))
    }

    const recovered = createReadyAgentRecoveredToolState(round, latestState.tasks)
    if (!recovered) return

    appendAgentRecoveredToolOutputs(conversation.id, round.id, recovered.additions)
    const updatedState = useStore.getState()
    const updatedConversation = updatedState.agentConversations.find((item) => item.id === conversation.id)
    const updatedRound = updatedConversation?.rounds.find((item) => item.id === round.id)
    if (!updatedConversation || !updatedRound) return

    if (!recovered.allSuccessful) {
      failRound(getAgentRecoveredFailureError(updatedRound, updatedState.tasks))
      return
    }

    const normalizedSettings = normalizeSettings(updatedState.settings)
    const agentValidationError = getAgentProfileValidationError(normalizedSettings)
    if (agentValidationError) {
      failRound(i18n.t('upstreamSync.message51', { value0: agentValidationError.message }))
      return
    }
    const activeProfile = getAgentTextApiProfile(normalizedSettings)
    const imageProfile = getAgentImageApiProfile(normalizedSettings)
    if (!activeProfile || !imageProfile) {
      failRound(i18n.t("upstreamSync.agentApiConfigurationMissingCannotResumeThisTask"))
      return
    }
    const roundTasks = updatedState.tasks.filter((item) => item.agentRoundId === round.id)
    const resumeParams = roundTasks.find((item) => item.params)?.params
      ?? normalizeParamsForSettings(updatedState.params, createSettingsForApiProfile(normalizedSettings, imageProfile), { hasInputImages: round.inputImageIds.length > 0 })
    const maxToolCalls = Number.isFinite(normalizedSettings.agentMaxToolRounds)
      ? Math.max(1, Math.trunc(normalizedSettings.agentMaxToolRounds))
      : DEFAULT_AGENT_MAX_TOOL_ROUNDS
    const toolCallsUsed = getAgentRecoveredToolCallCount(updatedRound.responseOutput ?? [], roundTasks)

    updateAgentConversation(conversation.id, (current) => ({
      ...current,
      updatedAt: Date.now(),
      rounds: current.rounds.map((currentRound) =>
        currentRound.id === round.id
          ? { ...currentRound, status: 'running', error: null, finishedAt: null }
          : currentRound,
      ),
    }))

    void executeAgentRound(
      conversation.id,
      round.id,
      resumeParams,
      createSettingsForApiProfile(normalizedSettings, activeProfile),
      activeProfile,
      imageProfile,
      {
        responseOutput: updatedRound.responseOutput ?? [],
        recoveredTaskIds: recovered.recoveredTaskIds,
        toolCallsUsed,
      },
    )
  } finally {
    agentRecoveryContinuations.delete(key)
  }
}

export async function submitAgentMessage() {
  const state = useStore.getState()
  const { settings, prompt, inputImages, maskDraft, params, showToast } = state
  const normalizedSettings = normalizeSettings(settings)
  const baseAgentProfile = getAgentTextApiProfile(normalizedSettings) ?? getActiveApiProfile(normalizedSettings)
  const activeProfile = createAgentResponsesApiProfile(baseAgentProfile)
  const imageProfile = getAgentImageApiProfile(normalizedSettings) ?? baseAgentProfile
  const agentValidationError = getAgentProfileValidationError(normalizedSettings)
  const supportsResponsesApi = activeProfile.provider === 'openai' && (
    activeProfile.apiMode === 'responses' ||
    canUseOAuthForProfile({ ...activeProfile, apiMode: 'responses' })
  )

  if (agentValidationError && !supportsResponsesApi) {
    showToast(i18n.t('upstreamSync.message52', { value0: agentValidationError.message }), 'error')
    state.setShowSettings(true, normalizedSettings.agentApiConfigMode === 'off' ? 'api' : 'agent')
    return
  }

  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) {
    showToast(i18n.t('errors.enterMessage'), 'error')
    return
  }

  const conversation = getActiveAgentConversation()
  if (conversation.rounds.some((round) => round.status === 'running')) {
    showToast(i18n.t('errors.waitOrStop'), 'info')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        state.clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  const inputImageIds = uniqueIds(orderedInputImages.map((image) => image.id))

  for (const image of orderedInputImages) {
    await storeImage(image.dataUrl)
  }

  const requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  const imageRequestSettings = createSettingsForApiProfile(normalizedSettings, imageProfile)
  const now = Date.now()
  const editingRound = state.agentEditingRoundId
    ? conversation.rounds.find((item) => item.id === state.agentEditingRoundId) ?? null
    : null
  const editingRoundAssistantMessage = editingRound?.assistantMessageId
    ? conversation.messages.find((message) => message.id === editingRound.assistantMessageId) ?? null
    : conversation.messages.find((message) => message.roundId === editingRound?.id && message.role === 'assistant') ?? null
  const editingRoundHasAssistantMessage = Boolean(editingRoundAssistantMessage)
  const editingRoundHasErrorAssistantMessage = Boolean(
    editingRound?.status === 'error' && startsWithAgentErrorPrefix(editingRoundAssistantMessage?.content),
  )
  const editingRoundHasChildren = editingRound
    ? conversation.rounds.some((round) => (round.parentRoundId ?? null) === editingRound.id)
    : false
  const shouldAppendToEditingRound = Boolean(
    editingRound && !editingRoundHasChildren && (!editingRoundHasAssistantMessage || editingRoundHasErrorAssistantMessage),
  )
  const roundId = shouldAppendToEditingRound && editingRound ? editingRound.id : genId()
  const userMessageId = shouldAppendToEditingRound && editingRound ? editingRound.userMessageId : genId()
  const activeRounds = getActiveAgentRounds(conversation)
  const activeLeafId = activeRounds[activeRounds.length - 1]?.id ?? null
  const parentRoundId = editingRound ? editingRound.parentRoundId ?? null : activeLeafId
  const parentPath = parentRoundId ? getAgentRoundPath(conversation, parentRoundId) : []
  const normalizedParams = {
    ...normalizeParamsForSettings(params, imageRequestSettings, { hasInputImages: inputImageIds.length > 0 }),
    n: DEFAULT_PARAMS.n,
    transparent_output: false,
  }
  const round: AgentRound = {
    id: roundId,
    index: shouldAppendToEditingRound && editingRound ? editingRound.index : parentPath.length + 1,
    parentRoundId,
    ...(editingRoundHasErrorAssistantMessage && editingRoundAssistantMessage ? { assistantMessageId: editingRoundAssistantMessage.id } : {}),
    userMessageId,
    prompt: trimmedPrompt,
    inputImageIds,
    maskTargetImageId,
    maskImageId,
    outputTaskIds: [],
    status: 'running',
    error: null,
    createdAt: now,
    finishedAt: null,
  }
  const userMessage: AgentMessage = {
    id: userMessageId,
    role: 'user',
    content: trimmedPrompt,
    roundId,
    inputImageIds,
    maskTargetImageId,
    maskImageId,
    createdAt: now,
  }

  let fallbackTitle: string | null = null
  updateAgentConversation(conversation.id, (current) => {
    const nextTitle = current.rounds.length === 0 ? createAgentConversationTitle(trimmedPrompt, current.title) : current.title
    if (current.rounds.length === 0) fallbackTitle = nextTitle
    const messages = shouldAppendToEditingRound
      ? current.messages.some((message) => message.id === userMessageId)
        ? current.messages.map((message) => {
            if (message.id === userMessageId) return userMessage
            if (editingRoundHasErrorAssistantMessage && message.id === editingRoundAssistantMessage?.id) {
              return { ...message, content: '', outputTaskIds: [] }
            }
            return message
          })
        : [...current.messages, userMessage]
      : [...current.messages, userMessage]

    return {
      ...current,
      title: nextTitle,
      activeRoundId: roundId,
      updatedAt: now,
      rounds: shouldAppendToEditingRound
        ? current.rounds.map((item) => item.id === roundId ? round : item)
        : [...current.rounds, round],
      messages,
    }
  })

  state.setPrompt('')
  state.clearInputImages()
  state.clearMaskDraft()
  state.setAgentEditingRoundId(null)

  if (fallbackTitle) {
    void generateAgentConversationTitle(conversation.id, trimmedPrompt, inputImageIds, requestSettings, activeProfile, fallbackTitle)
  }

  void executeAgentRound(conversation.id, roundId, normalizedParams, requestSettings, activeProfile, imageProfile)
}

export async function regenerateAgentAssistantMessage(conversationId: string, roundId: string) {
  const state = useStore.getState()
  const { settings, params, showToast } = state
  const normalizedSettings = normalizeSettings(settings)

  const agentValidationError = getAgentProfileValidationError(normalizedSettings)
  if (agentValidationError) {
    showToast(i18n.t('upstreamSync.message52', { value0: agentValidationError.message }), 'error')
    state.setShowSettings(true, normalizedSettings.agentApiConfigMode === 'off' ? 'api' : 'agent')
    return
  }

  const baseAgentProfile = getAgentTextApiProfile(normalizedSettings)!
  const activeProfile = createAgentResponsesApiProfile(baseAgentProfile)
  const imageProfile = getAgentImageApiProfile(normalizedSettings) ?? baseAgentProfile

  const conversation = state.agentConversations.find((item) => item.id === conversationId)
  const sourceRound = conversation?.rounds.find((item) => item.id === roundId) ?? null
  const sourceUserMessage = sourceRound
    ? conversation?.messages.find((message) => message.id === sourceRound.userMessageId) ?? null
    : null
  if (!conversation || !sourceRound || !sourceUserMessage) {
    showToast(i18n.t('errors.agentMessageNotFound'), 'error')
    return
  }

  if (conversation.rounds.some((round) => round.status === 'running')) {
    showToast(i18n.t('errors.waitOrStop'), 'info')
    return
  }

  const inputImageIds = uniqueIds(sourceRound.inputImageIds)
  const requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  const imageRequestSettings = createSettingsForApiProfile(normalizedSettings, imageProfile)
  const normalizedParams = {
    ...normalizeParamsForSettings(params, imageRequestSettings, { hasInputImages: inputImageIds.length > 0 }),
    n: DEFAULT_PARAMS.n,
    transparent_output: false,
  }
  const now = Date.now()
  if (sourceRound.status === 'error') {
    const assistantMessageId = sourceRound.assistantMessageId
      ?? conversation.messages.find((message) => message.roundId === sourceRound.id && message.role === 'assistant')?.id
    updateAgentConversation(conversationId, (current) => ({
      ...current,
      activeRoundId: sourceRound.id,
      updatedAt: now,
      rounds: current.rounds.map((round) =>
        round.id === sourceRound.id
          ? {
              ...round,
              outputTaskIds: [],
              responseId: undefined,
              responseOutput: undefined,
              status: 'running',
              error: null,
              finishedAt: null,
            }
          : round,
      ),
      messages: assistantMessageId
        ? current.messages.map((message) =>
            message.id === assistantMessageId ? { ...message, content: '', outputTaskIds: [] } : message,
          )
        : current.messages,
    }))
    state.setAgentEditingRoundId(null)
    void executeAgentRound(conversationId, sourceRound.id, normalizedParams, requestSettings, activeProfile, imageProfile)
    return
  }

  const newRoundId = genId()
  const newUserMessageId = genId()
  const newRound: AgentRound = {
    id: newRoundId,
    index: sourceRound.index,
    parentRoundId: sourceRound.parentRoundId ?? null,
    userMessageId: newUserMessageId,
    prompt: sourceRound.prompt || sourceUserMessage.content.trim(),
    inputImageIds,
    maskTargetImageId: sourceRound.maskTargetImageId ?? sourceUserMessage.maskTargetImageId ?? null,
    maskImageId: sourceRound.maskImageId ?? sourceUserMessage.maskImageId ?? null,
    outputTaskIds: [],
    status: 'running',
    error: null,
    createdAt: now,
    finishedAt: null,
  }
  const newUserMessage: AgentMessage = {
    id: newUserMessageId,
    role: 'user',
    content: sourceUserMessage.content,
    roundId: newRoundId,
    inputImageIds,
    maskTargetImageId: sourceRound.maskTargetImageId ?? sourceUserMessage.maskTargetImageId ?? null,
    maskImageId: sourceRound.maskImageId ?? sourceUserMessage.maskImageId ?? null,
    createdAt: now,
  }

  updateAgentConversation(conversationId, (current) => ({
    ...current,
    activeRoundId: newRoundId,
    updatedAt: now,
    rounds: [...current.rounds, newRound],
    messages: [...current.messages, newUserMessage],
  }))
  state.setAgentEditingRoundId(null)
  void executeAgentRound(conversationId, newRoundId, normalizedParams, requestSettings, activeProfile, imageProfile)
}

async function executeAgentRound(
  conversationId: string,
  roundId: string,
  params: TaskParams,
  requestSettings: AppSettings,
  activeProfile: ApiProfile,
  imageProfile: ApiProfile,
  resume?: { responseOutput: ResponsesOutputItem[]; recoveredTaskIds: string[]; toolCallsUsed: number },
) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const controllerKey = getAgentRoundControllerKey(conversationId, roundId)
  agentRoundControllers.set(controllerKey, controller)
  try {
    const latestState = useStore.getState()
    const conversation = latestState.agentConversations.find((item) => item.id === conversationId)
    if (!conversation) return
    const round = conversation.rounds.find((item) => item.id === roundId)
    const userMessage = round ? conversation.messages.find((message) => message.id === round.userMessageId) : null
    if (!round || !userMessage) return
    const maskDataUrl = round.maskImageId ? await ensureImageCached(round.maskImageId) : undefined
    if (round.maskImageId && !maskDataUrl) throw new Error(i18n.t('errors.maskImageMissing'))

    const appManagedImageProfile = resolveGalleryImageApiProfile(requestSettings, activeProfile)
    const shouldRunImageCallsWithGalleryApi = Boolean(appManagedImageProfile) || isSakrylleApiBaseUrl(activeProfile.baseUrl)

    const apiInput = await buildAgentApiInput({
      conversation,
      currentRound: round,
      tasks: latestState.tasks,
      loadImage: ensureImageCached,
    })
    if (controller.signal.aborted) throw createAgentAbortError()
    const existingAssistantMessage = round.assistantMessageId
      ? conversation.messages.find((message) => message.id === round.assistantMessageId) ?? null
      : conversation.messages.find((message) => message.roundId === roundId && message.role === 'assistant') ?? null
    const assistantMessageId = existingAssistantMessage?.id ?? genId()
    const resumedAssistantContent = resume ? existingAssistantMessage?.content.trim() ?? '' : ''
    const shouldStreamAssistantMessage = activeProfile.streamImages === true
    const imageRequestSettings = createSettingsForApiProfile(requestSettings, imageProfile)
    const imageParams = normalizeParamsForSettings(params, imageRequestSettings, { hasInputImages: round.inputImageIds.length > 0 })
    const streamingTaskIds: string[] = resume ? [...round.outputTaskIds] : []
    const taskIdByToolCallId = new Map<string, string>()
    const taskByToolCallId = new Map<string, TaskRecord>()

    const getDeletedAgentTasks = () => {
      const deletedTasks = getDeletedActiveAgentTasks(conversationId, roundId, controller)
      const deletedTaskIds = new Set(deletedTasks.map((task) => task.id))
      const currentTaskIds = new Set(useStore.getState().tasks.map((task) => task.id))
      for (const [toolCallId, taskId] of taskIdByToolCallId) {
        const task = taskByToolCallId.get(toolCallId)
        if (task && !currentTaskIds.has(taskId) && !deletedTaskIds.has(taskId)) deletedTasks.push(task)
      }
      return deletedTasks
    }
    const getLatestRound = () => useStore.getState().agentConversations
      .find((item) => item.id === conversationId)
      ?.rounds.find((item) => item.id === roundId)

    const attachTaskToAgentRound = (taskId: string) => {
      if (streamingTaskIds.includes(taskId)) return
      streamingTaskIds.push(taskId)
      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) =>
          item.id === roundId
            ? { ...item, outputTaskIds: item.outputTaskIds.includes(taskId) ? item.outputTaskIds : [...item.outputTaskIds, taskId] }
            : item,
        ),
        messages: current.messages.map((message) =>
          message.id === assistantMessageId
            ? { ...message, outputTaskIds: [...new Set([...(message.outputTaskIds ?? []), taskId])] }
            : message,
        ),
      }))
    }

    const ensureStreamingAgentTask = async (
      toolCallId: string,
      taskPrompt = '',
      inputImageIds = round.inputImageIds ?? [],
      options: { createdAt?: number; agentBatchCallId?: string; agentBatchItemId?: string; maskTargetImageId?: string | null; maskImageId?: string | null; apiProfile?: ApiProfile | null; taskParams?: TaskParams } = {},
    ) => {
      const existingTaskId = taskIdByToolCallId.get(toolCallId)
      if (existingTaskId) return existingTaskId

      const existingTask = useStore.getState().tasks.find((task) => task.agentToolCallId === toolCallId)
      if (existingTask) {
        taskIdByToolCallId.set(toolCallId, existingTask.id)
        taskByToolCallId.set(toolCallId, existingTask)
        attachTaskToAgentRound(existingTask.id)
        return existingTask.id
      }

      const taskProfile = options.apiProfile ?? activeProfile
      const task: TaskRecord = {
        id: genId(),
        prompt: taskPrompt,
        params: options.taskParams ?? { ...imageParams, n: 1 },
        apiProvider: taskProfile.provider,
        apiProfileId: taskProfile.id,
        apiProfileName: taskProfile.name,
        apiMode: taskProfile.apiMode,
        apiModel: taskProfile.model,
        inputImageIds,
        maskTargetImageId: options.maskTargetImageId !== undefined ? options.maskTargetImageId : round.maskTargetImageId ?? null,
        maskImageId: options.maskImageId !== undefined ? options.maskImageId : round.maskImageId ?? null,
        outputImages: [],
        status: 'running',
        error: null,
        createdAt: options.createdAt ?? Date.now(),
        finishedAt: null,
        elapsed: null,
        sourceMode: 'agent',
        agentConversationId: conversationId,
        agentRoundId: roundId,
        agentMessageId: assistantMessageId,
        agentToolCallId: toolCallId,
        ...(options.agentBatchCallId ? { agentBatchCallId: options.agentBatchCallId } : {}),
        ...(options.agentBatchItemId ? { agentBatchItemId: options.agentBatchItemId } : {}),
      }

      taskIdByToolCallId.set(toolCallId, task.id)
      taskByToolCallId.set(toolCallId, task)
      useStore.getState().setTasks([task, ...useStore.getState().tasks])
      attachTaskToAgentRound(task.id)
      await putTask(task)
      return task.id
    }

    const completeAgentImageTask = async (image: AgentApiResultImage, rawResponsePayload?: string) => {
      const toolCallId = image.toolCallId ?? genId()
      const taskId = await ensureStreamingAgentTask(toolCallId)
      const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
      if (latestTask?.status === 'done' && latestTask.outputImages.length > 0) return { taskId, committed: true }

      const stored = await storeImageWithSize(image.dataUrl, 'generated')
      cacheImage(stored.id, image.dataUrl)
      const latestBeforeUpdate = useStore.getState().tasks.find((task) => task.id === taskId)
      if (!latestBeforeUpdate) {
        await deleteUnreferencedImageIds([stored.id])
        return { taskId, committed: false }
      }
      const actualParams = deriveAgentImageActualParams(image.actualParams, stored)
      updateTaskInStore(taskId, {
        prompt: image.revisedPrompt ?? latestBeforeUpdate.prompt,
        outputImages: [stored.id],
        actualParams,
        actualParamsByImage: { [stored.id]: actualParams },
        revisedPromptByImage: image.revisedPrompt ? { [stored.id]: image.revisedPrompt } : undefined,
        rawResponsePayload,
        ...createTaskDonePatch(latestBeforeUpdate, Date.now()),
        agentToolAction: image.action,
      })
      useStore.getState().setTaskStreamPreview(taskId)
      return { taskId, committed: true }
    }

    const failAgentImageTask = (toolCallId: string, error: string, rawResponsePayload?: string) => {
      const taskId = taskIdByToolCallId.get(toolCallId)
      if (!taskId) return
      const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
      if (!latestTask || latestTask.status !== 'running') return

      useStore.getState().setTaskStreamPreview(taskId)
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(latestTask, error, Date.now()),
        rawResponsePayload,
        customRecoverable: false,
      })
    }

    const pauseAgentImageTaskForRecovery = (toolCallId: string, err: unknown) => {
      const taskId = taskIdByToolCallId.get(toolCallId)
      if (!taskId || !isNetworkRecoverableError(err)) return false
      const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
      if (!latestTask || latestTask.status !== 'running') return false

      if (latestTask.customTaskId) {
        useStore.getState().setTaskStreamPreview(taskId)
        updateTaskInStore(taskId, {
          ...createTaskErrorPatch(latestTask, i18n.t("upstreamSync.connectionToTheAsyncTaskWasLostResult"), Date.now()),
          customRecoverable: true,
        })
        scheduleCustomRecovery(taskId)
        return true
      }

      return false
    }

    if (shouldStreamAssistantMessage) {
      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) =>
          item.id === roundId ? { ...item, assistantMessageId } : item,
        ),
        messages: current.messages.some((message) => message.id === assistantMessageId)
          ? current.messages.map((message) => message.id === assistantMessageId
            ? resume
              ? { ...message, outputTaskIds: [...new Set([...(message.outputTaskIds ?? []), ...round.outputTaskIds])] }
              : { ...message, content: '', outputTaskIds: [] }
            : message)
          : [
              ...current.messages,
              {
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                roundId,
                createdAt: Date.now(),
              },
            ],
      }))
    }
    const maxToolCalls = Number.isFinite(requestSettings.agentMaxToolRounds)
      ? Math.max(1, Math.trunc(requestSettings.agentMaxToolRounds))
      : DEFAULT_AGENT_MAX_TOOL_ROUNDS
    let accumulatedOutputItems: ResponsesOutputItem[] = resume?.responseOutput ?? []
    let accumulatedText = resumedAssistantContent
    const textSegments: string[] = resumedAssistantContent ? [resumedAssistantContent] : []
    let lastResponseId: string | undefined = round.responseId
    let toolCallsUsed = resume?.toolCallsUsed ?? 0
    let apiInputForTurn = apiInput
    if (resume) {
      const resumeState = useStore.getState()
      apiInputForTurn = await buildAgentContinuationInput({
        baseInput: apiInput,
        currentRound: round,
        tasks: resumeState.tasks,
        currentRoundOutput: accumulatedOutputItems,
        batchTaskIds: resume.recoveredTaskIds,
        toolCallsUsed,
        maxToolCalls,
        loadImage: ensureImageCached,
      })
    }
    let reachedToolLimit = resume ? toolCallsUsed >= maxToolCalls : false
    let pendingToolTextSeparator = false
    // Helper: resolve reference image ids to data URLs for batch image calls
    const resolveReferenceImages = async (referenceIds: string[]): Promise<{ dataUrls: string[]; imageIds: string[] }> => {
      const dataUrls: string[] = []
      const imageIds: string[] = []
      for (const refId of referenceIds) {
        // Resolve both generated image refs and current/user input refs from XML tags.
        const latestConv = useStore.getState().agentConversations.find((item) => item.id === conversationId)
        if (!latestConv) continue
        for (const r of getAgentRoundPath(latestConv, roundId)) {
          for (let imgIdx = 0; imgIdx < r.inputImageIds.length; imgIdx++) {
            const currentRefId = getAgentCurrentReferenceId(r, imgIdx)
            if (currentRefId === refId) {
              const imageId = r.inputImageIds[imgIdx]
              const dataUrl = await ensureImageCached(imageId)
              if (dataUrl) dataUrls.push(dataUrl)
              imageIds.push(imageId)
            }
          }
          const outputImages = collectAgentRoundOutputImageSlots(r, useStore.getState().tasks)
          for (let imgIdx = 0; imgIdx < outputImages.length; imgIdx++) {
            const generatedRefId = getAgentGeneratedImageReferenceId(r, imgIdx)
            if (generatedRefId === refId) {
              const imageId = outputImages[imgIdx]
              if (!imageId) continue
              const dataUrl = await ensureImageCached(imageId)
              if (dataUrl) dataUrls.push(dataUrl)
              imageIds.push(imageId)
            }
          }
        }
      }
      return { dataUrls, imageIds }
    }

    const markAgentImageTaskError = (toolCallId: string | undefined, error: string) => {
      if (!toolCallId) return
      const taskId = taskIdByToolCallId.get(toolCallId)
      if (!taskId) return
      const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
      if (latestTask?.status === 'done') return
      updateTaskInStore(taskId, {
        status: 'error',
        error,
        finishedAt: Date.now(),
        elapsed: Date.now() - (latestTask?.createdAt ?? startedAt),
      })
    }

    const parseSingleImageCallArguments = (args: string): { id: string; prompt: string } | null => {
      try {
        const parsed = JSON.parse(args) as Record<string, unknown>
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
        if (!prompt) return null
        const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : 'image'
        return { id, prompt }
      } catch {
        return null
      }
    }

    const callHybridImageApiSingle = async (opts: {
      taskId: string
      prompt: string
      referenceImageDataUrls: string[]
      taskParams: TaskParams
      signal: AbortSignal
      onPartialImage?: (event: { image: string; partialImageIndex?: number }) => void | Promise<void>
    }) => {
      const result = await callImageApi({
        settings: imageRequestSettings,
        prompt: replaceImageMentionsForApi(opts.prompt, opts.referenceImageDataUrls.length),
        params: opts.taskParams,
        inputImageDataUrls: opts.referenceImageDataUrls,
        skipCodexCliSizePrompt: true,
        onPartialImage: opts.onPartialImage
          ? (partial) => {
              void opts.onPartialImage?.({ image: partial.image, partialImageIndex: partial.partialImageIndex ?? partial.requestIndex })
            }
          : undefined,
        onCustomTaskEnqueued: (request) => {
          updateTaskInStore(opts.taskId, {
            customTaskId: request.taskId,
            customRecoverable: false,
          })
        },
      })
      if (opts.signal.aborted) throw createAgentAbortError()
      const dataUrl = result.images[0]
      return {
        image: dataUrl ? {
          dataUrl,
          actualParams: result.actualParamsList?.[0] ?? result.actualParams,
          revisedPrompt: result.revisedPrompts?.[0] ?? opts.prompt,
        } satisfies AgentApiResultImage : null,
        error: result.failedRequests?.[0]?.error ?? (dataUrl ? null : i18n.t("errors.imagePayloadMissing")),
        rawResponsePayload: JSON.stringify({
          imageCount: result.images.length,
          actualParams: result.actualParams,
          actualParamsList: result.actualParamsList,
          revisedPrompts: result.revisedPrompts,
          rawImageUrls: result.rawImageUrls,
          failedRequests: result.failedRequests,
        }, null, 2),
      }
    }

    const executeSingleImageFunctionCall = async (functionCallItem: ResponsesOutputItem): Promise<string | null> => {
      const callId = functionCallItem.call_id ?? ''
      const item = parseSingleImageCallArguments(functionCallItem.arguments ?? '')
      if (!item) return JSON.stringify({ error: 'Invalid or empty image arguments' })

      const referenceIds = uniqueIds(extractAgentReferenceIds(item.prompt))
      const references = await resolveReferenceImages(referenceIds)
      const toolCallId = callId || genId()
      const taskParams = {
        ...normalizeParamsForSettings(imageParams, imageRequestSettings, { hasInputImages: references.dataUrls.length > 0 }),
        n: 1,
      }

      const taskId = await ensureStreamingAgentTask(toolCallId, item.prompt, references.imageIds, {
        createdAt: Date.now(),
        taskParams,
        maskTargetImageId: null,
        maskImageId: null,
      })

      try {
        const result = await callHybridImageApiSingle({
          taskId,
          prompt: item.prompt,
          referenceImageDataUrls: references.dataUrls,
          taskParams,
          signal: controller.signal,
          onPartialImage: async ({ image, partialImageIndex }) => {
            if (controller.signal.aborted) return
            const taskId = taskIdByToolCallId.get(toolCallId)
            if (taskId) {
              useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
              if (partialImageIndex === 0 || partialImageIndex == null) void persistTaskStreamPartialImage(taskId, image)
            }
          },
        })

        if (controller.signal.aborted) throw createAgentAbortError()
        if (result.image) {
          const completed = await completeAgentImageTask({ ...result.image, toolCallId }, result.rawResponsePayload)
          if (completed.committed) {
            toolCallsUsed += 1
            return JSON.stringify({ id: item.id, status: 'done' })
          }
          return null
        }

        failAgentImageTask(toolCallId, result.error!, result.rawResponsePayload)
        return JSON.stringify({ id: item.id, status: 'error', error: result.error })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        if (controller.signal.aborted) throw createAgentAbortError()
        if (pauseAgentImageTaskForRecovery(toolCallId, err)) throw createAgentRecoveryPauseError()
        failAgentImageTask(toolCallId, error)
        return JSON.stringify({ id: item.id, status: 'error', error })
      }
    }

    const executeImageGenerationCallWithGalleryApi = async (item: ResponsesOutputItem): Promise<BatchImageCallResult> => {
      const toolCallId = getImageGenerationCallId(item)
      const prompt = getImageGenerationCallPrompt(item, round?.prompt ?? userMessage.content)
      const referenceIds = uniqueIds(extractAgentReferenceIds(prompt))
      const references = await resolveReferenceImages(referenceIds)

      await ensureStreamingAgentTask(toolCallId, prompt, references.imageIds, {
        createdAt: Date.now(),
        maskTargetImageId: null,
        maskImageId: null,
        apiProfile: appManagedImageProfile,
      })

      const result = await callBatchImageSingle({
        profile: activeProfile,
        allProfiles: requestSettings.profiles,
        params,
        batchItemId: toolCallId,
        prompt,
        referenceImageDataUrls: references.dataUrls,
        referenceIds,
        signal: controller.signal,
        onImageToolStarted: shouldStreamAssistantMessage
          ? async () => {
              if (controller.signal.aborted) return
            }
          : undefined,
        onPartialImage: shouldStreamAssistantMessage
          ? async ({ image, partialImageIndex }) => {
              if (controller.signal.aborted) return
              const taskId = taskIdByToolCallId.get(toolCallId)
              if (taskId) {
                useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
                if (partialImageIndex === 0 || partialImageIndex == null) {
                  void persistTaskStreamPartialImage(taskId, image)
                }
              }
            }
          : undefined,
        onImageToolCompleted: shouldStreamAssistantMessage
          ? async (image) => {
              if (controller.signal.aborted) return
              await completeAgentImageTask({ ...image, toolCallId })
            }
          : undefined,
      })

      if (result.image && !shouldStreamAssistantMessage) {
        await completeAgentImageTask({ ...result.image, toolCallId }, result.rawResponsePayload)
      } else if (!result.image && result.error) {
        markAgentImageTaskError(toolCallId, result.error)
      }

      return result
    }

    // Helper: execute a generate_image_batch function call concurrently
    const executeBatchFunctionCall = async (functionCallItem: ResponsesOutputItem): Promise<string> => {
      const callId = functionCallItem.call_id ?? ''
      const args = functionCallItem.arguments ?? ''
      const batchItems = parseBatchImageCallArguments(args)

      if (!batchItems || batchItems.length === 0) {
        return JSON.stringify({ error: 'Invalid or empty batch arguments' })
      }

      // Create task cards in model-provided order before starting network calls.
      const batchExecutionItems = []
      for (const item of batchItems) {
        const referenceIds = uniqueIds(extractAgentReferenceIds(item.prompt))
        const references = await resolveReferenceImages(referenceIds)
        const batchToolCallId = genId()
        const taskParams = requestSettings.agentApiConfigMode === 'hybrid'
          ? {
              ...normalizeParamsForSettings(imageParams, imageRequestSettings, { hasInputImages: references.dataUrls.length > 0 }),
              n: 1,
            }
          : { ...imageParams, n: 1 }
        await ensureStreamingAgentTask(batchToolCallId, item.prompt, references.imageIds, {
          createdAt: Date.now(),
          taskParams,
          maskTargetImageId: null,
          maskImageId: null,
          apiProfile: appManagedImageProfile,
          ...(callId ? { agentBatchCallId: callId } : {}),
          agentBatchItemId: item.id,
        })
        batchExecutionItems.push({ item, batchToolCallId, references, referenceIds, taskParams })
      }

      // Fire all batch items concurrently after all cards are visible.
      const batchPromises = batchExecutionItems.map(async ({ item, batchToolCallId, references, referenceIds, taskParams }) => {
        let committed = false
        const batchResult = requestSettings.agentApiConfigMode === 'hybrid'
          ? {
              batchItemId: item.id,
              ...(await callHybridImageApiSingle({
                taskId: taskIdByToolCallId.get(batchToolCallId)!,
                prompt: item.prompt,
                referenceImageDataUrls: references.dataUrls,
                taskParams,
                signal: controller.signal,
                onPartialImage: shouldStreamAssistantMessage
                  ? async ({ image, partialImageIndex }) => {
                      if (controller.signal.aborted) return
                      const taskId = taskIdByToolCallId.get(batchToolCallId)
                      if (taskId) {
                        useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
                        if (partialImageIndex === 0 || partialImageIndex == null) {
                          void persistTaskStreamPartialImage(taskId, image)
                        }
                      }
                    }
                  : undefined,
              })),
            }
          : await callBatchImageSingle({
              profile: imageProfile,
              allProfiles: requestSettings.profiles,
              params: taskParams,
              batchItemId: item.id,
              prompt: item.prompt,
              referenceImageDataUrls: references.dataUrls,
              referenceIds,
              allowPromptRewrite: requestSettings.allowPromptRewrite,
              signal: controller.signal,
              onImageToolStarted: shouldStreamAssistantMessage
                ? async () => {
                    if (controller.signal.aborted) return
                  }
                : undefined,
              onPartialImage: shouldStreamAssistantMessage
                ? async ({ image, partialImageIndex }) => {
                    if (controller.signal.aborted) return
                    const taskId = taskIdByToolCallId.get(batchToolCallId)
                    if (taskId) {
                      useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
                      if (partialImageIndex === 0 || partialImageIndex == null) {
                        void persistTaskStreamPartialImage(taskId, image)
                      }
                    }
                  }
                : undefined,
              onImageToolCompleted: shouldStreamAssistantMessage
                ? async (image) => {
                    if (controller.signal.aborted) return
                    committed = (await completeAgentImageTask({ ...image, toolCallId: batchToolCallId })).committed
                  }
                : undefined,
            })

        if (controller.signal.aborted) throw createAgentAbortError()
        // If not streaming and we have an image, complete the pre-created task.
        if (batchResult.image && (requestSettings.agentApiConfigMode === 'hybrid' || !shouldStreamAssistantMessage)) {
          committed = (await completeAgentImageTask({ ...batchResult.image, toolCallId: batchToolCallId }, batchResult.rawResponsePayload)).committed
        }

        const latestTask = useStore.getState().tasks.find((task) => task.id === taskIdByToolCallId.get(batchToolCallId))
        return { ...batchResult, committed: committed || Boolean(latestTask?.status === 'done' && latestTask.outputImages.length > 0) }
      })

      const batchResults = await Promise.allSettled(batchPromises)
      if (controller.signal.aborted) throw createAgentAbortError()

      // Build function_call_output
      const outputImages: Array<{ id: string; status: string; error?: string }> = []
      let pausedForRecovery = false
      for (let i = 0; i < batchItems.length; i++) {
        const settled = batchResults[i]
        const batchItem = batchItems[i]
        const taskId = taskIdByToolCallId.get(batchExecutionItems[i].batchToolCallId)
        if (!taskId || !useStore.getState().tasks.some((task) => task.id === taskId)) continue
        if (settled.status === 'fulfilled') {
          const r = settled.value
          if (r.image && !r.committed) continue
          if (!r.image) {
            failAgentImageTask(batchExecutionItems[i].batchToolCallId, r.error!, r.rawResponsePayload)
          }
          outputImages.push({
            id: r.batchItemId,
            status: r.image ? 'done' : 'error',
            ...(r.error ? { error: r.error } : {}),
          })
        } else {
          const error = settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
          if (isAgentRecoveryPauseError(settled.reason) || pauseAgentImageTaskForRecovery(batchExecutionItems[i].batchToolCallId, settled.reason)) {
            pausedForRecovery = true
            continue
          }
          failAgentImageTask(batchExecutionItems[i].batchToolCallId, error)
          outputImages.push({
            id: batchItem.id,
            status: 'error',
            error,
          })
        }
      }
      if (pausedForRecovery) throw createAgentRecoveryPauseError()

      const successCount = outputImages.filter((img) => img.status === 'done').length
      toolCallsUsed += successCount

      return JSON.stringify({ images: outputImages })
    }

    while (true) {
      if (controller.signal.aborted) throw createAgentAbortError()
      if (reachedToolLimit) break
      const textBeforeResponse = accumulatedText
      let currentResponseOutputItems: ResponsesOutputItem[] = []
      const result = await callAgentResponsesApi({
        settings: requestSettings,
        profile: activeProfile,
        imageProfile,
        params: imageParams,
        input: apiInputForTurn,
        maskDataUrl,
        signal: controller.signal,
        onTextDelta: shouldStreamAssistantMessage
          ? (delta) => {
              if (controller.signal.aborted) return
              if (pendingToolTextSeparator && delta && accumulatedText.trim()) {
                accumulatedText += '\n\n'
                appendAgentAssistantMessageContent(conversationId, assistantMessageId, '\n\n')
              }
              pendingToolTextSeparator = false
              accumulatedText += delta
              appendAgentAssistantMessageContent(conversationId, assistantMessageId, delta)
            }
          : undefined,
        onOutputItems: shouldStreamAssistantMessage
          ? (outputItems) => {
              if (controller.signal.aborted) return
              currentResponseOutputItems = canonicalizeBatchFunctionCallArguments(outputItems)
              updateAgentConversation(conversationId, (current) => ({
                ...current,
                rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseOutput: mergeResponseOutputItems(accumulatedOutputItems, currentResponseOutputItems) } : item),
              }))
            }
          : undefined,
        onImageToolStarted: shouldStreamAssistantMessage
          ? async ({ toolCallId }) => {
              if (controller.signal.aborted) return
              await ensureStreamingAgentTask(toolCallId)
            }
          : undefined,
        onImagePartialImage: shouldStreamAssistantMessage
          ? async ({ toolCallId, image, partialImageIndex }) => {
              if (controller.signal.aborted) return
              const taskId = await ensureStreamingAgentTask(toolCallId)
              if (controller.signal.aborted) return
              useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
              if (partialImageIndex === 0 || partialImageIndex == null) {
                void persistTaskStreamPartialImage(taskId, image)
              }
            }
          : undefined,
        onImageToolCompleted: shouldStreamAssistantMessage
          ? async (image) => {
              if (controller.signal.aborted) return
              await completeAgentImageTask(image)
            }
          : undefined,
        onImageToolFailed: shouldStreamAssistantMessage
          ? async ({ toolCallId, error }) => {
              if (controller.signal.aborted) return
              await ensureStreamingAgentTask(toolCallId)
              if (controller.signal.aborted) return
              failAgentImageTask(toolCallId, error)
            }
          : undefined,
      })
      if (controller.signal.aborted) throw createAgentAbortError()

      lastResponseId = result.responseId ?? lastResponseId
      currentResponseOutputItems = canonicalizeBatchFunctionCallArguments(
        currentResponseOutputItems.length ? currentResponseOutputItems : result.outputItems ?? [],
      )
      const deletedTasks = getDeletedAgentTasks()
      const currentRound = getLatestRound()
      if (currentRound) {
        currentResponseOutputItems = scrubResponseOutputForDeletedAgentTasks(
          currentRound,
          currentResponseOutputItems,
          deletedTasks,
          [...useStore.getState().tasks, ...deletedTasks],
        )
      }
      accumulatedOutputItems = mergeResponseOutputItems(accumulatedOutputItems, currentResponseOutputItems)
      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseId: lastResponseId, responseOutput: accumulatedOutputItems } : item),
      }))

      const responseText = result.text.trim()
      if (responseText && accumulatedText === textBeforeResponse) {
        const textToAppend = accumulatedText ? `\n\n${responseText}` : responseText
        accumulatedText += textToAppend
        if (shouldStreamAssistantMessage) appendAgentAssistantMessageContent(conversationId, assistantMessageId, textToAppend)
      }
      const newTextInThisResponse = accumulatedText.slice(textBeforeResponse.length).trim()
      if (newTextInThisResponse) textSegments.push(newTextInThisResponse)

      // Process built-in image_generation_call results (single images)
      for (const image of result.images) {
        if (image.toolCallId && taskIdByToolCallId.has(image.toolCallId)) {
          const completed = await completeAgentImageTask(image, result.rawResponsePayload)
          if (!completed.committed) continue
          const completedTaskId = completed.taskId
          const promptRefIds = uniqueIds(extractAgentReferenceIds(image.revisedPrompt ?? ''))
          if (promptRefIds.length > 0) {
            const promptRefs = await resolveReferenceImages(promptRefIds)
            if (promptRefs.imageIds.length > 0) {
              const latestTask = useStore.getState().tasks.find((t) => t.id === completedTaskId)
              if (latestTask) {
                const mergedInputIds = uniqueIds([...latestTask.inputImageIds, ...promptRefs.imageIds])
                if (mergedInputIds.length !== latestTask.inputImageIds.length) {
                  updateTaskInStore(completedTaskId, { inputImageIds: mergedInputIds })
                }
              }
            }
          }
          continue
        }
        const promptRefIds = uniqueIds(extractAgentReferenceIds(image.revisedPrompt ?? ''))
        const promptRefs = await resolveReferenceImages(promptRefIds)
        const stored = await storeImageWithSize(image.dataUrl, 'generated')
        cacheImage(stored.id, image.dataUrl)
        const actualParams = deriveAgentImageActualParams(image.actualParams, stored)
        const task: TaskRecord = {
          id: genId(),
          prompt: image.revisedPrompt ?? round?.prompt ?? userMessage.content,
          params: imageParams,
          apiProvider: imageProfile.provider,
          apiProfileId: imageProfile.id,
          apiProfileName: imageProfile.name,
          apiMode: imageProfile.apiMode,
          apiModel: imageProfile.model,
          inputImageIds: uniqueIds([...(round?.inputImageIds ?? []), ...promptRefs.imageIds]),
          maskTargetImageId: round?.maskTargetImageId ?? null,
          maskImageId: round?.maskImageId ?? null,
          outputImages: [stored.id],
          actualParams,
          actualParamsByImage: { [stored.id]: actualParams },
          revisedPromptByImage: image.revisedPrompt ? { [stored.id]: image.revisedPrompt } : undefined,
          rawResponsePayload: result.rawResponsePayload,
          status: 'done',
          error: null,
          createdAt: startedAt,
          finishedAt: Date.now(),
          elapsed: Date.now() - startedAt,
          sourceMode: 'agent',
          agentConversationId: conversationId,
          agentRoundId: roundId,
          agentMessageId: assistantMessageId,
          agentToolCallId: image.toolCallId,
          agentToolAction: image.action,
        }
        useStore.getState().setTasks([task, ...useStore.getState().tasks])
        attachTaskToAgentRound(task.id)
        await putTask(task)
      }

      if (result.rawResponsePayload && streamingTaskIds.length > 0) {
        for (const taskId of streamingTaskIds) {
          const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
          if (latestTask && !latestTask.rawResponsePayload) updateTaskInStore(taskId, { rawResponsePayload: result.rawResponsePayload })
        }
      }

      const pendingImageGenerationCalls = shouldRunImageCallsWithGalleryApi
        ? getPendingImageGenerationCalls(currentResponseOutputItems)
        : []
      const appManagedImageCallResults: Array<{ id: string; status: 'done' | 'error'; error?: string }> = []

      for (const imageCall of pendingImageGenerationCalls) {
        if (controller.signal.aborted) throw createAgentAbortError()
        const imageResult = await executeImageGenerationCallWithGalleryApi(imageCall)
        appManagedImageCallResults.push({
          id: imageResult.batchItemId,
          status: imageResult.image ? 'done' : 'error',
          ...(imageResult.error ? { error: imageResult.error } : {}),
        })
      }
      const shouldContinueAfterAppManagedImages = appManagedImageCallResults.some((item) => item.status === 'done')

      // Check for function calls that require continuation
      const imageFunctionCalls = currentResponseOutputItems.filter(
        (item) => item.type === 'function_call' && item.name === 'generate_image',
      )
      const batchFunctionCalls = currentResponseOutputItems.filter(
        (item) => item.type === 'function_call' && item.name === 'generate_image_batch',
      )
      const continueFunctionCalls = currentResponseOutputItems.filter(
        (item) => item.type === 'function_call' && item.name === 'continue_generation',
      )

      // Count built-in tool calls (image_generation, web_search) for budget tracking
      const responseToolCalls = countResponseToolCalls(currentResponseOutputItems)
      toolCallsUsed += responseToolCalls

      // Collect function_call_output items for all function calls that need responses
      const functionCallOutputs: ResponsesOutputItem[] = []

      if (imageFunctionCalls.length > 0) {
        for (const fc of imageFunctionCalls) {
          const output = await executeSingleImageFunctionCall(fc)
          if (output == null) continue
          functionCallOutputs.push({
            type: 'function_call_output',
            call_id: fc.call_id,
            output,
          })
        }
      }

      if (batchFunctionCalls.length > 0) {
        for (const fc of batchFunctionCalls) {
          const output = await executeBatchFunctionCall(fc)
          functionCallOutputs.push({
            type: 'function_call_output',
            call_id: fc.call_id,
            output,
          })
        }
      }

      for (const fc of continueFunctionCalls) {
        functionCallOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: JSON.stringify({ status: 'continued' }),
        })
      }

      const latestDeletedTasks = getDeletedAgentTasks()
      const cleanedConversation = useStore.getState().agentConversations.find((item) => item.id === conversationId)
      const latestRoundForCleanup = cleanedConversation?.rounds.find((item) => item.id === roundId)
      const outputBeforeFunctionResults = latestRoundForCleanup?.responseOutput ?? accumulatedOutputItems
      const mergedOutputItems = mergeResponseOutputItems(outputBeforeFunctionResults, functionCallOutputs)
      const accumulatedOutputItemsWithFunctionOutputs = latestRoundForCleanup
        ? scrubResponseOutputForDeletedAgentTasks(
            latestRoundForCleanup,
            mergedOutputItems,
            latestDeletedTasks,
            [...useStore.getState().tasks, ...latestDeletedTasks],
          )
        : mergedOutputItems
      const generatedOutputCallIds = new Set(functionCallOutputs.map((item) => item.call_id).filter(Boolean))
      const effectiveFunctionCallOutputs = accumulatedOutputItemsWithFunctionOutputs.filter(
        (item) => item.type === 'function_call_output' && item.call_id && generatedOutputCallIds.has(item.call_id),
      )

      const shouldFinishAfterAppManagedImages = isSakrylleApiBaseUrl(activeProfile.baseUrl) && shouldRunImageCallsWithGalleryApi && (
        shouldContinueAfterAppManagedImages ||
        (batchFunctionCalls.length > 0 && continueFunctionCalls.length === 0)
      )

      // If no function calls need output → model decided the task is done → break
      if ((effectiveFunctionCallOutputs.length === 0 && !shouldContinueAfterAppManagedImages) || shouldFinishAfterAppManagedImages) {
        const nextOutputItems = accumulatedOutputItemsWithFunctionOutputs
        updateAgentConversation(conversationId, (current) => ({
          ...current,
          updatedAt: Date.now(),
          rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseId: lastResponseId, responseOutput: nextOutputItems } : item),
        }))
        accumulatedOutputItems = nextOutputItems
        break
      }

      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseId: lastResponseId, responseOutput: accumulatedOutputItemsWithFunctionOutputs } : item),
      }))

      if (toolCallsUsed >= maxToolCalls) {
        reachedToolLimit = true
        break
      }

      // Build continuation input with function call outputs and available refs
      const continuationState = useStore.getState()
      const latestConversation = continuationState.agentConversations.find((item) => item.id === conversationId)
      const latestRound = latestConversation?.rounds.find((item) => item.id === roundId)
      if (!latestRound) break

      apiInputForTurn = await buildAgentContinuationInput({
        baseInput: apiInput,
        currentRound: latestRound,
        tasks: continuationState.tasks,
        currentRoundOutput: accumulatedOutputItemsWithFunctionOutputs,
        functionCallOutputs: effectiveFunctionCallOutputs,
        batchTaskIds: streamingTaskIds,
        toolCallsUsed,
        maxToolCalls,
        loadImage: ensureImageCached,
      })
      accumulatedOutputItems = accumulatedOutputItemsWithFunctionOutputs
      pendingToolTextSeparator = true
    }

    markAgentRoundTasksFailed(
      conversationId,
      roundId,
      requestSettings.agentApiConfigMode === 'hybrid' ? i18n.t("upstreamSync.customImageToolReturnedNoImage") : i18n.t("upstreamSync.builtInImageGenerationToolReturnedNoImage"),
      undefined,
      (task) => Boolean(task.agentToolCallId && !task.agentBatchCallId),
    )

    const latestTasks = useStore.getState().tasks
    const existingTaskIds = new Set(latestTasks.map((task) => task.id))
    const taskIds = streamingTaskIds.filter((taskId) => existingTaskIds.has(taskId))
    const outputIds = taskIds.flatMap((taskId) => latestTasks.find((task) => task.id === taskId)?.outputImages ?? [])
    const latestConversation = useStore.getState().agentConversations.find((item) => item.id === conversationId)
    const latestRound = latestConversation?.rounds.find((item) => item.id === roundId)
    const deletedTasks = getDeletedAgentTasks()
    const responseOutput = latestRound
      ? scrubResponseOutputForDeletedAgentTasks(latestRound, accumulatedOutputItems, deletedTasks, [...latestTasks, ...deletedTasks])
      : accumulatedOutputItems
    const limitNotice = reachedToolLimit ? i18n.t('upstreamSync.message54', { value0: maxToolCalls }) : ''
    const joinedText = textSegments.join('\n\n').trim()
    const doneNotice = outputIds.length > 0 ? i18n.t('errors.agentImagesGenerated') : ''
    const finalContent = [joinedText, doneNotice, limitNotice]
      .filter(Boolean)
      .join('\n\n')
      || doneNotice

    const assistantMessage: AgentMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: finalContent,
      roundId,
      outputTaskIds: taskIds,
      createdAt: Date.now(),
    }

    updateAgentConversation(conversationId, (current) => ({
      ...current,
      updatedAt: Date.now(),
      rounds: current.rounds.map((round) =>
        round.id === roundId
          ? {
              ...round,
              assistantMessageId,
              outputTaskIds: taskIds,
              responseId: lastResponseId,
              responseOutput,
              status: 'done',
              error: null,
              finishedAt: Date.now(),
            }
          : round,
      ),
      messages: current.messages.some((message) => message.id === assistantMessageId)
        ? current.messages.map((message) => message.id === assistantMessageId ? assistantMessage : message)
        : [...current.messages, assistantMessage],
    }))

    useStore.getState().showToast(outputIds.length > 0 ? i18n.t('toast.agentImagesGenerated') : i18n.t('toast.agentReplied'), 'success')
    showTaskCompletionNotification(
      outputIds.length > 0 ? i18n.t("toast.agentImagesGenerated") : i18n.t("toast.agentReplied"),
      outputIds.length > 0 ? i18n.t('upstreamSync.message55', { value0: outputIds.length }) : i18n.t("upstreamSync.agentResponseFinished"),
    )
  } catch (err) {
    if (controller.signal.aborted) {
      if (markAgentRoundStopped(conversationId, roundId)) {
        useStore.getState().showToast(i18n.t('toast.stoppedGeneration'), 'info')
      }
      return
    }

    if (isAgentRecoveryPauseError(err)) return

    let message = err instanceof Error ? err.message : String(err)
    const usesApiProxy = activeProfile.apiProxy ?? requestSettings.apiProxy
    const networkErrorHint = getApiRequestNetworkErrorHint(err, startedAt, usesApiProxy, activeProfile)
    if (networkErrorHint && !messageContainsImageFetchCorsHint(message)) {
      message += `\n${networkErrorHint}`
    }

    markAgentRoundTasksFailed(conversationId, roundId, message, getRawErrorPayload(err).rawResponsePayload)

    updateAgentConversation(conversationId, (current) => {
      const failedRound = current.rounds.find((round) => round.id === roundId)
      const existingAssistantMessage = failedRound?.assistantMessageId
        ? current.messages.find((item) => item.id === failedRound.assistantMessageId)
        : current.messages.find((item) => item.roundId === roundId && item.role === 'assistant')
      const errorContent = i18n.t('agent.errorMessagePrefix') + message

      return {
        ...current,
        title: current.rounds.length === 1 && current.rounds[0].id === roundId ? i18n.t('data.newConversationDefault') : current.title,
        updatedAt: Date.now(),
        rounds: current.rounds.map((round) =>
          round.id === roundId
            ? {
                ...round,
                ...(existingAssistantMessage ? { assistantMessageId: existingAssistantMessage.id } : {}),
                status: 'error',
                error: message,
                finishedAt: Date.now(),
              }
            : round,
        ),
        messages: existingAssistantMessage
          ? current.messages.map((item) => item.id === existingAssistantMessage.id ? { ...item, content: errorContent } : item)
          : [
              ...current.messages,
              {
                id: genId(),
                role: 'assistant',
                content: errorContent,
                roundId,
                createdAt: Date.now(),
              },
            ],
      }
    })
    useStore.getState().showToast(i18n.t('toast.agentRequestFailed', { message }), 'error')
  } finally {
    if (agentRoundControllers.get(controllerKey) === controller) {
      agentRoundControllers.delete(controllerKey)
    }
    const deletedTasks = getDeletedActiveAgentTasks(conversationId, roundId, controller)
    try {
      const cleanup = scrubAgentOutputPayloadsForDeletedTasks(deletedTasks)
      if (cleanup.updatedTasks.length > 0 || cleanup.updatedConversations.length > 0) {
        await persistTaskDeletionCleanup([], cleanup)
      }
    } catch (err) {
      console.warn(i18n.t("upstreamSync.failedToCleanUpDeletedAgentTaskResponses"), err)
    } finally {
      for (const task of deletedTasks) {
        if (deletedActiveAgentTasks.get(task.id)?.controller === controller) deletedActiveAgentTasks.delete(task.id)
      }
    }
  }
}

async function executeTask(taskId: string) {
  const { settings } = useStore.getState()
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return
  const taskProfile = getTaskApiProfile(settings, task)
  if (!taskProfile && task.apiProfileId) {
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, i18n.t("errors.missingProfileForTask"), Date.now()),
      customRecoverable: false,
    })
    return
  }
  const activeProfile = taskProfile ?? getActiveApiProfile(settings)
  const requestSettings = createSettingsForApiProfile(settings, activeProfile)
  const taskProvider = taskProfile?.provider ?? task.apiProvider ?? activeProfile.provider
  let customTaskInfo: { taskId: string } | null = task.customTaskId
    ? { taskId: task.customTaskId }
    : null

  if (
    !isAsyncCustomProviderTask(requestSettings, taskProvider, task.inputImageIds.length > 0) &&
    !usesConcurrentImageRequests(requestSettings, activeProfile, task.params, task.inputImageIds.length > 0)
  ) {
    scheduleOpenAIWatchdog(taskId, activeProfile.timeout, activeProfile)
  }

  try {
    // 获取输入图片 data URLs
    const inputDataUrls: string[] = []
    for (const imgId of task.inputImageIds) {
      const dataUrl = await ensureImageCached(imgId)
      if (!dataUrl) throw new Error(i18n.t('errors.inputImageMissing'))
      inputDataUrls.push(dataUrl)
    }
    let maskDataUrl: string | undefined
    if (task.maskImageId) {
      maskDataUrl = await ensureImageCached(task.maskImageId)
      if (!maskDataUrl) throw new Error(i18n.t('errors.maskImageMissing'))
    }

    const requestPrompt = task.transparentOutput && task.transparentPrompt
      ? task.transparentPrompt
      : task.prompt

    const result = await callImageApi({
      settings: requestSettings,
      prompt: replaceImageMentionsForApi(requestPrompt, inputDataUrls.length),
      params: task.params,
      nativeTransparentBackground: task.params.transparent_output && !task.transparentOutput,
      inputImageDataUrls: inputDataUrls,
      maskDataUrl,
      skipCodexCliSizePrompt: task.sourceMode === 'agent',
      onCustomTaskEnqueued: (request) => {
        customTaskInfo = request
        updateTaskInStore(taskId, {
          customTaskId: request.taskId,
          customRecoverable: false,
        })
      },
      onPartialImage: (partial) => {
        useStore.getState().setTaskStreamPreview(taskId, partial.image, partial.requestIndex)
        // final 帧是子请求成品，会在成功路径正式入库，无需再作为中间帧持久化
        if (!partial.final) void persistTaskStreamPartialImage(taskId, partial.image)
      },
    })

    const latestBeforeSuccess = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeSuccess || latestBeforeSuccess.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      return
    }

    // 存储输出图片
    const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
    const isAsyncCustomTask = taskProvider !== 'openai' && Boolean(customTaskInfo)
    const actualParamsList = await resolveImageSizeParamsList(
      outputDataUrls,
      isAsyncCustomTask ? undefined : result.actualParamsList,
      outputImageSizes,
    )
    const actualParams = deriveGalleryActualParams(taskProvider, isAsyncCustomTask, result.actualParams, actualParamsList, outputIds.length)
    const shouldStoreRevisedPrompts = !isAsyncCustomTask
    const actualParamsByImage = mapActualParamsByImage(outputIds, actualParamsList)
    const revisedPrompts = activeProfile.codexCli && task.sourceMode !== 'agent'
      ? result.revisedPrompts?.map((prompt) => prompt == null ? prompt : stripInjectedCodexCliSizePrompt(prompt, requestPrompt, task.params.size))
      : result.revisedPrompts
    const revisedPromptByImage = shouldStoreRevisedPrompts ? mapRevisedPromptsByImage(outputIds, revisedPrompts) : undefined
    const promptWasRevised = shouldStoreRevisedPrompts && revisedPrompts?.some(
      (revisedPrompt) => revisedPrompt?.trim() && revisedPrompt.trim() !== requestPrompt.trim(),
    )
    const hasRevisedPromptValue = shouldStoreRevisedPrompts && revisedPrompts?.some((revisedPrompt) => revisedPrompt?.trim())
    if (taskProvider === 'openai' && activeProfile.apiMode === 'responses' && !activeProfile.codexCli) {
      if (promptWasRevised) {
        showCodexCliPrompt()
      } else if (!hasRevisedPromptValue) {
        showCodexCliPrompt(false, i18n.t('errors.codexCliReasonMissing'))
      }
    }

    // 更新任务
    const latestBeforeUpdate = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeUpdate || latestBeforeUpdate.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
      return
    }
    const partialImageIdsToClean = latestBeforeUpdate.streamPartialImageIds || []
    clearOpenAIWatchdogTimer(taskId)
    useStore.getState().setTaskStreamPreview(taskId)
    updateTaskInStore(taskId, {
      outputImages: outputIds,
      transparentOriginalImages: transparentOriginalImageIds,
      outputErrors: result.failedRequests?.length ? result.failedRequests : undefined,
      streamPartialImageIds: undefined,
      rawImageUrls: result.rawImageUrls?.length ? result.rawImageUrls : undefined,
      actualParams,
      actualParamsByImage,
      revisedPromptByImage,
      ...createTaskDonePatch(task, Date.now()),
      customRecoverable: false,
    })
    void deleteUnreferencedImageIds(partialImageIdsToClean)

    if (result.partialFailure) {
      useStore.getState().showToast(
        i18n.t('toast.generationPartialFailure', {
          target: outputIds.length + result.partialFailure.failedCount,
          success: outputIds.length,
          failed: result.partialFailure.failedCount,
        }),
        'error',
      )
    } else {
      useStore.getState().showToast(i18n.t('toast.generationCompleteWithCount', { count: outputIds.length }), 'success')
    }
    if (!isAgentTask(task)) {
      const failedCount = result.failedRequests?.length ?? 0
      const completionMessage = failedCount > 0
        ? i18n.t('upstreamSync.message56', { value0: outputIds.length, value1: failedCount })
        : i18n.t('upstreamSync.message57', { value0: outputIds.length })
      showTaskCompletionNotification(i18n.t("upstreamSync.imageGenerationComplete"), `${completionMessage}。`)
    }
    const currentMask = useStore.getState().maskDraft
    if (
      maskDataUrl &&
      currentMask &&
      currentMask.targetImageId === task.maskTargetImageId &&
      currentMask.maskDataUrl === maskDataUrl
    ) {
      useStore.getState().clearMaskDraft()
    }
  } catch (err) {
    clearOpenAIWatchdogTimer(taskId)
    const latestTask = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestTask || latestTask.status !== 'running') return
    useStore.getState().setTaskStreamPreview(taskId)
    const latestCustomTaskInfo = customTaskInfo ?? (latestTask.customTaskId ? { taskId: latestTask.customTaskId } : null)
    if (latestCustomTaskInfo && isNetworkRecoverableError(err)) {
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, i18n.t("upstreamSync.connectionToTheAsyncTaskWasLostResult"), Date.now()),
        customTaskId: latestCustomTaskInfo.taskId,
        customRecoverable: true,
      })
      scheduleCustomRecovery(taskId)
    } else {
      let errorMessage = err instanceof Error ? err.message : String(err)
      const settingsNow = useStore.getState().settings
      const profile = getTaskApiProfile(settingsNow, latestTask)
      const usesApiProxy = profile?.apiProxy ?? settingsNow.apiProxy
      const activeProfileNow = getActiveApiProfile(settingsNow)
      const hintProfile = profile ?? {
        provider: latestTask.apiProvider ?? activeProfileNow.provider,
        apiMode: settingsNow.apiMode,
        streamImages: activeProfileNow.streamImages,
        streamPartialImages: activeProfileNow.streamPartialImages,
        streamChatCompletionsImage: activeProfileNow.streamChatCompletionsImage,
      }
      const networkErrorHint = getApiRequestNetworkErrorHint(err, latestTask.createdAt, usesApiProxy, hintProfile)
      if (networkErrorHint && !messageContainsImageFetchCorsHint(errorMessage)) {
        errorMessage += `\n${networkErrorHint}`
      }
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, errorMessage, Date.now()),
        ...getRawErrorPayload(err),
        customRecoverable: false,
      })
      useStore.getState().setDetailTaskId(taskId)
    }
  } finally {
    // 释放输入图片的内存缓存（已持久化到 IndexedDB，后续按需从 DB 加载）
    for (const imgId of task.inputImageIds) {
      deleteCachedImage(imgId)
    }
  }
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks, defaultFavoriteCollectionId } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...normalizeFavoritePatch(t, patch, defaultFavoriteCollectionId) } : t,
  )
  const task = updated.find((t) => t.id === taskId)
  setTasks(updated)
  maybeOpenSupportPrompt(tasks, updated, taskId)
  if (task) putTask(task)
}

export function createFavoriteCollection(name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName) return null
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast(i18n.t("upstreamSync.collectionNamesMayContainUpTo60Characters"), 'error')
    return null
  }
  const state = useStore.getState()
  const existing = state.favoriteCollections.find((collection) => collection.name === normalizedName)
  if (existing) return existing
  const now = Date.now()
  const collection: FavoriteCollection = { id: genId(), name: normalizedName, createdAt: now, updatedAt: now }
  state.setFavoriteCollections([...state.favoriteCollections, collection])
  state.showToast(i18n.t('upstreamSync.message58', { value0: normalizedName }), 'success')
  return collection
}

export function renameFavoriteCollection(collectionId: string, name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName || collectionId === ALL_FAVORITES_COLLECTION_ID) return
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast(i18n.t("upstreamSync.collectionNamesMayContainUpTo60Characters"), 'error')
    return
  }
  const { favoriteCollections, setFavoriteCollections, showToast } = useStore.getState()
  setFavoriteCollections(favoriteCollections.map((collection) =>
    collection.id === collectionId ? { ...collection, name: normalizedName, updatedAt: Date.now() } : collection,
  ))
  showToast(i18n.t("upstreamSync.collectionNameUpdated"), 'success')
}

export async function updateTasksFavoriteCollections(taskIds: string[], collectionIds: string[]) {
  const ids = normalizeFavoriteCollectionIds(collectionIds)
  const uniqueTaskIds = Array.from(new Set(taskIds)).filter(Boolean)
  if (!uniqueTaskIds.length) return
  const { tasks, setTasks, clearSelection, showToast, defaultFavoriteCollectionId } = useStore.getState()
  const idSet = new Set(uniqueTaskIds)
  const changedTaskIds = new Set<string>()
  const updated = tasks.map((task) => {
    if (!idSet.has(task.id)) return task
    if (sameFavoriteCollectionIds(getTaskFavoriteCollectionIds(task, defaultFavoriteCollectionId), ids)) return task
    changedTaskIds.add(task.id)
    return { ...task, favoriteCollectionIds: ids, isFavorite: ids.length > 0 }
  })
  if (!changedTaskIds.size) {
    clearSelection()
    return
  }
  setTasks(updated)
  await Promise.all(updated.filter((task) => changedTaskIds.has(task.id)).map((task) => putTask(task)))
  clearSelection()
  showToast(ids.length ? i18n.t("upstreamSync.collectionUpdated") : i18n.t("upstreamSync.removedFromFavorites"), 'success')
}

export async function deleteFavoriteCollection(collectionId: string, deleteTasks = false) {
  const state = useStore.getState()
  const collection = state.favoriteCollections.find((item) => item.id === collectionId)
  const result = deleteFavoriteCollectionState({
    collections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    activeFavoriteCollectionId: state.activeFavoriteCollectionId,
    selectedFavoriteCollectionIds: state.selectedFavoriteCollectionIds,
    selectedTaskIds: state.selectedTaskIds,
    tasks: state.tasks,
    collectionId,
    deleteTasks,
  })
  if (!collection || !result) return

  useStore.setState({
    favoriteCollections: result.collections,
    defaultFavoriteCollectionId: result.defaultFavoriteCollectionId,
    activeFavoriteCollectionId: result.activeFavoriteCollectionId,
    selectedFavoriteCollectionIds: result.selectedFavoriteCollectionIds,
    selectedTaskIds: result.selectedTaskIds,
  })
  if (result.updatedTasks.length) {
    const patches = new Map(result.updatedTasks.map((task) => [task.id, task]))
    const updated = useStore.getState().tasks.map((task) => {
      const patch = patches.get(task.id)
      return patch ? { ...task, favoriteCollectionIds: patch.favoriteCollectionIds, isFavorite: patch.isFavorite } : task
    })
    useStore.getState().setTasks(updated)
    await Promise.all(updated.filter((task) => patches.has(task.id)).map((task) => putTask(task)))
  }
  if (result.taskIdsToDelete.length) await removeMultipleTasks(result.taskIdsToDelete)
  useStore.getState().showToast(i18n.t('upstreamSync.message59', { value0: collection.name }), 'success')
}

const recoveringImageDownloads = new Set<string>()

/** Recover existing paid results. Never submit a generation request here. */
export async function retryImageDownloads(task: TaskRecord) {
  if (recoveringImageDownloads.has(task.id)) return
  const latest = useStore.getState().tasks.find(item => item.id === task.id)
  if (!latest || latest.status !== 'error' || latest.outputImages.length) return
  const urls = [...new Set(latest.rawImageUrls?.filter(isHttpUrl) ?? [])]
  if (!urls.length) return
  recoveringImageDownloads.add(task.id)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    useStore.getState().showToast(i18n.t('detail.recoveringDownloads'), 'success')
    const images: string[] = []
    for (const url of urls) images.push(await fetchImageUrlAsDataUrl(url, MIME_MAP[task.params.output_format] || 'image/png', controller.signal))
    if (useStore.getState().tasks.find(item => item.id === task.id)?.status !== 'error') return
    const { outputIds, transparentOriginalImageIds } = await storeTaskOutputImages(latest, images)
    if (useStore.getState().tasks.find(item => item.id === task.id)?.status !== 'error') {
      await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
      return
    }
    updateTaskInStore(task.id, { outputImages: outputIds, transparentOriginalImages: transparentOriginalImageIds, status: 'done', error: null })
    useStore.getState().showToast(i18n.t('toast.generationCompleteWithCount', { count: outputIds.length }), 'success')
  } catch {
    // Keep the original task and URLs available even when the link has expired.
    useStore.getState().showToast(i18n.t('detail.downloadRecoveryFailed'), 'error')
  } finally {
    clearTimeout(timeout)
    recoveringImageDownloads.delete(task.id)
  }
}

/** Retry saved downloads when available; otherwise create a new generation task. */
export async function retryTask(task: TaskRecord) {
  if (task.status === 'error' && task.rawImageUrls?.some(isHttpUrl) && !task.outputImages.length) {
    await retryImageDownloads(task)
    return
  }

  const { settings, showToast } = useStore.getState()
  const normalizedSettings = normalizeSettings(settings)
  const preferredProfile = getTaskApiProfile(normalizedSettings, task) ?? getActiveApiProfile(settings)
  const activeProfile = resolveGalleryImageApiProfile(normalizedSettings, preferredProfile)
  if (!activeProfile) {
    showToast(i18n.t('errors.noImagesProfile'), 'error')
    useStore.getState().setShowSettings(true)
    return
  }
  const requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  const normalizedParams = normalizeParamsForSettings(task.params, requestSettings, { hasInputImages: task.inputImageIds.length > 0 })
  const shouldUseTransparentOutput = (normalizedParams.output_format === 'png' || normalizedParams.output_format === 'webp') && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const transparentMeta = taskParams.transparent_output && activeProfile.transparentBackgroundMethod === 'local'
    ? createTransparentOutputMeta(task.prompt.trim())
    : null
  const taskId = genId()
  const newTask: TaskRecord = {
    id: taskId,
    prompt: task.prompt,
    params: taskParams,
    apiProvider: activeProfile.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeProfile.name,
    apiMode: activeProfile.apiMode,
    apiModel: activeProfile.model,
    inputImageIds: [...task.inputImageIds],
    maskTargetImageId: task.maskTargetImageId ?? null,
    maskImageId: task.maskImageId ?? null,
    transparentOutput: transparentMeta?.transparentOutput,
    transparentPrompt: transparentMeta?.effectivePrompt,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([newTask, ...latestTasks])
  await putTask(newTask)

  executeTask(taskId)
}

/** 复用配置 */
export async function reuseConfig(task: TaskRecord) {
  const { settings, setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, showToast, setConfirmDialog, setReusedTaskApiProfile } = useStore.getState()
  const normalizedSettings = normalizeSettings(settings)
  const currentProfile = getActiveApiProfile(settings)
  const taskProfile = normalizedSettings.reuseTaskApiProfileTemporarily ? getTaskApiProfile(normalizedSettings, task) : null
  const matchedProfile = taskProfile && (!isPresetConfigOnlyEnabled() || isPresetProfile(taskProfile.id)) ? taskProfile : null
  const shouldTemporarilyReuseProfile = Boolean(matchedProfile && matchedProfile.id !== currentProfile.id)
  const missingReusedProfile = normalizedSettings.reuseTaskApiProfileTemporarily && !matchedProfile
  const taskProfileName = matchedProfile?.name ?? getTaskApiProfileName(task)
  const paramsSettings = shouldTemporarilyReuseProfile && matchedProfile ? createSettingsForApiProfile(normalizedSettings, matchedProfile) : normalizedSettings

  setParams(normalizeParamsForSettings(task.params, paramsSettings, { hasInputImages: task.inputImageIds.length > 0 }))
  setReusedTaskApiProfile(
    shouldTemporarilyReuseProfile && matchedProfile ? matchedProfile.id : null,
    missingReusedProfile,
    taskProfileName,
  )
  clearMaskDraft()

  // 恢复输入图片
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      imgs.push({ id: imgId, dataUrl })
    }
  }
  setInputImages(imgs)
  setPrompt(task.prompt)
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  if (missingReusedProfile) {
    setConfirmDialog({
      title: i18n.t('errors.profileNotFoundTitle'),
      message: i18n.t('errors.profileNotFoundMessage', { taskProfile: taskProfileName, currentProfile: currentProfile.name }),
      confirmText: i18n.t('errors.useCurrentProfile'),
      cancelText: i18n.t('errors.abandonSubmit'),
      action: () => {
        void submitTask({ useCurrentApiProfileWhenReusedMissing: true })
      },
    })
    return
  }

  showToast(
    shouldTemporarilyReuseProfile && matchedProfile
      ? i18n.t('toast.reuseTempProfile', { name: matchedProfile.name })
      : i18n.t('toast.reuseToInput'),
    'success',
  )
}

/** 编辑输出：将输出图加入输入 */
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  let added = 0
  for (const imgId of task.outputImages) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      addInputImage({ id: imgId, dataUrl })
      added++
    }
  }
  showToast(i18n.t('toast.addedOutputsToInput', { count: added }), 'success')
}

function getAgentRoundDeletionTaskIds(conversation: AgentConversation, round: AgentRound, tasks: TaskRecord[]) {
  const messageIds = new Set(conversation.messages.filter((message) => message.roundId === round.id).map((message) => message.id))
  messageIds.add(round.userMessageId)
  if (round.assistantMessageId) messageIds.add(round.assistantMessageId)
  return uniqueIds([
    ...round.outputTaskIds,
    ...conversation.messages
      .filter((message) => messageIds.has(message.id))
      .flatMap((message) => message.outputTaskIds ?? []),
    ...tasks
      .filter((task) => task.agentRoundId === round.id || Boolean(task.agentMessageId && messageIds.has(task.agentMessageId)))
      .map((task) => task.id),
  ])
}

function hasRunningAgentDeletionWork(conversationId: string, roundIds: Set<string>, taskIds: Set<string>, state: AppState) {
  const conversation = state.agentConversations.find((item) => item.id === conversationId)
  if (conversation?.rounds.some((round) => roundIds.has(round.id) && round.status === 'running')) return true
  if (state.tasks.some((task) => taskIds.has(task.id) && task.status === 'running')) return true
  for (const roundId of roundIds) {
    const key = getAgentRoundControllerKey(conversationId, roundId)
    const round = conversation?.rounds.find((item) => item.id === roundId)
    const controller = agentRoundControllers.get(key)
    if (controller && !controller.signal.aborted) return true
    if (agentRecoveryContinuations.has(key) && round?.status !== 'done' && round?.error !== SENTINEL_AGENT_STOPPED) return true
  }
  return false
}

function cleanDeletedAgentReferences(conversation: AgentConversation, taskIds: Set<string>, assistantMessageIds: Set<string>, now: number) {
  let changed = false
  const rounds = conversation.rounds.map((round) => {
    const outputTaskIds = round.outputTaskIds.filter((taskId) => !taskIds.has(taskId))
    const clearAssistantMessage = Boolean(round.assistantMessageId && assistantMessageIds.has(round.assistantMessageId))
    if (outputTaskIds.length === round.outputTaskIds.length && !clearAssistantMessage) return round
    changed = true
    return {
      ...round,
      ...(clearAssistantMessage ? { assistantMessageId: undefined } : {}),
      outputTaskIds,
    }
  })
  const messages = conversation.messages.map((message) => {
    if (!message.outputTaskIds?.some((taskId) => taskIds.has(taskId))) return message
    changed = true
    return { ...message, outputTaskIds: message.outputTaskIds.filter((taskId) => !taskIds.has(taskId)) }
  })
  return changed ? { ...conversation, rounds, messages, updatedAt: now } : conversation
}

async function deleteAgentRoundAndTasks(conversationId: string, roundId: string): Promise<AgentDeletionResult> {
  const state = useStore.getState()
  const conversation = state.agentConversations.find((item) => item.id === conversationId)
  const round = conversation?.rounds.find((item) => item.id === roundId)
  if (!conversation || !round) return 'not-found'

  const taskIds = new Set(getAgentRoundDeletionTaskIds(conversation, round, state.tasks))
  if (hasRunningAgentDeletionWork(conversationId, new Set([roundId]), taskIds, state)) return 'running'

  let deleted = false
  try {
    await removeTasks([...taskIds], (latest, deletedTaskIds) => {
      const latestConversation = latest.agentConversations.find((item) => item.id === conversationId)
      const latestRound = latestConversation?.rounds.find((item) => item.id === roundId)
      if (!latestConversation || !latestRound) return null

      const oldActivePath = getActiveAgentRounds(latestConversation)
      const nextConversation = deleteAgentRoundFromConversation(latestConversation, roundId)
      const newActivePath = getActiveAgentRounds(nextConversation)
      const removedMessageIds = new Set([
        latestRound.userMessageId,
        ...(latestRound.assistantMessageId ? [latestRound.assistantMessageId] : []),
        ...latestConversation.messages.filter((message) => message.roundId === roundId).map((message) => message.id),
      ])
      const removedAssistantMessageIds = new Set(latestConversation.messages
        .filter((message) => message.role === 'assistant' && removedMessageIds.has(message.id))
        .map((message) => message.id))
      if (latestRound.assistantMessageId) removedAssistantMessageIds.add(latestRound.assistantMessageId)
      const now = Date.now()
      const agentConversations = latest.agentConversations.map((item) => {
        const candidate = item.id === conversationId
          ? { ...nextConversation, messages: nextConversation.messages.filter((message) => !removedMessageIds.has(message.id)) }
          : item
        return cleanDeletedAgentReferences(candidate, deletedTaskIds, removedAssistantMessageIds, now)
      })
      const agentInputDrafts = remapAgentInputDraftMentionsForPathChange(latest.agentInputDrafts, conversationId, oldActivePath, newActivePath)
      deleted = true
      return {
        agentConversations,
        agentInputDrafts,
        ...(latest.activeAgentConversationId === conversationId && latest.appMode === 'agent'
          ? { prompt: remapAgentRoundMentionsForPathChange(latest.prompt, oldActivePath, newActivePath) }
          : {}),
        agentEditingRoundId: latest.agentEditingRoundId === roundId ? null : latest.agentEditingRoundId,
      }
    })
  } catch (err) {
    if (!deleted) throw err
    console.warn(i18n.t("upstreamSync.agentRoundDeletedButStorageOrImageCleanup"), err)
    return 'deleted-with-warning'
  }
  return deleted ? 'deleted' : 'not-found'
}

async function deleteAgentAssistantMessageAndTasks(conversationId: string, messageId: string): Promise<AgentDeletionResult> {
  const state = useStore.getState()
  const conversation = state.agentConversations.find((item) => item.id === conversationId)
  const message = conversation?.messages.find((item) => item.id === messageId && item.role === 'assistant')
  if (!conversation || !message) return 'not-found'

  const round = conversation.rounds.find((item) => item.id === message.roundId)
  const taskIds = new Set(uniqueIds([
    ...(message.outputTaskIds ?? []),
    ...(round ? getAgentRoundDeletionTaskIds(conversation, round, state.tasks) : []),
    ...state.tasks.filter((task) => task.agentMessageId === messageId).map((task) => task.id),
  ]))
  const referencedRoundIds = new Set([
    message.roundId,
    ...conversation.rounds.filter((item) => item.assistantMessageId === messageId).map((item) => item.id),
  ])
  if (hasRunningAgentDeletionWork(conversationId, referencedRoundIds, taskIds, state)) return 'running'

  let deleted = false
  try {
    await removeTasks([...taskIds], (latest, deletedTaskIds) => {
      const latestConversation = latest.agentConversations.find((item) => item.id === conversationId)
      const latestMessage = latestConversation?.messages.find((item) => item.id === messageId && item.role === 'assistant')
      if (!latestConversation || !latestMessage) return null

      const now = Date.now()
      const assistantMessageIds = new Set([messageId])
      const agentConversations = latest.agentConversations.map((item) => {
        const candidate = item.id === conversationId
          ? { ...item, messages: item.messages.filter((current) => current.id !== messageId), updatedAt: now }
          : item
        return cleanDeletedAgentReferences(candidate, deletedTaskIds, assistantMessageIds, now)
      })
      deleted = true
      return { agentConversations }
    })
  } catch (err) {
    if (!deleted) throw err
    console.warn(i18n.t("upstreamSync.agentMessageDeletedButStorageOrImageCleanup"), err)
    return 'deleted-with-warning'
  }
  return deleted ? 'deleted' : 'not-found'
}

type TaskDeletionStateUpdater = (state: AppState, taskIds: Set<string>) => Partial<AppState> | null

async function removeTasks(taskIds: string[], updateState?: TaskDeletionStateUpdater) {
  const toDelete = new Set(taskIds)
  let deletedTasks: TaskRecord[] = []
  useStore.setState((state) => {
    deletedTasks = state.tasks.filter((task) => toDelete.has(task.id))
    const streamPreviews = { ...state.streamPreviews }
    const streamPreviewSlots = { ...state.streamPreviewSlots }
    for (const taskId of toDelete) {
      delete streamPreviews[taskId]
      delete streamPreviewSlots[taskId]
    }
    return {
      tasks: state.tasks.filter((task) => !toDelete.has(task.id)),
      selectedTaskIds: state.selectedTaskIds.filter((id) => !toDelete.has(id)),
      streamPreviews,
      streamPreviewSlots,
    }
  })
  if (deletedTasks.length === 0 && !updateState) return 0

  const deletedImageIds = new Set<string>()
  for (const task of deletedTasks) {
    addTaskReferencedImageIds(deletedImageIds, task)
    const controller = task.agentConversationId && task.agentRoundId
      ? agentRoundControllers.get(getAgentRoundControllerKey(task.agentConversationId, task.agentRoundId))
      : undefined
    if (controller) deletedActiveAgentTasks.set(task.id, { task, controller })
    clearCustomRecoveryTimer(task.id)
    clearOpenAIWatchdogTimer(task.id)
  }

  const cleanup = scrubAgentOutputPayloadsForDeletedTasks(deletedTasks)
  const domainUpdatedConversations: AgentConversation[] = []
  if (updateState) {
    useStore.setState((state) => {
      const patch = updateState(state, toDelete)
      if (!patch) return state
      if (patch.agentConversations) {
        const previousById = new Map(state.agentConversations.map((conversation) => [conversation.id, conversation]))
        domainUpdatedConversations.push(...patch.agentConversations.filter((conversation) => previousById.get(conversation.id) !== conversation))
      }
      return patch
    })
  }
  const updatedConversations = new Map(cleanup.updatedConversations.map((conversation) => [conversation.id, conversation]))
  for (const conversation of domainUpdatedConversations) updatedConversations.set(conversation.id, conversation)
  await persistTaskDeletionCleanup(deletedTasks.map((task) => task.id), {
    ...cleanup,
    updatedConversations: [...updatedConversations.values()],
  })
  await deleteUnreferencedImageIds(deletedImageIds)
  return deletedTasks.length
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  if (!taskIds.length) return

  const deletedCount = await removeTasks(taskIds)
  if (deletedCount === 0) return
  useStore.getState().showToast(i18n.t('toast.deletedRecords', { count: deletedCount }), 'success')
}

/** 删除所有失败任务 */
export async function clearFailedTasks(taskIds?: string[]) {
  const targetTaskIds = taskIds ? new Set(taskIds) : null
  const failedTasks = useStore.getState().tasks
    .filter((task) => taskMatchesFilterStatus(task, 'error') && (!targetTaskIds || targetTaskIds.has(task.id)))
  const failedTaskIds = failedTasks
    .filter((task) => task.status === 'error')
    .map((task) => task.id)
  const partialFailedTaskIds = new Set(
    failedTasks
      .filter((task) => task.status !== 'error' && taskHasOutputErrors(task))
      .map((task) => task.id),
  )

  if (failedTaskIds.length) await removeMultipleTasks(failedTaskIds)
  if (partialFailedTaskIds.size) {
    const { tasks, setTasks, selectedTaskIds, setSelectedTaskIds, showToast } = useStore.getState()
    const updated = tasks.map((task) => partialFailedTaskIds.has(task.id) ? { ...task, outputErrors: undefined } : task)
    setTasks(updated)
    const nextSelectedTaskIds = selectedTaskIds.filter((id) => !partialFailedTaskIds.has(id))
    if (nextSelectedTaskIds.length !== selectedTaskIds.length) setSelectedTaskIds(nextSelectedTaskIds)
    await Promise.all(updated.filter((task) => partialFailedTaskIds.has(task.id)).map((task) => putTask(task)))
    showToast(i18n.t('upstreamSync.message60', { value0: partialFailedTaskIds.size }), 'success')
  }
}

/** 删除单条任务 */
export async function removeTask(task: TaskRecord) {
  const deletedCount = await removeTasks([task.id])
  if (deletedCount === 0) return
  useStore.getState().showToast(i18n.t('toast.recordDeleted'), 'success')
}

/** 清空数据选项 */
export interface ClearOptions {
  clearConfig?: boolean
  clearTasks?: boolean
}

/** 清空数据 */
export async function clearData(options: ClearOptions = { clearConfig: true, clearTasks: true }) {
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()

  if (options.clearTasks) {
    await dbClearTasks()
    await dbClearAgentConversations()
    await clearImages()
    clearImageCaches()
    setTasks([])
    useStore.setState({
      agentConversations: [],
      activeAgentConversationId: null,
      supportPromptOpen: false,
      supportPromptSkippedForImportedData: false,
    })
    clearInputImages()
    clearMaskDraft()
  }

  if (options.clearConfig) {
    const presetConfig = getPresetConfig()
    useStore.setState({
      dismissedPresetProfileIds: [],
      dismissedPresetProviderIds: [],
      dismissedCodexCliPrompts: [],
      supportPromptDismissed: false,
    })
    if (presetConfig) {
      useStore.setState({ settings: { ...DEFAULT_SETTINGS } })
      await useStore.getState().setPresetImportedSettings(presetConfig)
    } else {
      setSettings({ ...DEFAULT_SETTINGS })
    }
    setParams({ ...DEFAULT_PARAMS })
  }

  showToast(i18n.t('toast.selectedDataCleared'), 'success')
}


async function completeRecoveredCustomTask(task: TaskRecord, result: Awaited<ReturnType<typeof getCustomQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done' || latest.error === SENTINEL_AGENT_STOPPED) return
  if (latest.status !== 'running' && !latest.customRecoverable) return

  const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
  const actualParamsList = await resolveImageSizeParamsList(outputDataUrls, undefined, outputImageSizes)
  const latestBeforeUpdate = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latestBeforeUpdate || latestBeforeUpdate.status === 'done' || latestBeforeUpdate.error === SENTINEL_AGENT_STOPPED || (latestBeforeUpdate.status !== 'running' && !latestBeforeUpdate.customRecoverable)) {
    await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
    return
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    ...createTaskDonePatch(task, Date.now()),
    customRecoverable: false,
  })
  useStore.getState().showToast(i18n.t('upstreamSync.message61', { value0: outputIds.length }), 'success')
  if (!isAgentTask(task)) showTaskCompletionNotification(i18n.t("upstreamSync.imageGenerationComplete"), i18n.t('upstreamSync.message62', { value0: outputIds.length }))
  else void continueRecoveredAgentRound(task.id)
}

async function recoverCustomTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || !task.customTaskId || task.status === 'done') return

  const profile = getCustomRecoveryProfile(settings, task)
  const customProvider = profile ? getCustomProviderDefinition(settings, profile.provider) : null
  if (!profile || !customProvider?.poll) {
    scheduleCustomRecovery(taskId)
    return
  }

  try {
    const result = await getCustomQueuedImageResult(profile, customProvider, task.customTaskId, task.params)
    clearCustomRecoveryTimer(taskId)
    await completeRecoveredCustomTask(task, result)
  } catch (err) {
    clearCustomRecoveryTimer(taskId)
    if (!useStore.getState().tasks.some((item) => item.id === taskId)) return
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, err instanceof Error ? err.message : String(err), Date.now()),
      ...getRawErrorPayload(err),
      customRecoverable: false,
    })
    if (isAgentTask(task)) void continueRecoveredAgentRound(taskId)
  }
}


/** 导出选项 */
export interface ExportOptions {
  exportConfig?: boolean
  exportTasks?: boolean
}

/** 导出数据为 ZIP */
export async function exportData(options: ExportOptions = { exportConfig: true, exportTasks: true }) {
  try {
    const state = useStore.getState()
    if (options.exportTasks && hasActiveDataOperations(state.tasks, state.agentConversations)) throw new Error(i18n.t("upstreamSync.finishOrStopRunningTasksBeforeExporting427"))
    const tasks = options.exportTasks ? await getAllTasks() : []
    const imageIds = options.exportTasks ? await getAllImageIds() : []
    const { settings, agentConversations, favoriteCollections, defaultFavoriteCollectionId } = state
    const exportedAt = Date.now()
    const params = {
      options,
      exportedAt,
      settings,
      tasks,
      imageTasks: tasks,
      favoriteCollections,
      defaultFavoriteCollectionId,
      agentConversations: options.exportTasks ? getPersistableAgentConversations(agentConversations) : [],
    }
    const imageSizes = []
    for (const id of imageIds) {
      const image = await getImage(id)
      if (!image) continue
      const thumbnail = await getImageThumbnail(id)
      imageSizes.push({ id, bytes: getExportImageEstimatedBytes(image, thumbnail) })
    }
    const plan = getExportZipPlan(params, imageSizes)
    const backupId = `${exportedAt}`

    for (let index = 0; index < plan.length; index++) {
      const images: StoredImage[] = []
      const thumbnailsByImageId = new Map<string, StoredImageThumbnail>()
      for (const id of plan[index].imageIds) {
        const image = await getImage(id)
        if (!image) continue
        images.push(image)
        const thumbnail = await getImageThumbnail(id)
        if (!thumbnail?.thumbnailDataUrl) continue
        thumbnailsByImageId.set(id, thumbnail)
        cacheThumbnail(id, {
          dataUrl: thumbnail.thumbnailDataUrl,
          width: thumbnail.width,
          height: thumbnail.height,
          thumbnailVersion: thumbnail.thumbnailVersion,
        })
      }

      const partNumber = index + 1
      const result = await buildExportZip({
        ...params,
        tasks: plan[index].tasks,
        agentConversations: plan[index].agentConversations,
        images,
        thumbnailsByImageId,
        includeManifestData: plan[index].includeBaseData,
        backupPart: plan.length > 1 ? { id: backupId, index: partNumber, total: plan.length } : undefined,
      })
      const blob = createExportBlob(result.bytes)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const suffix = plan.length > 1 ? `_${String(plan.length).padStart(2, '0')}parts_part${String(partNumber).padStart(2, '0')}` : ''
      a.href = url
      a.download = `gpt-image-playground-backup_${formatExportFileTime(new Date(exportedAt))}${suffix}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      if (partNumber < plan.length) await new Promise((resolve) => setTimeout(resolve, 150))
    }
    useStore.getState().showToast(plan.length > 1 ? i18n.t('upstreamSync.message63', { value0: plan.length }) : i18n.t("toast.dataExported"), 'success')
  } catch (e) {
    console.error('exportData failed', e)
    const detail = e instanceof Error ? e.message.trim() : String(e).trim()
    useStore.getState().showToast(detail ? i18n.t('upstreamSync.message64', { value0: detail }) : i18n.t("upstreamSync.exportFailedUnknownError"), 'error')
  }
}

/** 导入选项 */
export interface ImportOptions {
  importConfig?: boolean
  importTasks?: boolean
}

export async function restoreExplicitPresetConfig(ids: { providerIds: string[], profileIds: string[] }) {
  const presetProviderIds = getPresetProviderIds()
  const presetProfileIds = getPresetProfileIds()
  const providerIds = ids.providerIds.filter((id) => presetProviderIds.has(id))
  const profileIds = ids.profileIds.filter((id) => presetProfileIds.has(id))
  if (!providerIds.length && !profileIds.length) return false

  const state = useStore.getState()
  for (const id of providerIds) state.restorePresetProvider(id)
  for (const id of profileIds) state.restorePresetProfile(id)
  const presetConfig = getPresetConfig()
  if (presetConfig) await useStore.getState().setPresetImportedSettings(presetConfig)
  return true
}

/** 导入 ZIP 数据 */
export async function importData(input: File | File[], options: ImportOptions = { importConfig: true, importTasks: true }): Promise<boolean> {
  try {
    const state = useStore.getState()
    if (options.importTasks && hasActiveDataOperations(state.tasks, state.agentConversations)) throw new Error(i18n.t("upstreamSync.finishOrStopRunningTasksBeforeImporting430"))
    const files = Array.isArray(input) ? input : [input]
    if (!files.length) throw new Error(i18n.t("upstreamSync.noBackupFilesSelected"))
    if (files.some((file) => file.size >= MAX_EXPORT_ZIP_BYTES)) {
      throw new Error(i18n.t("upstreamSync.aZipMustBeSmallerThan2Gb"))
    }

    const selected = [] as Array<{ file: File; manifest: Awaited<ReturnType<typeof readExportZipManifest>> }>
    for (const file of files) {
      const manifest = await readExportZipManifest(new Uint8Array(await file.arrayBuffer()), options.importTasks)
      selected.push({ file, manifest })
    }
    const multipart = selected.some((part) => part.manifest.backupPart != null)
    if (multipart) {
      if (selected.some((part) => !part.manifest.backupPart)) throw new Error(i18n.t("upstreamSync.doNotMixSplitBackupsAndRegularBackups"))
      const first = selected[0].manifest.backupPart!
      const indexes = new Set(selected.map((part) => part.manifest.backupPart!.index))
      const validSet = selected.every((part) => {
        const backupPart = part.manifest.backupPart!
        return backupPart.id === first.id && backupPart.total === first.total && backupPart.index >= 1 && backupPart.index <= first.total
      })
      if (!validSet || indexes.size !== selected.length) throw new Error(i18n.t("upstreamSync.selectedPartsAreDuplicatedOrBelongToDifferent"))
      if (options.importTasks && (selected.length !== first.total || indexes.size !== first.total)) {
        throw new Error(i18n.t('upstreamSync.message65', { value0: first.total }))
      }
      selected.sort((a, b) => a.manifest.backupPart!.index - b.manifest.backupPart!.index)
    }

    const settingsManifests = selected.filter((part) => part.manifest.settings)
    if (options.importConfig && !options.importTasks && !settingsManifests.length) throw new Error(i18n.t("upstreamSync.theSelectedBackupContainsNoConfigurationData"))
    const importedTasks = selected.flatMap((part) => part.manifest.tasks ?? [])
    const importedAgentConversations = selected.flatMap((part) => part.manifest.agentConversations ?? [])
    const hasTaskData = selected.some((part) => part.manifest.tasks != null || part.manifest.imageFiles != null)

    const importedImageIds: string[] = []
    if (options.importTasks && hasTaskData) {
      for (const part of selected) {
        const { manifest, files: zipFiles } = await readExportZip(new Uint8Array(await part.file.arrayBuffer()))
        for (const [id, info] of Object.entries(manifest.imageFiles ?? {})) {
          const dataUrl = readExportZipFileAsDataUrl(zipFiles, info.path)
          if (!dataUrl) continue
          await putImage({
            id,
            dataUrl,
            createdAt: info.createdAt,
            source: info.source,
            width: info.width,
            height: info.height,
          })
          cacheImage(id, dataUrl)
          importedImageIds.push(id)
        }

        for (const [id, info] of Object.entries(manifest.thumbnailFiles ?? {})) {
          const thumbnailDataUrl = readExportZipFileAsDataUrl(zipFiles, info.path)
          if (!thumbnailDataUrl) continue
          await putImageThumbnail({
            id,
            thumbnailDataUrl,
            width: info.width,
            height: info.height,
            thumbnailVersion: info.thumbnailVersion,
          })
          cacheThumbnail(id, {
            dataUrl: thumbnailDataUrl,
            width: info.width,
            height: info.height,
            thumbnailVersion: info.thumbnailVersion,
          })
        }
      }

      for (const task of importedTasks) {
        await putTask(task)
      }

      const tasks = await getAllTasks()
      const state = useStore.getState()
      const importedFavoriteCollections = selected.flatMap((part) => part.manifest.favoriteCollections ?? [])
      const mergedFavorites = mergeFavoriteCollections(state.favoriteCollections, importedFavoriteCollections)
      const favoriteCollections = mergedFavorites.collections
      const importedDefaultFavoriteCollectionId = selected
        .map((part) => part.manifest.defaultFavoriteCollectionId)
        .find((id) => id != null && favoriteCollections.some((collection) => collection.id === id))
      const defaultFavoriteCollectionId = mergedFavorites.importedCollections.length
        ? resolveDefaultFavoriteCollectionId(favoriteCollections, importedDefaultFavoriteCollectionId)
        : state.defaultFavoriteCollectionId
      const normalizedFavorites = normalizeLoadedFavoriteState(tasks, favoriteCollections, defaultFavoriteCollectionId)
      useStore.setState({
        tasks: normalizedFavorites.tasks,
        favoriteCollections: normalizedFavorites.collections,
        defaultFavoriteCollectionId: normalizedFavorites.defaultFavoriteCollectionId,
      })
      if (normalizedFavorites.changed) await Promise.all(normalizedFavorites.tasks.map((task) => putTask(task)))
      const normalizedAgentConversations = normalizeAgentConversations(importedAgentConversations)
        .filter((conversation) => !isEmptyAgentConversation(conversation))
      useStore.setState((state) => {
        const agentConversations = mergeImportedAgentConversations(state.agentConversations, normalizedAgentConversations)
        const activeAgentConversationId = state.activeAgentConversationId && agentConversations.some((conversation) => conversation.id === state.activeAgentConversationId)
          ? state.activeAgentConversationId
          : normalizedAgentConversations[0]?.id ?? agentConversations[0]?.id ?? null
        return {
          agentConversations,
          activeAgentConversationId,
        }
      })
      await replaceStoredAgentConversations(useStore.getState().agentConversations)
      skipSupportPromptForImportedData(tasks)
      scheduleThumbnailBackfill(importedImageIds)
    }

    if (options.importConfig && settingsManifests.length) {
      const state = useStore.getState()
      const providerIds = new Set(settingsManifests.flatMap((part) =>
        part.manifest.settings?.customProviders.map((provider) => provider.id) ?? [],
      ))
      const profileIds = new Set(settingsManifests.flatMap((part) =>
        part.manifest.settings?.profiles.map((profile) => profile.id) ?? [],
      ))
      const presetProviderIds = getPresetProviderIds()
      const presetProfileIds = getPresetProfileIds()
      for (const id of providerIds) {
        if (presetProviderIds.has(id)) state.restorePresetProvider(id)
      }
      for (const id of profileIds) {
        if (presetProfileIds.has(id)) state.restorePresetProfile(id)
      }
      const current = useStore.getState()
      const settings = settingsManifests.reduce(
        (current, part) => mergeImportedSettings(current, part.manifest.settings, { preserveInternalIds: true }),
        current.settings,
      )
      current.setSettings(settings)
    }

    let msg = i18n.t('toast.dataImported')
    if (options.importTasks && hasTaskData) {
      msg = i18n.t('toast.importedRecords', { count: importedTasks.length })
    } else if (options.importConfig && settingsManifests.length) {
      msg = i18n.t('toast.configImported')
    }

    useStore.getState().showToast(msg, 'success')
    return true
  } catch (e) {
    useStore
      .getState()
      .showToast(
        i18n.t('toast.importFailed', { error: e instanceof Error ? e.message : String(e) }),
        'error',
      )
    return false
  }
}

/** 添加图片到输入（文件上传） */
export async function addImageFromFile(file: File): Promise<void> {
  const image = await createInputImageFromFile(file)
  if (!image) return
  useStore.getState().addInputImage(image)
}

export async function createInputImageFromFile(file: File): Promise<InputImage | null> {
  // HEIC/HEIF must be transcoded to JPEG: browsers can't render it for preview
  // and the canvas re-encode on send can't decode it either. Detect first (the
  // MIME check below would reject HEIC files that arrive with an empty type).
  let source: Blob = file
  if (await isHeicFile(file)) {
    try {
      source = await convertHeicToJpeg(file)
    } catch {
      throw new Error(i18n.t('errors.heicConvertFailed'))
    }
  } else if (!file.type.startsWith('image/')) {
    return null
  }
  const dataUrl = await blobToDataUrl(source)
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  return { id, dataUrl }
}

/** 添加图片到输入（右键菜单）—— 支持 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await fetch(src)
  let blob = await res.blob()
  if (await isHeicFile(blob)) {
    try {
      blob = await convertHeicToJpeg(blob)
    } catch {
      throw new Error(i18n.t('errors.heicConvertFailed'))
    }
  } else if (!blob.type.startsWith('image/')) {
    throw new Error(i18n.t('errors.imageNotImage'))
  }
  const dataUrl = await blobToDataUrl(blob)
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

function getImageGenerationResultBase64(result: ResponsesOutputItem['result']): string | null {
  if (typeof result === 'string') return result.trim() ? result : null
  if (!isRecord(result)) return null

  const candidates = [result.b64_json, result.base64, result.image, result.data]
  const b64 = candidates.find((value) => typeof value === 'string' && value.trim())
  return typeof b64 === 'string' ? b64 : null
}

function imageGenerationCallHasResult(item: ResponsesOutputItem): boolean {
  return Boolean(getImageGenerationResultBase64(item.result))
}

function getImageGenerationCallId(item: ResponsesOutputItem): string {
  return (typeof item.id === 'string' && item.id.trim())
    || (typeof item.call_id === 'string' && item.call_id.trim())
    || genId()
}

function getImageGenerationCallPrompt(item: ResponsesOutputItem, fallbackPrompt: string): string {
  const record = item as Record<string, unknown>
  for (const key of ['prompt', 'revised_prompt', 'input', 'text', 'description']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  if (isRecord(item.action)) {
    for (const key of ['prompt', 'input', 'text', 'description']) {
      const value = item.action[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }

  for (const part of item.content ?? []) {
    if (typeof part.text === 'string' && part.text.trim()) return part.text.trim()
  }

  if (typeof item.arguments === 'string' && item.arguments.trim()) {
    try {
      const parsed = JSON.parse(item.arguments)
      if (isRecord(parsed)) {
        for (const key of ['prompt', 'input', 'text', 'description']) {
          const value = parsed[key]
          if (typeof value === 'string' && value.trim()) return value.trim()
        }
      }
    } catch {
      // Some gateways may expose arguments as a raw prompt string.
      return item.arguments.trim()
    }
  }

  return fallbackPrompt.trim()
}

function getPendingImageGenerationCalls(output: ResponsesOutputItem[]) {
  return output.filter((item) => item.type === 'image_generation_call' && !imageGenerationCallHasResult(item))
}


function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
