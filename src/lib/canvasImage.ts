import { assertUsableMaskCoverage, classifyMaskAlpha, type MaskCoverage } from './mask'
import i18n from './i18n'

export async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  const src = await withSvgIntrinsicSize(dataUrl)
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(i18n.t('errors.imageLoadFailed')))
    image.src = src
  })
}

/** 宽高缺失、为百分比或 auto 的 SVG 会按 300×150 的默认尺寸加载，画到 Canvas 上会很小，用 viewBox 的宽高补上 */
async function withSvgIntrinsicSize(dataUrl: string): Promise<string> {
  if (!/^data:image\/svg\+xml[;,]/i.test(dataUrl)) return dataUrl
  const svg = new DOMParser().parseFromString(await (await fetch(dataUrl)).text(), 'image/svg+xml').documentElement
  // pt、mm 等绝对单位浏览器能自行换算，保留原值
  const hasSize = (name: string) => !/^(|auto|.*%)$/i.test(svg.getAttribute(name)?.trim() ?? '')
  if (hasSize('width') && hasSize('height')) return dataUrl
  const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (!box || box.length !== 4 || !(box[2] > 0) || !(box[3] > 0)) return dataUrl
  svg.setAttribute('width', String(box[2]))
  svg.setAttribute('height', String(box[3]))
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
}

export async function dataUrlToBlob(dataUrl: string, fallbackType = 'image/png'): Promise<Blob> {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return blob.type ? blob : new Blob([await blob.arrayBuffer()], { type: fallbackType })
}

export async function imageDataUrlToPngBlob(dataUrl: string): Promise<Blob> {
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(i18n.t('mask.canvasUnsupported'))
  ctx.drawImage(image, 0, 0)
  return canvasToBlob(canvas, 'image/png')
}

/** 图像接口不接受 SVG 和 GIF 作为输入图，转成 PNG（GIF 取第一帧） */
export async function toApiInputImageDataUrl(dataUrl: string): Promise<string> {
  if (!/^data:image\/(svg\+xml|gif)[;,]/i.test(dataUrl)) return dataUrl
  return blobToDataUrl(await imageDataUrlToPngBlob(dataUrl))
}

/** 把 markup 标注层画到原图上，供不支持 markup 的接口使用 */
export async function composeMarkupDataUrl(imageDataUrl: string, markupDataUrl: string): Promise<string> {
  const [image, markup] = await Promise.all([loadImage(imageDataUrl), loadImage(markupDataUrl)])
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.drawImage(image, 0, 0)
  ctx.drawImage(markup, 0, 0, canvas.width, canvas.height)
  return blobToDataUrl(await canvasToBlob(canvas, 'image/png'))
}

export async function maskDataUrlToPngBlob(maskDataUrl: string): Promise<Blob> {
  const blob = await dataUrlToBlob(maskDataUrl, 'image/png')
  if (blob.type !== 'image/png') {
    return imageDataUrlToPngBlob(maskDataUrl)
  }
  return blob
}

export async function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error(i18n.t('mask.exportFailed')))
      else resolve(blob)
    }, type, quality)
  })
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'))
    reader.readAsDataURL(blob)
  })
}

export interface ImageDimensions {
  width: number
  height: number
}

export async function getImageDimensions(dataUrl: string): Promise<ImageDimensions> {
  const image = await loadImage(dataUrl)
  return { width: image.naturalWidth, height: image.naturalHeight }
}

// ---------------------------------------------------------------------------
// Upload-time image compression (spec 2026-06-10-input-image-compression)
//
// Large input images (e.g. 8MP phone photos, ~7.5MB PNG -> ~9.5MB base64)
// stall the streaming chat/completions path: the oversized request body makes
// upstream processing so slow that heartbeat chunks arrive >60s apart and trip
// the idle timeout. Downsampling + re-encoding before send shrinks the body so
// upload + upstream processing are fast and heartbeats stay dense.
//
// This only touches the transient "copy we send" — store/db/history keep the
// user's original image.
// ---------------------------------------------------------------------------

export const COMPRESS_MAX_DIMENSION = 1536
/** Compares against dataUrl.length (base64 chars ≈ encoded bytes). 1.5M base64 ≈ ~1.1MB raw. */
export const COMPRESS_TRIGGER_BYTES = 1_500_000
/** JPEG quality for non-mask re-encoding; masks use PNG (no quality arg) to keep alpha. */
export const COMPRESS_JPEG_QUALITY = 0.85

export interface CompressImageOptions {
  /** Masks must stay PNG (transparent area is semantic) and trigger on size only. */
  isMask?: boolean
}

/** Injectable seam: the browser primitives have no real impl under node/jsdom tests. */
export interface CompressImageDeps {
  getImageDimensions: (dataUrl: string) => Promise<ImageDimensions>
  loadImage: (dataUrl: string) => Promise<HTMLImageElement>
  canvasToBlob: (canvas: HTMLCanvasElement, type?: string, quality?: number) => Promise<Blob>
  blobToDataUrl: (blob: Blob) => Promise<string>
  createCanvas: () => HTMLCanvasElement
}

const defaultCompressDeps: CompressImageDeps = {
  getImageDimensions,
  loadImage,
  canvasToBlob,
  blobToDataUrl,
  createCanvas: () => document.createElement('canvas'),
}

/**
 * Downsample + re-encode an input image before upload, but only when it is over
 * threshold (small images return unchanged with zero re-encode cost). Compression
 * is an optimization, never a blocker: any failure falls back to the original.
 */
export async function compressImageForUpload(
  dataUrl: string,
  options: CompressImageOptions = {},
  deps: CompressImageDeps = defaultCompressDeps,
): Promise<string> {
  const { isMask = false } = options
  try {
    const { width, height } = await deps.getImageDimensions(dataUrl)
    const longestEdge = Math.max(width, height)
    const overSize = longestEdge > COMPRESS_MAX_DIMENSION
    const overBytes = dataUrl.length > COMPRESS_TRIGGER_BYTES
    // Mask: size only (a heavy-but-small mask must stay lossless PNG, untouched).
    // Non-mask: size OR bytes (also catch in-bounds-but-heavy screenshots/PNGs).
    const shouldCompress = isMask ? overSize : overSize || overBytes
    if (!shouldCompress) return dataUrl

    const image = await deps.loadImage(dataUrl)
    const scale = Math.min(1, COMPRESS_MAX_DIMENSION / longestEdge)
    const canvas = deps.createCanvas()
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

    const mime = isMask ? 'image/png' : 'image/jpeg'
    const quality = isMask ? undefined : COMPRESS_JPEG_QUALITY
    const blob = await deps.canvasToBlob(canvas, mime, quality)
    const compressed = await deps.blobToDataUrl(blob)

    // Re-encoding can rarely grow the payload (tiny flat images). Never grow.
    return compressed.length < dataUrl.length ? compressed : dataUrl
  } catch {
    return dataUrl
  }
}

export async function validateMaskMatchesImage(maskDataUrl: string, imageDataUrl: string): Promise<MaskCoverage> {
  const [maskImage, sourceImage] = await Promise.all([loadImage(maskDataUrl), loadImage(imageDataUrl)])
  if (maskImage.naturalWidth !== sourceImage.naturalWidth || maskImage.naturalHeight !== sourceImage.naturalHeight) {
    throw new Error(i18n.t('errors.maskSizeMismatch'))
  }

  const canvas = document.createElement('canvas')
  canvas.width = maskImage.naturalWidth
  canvas.height = maskImage.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error(i18n.t('mask.canvasUnsupported'))
  ctx.drawImage(maskImage, 0, 0)
  const coverage = classifyMaskAlpha(ctx.getImageData(0, 0, canvas.width, canvas.height))
  assertUsableMaskCoverage(coverage)
  return coverage
}

export async function createMaskPreviewDataUrl(imageDataUrl: string, maskDataUrl: string): Promise<string> {
  const [image, mask] = await Promise.all([loadImage(imageDataUrl), loadImage(maskDataUrl)])
  if (image.naturalWidth !== mask.naturalWidth || image.naturalHeight !== mask.naturalHeight) {
    throw new Error(i18n.t('errors.maskSizeMismatch'))
  }

  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error(i18n.t('mask.canvasUnsupported'))

  ctx.drawImage(image, 0, 0)

  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = mask.naturalWidth
  maskCanvas.height = mask.naturalHeight
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!maskCtx) throw new Error(i18n.t('mask.canvasUnsupported'))
  maskCtx.drawImage(mask, 0, 0)
  const maskPixels = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)

  const overlay = ctx.createImageData(canvas.width, canvas.height)
  for (let i = 0; i < maskPixels.data.length; i += 4) {
    const editStrength = 255 - maskPixels.data[i + 3]
    overlay.data[i] = 59
    overlay.data[i + 1] = 130
    overlay.data[i + 2] = 246
    overlay.data[i + 3] = Math.round(editStrength * 0.58)
  }

  const overlayCanvas = document.createElement('canvas')
  overlayCanvas.width = canvas.width
  overlayCanvas.height = canvas.height
  const overlayCtx = overlayCanvas.getContext('2d')
  if (!overlayCtx) throw new Error(i18n.t('mask.canvasUnsupported'))
  overlayCtx.putImageData(overlay, 0, 0)
  ctx.drawImage(overlayCanvas, 0, 0)
  return canvas.toDataURL('image/png')
}
