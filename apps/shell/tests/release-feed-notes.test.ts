import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { withReleaseNotes } from '../../../tools/release-feed-notes.mjs'
import { normalizeReleaseNotes } from '../src/main/update-notes'

// js-yaml is what electron-updater reads latest.yml with
const { load } = createRequire(import.meta.url)('js-yaml') as {
  load: (text: string) => Record<string, unknown>
}

// the file electron-builder wrote for 0.15.1 (the private GitHub provider hands
// the app this file as it is, so notes have to travel inside it)
const FEED = `version: 0.15.1
files:
  - url: tandem-office-Setup-0.15.1.exe
    sha512: wJrpiINc+BM1Fz6vavMdbcMrpJPOUDNHFCai2eSDPSRpM9ZuVSOpDUvO4ZvpC8/Solp0+75ZwM8KgtoTud1ISA==
    size: 193009020
path: tandem-office-Setup-0.15.1.exe
sha512: wJrpiINc+BM1Fz6vavMdbcMrpJPOUDNHFCai2eSDPSRpM9ZuVSOpDUvO4ZvpC8/Solp0+75ZwM8KgtoTud1ISA==
releaseDate: '2026-11-15T19:42:02.460Z'
`

const HTML = `<p>요약 한 줄입니다.</p>
<h2>새로 들어간 것</h2>
<ul>
<li><strong>따옴표 "와" 역슬래시 \\ 가 든 항목:</strong> <code>C:\\temp</code> 😀</li>
</ul>
<h2>설치</h2>
<ul>
<li>Windows: 설치 파일을 받아 실행합니다.</li>
</ul>`

describe('release notes in latest.yml', () => {
  it('adds the notes as one string and leaves every other field as built', () => {
    const before = load(FEED)
    const after = load(withReleaseNotes(FEED, HTML))
    expect(after.releaseNotes).toBe(HTML)
    const { releaseNotes: _notes, ...rest } = after
    expect(rest).toEqual(before)
  })

  it('keeps the installer entry byte-for-byte (the hash covers the exe, not the feed)', () => {
    const out = withReleaseNotes(FEED, HTML)
    expect(out.startsWith(FEED)).toBe(true)
  })

  it('what the app reads out of the feed is the readable note', () => {
    const notes = normalizeReleaseNotes(load(withReleaseNotes(FEED, HTML)).releaseNotes)
    expect(notes).not.toBeNull()
    const blocks = notes!.sections[0].blocks
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'heading', 'list', 'heading', 'list'])
    const list = blocks[2]
    if (list.kind !== 'list') throw new Error('expected a list')
    const text = list.items[0].map((r) => r.text).join('')
    expect(text).toContain('따옴표 "와" 역슬래시 \\ 가 든 항목:')
    expect(text).toContain('C:\\temp')
  })

  it('leaves the feed alone when the release has no body', () => {
    expect(withReleaseNotes(FEED, '')).toBe(FEED)
    expect(withReleaseNotes(FEED, '  \n')).toBe(FEED)
    expect(withReleaseNotes(FEED, null)).toBe(FEED)
  })

  it('adds the notes even when the feed lacks a final newline', () => {
    const out = withReleaseNotes(FEED.trimEnd(), HTML)
    expect(load(out).releaseNotes).toBe(HTML)
  })

  it('refuses a feed that already has notes or no version', () => {
    const once = withReleaseNotes(FEED, HTML)
    expect(() => withReleaseNotes(once, HTML)).toThrow(/already/)
    expect(() => withReleaseNotes('files: []\n', HTML)).toThrow(/version/)
  })
})
