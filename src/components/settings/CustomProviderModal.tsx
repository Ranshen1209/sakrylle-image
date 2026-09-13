import { useTranslation } from 'react-i18next'
import i18n from '../../lib/i18n'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import ViewportTooltip from '../ViewportTooltip'
import { CloseIcon, LinkIcon } from '../icons'

interface CustomProviderModalProps {
  editing: boolean
  json: string
  error: string | null
  isImportingJson: boolean
  scrollBoundaryRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  onCopyLlmPrompt: () => void
  onImportJson: () => void
  onJsonChange: (json: string) => void
  onSave: () => void
}

export default function CustomProviderModal({
  editing,
  json,
  error,
  isImportingJson,
  scrollBoundaryRef,
  onClose,
  onCopyLlmPrompt,
  onImportJson,
  onJsonChange,
  onSave,
}: CustomProviderModalProps) {
  useTranslation()
  const llmPromptTooltipTimerRef = useRef<number | null>(null)
  const [llmPromptTooltipVisible, setLlmPromptTooltipVisible] = useState(false)

  const clearLlmPromptTooltipTimer = () => {
    if (llmPromptTooltipTimerRef.current == null) return
    window.clearTimeout(llmPromptTooltipTimerRef.current)
    llmPromptTooltipTimerRef.current = null
  }

  useEffect(() => () => clearLlmPromptTooltipTimer(), [])

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 flex flex-col h-[85vh] sm:h-[680px] max-h-[90vh] overflow-hidden">
        <div className="mb-5 flex items-center justify-between gap-4 shrink-0">
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">
            {editing ? i18n.t("upstreamSync.editCustomProvider") : i18n.t("upstreamSync.createCustomProvider")}
          </h3>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label={i18n.t("support.closeAria")}
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div ref={scrollBoundaryRef} className="flex-1 flex flex-col min-h-0 px-1 -mx-1 pb-2">
          <div className="mb-6 shrink-0 rounded-2xl bg-gray-50/80 p-4 border border-gray-200/60 dark:bg-white/[0.02] dark:border-white/[0.05]">
            <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200">
              <svg className="h-4 w-4 text-[#9181bd]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              {i18n.t("upstreamSync.generateAndImportWithAi")}
            </div>
            <div data-selectable-text className="mb-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
              {i18n.t("upstreamSync.sendTheCopiedPromptAndApiDocumentationTo")}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="relative inline-flex">
                <button
                  type="button"
                  onClick={onCopyLlmPrompt}
                  aria-label={i18n.t("upstreamSync.copyTheLlmPromptForACompleteImport")}
                  onMouseEnter={() => setLlmPromptTooltipVisible(true)}
                  onMouseLeave={() => setLlmPromptTooltipVisible(false)}
                  onFocus={() => setLlmPromptTooltipVisible(true)}
                  onBlur={() => setLlmPromptTooltipVisible(false)}
                  onTouchStart={() => {
                    clearLlmPromptTooltipTimer()
                    llmPromptTooltipTimerRef.current = window.setTimeout(() => {
                      setLlmPromptTooltipVisible(true)
                      llmPromptTooltipTimerRef.current = null
                    }, 450)
                  }}
                  onTouchEnd={clearLlmPromptTooltipTimer}
                  onTouchCancel={clearLlmPromptTooltipTimer}
                  className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-medium text-gray-700 shadow-sm border border-gray-200/80 transition hover:bg-gray-50 hover:text-gray-900 dark:bg-white/[0.05] dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
                >
                  <LinkIcon className="h-3.5 w-3.5" />
                  {i18n.t("upstreamSync.copyConfigurationPrompt")}
                </button>
                <ViewportTooltip visible={llmPromptTooltipVisible} className="w-56 whitespace-normal text-center">
                  {i18n.t("upstreamSync.generatesProviderModelAndEndpointSettingsAfterImport")}
                </ViewportTooltip>
              </span>
              <button
                type="button"
                onClick={onImportJson}
                disabled={isImportingJson}
                className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-medium text-gray-700 shadow-sm border border-gray-200/80 transition hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-white/[0.05] dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
              >
                {isImportingJson ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {i18n.t("settings.data.importing")}
                  </>
                ) : (
                  i18n.t("upstreamSync.pasteFromClipboardAndImport")
                )}
              </button>
            </div>
          </div>

          <div className="flex-1 flex flex-col min-h-0">
            <label className="flex-1 flex flex-col min-h-0">
              <span className="mb-1 shrink-0 block text-xs text-gray-500 dark:text-gray-400">{i18n.t("upstreamSync.manualEditApiMappingManifestOnly")}</span>
              <textarea
                value={json}
                onChange={(e) => onJsonChange(e.target.value)}
                spellCheck={false}
                className="flex-1 min-h-[150px] w-full resize-none rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 font-mono text-xs leading-relaxed text-gray-700 outline-none transition focus:border-[#b9a9da] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-[#9181bd]/50 custom-scrollbar"
              />
            </label>
          </div>

          {error && (
            <div data-selectable-text className="shrink-0 mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-500 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-gray-100 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
          >
            {i18n.t("size.cancel")}
          </button>
          <button
            type="button"
            onClick={onSave}
            className="rounded-xl bg-[#9181bd] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#7e6aa9]"
          >
            {editing ? i18n.t("upstreamSync.saveChanges") : i18n.t("upstreamSync.createAndUse")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
