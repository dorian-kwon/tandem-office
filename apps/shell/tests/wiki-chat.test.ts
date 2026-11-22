import { expect, it } from 'vitest'
import { isWikiEditingRequest } from '../src/shared/wiki-chat'

it.each([
  '번역해 줘',
  '전체 병기 번역',
  '문장을 다듬어줘',
  '영어로 옮겨 줘',
  'Please translate the selected paragraph.',
  'Polish the introduction.',
  '请翻译这一段',
  '翻訳して',
])('recognizes translation and revision requests (%s)', (query) => {
  expect(isWikiEditingRequest(query)).toBe(true)
})
it.each([
  '문서 열어줘',
  '번역본 열어줘',
  '일괄 번역 진행률 알려줘',
  'Open the translation.',
  'Choose a file',
  undefined,
])('leaves other chat requests alone (%s)', (query) => {
  expect(isWikiEditingRequest(query)).toBe(false)
})
