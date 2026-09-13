import { flushSync } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { useVersionCheck } from '../hooks/useVersionCheck'
import { useTooltip } from '../hooks/useTooltip'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import ViewportTooltip from './ViewportTooltip'
import HistoryModal from './HistoryModal'
import { useFavoriteCollectionTitle } from './FavoriteCollections'
import { CoinIcon, EditIcon, HistoryIcon, SettingsIcon } from './icons'
import { fetchBalance, formatBalance, type SakrylleBalance } from '../lib/sakrylleAccount'
import { beginLogin as sakrylleBeginLogin, getStoredToken } from '../lib/sakrylleAuth'
import { getThemeSwitchOrigin, readStoredTheme, switchTheme, type Theme } from '../lib/theme'
import type { Language } from '../lib/language'

const SAKRYLLE_PURCHASE_URL = 'https://ai1.sakrylle.com/purchase'

export default function Header() {
  const { t, i18n } = useTranslation()
  const appMode = useStore((s) => s.appMode)
  const setAppMode = useStore((s) => s.setAppMode)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const agentMobileHeaderVisible = useStore((s) => s.agentMobileHeaderVisible)
  const agentConversations = useStore((s) => s.agentConversations)
  const activeAgentConversationId = useStore((s) => s.activeAgentConversationId)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const activeConversation = agentConversations.find((item) => item.id === activeAgentConversationId)
  const favoriteCollectionTitle = useFavoriteCollectionTitle()
  const showFavoriteCollectionTitle = appMode === 'gallery' && Boolean(activeFavoriteCollectionId)
  const { hasUpdate, latestRelease, dismiss } = useVersionCheck()
  const [scrollDirection, setScrollDirection] = useState<'up' | 'down'>('up')
  const [hintVisible, setHintVisible] = useState(false)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const historyButtonRef = useRef<HTMLButtonElement>(null)
  const createConversation = useStore((s) => s.createAgentConversation)
  const balanceTooltip = useTooltip()
  const rechargeTooltip = useTooltip()
  const settingsTooltip = useTooltip()
  const loginTooltip = useTooltip()
  const themeTooltip = useTooltip()
  const languageTooltip = useTooltip()
  const [balance, setBalance] = useState<SakrylleBalance | null>(null)
  const [loggedIn, setLoggedIn] = useState<boolean>(() => Boolean(getStoredToken()))
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme())
  const currentLanguage: Language = i18n.language === 'en' ? 'en' : 'zh'

  useEffect(() => {
    if (appMode === 'agent') {
      setScrollDirection('up')
      return
    }

    let lastScrollY = window.scrollY
    let ticking = false

    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          const currentScrollY = window.scrollY
          if (currentScrollY < 20) {
            setScrollDirection('up')
          } else if (currentScrollY > lastScrollY + 10) {
            setScrollDirection('down')
          } else if (currentScrollY < lastScrollY - 10) {
            setScrollDirection('up')
          }
          lastScrollY = currentScrollY
          ticking = false
        })
        ticking = true
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [appMode])

  useEffect(() => {
    if (appMode === 'agent' && !agentMobileHeaderVisible) {
      setHintVisible(true)
      const timer = setTimeout(() => {
        setHintVisible(false)
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [appMode, agentMobileHeaderVisible])

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const hasToken = Boolean(getStoredToken())
      if (!cancelled) setLoggedIn(hasToken)
      if (!hasToken) {
        if (!cancelled) setBalance(null)
        return
      }
      try {
        const next = await fetchBalance()
        if (!cancelled) setBalance(next)
      } catch (err: unknown) {
        // fetchBalance throws 'oauth_logged_out' on 401 after authedFetch
        // already called logout(). Clear UI state immediately.
        if (err instanceof Error && err.message === 'oauth_logged_out') {
          if (!cancelled) {
            setLoggedIn(false)
            setBalance(null)
          }
        }
      }
    }
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    refreshIfVisible()
    const id = window.setInterval(refreshIfVisible, 60_000)
    const handleStorage = (event: StorageEvent) => {
      if (event.key === 'sakrylle-image-playground.auth') void refresh()
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('storage', handleStorage)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('storage', handleStorage)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  const handleRecharge = () => {
    window.open(SAKRYLLE_PURCHASE_URL, '_blank', 'noopener,noreferrer')
  }

  const handleLogin = () => {
    dismissAllTooltips()
    void sakrylleBeginLogin()
  }

  const handleToggleTheme = (event: React.MouseEvent<HTMLButtonElement>) => {
    dismissAllTooltips()
    const origin = getThemeSwitchOrigin(event)
    const current: Theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    const next: Theme = current === 'dark' ? 'light' : 'dark'
    switchTheme(next, { origin, onApply: () => flushSync(() => setThemeState(next)) })
  }

  const handleToggleLanguage = () => {
    dismissAllTooltips()
    const next: Language = currentLanguage === 'zh' ? 'en' : 'zh'
    void i18n.changeLanguage(next)
  }

  return (
    <>
      <header
        data-no-drag-select
        className={`safe-area-top fixed top-0 left-0 right-0 z-40 glass-panel border-b border-white/40 dark:border-white/[0.08] transition-transform duration-300 ease-in-out ${appMode === 'agent' && !agentMobileHeaderVisible ? '-translate-y-full lg:translate-y-0' : 'translate-y-0'}`}
      >
        <div className="safe-area-x safe-header-inner max-w-7xl mx-auto flex items-center justify-between gap-2 relative">
          <div className="flex min-w-0 flex-1 items-center gap-2 pr-1 xl:pr-2">
            <h1 className="relative inline-flex min-w-0 items-start mr-2">
              {showFavoriteCollectionTitle ? (
                <>
                  <span className="min-w-0 truncate whitespace-nowrap text-[17px] font-medium tracking-tight text-gray-800 dark:text-gray-100 sm:hidden" title={favoriteCollectionTitle}>{favoriteCollectionTitle}</span>
                  <a
                    href="https://github.com/Ranshen1209/sakrylle-image"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group hidden min-w-0 items-center gap-2 sm:inline-flex"
                    aria-label={t('header.appName')}
                  >
                    <span className="relative inline-flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 overflow-hidden rounded-full transition-transform group-hover:scale-105">
                      <img src="./favicon.png" alt="" className="h-full w-full object-contain select-none" draggable={false} />
                    </span>
                    <span className="truncate whitespace-nowrap text-[17px] font-medium tracking-tight text-gray-800 transition-colors group-hover:text-[#7d6cb0] dark:text-gray-100 dark:group-hover:text-[#c4b8e0] sm:text-lg">
                      {t('header.appName')}
                    </span>
                  </a>
                </>
              ) : (
                <a
                  href="https://github.com/Ranshen1209/sakrylle-image"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex min-w-0 items-center gap-2"
                  aria-label={t('header.appName')}
                >
                  <span className="relative inline-flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 overflow-hidden rounded-full transition-transform group-hover:scale-105">
                    <img src="./favicon.png" alt="" className="h-full w-full object-contain select-none" draggable={false} />
                  </span>
                  <span className="truncate whitespace-nowrap text-[17px] font-medium tracking-tight text-gray-800 transition-colors group-hover:text-[#7d6cb0] dark:text-gray-100 dark:group-hover:text-[#c4b8e0] sm:text-lg">
                    {t('header.appName')}
                  </span>
                </a>
              )}
              {hasUpdate && latestRelease && (
                <a
                  href={latestRelease.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.stopPropagation()
                    dismiss()
                  }}
                  className="absolute -right-1 -top-1 translate-x-full -translate-y-1/4 px-1 py-0.5 rounded-[4px] border border-red-500/30 text-[9px] font-black bg-red-500 text-white hover:bg-red-600 transition-all animate-fade-in leading-none shadow-sm"
                  title={t('header.newVersionTitle', { tag: latestRelease.tag })}
                >
                  {t('header.newVersionBadge')}
                </a>
              )}
            </h1>
            {appMode === 'agent' && <div className="relative ml-1 hidden items-center gap-1 xl:flex">
              <button
                ref={historyButtonRef}
                type="button"
                onClick={() => setShowHistoryModal((visible) => !visible)}
                className="p-1.5 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-white/40 dark:hover:bg-white/[0.06] rounded-lg transition-colors"
                title={t('header.history')}
              >
                <HistoryIcon className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setAppMode('agent')
                  createConversation()
                }}
                className="p-1.5 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-white/40 dark:hover:bg-white/[0.06] rounded-lg transition-colors"
                title={t('header.newConversation')}
              >
                <EditIcon className="w-5 h-5" />
              </button>
              {showHistoryModal && (
                <HistoryModal onClose={() => setShowHistoryModal(false)} ignoreOutsideClickRef={historyButtonRef} />
              )}
            </div>}
          </div>
          {appMode === 'agent' && activeConversation && (
            <div className="absolute left-1/2 top-1/2 hidden max-w-[24%] -translate-x-1/2 -translate-y-1/2 xl:flex">
              <button
                type="button"
                onClick={() => {
                  setShowHistoryModal(true)
                  setTimeout(() => {
                    useStore.getState().setAgentEditingConversationId(activeConversation.id)
                  }, 0)
                }}
                className="text-sm font-semibold text-gray-700 dark:text-gray-300 truncate hover:bg-white/40 dark:hover:bg-white/[0.06] px-2 py-1 rounded transition-colors"
              >
                {activeConversation.title || 'Agent'}
              </button>
            </div>
          )}
          {showFavoriteCollectionTitle && (
            <div className="absolute left-1/2 top-1/2 hidden max-w-[30%] -translate-x-1/2 -translate-y-1/2 xl:flex">
              <div className="truncate rounded px-2 py-1 text-sm font-semibold text-gray-700 dark:text-gray-300" title={favoriteCollectionTitle}>
                {favoriteCollectionTitle}
              </div>
            </div>
          )}
          <div className="mr-1 hidden shrink-0 items-center gap-1 rounded-2xl glass-button p-1 lg:flex xl:mr-3">
            <button
              type="button"
              onClick={() => setAppMode('gallery')}
              className={`px-3 py-1.5 rounded-xl text-sm transition-all xl:px-4 ${appMode === 'gallery' ? 'bg-white/85 dark:bg-white/15 text-[#5b4d8e] dark:text-white shadow-sm font-semibold' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              {t('header.gallery')}
            </button>
            <button
              type="button"
              onClick={() => setAppMode('agent')}
              className={`px-3 py-1.5 rounded-xl text-sm transition-all xl:px-4 ${appMode === 'agent' ? 'bg-white/85 dark:bg-white/15 text-[#5b4d8e] dark:text-white shadow-sm font-semibold' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              {t('header.agent')}
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            {balance && (
              <div className="glass-button hidden h-9 items-stretch gap-0 overflow-hidden rounded-full sm:inline-flex">
                <div
                  className="relative flex"
                  {...balanceTooltip.handlers}
                >
                  <button
                    type="button"
                    onClick={() => setShowSettings(true)}
                    className="inline-flex items-center gap-1.5 bg-transparent px-3 text-xs font-semibold text-[#5b4d8e] transition-colors hover:bg-white/20 dark:text-[#c4b8e0] dark:hover:bg-white/[0.06]"
                    aria-label={t('header.balanceAria', { amount: formatBalance(balance.creditRemaining, balance.currencyDisplay) })}
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-gradient-to-br from-[#b9a9da] to-[#7d6cb0]" />
                    {formatBalance(balance.creditRemaining, balance.currencyDisplay)}
                  </button>
                  <ViewportTooltip visible={balanceTooltip.visible} className="whitespace-nowrap">
                    {[balance.username, balance.groupName].filter(Boolean).join(' · ')}
                  </ViewportTooltip>
                </div>
                <div
                  className="relative flex"
                  {...rechargeTooltip.handlers}
                >
                  <button
                    type="button"
                    onClick={() => {
                      dismissAllTooltips()
                      handleRecharge()
                    }}
                    className="inline-flex items-center gap-1 px-3 text-xs font-semibold bg-transparent hover:bg-white/20 dark:hover:bg-white/[0.06] transition-colors border-l border-white/40 dark:border-white/10 text-[#5b4d8e] dark:text-[#c4b8e0]"
                    aria-label={t('header.rechargeAria')}
                  >
                    <CoinIcon className="w-3.5 h-3.5" />
                    {t('header.rechargeLabel')}
                  </button>
                  <ViewportTooltip visible={rechargeTooltip.visible} className="whitespace-nowrap">
                    {t('header.rechargeTooltip')}
                  </ViewportTooltip>
                </div>
              </div>
            )}
            {!balance && loggedIn && (
              <button
                type="button"
                onClick={() => {
                  dismissAllTooltips()
                  handleRecharge()
                }}
                className="hidden sm:inline-flex h-9 items-center gap-1 px-3 rounded-full text-xs font-semibold glass-button text-[#5b4d8e] dark:text-[#c4b8e0]"
                aria-label={t('header.rechargeAria')}
              >
                <CoinIcon className="w-3.5 h-3.5" />
                {t('header.rechargeLabel')}
              </button>
            )}
            {!loggedIn && (
              <div
                className="relative"
                {...loginTooltip.handlers}
              >
                <button
                  type="button"
                  onClick={handleLogin}
                  className="hidden h-9 items-center gap-1 rounded-xl px-2.5 text-xs font-semibold glass-button text-[#5b4d8e] dark:text-[#c4b8e0] lg:inline-flex"
                  aria-label={t('header.loginAria')}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                    <polyline points="10 17 15 12 10 7" />
                    <line x1="15" y1="12" x2="3" y2="12" />
                  </svg>
                  {t('header.loginShort')}
                </button>
                <ViewportTooltip visible={loginTooltip.visible} className="whitespace-nowrap">
                  {t('header.loginTooltip')}
                </ViewportTooltip>
              </div>
            )}
            <div
              className="relative"
              {...themeTooltip.handlers}
            >
              <button
                type="button"
                onClick={handleToggleTheme}
                className="p-2 rounded-xl glass-button"
                aria-label={theme === 'dark' ? t('header.themeAriaToLight') : t('header.themeAriaToDark')}
              >
                {theme === 'dark' ? (
                  <svg className="w-5 h-5 text-gray-700 dark:text-gray-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-gray-700 dark:text-gray-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                )}
              </button>
              <ViewportTooltip visible={themeTooltip.visible} className="whitespace-nowrap">
                {theme === 'dark' ? t('header.themeToLight') : t('header.themeToDark')}
              </ViewportTooltip>
            </div>
            <div
              className="relative"
              {...languageTooltip.handlers}
            >
              <button
                type="button"
                onClick={handleToggleLanguage}
                className="p-2 rounded-xl glass-button"
                aria-label={t('header.languageAria')}
              >
                <svg className="w-5 h-5 text-gray-700 dark:text-gray-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18" />
                  <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
                </svg>
              </button>
              <ViewportTooltip visible={languageTooltip.visible} className="whitespace-nowrap">
                {currentLanguage === 'zh' ? t('header.languageToEnglish') : t('header.languageToChinese')}
              </ViewportTooltip>
            </div>
            <div
              className="relative"
              {...settingsTooltip.handlers}
            >
              <button
                onClick={() => setShowSettings(true)}
                className="p-2 rounded-xl glass-button"
                aria-label={t('header.settingsAria')}
              >
                <SettingsIcon className="w-5 h-5 text-gray-700 dark:text-gray-200" />
              </button>
              <ViewportTooltip visible={settingsTooltip.visible} className="whitespace-nowrap">
                {t('header.settings')}
              </ViewportTooltip>
            </div>
          </div>
        </div>
        <div className={`safe-area-x overflow-hidden transition-all duration-300 ease-in-out lg:hidden ${appMode === 'gallery' && scrollDirection === 'down' ? 'max-h-0 opacity-0 pb-0' : 'max-h-24 opacity-100 pb-2'}`}>
          {balance && (
            <div className="glass-button mx-2 mb-2 flex items-stretch rounded-full overflow-hidden">
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#5b4d8e] dark:text-[#c4b8e0] bg-transparent hover:bg-white/20 dark:hover:bg-white/[0.06] transition-colors"
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-gradient-to-br from-[#b9a9da] to-[#7d6cb0]" />
                {formatBalance(balance.creditRemaining, balance.currencyDisplay)}
              </button>
              <button
                type="button"
                onClick={handleRecharge}
                className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-semibold text-[#5b4d8e] dark:text-[#c4b8e0] bg-transparent hover:bg-white/20 dark:hover:bg-white/[0.06] transition-colors border-l border-white/40 dark:border-white/10"
              >
                <CoinIcon className="w-3.5 h-3.5" />
                {t('header.rechargeLabel')}
              </button>
            </div>
          )}
          {!loggedIn && (
            <div className="mx-2 mb-2">
              <button
                type="button"
                onClick={handleLogin}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl glass-button text-xs font-semibold text-[#5b4d8e] dark:text-[#c4b8e0]"
                aria-label={t('header.loginAria')}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                  <polyline points="10 17 15 12 10 7" />
                  <line x1="15" y1="12" x2="3" y2="12" />
                </svg>
                {t('header.loginLong')}
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-1 rounded-2xl glass-button p-1 mx-2">
            <button
              type="button"
              onClick={() => setAppMode('gallery')}
              className={`px-4 py-1.5 rounded-xl text-sm transition-all ${appMode === 'gallery' ? 'bg-white/85 dark:bg-white/15 text-[#5b4d8e] dark:text-white shadow-sm font-semibold' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              {t('header.gallery')}
            </button>
            <button
              type="button"
              onClick={() => setAppMode('agent')}
              className={`px-4 py-1.5 rounded-xl text-sm transition-all ${appMode === 'agent' ? 'bg-white/85 dark:bg-white/15 text-[#5b4d8e] dark:text-white shadow-sm font-semibold' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              {t('header.agent')}
            </button>
          </div>
        </div>
      </header>

      {/* Hint for sliding down */}
      <div className={`fixed top-0 left-0 right-0 z-30 flex justify-center pointer-events-none transition-all duration-300 ease-in-out lg:hidden ${appMode === 'agent' && hintVisible && !agentMobileHeaderVisible ? 'translate-y-[env(safe-area-inset-top,0px)] opacity-100' : '-translate-y-full opacity-0'}`}>
        <div className="bg-black/60 backdrop-blur-sm text-white text-xs px-3 py-1.5 rounded-b-xl shadow-lg">
          {t('header.pullToReveal')}
        </div>
      </div>

      <div className={`safe-area-top invisible pointer-events-none transition-all duration-300 ease-in-out ${appMode === 'agent' && !agentMobileHeaderVisible ? 'max-h-0 lg:max-h-[500px] opacity-0 lg:opacity-100 overflow-hidden lg:overflow-visible' : 'max-h-[500px] opacity-100'}`} aria-hidden="true">
        <div className="safe-header-inner" />
        <div className={`safe-area-x overflow-hidden transition-all duration-300 ease-in-out lg:hidden ${appMode === 'gallery' && scrollDirection === 'down' ? 'max-h-0 pb-0' : 'max-h-24 pb-2'}`}>
          {(balance || !loggedIn) && <div className="mx-2 mb-2 h-[34px]" />}
          <div className="mx-2 h-[72px]" />
        </div>
      </div>
    </>
  )
}
