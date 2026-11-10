import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../lib/i18n'
import type { AppSettings } from '../../types'
import { markSaveLocationAsked } from '../../hooks/useSaveLocationPrompt'
import { DEFAULT_PRIVACY_MODE_SHORTCUT } from '../../lib/keyboardShortcut'
import { isTauri } from '../../lib/platform'
import { getDefaultSaveDir, openDefaultSaveDir } from '../../lib/saveFile'
import { openTauriLogDir } from '../../lib/tauriLog'
import { useStore } from '../../store'
import Select from '../Select'
import ProxySettingsSection from './ProxySettingsSection'
import ShortcutRecorder from './ShortcutRecorder'
import { changeSaveDirWithMigration } from './saveDirMigration'

interface GeneralSettingsTabProps {
  draft: AppSettings
  zipDownloadRouteSummary: string
  commitSettings: (nextDraft: AppSettings) => void
  onOpenZipDownloadRouteManager: () => void
  toggleTaskCompletionNotification: () => Promise<void>
}

const selectClass = 'w-full px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-xs transition-all duration-200 text-gray-700 dark:text-gray-200 outline-none'
const actionButtonClass = 'shrink-0 rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-black/[0.07] hover:text-gray-900 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white'

function Toggle({ checked, label, onClick }: { checked: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${checked ? 'bg-[#9181bd]' : 'bg-gray-300 dark:bg-gray-600'}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
    </button>
  )
}

export default function GeneralSettingsTab({
  draft,
  zipDownloadRouteSummary,
  commitSettings,
  onOpenZipDownloadRouteManager,
  toggleTaskCompletionNotification,
}: GeneralSettingsTabProps) {
  useTranslation()
  const showToast = useStore((s) => s.showToast)
  const [defaultSaveDir, setDefaultSaveDir] = useState('')

  useEffect(() => {
    if (!isTauri) return
    getDefaultSaveDir().then(setDefaultSaveDir).catch((err) => {
      console.error('读取默认保存地址失败：', err)
      setDefaultSaveDir(typeof err === 'string' ? err : '读取失败')
    })
  }, [])

  const handleChangeDefaultSaveDir = async () => {
    try {
      const dir = await changeSaveDirWithMigration()
      if (dir) setDefaultSaveDir(dir)
    } catch (err) {
      console.error('更改默认保存地址失败：', err)
      showToast(typeof err === 'string' ? err : '更改默认保存地址失败', 'error')
    }
  }

  const handleOpenDefaultSaveDir = async () => {
    try {
      await openDefaultSaveDir()
    } catch (err) {
      console.error('打开默认保存地址失败：', err)
      showToast(typeof err === 'string' ? err : '打开默认保存地址失败', 'error')
    }
  }

  const handleOpenLogDir = async () => {
    try {
      await openTauriLogDir()
    } catch (err) {
      console.error('打开日志目录失败：', err)
      showToast(typeof err === 'string' ? err : '打开日志目录失败', 'error')
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">输入</h4>
        <div className="hidden sm:block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t('settings.general.submitMode')}</span>
            <div className="w-28 shrink-0">
              <Select
                value={draft.enterSubmit ? 'enter' : 'ctrl-enter'}
                onChange={(val) => commitSettings({ ...draft, enterSubmit: val === 'enter' })}
                options={[
                  { label: navigator.userAgent.includes('Mac') ? '⌘ + Enter' : 'Ctrl + Enter', value: 'ctrl-enter' },
                  { label: 'Enter', value: 'enter' },
                ]}
                className={selectClass}
              />
            </div>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {i18n.t('upstreamSync.choose')} {navigator.userAgent.includes('Mac') ? '⌘ + Enter' : 'Ctrl + Enter'} {i18n.t('upstreamSync.forEnterToInsertANewlineWithEnter')}
          </div>
        </div>
        <div className="sm:hidden">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t('settings.general.submitMode')}</span>
            <div className="w-28 shrink-0">
              <Select
                value={draft.enterSubmit ? 'enter' : 'button'}
                onChange={(val) => commitSettings({ ...draft, enterSubmit: val === 'enter' })}
                options={[
                  { label: i18n.t('upstreamSync.sendButton'), value: 'button' },
                  { label: i18n.t('upstreamSync.enterSendButton'), value: 'enter' },
                ]}
                className={selectClass}
              />
            </div>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {i18n.t('upstreamSync.chooseEnterSendButtonToSubmitWithEnter')}
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">多提示词批量提交</span>
            <Toggle
              checked={draft.showBatchPrompt}
              label="多提示词批量提交"
              onClick={() => commitSettings({ ...draft, showBatchPrompt: !draft.showBatchPrompt })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            开启后，首页参数栏会显示“批量”选项，可将空两行分隔的多条提示词一次提交，支持排队或并发执行。
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t('settings.general.clearInputAfterSubmit')}</span>
            <Toggle
              checked={draft.clearInputAfterSubmit}
              label={i18n.t('settings.general.clearInputAfterSubmit')}
              onClick={() => commitSettings({ ...draft, clearInputAfterSubmit: !draft.clearInputAfterSubmit })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {i18n.t('settings.general.clearInputAfterSubmitHint')}
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t('settings.general.persistInputOnRestart')}</span>
            <Toggle
              checked={draft.persistInputOnRestart}
              label={i18n.t('settings.general.persistInputOnRestart')}
              onClick={() => commitSettings({ ...draft, persistInputOnRestart: !draft.persistInputOnRestart })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {i18n.t('settings.general.persistInputOnRestartHint')}
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">参考图编辑方式</span>
            <div className="w-28 shrink-0">
              <Select
                value={draft.referenceImageEditAction}
                onChange={(val) => commitSettings({ ...draft, referenceImageEditAction: val as AppSettings['referenceImageEditAction'] })}
                options={[
                  { label: '每次询问', value: 'ask' },
                  { label: '画板', value: 'sketch' },
                  { label: '遮罩', value: 'mask' },
                ]}
                className={selectClass}
              />
            </div>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            控制在参考图预览中点击“编辑图片”时，是每次询问，还是直接用画板标注或添加遮罩。
          </div>
        </div>
      </section>
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">任务与下载</h4>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t('settings.general.reuseTaskApiProfileTemporarily')}</span>
            <Toggle
              checked={draft.reuseTaskApiProfileTemporarily}
              label={i18n.t('settings.general.reuseTaskApiProfileTemporarily')}
              onClick={() => commitSettings({ ...draft, reuseTaskApiProfileTemporarily: !draft.reuseTaskApiProfileTemporarily })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {i18n.t('settings.general.reuseTaskApiProfileTemporarilyHint')}
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">收藏夹页的新任务加入当前收藏夹</span>
            <Toggle
              checked={draft.saveTasksToActiveFavoriteCollection}
              label="收藏夹页的新任务加入当前收藏夹"
              onClick={() => commitSettings({ ...draft, saveTasksToActiveFavoriteCollection: !draft.saveTasksToActiveFavoriteCollection })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            开启后，在收藏夹页提交或重试出的新任务会自动加入当前收藏夹，重试出的任务同时沿用原任务的收藏夹；在收藏夹总览或“全部收藏”中提交的任务加入默认收藏夹。
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t('settings.general.alwaysShowRetryButton')}</span>
            <Toggle
              checked={draft.alwaysShowRetryButton}
              label={i18n.t('settings.general.alwaysShowRetryButton')}
              onClick={() => commitSettings({ ...draft, alwaysShowRetryButton: !draft.alwaysShowRetryButton })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {i18n.t('settings.general.alwaysShowRetryButtonHint')}
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">重试方式</span>
            <div className="w-32 shrink-0">
              <Select
                value={draft.retryMode}
                onChange={(val) => commitSettings({ ...draft, retryMode: val as AppSettings['retryMode'] })}
                options={[
                  { label: '新建任务', value: 'new' },
                  { label: '覆盖失败任务', value: 'overwriteFailed' },
                  ...(draft.alwaysShowRetryButton ? [{ label: '覆盖任何任务', value: 'overwriteAll' }] : []),
                ]}
                className={selectClass}
              />
            </div>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            覆盖时保留原任务的创建时间和收藏，清空旧的结果和耗时后重新生成；重试 Agent 对话中的图片卡片时，始终新建任务。
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">附加图像生成提示词</span>
            <Toggle
              checked={draft.imagePromptHints}
              label="附加图像生成提示词"
              onClick={() => commitSettings({ ...draft, imagePromptHints: !draft.imagePromptHints })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            为 Google 图像请求添加“生成图像：”前缀，并在启用 Google Search 或 Image Search 时附加搜索提示词。关闭后仍保留搜索工具。
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t('upstreamSync.allowPromptRewriting')}</span>
            <Toggle
              checked={draft.allowPromptRewrite}
              label={i18n.t('upstreamSync.allowPromptRewriting')}
              onClick={() => commitSettings({ ...draft, allowPromptRewrite: !draft.allowPromptRewrite })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {i18n.t('upstreamSync.allowsProvidersToOptimizePromptsByOmittingThe')}
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t('upstreamSync.downloadRoutesUsingZipArchives')}</span>
            <button
              type="button"
              onClick={onOpenZipDownloadRouteManager}
              className={actionButtonClass}
            >
              {i18n.t('upstreamSync.manage')}
            </button>
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {zipDownloadRouteSummary}
          </div>
        </div>
        {isTauri && (
          <>
            <div className="block">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="block text-sm text-gray-600 dark:text-gray-300">文件保存位置</span>
                <div className="w-28 shrink-0">
                  <Select
                    value={draft.saveLocationMode}
                    onChange={(val) => {
                      markSaveLocationAsked()
                      commitSettings({ ...draft, saveLocationMode: val as AppSettings['saveLocationMode'] })
                    }}
                    options={[
                      { label: '每次询问', value: 'ask' },
                      { label: '默认地址', value: 'default' },
                    ]}
                    className={selectClass}
                  />
                </div>
              </div>
              <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
                下载图片、压缩包和导出备份时，每次选择保存位置，或直接保存到默认保存地址；直接保存时遇到同名文件会自动加序号，不会覆盖。
              </div>
            </div>
            <div className="block">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="block text-sm text-gray-600 dark:text-gray-300">默认保存地址</span>
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={handleChangeDefaultSaveDir} className={actionButtonClass}>
                    更改
                  </button>
                  <button type="button" onClick={handleOpenDefaultSaveDir} className={actionButtonClass}>
                    打开
                  </button>
                </div>
              </div>
              <div data-selectable-text className="break-all text-xs text-gray-500 dark:text-gray-500">
                {defaultSaveDir || '读取中…'}
              </div>
            </div>
          </>
        )}
      </section>
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">通知</h4>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">任务完成或失败时发送系统通知</span>
            <Toggle
              checked={draft.taskCompletionNotification}
              label="任务完成或失败时发送系统通知"
              onClick={() => { void toggleTaskCompletionNotification() }}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {isTauri
              ? '开启后，画廊模式图像生成和 Agent 模式回复结束时（无论成功或失败）都会发送系统通知。如果没有收到通知，请检查 Windows 设置中本应用的通知开关。'
              : '开启后，画廊模式图像生成和 Agent 模式回复结束时（无论成功或失败）都会发送浏览器系统通知。浏览器可能会请求通知权限或默认拒绝，请查看相关提示。'}
          </div>
        </div>
      </section>
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">隐私</h4>
        <div className="block">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="block text-sm text-gray-600 dark:text-gray-300">隐私模式快捷键</span>
            <ShortcutRecorder
              value={draft.privacyModeShortcut}
              defaultValue={DEFAULT_PRIVACY_MODE_SHORTCUT}
              onChange={(value) => commitSettings({ ...draft, privacyModeShortcut: value })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            按下后关闭所有弹窗，隐藏历史记录、收藏夹和输入框内容，之前任务的通知不再提示；再按一次恢复。点击按钮后按下新组合即可修改。
          </div>
        </div>
      </section>
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">Agent 对话</h4>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t('settings.general.agentScrollToBottomAfterSubmit')}</span>
            <Toggle
              checked={draft.agentScrollToBottomAfterSubmit}
              label={i18n.t('settings.general.agentScrollToBottomAfterSubmit')}
              onClick={() => commitSettings({ ...draft, agentScrollToBottomAfterSubmit: !draft.agentScrollToBottomAfterSubmit })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {i18n.t('settings.general.agentScrollToBottomAfterSubmitHint')}
          </div>
        </div>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">{i18n.t('upstreamSync.mathFormattingInstructions')}</span>
            <Toggle
              checked={draft.agentMathFormattingPrompt}
              label={i18n.t('upstreamSync.mathFormattingInstructions')}
              onClick={() => commitSettings({ ...draft, agentMathFormattingPrompt: !draft.agentMathFormattingPrompt })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            {i18n.t('upstreamSync.askTheAgentToUse')} <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.9em] text-gray-700 dark:bg-white/10 dark:text-gray-200">$...$</code> {i18n.t('upstreamSync.and')} <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.9em] text-gray-700 dark:bg-white/10 dark:text-gray-200">$$...$$</code> {i18n.t('upstreamSync.forCorrectlyRenderedMath')}
          </div>
        </div>
      </section>
      {isTauri && <ProxySettingsSection />}
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">更新</h4>
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-sm text-gray-600 dark:text-gray-300">自动检查更新</span>
            <Toggle
              checked={draft.autoCheckUpdate}
              label="自动检查更新"
              onClick={() => commitSettings({ ...draft, autoCheckUpdate: !draft.autoCheckUpdate })}
            />
          </div>
          <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
            开启后，启动时会从 GitHub 获取版本信息，有新版本时在左上角显示 NEW 提示。关闭后可在“关于”中手动检查更新。
          </div>
        </div>
      </section>
      {isTauri && (
        <section className="space-y-4">
          <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">诊断</h4>
          <div className="block">
            <div className="mb-1 flex items-center justify-between">
              <span className="block text-sm text-gray-600 dark:text-gray-300">写入日志文件</span>
              <Toggle
                checked={draft.writeLogFile}
                label="写入日志文件"
                onClick={() => commitSettings({ ...draft, writeLogFile: !draft.writeLogFile })}
              />
            </div>
            <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
              记录警告和错误，便于排查问题。
            </div>
          </div>
          <div className="block">
            <div className="mb-1 flex items-center justify-between gap-3">
              <span className="block text-sm text-gray-600 dark:text-gray-300">日志目录</span>
              <button type="button" onClick={handleOpenLogDir} className={actionButtonClass}>
                打开
              </button>
            </div>
            <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
              日志保存在数据目录的 logs 文件夹中，反馈问题时可以附上。
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
