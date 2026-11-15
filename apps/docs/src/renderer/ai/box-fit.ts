import type { TextboxDisplay } from '@genoffice/docx-engine'
import { fitTextHalfPoints } from '../../../../shell/src/shared/ocr-boxes'

/** CSS pixels (96 per inch) to points (72 per inch) */
const PX_TO_PT = 0.75

/**
 * The box with its text made smaller when it no longer fits. A box of fixed size clips what runs
 * past it, and a translation is often longer than the text it replaces. Only a box with a fixed
 * height is touched (one that grows with its text cannot clip), every run keeps its proportion
 * to the others, and nothing is made larger. A box whose runs declare no size is left as it is:
 * its size comes from the document and is not known here.
 */
export function shrinkBoxToFit(box: TextboxDisplay): TextboxDisplay {
  if (box.readOnly || !(box.widthPx && box.widthPx > 0) || !(box.heightPx && box.heightPx > 0))
    return box
  const sizes = box.paras.flatMap((para) =>
    para.runs
      .map((run) => run.sizeHalfPoints)
      .filter((size): size is number => typeof size === 'number'),
  )
  if (sizes.length === 0) return box
  const largest = Math.max(...sizes)
  const widthPt = (box.widthPx - (box.insetLeftPx ?? 0) - (box.insetRightPx ?? 0)) * PX_TO_PT
  const heightPt = (box.heightPx - (box.insetTopPx ?? 0) - (box.insetBottomPx ?? 0)) * PX_TO_PT
  if (widthPt <= 0 || heightPt <= 0) return box
  const fitted = fitTextHalfPoints({
    lines: box.paras.map((para) => para.runs.map((run) => run.text).join('')),
    widthPt,
    heightPt,
    maxHalf: largest,
  })
  if (fitted >= largest) return box
  const ratio = fitted / largest
  return {
    ...box,
    paras: box.paras.map((para) => ({
      ...para,
      runs: para.runs.map((run) =>
        typeof run.sizeHalfPoints === 'number'
          ? { ...run, sizeHalfPoints: Math.max(12, Math.floor(run.sizeHalfPoints * ratio)) }
          : run,
      ),
    })),
  }
}
