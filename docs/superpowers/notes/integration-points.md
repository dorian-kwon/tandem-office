# 연결 지점과 기준선 (Task 0)

작성일 2026-11-02. 브랜치 `feat/translation-tool`, 기준 커밋 `05ae25999`. 제품 코드는 고치지 않았다. 경로는 저장소 루트 기준이다.

## 1. 기준선

환경: macOS(Darwin), Node v22.23.3(`.nvmrc` 22), npm 10.9.9. `npm ci` 성공, `npm run fixtures` 성공, `npm run check:no-genspark` 통과.

막힌 것: `cargo`가 없어 엑셀 처리 프로그램(Rust, `native:build -w @genoffice/sheets`)을 만들지 못했다. 전체 빌드(`build:all`)와 앱 실행, 홈 화면 확인, `apps/sheets` 테스트는 하지 않았다. 구독을 쓰는 실행은 하지 않았다.

단위 테스트(작업 공간별, 손대지 않은 상태):

| 작업 공간     | 결과                        |
| ------------- | --------------------------- |
| project-store | 126 통과, 2 건너뜀          |
| pdf-structure | 519 통과, 1 건너뜀          |
| agent-core    | 409 통과                    |
| ui            | 1215 통과, 2 건너뜀         |
| ai-provider   | 1543 통과, 2 실패, 1 건너뜀 |
| shell         | 3305 통과, 3 실패, 2 건너뜀 |

실패 5건은 모두 원본 그대로의 상태다. 이유는 Windows 전제 코드로 보인다(원인 분석은 안 함).

- ai-provider `tests/subscription-locate.test.ts`: winget으로 깐 Codex 찾기, 설정한 경로가 없을 때의 대체 탐색(2건)
- shell `tests/mcp-client/local.test.ts`: 셸 없이 서버 실행, 최소 시스템 변수(2건)
- shell `tests/tab-shortcuts.test.ts`: 활성 문서 탭 닫기(1건)

돌리지 않은 작업 공간: 편집기 앱들(docs, sheets, slides, pdf 등), 엔진 패키지들, typecheck, lint.

## 2. 여섯 연결 지점

### 2.1 프로젝트 폴더 기능 (결정 0088)

main에 합쳐져 있고 배선되어 있다(상태 기록은 "구현 끝, 사람 확인 남음", `docs/tracking/status.md` 26번. 화면 동작은 이번에 확인하지 못했다).

- 서비스 본체: `apps/shell/src/main/projects/project-guide.ts`의 `ProjectGuide`. 배선은 `apps/shell/src/main/index.ts`(import는 460~489행 부근, `projectsChanged`는 5872행 부근)와 `projects/project-ipc.ts`.
- 목록: `ProjectGuide.listProjects()`, `getProject(id)`, `createProject(args, askTrust)`, `addFolder(path, askTrust)`, `removeFromList(id)`, `renameProject`, `setPinned`, `relocateProject`, `projectRoot(id)`.
- 목록 저장: `app-settings.json`의 `projects`(`ProjectsAppSettings`, `packages/project-store/src/folder-api.ts`). 폴더 경로, 고정, 믿음 기록, 문서별 선택, `installId`. 목록 경로만 따로 읽는 함수는 `projects/project-index.ts`의 `projectFolderRoots(settingsPath)`.
- 지침 주입: `ProjectGuide.readContext(id)`가 이름, 지침, 기억, 파일 이름, 알림을 모아 `ProjectContextBundle`을 돌려준다. 지침 조립은 순수 함수 `projects/context.ts`의 `assembleTrustedContext`(`instructions.md`, 루트 `AGENTS.md`, `CLAUDE.md`를 이어 32,000자(`INSTRUCTIONS_LIMIT_CHARS`)에서 자른다). 믿음 기록이 `use`일 때만 지침과 기억이 실린다. 목록에만 있고 믿음 확인이 없는 프로젝트는 아무것도 싣지 않는다.
- 지침 쓰기: `saveInstructions(id, text)`(`<폴더>/.ieumoffice/instructions.md`), `writeData`, `appendData`, `updateData`.
- 믿음: `decideTrust(...)`. 번역 프로젝트를 만들 때 `createProject(args, askTrust)`의 `askTrust`가 확인 창을 부른다. 번역 쪽이 자기 폴더를 믿음 `use`로 만들려면 이 흐름을 지나야 한다.
- 채널 이름: `packages/project-store/src/folder-api.ts`의 `PROJECT_FOLDER_CHANNELS`(`projectFolder:listProjects`, `projectFolder:readContext`, `projectFolder:createProject`, `projectFolder:openProjectScreen` 등 41개). preload 다리는 `window.projectFolderApi`.
- 화면 쪽 소비: `packages/ui/src/project-skill.ts`의 `panelProjectSkill`, `createProjectRun`. 열 곳의 AI 창이 모두 쓴다.

### 2.2 화면 나누기와 읽기 전용

- 순수 계산: `apps/shell/src/main/split-layout.ts`(`paneRects`, `decideSplitDrop`, `activationMode`, `splitSurvivor`). 상태 형태는 `apps/shell/src/shared/split-view-api.ts`의 `SplitViewState { aTabId, bTabId, orientation, ratio, focus }`.
- 실행: `apps/shell/src/main/tab-manager.ts`의 `TabManager`. 코드로 두 칸을 만드는 함수는 `beginSplit(aTabId, bTabId, orientation, ratio, focus)`(복원용이지만 공개). 드롭 결과를 적용하는 `splitWith(tabId, intent)`, 비율 `setSplitRatio`, 상태 `splitState()`, 칸 역할 `splitRoleOf(webContentsId)`, 칸 여부 `isPaneTab(tabId)`. 한 칸의 접기(비율 0 또는 1)는 지금 "그 칸을 닫고 남은 칸을 펴기"(`unsplitKeeping`)라서 상태 유지 접기가 아니다.
- 문서를 여는 길: `index.ts`의 `openDocumentPath(filePath)`(드라이브 재열기 판단 후 `routeDocumentPath`), 종류별 `TabManager.openPdfTab(path)`, `openDocsTab`, `openMarkdownTab` 등. 분할 기억: `split-memory.ts`(`readSplitMemory`, `writeSplitMemory`, 설정 키 `splitView`).
- 읽기 전용 칸: 없다. `TabRecord`(tab-manager.ts 176행), `SplitViewState`, `openPdfTab` 어디에도 읽기 전용 표시가 없다. PDF 편집기 안에는 자체 읽기 기능이 있으나 편집기를 고치는 일이라 범위 밖이다.
- 문서 엔진 패키지를 건드리지 않고 더하는 방법(제안, 구현 안 함):
  1. 껍데기에서 `TabRecord`에 `readOnly?: boolean`을 더한다. 번역 화면이 `source/`의 PDF를 `openPdfTab`으로 열 때 켠다.
  2. 저장 길목은 껍데기가 이미 거친다. `tab-document-actions.ts`의 `runTabDocumentAction(deps, id, 'save' | 'saveAs' | 'print')`가 읽기 전용 탭이면 저장을 거부하게 하고, 탭 메뉴와 단축키(`tab-menu.ts`, `tab-shortcuts.ts`)에서도 같은 검사를 쓴다. 편집기 안에서 직접 저장하는 길(자동 저장, 편집기 메뉴)은 별도로 확인해야 한다.
  3. 방어선으로 `source/`의 사본을 OS 읽기 전용으로 두고, 열기 전과 번역 시작 전에 `.tandem/project.json`의 해시와 비교한다(설계 6.1의 해시 기록과 같다).
  4. 칸 접기 토글은 `paneRects`가 아니라 `TabManager.layoutVisible`(tab-manager.ts 428행 부근)에서 해당 칸의 `view.setVisible(false)`로 구현하면 상태(스크롤)를 유지한 채 숨길 수 있다. 새 필드 `collapsed: 'a' | 'b' | null`을 `SplitViewState`에 더하고 `split-memory.ts`에 함께 저장한다. 이 부분은 설계에서도 "새로 만든다"고 한 것이다.
- 주의: `TabManager.split`은 홈과 도움말 탭을 칸으로 받지 않는다(`beginSplit`).

### 2.3 홈 화면에 새 화면 더하기

- `apps/shell/src/renderer/src/Home.tsx`(3713줄). 화면 전환은 라우터가 아니라 불리언 상태다: `driveMode`(1096행), `projectsMode`(1100행), `askMode`. 렌더 분기는 3485~3520행 부근에서 `selectedFolder` → `driveMode` → `projectsMode` → `askMode` → 기본 순서로 고른다. 왼쪽 사이드바 `<nav>`(3470행 부근)에 `nav-item` 버튼을 더하고 `<DrivePanel>`, `<ProjectsPanel>`처럼 패널 컴포넌트를 분기에 더하는 방식이다. 기존 예: `ProjectsPanel.tsx`(`apps/shell/src/renderer/src/`)와 `subscribeProjectScreen`, 문구는 `i18n/strings-projects.ts`(21개 언어를 모두 채워야 한다, `docs/standards.md`).
- 번역 홈 화면은 `translateMode` 불리언과 `TranslationPanel`을 같은 방식으로 더하면 된다. 3289행의 `!selectedFolder && !driveMode ? (projectsMode ? 'projects' : askMode ? 'ask' : view) : null`(현재 화면 이름 계산)과 2958행의 스페이스 키 처리에도 새 모드를 더해야 한다.
- preload는 `apps/shell/src/preload/index.ts`와 `apps/shell/src/shared/*-api.ts`(예: `drive-api.ts`, `home-api.ts`)에 약속을 둔다. 뒷단 등록은 `index.ts`.

### 2.4 앱 설정(`app-settings.json`)에 값 더하기

- 읽고 쓰기: `apps/shell/src/main/app-settings.ts`의 `readAppSettings(path)`, `writeAppSettings(path, updates)`(평평한 JSON 객체, 임시 파일 후 이름 바꾸기). 경로는 `index.ts`의 `APP_SETTINGS_PATH()`(`<userData>/app-settings.json`). 값 하나당 정규화 함수를 두는 형태(`normalizeUserSkillSettings`, 프로젝트 쪽 `ProjectsAppSettings`)가 관례다.
- 약속 문서: `docs/contracts.md` 289행 "앱 설정(`app-settings.json`)의 값" 표에 새 값을 더한다. 편집기 모듈도 같은 파일을 읽으므로 모양은 평평한 객체로 유지한다. 알 수 없는 값은 무시하고 처음 상태로 읽는 것이 규칙이다.
- 주의: `docs/engineering-notes.md`의 "설정 파일" 절은 `ai-settings.json`(제공자 설정)에 관한 것이다. 시스템 프롬프트를 거기에 넣지 말고 `app-settings.json`에 둔다(설계 6.2). `ai-settings.json`을 쓰는 새 길을 만들면 `withStoredKeyModels`, `sealAiSecrets`를 거쳐야 한다(번역 도구가 쓸 일은 없어야 한다).
- 번역 값 제안 키(구현 안 함): `translation.systemPrompt`, `translation.projects`(폴더 경로 목록). 프로젝트 폴더 기능의 `projects`와 겹치지 않게 별도 키로 둔다.

### 2.5 AI 페이지 읽기(진입점과 확인 창)

- 엔진: `packages/pdf-structure/src/ai-read/`. 요청 만들기 `buildAiReadRequest`(instruction.ts), 한 쪽 읽기 `readAiPage({page, pageFingerprint, image, mime, ask, signal})`, 작업용 `createAiReadCallModel({renderPage, ask})`(read-page.ts), 스캔 쪽 자동 선택 `aiReadPreselectPages(tree)`, 이미지 지원 확인 `aiReadVisionCheck(provider, model)`. 작업 시작은 `packages/pdf-structure/src/jobs/ai-read.ts`의 `startAiReadJob`, 견적은 `estimateAiReadJob`.
- 호출처(화면): `apps/pdf/src/renderer/ai-read/AiPageReading.tsx`가 `createAiReadCallModel`과 `startAiReadJob`을 부른다(약 252, 263행). 쪽 이미지는 `ai-read/render-page.ts`.
- 확인 창: `apps/pdf/src/renderer/ai-read/AiReadDialog.tsx`의 `AiReadDialog`(쪽 고르기 단계, 확인 단계). 요금과 전송 사실, 연결 안 됨(`AiConnectPrompt`), 이미지 불가(`aiReadVisionCheck`)를 보여 주고 `onStart(request)`로 결정을 넘긴다. 보내기 문지기 `useAiSendGate`(`@genoffice/ui`), 구독 연결 `useSubscriptionConnection`, 경로 `doc-jobs/route.ts`의 `documentJobRoute`.
- 결과 저장: PDF 결과 보관소(`pdf-structure` store, 뒷단 `apps/shell/src/main/pdf-structure/handlers.ts`의 `aiReadPage` 쓰기).
- 의미: 이 창은 PDF 편집기(`apps/pdf`)의 화면 안에 있다. 번역 화면에서 "AI 읽기" OCR을 쓰려면 번역 화면이 연 원본 PDF 탭 안에서 이 창을 열게 하거나, 같은 엔진 함수를 껍데기 쪽에서 부르고 같은 확인 문구를 따라야 한다. 이번 범위에서는 "기존 확인 창을 따른다"(설계 6.5)는 요구가 어느 쪽인지 정해야 한다(질문으로 남김).
- 단독 이미지 파일(png, jpg)의 OCR 진입점은 기존에 없다. `readAiPage`는 이미지 바이트를 받으므로 엔진 함수는 재사용 가능하다.

### 2.6 PDF 번역 작업 엔진

- 엔진: `packages/pdf-structure/src/translate/`(`index.ts`가 공개 목록). 요청 `buildTranslationRequest(lang, blocks)`, 시스템 프롬프트 `translationSystemPrompt(lang)`(prompt.ts), 모델 호출 `createTranslationModelCall({lang, send, maxResends})`(call.ts), 묶기 `batchTranslationItems`, 결과 `buildTranslatedTree`, `buildBilingualTree`, `translationReport`, 언어 `TRANSLATION_LANGUAGES`, `defaultTargetLanguageForTree`.
- 작업: `packages/pdf-structure/src/jobs/translate.ts`의 `startTranslationJob({callModel, ...})`, 견적 `estimateTranslationJob`. 이어하기, 다시 시작, 쪽 번역(`kind: 'translate-page'`)을 지원한다.
- 호출처: 화면 `apps/pdf/src/renderer/translate/TranslateDialog.tsx`(선택, 확인), `DocumentTranslation.tsx`(`send`를 만들고 작업을 돌림, 신호 흐름은 396행 부근), 쪽 단위는 `apps/pdf/src/renderer/bilingual/actions-controller.ts`, `retranslate.ts`. 명령줄은 같은 엔진을 `packages/cli`에서 돌린다(`docs/architecture.md` 250행).
- 대역본(bilingual) 옵션: `bilingual: boolean`. PDF는 `writeBack({payload: {lang, bilingual: true}})`로 "번역한 쪽을 원본 쪽 옆에" 쓰고, Markdown과 EPUB은 문단 뒤에 번역을 붙인다(TranslateDialog 상단 주석). 트리 쪽은 `buildBilingualTree`.
- 이어붙일 곳: `TranslationSend = (request: {system, prompt, lang, attempt}, signal) => Promise<string>`. 번역 맥락(시스템 프롬프트, 프로젝트 프롬프트, 단어집)을 넣으려면 `send`를 감싸 `request.system`을 덧붙이면 된다. 엔진 패키지를 고칠 필요가 없다(고치지 말 것, 문서 엔진 규칙).
- 목표는 "원본 사본을 편집기에서 고치는 방식"(설계 6.4)이므로, 이 엔진 쓰기가 필요한 것은 PDF 원본일 때 정도다. Word 등은 편집기의 AI 창(2.8)을 쓴다.

### 2.7 도구를 끈 구독 실행에서 앱 쪽 읽기 도구가 요청에 닿는가

닿는다. 단 문서 편집 차례(도구가 있는 차례)에서만이다.

- `packages/ai-provider/src/claude-code-cli.ts`: 내장 도구는 `--tools ""`로 끈다. 앱 도구는 `claudeCodeOutputSchema(tools)`로 출력 형식(`StructuredOutput`)의 `toolCalls[].name` enum에 이름만 실린다. 모델이 그 이름으로 호출을 요청하면 앱의 실행 반복이 도구를 실행하고 결과를 다음 차례에 싣는다. 도구가 0개인 일반 대화와 번역 작업의 `send` 호출은 `toolCalls`가 최대 0개인 형식이거나 도구 없는 일반 답이다.
- 따라서 프로젝트 도구(`project_list_files`, `project_search`, `project_read`, `project_remember`, 이름은 `packages/ui/src/project-skill.ts`의 `PROJECT_TOOLS`)는 편집기 AI 창의 실행 반복(`AgentLoop`)에서만 닿는다. 번역 작업 엔진(`createTranslationModelCall`)은 도구 없는 단발 호출이므로 참고자료 도구를 쓸 수 없다. 번역 작업에는 필요한 단어집과 맥락을 요청 글에 직접 싣는다. 이 판단은 문서(`docs/architecture.md` 96, 198행; `AGENTS.md`의 절대 규칙 3)와 소스를 읽어서 한 것이고, 실제 구독으로 확인하지는 않았다.

## 3. 추가 질문

### (a) 프로젝트 폴더 기능이 합쳐지고 배선되었는가

예. 2.1 참고. 목록은 `ProjectGuide.listProjects()`, 지침 주입은 `readContext(id)`(내부 조립 `assembleTrustedContext`), 실제 요청에 들어가는 자리는 `panelProjectSkill`의 `systemPrompt`(2.8 참고).

### (b) 읽기 전용 칸

없다. 껍데기 쪽에서만 더하는 방법은 2.2의 제안 1~4.

### (c) AI 요청 지시문이 조립되는 곳

- 편집기 AI 창(Word, PDF 등 열 곳): `packages/agent-core/src/loop.ts` 1019행 부근에서 `MATERIAL_NOT_INSTRUCTIONS + skill.systemPrompt + … + systemSuffix?.()`로 이어 붙인다. 스킬은 각 편집기의 `AiPanel.tsx`(예: `apps/pdf/src/renderer/ai/AiPanel.tsx` 753행)가 `...panelProjectSkill({ run: projectPanel.chat.run, lang })`로 더하는 `AgentSkill[]`이다.
- 프로젝트 맥락의 본문: `packages/ui/src/project-skill.ts`의 `projectSystemPrompt(context, canRemember)`(330행)와 `panelProjectSkill`(519행)의 `systemPrompt` getter(679행). 맥락은 보내기 직전 `run.prepare()`가 다리로 읽어 요청 동안 고정한다. 사용자 메시지(`buildContext`)에는 넣지 않는다(대화 기록에 쌓이지 않게, 주소 판정에서 사람의 말로 치이지 않게, `docs/architecture.md` 198행 2번).
- 번역 맥락 훅의 자리(제안): 설계 6.6대로 프로젝트 폴더 기능의 지시문에 번역 항목을 더하려면 `readContext`가 만드는 `ProjectContextBundle.instructions`에 껍데기 쪽에서 번역 항목(시스템 프롬프트, 프로젝트 프롬프트, 단어집)을 덧붙이는 것이 가장 얕다. 이 경우 번역 프로젝트의 `.ieumoffice/instructions.md`에 앱이 쓴 글을 두는 방법도 있으나, 믿음 확인과 해시 변경 알림("바뀌었음" 알림)이 걸린다. 대안으로 `ProjectGuide.readContext` 결과에 값을 더하는 훅을 `project-guide.ts`에 두거나, `panelProjectSkill`에 `extraSystemPrompt` 옵션을 더하는 방법이 있다(후자는 `packages/ui`와 열 곳의 AiPanel 수정이 필요하다). 어느 쪽이든 목록 한도(`INSTRUCTIONS_LIMIT_CHARS` 32,000자)와 알림 흐름을 따로 정해야 한다.
- 번역 작업(문서 전체 일괄 번역)은 별도 길이다. 2.6의 `TranslationSend`를 감싼다.
- 홈 AI 질문: `apps/shell/src/renderer/src/KbAskPanel.tsx`도 `panelProjectSkill`을 쓴다.

## 4. 이후 작업에 넘기는 질문과 위험

1. 번역 프로젝트를 0088의 프로젝트로 만들면 믿음 확인(`askTrust`)이 들어간다. 번역 프로젝트 만들기 때 이 확인 창을 어떻게 보일지 정해야 한다.
2. 읽기 전용 칸과 칸 접기 토글은 껍데기(`tab-manager.ts`)에 새로 만든다. 편집기 자체 저장 길(자동 저장 등)이 읽기 전용 표시를 모르므로 방어선 3(OS 읽기 전용과 해시 비교)을 같이 둔다.
3. OCR "AI 읽기" 확인 창은 PDF 편집기 안에 있다(2.5). 번역 화면에서 열지, 껍데기에서 엔진을 직접 부르고 문구를 복제할지 정해야 한다.
4. Mac에서는 Rust 도구가 없어 앱 전체 빌드와 실행 확인을 못 했다. 앱 실행이 필요한 작업은 이 환경에서 `cargo` 설치 후에 확인한다(전체 설치는 `docs/operations.md`).
5. 프로젝트 폴더 기능은 "사람 확인 남음" 상태다. 번역 쪽은 그 위에 얹으므로, 실제 화면에서의 동작은 앱을 띄워 확인해야 한다.
