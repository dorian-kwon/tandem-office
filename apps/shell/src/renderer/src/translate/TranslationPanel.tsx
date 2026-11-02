import { useState } from 'react'
import { ProjectDetail } from './ProjectDetail'
import { ProjectList } from './ProjectList'

/**
 * The translation tool's home screen: the project list, or one project's
 * detail screen once opened.
 */
export function TranslationPanel() {
  const [openDir, setOpenDir] = useState<string | null>(null)

  if (openDir === null) return <ProjectList onOpen={setOpenDir} />
  return (
    <ProjectDetail
      dir={openDir}
      onBack={() => setOpenDir(null)}
      // The translation view arrives in Task 9, which supplies the real handler;
      // until then starting a translation has no destination.
      onStartTranslation={noStartTranslation}
    />
  )
}

function noStartTranslation(_sourceFile: string): void {}
