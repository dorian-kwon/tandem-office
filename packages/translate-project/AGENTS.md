# translate-project

## 맡은 범위

번역 도구의 프로젝트 모델이다. 지금은 프로젝트 파일(`project.json`)의 스키마, 기본값, 파싱과 직렬화를 맡는다. 이후 용어집, 원본 가드, 프로젝트 저장소가 이 패키지에 더해진다.

## 맡지 않는 것 (경계)

- Electron, 파일 시스템, IPC를 쓰지 않는다. 디스크 읽기와 쓰기는 호출하는 셸이 한다.
- AI 호출과 OCR 실행은 하지 않는다. 여기에는 OCR 설정값만 있다.

## 항상 지켜야 하는 것

- 순수 TypeScript만 쓴다. 런타임 의존성을 더하지 않고 `node:*`도 import하지 않는다.
- `ProjectFile`에는 시스템 프롬프트 필드가 없다. 프로젝트 프롬프트(`projectPrompt`)만 사용자가 고치며, 파서는 모르는 키를 버린다.
- 형식이 틀린 파일은 `ProjectFileError`로 던진다. 버전은 1만 받는다.
- 기본 OCR은 `{ kind: 'ai', provider: 'claude' }`다.

## 테스트

- `npm run test -w @genoffice/translate-project`. 테스트는 `src/*.test.ts`에 소스 옆에 둔다.
