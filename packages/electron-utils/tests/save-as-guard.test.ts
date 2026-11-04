import { afterEach, describe, expect, it } from 'vitest'
import { interceptSaveAs, setSaveAsInterceptor } from '../src/save-as-guard'

afterEach(() => setSaveAsInterceptor(null))

describe('save-as guard', () => {
  it('lets Save As through when nothing is registered', () => {
    expect(interceptSaveAs(7)).toBe(false)
  })

  it('asks the registered interceptor with the renderer id', () => {
    const seen: number[] = []
    setSaveAsInterceptor((id) => {
      seen.push(id)
      return true
    })
    expect(interceptSaveAs(7)).toBe(true)
    expect(seen).toEqual([7])
  })

  it('lets it through when the interceptor declines or throws', () => {
    setSaveAsInterceptor(() => false)
    expect(interceptSaveAs(1)).toBe(false)
    setSaveAsInterceptor(() => {
      throw new Error('boom')
    })
    expect(interceptSaveAs(1)).toBe(false)
  })
})
