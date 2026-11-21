/**
 * The PC's fonts in the editor's font lists from the start.
 *
 * The studio reads only the fonts it found last time; looking at the PC again is the
 * 찾기 button in its options dialog, so a user who never pressed it saw the seven base
 * fonts and the document's own, and a font installed later stayed out of the list. On a
 * website that is deliberate (the browser asks the user before listing the fonts); the app
 * already lets its pages list them, as the Word, Excel and PowerPoint pickers do.
 *
 * Startup compares the enumerated face names with the saved catalog. When it
 * changes, the app supplies Korean family names from its cached SFNT table
 * reader in main. The studio options dialog can enrich these with the full
 * aliases on explicit detection.
 */

/** Module specifier the studio-pc-fonts patch imports; build-studio.mjs aliases it. */
export const PC_FONTS_MODULE = '@ieum/pc-fonts'

/** A font name the way the studio compares them (its `normalizeFontAlias`). */
const alias = (value) =>
  typeof value === 'string'
    ? value
        .replaceAll('\u0000', '')
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase('en-US')
    : ''

/** The name the studio keys one listed face by: PostScript name, else full name, else family. */
const faceKey = (face) => alias(face.postscriptName) || alias(face.fullName) || alias(face.family)

/**
 * Whether the kept records already hold exactly the faces the PC lists now: as many faces,
 * and each listed one known under some name of a record (a record merges the names the
 * enumeration gave with those read from the file). Records the studio found by trying a
 * name (a presence probe) are not part of the list and are left out.
 */
export function sameFaces(listed, kept) {
  const faces = kept.filter((record) => record.detectionSource !== 'font-presence-probe')
  const now = new Set(listed.map(faceKey).filter(Boolean))
  if (now.size !== faces.length) return false
  const known = new Set(
    faces.flatMap((record) =>
      [record.postscriptName, record.fullName, record.family, ...(record.aliases ?? [])].map(alias),
    ),
  )
  for (const key of now) if (!known.has(key)) return false
  return true
}

/** Resolves once the page is visible: the enumeration refuses a hidden page (a tab opened behind another). */
function whenVisible(doc) {
  if (!doc || doc.visibilityState === 'visible') return Promise.resolve()
  return new Promise((resolve) => {
    const onShow = () => {
      if (doc.visibilityState !== 'visible') return
      doc.removeEventListener('visibilitychange', onShow)
      resolve()
    }
    doc.addEventListener('visibilitychange', onShow)
  })
}

/** Enumerated faces are metadata objects; never spread them or call blob().
 * Older explicit searches may have richer face names and aliases. Keep those
 * for surviving faces when fonts are installed or removed. */
async function enumeratedRecords(listed, studio) {
  const families = [...new Set(listed.map((face) => face.family).filter(Boolean))]
  let localized = new Map()
  try {
    if (studio.familyInfo) localized = new Map(await studio.familyInfo(families))
  } catch {
    // A standalone studio or an unavailable metadata service still has the OS names.
  }
  const kept = new Map(
    studio
      .records()
      .filter((r) => r.detectionSource !== 'font-presence-probe')
      .map((r) => [faceKey(r), r]),
  )
  return listed.map(({ family, fullName, postscriptName, style }) => {
    const from = kept.get(faceKey({ family, fullName, postscriptName }))
    const ko = localized.get(family)?.ko
    const koFace = ko && style && !/^(regular|normal|roman)$/i.test(style) ? ko + ' ' + style : ko
    return {
      family,
      fullName,
      postscriptName,
      style,
      displayName: from?.displayName ?? koFace ?? fullName ?? family,
      aliases: [...(from?.aliases ?? []), ...(ko ? [ko, koFace] : [])],
    }
  })
}

/**
 * @param {{
 *   headless?: boolean,
 *   queryLocalFonts?: () => Promise<ReadonlyArray<{ family?: string; fullName?: string; postscriptName?: string; style?: string }>>,
 *   loadStored: () => Promise<unknown>,
 *   records: () => ReadonlyArray<{ family?: string; fullName?: string; postscriptName?: string; aliases?: readonly string[]; detectionSource?: string }>,
 *   familyInfo?: (families: string[]) => Promise<ReadonlyArray<readonly [string, {ko?: string}]>>,
 *   update: (records: object[]) => Promise<unknown>,
 *   changed: () => void,
 *   document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
 * }} studio
 * @returns {Promise<boolean>} whether the studio's list was detected anew
 */
export async function refreshPcFonts(studio) {
  if (studio.headless ?? new URLSearchParams(globalThis.location?.search).get('headless') === '1') {
    try {
      await studio.loadStored()
    } catch (error) {
      console.warn('[pc-fonts] Could not load the saved font list:', error)
    }
    return false
  }
  if (!studio.queryLocalFonts) return false
  try {
    await whenVisible(studio.document)
    await studio.loadStored()
    const listed = await studio.queryLocalFonts()
    if (listed.length === 0 || sameFaces(listed, studio.records())) return false
    await studio.update(await enumeratedRecords(listed, studio))
    studio.changed()
    return true
  } catch (error) {
    console.warn('[pc-fonts] PC font list not refreshed; the kept list stays:', error)
    return false
  }
}
