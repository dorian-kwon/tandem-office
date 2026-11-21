// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { FileConversionPanel } from '../src/renderer/src/FileConversionPanel'
import type { FileConversionInput } from '../src/shared/file-conversion'

it('adds unique files across dialogs and only reuses successes for the current format', async () => {
  const input = (id: string, targets: string[]): FileConversionInput => ({
    id,
    name: id,
    displayPath: '/inputs/' + id,
    targets,
  })
  const one = input('one', ['pdf', 'md'])
  const two = input('two', ['pdf'])
  const three = input('three', ['md'])
  const pick = vi
    .fn()
    .mockResolvedValueOnce([one])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([one, two])
    .mockResolvedValueOnce([three])
  const run = vi.fn(async (ids: string[], format: string) =>
    ids.map((id) => ({ id, outputPath: '/inputs/' + id + '.' + format })),
  )
  vi.stubGlobal('fileConversionApi', { pick, run, onProgress: () => () => {} })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const content = document.createElement('div')
  const root = createRoot(content)
  const button = (id: string) =>
    content.querySelector<HTMLButtonElement>(`[data-testid="file-conversion-${id}"]`)!
  const click = async (id: string) => act(async () => button(id).click())
  try {
    await act(async () => root.render(createElement(FileConversionPanel, { visible: true })))
    await click('pick')
    await click('run')
    expect(run).toHaveBeenLastCalledWith(['one'], 'pdf')
    await click('pick')
    expect(button('run').disabled).toBe(true)
    await click('pick')
    expect(content.querySelectorAll('li')).toHaveLength(2)
    await click('run')
    expect(run).toHaveBeenLastCalledWith(['two'], 'pdf')
    await click('pick')
    expect(button('run').disabled).toBe(true)
    await act(async () => content.querySelectorAll<HTMLButtonElement>('li button')[1].click())
    expect(button('run').disabled).toBe(false)
    await click('run')
    expect(run).toHaveBeenLastCalledWith(['one', 'three'], 'md')
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
