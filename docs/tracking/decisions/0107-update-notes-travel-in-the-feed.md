# 0107 업데이트 창의 릴리스 본문은 `latest.yml`에 실어 보낸다

## 맥락

결정 0044는 업데이트 창에 릴리스 본문을 보여 주기로 했고, 본문은 `electron-updater`의 GitHub provider가 `releases.atom`에서 이미 받아 오는 값(`info.releaseNotes`)을 쓰기로 했다. 그런데 그 뒤 앱은 비공개 저장소를 읽는 방식으로 바뀌었다(`updater.ts`의 `setFeedURL({ private: true, token })`, 토큰은 PC의 `gh` 로그인). 이 방식은 다른 provider(`PrivateGitHubProvider`)가 맡는다. 그 provider는 릴리스 API에서 파일 목록을 찾아 `latest.yml`을 읽어 그대로 돌려줄 뿐 본문(`body`)을 가져오지 않는다.

그래서 실제 업데이트에서는 `info.releaseNotes`가 늘 비어, 업데이트 창에 "성능 개선과 버그 수정이 포함되어 있습니다"라는 일반 문구만 떴다. 0.15.1 릴리스의 `latest.yml`에도 `releaseNotes`가 없다. 0044의 화면은 `GENOFFICE_FAKE_UPDATE`로만 확인했고 실제 릴리스로는 확인하지 않았다(0044의 "결과"가 그렇게 적고 있다). 사용자는 "업데이트를 확인했을 때 새 버전이 있으면 노트를 보여 주고, 할지 말지 물어 달라"고 했다. 묻는 쪽(지금 업데이트/나중에)은 이미 있었고, 노트가 비어 있던 것이 문제였다.

## 결정

**릴리스 본문을 빌드 때 `latest.yml`의 `releaseNotes`에 넣는다.** 앱은 이 파일을 그대로 받으므로 새 네트워크 요청도, 앱의 새 코드도 필요 없다. 이미 설치된 앱도 다음 업데이트부터 노트를 본다(앱은 `info.releaseNotes`를 이미 읽고 있다).

- Windows build 워크플로(`windows-build.yml`)가 릴리스 태그를 받은 실행에서, 패키징 검사 뒤 출처 증명 앞에 한 단계를 둔다. 릴리스의 렌더링된 본문(`gh api -H "Accept: application/vnd.github.html+json"` 의 `body_html`, atom 피드의 `content`와 같은 HTML)을 받아 `tools/release-feed-notes.mjs`로 `latest.yml` 끝에 `releaseNotes` 한 줄로 붙인다. 출처 증명은 `latest.yml`도 덮으므로 붙이는 일은 증명보다 먼저여야 한다.
- 값은 JSON 문자열(YAML의 큰따옴표 값)이다. 파일의 나머지는 바이트 그대로다. 설치 파일의 해시는 exe만 덮으므로 업데이트 검증에 영향이 없다.
- 본문은 한 버전의 것뿐이다. 여러 버전을 건너뛴 사용자는 최신 릴리스의 본문만 본다(0044가 하려던 건너뛴 버전 모음은 atom 피드가 있어야 가능했다). 릴리스 본문이 비어 있으면 파일을 바꾸지 않는다.
- 릴리스 본문은 워크플로를 돌리기 전에 최종본이어야 한다. 나중에 GitHub에서 본문을 고쳐도 업데이트 창의 노트는 `latest.yml`에 들어간 것 그대로다. 본문을 고쳤으면 워크플로를 다시 돌린다(`--clobber`로 같은 릴리스의 파일을 바꾼다).
- 손으로 만든 빌드(워크플로 없이)에는 노트가 없다. 그 경우 `tools/release-feed-notes.mjs`를 직접 돌린다(`docs/releasing.ko.md` 4번).

## 버린 대안

- **앱이 업데이트를 확인할 때 릴리스 API에서 본문을 따로 받기**: 이미 설치된 앱에는 그 코드가 없어 다음 업데이트(0.15.1 → 0.15.2)에서는 여전히 노트가 비고, 앱에 새 네트워크 요청과 토큰 사용처가 생긴다.
- **electron-builder의 `releaseInfo.releaseNotesFile`**: 빌드 시점의 파일 내용(Markdown)이 들어가 앱이 읽을 HTML이 아니다. 렌더링은 GitHub가 하는 것이 정확하고, 워크플로는 이미 릴리스가 먼저 공개된 뒤에 돈다.
- **GitHub provider(atom 피드)로 되돌리기**: 비공개 저장소를 읽으려면 토큰이 필요하고 atom 피드는 토큰을 받지 않는다.

## 결과

- `tools/release-feed-notes.mjs`(`withReleaseNotes`)와 시험 `apps/shell/tests/release-feed-notes.test.ts`: 다른 필드가 그대로인지, 앱의 `normalizeReleaseNotes`가 그 값을 읽는지, 본문이 없을 때 파일이 그대로인지, 이미 노트가 있거나 버전이 없으면 거절하는지.
- 실제 0.15.1 릴리스의 본문과 `latest.yml`로 한 번 합쳐, `js-yaml`로 읽은 값을 앱의 `normalizeReleaseNotes`가 노트로 읽는 것까지 확인했다. 설치된 앱의 업데이트 창에 실제로 뜨는지는 0.15.2를 올린 뒤 옛 버전에서 확인해야 한다.
- `docs/releasing.ko.md`, `apps/shell/AGENTS.md`, `docs/tracking/decisions/0044-update-notes-in-the-window.md`(이 결정을 가리키는 줄)를 고쳤다.
