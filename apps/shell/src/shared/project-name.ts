/** Longest display name a translation project may have. */
export const PROJECT_NAME_MAX = 80

/**
 * The trimmed display name, or null when it is empty, longer than PROJECT_NAME_MAX or has
 * a control character (line breaks included). Names need not be unique.
 */
export function normalizeProjectName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  // eslint-disable-next-line no-control-regex
  if (name === '' || name.length > PROJECT_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name))
    return null
  return name
}
