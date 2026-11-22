import { useEffect, useMemo, useState } from 'react'
import type {
  OcrPageResult,
  OcrPlacement,
  OcrPrepared,
  OcrRecommendation,
} from '../../../shared/translate-ocr'
import { checkOcrBoxesPayload, type OcrBox } from '../../../shared/ocr-boxes'
import type { TranslateApi } from '../../../shared/translate-api'
import { makeText, translateErrorText } from './shared'
import { fileConversionText } from '../i18n/strings-file-conversion'
import { useI18n } from '../locale'
import { OcrBoxPicture } from './OcrBoxPicture'
import { parseOcrDestination } from './ocr-destination-text'

function recognisedText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(recognisedText).filter(Boolean).join('\n')
  const object = value as Record<string, unknown>
  if (typeof object.text === 'string') return object.text
  return Object.values(object).map(recognisedText).filter(Boolean).join('\n')
}

function nextSheetName(sheets?: string[]) {
  const existing = new Set(sheets?.map((name) => name.toLowerCase()))
  let name = 'OCR'
  for (let i = 2; existing.has(name.toLowerCase()); i++) name = `OCR (${i})`
  return name
}

export function OcrPlacementDialog({
  prepared,
  pages,
  busy,
  error,
  recommendation,
  api,
  onPlace,
  onCancel,
  before,
  allowReference,
  allowBoxes = true,
  initialPlacement,
  onSelection,
}: {
  before?: number[]
  allowReference?: boolean
  allowBoxes?: boolean
  initialPlacement?: OcrPlacement | 'reference-only' | null
  onSelection?: (value: OcrPlacement | 'reference-only' | null) => void
  prepared: OcrPrepared
  pages: OcrPageResult[]
  busy: boolean
  error?: unknown
  onPlace: (placement: OcrPlacement) => void
  onCancel: () => void
  recommendation?: OcrRecommendation
  /** shows the pictures of the on-image boxes; without it the boxes are kept but not shown */
  api?: TranslateApi
}) {
  const { lang } = useI18n()
  const s = makeText(lang)
  // the pictures a box reading found places on, and the boxes the person edits
  const boxed = useMemo(
    () =>
      pages.flatMap((page) => {
        const payload = checkOcrBoxesPayload(page.payload)
        const item = prepared.items.find((i) => i.index === page.index)
        return payload && payload.boxes.length > 0 && item?.boxable
          ? [{ index: page.index, name: item.name, boxes: payload.boxes }]
          : []
      }),
    [pages, prepared],
  )
  const canBoxes =
    allowBoxes &&
    prepared.format === 'docx' &&
    (before ? prepared.items.some((i) => i.boxable && before.includes(i.index)) : boxed.length > 0)
  const [edited, setEdited] = useState<Record<number, OcrBox[]>>(() =>
    Object.fromEntries(boxed.map((b) => [b.index, b.boxes])),
  )
  const xlsx = prepared.format === 'xlsx'
  const [kind, setKind] = useState(
    initialPlacement === 'reference-only'
      ? initialPlacement
      : (initialPlacement?.kind ??
          (canBoxes
            ? 'docx-image-boxes'
            : before
              ? xlsx
                ? 'xlsx-new-sheet'
                : 'docx-after-images'
              : '')),
  )
  const [typed, setTyped] = useState('')
  const [sheet, setSheet] = useState(() => {
    if (initialPlacement && typeof initialPlacement !== 'string' && 'sheet' in initialPlacement)
      return initialPlacement.sheet
    if (!before || !xlsx) return ''
    return nextSheetName(prepared.sheets)
  })
  const [cell, setCell] = useState(
    initialPlacement && typeof initialPlacement !== 'string' && 'cell' in initialPlacement
      ? initialPlacement.cell
      : '',
  )
  const [overwrite, setOverwrite] = useState(
    !!(
      initialPlacement &&
      typeof initialPlacement !== 'string' &&
      'overwrite' in initialPlacement &&
      initialPlacement.overwrite
    ),
  )
  const initialTable =
    typeof initialPlacement === 'object' && initialPlacement?.kind === 'docx-table-cell'
      ? initialPlacement
      : null
  const [table, setTable] = useState(String(initialTable?.table ?? ''))
  const [row, setRow] = useState(String(initialTable?.row ?? ''))
  const [column, setColumn] = useState(String(initialTable?.column ?? ''))
  // boxes without text are dropped; a picture left with none keeps its text paragraph instead
  const placedImages = boxed
    .map((b) => ({
      index: b.index,
      boxes: (edited[b.index] ?? []).filter((box) => box.text.trim() !== ''),
    }))
    .filter((image) => image.boxes.length > 0)
  const paragraphNames = prepared.items
    .filter((item) => pages.some((p) => p.index === item.index))
    .filter((item) => !placedImages.some((image) => image.index === item.index))
    .map((item) => item.name)
  const selectedItems = new Set(before ?? pages.map((p) => p.index))
  const canNextPage = prepared.items.every(
    (item) => !selectedItems.has(item.index) || /^document\.xml · ¶\d+$/.test(item.location ?? ''),
  )
  const locationLabels = useMemo(() => {
    const t = makeText(lang)
    return [
      ...(!xlsx
        ? ([
            ['docx-before-images', fileConversionText(lang, 'ocrBeforeImage')],
            ['docx-after-images', t('ocrAfterImages')],
            ['docx-next-page', fileConversionText(lang, 'ocrNextPage')],
            ['docx-replace-images', fileConversionText(lang, 'ocrReplaceImage')],
            ['docx-end', t('ocrDocumentEnd')],
            ...(canBoxes ? [['docx-image-boxes', t('ocrPlaceBoxes')] as const] : []),
          ] as const)
        : []),
      ...(allowReference ? [['reference-only', t('referencesTitle')] as const] : []),
    ]
  }, [lang, xlsx, canBoxes, allowReference])
  const typedFields = useMemo(
    () =>
      kind === 'custom'
        ? parseOcrDestination(typed, xlsx, prepared.sheets ?? [], locationLabels)
        : null,
    [kind, typed, xlsx, prepared.sheets, locationLabels],
  )
  const selection = useMemo((): OcrPlacement | 'reference-only' | null => {
    const dest = kind === 'custom' ? typedFields : { kind, sheet, cell, table, row, column }
    if (!dest) return null
    const {
      kind: destination,
      sheet: targetSheet = '',
      cell: targetCell = '',
      table: targetTable,
      row: targetRow,
      column: targetColumn,
    } = dest
    if (destination === 'reference-only' && allowReference) return destination
    if (
      destination === 'xlsx-new-sheet' &&
      targetSheet.trim() &&
      targetSheet.length <= 31 &&
      !/[\][:*?/\\]/.test(targetSheet) &&
      !/^'|'$/.test(targetSheet) &&
      !prepared.sheets?.some((n) => n.toLowerCase() === targetSheet.toLowerCase())
    )
      return { kind: destination, sheet: targetSheet }
    if (destination === 'xlsx-cells' && prepared.sheets?.includes(targetSheet)) {
      const at = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(targetCell)
      if (
        at &&
        (at[1]!.length < 3 || at[1]!.toUpperCase() <= 'XFD') &&
        Number(at[2]) + (before?.length ?? pages.length) - 1 <= 1048576
      )
        return { kind: destination, sheet: targetSheet, cell: targetCell.toUpperCase(), overwrite }
    }
    if (destination === 'docx-table-cell') {
      const target = prepared.tables?.find((t) => t.index === Number(targetTable))
      const r = Number(targetRow),
        c = Number(targetColumn)
      if (
        target &&
        Number.isSafeInteger(r) &&
        r > 0 &&
        r + (before?.length ?? pages.length) - 1 <= target.rows &&
        Number.isSafeInteger(c) &&
        c > 0 &&
        c <= target.columns
      )
        return { kind: destination, table: target.index, row: r, column: c, overwrite }
    }
    if (destination === 'docx-image-boxes' && canBoxes) {
      const images = boxed
        .map((b) => ({
          index: b.index,
          boxes: (edited[b.index] ?? []).filter((box) => box.text.trim()),
        }))
        .filter((i) => i.boxes.length)
      if (before || images.length) return { kind: destination, images }
    }
    if (destination === 'docx-next-page' && !canNextPage) return null
    if (
      destination === 'docx-before-images' ||
      destination === 'docx-next-page' ||
      destination === 'docx-replace-images' ||
      destination === 'docx-after-images' ||
      destination === 'docx-end'
    )
      return { kind: destination }
    return null
  }, [
    kind,
    allowReference,
    canNextPage,
    typedFields,
    sheet,
    prepared.sheets,
    prepared.tables,
    cell,
    before,
    pages.length,
    overwrite,
    table,
    row,
    column,
    canBoxes,
    boxed,
    edited,
  ])
  useEffect(() => {
    if (before) onSelection?.(selection)
  }, [before, onSelection, selection])
  const submit = () => {
    if (!busy && selection && selection !== 'reference-only') onPlace(selection)
  }
  const applyRecommendation = () => {
    const p = recommendation?.placement
    if (!p) return
    setKind(p.kind)
    setTyped('')
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
  function chooseKind(value: string) {
    setKind(value)
    setTyped('')
    setOverwrite(false)
    if (
      recommended?.kind === value &&
      (value === 'xlsx-cells' || value === 'xlsx-new-sheet' || value === 'docx-table-cell')
    ) {
      applyRecommendation()
    } else if (value === 'xlsx-cells') {
      setSheet(prepared.sheets?.[0] ?? '')
      setCell('')
    } else if (value === 'xlsx-new-sheet') {
      setSheet(nextSheetName(prepared.sheets))
    }
  }
  const positionButton = (destination: string, label: string, disabled = false) => (
    <button
      key={destination}
      type="button"
      className="btn btn-secondary"
      data-destination={destination}
      aria-pressed={kind === destination}
      disabled={busy || disabled}
      onClick={() => chooseKind(destination)}
    >
      {label}
    </button>
  )
  return (
    <>
      {!before && <p>{s('ocrPlaceIntro')}</p>}
      {!before && recommendation && (
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
            onClick={applyRecommendation}
          >
            {s('ocrUseRecommendation')}
          </button>
        </aside>
      )}
      {!before && (
        <>
          <h4>{s('ocrReadText')}</h4>
          <div className="translate-ocr-readings">
            {pages.map((page) => (
              <article key={page.index}>
                <strong>{prepared.items.find((i) => i.index === page.index)?.name}</strong>
                <pre>{recognisedText(page.payload)}</pre>
              </article>
            ))}
          </div>
        </>
      )}
      {before ? (
        <div className="ocr-placement-choices" role="group" aria-label={s('ocrPlaceTitle')}>
          <div className="ocr-placement-buttons">
            {xlsx ? (
              <>
                {positionButton('xlsx-cells', s('ocrExistingCells'))}
                {positionButton('xlsx-new-sheet', s('ocrNewSheet'))}
              </>
            ) : (
              <>
                {positionButton('docx-replace-images', fileConversionText(lang, 'ocrReplaceImage'))}
                {positionButton('docx-before-images', fileConversionText(lang, 'ocrBeforeImage'))}
                {positionButton('docx-after-images', s('ocrAfterImages'))}
                {positionButton(
                  'docx-next-page',
                  fileConversionText(lang, 'ocrNextPage'),
                  !canNextPage,
                )}
                {canBoxes && positionButton('docx-image-boxes', s('ocrPlaceBoxes'))}
              </>
            )}
          </div>
          {(!xlsx || allowReference) && (
            <details
              className="ocr-other-placements"
              open={['docx-end', 'docx-table-cell', 'reference-only'].includes(kind) || undefined}
            >
              <summary>{fileConversionText(lang, 'ocrOtherLocations')}</summary>
              <div className="ocr-placement-buttons">
                {!xlsx && positionButton('docx-end', s('ocrDocumentEnd'))}
                {!xlsx &&
                  !!prepared.tables?.length &&
                  positionButton('docx-table-cell', s('ocrTableCell'))}
                {allowReference && positionButton('reference-only', s('referencesTitle'))}
              </div>
            </details>
          )}
        </div>
      ) : (
        <label className="projects-field">
          <span>{s('ocrPlaceTitle')}</span>
          <select
            data-testid="ocr-picture-placement"
            aria-label={s('ocrPlaceTitle')}
            value={kind}
            disabled={busy}
            onChange={(e) => {
              setKind(e.target.value)
              setTyped('')
              setOverwrite(false)
              setSheet('')
            }}
          >
            {!before && <option value="">{s('ocrPlaceTitle')}</option>}
            {xlsx ? (
              <>
                <option value="xlsx-cells">{s('ocrExistingCells')}</option>
                <option value="xlsx-new-sheet">{s('ocrNewSheet')}</option>
              </>
            ) : (
              <>
                {canBoxes && <option value="docx-image-boxes">{s('ocrPlaceBoxes')}</option>}
                <option value="docx-replace-images">
                  {fileConversionText(lang, 'ocrReplaceImage')}
                </option>
                <option value="docx-before-images">
                  {fileConversionText(lang, 'ocrBeforeImage')}
                </option>
                <option value="docx-next-page" disabled={!canNextPage}>
                  {fileConversionText(lang, 'ocrNextPage')}
                </option>
                <option value="docx-after-images">{s('ocrAfterImages')}</option>
                <option value="docx-end">{s('ocrDocumentEnd')}</option>
                {!!prepared.tables?.length && (
                  <option value="docx-table-cell">{s('ocrTableCell')}</option>
                )}
              </>
            )}

            {allowReference && <option value="reference-only">{s('referencesTitle')}</option>}
          </select>
        </label>
      )}
      {before && (
        <label className="projects-field">
          <span>{fileConversionText(lang, 'ocrTypePlacement')}</span>
          <input
            type="text"
            data-testid="ocr-destination-input"
            aria-label={fileConversionText(lang, 'ocrTypePlacement')}
            maxLength={200}
            value={typed}
            disabled={busy}
            placeholder={
              xlsx
                ? `${prepared.sheets?.[0] ?? 'Sheet1'}!B2`
                : fileConversionText(lang, 'ocrBeforeImage')
            }
            aria-invalid={kind === 'custom' && !!typed.trim() && !selection}
            onChange={(event) => {
              setTyped(event.target.value)
              setKind('custom')
              setOverwrite(false)
            }}
          />
          {kind === 'custom' && typed.trim() && (
            <small role="status">
              {selection
                ? selection === 'reference-only'
                  ? s('referencesTitle')
                  : selection.kind === 'docx-table-cell'
                    ? `${s('ocrTableNumber')} ${selection.table} · ${s('ocrRow')} ${selection.row} · ${s('ocrColumn')} ${selection.column}`
                    : selection.kind === 'xlsx-cells'
                      ? `${selection.sheet}!${selection.cell}`
                      : selection.kind === 'xlsx-new-sheet'
                        ? `${s('ocrNewSheet')} · ${selection.sheet}`
                        : locationLabels.find(([id]) => id === selection.kind)?.[1]
                : fileConversionText(lang, 'ocrInvalidPlacement')}
            </small>
          )}
        </label>
      )}
      {kind === 'custom' &&
        selection &&
        selection !== 'reference-only' &&
        (selection.kind === 'docx-table-cell' || selection.kind === 'xlsx-cells') && (
          <label>
            <input
              type="checkbox"
              checked={overwrite}
              disabled={busy}
              onChange={(event) => setOverwrite(event.target.checked)}
            />
            {s('ocrOverwrite')}
          </label>
        )}
      {!before && kind === 'docx-image-boxes' && (
        <>
          <p>{s('ocrBoxesIntro')}</p>
          {boxed.map((b) => (
            <section key={b.index}>
              <strong>{b.name}</strong>
              <OcrBoxPicture
                api={api}
                token={prepared.token}
                index={b.index}
                boxes={edited[b.index] ?? []}
                disabled={busy}
                onChange={(boxes) => setEdited((prev) => ({ ...prev, [b.index]: boxes }))}
              />
            </section>
          ))}
          {paragraphNames.length > 0 && (
            <p>{s('ocrBoxFallbackNote', { items: paragraphNames.join(', ') })}</p>
          )}
        </>
      )}
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
      {!before && (
        <div className="modal-buttons">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            {s('cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!selection || busy}
            onClick={submit}
          >
            {s('ocrPlaceSave')}
          </button>
        </div>
      )}
    </>
  )
}
