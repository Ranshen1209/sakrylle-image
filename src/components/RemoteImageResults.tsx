import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isHttpUrl } from '../lib/imageApiShared'

/** A remote <img> can display without CORS permission; it is not a local save. */
export default function RemoteImageResults({ urls }: { urls: string[] }) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState<Record<string, boolean>>({})
  const links = [...new Set(urls.filter(isHttpUrl))]
  if (!links.length) return null
  return <div className="mt-3 max-h-[35vh] space-y-3 overflow-y-auto text-sm">
    <p className="text-gray-500 dark:text-gray-400">{t('detail.remotePreview')}</p>
    {links.map(url => <div key={url} className="space-y-2">
      {failed[url] ? <p className="text-gray-500">{t('detail.remoteUnavailable')}</p> :
        <img src={url} alt={t('detail.remotePreview')} referrerPolicy="no-referrer" loading="lazy"
          className="mx-auto max-h-48 rounded-xl object-contain" onError={() => setFailed(current => ({ ...current, [url]: true }))} />}
      <a href={url} target="_blank" rel="noopener noreferrer" className="inline-block text-[#9181bd] underline dark:text-[#b9a9da]">{t('detail.openOriginal')}</a>
    </div>)}
  </div>
}
