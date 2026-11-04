import type { ReactNode } from 'react'

/** 16px line icons for the translation tables; they draw with the text color. */
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      className="tt-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export type FileGlyph = 'doc' | 'sheet' | 'slide' | 'pdf' | 'image' | 'text' | 'book' | 'glossary'

const EXTENSION_GLYPH: Record<string, FileGlyph> = {
  docx: 'doc',
  odt: 'doc',
  hwp: 'doc',
  hwpx: 'doc',
  xlsx: 'sheet',
  xlsm: 'sheet',
  xls: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  pptx: 'slide',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  epub: 'book',
}

/** The glyph for a file name's extension; anything unknown is a plain text page. */
export function glyphForFile(name: string): FileGlyph {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return EXTENSION_GLYPH[ext] ?? 'text'
}

const PAGE = 'M4 1.8h5.2L12.4 5v9.2H4z M9.2 1.8V5h3.2'

export function FileIcon({ glyph }: { glyph: FileGlyph }) {
  switch (glyph) {
    case 'sheet':
      return (
        <Svg>
          <path d={PAGE} />
          <path d="M6 8.2h4.4M6 10.2h4.4M6 12.2h4.4M8.2 8.2v4" />
        </Svg>
      )
    case 'slide':
      return (
        <Svg>
          <path d={PAGE} />
          <rect x="5.8" y="8" width="4.8" height="3.4" rx="0.5" />
        </Svg>
      )
    case 'pdf':
      return (
        <Svg>
          <path d={PAGE} />
          <path d="M6 12.2c1.6-1.2 2.4-2.6 2.4-3.8 0 1.2.8 2.2 2 2.8-1.6 0-3 .4-4.4 1z" />
        </Svg>
      )
    case 'image':
      return (
        <Svg>
          <rect x="2.2" y="3" width="11.6" height="10" rx="1.5" />
          <circle cx="6" cy="6.6" r="1" />
          <path d="M2.8 12l3.4-3.2 2.4 2.2 2-1.8 2.6 2.6" />
        </Svg>
      )
    case 'book':
      return (
        <Svg>
          <path d="M3 2.8h6.2c1.2 0 2 .8 2 2v8.4H5c-1.2 0-2-.8-2-2z M11.2 4.8H13v8.4h-1.8" />
        </Svg>
      )
    case 'glossary':
      return (
        <Svg>
          <path d="M3 2.8h8.4v10.4H3z M5.6 6h3.4M5.6 8.2h3.4M5.6 10.4h2" />
        </Svg>
      )
    case 'doc':
      return (
        <Svg>
          <path d={PAGE} />
          <path d="M6.2 8.2h4M6.2 10.2h4M6.2 12.2h2.4" />
        </Svg>
      )
    default:
      return (
        <Svg>
          <path d={PAGE} />
        </Svg>
      )
  }
}

/** A translation project: a folder holding a language pair. */
export function ProjectIcon() {
  return (
    <Svg>
      <path d="M1.8 4.4c0-.7.5-1.2 1.2-1.2h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />
    </Svg>
  )
}

export function PencilIcon() {
  return (
    <Svg>
      <path d="M2.6 13.4l.6-3L10.8 2.8a1.4 1.4 0 0 1 2 0l.4.4a1.4 1.4 0 0 1 0 2L5.6 12.8z M9.6 4l2.4 2.4" />
    </Svg>
  )
}

export function MoreIcon() {
  return (
    <svg
      className="tt-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="3.2" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.8" cy="8" r="1.3" />
    </svg>
  )
}

export function OpenIcon() {
  return (
    <Svg>
      <path d="M3 8h9.2M8.6 4.4L12.2 8l-3.6 3.6" />
    </Svg>
  )
}

export function SaveAsIcon() {
  return (
    <Svg>
      <path d="M8 2.4v7.2M4.8 6.6L8 9.8l3.2-3.2M3 12.6h10" />
    </Svg>
  )
}

export function EyeIcon() {
  return (
    <Svg>
      <path d="M1.6 8s2.3-4.2 6.4-4.2S14.4 8 14.4 8s-2.3 4.2-6.4 4.2S1.6 8 1.6 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </Svg>
  )
}

export function TrashIcon() {
  return (
    <Svg>
      <path d="M2.8 4.4h10.4M6.2 4.4V2.8h3.6v1.6M4.2 4.4l.6 8.8h6.4l.6-8.8M6.6 7v3.6M9.4 7v3.6" />
    </Svg>
  )
}

export function SwapIcon() {
  return (
    <Svg>
      <path d="M3 5.6h9.4M9.8 3l2.6 2.6-2.6 2.6M13 10.4H3.6M6.2 7.8L3.6 10.4l2.6 2.6" />
    </Svg>
  )
}

export function ScanIcon() {
  return (
    <Svg>
      <path d="M2.4 5.4V3.2h2.2M11.4 3.2h2.2v2.2M13.6 10.6v2.2h-2.2M4.6 12.8H2.4v-2.2M2.4 8h11.2" />
    </Svg>
  )
}

/** Sort chevron: points up for ascending, down for descending. */
export function SortChevron({ dir }: { dir: 'asc' | 'desc' }) {
  return (
    <Svg>
      <path d={dir === 'asc' ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} />
    </Svg>
  )
}
