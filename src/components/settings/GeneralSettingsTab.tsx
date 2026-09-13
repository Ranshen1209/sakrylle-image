import { useTranslation } from 'react-i18next'
import i18n from '../../lib/i18n'
import type { AppSettings } from '../../types'
import Select from '../Select'

interface GeneralSettingsTabProps {
  draft: AppSettings
  zipDownloadRouteSummary: string
  commitSettings: (nextDraft: AppSettings) => void
  onOpenZipDownloadRouteManager: () => void
  toggleTaskCompletionNotification: () => Promise<void>
}

export default function GeneralSettingsTab({
  draft,
  zipDownloadRouteSummary,
  commitSettings,
  onOpenZipDownloadRouteManager,
  toggleTaskCompletionNotification,
}: GeneralSettingsTabProps) {
  useTranslation()
  return (
    <div className="space-y-4">
      <div className="hidden sm:block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("settings.general.submitMode")}</span>
          <div className="w-28 shrink-0">
            <Select
              value={draft.enterSubmit ? 'enter' : 'ctrl-enter'}
              onChange={(val) => commitSettings({ ...draft, enterSubmit: val === 'enter' })}
              options={[
                { label: navigator.userAgent.includes('Mac') ? '⌘ + Enter' : 'Ctrl + Enter', value: 'ctrl-enter' },
                { label: 'Enter', value: 'enter' }
              ]}
              className="w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
            />
          </div>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {i18n.t("upstreamSync.choose")} {navigator.userAgent.includes('Mac') ? '⌘ + Enter' : 'Ctrl + Enter'} {i18n.t("upstreamSync.forEnterToInsertANewlineWithEnter")}
        </div>
      </div>
      <div className="sm:hidden">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("settings.general.submitMode")}</span>
          <div className="w-28 shrink-0">
            <Select
              value={draft.enterSubmit ? 'enter' : 'button'}
              onChange={(val) => commitSettings({ ...draft, enterSubmit: val === 'enter' })}
              options={[
                { label: i18n.t("upstreamSync.sendButton"), value: 'button' },
                { label: i18n.t("upstreamSync.enterSendButton"), value: 'enter' }
              ]}
              className="w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
            />
          </div>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {i18n.t("upstreamSync.chooseEnterSendButtonToSubmitWithEnter")}
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("settings.general.clearInputAfterSubmit")}</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, clearInputAfterSubmit: !draft.clearInputAfterSubmit })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.clearInputAfterSubmit ? 'bg-[#9181bd]' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.clearInputAfterSubmit}
            aria-label={i18n.t("settings.general.clearInputAfterSubmit")}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.clearInputAfterSubmit ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {i18n.t("settings.general.clearInputAfterSubmitHint")}
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("upstreamSync.downloadRoutesUsingZipArchives")}</span>
          <button
            type="button"
            onClick={onOpenZipDownloadRouteManager}
            className="shrink-0 rounded-xl border border-gray-200/80 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 hover:text-gray-900 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
          >
            {i18n.t("upstreamSync.manage")}
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {zipDownloadRouteSummary}
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("settings.general.persistInputOnRestart")}</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, persistInputOnRestart: !draft.persistInputOnRestart })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.persistInputOnRestart ? 'bg-[#9181bd]' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.persistInputOnRestart}
            aria-label={i18n.t("settings.general.persistInputOnRestart")}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.persistInputOnRestart ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {i18n.t("settings.general.persistInputOnRestartHint")}
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("settings.general.reuseTaskApiProfileTemporarily")}</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, reuseTaskApiProfileTemporarily: !draft.reuseTaskApiProfileTemporarily })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.reuseTaskApiProfileTemporarily ? 'bg-[#9181bd]' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.reuseTaskApiProfileTemporarily}
            aria-label={i18n.t("settings.general.reuseTaskApiProfileTemporarily")}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.reuseTaskApiProfileTemporarily ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {i18n.t("settings.general.reuseTaskApiProfileTemporarilyHint")}
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("settings.general.alwaysShowRetryButton")}</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, alwaysShowRetryButton: !draft.alwaysShowRetryButton })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.alwaysShowRetryButton ? 'bg-[#9181bd]' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.alwaysShowRetryButton}
            aria-label={i18n.t("settings.general.alwaysShowRetryButton")}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.alwaysShowRetryButton ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {i18n.t("settings.general.alwaysShowRetryButtonHint")}
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("upstreamSync.allowPromptRewriting")}</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, allowPromptRewrite: !draft.allowPromptRewrite })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.allowPromptRewrite ? 'bg-[#9181bd]' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.allowPromptRewrite}
            aria-label={i18n.t("upstreamSync.allowPromptRewriting")}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.allowPromptRewrite ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {i18n.t("upstreamSync.allowsProvidersToOptimizePromptsByOmittingThe")}
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("upstreamSync.notifyWhenTasksFinish")}</span>
          <button
            type="button"
            onClick={() => { void toggleTaskCompletionNotification() }}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.taskCompletionNotification ? 'bg-[#9181bd]' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.taskCompletionNotification}
            aria-label={i18n.t("upstreamSync.notifyWhenTasksFinish")}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.taskCompletionNotification ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {i18n.t("upstreamSync.sendsBrowserNotificationsWhenGalleryGenerationOrAn")}
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("settings.general.agentScrollToBottomAfterSubmit")}</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, agentScrollToBottomAfterSubmit: !draft.agentScrollToBottomAfterSubmit })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.agentScrollToBottomAfterSubmit ? 'bg-[#9181bd]' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.agentScrollToBottomAfterSubmit}
            aria-label={i18n.t("settings.general.agentScrollToBottomAfterSubmit")}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.agentScrollToBottomAfterSubmit ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {i18n.t("settings.general.agentScrollToBottomAfterSubmitHint")}
        </div>
      </div>
      <div className="block">
        <div className="mb-1 flex items-center justify-between">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("upstreamSync.mathFormattingInstructions")}</span>
          <button
            type="button"
            onClick={() => commitSettings({ ...draft, agentMathFormattingPrompt: !draft.agentMathFormattingPrompt })}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${draft.agentMathFormattingPrompt ? 'bg-[#9181bd]' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.agentMathFormattingPrompt}
            aria-label={i18n.t("upstreamSync.mathFormattingInstructions")}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.agentMathFormattingPrompt ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {i18n.t("upstreamSync.askTheAgentToUse")} <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.9em] text-gray-700 dark:bg-white/10 dark:text-gray-200">$...$</code> {i18n.t("upstreamSync.and")} <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.9em] text-gray-700 dark:bg-white/10 dark:text-gray-200">$$...$$</code> {i18n.t("upstreamSync.forCorrectlyRenderedMath")}
        </div>
      </div>
    </div>
  )
}
