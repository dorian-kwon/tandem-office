/**
 * The person's small settings of the AI compare feature, kept in one file in the
 * data folder (`web-compare.json`): the one-time acknowledgement of what is sent
 * where, and the popup's choices (engine switches, re-translation, auto integrate). The AI settings file is owned by
 * the provider code and these values are not provider choices, hence their own
 * file. Reads never throw; anything unreadable counts as "not yet" / the default.
 */
import type { ComparePrefs } from '../../shared/compare'

export interface ConsentFs {
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

/** bump when the wording of what is sent changes: an older acknowledgement then asks again */
export const COMPARE_CONSENT_VERSION = 1

interface Stored {
  consentVersion?: unknown
  retranslate?: unknown
  autoIntegrate?: unknown
  engines?: unknown
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

/** the popup's remembered choices, each only when it holds a valid value */
export async function readComparePrefs(fs: ConsentFs): Promise<ComparePrefs> {
  const stored = await readStored(fs)
  return sanitizePrefs(stored)
}

/** merge a change into the remembered choices (engine switches merge per engine); nothing else is touched */
export async function writeComparePrefs(fs: ConsentFs, patch: unknown): Promise<void> {
  const clean = sanitizePrefs(patch)
  const current = sanitizePrefs(await readStored(fs))
  const next: ComparePrefs = { ...current, ...clean }
  if (clean.engines) next.engines = { ...current.engines, ...clean.engines }
  await writeStored(fs, next as Stored)
}

function sanitizePrefs(value: unknown): ComparePrefs {
  const out: ComparePrefs = {}
  if (!value || typeof value !== 'object') return out
  const raw = value as Record<string, unknown>
  if (typeof raw.retranslate === 'boolean') out.retranslate = raw.retranslate
  if (typeof raw.autoIntegrate === 'boolean') out.autoIntegrate = raw.autoIntegrate
  if (raw.engines && typeof raw.engines === 'object' && !Array.isArray(raw.engines)) {
    const engines: Record<string, boolean> = {}
    for (const [id, on] of Object.entries(raw.engines as Record<string, unknown>)) {
      if (typeof on === 'boolean' && id.length <= 40) engines[id] = on
    }
    out.engines = engines
  }
  return out
}
