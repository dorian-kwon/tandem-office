// Puts a release's notes into the update feed (latest.yml) the build wrote.
//
// The installed app reads the feed through electron-updater's private GitHub
// provider, which returns latest.yml as it is and never fetches the release
// body. Notes the update window should show therefore have to travel inside
// the feed, as `releaseNotes` (one string of GitHub-rendered HTML; the app turns
// it into plain text blocks, apps/shell/src/main/update-notes.ts).
//
// The installer's hash covers the exe, not the feed, so adding a field changes
// nothing the updater checks. Run it before the build is attested, so the
// attestation covers the feed that is published.
//
//   node tools/release-feed-notes.mjs <latest.yml> <notes.html>

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * `feedText` with `html` appended as the `releaseNotes` field; the text is
 * returned unchanged when the release has no body.
 *
 * The note is written as a JSON string: a double-quoted scalar is valid YAML and
 * needs no escaping rules of its own, and everything before it stays byte for byte.
 */
export function withReleaseNotes(feedText, html) {
  if (!/^version:[ \t]*\S/m.test(feedText)) throw new Error('the feed has no version')
  if (/^releaseNotes:/m.test(feedText)) throw new Error('the feed already has release notes')
  const notes = typeof html === 'string' ? html.trim() : ''
  if (notes === '') return feedText
  const base = feedText.endsWith('\n') ? feedText : `${feedText}\n`
  return `${base}releaseNotes: ${JSON.stringify(notes)}\n`
}

function main(argv) {
  const [feedPath, notesPath] = argv
  if (!feedPath || !notesPath) {
    console.error('usage: node tools/release-feed-notes.mjs <latest.yml> <notes.html>')
    return 2
  }
  const feed = readFileSync(feedPath, 'utf8')
  const next = withReleaseNotes(feed, readFileSync(notesPath, 'utf8'))
  if (next === feed) {
    console.log('the release has no notes; the feed is unchanged')
    return 0
  }
  writeFileSync(feedPath, next)
  console.log(`added the release notes to ${feedPath}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
