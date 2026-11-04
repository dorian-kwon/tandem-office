import { resolve } from 'node:path'

/**
 * Private OCR project folders made by the app for one document (the sheets AI's picture OCR).
 * They are not in the person's project list; the translation channels accept them for this
 * run only. Held in memory, so a restart forgets them.
 */
const dirs = new Set<string>()
const key = (dir: string): string => resolve(dir).normalize('NFC').toLowerCase()

export function allowAdHocDir(dir: string): void {
  dirs.add(key(dir))
}

export function isAdHocDir(dir: unknown): boolean {
  return typeof dir === 'string' && dirs.has(key(dir))
}
