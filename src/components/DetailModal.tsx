import { resolveErrorForDisplay } from '../lib/agentSentinels'
import { isHttpUrl } from '../lib/imageApiShared'
import RemoteImageResults from './RemoteImageResults'
import i18n from '../lib/i18n'
import { useEffect, useState, useMemo, useRef } from 'react'
import { useStore, reuseConfig, editOutputs, removeTask, showCodexCliPrompt, getCodexCliPromptKey, retryTask } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { useTooltip } from '../hooks/useTooltip'
import { ensureImageCached, getCachedImage } from '../lib/imageCache'
import { formatImageRatio } from '../lib/size'
import { ActualValueBadge, DetailParamValue } from '../lib/paramDisplay'
import { copyImageSourceToClipboard, copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import { downloadImageEntriesAsZip, downloadImageIds, getImageZipEntries } from '../lib/downloadImages'
import { isAgentTaskPromptPending } from '../lib/taskPromptDisplay'
import { replaceImageMentionsForApi } from '../lib/promptImageMentions'
import { getApiProviderLabel } from '../lib/apiProfiles'
import { CloseIcon, CodeIcon, CopyIcon, DownloadIcon, EditIcon, LinkIcon, TrashIcon } from './icons'

import ViewportTooltip from './ViewportTooltip'

export default function DetailModal() {
  const tasks = useStore((s) => s.tasks)
  const detailTaskId = useStore((s) => s.detailTaskId)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const openFavoritePicker = useStore((s) => s.openFavoritePicker)
  const settings = useStore((s) => s.settings)
  const dismissedCodexCliPrompts = useStore((s) => s.dismissedCodexCliPrompts)
  const streamPreviewSrc = useStore((s) => detailTaskId ? s.streamPreviews[detailTaskId] || '' : '')
  const streamPreviewSlots = useStore((s) => detailTaskId ? s.streamPreviewSlots[detailTaskId] : undefined)

  const [imageIndex, setImageIndex] = useState(0)
  const [imageSrcs, setImageSrcs] = useState<Record<string, string>>({})
  const [outputPreviewSrcs, setOutputPreviewSrcs] = useState<Record<string, string>>({})
  const [imageRatios, setImageRatios] = useState<Record<string, string>>({})
  const [imageSizes, setImageSizes] = useState<Record<string, string>>({})
  const [maskPreviewSrc, setMaskPreviewSrc] = useState('')
  const [now, setNow] = useState(Date.now())
  const [showRawUrlsModal, setShowRawUrlsModal] = useState(false)
  const [showRawResponseModal, setShowRawResponseModal] = useState(false)
  const [streamPreviewLoaded, setStreamPreviewLoaded] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const rawUrlsModalRef = useRef<HTMLDivElement>(null)
  const rawResponseModalRef = useRef<HTMLDivElement>(null)

  const rawUrlsBackdropPointerDownRef = useRef(false)
  const rawResponseBackdropPointerDownRef = useRef(false)

  const copyErrorTooltip = useTooltip()
  const copyRawUrlsTooltip = useTooltip()
  const viewRawResponseTooltip = useTooltip()
  const downloadPartialImagesTooltip = useTooltip()
  const retryTooltip = useTooltip()
  const downloadImageTooltip = useTooltip()
  const downloadOriginalImageTooltip = useTooltip()
  const downloadAllTooltip = useTooltip()

  const clearTextSelection = () => {
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) selection.removeAllRanges()
  }

  const task = useMemo(
    () => tasks.find((t) => t.id === detailTaskId) ?? null,
    [tasks, detailTaskId],
  )
  const streamPreviewItems = useMemo(() => {
    const slotEntries = streamPreviewSlots
      ? Object.entries(streamPreviewSlots)
          .filter(([, src]) => Boolean(src))
          .sort(([a], [b]) => Number(a) - Number(b))
      : []
    const count = Math.max(
      task?.status === 'running' ? task.params.n : 0,
      slotEntries.length ? Math.max(...slotEntries.map(([key]) => Number(key) + 1)) : 0,
      streamPreviewSrc ? 1 : 0,
    )
    const byIndex = new Map(slotEntries.map(([key, src]) => [Number(key), src]))

    return Array.from({ length: count }, (_, index) => ({
      key: String(index),
      src: byIndex.get(index) ?? (index === 0 ? streamPreviewSrc : ''),
    }))
  }, [task?.params.n, task?.status, streamPreviewSlots, streamPreviewSrc])
  const activeStreamPreviewSrc = streamPreviewItems[imageIndex]?.src || ''

  useEffect(() => {
    setStreamPreviewLoaded(false)
  }, [activeStreamPreviewSrc, detailTaskId, imageIndex])

  useEffect(() => {
    const count = task?.status === 'running'
      ? streamPreviewItems.length
      : task
      ? (task.outputErrors?.length ? Math.max(task.params.n, task.outputImages.length + task.outputErrors.length) : task.outputImages.length)
      : 0
    if (count > 0 && imageIndex >= count) setImageIndex(count - 1)
  }, [imageIndex, streamPreviewItems.length, task, task?.status])

  useCloseOnEscape(Boolean(task), () => setDetailTaskId(null))
  usePreventBackgroundScroll(Boolean(task), [modalRef, rawUrlsModalRef, rawResponseModalRef])

  // Reset index when task changes
  useEffect(() => {
    setImageIndex(0)
  }, [detailTaskId])

  useEffect(() => {
    if (task?.status !== 'running') return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    setNow(Date.now())
    return () => window.clearInterval(id)
  }, [task?.status])

  // 加载所有相关图片
  useEffect(() => {
    if (!task) {
      setImageSrcs({})
      setOutputPreviewSrcs({})
      setImageRatios({})
      setImageSizes({})
      return
    }

    let cancelled = false
    const ids = [...new Set([
      ...(task.inputImageIds || []),
      ...(task.maskImageId ? [task.maskImageId] : []),
    ])]
    const initial: Record<string, string> = {}
    for (const id of ids) {
      const cached = getCachedImage(id)
      if (cached) initial[id] = cached
    }
    setImageSrcs(initial)
    for (const id of ids) {
      if (initial[id]) continue
      ensureImageCached(id).then((url) => {
        if (!cancelled && url) setImageSrcs((prev) => ({ ...prev, [id]: url }))
      })
    }

    return () => {
      cancelled = true
    }
  }, [task])

  const maskTargetId = task?.maskTargetImageId || null
  const maskTargetSrc = maskTargetId ? imageSrcs[maskTargetId] || '' : ''
  const maskSrc = task?.maskImageId ? imageSrcs[task.maskImageId] || '' : ''
  const allInputImageIds = task?.inputImageIds ?? []
  const outputSlots = useMemo(() => {
    if (!task) return []
    const outputErrors = task.outputErrors ?? []
    if (outputErrors.length === 0) {
      return task.outputImages.map((imageId, outputImageIndex) => ({
        requestIndex: outputImageIndex,
        outputImageIndex,
        imageId,
        error: '',
      }))
    }

    const errorsByIndex = new Map(outputErrors.map((item) => [item.requestIndex, item.error]))
    const requestedCount = Math.max(task.params.n, task.outputImages.length + outputErrors.length)
    let outputImageIndex = 0
    return Array.from({ length: requestedCount }, (_, requestIndex) => {
      const error = errorsByIndex.get(requestIndex)
      if (error) return { requestIndex, outputImageIndex: -1, imageId: '', error }
      const imageId = task.outputImages[outputImageIndex] ?? ''
      const slot = { requestIndex, outputImageIndex, imageId, error: '' }
      outputImageIndex += 1
      return slot
    })
  }, [task])
  const currentOutputSlot = outputSlots[imageIndex]
  const currentOutputImageId = currentOutputSlot?.imageId || ''
  const currentOutputImageIndex = currentOutputSlot?.outputImageIndex ?? -1
  const currentOutputError = currentOutputSlot?.error || ''
  const currentOriginalOutputImageId = currentOutputImageIndex >= 0 ? task?.transparentOriginalImages?.[currentOutputImageIndex] || '' : ''
  const currentOutputPreviewSrc = currentOutputImageId ? outputPreviewSrcs[currentOutputImageId] || '' : ''

  useEffect(() => {
    const outputImageIds = task?.outputImages ?? []
    if (outputImageIds.length === 0) {
      setOutputPreviewSrcs({})
      return
    }

    let cancelled = false
    const setOutputImage = (imageId: string, dataUrl: string) => {
      if (!cancelled) setOutputPreviewSrcs((prev) => ({ ...prev, [imageId]: dataUrl }))
    }

    for (const imageId of outputImageIds) {
      const cached = getCachedImage(imageId)
      if (cached) {
        setOutputImage(imageId, cached)
      } else {
        ensureImageCached(imageId)
          .then((dataUrl) => {
            if (dataUrl) setOutputImage(imageId, dataUrl)
          })
          .catch(() => {})
      }
    }

    return () => {
      cancelled = true
    }
  }, [task?.outputImages])

  useEffect(() => {
    let cancelled = false
    setMaskPreviewSrc('')
    if (!maskTargetSrc || !maskSrc) return

    createMaskPreviewDataUrl(maskTargetSrc, maskSrc)
      .then((url) => {
        if (!cancelled) setMaskPreviewSrc(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewSrc('')
      })

    return () => {
      cancelled = true
    }
  }, [maskTargetSrc, maskSrc])

  if (!task) return null

  const isAgentTask = task.sourceMode === 'agent' || Boolean(task.agentConversationId || task.agentRoundId)
  const showPendingPrompt = isAgentTaskPromptPending(task)
  const isAgentEditTool = task.status === 'done' && String(task.agentToolAction ?? '').toLowerCase() === 'edit'
  const showReferenceSection = allInputImageIds.length > 0 || isAgentEditTool

  const outputLen = outputSlots.length
  const currentImageRatio = currentOutputImageId ? imageRatios[currentOutputImageId] : ''
  const currentImageSize = currentOutputImageId ? imageSizes[currentOutputImageId] : ''
  const baseActualParams = currentOutputImageId
    ? task.actualParamsByImage?.[currentOutputImageId] ?? task.actualParams
    : task.actualParams
  const currentActualParams = (baseActualParams?.size || !currentImageSize)
    ? baseActualParams
    : { ...(baseActualParams ?? {}), size: currentImageSize.replace('×', 'x') }
  const currentRevisedPrompt = currentOutputImageId ? task.revisedPromptByImage?.[currentOutputImageId]?.trim() : ''
  // 将 @图N 等 mention 标记和透明背景追加提示词都按实际请求内容比较，
  // 避免仅由本地请求预处理导致的不一致被当作“API 改写”。
  const requestPrompt = task.transparentOutput && task.transparentPrompt
    ? task.transparentPrompt
    : task.prompt
  const promptSentToApi = replaceImageMentionsForApi(requestPrompt, task.inputImageIds.length).trim()
  const showRevisedPrompt = Boolean(currentRevisedPrompt && currentRevisedPrompt !== promptSentToApi)
  const codexCliPromptKey = getCodexCliPromptKey(settings)
  const hasHandledPromptWarning = settings.codexCli || dismissedCodexCliPrompts.includes(codexCliPromptKey)
  const taskProvider = task.apiProvider
  const isOpenAiTask = (taskProvider ?? 'openai') === 'openai'
  const showPromptWarning = Boolean(isOpenAiTask && task.apiMode === 'responses' && currentOutputImageId && (!currentRevisedPrompt || showRevisedPrompt) && !hasHandledPromptWarning)
  const taskProviderName = taskProvider ? getApiProviderLabel(settings, taskProvider) : i18n.t("common.unknown")
  const taskProfileName = task.apiProfileName || '未知'
  const taskModel = task.apiModel || '未知'
  const showSourceInfo = Boolean(task.apiProvider || task.apiProfileName || task.apiModel)
  const isCustomReconnecting = false
  const rawImageUrls = task.rawImageUrls ?? []
  const canRetryDownload = rawImageUrls.some(isHttpUrl) && !task.outputImages.length
  const streamPreviewLen = streamPreviewItems.length
  const currentStreamPreviewSrc = activeStreamPreviewSrc
  const streamPartialImageIds = task.streamPartialImageIds ?? []
  const supportsTransparentOutput = task.params.output_format === 'png' || task.params.output_format === 'webp'
  const transparentOutputText = task.transparentOutput || task.params.transparent_output ? 'true' : 'false'
  const currentTransparentOutputFailed = Boolean(currentOutputImageId && task.transparentOutput && task.transparentOriginalImages?.[currentOutputImageIndex] === '')
  const outputCompressionText = task.params.output_compression == null ? i18n.t("upstreamSync.notSet") : String(task.params.output_compression)

  const formatTime = (ts: number | null) => {
    if (!ts) return ''
    return new Date(ts).toLocaleString('zh-CN')
  }

  const formatDuration = () => {
    if (task.status === 'running' || isCustomReconnecting) {
      const seconds = Math.max(0, Math.floor((now - task.createdAt) / 1000))
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
      const ss = String(seconds % 60).padStart(2, '0')
      return `${mm}:${ss}`
    }
    if (task.elapsed == null) return null
    const seconds = Math.floor(task.elapsed / 1000)
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  const handleReuse = () => {
    reuseConfig(task)
    setDetailTaskId(null)
  }

  const handleEdit = () => {
    editOutputs(task)
    setDetailTaskId(null)
  }

  const handleDelete = () => {
    setDetailTaskId(null)
    setConfirmDialog({
      title: i18n.t("upstreamSync.deleteTask"),
      message: i18n.t("upstreamSync.deleteThisTaskImagesWillAlsoBeRemoved"),
      action: () => removeTask(task),
    })
  }

  const handleToggleFavorite = () => {
    openFavoritePicker([task.id])
  }

  const handleCopyError = async () => {
    const errorText = task.error || '生成失败'
    try {
      await copyTextToClipboard(errorText)
      showToast(i18n.t("detail.errorCopied"), 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage(i18n.t("detail.errorCopyFailed"), err), 'error')
    }
  }

  const handleCopyPrompt = async () => {
    if (!task.prompt) return
    try {
      await copyTextToClipboard(task.prompt)
      showToast(i18n.t("detail.promptCopied"), 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage(i18n.t("detail.promptCopyFailed"), err), 'error')
    }
  }

  const handleShowPromptWarning = () => {
    showCodexCliPrompt(
      true,
      currentRevisedPrompt ? i18n.t("errors.codexCliReasonRewritten") : i18n.t("errors.codexCliReasonMissing"),
    )
  }

  const handleCopyInputImage = async () => {
    const imgId = allInputImageIds[0]
    const src = imgId ? imageSrcs[imgId] : ''
    if (!src) return
    try {
      await copyImageSourceToClipboard(src)
      showToast(i18n.t("detail.referenceCopied"), 'success')
    } catch (err) {
      console.error(err)
      showToast(getClipboardFailureMessage(i18n.t("detail.referenceCopyFailed"), err), 'error')
    }
  }

  const handleDownloadCurrentOutput = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!currentOutputImageId || !task) return

    try {
      const result = await downloadImageIds([currentOutputImageId], `task-${task.id}`)
      if (result.successCount === 0) {
        showToast(i18n.t("contextMenu.downloadFailed"), 'error')
      } else {
        showToast(i18n.t("contextMenu.downloadSuccess"), 'success')
      }
    } catch (err) {
      console.error(err)
      showToast(i18n.t("contextMenu.downloadFailed"), 'error')
    }
  }

  const handleDownloadCurrentOriginalOutput = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!currentOriginalOutputImageId || !task) return

    try {
      const result = await downloadImageIds([currentOriginalOutputImageId], `task-${task.id}-orig`)
      if (result.successCount === 0) {
        showToast(i18n.t("contextMenu.downloadFailed"), 'error')
      } else {
        showToast(i18n.t("upstreamSync.originalImageDownloaded"), 'success')
      }
    } catch (err) {
      console.error(err)
      showToast(i18n.t("contextMenu.downloadFailed"), 'error')
    }
  }

  const handleDownloadAllOutputs = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!task?.outputImages?.length) return

    try {
      const fileNameBase = `task-${task.id}`
      const result = settings.zipDownloadRoutes.includes('task-detail-all')
        ? await downloadImageEntriesAsZip(getImageZipEntries(task.outputImages, fileNameBase), fileNameBase)
        : await downloadImageIds(task.outputImages, fileNameBase)
      if (result.successCount === 0) {
        showToast(i18n.t("contextMenu.downloadFailed"), 'error')
      } else if (result.failCount > 0) {
        showToast(i18n.t('upstreamSync.message1', { value0: result.successCount, value1: result.failCount }), 'error')
      } else {
        showToast(result.successCount > 1 ? i18n.t('upstreamSync.message2', { value0: result.successCount }) : i18n.t("contextMenu.downloadSuccess"), 'success')
      }
    } catch (err) {
      console.error(err)
      showToast(i18n.t("contextMenu.downloadFailed"), 'error')
    }
  }

  const handleDownloadPartialImages = async () => {
    if (!task || !streamPartialImageIds.length) return

    try {
      const fileNameBase = `task-${task.id}-partial`
      const result = settings.zipDownloadRoutes.includes('task-detail-partial')
        ? await downloadImageEntriesAsZip(getImageZipEntries(streamPartialImageIds, fileNameBase), fileNameBase)
        : await downloadImageIds(streamPartialImageIds, fileNameBase)
      if (result.successCount === 0) {
        showToast(i18n.t("contextMenu.downloadFailed"), 'error')
      } else if (result.failCount > 0) {
        showToast(i18n.t('upstreamSync.message1', { value0: result.successCount, value1: result.failCount }), 'error')
      } else {
        showToast(i18n.t('upstreamSync.message4', { value0: result.successCount }), 'success')
      }
    } catch (err) {
      console.error(err)
      showToast(i18n.t("contextMenu.downloadFailed"), 'error')
    }
  }

  const handleRetry = () => {
    retryTask(task)
    if (!canRetryDownload) setDetailTaskId(null)
  }

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={() => setDetailTaskId(null)}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        ref={modalRef}
        className="relative bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col md:flex-row z-10 ring-1 ring-black/5 dark:ring-white/10 animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 items-center justify-end px-4 md:hidden">
          <button
            onClick={() => setDetailTaskId(null)}
            className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/[0.06] transition text-gray-400"
            aria-label={i18n.t("support.closeAria")}
          >
            <CloseIcon className="w-6 h-6" />
          </button>
        </div>

        {/* 左侧：图片 */}
        <div className="md:w-1/2 w-full h-64 md:h-auto bg-gray-100 dark:bg-black/20 relative flex items-center justify-center flex-shrink-0 min-h-[16rem]">
          {task.status === 'done' && outputLen > 0 && (currentOutputImageId || task.outputImages.length > 0) && (
            <div className="absolute right-3 top-[15px] z-20 flex items-center gap-1.5">
              {currentOutputImageId && (
                <div className="relative group flex">
                  <button
                    type="button"
                    {...downloadImageTooltip.handlers}
                    onClick={(e) => {
                      downloadImageTooltip.handlers.onClick()
                      handleDownloadCurrentOutput(e)
                    }}
                      className="flex items-center justify-center px-1.5 py-0.5 bg-black/50 text-white rounded backdrop-blur-sm hover:bg-black/70 transition focus:outline-none focus:ring-1 focus:ring-white/50"
                    aria-label={i18n.t("markdown.downloadImage")}
                  >
                    <DownloadIcon className="h-4 w-4" />
                  </button>
                  <ViewportTooltip visible={downloadImageTooltip.visible} className="whitespace-nowrap">
                    {i18n.t("markdown.downloadImage")}
                  </ViewportTooltip>
                </div>
              )}
              {task.outputImages.length > 1 && (
                <div className="relative group flex">
                  <button
                    type="button"
                    {...downloadAllTooltip.handlers}
                    onClick={(e) => {
                      downloadAllTooltip.handlers.onClick()
                      handleDownloadAllOutputs(e)
                    }}
                    className="flex items-center justify-center pl-1.5 pr-2 py-0.5 gap-0.5 bg-black/50 text-white rounded backdrop-blur-sm hover:bg-black/70 transition focus:outline-none focus:ring-1 focus:ring-white/50"
                    aria-label={i18n.t("contextMenu.downloadAll")}
                  >
                    <DownloadIcon className="h-4 w-4" />
                    <span className="text-[9px] font-bold leading-none mt-[1px]">ALL</span>
                  </button>
                  <ViewportTooltip visible={downloadAllTooltip.visible} className="whitespace-nowrap">
                    {i18n.t("contextMenu.downloadAll")}
                  </ViewportTooltip>
                </div>
              )}
            </div>
          )}
          {task.status === 'done' && outputLen > 0 && currentOutputPreviewSrc && (
            <>
              <img
                src={currentOutputPreviewSrc}
                data-image-id={currentOutputImageId}
                className="saveable-image max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] object-contain cursor-pointer"
                onLoad={(e) => {
                  const image = e.currentTarget
                  if (currentOutputImageId && image.naturalWidth > 0 && image.naturalHeight > 0) {
                    setImageRatios((prev) => ({
                      ...prev,
                      [currentOutputImageId]: formatImageRatio(image.naturalWidth, image.naturalHeight),
                    }))
                    setImageSizes((prev) => ({
                      ...prev,
                      [currentOutputImageId]: `${image.naturalWidth}×${image.naturalHeight}`,
                    }))
                  }
                }}
                onClick={() =>
                  setLightboxImageId(currentOutputImageId, task.outputImages)
                }
                alt=""
              />
              <div data-selectable-text className="absolute left-4 top-[15px] flex items-center gap-1.5">
                {currentImageRatio && currentImageSize ? (
                  <>
                    <span className="bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                      {currentImageRatio}
                    </span>
                    <span className="bg-black/50 text-white/90 text-xs px-2 py-0.5 rounded backdrop-blur-sm font-medium">
                      {currentImageSize}
                    </span>
                  </>
                ) : (
                  formatDuration() && (
                    <span className="flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {formatDuration()}
                    </span>
                  )
                )}
              </div>
              {outputLen > 1 && (
                <>
                  <button
                    onClick={() =>
                      setImageIndex(
                        (imageIndex - 1 + outputLen) % outputLen,
                      )
                    }
                    className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <button
                    onClick={() =>
                      setImageIndex((imageIndex + 1) % outputLen)
                    }
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                  <span className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
                    {imageIndex + 1} / {outputLen}
                  </span>
                </>
              )}
              {currentOriginalOutputImageId && (
                <div className="absolute bottom-4 right-4 z-20 flex">
                  <button
                    type="button"
                    {...downloadOriginalImageTooltip.handlers}
                    onClick={(e) => {
                      downloadOriginalImageTooltip.handlers.onClick()
                      handleDownloadCurrentOriginalOutput(e)
                    }}
                    className="flex items-center justify-center gap-0.5 rounded bg-black/50 py-0.5 pl-1.5 pr-2 text-white backdrop-blur-sm transition hover:bg-black/70 focus:outline-none focus:ring-1 focus:ring-white/50"
                    aria-label={i18n.t("upstreamSync.downloadOriginal")}
                  >
                    <DownloadIcon className="h-4 w-4" />
                    <span className="text-[9px] font-bold leading-none mt-[1px] uppercase">orig</span>
                  </button>
                  <ViewportTooltip visible={downloadOriginalImageTooltip.visible} className="whitespace-nowrap">
                    {i18n.t("upstreamSync.downloadOriginal")}
                  </ViewportTooltip>
                </div>
              )}
            </>
          )}
          {task.status === 'done' && outputLen > 0 && currentOutputError && (
            <div className="w-full max-w-md px-4 text-center">
              <svg className="w-10 h-10 text-red-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-medium text-red-500">{i18n.t("upstreamSync.image")} {currentOutputSlot.requestIndex + 1} {i18n.t("upstreamSync.failed80")}</p>
              <p
                className="mt-2 overflow-hidden whitespace-pre-line text-sm leading-6 text-red-500 break-words"
                style={{
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 8,
                }}
              >
                {currentOutputError}
              </p>
              {outputLen > 1 && (
                <>
                  <button
                    onClick={() => setImageIndex((imageIndex - 1 + outputLen) % outputLen)}
                    className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setImageIndex((imageIndex + 1) % outputLen)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                  <span className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
                    {imageIndex + 1} / {outputLen}
                  </span>
                </>
              )}
            </div>
          )}
          {task.status === 'running' && (
            <>
              <div className="absolute left-4 top-4 flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {formatDuration()}
              </div>
              {task.status === 'running' && streamPreviewLen > 0 && (
                <>
                  {currentStreamPreviewSrc ? (
                    <img
                      src={currentStreamPreviewSrc}
                      className={`max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] object-contain ${streamPreviewLoaded ? '' : 'hidden'}`}
                      alt=""
                      onLoad={() => setStreamPreviewLoaded(true)}
                      onError={() => setStreamPreviewLoaded(false)}
                    />
                  ) : null}
                  {(!currentStreamPreviewSrc || !streamPreviewLoaded) && (
                    <svg className="w-10 h-10 text-[#a28fc9] animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {streamPreviewLoaded && (
                    <span className="absolute top-4 right-4 flex items-center gap-1 rounded bg-[#9181bd] px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
                      {i18n.t("detail.streamPreview")}
                    </span>
                  )}
                  {streamPreviewLen > 1 && (
                    <>
                      <button
                        onClick={() => setImageIndex((imageIndex - 1 + streamPreviewLen) % streamPreviewLen)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setImageIndex((imageIndex + 1) % streamPreviewLen)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <span className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
                        {imageIndex + 1} / {streamPreviewLen}
                      </span>
                    </>
                  )}
                </>
              )}
              {task.status === 'running' && streamPreviewLen === 0 && (
                <svg className="w-10 h-10 text-[#a28fc9] animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
            </>
          )}
          {task.status === 'error' && (
            <div className="w-full max-w-md px-4 text-center">
              <svg className="w-10 h-10 text-red-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p
                className="overflow-hidden whitespace-pre-line text-sm leading-6 text-red-500 break-words"
                style={{
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 10,
                }}
              >
                {resolveErrorForDisplay(task.error, i18n.t('errors.noImagePayload'))}
              </p>
              <RemoteImageResults urls={rawImageUrls} />
              <div className="mt-3 flex items-center justify-center gap-2">
                <div className="relative group">
                  <button
                    type="button"
                    {...copyErrorTooltip.handlers}
                    onClick={() => {
                      copyErrorTooltip.handlers.onClick()
                      handleCopyError()
                    }}
                    className="inline-flex items-center justify-center rounded-full border border-red-200/80 bg-white/80 px-3 py-1.5 text-red-500 transition hover:bg-red-50 dark:border-red-400/20 dark:bg-white/[0.04] dark:hover:bg-red-500/10"
                    aria-label={i18n.t("detail.copyError")}
                  >
                    <CopyIcon className="h-4 w-4" />
                  </button>
                  <ViewportTooltip visible={copyErrorTooltip.visible} className="whitespace-nowrap">
                    {i18n.t("detail.copyError")}
                  </ViewportTooltip>
                </div>
                {task.rawResponsePayload && (
                  <div className="relative group">
                    <button
                      type="button"
                      {...viewRawResponseTooltip.handlers}
                      onClick={() => {
                        dismissAllTooltips()
                        setShowRawResponseModal(true)
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-purple-200/80 bg-purple-50 px-3 py-1.5 text-purple-600 transition hover:bg-purple-100 dark:border-purple-500/20 dark:bg-purple-500/10 dark:text-purple-400 dark:hover:bg-purple-500/20"
                      aria-label={i18n.t("detail.viewRawResponse")}
                    >
                      <CodeIcon className="h-4 w-4" />
                    </button>
                    <ViewportTooltip visible={viewRawResponseTooltip.visible} className="whitespace-nowrap">
                      {i18n.t("detail.viewRawResponse")}
                    </ViewportTooltip>
                  </div>
                )}
                {task.rawImageUrls && task.rawImageUrls.length > 0 && (
                  <div className="relative group">
                    <button
                      type="button"
                      {...copyRawUrlsTooltip.handlers}
                      onClick={async () => {
                        if (task.rawImageUrls!.length === 1) {
                          copyRawUrlsTooltip.handlers.onClick()
                          try {
                            await copyTextToClipboard(task.rawImageUrls![0])
                            showToast(i18n.t("detail.linkCopied"), 'success')
                          } catch (err) {
                            showToast(getClipboardFailureMessage(i18n.t("detail.linkCopyFailed"), err), 'error')
                          }
                        } else {
                          dismissAllTooltips()
                          setShowRawUrlsModal(true)
                        }
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-green-200/80 bg-green-50 px-3 py-1.5 text-green-600 transition hover:bg-green-100 dark:border-green-500/20 dark:bg-green-500/10 dark:text-green-400 dark:hover:bg-green-500/20"
                      aria-label={i18n.t("detail.copyImageLinks")}
                    >
                      <LinkIcon className="h-4 w-4" />
                    </button>
                    <ViewportTooltip visible={copyRawUrlsTooltip.visible} className="whitespace-nowrap">
                      {i18n.t("detail.copyImageLinks")}
                    </ViewportTooltip>
                  </div>
                )}
                {streamPartialImageIds.length > 0 && (
                  <div className="relative group">
                    <button
                      type="button"
                      {...downloadPartialImagesTooltip.handlers}
                      onClick={() => {
                        downloadPartialImagesTooltip.handlers.onClick()
                        void handleDownloadPartialImages()
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-amber-200/80 bg-amber-50 px-3 py-1.5 text-amber-600 transition hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400 dark:hover:bg-amber-500/20"
                      aria-label={i18n.t("detail.downloadPartial")}
                    >
                      <DownloadIcon className="h-4 w-4" />
                    </button>
                    <ViewportTooltip visible={downloadPartialImagesTooltip.visible} className="whitespace-nowrap">
                      {i18n.t("detail.downloadPartial")}
                    </ViewportTooltip>
                  </div>
                )}
                <div className="relative group">
                  <button
                    type="button"
                    {...retryTooltip.handlers}
                    onClick={() => {
                      retryTooltip.handlers.onClick()
                      handleRetry()
                    }}
                    className="inline-flex items-center justify-center rounded-full border border-[#d4c5ec]/80 bg-white/80 px-3 py-1.5 text-[#9181bd] transition hover:bg-[#f1edf8] dark:border-[#a28fc9]/20 dark:bg-white/[0.04] dark:hover:bg-[#9181bd]/10"
                    aria-label={i18n.t(canRetryDownload ? 'detail.retryDownload' : 'detail.retry')}
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                  <ViewportTooltip visible={retryTooltip.visible} className="whitespace-nowrap">
                    {i18n.t(canRetryDownload ? 'detail.retryDownload' : 'detail.retry')}
                  </ViewportTooltip>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 右侧：信息 */}
        <div className="md:w-1/2 w-full p-5 overflow-y-auto overscroll-contain flex flex-col">
          <button
            onClick={() => setDetailTaskId(null)}
            className="absolute top-3 right-3 hidden p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/[0.06] transition text-gray-400 z-10 md:block"
            aria-label={i18n.t("support.closeAria")}
          >
            <CloseIcon className="w-5 h-5" />
          </button>

          <div data-selectable-text className="flex-1">
            <div className="flex items-center gap-1.5 mb-2">
              <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                {i18n.t("detail.input")}
              </h3>
              {task.prompt && !showPendingPrompt && (
                <button
                  onClick={handleCopyPrompt}
                  className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:text-gray-500 dark:hover:bg-white/[0.06] transition"
                  title={i18n.t("agent.copyPrompt")}
                >
                  <CopyIcon className="h-4 w-4" />
                </button>
              )}
              {showPromptWarning && (
                <span className="relative inline-flex">
                  <button
                    type="button"
                    className="p-1 rounded text-amber-500 hover:bg-amber-50 dark:text-yellow-300 dark:hover:bg-yellow-500/10 transition"
                    onClick={handleShowPromptWarning}
                    aria-label={i18n.t("detail.promptRewritten")}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    </svg>
                  </button>
                </span>
              )}
            </div>
            {showPendingPrompt ? (
              <div className="mb-4 leading-relaxed">
                <p className="text-sm text-gray-700 dark:text-gray-300">{i18n.t("tasks.pending")}</p>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{i18n.t("tasks.pendingHint")}</p>
              </div>
            ) : (
              <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap mb-4">
                {task.prompt || '(无提示词)'}
              </p>
            )}
            {showRevisedPrompt && currentRevisedPrompt && (
              <div className="mb-4">
                <ActualValueBadge
                  value={currentRevisedPrompt}
                  className="max-w-full rounded px-2 py-1 text-left text-xs leading-relaxed whitespace-pre-wrap"
                />
              </div>
            )}

            {/* 参考图 */}
            {showReferenceSection && (
              <div className="mb-4">
                <div className="flex items-center gap-1.5 mb-2">
                  <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                    {i18n.t("detail.referenceImages")}
                  </h3>
                  {allInputImageIds.length > 0 && (
                    <button
                      onClick={handleCopyInputImage}
                      className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:text-gray-500 dark:hover:bg-white/[0.06] transition"
                      title={i18n.t("upstreamSync.copyReferenceImage")}
                    >
                      <CopyIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {allInputImageIds.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {allInputImageIds.map((imgId) => {
                      const isMaskTarget = imgId === maskTargetId
                      const displaySrc = (isMaskTarget && maskPreviewSrc) ? maskPreviewSrc : (imageSrcs[imgId] || '')
                      return (
                        <div key={imgId} className="relative group inline-block">
                          <div
                            className={`relative w-16 h-16 rounded-lg overflow-hidden border cursor-pointer hover:opacity-80 transition ${
                              isMaskTarget ? 'border-[#9181bd] border-2 shadow-sm' : 'border-gray-200 dark:border-white/[0.08]'
                            }`}
                            onClick={() => setLightboxImageId(imgId, allInputImageIds)}
                          >
                            {displaySrc && (
                              <img
                                src={displaySrc}
                                data-image-id={imgId}
                                className="w-full h-full object-cover"
                                alt=""
                              />
                            )}
                            {isMaskTarget && (
                              <span className="absolute left-1 top-1 rounded bg-[#9181bd]/90 px-1.5 py-0.5 text-[8px] leading-none text-white font-bold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
                                MASK
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                {isAgentTask && (
                  <div className={`${allInputImageIds.length > 0 ? 'mt-2 ' : ''}text-xs text-gray-500 dark:text-gray-400`}>
                    {allInputImageIds.length > 0 ? i18n.t("detail.referenceMaybeMore") : i18n.t("detail.referenceModelChosen")}
                  </div>
                )}
              </div>
            )}

            {/* 参数 */}
            <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
              {i18n.t("detail.params")}
            </h3>
            {showSourceInfo && (
              <div className="mb-2 min-w-0 overflow-hidden rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-white/[0.03]">
                <span className="text-gray-400 dark:text-gray-500">{i18n.t("detail.source")}</span>
                <br />
                <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                  <span className="font-medium text-gray-700 dark:text-gray-200">{taskProviderName}</span>
                  <span className="text-gray-400 dark:text-gray-500"> · {taskProfileName} · {taskModel}</span>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-xs mb-4 min-w-0">
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                <span className="text-gray-400 dark:text-gray-500">{i18n.t("detail.size")}</span>
                <br />
                <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                  <DetailParamValue task={task} paramKey="size" className="font-medium" actualParams={currentActualParams} />
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                <span className="text-gray-400 dark:text-gray-500">{i18n.t("detail.quality")}</span>
                <br />
                <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                  <DetailParamValue task={task} paramKey="quality" className="font-medium" actualParams={currentActualParams} />
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                <span className="text-gray-400 dark:text-gray-500">{i18n.t("detail.format")}</span>
                <br />
                <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                  <DetailParamValue task={task} paramKey="output_format" className="font-medium" actualParams={currentActualParams} />
                </div>
              </div>
              {supportsTransparentOutput && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                  <span className="text-gray-400 dark:text-gray-500">{i18n.t("upstreamSync.transparentBackground")}</span>
                  <br />
                  <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                    <span className="font-medium text-gray-700 dark:text-gray-300">{transparentOutputText}</span>
                    {currentTransparentOutputFailed && (
                      <span className="ml-1.5 rounded bg-red-50 px-1 py-0.5 text-[10px] font-medium uppercase leading-none text-red-600 dark:bg-red-500/10 dark:text-red-400">
                        failed
                      </span>
                    )}
                  </div>
                </div>
              )}
              {task.params.output_format !== 'png' && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                  <span className="text-gray-400 dark:text-gray-500">{i18n.t("detail.compression")}</span>
                  <br />
                  <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                    <span className="font-medium text-gray-700 dark:text-gray-300">{outputCompressionText}</span>
                  </div>
                </div>
              )}
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                <span className="text-gray-400 dark:text-gray-500">{i18n.t("detail.moderation")}</span>
                <br />
                <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                  <DetailParamValue task={task} paramKey="moderation" className="font-medium" actualParams={currentActualParams} />
                </div>
              </div>
              {!isAgentTask && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                  <span className="text-gray-400 dark:text-gray-500">{i18n.t("detail.count")}</span>
                  <br />
                  <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                    <DetailParamValue task={task} paramKey="n" className="font-medium" />
                  </div>
                </div>
              )}
            </div>

            {/* 时间 */}
            <div className="text-xs text-gray-400 dark:text-gray-500 mb-4">
              <span>{i18n.t("upstreamSync.created")} {formatTime(task.createdAt)}</span>
              {formatDuration() && <span> {i18n.t("upstreamSync.duration")} {formatDuration()}</span>}
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="grid grid-cols-4 sm:flex gap-2 pt-4 border-t border-gray-100 dark:border-white/[0.08]">
            <button
              onClick={handleReuse}
              className="col-span-2 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[#f1edf8] dark:bg-[#9181bd]/10 text-[#7e6aa9] dark:text-[#a28fc9] hover:bg-[#e4d9f5] dark:hover:bg-[#9181bd]/20 transition text-sm font-medium whitespace-nowrap"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              {i18n.t("detail.reuseConfig")}
            </button>
            <button
              onClick={handleEdit}
              disabled={!outputLen}
              className="col-span-2 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition text-sm font-medium whitespace-nowrap"
            >
              <EditIcon className="w-4 h-4 flex-shrink-0" />
              {i18n.t("detail.editOutputs")}
            </button>
            <button
              onClick={handleDelete}
              className="col-span-3 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 transition text-sm font-medium whitespace-nowrap"
            >
              <TrashIcon className="w-4 h-4 flex-shrink-0" />
              {i18n.t("upstreamSync.deleteTask")}
            </button>
            <button
              onClick={handleToggleFavorite}
              className={`col-span-1 sm:flex-none sm:w-11 w-full flex items-center justify-center rounded-xl transition ${
                task.isFavorite
                  ? 'bg-yellow-50 text-yellow-500 hover:bg-yellow-100 dark:bg-yellow-500/10 dark:hover:bg-yellow-500/20'
                  : 'bg-gray-50 text-gray-400 hover:bg-yellow-50 hover:text-yellow-500 dark:bg-white/[0.04] dark:hover:bg-yellow-500/10'
              }`}
              title={task.isFavorite ? i18n.t("upstreamSync.editCollections") : i18n.t("upstreamSync.favoriteTask")}
            >
              <svg className="w-5 h-5" fill={task.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {showRawUrlsModal && rawImageUrls.length > 0 && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm sm:p-6"
          onPointerDown={(e) => {
            rawUrlsBackdropPointerDownRef.current = e.target === e.currentTarget
          }}
          onClick={(e) => {
            e.stopPropagation()
            if (rawUrlsBackdropPointerDownRef.current && e.target === e.currentTarget) setShowRawUrlsModal(false)
            rawUrlsBackdropPointerDownRef.current = false
          }}
        >
          <div ref={rawUrlsModalRef} className="flex w-full max-w-2xl max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-[#1c1c1e]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-white/[0.08] shrink-0">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">{i18n.t("upstreamSync.originalImageUrls")}{rawImageUrls.length})</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await copyTextToClipboard(rawImageUrls.join('\n'))
                      showToast(i18n.t("detail.copySuccess"), 'success')
                    } catch (err) {
                      showToast(getClipboardFailureMessage(i18n.t("contextMenu.copyFailed"), err), 'error')
                    }
                  }}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-white/[0.04] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors text-xs font-medium"
                >
                  <CopyIcon className="w-3.5 h-3.5" />
                  {i18n.t("detail.copyAll")}
                </button>
                <button
                  type="button"
                  onClick={() => setShowRawUrlsModal(false)}
                  className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-500 dark:hover:bg-white/[0.08] dark:hover:text-gray-300 transition-colors"
                >
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-5 bg-gray-50/50 dark:bg-black/20 overscroll-contain">
              <div className="space-y-2.5">
                {rawImageUrls.map((url, i) => (
                  <div key={i} className="group flex items-center gap-3 p-3 sm:p-4 rounded-xl bg-white dark:bg-[#1c1c1e] border border-gray-100 dark:border-white/[0.06] shadow-sm hover:shadow-md transition-all">
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      <div className="text-xs font-medium text-gray-400 dark:text-gray-500">
                        {i18n.t("common.image")} {i + 1}
                      </div>
                      <div className="text-sm text-gray-700 dark:text-gray-300 truncate select-text" title={url}>
                        {url}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await copyTextToClipboard(url)
                          showToast(i18n.t("detail.copySuccess"), 'success')
                        } catch (err) {
                          showToast(getClipboardFailureMessage(i18n.t("contextMenu.copyFailed"), err), 'error')
                        }
                      }}
                      className="flex-shrink-0 p-2 sm:px-3 sm:py-1.5 flex items-center justify-center gap-1.5 rounded-lg bg-gray-50 dark:bg-white/[0.04] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors text-xs font-medium border border-transparent dark:border-white/[0.04]"
                      title={i18n.t("markdown.copyLink")}
                    >
                      <CopyIcon className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                      <span className="hidden sm:inline">{i18n.t("contextMenu.copy")}</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showRawResponseModal && task?.rawResponsePayload && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm sm:p-6"
          onPointerDown={(e) => {
            rawResponseBackdropPointerDownRef.current = e.target === e.currentTarget
          }}
          onClick={(e) => {
            e.stopPropagation()
            if (rawResponseBackdropPointerDownRef.current && e.target === e.currentTarget) setShowRawResponseModal(false)
            rawResponseBackdropPointerDownRef.current = false
          }}
        >
          <div
            ref={rawResponseModalRef}
            className="flex w-full max-w-3xl max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-[#1c1c1e]"
            onPointerDown={(e) => {
              if (!(e.target as Element).closest('[data-selectable-text]')) clearTextSelection()
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-white/[0.08] shrink-0">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">{i18n.t("detail.rawResponseTitle")}</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await copyTextToClipboard(task.rawResponsePayload!)
                      showToast(i18n.t("detail.copySuccess"), 'success')
                    } catch (err) {
                      showToast(getClipboardFailureMessage(i18n.t("contextMenu.copyFailed"), err), 'error')
                    }
                  }}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-white/[0.04] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors text-xs font-medium"
                >
                  <CopyIcon className="w-3.5 h-3.5" />
                  {i18n.t("detail.copyAll")}
                </button>
                <button
                  type="button"
                  onClick={() => setShowRawResponseModal(false)}
                  className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-500 dark:hover:bg-white/[0.08] dark:hover:text-gray-300 transition-colors"
                >
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 bg-gray-50/50 dark:bg-black/20 overscroll-contain">
              <pre data-selectable-text className="text-[11px] sm:text-xs text-gray-600 dark:text-gray-300 font-mono whitespace-pre-wrap break-all select-text">
                {task.rawResponsePayload.replace(/"(b64_json|base64|data)":\s*"[^"]+"/g, '"$1": "<base64_data>"')}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
