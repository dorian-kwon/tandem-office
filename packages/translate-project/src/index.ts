export {
  ProjectFileError,
  defaultProjectFile,
  parseProjectFile,
  serializeProjectFile,
} from './project-file'
export type { OcrMode, ProjectFile, SourceEntry, SourceKind } from './project-file'
export { DEFAULT_GLOSSARY_LIMIT, parseGlossary, selectGlossary } from './glossary'
export type { GlossaryEntry } from './glossary'
export {
  UnsupportedSourceError,
  classifySource,
  copyIntoWithSuffix,
  importSource,
  verifySource,
} from './source-guard'
export {
  InvalidProjectNameError,
  NotAProjectError,
  ProjectExistsError,
  createProject,
  loadProject,
  projectStatus,
  removeProject,
  saveProject,
} from './project-store'
export {
  NotListedError,
  addGlossary,
  addReference,
  addSource,
  loadGlossary,
  removeGlossary,
  removeReference,
  removeSource,
} from './materials'
export { InvalidSourceKindError, setSourceKind } from './source-kind'
export { withProjectLock } from './project-lock'
export { composeContext } from './compose'
export type { ComposedContext, ComposedItemKind } from './compose'
