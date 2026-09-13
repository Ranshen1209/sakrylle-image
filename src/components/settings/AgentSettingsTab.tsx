import { useTranslation } from 'react-i18next'
import i18n from '../../lib/i18n'
import {
  DEFAULT_AGENT_MAX_TOOL_ROUNDS,
  type AgentApiConfigMode,
  type ApiProfile,
  type AppSettings,
} from '../../types'
import { normalizeAgentMaxToolRounds } from '../../lib/apiProfiles'
import Select from '../Select'

interface SelectOption {
  label: string
  value: string
}

interface AgentSettingsTabProps {
  draft: AppSettings
  agentMaxToolRoundsInput: string
  agentTextProfileOptions: SelectOption[]
  agentImageProfileOptions: SelectOption[]
  selectedAgentTextProfile: ApiProfile | null
  selectedAgentImageProfile: ApiProfile | null
  setAgentMaxToolRoundsInput: (value: string) => void
  updateAgentApiConfigMode: (mode: AgentApiConfigMode) => void
  commitSettings: (nextDraft: AppSettings) => void
  commitAgentMaxToolRounds: () => void
}

export default function AgentSettingsTab({
  draft,
  agentMaxToolRoundsInput,
  agentTextProfileOptions,
  agentImageProfileOptions,
  selectedAgentTextProfile,
  selectedAgentImageProfile,
  setAgentMaxToolRoundsInput,
  updateAgentApiConfigMode,
  commitSettings,
  commitAgentMaxToolRounds,
}: AgentSettingsTabProps) {
  useTranslation()
  return (
    <div className="space-y-4">
      <div className="block">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("upstreamSync.useSeparateApiConfigurations")}</span>
          <div className="w-20 shrink-0">
            <Select
              value={draft.agentApiConfigMode}
              onChange={(value) => updateAgentApiConfigMode(value as AgentApiConfigMode)}
              options={[
                { label: i18n.t("support.closeAria"), value: 'off' },
                { label: i18n.t("upstreamSync.native"), value: 'native' },
                { label: i18n.t("upstreamSync.hybrid"), value: 'hybrid' },
              ]}
              className="w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
            />
          </div>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500 space-y-1">
          <div>{i18n.t("upstreamSync.nativeUseAResponsesApiConfigurationAndLet")} <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] dark:bg-white/[0.06]">image_generation</code> {i18n.t("upstreamSync.toolToGenerateImages")}</div>
          <div>{i18n.t("upstreamSync.hybridATextModelCallsACustomTool")} <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] dark:bg-white/[0.06]">image_generation</code> {i18n.t("upstreamSync.tool")}</div>
        </div>
      </div>

      {draft.agentApiConfigMode !== 'off' && (
        <>
          <div className="block">
            <div className="mb-1 flex items-center justify-between gap-3">
              <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("upstreamSync.textModelApiConfiguration")}</span>
              <div className="w-40 shrink-0">
                {agentTextProfileOptions.length > 0 ? (
                  <Select
                    value={selectedAgentTextProfile?.id ?? '请选择配置'}
                    onChange={(value) => commitSettings({ ...draft, agentTextProfileId: String(value) })}
                    options={agentTextProfileOptions}
                    showValueTooltips
                    className="w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
                  />
                ) : (
                  <div className="w-full rounded-xl border border-gray-200/60 bg-white/50 px-3 py-1.5 text-center text-xs text-gray-700 shadow-sm transition-all duration-200 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200">
                    {i18n.t("upstreamSync.noAvailableConfigurations")}
                  </div>
                )}
              </div>
            </div>
            <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
              {i18n.t("upstreamSync.usedForConversationAndToolsRequiresAResponses")}
            </div>
          </div>

          {draft.agentApiConfigMode === 'hybrid' && (
            <div className="block">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("upstreamSync.imageModelApiConfiguration")}</span>
                <div className="w-40 shrink-0">
                  {agentImageProfileOptions.length > 0 ? (
                    <Select
                      value={selectedAgentImageProfile?.id ?? '请选择配置'}
                      onChange={(value) => commitSettings({ ...draft, agentImageProfileId: String(value) })}
                      options={agentImageProfileOptions}
                      showValueTooltips
                      className="w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
                    />
                  ) : (
                    <div className="w-full rounded-xl border border-gray-200/60 bg-white/50 px-3 py-1.5 text-center text-xs text-gray-700 shadow-sm transition-all duration-200 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200">
                      {i18n.t("upstreamSync.noAvailableConfigurations")}
                    </div>
                  )}
                </div>
              </div>
              <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
                {i18n.t("upstreamSync.usedForImageGenerationSupportsAllProviderTypes")}
              </div>
            </div>
          )}
        </>
      )}
      <label className="block">
        <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">{i18n.t("settings.agent.maxToolRounds")}</span>
        <input
          value={agentMaxToolRoundsInput}
          onChange={(e) => setAgentMaxToolRoundsInput(e.target.value)}
          onBlur={commitAgentMaxToolRounds}
          type="number"
          min={1}
          max={50}
          className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-[#b9a9da] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-[#9181bd]/50"
        />
        <div data-selectable-text className="mt-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-500">
          {i18n.t("settings.agent.maxToolRoundsHint")}
        </div>
      </label>
      <div className="block">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t("settings.agent.webSearch")}</span>
          <button
            type="button"
            onClick={() => {
              const agentMaxToolRounds = agentMaxToolRoundsInput.trim() === ''
                ? DEFAULT_AGENT_MAX_TOOL_ROUNDS
                : normalizeAgentMaxToolRounds(agentMaxToolRoundsInput, draft.agentMaxToolRounds)
              setAgentMaxToolRoundsInput(String(agentMaxToolRounds))
              commitSettings({ ...draft, agentMaxToolRounds, agentWebSearch: !draft.agentWebSearch })
            }}
            className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${draft.agentWebSearch ? 'bg-[#9181bd]' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.agentWebSearch}
            aria-label={i18n.t("settings.agent.webSearch")}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.agentWebSearch ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          {i18n.t("settings.agent.webSearchHintBefore")} <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] dark:bg-white/[0.06]">web_search</code> {i18n.t("settings.agent.webSearchHintAfter")}
        </div>
      </div>
    </div>
  )
}
