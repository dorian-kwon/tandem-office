# translate-project

## 맡은 범위

번역 도구의 프로젝트 모델과 프로젝트 폴더(결정 0102)의 읽기·쓰기다. 폴더 모양과 파일의 약속은 `docs/contracts.md`의 "번역 프로젝트 폴더"에 있다.

- `project-file.ts`: `project.json`의 스키마, 기본값, 파싱(`ProjectFileError`)과 직렬화.
- `project-store.ts`: 폴더 만들기(`source/`·`references/`·`glossary/`·`output/`·`.tandem/`, 이름 검사와 실패 때 치우기), 읽기, 원자적 저장, 상태(`ok`·`not-found`·`invalid`), 폴더 지우기(올바른 프로젝트 파일이 있을 때만).
- `source-guard.ts`: 원본 종류 판정(`EDITABLE_SOURCE_EXTENSIONS`, `IMAGE_SOURCE_EXTENSIONS`), 덮어쓰지 않는 복사(`copyIntoWithSuffix`, 덤으로 볼 폴더 목록), 원본 사본 만들기와 SHA-256(`importSource`, `source/`와 `output/`에 없는 이름), 해시 확인(`verifySource`).
- `materials.ts`: 원본·참고자료·단어집 더하기와 빼기, 합친 단어집 `glossary.json`. 참고자료를 더하고 뺄 때 `convert`를 받으면 같은 잠금 안에서 색인을 맞춘다(실패는 삼키고 파일마다 상태로 남긴다). `refreshReferences`는 잠금 안에서 목록과 색인을 맞춘다.
- `glossary.ts`: 단어집 읽기(csv, 탭으로 나눈 txt, 첫 시트의 xlsx; UTF-16·UTF-8·CP949; 읽지 못하면 `GlossaryFormatError`)와 고르기(`selectGlossary`, 상한 `DEFAULT_GLOSSARY_LIMIT` 200).
- `source-kind.ts`: PDF를 텍스트 PDF·스캔으로 고친 사람의 선택(`.tandem/source-kinds.json`).
- `project-lock.ts`: 같은 폴더의 읽고-고치고-쓰기를 한 줄로 세우는 프로세스 안 잠금.
- `compose.ts`: AI 요청에 붙일 번역 맥락 글(프롬프트, 언어 쌍, 단어집, 참고자료 이름)과 그 항목 목록, 그리고 따로 둔 참고자료 조각 글(`referencesText`, 조각마다 `[파일 — 제목]`).
- `reference-md.ts`: 참고자료를 마크다운 글로(`convertReferenceToMarkdown`). 읽기는 셸이 넘긴 함수(`file-parse`의 `parseFileToText`)가 하고, 여기는 결과를 판정만 한다. 그림과 글자 층 없는 PDF(글자와 숫자 20자 미만)는 `needs-ocr`, 목록 밖 형식은 `unsupported`, 읽기 실패는 `failed`. HTML은 태그를 걷어 낸다.
- `reference-index.ts`: 변환한 글 `references/.md/<이름>.md`와 색인 `.tandem/references-index.json`(맞추기 `syncReferenceIndex`, 상태 `referenceStatuses`, 읽기 `readConvertedReference`), 요청마다 고르기 `queryReferences`(BM25, k1 1.2, b 0.75, 합이 상한 이하이면 통째로). 조각은 제목에서 끊고 문단을 1,200자(`REFERENCE_CHUNK_CHARS`)까지 묶는다. 요청 상한 기본값은 6,000자(`DEFAULT_REFERENCE_CHARS`).

## 맡지 않는 것 (경계)

- Electron, IPC, 화면을 쓰지 않는다. 등록된 프로젝트 목록과 전체 시스템 프롬프트(`app-settings.json`), 창구와 경로 검사는 `apps/shell`(`src/main/translate/`)이 한다.
- 셸을 가져오지 않는다. 그래서 편집기 확장자 표를 직접 들고 있고, 셸의 `tests/translate-source-types.test.ts`가 `app-routing.ts`의 `ROUTED_EXTENSIONS`와 같은지 지킨다. 한쪽만 고치면 그 테스트가 깨진다.
- AI 호출과 OCR 실행은 하지 않는다. 여기에는 OCR 설정값만 있다.

## 항상 지켜야 하는 것

- 순수 TypeScript와 Node 내장 모듈(`node:fs`, `node:crypto`, `node:zlib`)만 쓴다. 런타임 npm 의존성을 더하지 않는다. 화면(렌더러)은 이 패키지를 가져오지 못한다.
- 사람의 원래 파일은 읽기만 한다. 폴더 안에서도 덮어쓰지 않는다(`COPYFILE_EXCL`, 번호 붙이기). `.tandem/`의 JSON은 임시 파일에 쓴 뒤 이름을 바꾼다. 쓰기 실패 때는 방금 만든 사본을 치우고, 정리 실패가 원래 오류를 가리지 않게 한다.
- 파일 이름을 받는 함수는 파일 시스템에 닿기 전에 경로 구분자·`.`·`..`를 거절한다(`NotListedError`).
- `ProjectFile`에는 시스템 프롬프트 필드가 없다. 프로젝트 프롬프트(`projectPrompt`)만 사용자가 고치며, 파서는 모르는 키를 버린다. 버전은 1만 받는다. 기본 OCR은 `{ kind: 'ai', provider: 'claude' }`다.
- 오류는 이름이 있는 클래스로 던진다(`ProjectExistsError`, `InvalidProjectNameError`, `NotAProjectError`, `UnsupportedSourceError`, `NotListedError`, `GlossaryFormatError` 등). 셸은 그 이름으로 오류 코드를 고른다(`src/shared/translate-api.ts`).
- 맥락 글(`text`)에는 참고자료의 이름만 넣는다. 내용은 요청마다 고른 조각만 `referencesText`로 따로 내고, 호출자가 `<translation-references>`로 감싼다. 참고자료 파일 자체는 읽기만 한다. 변환한 글은 `references/.md/`에만 쓴다.
- 이 PC에서 도는 OCR, 모델, 임베딩을 쓰지 않는다. 참고자료 찾기는 낱말(BM25)뿐이다. 한 파일의 실패가 프로젝트를 막지 않는다.

## 테스트

- `npm run test -w @genoffice/translate-project`. 테스트는 `src/*.test.ts`에 소스 옆에 둔다. 임시 폴더에서 실제 파일 시스템으로 돈다.
