import { describe, expect, it } from 'vitest'
import {
  EDITABLE_SOURCE_EXTENSIONS,
  IMAGE_SOURCE_EXTENSIONS,
  UnsupportedSourceError,
  classifySource,
} from '@genoffice/translate-project'
import { ROUTED_EXTENSIONS, appForPath } from '../src/main/app-routing'
import { SOURCE_DIALOG_EXTENSIONS } from '../src/main/translate/translate-ipc'

const sorted = (list: readonly string[]) => [...new Set(list)].sort()

/**
 * A translation source is a document an editor tab opens (or a PDF, or an
 * image OCR reads). translate-project cannot import the shell, so its list is
 * held equal to the routing table here: adding or dropping an extension in
 * app-routing.ts without the other fails this test.
 */
describe('translation source types follow the app routing table', () => {
  it('the editable source list is every routed extension except PDF', () => {
    const routed = Object.values(ROUTED_EXTENSIONS)
      .flat()
      .filter((ext) => ext !== 'pdf')
    expect(sorted(EDITABLE_SOURCE_EXTENSIONS)).toEqual(sorted(routed))
  })

  it('every editable source opens in an editor tab, never the PDF one', () => {
    for (const ext of EDITABLE_SOURCE_EXTENSIONS) {
      const app = appForPath(`/p/a.${ext}`)
      expect(app, ext).toBeDefined()
      expect(app, ext).not.toBe('pdf')
      expect(classifySource(`a.${ext}`)).toBe('editable')
    }
  })

  it('only PNG and JPEG are image sources; OpenDocument sheets and slides are refused', () => {
    expect(sorted(IMAGE_SOURCE_EXTENSIONS)).toEqual(['jpeg', 'jpg', 'png'])
    for (const name of ['a.ods', 'a.odp', 'a.gif', 'a.webp', 'a.tiff', 'a.bmp'])
      expect(() => classifySource(name)).toThrow(UnsupportedSourceError)
  })

  it('the add-source dialog offers exactly the accepted types', () => {
    expect(sorted(SOURCE_DIALOG_EXTENSIONS)).toEqual(
      sorted([...EDITABLE_SOURCE_EXTENSIONS, 'pdf', ...IMAGE_SOURCE_EXTENSIONS]),
    )
  })
})
