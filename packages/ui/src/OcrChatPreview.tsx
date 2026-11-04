import type { ChatOcrAnswer } from '@genoffice/project-store/folder-api'

export type OcrChatDisplay = NonNullable<ChatOcrAnswer['display']>

/**
 * The part of a tool's display that the chat shows for `document_ocr` (image previews or
 * link lists), or null for any other tool or display kind.
 */
export function ocrDisplayOf(
  toolName: string,
  display: { kind: string; items?: OcrChatDisplay['items'] } | undefined,
): OcrChatDisplay | null {
  if (toolName !== 'document_ocr' || !display) return null
  if (display.kind !== 'images' && display.kind !== 'links') return null
  return { kind: display.kind, ...(display.items ? { items: display.items } : {}) }
}

/** Local previews stay in the live chat UI, outside model input and persisted history. */
export function OcrChatPreview({ displays }: { displays?: readonly OcrChatDisplay[] | undefined }) {
  return (
    <>
      {displays?.map((display, i) => (
        <div
          key={i}
          className="ai-tool-output"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
        >
          {display.items?.map((item, j) =>
            display.kind === 'images' && /^data:image\/png;base64,/.test(item.url) ? (
              <figure key={j} style={{ margin: 0, maxWidth: 180 }}>
                <img
                  src={item.thumb ?? item.url}
                  alt={item.title ?? ''}
                  width={160}
                  height={100}
                  style={{ objectFit: 'contain' }}
                />
                <figcaption>{item.title}</figcaption>
              </figure>
            ) : display.kind === 'links' ? (
              <code key={j} style={{ overflowWrap: 'anywhere' }}>
                {item.url}
              </code>
            ) : null,
          )}
        </div>
      ))}
    </>
  )
}
