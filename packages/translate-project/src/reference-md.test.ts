import { describe, expect, it, vi } from 'vitest'
import { convertReferenceToMarkdown, htmlToMarkdown, type ReferenceExtract } from './reference-md'

const text =
  (value: string): ReferenceExtract =>
  async () => ({ ok: true, kind: 'text', text: value })

describe('convertReferenceToMarkdown', () => {
  it('passes the extracted text of a document through as markdown', async () => {
    const extract = vi.fn(text('# Title\n\nBody paragraph.'))
    const out = await convertReferenceToMarkdown('/r/a.docx', extract)
    expect(out).toEqual({ ok: true, md: '# Title\n\nBody paragraph.' })
    expect(extract).toHaveBeenCalledWith('/r/a.docx')
  })

  it('accepts the listed formats only; others are unsupported without being read', async () => {
    for (const name of [
      'a.pdf',
      'a.docx',
      'a.hwp',
      'a.hwpx',
      'a.pptx',
      'a.xlsx',
      'a.epub',
      'a.md',
      'a.txt',
      'a.html',
    ]) {
      expect(
        (
          await convertReferenceToMarkdown(
            `/r/${name}`,
            text('some words here, enough for a text layer'),
          )
        ).ok,
      ).toBe(true)
    }
    const extract = vi.fn(text('x'))
    expect(await convertReferenceToMarkdown('/r/a.zip', extract)).toEqual({
      ok: false,
      reason: 'unsupported',
    })
    expect(await convertReferenceToMarkdown('/r/noext', extract)).toEqual({
      ok: false,
      reason: 'unsupported',
    })
    expect(extract).not.toHaveBeenCalled()
  })

  it('normalizes line endings and trailing blanks', async () => {
    expect(await convertReferenceToMarkdown('/r/a.txt', text('one  \r\n\r\n   \r\ntwo\t'))).toEqual(
      {
        ok: true,
        md: 'one\n\n\ntwo',
      },
    )
  })

  it('an image file needs OCR and is never read', async () => {
    const extract = vi.fn(text('x'))
    for (const name of ['scan.png', 'scan.JPG', 'scan.jpeg', 'scan.tif', 'scan.webp']) {
      expect(await convertReferenceToMarkdown(`/r/${name}`, extract)).toEqual({
        ok: false,
        reason: 'needs-ocr',
      })
    }
    expect(extract).not.toHaveBeenCalled()
  })

  it('a PDF without a text layer needs OCR', async () => {
    expect(await convertReferenceToMarkdown('/r/scan.pdf', text('\n\n  \n'))).toEqual({
      ok: false,
      reason: 'needs-ocr',
    })
    // a page number or two is not a text layer
    expect(await convertReferenceToMarkdown('/r/scan.pdf', text('1\n\n2\n\n3'))).toEqual({
      ok: false,
      reason: 'needs-ocr',
    })
  })

  it('an extractor that reports an image needs OCR', async () => {
    const extract: ReferenceExtract = async () => ({ ok: true, kind: 'image', mime: 'image/png' })
    expect(await convertReferenceToMarkdown('/r/a.pdf', extract)).toEqual({
      ok: false,
      reason: 'needs-ocr',
    })
  })

  it('a failed or throwing read is a failure, never an exception', async () => {
    const refused: ReferenceExtract = async () => ({
      ok: false,
      kind: 'text',
      error: 'Content mismatch',
    })
    expect(await convertReferenceToMarkdown('/r/a.docx', refused)).toEqual({
      ok: false,
      reason: 'failed',
    })
    const throws: ReferenceExtract = async () => {
      throw new Error('boom')
    }
    expect(await convertReferenceToMarkdown('/r/a.docx', throws)).toEqual({
      ok: false,
      reason: 'failed',
    })
    expect(await convertReferenceToMarkdown('/r/a.docx', text('   '))).toEqual({
      ok: false,
      reason: 'failed',
    })
  })

  it('turns HTML source into markdown text', async () => {
    const out = await convertReferenceToMarkdown(
      '/r/a.html',
      text(
        '<html><head><style>p{}</style><script>var x="<p>"</script></head><body><h2>Terms</h2><p>One &amp; two</p><ul><li>A</li><li>B</li></ul></body></html>',
      ),
    )
    expect(out).toEqual({ ok: true, md: '## Terms\n\nOne & two\n\n- A\n- B' })
  })
})

describe('htmlToMarkdown', () => {
  it('decodes entities and drops tags and comments', () => {
    expect(htmlToMarkdown('<p>a&lt;b &#x41;&#66;&nbsp;c<!-- hidden --></p><br>d')).toBe(
      'a<b AB c\n\nd',
    )
  })
})
