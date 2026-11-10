import i18n from '../lib/i18n'
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../store'
import { canvasToBlob, loadImage } from '../lib/canvasImage'
import { blobToDataUrl } from '../lib/dataUrl'
import { storeImage } from '../lib/db'
import { ensureImageCached } from '../lib/imageCache'
import { prepareMaskTargetDataUrl, replaceMaskTargetImage } from '../lib/maskPreprocess'
import { clientPointToCanvasPoint, getComfortableInitialTransform, type Point } from '../lib/viewportTransform'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { useEditorViewport } from '../hooks/useEditorViewport'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { useTooltip } from '../hooks/useTooltip'
import { TooltipButton } from './TooltipButton'
import ViewportTooltip from './ViewportTooltip'
import {
  BrushCursor,
  CheckIcon,
  ClearIcon,
  EDITOR_ICON_BUTTON_CLASS,
  EditorResetViewButton,
  EditorShell,
  EditorSizeSlider,
  EditorTopBar,
  EraserIcon,
  PenIcon,
  RedoIcon,
  UndoIcon,
} from './editor/EditorControls'
import { CloseIcon } from './icons'

type Tool = 'brush' | 'eraser'

interface CanvasSize {
  width: number
  height: number
}

function getCanvasPoint(canvas: HTMLCanvasElement, event: ReactPointerEvent<HTMLElement>): Point {
  return clientPointToCanvasPoint(
    canvas.getBoundingClientRect(),
    { x: event.clientX, y: event.clientY },
    { width: canvas.width, height: canvas.height },
  )
}

function fillWhiteMask(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error(i18n.t("mask.canvasUnsupported"))
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

function drawMaskImageToCanvas(maskImage: HTMLImageElement, maskCanvas: HTMLCanvasElement) {
  const maskAspect = maskImage.naturalWidth / maskImage.naturalHeight
  const canvasAspect = maskCanvas.width / maskCanvas.height
  if (Math.abs(maskAspect - canvasAspect) > 0.001) {
    throw new Error(i18n.t("mask.maskSizeMismatch"))
  }

  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!maskCtx) throw new Error(i18n.t("mask.canvasUnsupported"))
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
  maskCtx.imageSmoothingEnabled = true
  maskCtx.imageSmoothingQuality = 'high'
  maskCtx.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height)
}

export default function MaskEditorModal() {
  const imageId = useStore((s) => s.maskEditorImageId)
  if (!imageId) return null
  // 以图片 id 作为 key，每次打开都是全新的编辑状态
  return <MaskEditor key={imageId} imageId={imageId} />
}

function MaskEditor({ imageId }: { imageId: string }) {
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const maskDraft = useStore((s) => s.maskDraft)
  const setMaskDraft = useStore((s) => s.setMaskDraft)
  const clearMaskDraft = useStore((s) => s.clearMaskDraft)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)

  const imageCanvasRef = useRef<HTMLCanvasElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const baseFrameRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const activePointerIdRef = useRef<number | null>(null)
  const lastPointRef = useRef<Point | null>(null)
  const undoStackRef = useRef<ImageData[]>([])
  const redoStackRef = useRef<ImageData[]>([])
  const previewFrameRef = useRef<number | null>(null)
  const saveTokenRef = useRef(0)

  const [sourceDataUrl, setSourceDataUrl] = useState('')
  const [size, setSize] = useState<CanvasSize | null>(null)
  const [tool, setTool] = useState<Tool>('brush')
  const [brushSize, setBrushSize] = useState(64)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 })
  const [hoverPoint, setHoverPoint] = useState<Point | null>(null)
  const [isAdjustingSize, setIsAdjustingSize] = useState(false)

  const viewport = useEditorViewport(baseFrameRef, viewRef, Boolean(size))
  const infoTooltip = useTooltip()

  const close = () => {
    if (isSaving) return
    setMaskEditorImageId(null)
  }
  useCloseOnEscape(true, close)
  usePreventBackgroundScroll(true)

  const handleRemoveMask = () => {
    setConfirmDialog({
      title: i18n.t("mask.removeButton"),
      message: i18n.t("mask.removeMessage"),
      tone: 'danger',
      action: () => {
        clearMaskDraft()
        setMaskEditorImageId(null)
        showToast(i18n.t("mask.removed"), 'success')
      },
    })
  }

  function resetViewTransform() {
    const frame = baseFrameRef.current!
    const stage = stageRef.current!
    viewport.commit(getComfortableInitialTransform(
      { width: frame.clientWidth, height: frame.clientHeight },
      { width: stage.clientWidth, height: stage.clientHeight },
      window.matchMedia('(max-width: 1023px)').matches,
    ))
  }

  function syncHistoryState() {
    setHistoryState({
      undo: undoStackRef.current.length,
      redo: redoStackRef.current.length,
    })
  }

  function renderPreviewNow() {
    const maskCanvas = maskCanvasRef.current
    const previewCanvas = previewCanvasRef.current
    if (!maskCanvas || !previewCanvas) return

    const previewCtx = previewCanvas.getContext('2d')
    if (!previewCtx) return

    previewFrameRef.current = null
    previewCtx.save()
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height)
    previewCtx.globalCompositeOperation = 'source-over'
    previewCtx.fillStyle = 'rgba(59, 130, 246, 0.58)'
    previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height)
    previewCtx.globalCompositeOperation = 'destination-out'
    previewCtx.drawImage(maskCanvas, 0, 0)
    previewCtx.restore()
  }

  function renderPreview() {
    if (previewFrameRef.current != null) return
    previewFrameRef.current = window.requestAnimationFrame(renderPreviewNow)
  }

  function pushUndoSnapshot() {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !ctx) return

    undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height))
    if (undoStackRef.current.length > 40) undoStackRef.current.shift()
    redoStackRef.current = []
    syncHistoryState()
  }

  function restoreMask(imageData: ImageData) {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !ctx) return

    ctx.putImageData(imageData, 0, 0)
    renderPreview()
  }

  function cancelActiveStroke() {
    if (activePointerIdRef.current == null) return

    const previous = undoStackRef.current.pop()
    if (previous) restoreMask(previous)
    activePointerIdRef.current = null
    lastPointRef.current = null
    syncHistoryState()
  }

  function drawAt(point: Point) {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    ctx.save()
    ctx.globalCompositeOperation = tool === 'brush' ? 'destination-out' : 'source-over'
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(point.x, point.y, brushSize / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    renderPreview()
  }

  function drawStroke(from: Point, to: Point) {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    ctx.save()
    ctx.globalCompositeOperation = tool === 'brush' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = brushSize
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    ctx.restore()
    renderPreview()
  }

  // 关闭后丢弃仍在进行的保存结果
  useEffect(() => () => {
    saveTokenRef.current++
  }, [])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setSourceDataUrl('')
    setSize(null)
    undoStackRef.current = []
    redoStackRef.current = []
    syncHistoryState()

    async function loadCanvases() {
      try {
        const dataUrl = await ensureImageCached(imageId)
        if (cancelled) return
        if (!dataUrl) {
          showToast(i18n.t("mask.imageMissing"), 'error')
          setMaskEditorImageId(null)
          return
        }

        const preparedTarget = await prepareMaskTargetDataUrl(dataUrl)
        const image = await loadImage(preparedTarget.dataUrl)
        if (cancelled) return

        const nextSize = { width: preparedTarget.width, height: preparedTarget.height }
        const imageCanvas = imageCanvasRef.current
        const previewCanvas = previewCanvasRef.current
        const maskCanvas = maskCanvasRef.current
        if (!imageCanvas || !previewCanvas || !maskCanvas) return

        for (const canvas of [imageCanvas, previewCanvas, maskCanvas]) {
          canvas.width = nextSize.width
          canvas.height = nextSize.height
        }

        const imageCtx = imageCanvas.getContext('2d')
        if (!imageCtx) throw new Error(i18n.t("mask.canvasUnsupported"))
        imageCtx.clearRect(0, 0, imageCanvas.width, imageCanvas.height)
        imageCtx.drawImage(image, 0, 0)

        fillWhiteMask(maskCanvas)

        if (maskDraft?.targetImageId === imageId) {
          try {
            const draftImage = await loadImage(maskDraft.maskDataUrl)
            if (cancelled) return
            drawMaskImageToCanvas(draftImage, maskCanvas)
          } catch (err) {
            fillWhiteMask(maskCanvas)
            showToast(
              i18n.t('upstreamSync.message13', { value0: err instanceof Error ? err.message : String(err) }),
              'error',
            )
          }
        }

        renderPreview()
        setSourceDataUrl(preparedTarget.dataUrl)
        setSize(nextSize)
        if (preparedTarget.wasResized) {
          showToast(
            i18n.t('upstreamSync.message14', { value0: preparedTarget.originalWidth, value1: preparedTarget.originalHeight, value2: preparedTarget.width, value3: preparedTarget.height }),
            'info',
          )
        }
        requestAnimationFrame(() => {
          if (!cancelled) resetViewTransform()
        })
      } catch (err) {
        if (!cancelled) {
          showToast(err instanceof Error ? err.message : String(err), 'error')
          setMaskEditorImageId(null)
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadCanvases()

    return () => {
      cancelled = true
      if (previewFrameRef.current != null) {
        window.cancelAnimationFrame(previewFrameRef.current)
        previewFrameRef.current = null
      }
      activePointerIdRef.current = null
      lastPointRef.current = null
    }
  }, [imageId, maskDraft, setMaskEditorImageId, showToast])

  const isReady = Boolean(sourceDataUrl && size && !isLoading)
  const canUndo = historyState.undo > 0 && isReady && !isSaving
  const canRedo = historyState.redo > 0 && isReady && !isSaving
  const hasMask = maskDraft?.targetImageId === imageId
  // 屏幕像素与遮罩像素的换算比例，包含缩放
  const viewScale = size ? (viewport.frameWidth / size.width) * viewport.transform.scale : 0

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const canvas = maskCanvasRef.current
    if (!canvas || !isReady || isSaving || (event.pointerType !== 'touch' && event.button !== 0)) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)

    const viewportGesture = viewport.pointerDown(event)
    if (viewportGesture === 'pan') return
    if (viewportGesture === 'pinch') {
      cancelActiveStroke()
      return
    }
    if (viewport.isPinching() || activePointerIdRef.current != null) return

    activePointerIdRef.current = event.pointerId
    pushUndoSnapshot()
    const point = getCanvasPoint(canvas, event)
    lastPointRef.current = point
    drawAt(point)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const canvas = maskCanvasRef.current
    if (!canvas) return
    const point = getCanvasPoint(canvas, event)
    if (event.pointerType !== 'touch') setHoverPoint(point)
    if (viewport.pointerMove(event)) {
      event.preventDefault()
      return
    }
    if (activePointerIdRef.current !== event.pointerId || !lastPointRef.current || !isReady || isSaving) return
    event.preventDefault()
    drawStroke(lastPointRef.current, point)
    lastPointRef.current = point
  }

  const finishStroke = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    viewport.pointerUp(event)
    if (activePointerIdRef.current === event.pointerId) {
      activePointerIdRef.current = null
      lastPointRef.current = null
    }
  }

  const handleUndo = () => {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    const previous = undoStackRef.current.pop()
    if (!canvas || !ctx || !previous) return

    redoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height))
    restoreMask(previous)
    syncHistoryState()
  }

  const handleRedo = () => {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    const next = redoStackRef.current.pop()
    if (!canvas || !ctx || !next) return

    undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height))
    restoreMask(next)
    syncHistoryState()
  }

  const handleClear = () => {
    const canvas = maskCanvasRef.current
    if (!canvas || !isReady || isSaving) return

    pushUndoSnapshot()
    fillWhiteMask(canvas)
    renderPreview()
  }

  const handleSave = async () => {
    const canvas = maskCanvasRef.current
    if (!canvas || !sourceDataUrl || !isReady || isSaving) return

    const token = ++saveTokenRef.current
    try {
      setIsSaving(true)
      const blob = await canvasToBlob(canvas, 'image/png')
      const maskDataUrl = await blobToDataUrl(blob)
      const workingTargetId = await storeImage(sourceDataUrl, 'upload')
      if (saveTokenRef.current !== token) return

      const latestStore = useStore.getState()
      latestStore.setInputImages(
        replaceMaskTargetImage(latestStore.inputImages, imageId, {
          id: workingTargetId,
          dataUrl: sourceDataUrl,
        }),
        { equivalentImageIds: { [imageId]: workingTargetId } },
      )
      setMaskDraft({
        targetImageId: workingTargetId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
      setMaskEditorImageId(null)
      showToast(i18n.t("mask.saved"), 'success')
    } catch (err) {
      if (saveTokenRef.current !== token) return
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      if (saveTokenRef.current === token) setIsSaving(false)
    }
  }

  // 笔刷范围预览；调节大小且指针不在画布上时显示在可见区域中心，放大后也能看到
  const brushPoint = !size || viewport.isAltPressed
    ? null
    : isAdjustingSize
    ? hoverPoint ?? viewport.getVisibleCenter(viewport.frameWidth / size.width)
    : hoverPoint
  const canvasCursor = viewport.isPanning ? 'grabbing' : viewport.isAltPressed ? 'grab' : brushPoint ? 'none' : 'crosshair'

  const toolButtonClass = (active: boolean) =>
    `flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-xl transition-colors disabled:opacity-40 ${
      active
        ? 'bg-white text-[#9181bd] shadow-sm dark:bg-[#323338] dark:text-[#a28fc9] dark:shadow-none'
        : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100'
    }`

  return (
    <EditorShell onBackdropClick={close}>
      <EditorTopBar
        left={
          <TooltipButton tooltip={i18n.t('mask.cancel')} className={EDITOR_ICON_BUTTON_CLASS} disabled={isSaving} onClick={close}>
            <CloseIcon className="h-5 w-5" />
          </TooltipButton>
        }
        center={
          <>
            <TooltipButton tooltip={i18n.t('mask.brush')} className={toolButtonClass(tool === 'brush')} disabled={!isReady || isSaving} onClick={() => setTool('brush')}>
              <PenIcon />
            </TooltipButton>
            <TooltipButton tooltip={i18n.t('mask.eraser')} className={toolButtonClass(tool === 'eraser')} disabled={!isReady || isSaving} onClick={() => setTool('eraser')}>
              <EraserIcon />
            </TooltipButton>
          </>
        }
        right={
          <>
            <TooltipButton tooltip={i18n.t('mask.undo')} className={EDITOR_ICON_BUTTON_CLASS} disabled={!canUndo} onClick={handleUndo}>
              <UndoIcon />
            </TooltipButton>
            <TooltipButton tooltip={i18n.t('mask.redo')} className={EDITOR_ICON_BUTTON_CLASS} disabled={!canRedo} onClick={handleRedo}>
              <RedoIcon />
            </TooltipButton>
            <TooltipButton tooltip={i18n.t('mask.clear')} wrapperClassName="relative hidden sm:inline-flex" className={EDITOR_ICON_BUTTON_CLASS} disabled={!isReady || isSaving} onClick={handleClear}>
              <ClearIcon />
            </TooltipButton>
          </>
        }
      />

      {/* 画布区域：整个区域都是缩放视口，放大后图片可铺满 */}
      <div ref={stageRef} className="relative min-h-0 flex-1 bg-gray-100/70 dark:bg-black/25">
        <div
          ref={viewRef}
          className="absolute inset-0 flex touch-none select-none items-center justify-center overflow-hidden py-4 pl-16 pr-4 sm:px-20 sm:py-6"
          style={{ containerType: 'size', cursor: canvasCursor }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onLostPointerCapture={finishStroke}
          onPointerLeave={() => setHoverPoint(null)}
        >
          <div
            ref={baseFrameRef}
            className="relative max-h-full max-w-full"
            style={{
              aspectRatio: size ? `${size.width} / ${size.height}` : '1 / 1',
              width: size ? `min(100%, 100cqh * ${size.width / size.height})` : '520px',
              visibility: size ? 'visible' : 'hidden',
            }}
          >
            <div
              className="absolute inset-0 overflow-hidden rounded-lg shadow-sm ring-1 ring-black/5 will-change-transform dark:ring-white/10"
              style={{
                transform: `matrix(${viewport.transform.scale}, 0, 0, ${viewport.transform.scale}, ${viewport.transform.x}, ${viewport.transform.y})`,
                transformOrigin: '0 0',
              }}
            >
              <canvas ref={imageCanvasRef} className="absolute inset-0 h-full w-full" />
              <canvas ref={previewCanvasRef} className="absolute inset-0 h-full w-full" />
              <canvas ref={maskCanvasRef} className="absolute inset-0 h-full w-full opacity-0" />
            </div>
            {brushPoint && (
              <BrushCursor
                x={brushPoint.x * viewScale + viewport.transform.x}
                y={brushPoint.y * viewScale + viewport.transform.y}
                size={brushSize * viewScale}
              />
            )}
          </div>
        </div>
        {isLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            {i18n.t('mask.loading')}
          </div>
        )}

        <EditorSizeSlider
          value={brushSize}
          min={8}
          max={220}
          label={i18n.t('mask.brushSize')}
          disabled={!isReady || isSaving}
          onChange={setBrushSize}
          onAdjustStart={() => setIsAdjustingSize(true)}
          onAdjustEnd={() => setIsAdjustingSize(false)}
        />

        {viewport.isZoomed && <EditorResetViewButton onClick={resetViewTransform} />}
      </div>

      {/* 底部说明与操作 */}
      <div className="flex flex-none items-center justify-between gap-3 px-3 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-1.5 pl-1">
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">{i18n.t('mask.title')}</span>
          <span className="relative inline-flex" {...infoTooltip.handlers}>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-white/[0.08] dark:hover:text-gray-300"
              aria-label={i18n.t('mask.infoAria')}
              onClick={infoTooltip.show}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
            <ViewportTooltip visible={infoTooltip.visible} className="w-64 leading-5">
              <p>{i18n.t('mask.infoLine1')}</p>
              <p className="mt-1.5">{i18n.t('mask.infoLine2')}</p>
            </ViewportTooltip>
          </span>
        </div>
        <div className="flex flex-none items-center gap-2">
          {hasMask && (
            <button onClick={handleRemoveMask} disabled={isSaving} className="flex h-10 items-center rounded-xl bg-gray-100 px-4 text-sm font-medium text-gray-700 transition hover:bg-red-500/[0.1] hover:text-red-600 disabled:opacity-50 dark:bg-white/[0.08] dark:text-gray-300 dark:hover:bg-red-500/20 dark:hover:text-red-400">
              {i18n.t('mask.removeButton')}
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!isReady || isSaving}
            className="flex h-10 items-center gap-1.5 rounded-xl bg-[#9181bd] px-4 text-sm font-medium text-white shadow-sm transition hover:bg-[#7e6aa9] active:bg-[#5b4d8e] disabled:opacity-50"
          >
            <CheckIcon />
            {isSaving ? i18n.t('mask.saving') : i18n.t('mask.save')}
          </button>
        </div>
      </div>
    </EditorShell>
  )
}
