import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../locale'
import { ProjectDetail } from './ProjectDetail'
import { ProjectList } from './ProjectList'
import { makeText, translateErrorText } from './shared'
import './translate-global'

/**
 * The translation tool's home screen: the project list, or one project's
 * detail screen once opened. "Open translation" on a source shows the
 * translation view (main: translate/open-translation.ts); a failure or a
 * changed source copy is reported on the detail screen.
 */
export function TranslationPanel() {
  const { lang } = useI18n()
  const s = makeText(lang)
  const [openDir, setOpenDir] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; isError: boolean } | null>(null)
  // the project the newest open request belongs to: a late answer for another
  // project (the person went back and opened a different one) is dropped
  const current = useRef<string | null>(null)
  useEffect(() => {
    current.current = openDir
    setNotice(null)
  }, [openDir])

  const startTranslation = async (dir: string, file: string): Promise<void> => {
    const api = window.translateApi
    if (!api) return
    setNotice(null)
    try {
      const result = await api.openTranslation({ dir, file })
      if (current.current !== dir) return
      setNotice(
        result.hashStatus === 'changed' ? { text: s('warnSourceChanged'), isError: false } : null,
      )
    } catch (err) {
      if (current.current !== dir) return
      setNotice({ text: translateErrorText(lang, err), isError: true })
    }
  }

  if (openDir === null) return <ProjectList onOpen={setOpenDir} />
  return (
    <ProjectDetail
      dir={openDir}
      onBack={() => setOpenDir(null)}
      onStartTranslation={(file) => void startTranslation(openDir, file)}
      startNotice={notice}
    />
  )
}
