import { describe, expect, it } from 'vitest'
import { batchChatTargets } from '../src/renderer/src/translate/batch-chat-targets'

const files = ['완료.docx', '여행 계획.pdf', '다음.hwpx']
const current = files[1]!
describe('batch conversation scope', () => {
  it.each([
    ['전체 문서에 이 용어를 써 줘', files],
    ['  문서 전체 그렇게 해줘.\n단어 사이  공백도 유지해줘.  ', files],
    ['이 문서만 전체 번역해줘', [current]],
    ['전체를 다시 다듬어줘', files],
    ['현재 번역 중인 문서만 공손하게', [current]],
    ['지금 이문서만 다듬어', [current]],
    ['나머지는 그대로 두고 지금 파일 전체를 고쳐줘', [current]],
    ['전체 말고 이 문서만 바꿔 줘', [current]],
    ['아니 전체 문서가 아니라 다음.hwpx만 해줘', ['다음.hwpx']],
    ['여행 계획.pdf 제외하고 모든 문서에 반영', ['완료.docx', '다음.hwpx']],
    ['완료.docx 말고 다음.hwpx에 해줘', ['다음.hwpx']],
    ['다음.hwpx와 완료.docx에만 사용해', ['완료.docx', '다음.hwpx']],
    ['apply to every file except 여행 계획.pdf', ['완료.docx', '다음.hwpx']],
    ['not all documents, just the current document', [current]],
    ['do not change all files', null],
    ['Summarize this table', null],
    ['표 전체를 번역해줘', null],
    ['현재 문서만 말고 전체 문서도 동일하게', files],
    ['이 문서가 아니라 전체 문서에 적용', files],
    ['apply all formatting changes', null],
    ['edit 완료.docx.', [files[0]]],
    ['이 문서를 제외한 전체 문서', ['완료.docx', '다음.hwpx']],
    ['Use “all documents” in the heading', null],
    ['없는.pdf에 적용', null],
  ])('%s', (text, expected) => {
    expect(batchChatTargets(text as string, files, current)).toEqual(expected)
  })
  it('preserves the previous target for a contextual follow-up and accepts localized target labels', () => {
    expect(batchChatTargets('그렇게 해줘', files, current, [files[0]!])).toEqual([files[0]])
    expect(batchChatTargets('그렇게 해줘', files, current, ['old.docx'])).toBeNull()
    expect(
      batchChatTargets('Uprav všechny dokumenty', files, current, undefined, {
        all: 'Všechny dokumenty',
        current: 'Aktuální dokument',
      }),
    ).toEqual(files)
    expect(
      batchChatTargets('Tous les documents sauf le premier', files, current, undefined, {
        all: 'Tous les documents',
        current: 'Document actuel',
      }),
    ).toBeNull()
  })
  it('resolves exact names before shared stems and refuses an ambiguous basename', () => {
    const names = ['guide.pdf', 'guide.docx', 'north-guide.pdf']
    expect(batchChatTargets('edit guide.pdf', names)).toEqual(['guide.pdf'])
    expect(batchChatTargets('edit guide', names)).toBeNull()
    expect(batchChatTargets('edit north-guide.pdf', names)).toEqual(['north-guide.pdf'])
  })
  it('asks for a target when several files match and routes an unambiguous one-file run', () => {
    expect(batchChatTargets('polish the title', files, current)).toBeNull()
    expect(batchChatTargets('apply to all files', files, current)).toEqual(files)
    expect(batchChatTargets('polish the title', [current])).toEqual([current])
    expect(batchChatTargets('just this file', files)).toBeNull()
    expect(batchChatTargets('전체 문서 말고', files, current)).toBeNull()
  })
})
