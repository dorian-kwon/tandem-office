import { expect, test } from '@playwright/test'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

test('built HWP change marks reuse geometry and follow zoom', async () => {
  test.setTimeout(120_000)
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'hwp-change-marks' })
  try {
    await launched.page.evaluate(() => window.aiOffice.newHwp())
    const hwp = await waitForPageWithUrl(launched.app, '://hwp/')
    await hwp.waitForSelector('.hwp-app[data-phase="ready"]', { timeout: 90_000 })
    const result = await hwp.evaluate(async () => {
      const iframe = document.querySelector('.hwp-editor-host iframe') as HTMLIFrameElement
      const frame = iframe.contentWindow as any
      const studio = frame.rhwpStudio
      await studio.plugins.load('ieum-agent')
      const call = (method: string, args: unknown[]) =>
        studio.plugins.invoke('ieum-agent', method, args)
      const names = [
        'getSelectionRects',
        'getSelectionRectsInCellByPath',
        'getSelectionRectsInCellByPathEx',
      ] as const
      const counts: Record<string, number> = Object.fromEntries(names.map((name) => [name, 0]))
      const restore: (() => void)[] = []
      let viewport: any
      let instrumented = false
      studio.automation.registerCommand({
        id: 'ext:e2e-mark-geometry-probe',
        label: 'Count change mark geometry queries for testing',
        execute(services: any) {
          // Instrument the same raw WASM handle that PluginHost.read borrows.
          // The test never replaces its geometry results or edits through this handle.
          const doc = services.wasm.borrowDocumentHandle()
          if (!doc) throw new Error('The HWP document is not ready')
          viewport = services.getViewportManager()
          for (const name of names) {
            const original = doc[name]
            if (typeof original !== 'function') throw new Error(`Missing geometry API: ${name}`)
            doc[name] = function (...args: unknown[]) {
              counts[name]++
              return original.apply(this, args)
            }
            restore.push(() => {
              doc[name] = original
            })
          }
          instrumented = true
        },
      })
      studio.automation.execute('ext:e2e-mark-geometry-probe')
      if (!instrumented) throw new Error('The geometry probe did not execute')
      const initialZoom = viewport.getZoom()
      const boxes = () =>
        Array.from(frame.document.querySelectorAll('.ieum-change-marks > div')).map((node) => {
          const style = (node as HTMLElement).style
          return {
            left: parseFloat(style.left),
            top: parseFloat(style.top),
            width: parseFloat(style.width),
            height: parseFloat(style.height),
          }
        })
      const redrawBatch = () => {
        const beforeCounts = { ...counts }
        const beforeBoxes = boxes()
        for (let i = 0; i < 20; i++) {
          const response = studio.automation.execute('ext:ieum-mark-changes')
          if (!response.ok) throw new Error('The mark redraw command failed')
        }
        return { beforeCounts, afterCounts: { ...counts }, beforeBoxes, afterBoxes: boxes() }
      }
      // Let the plugin's 350 ms geometry refresh and real ResizeObserver delivery finish.
      const settled = () => new Promise<void>((resolve) => frame.setTimeout(resolve, 700))
      try {
        const inserted = await call('insertTable', [
          '',
          null,
          'end',
          [
            ['Mark target', 'Other cell'],
            ['Second row', 'Unchanged'],
          ],
          false,
        ])
        await call('clearMarks', [])
        const replaced = await call('replaceText', ['Mark target', 'Marked replacement', null])
        await settled()
        const normal = redrawBatch()
        viewport.setZoom(initialZoom * 0.8)
        await settled()
        const zoomed = redrawBatch()
        return { inserted, replaced, normal, zoomed, initialZoom, finalZoom: viewport.getZoom() }
      } finally {
        viewport.setZoom(initialZoom)
        for (const undo of restore) undo()
        studio.automation.unregisterCommand('ext:e2e-mark-geometry-probe')
      }
    })
    expect(result.inserted).toMatchObject({ ok: true })
    expect(result.replaced).toMatchObject({ ok: true })
    expect(Object.values(result.normal.beforeCounts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    for (const batch of [result.normal, result.zoomed]) {
      // Query counts, rather than wall-clock timing, make the regression deterministic.
      expect(batch.afterCounts).toEqual(batch.beforeCounts)
      expect(batch.beforeBoxes.length).toBeGreaterThan(0)
      expect(batch.afterBoxes).toEqual(batch.beforeBoxes)
      for (const box of batch.afterBoxes) {
        expect(Object.values(box).every(Number.isFinite)).toBe(true)
        expect(box.width).toBeGreaterThan(0)
        expect(box.height).toBeGreaterThan(0)
      }
    }
    expect(result.finalZoom).toBeLessThan(result.initialZoom)
    expect(result.zoomed.beforeBoxes).toHaveLength(result.normal.beforeBoxes.length)
    const ratio = result.finalZoom / result.initialZoom
    expect(result.zoomed.beforeBoxes[0].width / result.normal.beforeBoxes[0].width).toBeCloseTo(
      ratio,
      2,
    )
    expect(result.zoomed.beforeBoxes[0].height / result.normal.beforeBoxes[0].height).toBeCloseTo(
      ratio,
      2,
    )
  } finally {
    await closeAndSaveVideo(launched, 'hwp-change-marks')
  }
})
