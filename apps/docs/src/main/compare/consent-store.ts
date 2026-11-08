/**
 * The person's one-time acknowledgement of what the AI compare feature sends
 * where. Kept in its own small file in the data folder (`web-compare.json`):
 * the AI settings file is owned by the provider code, and this value is not a
 * provider choice. Reads never throw; anything unreadable counts as "not yet".
 */
export interface ConsentFs {
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

/** bump when the wording of what is sent changes: an older acknowledgement then asks again */
export const COMPARE_CONSENT_VERSION = 1

export async function readCompareConsent(fs: ConsentFs): Promise<boolean> {
  try {
    const text = await fs.read()
    if (!text) return false
    const value = JSON.parse(text) as { consentVersion?: unknown }
    return value.consentVersion === COMPARE_CONSENT_VERSION
  } catch {
    return false
  }
}

export async function writeCompareConsent(fs: ConsentFs): Promise<void> {
  await fs.write(JSON.stringify({ consentVersion: COMPARE_CONSENT_VERSION }) + '\n')
}
