export {
  ProjectFileError,
  defaultProjectFile,
  parseProjectFile,
  serializeProjectFile,
} from './project-file'
export type { OcrMode, ProjectFile, SourceEntry, SourceKind } from './project-file'
export {
  DEFAULT_GLOSSARY_LIMIT,
  GlossaryFormatError,
  parseGlossary,
  selectGlossary,
} from './glossary'
export type { GlossaryEntry } from './glossary'
export {
  EDITABLE_SOURCE_EXTENSIONS,
  IMAGE_SOURCE_EXTENSIONS,
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
  refreshReferences,
  removeGlossary,
  removeReference,
  removeSource,
} from './materials'
export {
  InvalidSourceKindError,
  SourceChangedError,
  SourceKindChosenError,
  chosenSourceKind,
  setSourceKind,
} from './source-kind'
export type { SetSourceKindOptions } from './source-kind'
export type { ReferenceOptions } from './materials'
export {
  PDF_TEXT_MIN_CHARS,
  REFERENCE_IMAGE_EXTENSIONS,
  REFERENCE_TEXT_EXTENSIONS,
  convertReferenceToMarkdown,
  htmlToMarkdown,
} from './reference-md'
export type { ReferenceConversion, ReferenceExtract, ReferenceExtractResult } from './reference-md'
export {
  DEFAULT_REFERENCE_CHARS,
  REFERENCE_CHUNK_CHARS,
  REFERENCE_INDEX_FILE,
  REFERENCE_MD_DIR,
  chunkMarkdown,
  queryReferences,
  readConvertedReference,
  referenceStatuses,
  syncReferenceIndex,
  tokenize,
} from './reference-index'
export type { ReferenceChunk, ReferenceConverter, ReferenceStatus } from './reference-index'
export { withProjectLock } from './project-lock'
export { composeContext } from './compose'
export type { ComposedContext, ComposedItemKind } from './compose'
