import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { initStore, restoreExplicitPresetConfig, useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, getExplicitUrlSettingsIds, hasUrlSettingParams } from './lib/urlSettings'
import { createDefaultOpenAIProfile, hasDefaultPresetConfig, isAgentTextApiProfile, normalizeSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, hasEmbeddedDefaultConfig, loadCustomProviderSettingsFromUrl, loadEmbeddedDefaultConfig } from './lib/customProviderConfigUrl'
import { getDefaultPresetProfileId, getPresetProfileIds, isPresetConfigOnlyEnabled, setPresetConfig } from './lib/presetConfig'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import type { AppSettings } from './types'
import { beginLogin as sakrylleBeginLogin, getStoredToken as sakrylleGetStoredToken } from './lib/sakrylleAuth'
import { applyThemeClass, readStoredTheme } from './lib/theme'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import { FavoriteCollectionPickerModal, FavoriteCollectionsView, ManageCollectionsModal } from './components/FavoriteCollections'
import { useGlobalClickSuppression } from './lib/clickSuppression'

let defaultConfigImportStarted = false

const SAKRYLLE_FIRST_VISIT_KEY = 'sakrylle-image-playground.first-visit-prompted'

export default function App() {
  const { t } = useTranslation()
  const setSettings = useStore((s) => s.setSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const appMode = useStore((s) => s.appMode)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    if (defaultConfigImportStarted) return
    defaultConfigImportStarted = true

    const searchParams = new URLSearchParams(window.location.search)
    const customProviderConfigUrl = getCustomProviderConfigUrl()
    const embeddedDefaultConfig = hasEmbeddedDefaultConfig()
    const loadDefaultConfig = () => embeddedDefaultConfig
      ? Promise.resolve().then(() => loadEmbeddedDefaultConfig())
      : loadCustomProviderSettingsFromUrl(customProviderConfigUrl)

    const applyUrlSettings = async (baseSettings: Partial<AppSettings>) => {
      const ids = getExplicitUrlSettingsIds(searchParams)
      const restored = await restoreExplicitPresetConfig(ids)
      const restoredSettings = useStore.getState().settings
      const sourceSettings = restored
        ? { ...restoredSettings, ...baseSettings, customProviders: restoredSettings.customProviders, profiles: restoredSettings.profiles }
        : baseSettings
      const nextSettings = buildSettingsFromUrlParams(sourceSettings, searchParams)
      return Object.keys(nextSettings).length ? nextSettings : sourceSettings
    }

    const clearAppliedUrlSettings = () => {
      if (!hasUrlSettingParams(searchParams)) return

      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    void initStore()
      .then(async () => {
        const importedSettings = embeddedDefaultConfig || customProviderConfigUrl
          ? await loadDefaultConfig()
          : hasDefaultPresetConfig()
            ? {
                customProviders: [],
                profiles: [{ ...createDefaultOpenAIProfile(), isDefault: true }],
              }
            : null
        setPresetConfig(importedSettings)

        const state = useStore.getState()
        if (importedSettings) {
          await state.setPresetImportedSettings(importedSettings)
        } else if (state.previousPresetConfig) {
          await state.setPresetImportedSettings({ customProviders: [], profiles: [] })
        }

        const syncedState = useStore.getState()
        if (!importedSettings) {
          useStore.setState({ dismissedPresetProfileIds: [], dismissedPresetProviderIds: [] })
          if (syncedState.settings.profiles.some((profile) => profile.isDefault)) {
            syncedState.setSettings({
              profiles: syncedState.settings.profiles.map((profile) => profile.isDefault ? { ...profile, isDefault: undefined } : profile),
            })
          }
        }

        const current = useStore.getState()
        const presetIds = getPresetProfileIds()
        const defaultPresetId = getDefaultPresetProfileId()
        const settings = isPresetConfigOnlyEnabled()
          ? normalizeSettings({
              ...current.settings,
              activeProfileId: presetIds.has(current.settings.activeProfileId)
                ? current.settings.activeProfileId
                : defaultPresetId ?? [...presetIds][0],
              agentTextProfileId: current.settings.agentTextProfileId && presetIds.has(current.settings.agentTextProfileId)
                ? current.settings.agentTextProfileId
                : current.settings.profiles.find((profile) => presetIds.has(profile.id) && isAgentTextApiProfile(profile))?.id ?? null,
              agentImageProfileId: current.settings.agentImageProfileId && presetIds.has(current.settings.agentImageProfileId)
                ? current.settings.agentImageProfileId
                : defaultPresetId ?? [...presetIds][0],
            })
          : current.settings
        current.setSettings(await applyUrlSettings(settings))
        clearAppliedUrlSettings()
      })
      .catch((error) => {
        console.warn('Failed to import preset config:', error)
        setPresetConfig(null)
        const state = useStore.getState()
        void applyUrlSettings(state.settings).then((settings) => {
          useStore.getState().setSettings(settings)
          clearAppliedUrlSettings()
        })
      })
  }, [])

  useEffect(() => {
    const err = (window as any).__oauthCallbackError
    if (err) {
      delete (window as any).__oauthCallbackError
      useStore.getState().showToast(String(err), 'error')
    }
  }, [])

  useEffect(() => {
    applyThemeClass(readStoredTheme())
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.location.pathname.startsWith('/oauth/callback')) return
    if (sakrylleGetStoredToken()) return

    let prompted = false
    try {
      prompted = window.localStorage.getItem(SAKRYLLE_FIRST_VISIT_KEY) === '1'
    } catch {
      prompted = false
    }
    if (prompted) return

    try {
      window.localStorage.setItem(SAKRYLLE_FIRST_VISIT_KEY, '1')
    } catch {
      // ignore
    }

    setConfirmDialog({
      title: t('welcome.title'),
      message: t('welcome.message'),
      icon: 'info',
      buttons: [
        {
          label: t('welcome.skip'),
          tone: 'secondary',
          action: () => {},
        },
        {
          label: t('welcome.login'),
          tone: 'primary',
          action: () => {
            void sakrylleBeginLogin()
          },
        },
      ],
    })
  }, [setConfirmDialog, t])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <>
      <Header />
      {appMode === 'agent' ? (
        <AgentWorkspace />
      ) : (
        <main data-home-main data-drag-select-surface className="pb-48">
          <div className="safe-area-x max-w-7xl mx-auto">
            <SearchBar />
            {filterFavorite && !activeFavoriteCollectionId ? <FavoriteCollectionsView /> : <TaskGrid />}
          </div>
        </main>
      )}
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <SupportPromptModal />
      <FavoriteCollectionPickerModal />
      <ManageCollectionsModal />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
