import { useState } from 'react'
import type {
  OcrPageResult,
  OcrPlacement,
  OcrPrepared,
  OcrRecommendation,
} from '../../../shared/translate-ocr'
import { makeText, translateErrorText } from './shared'
import { useI18n } from '../locale'

function recognisedText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(recognisedText).filter(Boolean).join('\n')
  const object = value as Record<string, unknown>
  if (typeof object.text === 'string') return object.text
  return Object.values(object).map(recognisedText).filter(Boolean).join('\n')
}

export function OcrPlacementDialog({
  prepared,
  pages,
  busy,
  error,
  recommendation,
  onPlace,
  onCancel,
}: {
  prepared: OcrPrepared
  pages: OcrPageResult[]
  busy: boolean
  error?: unknown
  onPlace: (placement: OcrPlacement) => void
  onCancel: () => void
  recommendation?: OcrRecommendation
}) {
  const { lang } = useI18n()
  const s = makeText(lang)
  const [kind, setKind] = useState('')
  const [sheet, setSheet] = useState('')
  const [cell, setCell] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [table, setTable] = useState('')
  const [row, setRow] = useState('')
  const [column, setColumn] = useState('')
  const xlsx = prepared.format === 'xlsx'
  const valid =
    kind === 'docx-after-images' ||
    kind === 'docx-end' ||
    (kind === 'xlsx-new-sheet' && sheet.trim().length > 0) ||
    (kind === 'xlsx-cells' && sheet.length > 0 && /^[A-Z]{1,3}[1-9]\d*$/i.test(cell)) ||
    (kind === 'docx-table-cell' && Number(table) > 0 && Number(row) > 0 && Number(column) > 0)
  const submit = () => {
    if (!valid || busy) return
    if (kind === 'xlsx-cells') onPlace({ kind, sheet, cell: cell.toUpperCase(), overwrite })
    else if (kind === 'xlsx-new-sheet') onPlace({ kind, sheet })
    else if (kind === 'docx-after-images' || kind === 'docx-end') onPlace({ kind })
    else if (kind === 'docx-table-cell')
      onPlace({ kind, table: Number(table), row: Number(row), column: Number(column), overwrite })
  }
  const useRecommendation = () => {
    const p = recommendation?.placement
    if (!p) return
    setKind(p.kind)
    setOverwrite(false)
    if (p.kind === 'xlsx-cells') {
      setSheet(p.sheet)
      setCell(p.cell)
    }
    if (p.kind === 'xlsx-new-sheet') setSheet(p.sheet)
    if (p.kind === 'docx-table-cell') {
      setTable(String(p.table))
      setRow(String(p.row))
      setColumn(String(p.column))
    }
  }
  const recommended = recommendation?.placement
  const description =
    recommended?.kind === 'xlsx-cells'
      ? `${recommended.sheet} · ${recommended.cell}`
      : recommended?.kind === 'xlsx-new-sheet'
        ? `${s('ocrNewSheet')} · ${recommended.sheet}`
        : recommended?.kind === 'docx-table-cell'
          ? `${s('ocrTableNumber')} ${recommended.table} · ${s('ocrRow')} ${recommended.row} · ${s('ocrColumn')} ${recommended.column}`
          : s('ocrAfterImages')
  return (
    <>
      <p>{s('ocrPlaceIntro')}</p>
      {recommendation && (
        <aside className="projects-note">
          <strong>
            {s('ocrRecommendation')}: {description}
          </strong>
          <p>
            {s(
              recommendation.reason === 'empty-cells'
                ? 'ocrRecommendCells'
                : recommendation.reason === 'new-sheet'
                  ? 'ocrRecommendSheet'
                  : 'ocrRecommendAfter',
            )}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={useRecommendation}
          >
            {s('ocrUseRecommendation')}
          </button>
        </aside>
      )}
      <h4>{s('ocrReadText')}</h4>
      <div className="translate-ocr-readings">
        {pages.map((page) => (
          <article key={page.index}>
            <strong>{prepared.items.find((i) => i.index === page.index)?.name}</strong>
            <pre>{recognisedText(page.payload)}</pre>
          </article>
        ))}
      </div>
      <label className="projects-field">
        <span>{s('ocrPlaceTitle')}</span>
        <select
          aria-label={s('ocrPlaceTitle')}
          value={kind}
          disabled={busy}
          onChange={(e) => {
            setKind(e.target.value)
            setSheet('')
          }}
        >
          <option value="">{s('ocrPlaceTitle')}</option>
          {xlsx ? (
            <>
              <option value="xlsx-cells">{s('ocrExistingCells')}</option>
              <option value="xlsx-new-sheet">{s('ocrNewSheet')}</option>
            </>
          ) : (
            <>
              <option value="docx-after-images">{s('ocrAfterImages')}</option>
              <option value="docx-end">{s('ocrDocumentEnd')}</option>
              {!!prepared.tables?.length && (
                <option value="docx-table-cell">{s('ocrTableCell')}</option>
              )}
            </>
          )}
        </select>
      </label>
      {(kind === 'xlsx-cells' || kind === 'xlsx-new-sheet') && (
        <label className="projects-field">
          <span>{s('ocrSheetName')}</span>
          {kind === 'xlsx-cells' ? (
            <select
              aria-label={s('ocrSheetName')}
              value={sheet}
              disabled={busy}
              onChange={(e) => setSheet(e.target.value)}
            >
              <option value="">{s('ocrSheetName')}</option>
              {prepared.sheets?.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          ) : (
            <input
              aria-label={s('ocrSheetName')}
              maxLength={31}
              value={sheet}
              disabled={busy}
              onChange={(e) => setSheet(e.target.value)}
            />
          )}
        </label>
      )}
      {kind === 'xlsx-cells' && (
        <>
          <label className="projects-field">
            <span>{s('ocrStartCell')}</span>
            <input
              aria-label={s('ocrStartCell')}
              placeholder="C7"
              value={cell}
              disabled={busy}
              onChange={(e) => setCell(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={overwrite}
              disabled={busy}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            {s('ocrOverwrite')}
          </label>
        </>
      )}
      {kind === 'docx-table-cell' && (
        <>
          <label className="projects-field">
            <span>{s('ocrTableNumber')}</span>
            <select
              aria-label={s('ocrTableNumber')}
              value={table}
              disabled={busy}
              onChange={(e) => setTable(e.target.value)}
            >
              <option value="">{s('ocrTableNumber')}</option>
              {prepared.tables?.map((t) => (
                <option key={t.index} value={t.index}>
                  {t.index} ({t.rows} × {t.columns})
                </option>
              ))}
            </select>
          </label>
          <label className="projects-field">
            <span>{s('ocrRow')}</span>
            <input
              type="number"
              min={1}
              step={1}
              aria-label={s('ocrRow')}
              value={row}
              disabled={busy}
              onChange={(e) => setRow(e.target.value)}
            />
          </label>
          <label className="projects-field">
            <span>{s('ocrColumn')}</span>
            <input
              type="number"
              min={1}
              step={1}
              aria-label={s('ocrColumn')}
              value={column}
              disabled={busy}
              onChange={(e) => setColumn(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={overwrite}
              disabled={busy}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            {s('ocrOverwrite')}
          </label>
        </>
      )}
      {error !== undefined && <p role="alert">{translateErrorText(lang, error)}</p>}
      <div className="modal-buttons">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          {s('cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!valid || busy}
          onClick={submit}
        >
          {s('ocrPlaceSave')}
        </button>
      </div>
    </>
  )
}
