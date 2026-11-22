/**
 * A short fingerprint of a paragraph's translatable text (FNV-1a, base 36).
 * read_runs hands it out and translate_blocks checks it, so an index that
 * shifted since the read (an earlier edit in the same turn, a user edit)
 * cannot write a translation into the wrong paragraph.
 */
export function runFingerprint(segments: readonly string[]): string {
  let hash = 0x811c9dc5
  const text = segments.join('\u0001')
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
