import { useTranslation } from 'react-i18next'
import i18n from '../../lib/i18n'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { ZipDownloadRoute } from '../../types'
import { Checkbox } from '../Checkbox'
import { CloseIcon } from '../icons'

export const getZipDownloadRouteOptions = (): Array<{ route: ZipDownloadRoute; label: string; description: string }> => [
  { route: 'task-selection', label: i18n.t("upstreamSync.taskListSelection"), description: i18n.t("upstreamSync.downloadSelectedTasksAfterBoxSelectionCtrlClick") },
  { route: 'favorite-collection-selection', label: i18n.t("upstreamSync.collectionsSelection"), description: i18n.t("upstreamSync.downloadSelectedCollectionsFromTheCollectionOverview") },
  { route: 'image-context-menu-all', label: i18n.t("upstreamSync.imageContextMenuDownloadAll"), description: i18n.t("upstreamSync.downloadAllImagesFromTheSameOutputGroup") },
  { route: 'task-detail-all', label: i18n.t("upstreamSync.taskDetailsDownloadAll"), description: i18n.t("upstreamSync.downloadEveryOutputImageInTheTaskDetails") },
  { route: 'task-detail-partial', label: i18n.t("upstreamSync.taskDetailsDownloadIntermediateImages"), description: i18n.t("upstreamSync.downloadIntermediateImagesSavedDuringStreaming") },
  { route: 'agent-round-all', label: i18n.t("upstreamSync.agentRoundDownloadAllImages"), description: i18n.t("upstreamSync.downloadAllImagesAssociatedWithOneAgentReply") },
]

interface ZipDownloadRouteModalProps {
  routes: ZipDownloadRoute[]
  scrollBoundaryRef: RefObject<HTMLDivElement | null>
  onSetEnabled: (route: ZipDownloadRoute, enabled: boolean) => void
  onClose: () => void
}

export default function ZipDownloadRouteModal({
  routes,
  scrollBoundaryRef,
  onSetEnabled,
  onClose,
}: ZipDownloadRouteModalProps) {
  useTranslation()
  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative z-10 w-full max-w-md rounded-3xl bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] ring-1 ring-black/5 dark:ring-white/10 animate-confirm-in flex flex-col max-h-[85vh] sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 p-6 pb-2">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">{i18n.t("upstreamSync.useZipArchivesForBatchDownloads")}</h3>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label={i18n.t("support.closeAria")}
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          <div data-selectable-text className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
            {i18n.t("upstreamSync.selectedDownloadRoutesSaveOneZipInsteadOf")}
          </div>
        </div>

        <div ref={scrollBoundaryRef} className="flex-1 overflow-y-auto px-6 space-y-3 custom-scrollbar min-h-0 py-2">
          {getZipDownloadRouteOptions().map((option) => {
            const isChecked = routes.includes(option.route)
            return (
              <div
                key={option.route}
                role="checkbox"
                aria-checked={isChecked}
                tabIndex={0}
                onClick={() => onSetEnabled(option.route, !isChecked)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSetEnabled(option.route, !isChecked)
                }}
                className={`cursor-pointer rounded-2xl border p-3.5 transition-colors focus:outline-none focus:ring-2 focus:ring-[#9181bd]/20 ${isChecked ? 'border-[#9181bd]/30 bg-[#f1edf8]/50 dark:border-[#a28fc9]/30 dark:bg-[#9181bd]/[0.05]' : 'border-gray-100 bg-gray-50/70 hover:bg-gray-100/70 dark:border-white/[0.06] dark:bg-white/[0.03] dark:hover:bg-white/[0.05]'}`}
              >
                <div onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    checked={isChecked}
                    onChange={(checked) => onSetEnabled(option.route, checked)}
                    label={<span className="text-sm font-medium text-gray-700 dark:text-gray-200">{option.label}</span>}
                  />
                </div>
                <div data-selectable-text className="mt-1.5 pl-6 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                  {option.description}
                </div>
              </div>
            )
          })}
        </div>

        <div className="shrink-0 p-6 pt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl bg-[#9181bd] py-2 text-sm font-medium text-white transition hover:bg-[#7e6aa9]"
          >
            {i18n.t("upstreamSync.done")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
