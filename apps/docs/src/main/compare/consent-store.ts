/**
 * The person's small settings of the AI compare feature, kept in one file in the
 * data folder (`web-compare.json`): the one-time acknowledgement of what is sent
 * where, and the "include re-translation" choice. The AI settings file is owned by
 * the provider code and these values are not provider choices, hence their own
 * file. Reads never throw; anything unreadable counts as "not yet" / the default.
 */
export interface ConsentFs {
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

/** bump when the wording of what is sent changes: an older acknowledgement then asks again */
export const COMPARE_CONSENT_VERSION = 1

interface Stored {
  consentVersion?: unknown
  retranslate?: unknown
}

async function readStored(fs: ConsentFs): Promise<Stored> {
  try {
    const text = await fs.read()
    if (!text) return {}
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Stored) : {}
  } catch {
    return {}
  }
}

async function writeStored(fs: ConsentFs, patch: Stored): Promise<void> {
  // keep whatever else the file holds (the two values are written independently)
  const next = { ...(await readStored(fs)), ...patch }
  await fs.write(JSON.stringify(next) + '\n')
}

export async function readCompareConsent(fs: ConsentFs): Promise<boolean> {
  return (await readStored(fs)).consentVersion === COMPARE_CONSENT_VERSION
}

export async function writeCompareConsent(fs: ConsentFs): Promise<void> {
  await writeStored(fs, { consentVersion: COMPARE_CONSENT_VERSION })
}

/** whether the sites also re-translate the Korean original; on unless the person turned it off */
export async function readCompareRetranslate(fs: ConsentFs): Promise<boolean> {
  return (await readStored(fs)).retranslate !== false
}

export async function writeCompareRetranslate(fs: ConsentFs, on: boolean): Promise<void> {
  await writeStored(fs, { retranslate: on })
}
