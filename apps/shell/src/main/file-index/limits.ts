/** body text kept for snippets and indexed; longer files are cut */
export const MAX_BODY_CHARS = 1_000_000

/** ZIP formats whose body can be streamed even when media makes the file large. */
export const INDEX_STREAMING_EXTS = new Set([
  'docx',
  'xlsx',
  'xlsm',
  'pptx',
  'odt',
  'epub',
  'xmind',
])
export const MAX_EXTRACT_BYTES = 64 * 1024 * 1024
