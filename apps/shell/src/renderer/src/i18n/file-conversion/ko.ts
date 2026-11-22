import type { zh } from './zh'

export const ko = {
  ocrLanguage: '인식 언어',
  ocrLanguageDefault: '시스템 기본값',
  ocrLanguageUnavailable:
    '선택한 인식 언어를 사용할 수 없습니다. 다른 언어를 선택하거나 기기에 해당 언어를 설치하세요.',
  ocrTitle: 'OCR 하기',
  ocrBatch: '일괄 OCR 시작',
  ocrPdf: '검색 가능한 PDF',
  ocrWord: '편집용 Word',
  ocrRunning: '문자 인식 중…',
  ocrNoText: '인식할 글자를 찾지 못했습니다.',
  ocrUnavailable: '이 기기에서 로컬 문자 인식을 사용할 수 없습니다.',
  title: '파일 변환',
  chooseFiles: '파일 선택',
  outputFormat: '변환할 형식',
  convert: '변환',
  converting: '변환 중…',
  destinationHint:
    '변환한 파일은 각 원본과 같은 폴더에 저장합니다. 이름이 겹치면 새 파일 이름에 번호를 붙입니다.',
  noCommonFormat:
    '모든 파일에 공통으로 쓸 수 있는 형식이 없습니다. 일부 파일을 목록에서 빼거나 다른 파일을 선택하세요.',
  chooseFailed: '파일 선택 창을 열 수 없습니다.',
  convertFailed: '변환을 완료할 수 없습니다.',
  saved: '저장됨',
  failed: '변환 실패',
  removeFile: '{name} 목록에서 제거',
  ocrRange: '인식할 페이지',
  ocrAllPages: '전체 페이지',
  ocrRangeInvalid: '이 파일의 페이지 범위를 확인하세요. 예: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
