# 번역툴(tandem office) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이음오피스를 포크해 프로젝트 목록·상세·번역 화면을 가진 단독 사용자용 번역 데스크톱 앱을 만든다.

**Architecture:** 번역 프로젝트의 순수 로직(폴더 구조, 단어집, 프롬프트 조립, 원본 보호)은 새 패키지 `packages/translate-project`에 두고 Electron 없이 테스트한다. 화면과 연결은 `apps/shell`에 새 모듈로 더하고, 문서 엔진 패키지는 수정하지 않는다. AI 맥락은 기존 프로젝트 폴더 기능(결정 0088)의 지시문 주입 경로에 번역 항목을 더해 넘긴다.

**Tech Stack:** TypeScript, Electron, React(껍데기 앱 renderer), vitest, npm workspaces (원본 저장소 그대로).

**Spec:** `docs/superpowers/specs/2026-11-02-translation-tool-design.md`

## Global Constraints

- 포크 대상: https://github.com/pblsketch/openoffice (Apache-2.0). `LICENSE`, `NOTICE`, 출처 표시를 유지한다.
- 코드 내부 이름 `@genoffice/*`, `GENOFFICE_*`를 바꾸지 않는다. `genoffice` 명령어와 `~/.genoffice`는 읽지도 고치지도 않는다.
- 문서 엔진 패키지(`docx-engine`, `pptx-*`, `xlsx-gateway`, `pdf2docx`, `html2docx`, `odt-engine` 등)는 수정하지 않는다. 필요해 보이면 멈추고 사용자에게 묻는다.
- 구독 프로그램의 로그인 정보에 손대지 않는다. 사용자가 고르지 않은 요금 경로로 AI 요청을 보내지 않는다.
- 서버, 도커, 계정 없음. 프로젝트 하나 = 폴더 하나, 파일로만 저장.
- 프로젝트 폴더 구조: `source/`, `references/`, `glossary/`, `output/`, `.tandem/project.json`, `.tandem/glossary.json`, `.ieumoffice/`.
- 시스템 프롬프트는 앱 설정에 저장하는 전체 공통 값이고, 프로젝트 프롬프트는 `.tandem/project.json`에 저장한다. 조립 순서는 시스템 → 프로젝트.
- OCR 선택지는 "AI 읽기(Claude 또는 ChatGPT 중 선택)"와 "끔" 두 가지뿐이다. 로컬 OCR은 만들지 않는다.
- OCR은 선택해서 실행한다: 시작 전에 페이지(PDF)나 파일(이미지)을 사용자가 고르고 "전체 선택" 단추가 있다. 고른 것만 AI로 보내며, 아무것도 고르지 않으면 시작할 수 없다. (사용자 결정, 2026-11-02, 계획 작성 후 추가)
- 단어집: csv, xlsx, txt를 읽는다. UTF-8과 CP949를 자동 판별하고, 열은 `원어, 번역어, 비고` 순이며, 첫 줄이 제목이면 건너뛰고, xlsx는 첫 시트만 읽는다. 항목이 200개 이하면 전체를 싣고 넘으면 해당 문단에 나온 용어만 싣는다. 200은 설정으로 바꿀 수 있다.
- 원본은 `source/`에 복사하고 해시를 기록한다. 열 때마다 해시를 비교해 달라졌으면 알린다. 번역은 `output/`의 사본에서 한다.
- 번역할 문서를 지워도 `output/`의 번역본은 지우지 않는다. 번역본은 따로 확인을 받고 지운다.
- PDF·스캔·이미지의 결과 형식: 일반 PDF는 기존 번역 엔진의 번역 PDF(선택 시 대역본), 스캔 PDF와 이미지는 OCR 결과를 Word 문서로 만들어 그 문서에서 번역한다.
- 화면 문구는 21개 언어를 모두 채운다는 원본 규칙을 따른다(시점은 Task 12).
- 제품 이름은 `tandem office`다. 이음오피스 이름과 브랜드를 그대로 쓰지 않는다.

## Review Focus

1. 단어집에 한글이 CP949로 저장된 csv가 올라온다. 깨지지 않고 읽혀야 한다. (Task 2)
2. 원본 파일이 `source/`에 복사된 뒤 사용자가 바깥에서 원본을 고쳤다. 앱은 `source/`의 사본을 쓰고, 바뀌었다는 사실을 알려야 한다. (Task 3)
3. 같은 이름의 문서를 두 번 올린다. 덮어쓰지 말고 이름을 구분해야 한다. (Task 5)
4. 프로젝트 폴더가 사용자 손으로 옮겨지거나 지워진 뒤 목록에 남아 있다. 목록이 깨지지 않고 "찾을 수 없음"으로 표시되어야 한다. (Task 4)
5. AI 읽기를 시작할 때 이미지가 제공자로 나간다는 사실과 요금 안내를 사용자가 보지 못하고 지나간다. 확인 없이 전송되면 안 된다. (Task 10)

---

### Task 0: 포크, 빌드, 연결 지점 확인

이 작업은 이후 작업의 경로와 이름을 확정한다. 확인 결과를 `docs/superpowers/notes/integration-points.md`에 적는다.

**Files:**

- Create: `<workspace>/tandem2/app/` (포크한 저장소)
- Create: `docs/superpowers/notes/integration-points.md`

**Interfaces:**

- Produces: 아래 연결 지점의 실제 파일 경로와 함수 이름. Task 5~11이 이 문서를 근거로 삼는다.

- [ ] **Step 1: 포크하고 내려받는다**

Run: `cd <workspace>/tandem2 && gh repo fork pblsketch/openoffice --clone=true --fork-name tandem -- app` 실패하면 `gh repo clone pblsketch/openoffice app`으로 받고 새 원격 저장소를 연결한다.
Expected: `app/` 안에 `package.json`, `apps/`, `packages/`가 있다.

- [ ] **Step 2: 설치하고 빌드해서 기준선을 기록한다**

`docs/operations.md`의 "설치, 실행, 검사" 절차대로 `.nvmrc`의 Node 버전으로 설치, 빌드, 단위 테스트를 돌린다. 통과·실패 개수를 노트에 적는다. 실패가 있으면 손대지 않은 상태의 것이라고 표시한다.
Expected: 앱이 실행되고 홈 화면이 뜬다.

- [ ] **Step 3: 연결 지점을 찾아 노트에 적는다**

다음 여섯 가지의 파일 경로와 공개 함수·채널 이름을 찾는다.

1. `apps/shell/src/main/projects/`의 프로젝트 목록 저장, 지침 주입 함수. main에 합쳐져 동작하는지도 확인한다.
2. 분할 화면을 여는 함수(`apps/shell/src/main/split-layout.ts`, `tab-manager.ts`)와 읽기 전용으로 여는 방법의 유무.
3. 홈 화면(`apps/shell/src/renderer/src/Home.tsx`)에 새 화면을 더하는 방식.
4. 앱 설정(`app-settings.json`)에 값을 더하는 방식(`docs/engineering-notes.md`의 "설정 파일", `docs/contracts.md`).
5. AI 페이지 읽기의 호출 진입점과 확인 창(`packages/pdf-structure/src/ai-read`).
6. PDF 번역 작업 엔진의 호출 진입점(`packages/pdf-structure/src/translate`)과 대역본 옵션.
   또한 도구를 끈 구독 실행에서 앱 쪽 읽기 도구가 요청에 닿는지 확인한다.

- [ ] **Step 4: 규칙 확인 후 커밋**

`npm run check:no-genspark`와 `docs/standards.md`의 합치기 전 검사를 실행한다.

```bash
git add docs/superpowers/notes/integration-points.md
git commit -m "docs: record integration points for translation project"
```

---

### Task 1: translate-project 패키지 골격과 프로젝트 파일 스키마

**Files:**

- Create: `app/packages/translate-project/package.json` (이름 `@genoffice/translate-project`, 다른 패키지의 형식을 따른다)
- Create: `app/packages/translate-project/AGENTS.md`
- Create: `app/packages/translate-project/src/project-file.ts`
- Create: `app/packages/translate-project/src/index.ts`
- Test: `app/packages/translate-project/src/project-file.test.ts`

**Interfaces:**

- Produces:
  - `type OcrMode = { kind: 'off' } | { kind: 'ai'; provider: 'claude' | 'chatgpt' }`
  - `type ProjectFile = { version: 1; name: string; sourceLang: string; targetLang: string; projectPrompt: string; ocr: OcrMode; sources: SourceEntry[]; references: string[]; glossaryFiles: string[] }`
  - `type SourceEntry = { file: string; sha256: string; kind: 'editable' | 'pdf' | 'scan' | 'image' }`
  - `function defaultProjectFile(name: string, sourceLang: string, targetLang: string): ProjectFile` 기본 OCR은 `{ kind: 'ai', provider: 'claude' }`
  - `function parseProjectFile(json: string): ProjectFile` 형식이 틀리면 `ProjectFileError`를 던진다
  - `function serializeProjectFile(p: ProjectFile): string`

- [ ] **Step 1: Write the failing test**

테스트 이름과 단언: `roundtrips a default project file` (`parseProjectFile(serializeProjectFile(p))`가 `p`와 같다), `default OCR is ai with claude`, `rejects version 2 with ProjectFileError`, `rejects missing name`, `projectPrompt never contains the system prompt field` (객체에 `systemPrompt` 키가 없다).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/translate-project/src/project-file.test.ts`
Expected: FAIL, 모듈을 찾을 수 없음.

- [ ] **Step 3: Implement `project-file.ts`**

수동 검증 함수로 구현한다. 새 의존성을 더하지 않는다.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/translate-project/src/project-file.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/translate-project
git commit -m "feat(translate-project): project file schema"
```

---

### Task 2: 단어집 읽기와 용어 고르기

**Files:**

- Create: `app/packages/translate-project/src/glossary.ts`
- Test: `app/packages/translate-project/src/glossary.test.ts`
- Fixtures: `app/packages/translate-project/src/__fixtures__/glossary-cp949.csv`, `glossary-header.csv`, `glossary.txt`, `glossary.xlsx`

**Interfaces:**

- Produces:
  - `type GlossaryEntry = { source: string; target: string; note?: string }`
  - `function parseGlossary(bytes: Uint8Array, fileName: string): GlossaryEntry[]` 확장자(csv, txt, xlsx)로 판단한다. txt는 탭 구분이고, csv는 쉼표 구분이다.
  - `function selectGlossary(entries: GlossaryEntry[], paragraph: string, limit = 200): GlossaryEntry[]` 항목 수가 `limit` 이하면 전체를 반환하고, 넘으면 `paragraph`에 `source`가 포함된 항목만 반환한다.

- [ ] **Step 1: Write the failing test**

- `parses cp949 csv without mojibake`: CP949로 인코딩한 `계약,contract`가 `{source:'계약',target:'contract'}`가 된다.
- `skips header row`: 첫 줄이 `원어,번역어,비고`이면 건너뛴다.
- `reads only the first xlsx sheet`
- `returns all entries at or below limit` (200개)
- `returns only matching entries above limit` (201개 중 문단에 나온 2개)
- `case-insensitive match for latin terms`
- `ignores blank lines and rows with empty source`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/translate-project/src/glossary.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

인코딩 판별은 UTF-8로 엄격 디코딩을 시도하고 실패하면 `TextDecoder('euc-kr')`를 쓴다. xlsx 읽기는 저장소에 이미 있는 xlsx 읽기 경로를 쓴다(Task 0 노트에서 확인). 새 의존성은 더하지 않는다.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/translate-project/src/glossary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/translate-project
git commit -m "feat(translate-project): glossary parsing and selection"
```

---

### Task 3: 원본 복사와 해시 검사

**Files:**

- Create: `app/packages/translate-project/src/source-guard.ts`
- Test: `app/packages/translate-project/src/source-guard.test.ts`

**Interfaces:**

- Consumes: `SourceEntry` (Task 1)
- Produces:
  - `function importSource(projectDir: string, originalPath: string): Promise<SourceEntry>` 파일을 `source/`로 복사하고 SHA-256을 계산한다. 같은 이름이 있으면 `이름 (2).확장자`로 구분한다.
  - `function verifySource(projectDir: string, entry: SourceEntry): Promise<'ok' | 'changed' | 'missing'>`
  - `function classifySource(fileName: string): SourceEntry['kind']` docx, xlsx, pptx, hwp, hwpx, epub, md, html은 `editable`, pdf는 `pdf`, 이미지 확장자는 `image`이다. PDF가 스캔본인지는 Task 10에서 정한다.

- [ ] **Step 1: Write the failing test**

임시 폴더에서 다음을 확인한다: `copies file into source/ and records sha256`, `second import of same name gets suffix (2)`, `verify returns changed after the copy is modified`, `verify returns missing after deletion`, `import never modifies the original file` (원본의 해시와 수정 시각이 그대로).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/translate-project/src/source-guard.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`node:fs/promises`와 `node:crypto`만 쓴다.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/translate-project/src/source-guard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/translate-project
git commit -m "feat(translate-project): source import and hash verification"
```

---

### Task 4: 프로젝트 만들기, 불러오기, 삭제

**Files:**

- Create: `app/packages/translate-project/src/project-store.ts`
- Test: `app/packages/translate-project/src/project-store.test.ts`

**Interfaces:**

- Consumes: `defaultProjectFile`, `parseProjectFile`, `serializeProjectFile` (Task 1)
- Produces:
  - `function createProject(parentDir: string, name: string, sourceLang: string, targetLang: string): Promise<{ dir: string; project: ProjectFile }>` 폴더 구조(`source/`, `references/`, `glossary/`, `output/`, `.tandem/project.json`)를 만든다. 같은 이름의 폴더가 이미 있으면 `ProjectExistsError`를 던진다.
  - `function loadProject(dir: string): Promise<ProjectFile>`
  - `function saveProject(dir: string, p: ProjectFile): Promise<void>` 임시 파일에 쓰고 이름을 바꾸는 방식이다.
  - `function removeProject(dir: string, opts: { deleteFolder: boolean }): Promise<void>` `deleteFolder`가 false면 폴더에 손대지 않는다(목록에서 빼는 일은 Task 5가 한다).
  - `function projectStatus(dir: string): Promise<'ok' | 'not-found' | 'invalid'>`

- [ ] **Step 1: Write the failing test**

`creates the full folder layout`, `refuses to overwrite an existing folder`, `loads what was saved`, `status is not-found for a moved folder`, `status is invalid for a corrupt project.json`, `removeProject with deleteFolder false leaves files`, `removeProject with deleteFolder true removes the directory`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/translate-project/src/project-store.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/translate-project/src/project-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/translate-project
git commit -m "feat(translate-project): create, load, remove projects"
```

---

### Task 5: 상세 화면 동작: 자료 올리기와 지우기

**Files:**

- Create: `app/packages/translate-project/src/materials.ts`
- Test: `app/packages/translate-project/src/materials.test.ts`

**Interfaces:**

- Consumes: `importSource`, `SourceEntry` (Task 3), `saveProject`, `loadProject` (Task 4), `parseGlossary` (Task 2)
- Produces:
  - `function addSource(dir: string, originalPath: string): Promise<ProjectFile>`
  - `function removeSource(dir: string, file: string): Promise<ProjectFile>` `source/`의 사본만 지우고 `output/`은 건드리지 않는다.
  - `function addReference(dir: string, originalPath: string): Promise<ProjectFile>`
  - `function removeReference(dir: string, file: string): Promise<ProjectFile>`
  - `function addGlossary(dir: string, originalPath: string): Promise<ProjectFile>` 올릴 때 파싱해서 `.tandem/glossary.json`에 정규화해 저장한다. 파싱에 실패하면 파일을 남기지 않고 오류를 던진다.
  - `function removeGlossary(dir: string, file: string): Promise<ProjectFile>` 남은 단어집 파일로 `.tandem/glossary.json`을 다시 만든다.
  - `function loadGlossary(dir: string): Promise<GlossaryEntry[]>`

- [ ] **Step 1: Write the failing test**

`removeSource keeps the translated copy in output/`, `adding a same-named reference twice keeps both`, `addGlossary writes normalized glossary.json`, `addGlossary with unreadable file leaves no copy in glossary/`, `removeGlossary rebuilds merged glossary from remaining files`, `removing a file that is not listed throws NotListedError`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/translate-project/src/materials.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/translate-project/src/materials.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/translate-project
git commit -m "feat(translate-project): material add/remove"
```

---

### Task 6: 프롬프트 조립

**Files:**

- Create: `app/packages/translate-project/src/compose.ts`
- Test: `app/packages/translate-project/src/compose.test.ts`

**Interfaces:**

- Consumes: `ProjectFile` (Task 1), `GlossaryEntry`, `selectGlossary` (Task 2)
- Produces:
  - `type ComposedContext = { text: string; items: { kind: 'system' | 'project' | 'glossary' | 'reference'; label: string; included: boolean }[] }`
  - `function composeContext(input: { systemPrompt: string; project: ProjectFile; glossary: GlossaryEntry[]; paragraph: string; glossaryLimit?: number }): ComposedContext` 순서는 시스템 → 프로젝트 → 단어집 → 참고자료 이름 목록이다. 비어 있는 항목은 `included:false`로 `items`에 남긴다. `items`는 6.4의 "실린 항목 보여 주기"가 쓴다.

- [ ] **Step 1: Write the failing test**

`orders system before project`, `omits empty system prompt but lists it as not included`, `includes whole glossary at 200 entries`, `includes only matching terms at 201 entries`, `lists reference file names`, `text never contains source file contents` (참고자료 내용은 싣지 않고 이름만).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/translate-project/src/compose.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/translate-project/src/compose.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/translate-project
git commit -m "feat(translate-project): compose AI context"
```

---

### Task 7: 껍데기 앱에 프로젝트 기능 연결 (뒷단)

Task 0의 노트에 적힌 경로를 따른다. 아래 경로는 노트와 다르면 노트를 우선한다.

**Files:**

- Create: `app/apps/shell/src/main/translate/translate-ipc.ts`
- Create: `app/apps/shell/src/shared/translate-api.ts`
- Modify: preload와 설정 파일(Task 0에서 확인한 위치)에 `translateSystemPrompt: string`, 프로젝트 목록 경로 배열을 더한다.
- Test: `app/apps/shell/src/main/translate/translate-ipc.test.ts`

**Interfaces:**

- Consumes: Task 1~6의 모든 공개 함수
- Produces (`translate-api.ts`의 채널 계약):
  - `translate:list(): Promise<{ dir: string; name: string; status: 'ok' | 'not-found' | 'invalid'; sourceLang: string; targetLang: string; lastOpened: number }[]>`
  - `translate:create(args: { parentDir: string; name: string; sourceLang: string; targetLang: string }): Promise<{ dir: string }>`
  - `translate:remove(args: { dir: string; deleteFolder: boolean }): Promise<void>`
  - `translate:get-system-prompt(): Promise<string>` / `translate:set-system-prompt(text: string): Promise<void>`
  - `translate:get-project(dir: string): Promise<ProjectFile>` / `translate:save-project(dir: string, p: ProjectFile): Promise<void>`
  - `translate:add-material(args: { dir: string; kind: 'source' | 'reference' | 'glossary'; path: string }): Promise<ProjectFile>` / `translate:remove-material(args: { dir: string; kind: 'source' | 'reference' | 'glossary'; file: string }): Promise<ProjectFile>`
  - 채널 이름은 프로세스 전체에서 유일해야 하므로 모두 `translate:` 접두사를 쓴다.

- [ ] **Step 1: Write the failing test**

핸들러를 가짜 Electron 없이 호출하는 단위 테스트: `list marks a deleted folder as not-found without throwing`, `remove with deleteFolder false only drops the list entry`, `set/get system prompt roundtrips through settings`, `add-material for glossary returns project with glossaryFiles updated`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/shell/src/main/translate/translate-ipc.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

기존 `ipcMain.handle` 등록 방식과 설정 저장 방식을 따른다. 폴더 삭제는 앱 쪽에서 한 번 더 `dir`이 등록된 프로젝트 목록에 있는지 확인한 뒤에만 실행한다.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/shell/src/main/translate/translate-ipc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/shell packages/translate-project
git commit -m "feat(shell): translate project IPC and settings"
```

---

### Task 8: 목록 화면과 상세 화면

**Files:**

- Create: `app/apps/shell/src/renderer/src/translate/ProjectList.tsx`
- Create: `app/apps/shell/src/renderer/src/translate/ProjectDetail.tsx`
- Modify: `app/apps/shell/src/renderer/src/Home.tsx` (진입 카드 하나)
- Test: `app/apps/shell/src/renderer/src/translate/ProjectList.test.tsx`, `ProjectDetail.test.tsx`
- Test (e2e): `app/e2e/translate-projects.spec.ts`

**Interfaces:**

- Consumes: `translate:*` 채널 (Task 7)
- Produces: 목록 화면(생성, 삭제 확인 창, 목록, 시스템 프롬프트 입력란), 상세 화면(번역할 문서·참고자료·단어집 각각의 올리기 목록과 삭제 단추, 프로젝트 프롬프트 입력란, OCR 선택 칸, "번역 시작" 단추).

- [ ] **Step 1: Write the failing test**

- `list shows not-found projects as disabled with a remove button`
- `delete asks whether to remove only from the list or also the folder`
- `system prompt field saves on blur`
- `detail shows three separate upload lists`
- `each uploaded item has its own delete button`
- `OCR select offers only 'AI (Claude)', 'AI (ChatGPT)' and 'Off'`
- `start translation is disabled while no source is added`

e2e: 프로젝트 만들기 → 단어집 올리기 → 원본 올리기 → 지우기 → 프로젝트 삭제(목록에서만)가 앱에서 끝까지 되는지 확인한다.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/shell/src/renderer/src/translate`
Expected: FAIL

- [ ] **Step 3: Implement**

화면 색은 `docs/standards.md`의 "화면 색" 규칙을 따른다. 문구는 이 단계에서는 한국어와 영어 키만 만들고 나머지 언어는 Task 12에서 채운다.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/shell/src/renderer/src/translate` 그리고 e2e 실행 명령은 `docs/operations.md`를 따른다.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/shell e2e
git commit -m "feat(shell): project list and detail screens"
```

---

### Task 9: 번역 화면 (분할, 읽기 전용 원본, 숨김)

**Files:**

- Create: `app/apps/shell/src/main/translate/open-translation.ts`
- Modify: `app/apps/shell/src/main/split-layout.ts`, `tab-manager.ts` (읽기 전용 칸과 숨김 토글, Task 0 노트의 실제 위치)
- Test: `app/apps/shell/src/main/translate/open-translation.test.ts`, `app/e2e/translate-split.spec.ts`

**Interfaces:**

- Consumes: `verifySource` (Task 3), 분할 화면 열기 함수(Task 0 노트)
- Produces:
  - `function openTranslation(dir: string, source: SourceEntry): Promise<{ sourceTabId: string; outputTabId: string; hashStatus: 'ok' | 'changed' | 'missing' }>` 편집 가능 형식은 `source/`의 파일을 읽기 전용으로 왼쪽에, `output/`의 사본(없으면 만든다)을 오른쪽에 연다. PDF·스캔·이미지의 열기는 Task 11에서 한다.
  - `function setPaneHidden(side: 'left' | 'right', hidden: boolean): void` 숨겨도 탭의 위치와 스크롤을 유지한다.

- [ ] **Step 1: Write the failing test**

- `creates output copy once and reuses it on reopen` (사용자가 고친 사본을 덮어쓰지 않는다)
- `source pane rejects edit commands`
- `hash changed returns hashStatus changed and still opens the source copy`
- `hiding a pane keeps its scroll position after showing again`
- `output copy keeps the original extension`

e2e: 번역 시작 → 좌우 분할 → 왼쪽 숨김 → 다시 보임 → 왼쪽에서 글자 입력이 거부되는지 확인한다.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/shell/src/main/translate/open-translation.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

읽기 전용은 앱 수준에서 처리한다(OS 권한은 건드리지 않는다). 같은 문서 사본 두 칸의 저장 확인(결정 0037) 규칙과 부딪히지 않게, 원본 칸은 저장 명령 자체를 막는다. 원본 문서 엔진은 수정하지 않는다.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/shell/src/main/translate/open-translation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/shell e2e
git commit -m "feat(shell): split translation view with read-only source and hide toggle"
```

---

### Task 10: AI 맥락 자동 전달과 OCR(AI 읽기)

**Files:**

- Create: `app/apps/shell/src/main/translate/context-injection.ts`
- Create: `app/apps/shell/src/main/translate/ocr.ts`
- Modify: 프로젝트 폴더 기능의 지시문 주입 지점(Task 0 노트)
- Modify: AI 창의 항목 표시 부품(`packages/ui`의 해당 위치, Task 0 노트)
- Test: `context-injection.test.ts`, `ocr.test.ts` (같은 폴더)

**Interfaces:**

- Consumes: `composeContext` (Task 6), `loadGlossary` (Task 5), `loadProject`, `OcrMode` (Task 1)
- Produces:
  - `function buildTranslationInstructions(dir: string, paragraph: string): Promise<ComposedContext>` 앱 설정의 시스템 프롬프트를 읽어 `composeContext`에 넘긴다.
  - `type OcrSelection = { kind: 'all' } | { kind: 'pages'; pages: number[] }` (이미지 여러 장은 파일 순번을 `pages`로 쓴다. 번호는 1부터)
  - `function runOcr(args: { dir: string; source: SourceEntry; selection: OcrSelection; confirm: (count: number) => Promise<boolean> }): Promise<{ docxPath: string }>` `selection`이 `pages`이고 비어 있으면 `EmptyOcrSelectionError`를 던지고 AI를 부르지 않는다. 고른 페이지만 보내며 `confirm`에는 보낼 개수를 넘긴다. `ocr.kind === 'off'`면 AI를 부르지 않고 `OcrDisabledError`를 던진다. `ai`면 `confirm()`이 true일 때만 이미지를 제공자로 보낸다. 결과는 OCR로 읽은 글을 담은 Word 문서(`output/`)다.
  - AI 창에는 실린 항목(`items`)이 보인다.

- [ ] **Step 1: Write the failing test**

- `instructions include system prompt then project prompt then glossary`
- `no instructions are injected for a non-translation project folder` (일반 프로젝트 폴더의 동작을 바꾸지 않는다)
- `runOcr with off throws OcrDisabledError and never calls the provider`
- `runOcr never sends images when confirm resolves false`
- `runOcr sends only the selected pages and passes their count to confirm`
- `runOcr with selection all sends every page`
- `runOcr with an empty pages selection throws EmptyOcrSelectionError and never calls the provider`
- 선택 화면(`apps/shell/src/renderer/src/translate/OcrSelectDialog.tsx`)을 이 작업에 더한다. 페이지 체크박스, "전체 선택", "선택 해제", 선택 개수, 0개면 시작 단추 비활성. 테스트: `select all checks every page`, `start is disabled with zero selected`
- `runOcr uses the provider chosen in the project's OCR setting`
- `runOcr writes a docx into output/ and returns its path`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/shell/src/main/translate`
Expected: FAIL

- [ ] **Step 3: Implement**

OCR은 기존 AI 페이지 읽기의 호출 진입점을 재사용하고 새 모델 호출 경로를 만들지 않는다. `confirm`에는 기존 AI 페이지 읽기의 요금·전송 안내 확인 창을 연결한다. 이 경로에서 사용자가 고르지 않은 요금 경로가 쓰이지 않는지 테스트한다.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/shell/src/main/translate`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/shell packages
git commit -m "feat(shell): inject translation context and AI OCR"
```

---

### Task 11: PDF·스캔·이미지의 번역 결과

**Files:**

- Create: `app/apps/shell/src/main/translate/non-editable.ts`
- Modify: `app/apps/shell/src/main/translate/open-translation.ts` (Task 9)
- Test: `app/apps/shell/src/main/translate/non-editable.test.ts`

**Interfaces:**

- Consumes: `runOcr` (Task 10), PDF 번역 작업 엔진 진입점(Task 0 노트), `SourceEntry`
- Produces:
  - `function translateNonEditable(args: { dir: string; source: SourceEntry; bilingual: boolean; ocrSelection?: OcrSelection }): Promise<{ outputPath: string }>` `kind: 'pdf'`는 글자 층이 있으면 기존 번역 엔진으로 번역 PDF(`bilingual`이면 대역본)를 `output/`에 쓴다. 글자 층이 없는 PDF(`scan`)와 `image`는 `runOcr`로 만든 Word 문서를 `output/`에 두고 Task 9의 편집 화면으로 연다.
  - `function detectScan(pdfPath: string): Promise<boolean>` 페이지 대부분에 글자 층이 없으면 true.

- [ ] **Step 1: Write the failing test**

- `text PDF goes through the translation engine and writes into output/`
- `bilingual option selects the bilingual output`
- `scan PDF is routed to OCR then to an editable docx`
- `image file is routed to OCR`
- `OCR off on a scan returns a clear error instead of an empty document`
- `source file in source/ is unchanged afterwards` (해시 비교)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/shell/src/main/translate/non-editable.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`detectScan`은 기존 PDF 문서 나무의 글자 추출 결과에서 페이지별 글자 수를 쓴다(Task 0 노트에서 해당 함수 확인).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/shell/src/main/translate/non-editable.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/shell
git commit -m "feat(shell): translation output for PDF, scan and image sources"
```

---

### Task 12: 문구, 이름, 마무리 검사

**Files:**

- Modify: `app/packages/i18n/` 하위 문구 파일(21개 언어, Task 0 노트의 위치)
- Create: `app/apps/shell/src/renderer/src/i18n/translate/` 번역 화면 문구
- Modify: 도움말 주제 하나 추가("번역 프로젝트")
- Test: 기존 `tools/check-help-langs.mjs`

**Interfaces:**

- Consumes: Task 8, 9, 10의 문구 키

- [ ] **Step 1: Write the failing check**

Run: `node tools/check-help-langs.mjs` 와 `npm run check:no-genspark`
Expected: FAIL (새 문구 키가 일부 언어에 없음)

- [ ] **Step 2: 21개 언어를 모두 채운다**

한국어와 영어를 먼저 쓰고 나머지 언어는 같은 키로 번역한다. 제품 이름 정의 위치(`packages/i18n`)에서 `tandem office`를 한 곳에서만 정의한다.

- [ ] **Step 3: 전체 검사 실행**

`docs/standards.md`의 "합치기 전 검사" 전체를 실행한다.
Expected: 새로 생긴 실패 없음. 기준선(Task 0)에 있던 실패만 남는다.

- [ ] **Step 4: 손 확인 목록을 기록**

실제 구독으로 확인할 것(스캔 1쪽 OCR, 번역 한 문단)과 확인하지 못한 것을 `docs/superpowers/notes/manual-checks.md`에 적는다. 구독 한도를 쓰는 확인은 사용자 동의 후에만 한다.

- [ ] **Step 5: Commit**

```bash
git add apps packages tools docs
git commit -m "feat: translation project strings, help topic, final checks"
```

---

## Self-Review 결과

- 스펙 커버리지: 화면 3개(Task 8, 9), 자료 올리기·삭제(Task 5, 8), 프롬프트 두 종류(Task 6, 7, 8, 10), 분할·숨김(Task 9), 자동 맥락 전달과 항목 표시(Task 10), OCR 선택과 AI 전용(Task 1, 8, 10), PDF·스캔·이미지 결과(Task 11), 원본 보호(Task 3, 9), 단어집 규칙(Task 2, 6), 21개 언어(Task 12). 빠진 요구사항 없음.
- 알려진 한계: Task 0 이전에는 실제 파일 경로와 함수 이름이 추정이다. Task 7 이후의 `apps/shell`, `packages/ui` 경로는 Task 0 노트가 우선한다. 도구를 끈 구독 실행에서 앱 쪽 읽기 도구가 번역 요청에 닿지 않으면 Task 10에서 요청한 문단 관련 발췌를 지시문에 싣는 방식으로 바꾼다(스펙 7-1절의 대체안).
