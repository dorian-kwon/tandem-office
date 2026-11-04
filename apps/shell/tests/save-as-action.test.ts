import { describe, expect, it, vi } from 'vitest'
import { saveAsNoticeFor } from '../src/renderer/src/translate/save-as-action'
import { translateText } from '../src/renderer/src/i18n/strings-translate'
import { LANGS } from '@genoffice/i18n'
import { TranslateIpcError } from '../src/shared/translate-api'

const args = { dir: '/p', file: 'a.docx' }

describe('saveAsNoticeFor', () => {
  it('says nothing when the person cancels the dialog', async () => {
    const api = { exportTranslation: vi.fn(async () => ({ status: 'canceled' as const })) }
    expect(await saveAsNoticeFor('en', api, args)).toBeNull()
    expect(api.exportTranslation).toHaveBeenCalledWith(args)
  })

  it('confirms a finished Save as', async () => {
    const api = { exportTranslation: async () => ({ status: 'saved' as const, path: '/x/a.docx' }) }
    expect(await saveAsNoticeFor('ko', api, args)).toEqual({
      text: translateText('ko', 'saveAsDone'),
      isError: false,
    })
  })

  it('tells the person to save first when the editor has unsaved changes', async () => {
    const api = { exportTranslation: async () => ({ status: 'unsaved' as const }) }
    expect(await saveAsNoticeFor('en', api, args)).toEqual({
      text: translateText('en', 'saveAsUnsaved'),
      isError: true,
    })
  })

  it('shows the localized message of a refused or missing export, never the raw error', async () => {
    const refused = {
      exportTranslation: async () => {
        throw new TranslateIpcError('EXPORT_REFUSED', 'raw english')
      },
    }
    expect(await saveAsNoticeFor('de', refused, args)).toEqual({
      text: translateText('de', 'errExportRefused'),
      isError: true,
    })
    const missing = {
      exportTranslation: async () => {
        throw new TranslateIpcError('OUTPUT_MISSING', 'raw english')
      },
    }
    expect((await saveAsNoticeFor('en', missing, args))?.text).toBe(
      translateText('en', 'errOutputMissing'),
    )
  })
})

describe('Save as strings', () => {
  it('has the button label and both notices in every UI language', () => {
    for (const lang of LANGS) {
      for (const key of ['saveAsTranslation', 'saveAsDone', 'saveAsUnsaved'] as const)
        expect(translateText(lang, key).length, `${lang} ${key}`).toBeGreaterThan(2)
    }
    expect(translateText('en', 'saveAsTranslation')).toBe('Save as…')
    expect(translateText('ko', 'saveAsTranslation')).toBe('다른 이름으로 저장…')
  })
})
