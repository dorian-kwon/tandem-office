/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AiChangeLinks } from '../src/AiChangeLinks'
import { changeLocationPatch, type AiChangeLocation } from '@genoffice/agent-core'

it('shows the local receipt for successful edits and passes the chosen location to the editor', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const onShow = vi.fn()
  const places: AiChangeLocation[] = [
    { kind: 'page', index: 2 },
    { kind: 'page', index: 4 },
  ]
  try {
    const receipt = changeLocationPatch(
      { changeLocations: [places[1]!] },
      { mutated: true, changeLocations: places },
    )
    act(() =>
      root.render(
        createElement(AiChangeLinks, { lang: 'ko', places: receipt.changeLocations, onShow }),
      ),
    )
    expect(host.querySelector('summary')?.textContent).toBe('변경 위치 보기')
    const buttons = host.querySelectorAll('button')
    expect(buttons).toHaveLength(2)
    act(() => buttons[1]!.click())
    expect(onShow).toHaveBeenCalledWith(places[0])
    expect(changeLocationPatch({}, { mutated: false, changeLocations: places })).toEqual({})
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
