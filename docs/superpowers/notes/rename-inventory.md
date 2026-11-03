# Rename inventory: IeumOffice / 이음오피스 → tandem office

The owner's request: "이음 오피스는 없애주고 tandem office라고 하자". The product is
now called `tandem office` (lowercase, two words, the same in every UI
language). This note records what was renamed, what was deliberately kept,
and why.

Starting point (`git grep -i "이음오피스\|ieumoffice"`, before the rename): 590
files, about 3,560 hits. 172 were `이음오피스`, about 1,050 `IeumOffice`, about
2,850 lowercase `ieumoffice`. Most lowercase hits are the terminal command,
the `.ieumoffice/` project folder, `~/.ieumoffice` and test fixtures, which
are contracts and stay. After the rename: about 490 files and about 3,020
hits, nearly all of them kept on purpose (see "Kept").

## One definition

`packages/i18n/src/product.ts` defines the name:

| Constant                  | Value               | Used for                                                                                                                                                             |
| ------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRODUCT_NAME`            | `tandem office`     | everything people see, the Electron app name, the app bundle and executable (`tandem office.app`, `tandem office.exe`), the userData folder, the default save folder |
| `PRODUCT_FILE_NAME`       | `tandem-office`     | installer files, Linux executable and packages, packaged package.json name, User-Agent, file names joined with `-`/`_` in UI strings                                 |
| `PRODUCT_ID_NAME`         | `TandemOffice`      | Windows ProgIds (`TandemOffice.WordDocument`), the registry key `Software\TandemOffice`, the Codex service name (`tandemoffice`)                                     |
| `LOCALIZED_PRODUCT_NAMES` | empty               | the Korean name `이음오피스` is gone; no language has its own name                                                                                                   |
| `USER_DATA_DIR_NAME`      | `tandem office`     | installed userData folder                                                                                                                                            |
| `DEV_USER_DATA_DIR_NAME`  | `tandem office-Dev` | unpacked (dev) userData folder                                                                                                                                       |

`brandText()` now maps a name joined with `-`/`_` (`GenOffice-Setup-<version>.exe`)
to `PRODUCT_FILE_NAME`, and other file or folder names (`GenOffice.exe`,
`Documents/GenOffice`) to `PRODUCT_NAME`. Dictionaries and help topics keep
writing `GenOffice`; the one literal `이음오피스` in a dictionary (shell
`strings.ts`, Korean AI start-up setting) became the `GenOffice` token.

## Renamed, by category

- **Display name.** Every HTML `<title>`, the update window's image alt text,
  the HWP plugin's memo author fallback, the shell's agent-skills bundle folder
  under `%LOCALAPPDATA%`, the tool `tools/trial-free-models.mjs`, the e2e trial
  spec. Window titles, menus, About, onboarding, tabs and help derive from
  `PRODUCT_NAME` and changed with it.
- **Build and installer identity** (`apps/shell/electron-builder.cjs`,
  `apps/shell/package.json`, `apps/shell/build/*`):
  - appId `io.github.pblsketch.ieumoffice` → `io.github.pblsketch.tandemoffice`
  - productName and package.json `description` → `tandem office`
  - packaged name (`extraMetadata.name`, updater cache folder) → `tandem-office`
  - `desktopName` / Linux desktop id → `tandem-office.desktop`
  - Linux `executableName`, deb/rpm `packageName` → `tandem-office`
  - artifacts: `tandem-office-Setup-<v>.exe` (and `-arm64`),
    `tandem-office-<v>-<arch>.dmg`, `tandem-office-<v>-<arch>-mac.zip`
    (the x64 zip now carries `-x64`), `tandem-office-<v>.AppImage`,
    `tandem-office_<v>_<arch>.deb`, `tandem-office-<v>.<arch>.rpm`
  - Windows ProgIds `IeumOffice.*` → `TandemOffice.*` (electron-builder,
    `src/main/default-app.ts`, `build/installer.nsh`), registry key
    `Software\IeumOffice` → `Software\TandemOffice`
  - Linux post-install/remove scripts: `/opt/tandem office` (quoted, it has a
    space), AppArmor profile `/etc/apparmor.d/tandem-office`, MIME file
    `tandem-office.xml`
  - CLI launchers start `tandem office.app` / `tandem office.exe` /
    `tandem-office` (Linux); `packages/cli/src/resources.ts` looks for the
    Linux binary `tandem-office`
  - CI workflows (`.github/workflows/*-build.yml`) check and upload the new
    file names
- **AI-facing identity.** User-Agent `tandem-office[/<version>]` (a space would
  split it into two product tokens), Codex client/service name `tandemoffice`
  and payload tag `<tandemoffice_payload>`, GitHub skill download User-Agent.
  Instructions to the model keep naming the product with `PRODUCT_NAME`.
- **Brand art.** `apps/shell/build/brand/logo-lockup.svg` (and its copy
  `apps/shell/src/renderer/src/assets/genoffice-logo.svg`) carried the
  wordmark "IeumOffice" as outlines. The wordmark is now "tandem office" set in
  Pretendard Bold (OFL, already shipped in `packages/ui/template-fonts`),
  converted to outlines with opentype.js (an existing dependency). The mark
  (the icon square) is unchanged. NOTICE names the new font.
- **CLI / MCP prose.** CLI messages already used `PRODUCT_NAME`. The agent skill
  `skills/ieumoffice/SKILL.md` prose says "tandem office" (version 2.73.4 →
  2.73.5). `packaging/cli/install.sh` messages.
- **Docs.** README.md, README.en.md (title, intro, install file names,
  lineage), PRIVACY.md, CONTRIBUTING.md, SECURITY.md, AGENTS.md = CLAUDE.md
  (first heading `# tandem office`, lineage sentence), module AGENTS.md files,
  docs/_.md, docs/plans/_.md, packages/cli/README.md, the slide pipeline guides,
  the release skill's prose, `docs/tracking/status.md` (the button name only),
  the translation spec and plan (the working name "tandem" → "tandem office").
- **NOTICE.** A "tandem office modifications" section (forked from
  IeumOffice); the trademark lines name tandem office; the brand-artwork
  section says the icon and mark were drawn for IeumOffice; the find-skills
  appended section is now "In tandem office".
- **Tests.** product-identity, i18n product tests, and every test whose
  expectation follows from the new names.

## Kept, and why

- **Upstream attribution and lineage.** LICENSE; NOTICE's GenOffice notice
  and its "IeumOffice modifications" section; README/NOTICE/AGENTS sentences
  that say tandem office is forked from IeumOffice; CONTRIBUTORS.md (the people
  who contributed to IeumOffice); the story section and the
  ieumoffice.com/story link (IeumOffice's author's account); vendor rhwp patch
  headers ("IeumOffice patch onto v0.8.7"); docx-engine test comments
  ("IeumOffice divergence").
- **Terminal command and its folders (compatibility contract,
  docs/contracts.md).** The command `ieumoffice`, launcher files
  `bin/ieumoffice` / `ieumoffice.cmd`, `/usr/bin/ieumoffice`, the home folder
  `~/.ieumoffice` (launcher record, audit log, skills), the project folder
  `.ieumoffice/` (instructions, memory, chats, project.json), the MCP server
  key `ieumoffice`, the app MCP server `ieumoffice-editor`, the local test tool
  `ieumoffice_probe`, Codex profiles `ieumoffice-agent` / `ieumoffice-probe`,
  the agent skill name and folder `skills/ieumoffice` (installed copies are
  matched by it), the reserved skill names, the CLI tarball
  `ieumoffice-cli_<v>_<os>-<arch>.tar.gz`, temp folder prefixes. Renaming any
  of these breaks installed skills, MCP configs and existing project folders.
- **Internal identifiers.** `@genoffice/*`, `GENOFFICE_*`, `genoffice`
  (CLAUDE.md rule 5), `IEUM_SOURCE_FILE`, `IEUM_RELEASE`, skill metadata keys
  `ieum-title` / `ieum-template`, CSS tokens `--ieum-dialog-*`, the C# namespace
  `IeumOffice.QuickLook`, CI artifact names `ieumoffice-mac` etc.,
  `.claude/skills/release-ieumoffice/` (folder name; its prose was updated),
  `.tandem/` project data (already this product's).
- **Document-embedded values (CLAUDE.md rule 4).** ODT export's
  `<meta:generator>IeumOffice</meta:generator>`
  (`packages/odt-engine/src/assemble/export/index.ts`), and the HWP/ODT test
  marker `이음오피스검증문단` (`tools/odt-hancom/marks.mjs`).
- **Update feed and site.** `publish` still points at the GitHub releases of
  `pblsketch/openoffice`; `PRODUCT_REPO_*`, `PRODUCT_WEBSITE`
  (`https://ieumoffice.com`) and `PRODUCT_CONTACT_EMAIL` are unchanged. No
  invented URLs.
- **History.** `docs/tracking/decisions/0*.md`, `decisions/index.md`,
  `findings.md`, the dated entries of `status.md`, `growth-history.json`,
  `growth-latest.json`, `tools/growth-*` and their tests (download counts of
  IeumOffice's releases), `apps/shell/resources/builtin-skills/builtin-skills.json`
  (`"source": "ieumoffice"`: where the skill was written).
- **Test fixtures that test coexistence or reserved names** (for example an
  older `IeumOffice.app` install that must be treated as another program, a
  user skill named `IeumOffice` that is reserved, ChatGPT agent-name fixtures).

## Needs the owner

- **New art.** The app icon (`apps/shell/build/brand/app-icon.svg`,
  `app-icon-small.svg` and everything `tools/gen-brand-assets.mjs` derives
  from them), the mark in the logo lockup and the AI button mark
  (`ai-mark.svg`, `packages/ui/src/AiMark.tsx`) are IeumOffice's art. The
  README's own redistribution section says IeumOffice's name and logo may not
  be used as another product's. They need tandem office art; the generator
  then rebuilds every icon. The wordmark set here is a plain interim one.
- **Release channel.** The update feed, the README download links and badges,
  "official downloads" (`pblsketch/openoffice` releases and ieumoffice.com) and
  the contact email are IeumOffice's. Auto-update and publishing under the new
  name need the owner's own repository and site.
- **Third-party registrations under the IeumOffice name.** The Google Drive
  OAuth client (consent screen) and the ChatGPT direct connection (decision 0081) were registered by IeumOffice; tandem office still uses them.
- **CLI command collision.** tandem office and an installed IeumOffice both
  register `ieumoffice`, `~/.ieumoffice` and the MCP key `ieumoffice` (the
  apps themselves no longer collide). Renaming the command is a separate
  decision.
