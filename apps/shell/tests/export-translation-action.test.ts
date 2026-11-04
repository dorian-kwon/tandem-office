import { describe, expect, it, vi } from 'vitest'
import { exportNoticeFor } from '../src/renderer/src/translate/export-action'
import { translateText } from '../src/renderer/src/i18n/strings-translate'
import { TranslateIpcError } from '../src/shared/translate-api'

const args = { dir: '/p', file: 'a.docx' }

describe('exportNoticeFor', () => {
  it('says nothing when the person cancels the dialog', async () => {
    const api = { exportTranslation: vi.fn(async () => ({ status: 'canceled' as const })) }
    expect(await exportNoticeFor('en', api, args)).toBeNull()
    expect(api.exportTranslation).toHaveBeenCalledWith(args)
  })

  it('confirms a finished export', async () => {
    const api = { exportTranslation: async () => ({ status: 'saved' as const, path: '/x/a.docx' }) }
    expect(await exportNoticeFor('ko', api, args)).toEqual({
      text: translateText('ko', 'exportDone'),
      isError: false,
    })
  })

  it('tells the person to save first when the editor has unsaved changes', async () => {
    const api = { exportTranslation: async () => ({ status: 'unsaved' as const }) }
    expect(await exportNoticeFor('en', api, args)).toEqual({
      text: translateText('en', 'exportUnsaved'),
      isError: true,
    })
  })

  it('shows the localized message of a refused or missing export, never the raw error', async () => {
    const refused = {
      exportTranslation: async () => {
        throw new TranslateIpcError('EXPORT_REFUSED', 'raw english')
      },
    }
    expect(await exportNoticeFor('de', refused, args)).toEqual({
      text: translateText('de', 'errExportRefused'),
      isError: true,
    })
    const missing = {
      exportTranslation: async () => {
        throw new TranslateIpcError('OUTPUT_MISSING', 'raw english')
      },
    }
    expect((await exportNoticeFor('en', missing, args))?.text).toBe(
      translateText('en', 'errOutputMissing'),
    )
  })
})
