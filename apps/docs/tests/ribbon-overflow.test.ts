import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RibbonOverflow, fittingRibbonItems } from '../src/renderer/components/ribbon-overflow'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('ribbon overflow', () => {
  let root: Root | undefined
  afterEach(() => {
    if (root) act(() => root!.unmount())
    root = undefined
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })
  it('reserves the More button and retains the selected tab when space runs out', () => {
    expect(fittingRibbonItems([60, 70, 80, 90], 220, 60, 3)).toEqual([0, 3])
    expect(fittingRibbonItems([60, 70, 80, 90], 300, 60)).toEqual([0, 1, 2, 3])
    expect(fittingRibbonItems([300, 70], 140, 60)).toEqual([1])
  })
  it('makes overflow commands operable, dismisses on Escape, and restores trigger focus', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const el = this as HTMLElement
      const width = el.classList.contains('ribbon-overflow')
        ? 220
        : el.classList.contains('ribbon-overflow-trigger')
          ? 60
          : 100
      return {
        width,
        height: 32,
        top: 0,
        bottom: 32,
        left: 0,
        right: width,
        x: 0,
        y: 0,
        toJSON() {},
      }
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const action = vi.fn()
    act(() =>
      root!.render(
        createElement(RibbonOverflow, {
          label: 'More',
          tabs: true,
          children: [
            createElement('button', { key: 'a' }, 'Primary'),
            createElement('button', { key: 'b', onClick: action }, 'Secondary'),
            createElement('button', { key: 'c' }, 'Third'),
          ],
        }),
      ),
    )
    const trigger = host.querySelector<HTMLButtonElement>('.ribbon-overflow-trigger')!
    expect(trigger).not.toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    act(() => trigger.click())
    const panel = document.querySelector<HTMLElement>('.ribbon-overflow-panel')!
    expect(panel.getAttribute('aria-hidden')).toBe('false')
    expect(document.activeElement?.textContent).toBe('Secondary')
    act(() => (panel.querySelector('button') as HTMLButtonElement).click())
    expect(action).toHaveBeenCalledOnce()
    act(() => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    act(() => trigger.click())
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    act(() => trigger.click())
    act(() => window.dispatchEvent(new Event('blur')))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
