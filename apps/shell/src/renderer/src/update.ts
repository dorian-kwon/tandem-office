import type {
  UpdateNoteBlock,
  UpdateNoteRun,
  UpdateUiState,
  UpdateWindowApi,
} from '../../shared/update-api'

// exposed by src/preload/update.ts
const api = (window as unknown as { aiOfficeUpdate: UpdateWindowApi }).aiOfficeUpdate

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const headline = el('headline')
const verCurrent = el('ver-current')
const verNew = el('ver-new')
const verArrow = el('version-arrow')
const desc = el('desc')
const progress = el('progress')
const bar = el('bar')
const progressText = el('progress-text')
const percentText = el('percent')
const action = el('action') as HTMLButtonElement
const versionToggle = el('version-toggle') as HTMLButtonElement
const versionPicker = el('version-picker')
const versionOptions = el('version-options')
const versionStatus = el('version-status')
const actionGroup = el('action-group')
const later = el('later') as HTMLButtonElement
const notes = el('notes')
const notesLabel = el('notes-label')
const notesBox = el('notes-box')
const notesMore = el('notes-more') as HTMLButtonElement

let phase: UpdateUiState['phase'] = 'available'
let state: UpdateUiState | null = null
let pickerGeneration = 0

function closeVersions(restoreFocus = false): void {
  pickerGeneration += 1
  versionPicker.hidden = true
  versionToggle.setAttribute('aria-expanded', 'false')
  versionOptions.replaceChildren()
  if (restoreFocus) versionToggle.focus()
}

function showVersionStatus(message: string): void {
  versionStatus.textContent = message
  versionStatus.hidden = !message
}

async function openVersions(): Promise<void> {
  const strings = state?.recentVersions
  if (!state || !strings) return
  const installed = state.currentVersion
  const generation = ++pickerGeneration
  versionToggle.setAttribute('aria-expanded', 'true')
  versionPicker.hidden = false
  showVersionStatus(strings.loading)
  let versions
  try {
    versions = await api.listVersions()
  } catch {
    versions = null
  }
  if (generation !== pickerGeneration) return
  showVersionStatus(versions === null ? strings.failed : versions.length ? '' : strings.empty)
  for (const { version } of versions ?? []) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = version === installed ? `v${version} · Current` : `v${version}`
    button.disabled = version === installed
    if (button.disabled) button.setAttribute('aria-current', 'true')
    button.addEventListener('click', async () => {
      for (const option of versionOptions.querySelectorAll('button')) option.disabled = true
      let result
      try {
        result = await api.selectVersion(version)
      } catch {
        result = 'unavailable'
      }
      if (generation !== pickerGeneration) return
      if (result === 'selected') closeVersions(true)
      else {
        for (const option of versionOptions.querySelectorAll('button')) {
          option.disabled = option.hasAttribute('aria-current')
        }
        showVersionStatus(strings.failed)
        button.focus()
      }
    })
    versionOptions.append(button)
  }
  versionOptions.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
}

/** draws the release notes from the pre-converted block tree; text nodes only, never HTML */
function renderNotes(state: UpdateUiState): void {
  const releaseNotes = state.releaseNotes
  const present = releaseNotes !== null && releaseNotes.sections.length > 0
  notes.style.display = present ? 'flex' : 'none'
  notesBox.replaceChildren()
  if (releaseNotes === null || !present) return

  notesLabel.textContent = state.strings.notesLabel
  notesBox.setAttribute('aria-label', state.strings.notesLabel)
  notesMore.textContent = state.strings.notesOnGitHub

  const showVersions = releaseNotes.sections.length > 1
  for (const section of releaseNotes.sections) {
    if (showVersions && section.version !== null) {
      const version = document.createElement('div')
      version.className = 'nl-ver'
      version.textContent = `v${section.version}`
      notesBox.appendChild(version)
    }
    for (const block of section.blocks) notesBox.appendChild(blockNode(block))
  }
  if (releaseNotes.truncated) {
    const truncated = document.createElement('div')
    truncated.className = 'nl-trunc'
    truncated.textContent = state.strings.notesTruncated
    notesBox.appendChild(truncated)
  }
}

function blockNode(block: UpdateNoteBlock): HTMLElement {
  if (block.kind === 'list') {
    const list = document.createElement(block.ordered ? 'ol' : 'ul')
    for (const item of block.items) {
      const li = document.createElement('li')
      appendRuns(li, item)
      list.appendChild(li)
    }
    return list
  }
  const node = document.createElement(block.kind === 'heading' ? 'div' : 'p')
  if (block.kind === 'heading') node.className = 'nl-h'
  appendRuns(node, block.runs)
  return node
}

function appendRuns(parent: HTMLElement, runs: UpdateNoteRun[]): void {
  for (const run of runs) {
    let node: Node = document.createTextNode(run.text)
    if (run.code === true) {
      const code = document.createElement('code')
      code.appendChild(node)
      node = code
    }
    if (run.strong === true) {
      const strong = document.createElement('strong')
      strong.appendChild(node)
      node = strong
    }
    parent.appendChild(node)
  }
}

function render(next: UpdateUiState): void {
  const changingVersion = state?.version !== next.version
  const returningFromPicker = changingVersion && !versionPicker.hidden
  if (state && (changingVersion || next.phase !== state.phase)) closeVersions()
  state = next
  phase = state.phase
  const s = state.strings
  const downloadLabel = state.selectedVersion
    ? (state.recentVersions?.install ?? s.download)
    : s.download

  document.documentElement.lang = state.lang
  document.title = s.title
  headline.textContent = state.selectedVersion
    ? (state.recentVersions?.install ?? s.headline)
    : s.headline
  verCurrent.textContent = `v${state.currentVersion}${state.recentVersions ? ' · Current' : ''}`
  verNew.textContent = `v${state.version}`
  verNew.hidden = verArrow.hidden = phase === 'current'
  actionGroup.hidden = phase === 'downloading'
  action.disabled = phase === 'current'
  versionToggle.hidden = !state.recentVersions || phase === 'downloading' || phase === 'downloaded'
  actionGroup.classList.toggle('split', !versionToggle.hidden)
  if (returningFromPicker && state.selectedVersion) action.focus()
  if (state.recentVersions) {
    versionToggle.setAttribute('aria-label', state.recentVersions.label)
    versionToggle.title = state.recentVersions.label
    versionPicker.setAttribute('aria-label', state.recentVersions.label)
  }
  later.textContent = s.later

  const hasNotes = state.releaseNotes !== null && state.releaseNotes.sections.length > 0
  renderNotes(state)
  // the notes take the generic line's place; failure and manual guidance
  // always stay (their text explains what to do)
  desc.style.display = hasNotes ? 'none' : ''
  desc.classList.toggle(
    'error',
    state.phase === 'error' || state.phase === 'manual' || state.phase === 'install-failed',
  )
  // in the manual phase the main button already opens the same release page
  notesMore.style.display = state.phase === 'manual' ? 'none' : ''

  switch (state.phase) {
    case 'current':
      progress.style.display = 'none'
      desc.style.display = 'none'
      action.style.display = ''
      action.textContent = s.download
      break
    case 'available':
      desc.textContent = s.desc
      if (state.selectedVersion) desc.style.display = 'none'
      progress.style.display = 'none'
      action.style.display = ''
      action.textContent = downloadLabel
      break
    case 'downloading': {
      desc.textContent = s.desc
      progress.style.display = 'flex'
      action.style.display = 'none'
      const pct = Math.max(0, Math.min(100, Math.round(state.percent)))
      bar.style.width = `${pct}%`
      progressText.textContent = s.downloading
      percentText.textContent = `${pct}%`
      break
    }
    case 'downloaded': {
      // say what the restart does before it happens: an installer window (and
      // its administrator prompt), then the app and its documents come back
      const restartDesc = state.visibleInstall ? s.visibleInstallDesc : s.restartDesc
      desc.textContent = restartDesc || s.desc
      if (restartDesc) desc.style.display = ''
      progress.style.display = 'none'
      action.style.display = ''
      action.textContent = s.install
      break
    }
    case 'install-failed':
      desc.textContent = s.installFailedDesc
      desc.style.display = ''
      progress.style.display = 'none'
      action.style.display = ''
      action.textContent = downloadLabel
      break
    case 'error':
      desc.textContent = s.failed
      desc.style.display = ''
      progress.style.display = 'none'
      action.style.display = ''
      action.textContent = s.retry
      break
    case 'manual':
      desc.textContent = s.manualDesc
      desc.style.display = ''
      progress.style.display = 'none'
      action.style.display = ''
      action.textContent = s.openDownload
      break
  }
}

action.addEventListener('click', () => {
  if (phase === 'downloaded') api.install()
  else if (phase === 'manual') api.openDownload()
  else api.download()
})
versionToggle.addEventListener('click', () => {
  if (versionPicker.hidden) void openVersions()
  else closeVersions()
})
document.addEventListener('pointerdown', (event) => {
  if (!versionPicker.hidden && event.target instanceof Node && !actionGroup.contains(event.target))
    closeVersions()
})
document.addEventListener('keydown', (event) => {
  if (versionPicker.hidden) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeVersions(true)
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const buttons = [...versionOptions.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (!buttons.length) return
    event.preventDefault()
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      index < 0
        ? 0
        : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
    buttons[next]?.focus()
  }
})
later.addEventListener('click', () => api.later())
notesMore.addEventListener('click', () => api.openDownload())

api.onState(render)
void api.getState().then((state) => {
  if (state) render(state)
})
