import type { zh } from './zh'

export const ko = {
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
} satisfies Record<keyof typeof zh, string>
