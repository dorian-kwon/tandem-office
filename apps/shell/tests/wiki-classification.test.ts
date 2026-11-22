import { describe, expect, it } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { classifyWikiDocument, wikiCategoryLabel } from '../src/main/translate/wiki-classification'

const unknown = { documentType: 'unclassified', industry: null, style: null, institution: null }

describe('local finished-document categories', () => {
  it('classifies a decomposed Korean filename and uses an explicitly named publisher', () => {
    const name = 'C:\\contracts\\2026부산시팸투어가이드북_최종시안.docx'.normalize('NFD')
    expect(classifyWikiDocument(name, '의뢰 기관： 부산광역시\n여행자를 위한 일정입니다.')).toEqual(
      {
        documentType: 'guide',
        industry: 'tourism',
        institution: '부산광역시',
        style: null,
      },
    )
    expect(
      classifyWikiDocument(
        '보건시스템 강화를 위한 모성 및 신생아 보건 개선 사업 종료보고서.hwp',
        '케냐 카지아도주를 방문했다.',
      ),
    ).toEqual({
      ...unknown,
      documentType: 'report',
      industry: 'healthcare',
    })
  })

  it('requires corroborating prose cues, and omits institutions merely mentioned in the document', () => {
    const prose =
      'The parties hereby agree as follows.\nThis section establishes the governing law.\nThe provisions shall be binding.\nThe City of Busan received a copy.'
    expect(classifyWikiDocument('final.txt', prose)).toEqual({
      ...unknown,
      documentType: 'contract',
      style: 'formal',
    })
    expect(
      classifyWikiDocument('final.txt', 'Please refer to the report.\nStudents visited Busan.'),
    ).toEqual(unknown)
    expect(
      classifyWikiDocument(
        'final.txt',
        'Tourist attractions were reviewed.\nThe city welcomed visitors last spring.',
      ),
    ).toEqual({ ...unknown, industry: 'tourism' })
  })

  it('prefers explicit metadata and leaves ambiguous or unsafe categories unclassified', () => {
    expect(
      classifyWikiDocument('travel-guide.txt', '발행처: A 기관\n발행처: B 기관', {
        documentType: 'Rapport',
        industry: '금융',
        institution: 'Ministry of Finance',
        style: '격식체',
      }),
    ).toEqual({
      documentType: 'report',
      industry: 'finance',
      institution: 'Ministry of Finance',
      style: 'formal',
    })
    expect(
      classifyWikiDocument(
        'Guide and Report.txt',
        'Industry: finance\nSector: tourism\nIssued by: One City\nPublisher: Other City',
      ),
    ).toEqual(unknown)
    expect(
      classifyWikiDocument('guide.md', 'Document type: [read this](file)\nClient: [[bad link]]'),
    ).toEqual(unknown)
    expect(classifyWikiDocument('final.md', '制作概要。\n関係者が確認した。')).toEqual(unknown)
  })

  it('accepts explicitly named categories outside the built-in taxonomy', () => {
    expect(
      classifyWikiDocument('a.txt', '산업군: 조선·해양\n문서 유형: 선박 검사표\n문체: 현장 실무체'),
    ).toEqual({
      documentType: '선박 검사표',
      industry: '조선·해양',
      style: '현장 실무체',
      institution: null,
    })
    expect(
      classifyWikiDocument('a.md', '', {
        documentType: '地方条例',
        industry: 'Énergies renouvelables'.normalize('NFD'),
        style: 'سردي',
      }),
    ).toEqual({
      documentType: '地方条例',
      industry: 'Énergies renouvelables',
      style: 'سردي',
      institution: null,
    })
    expect(classifyWikiDocument('a.md', '', { industry: '../[[evil]]' })).toEqual(unknown)
  })

  it('identifies clearly instructional or promotional language independently of document type', () => {
    expect(classifyWikiDocument('기기_설명서.md', '1단계\n파일 버튼을 선택하세요.')).toEqual({
      ...unknown,
      documentType: 'manual',
      style: 'instructional',
    })
    expect(
      classifyWikiDocument('flyer.txt', 'Discover our exclusive offers.\nBook now for next summer.')
        .style,
    ).toBe('promotional')
    expect(
      classifyWikiDocument('Guide.docx', 'Step 1: Open the file.\nClick the Print button.').style,
    ).toBe('instructional')
  })

  it('only uses complete lines for institutional attribution at a sample boundary', () => {
    const cutName = 'x'.repeat(8172) + '\nPublisher: Tandem Office Foundation' + ' '.repeat(4000)
    const cutLabel =
      'y'.repeat(13000) + 'Product publisher: Wrong Organization' + '\n' + ' '.repeat(2018)
    expect(classifyWikiDocument('sample.txt', cutName).institution).toBeNull()
    expect(classifyWikiDocument('sample.txt', cutLabel).institution).toBeNull()
    expect(
      classifyWikiDocument(
        'final.md',
        'x'.repeat(16000) + '\nIssued by: Busan Tourism Organization',
      ).institution,
    ).toBe('Busan Tourism Organization')
  })

  it('displays all built-in categories for every app language and preserves custom names', () => {
    const ids = [
      'report',
      'guide',
      'contract',
      'proposal',
      'manual',
      'press-release',
      'unclassified',
      'tourism',
      'healthcare',
      'finance',
      'technology',
      'education',
      'construction',
      'formal',
      'instructional',
      'promotional',
    ]
    for (const lang of LANGS) {
      const labels = ids.map((id) => wikiCategoryLabel(lang, id))
      expect(labels.every((label) => label.trim().length > 1)).toBe(true)
      expect(new Set(labels).size).toBe(ids.length)
      expect(wikiCategoryLabel(lang, 'Dorian & Co.')).toBe('Dorian & Co.')
    }
    expect(wikiCategoryLabel('ko', 'unclassified')).toBe('미분류')
    expect(wikiCategoryLabel('ja', 'report')).toBe('報告書')
  })
})
