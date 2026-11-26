import type { Plugin } from 'vite'

export type RhwpPatchName =
  | 'sdk-scheme'
  | 'sdk-edit-ack'
  | 'studio-replacement-history'
  | 'studio-textbox-edit-mouse'
  | 'studio-textbox-edit-picture'
  | 'studio-textbox-edit-keyboard'
  | 'studio-textbox-edit-handler'
  | 'studio-textbox-edit-cursor'
  | 'studio-scheme'
  | 'studio-password-flag'
  | 'studio-plugin-allow'
  | 'studio-table-delete-at'
  | 'studio-nested-table-delete'
  | 'studio-nested-table-cut'
  | 'studio-nested-table-command'
  | 'studio-nested-table-dispatch'
  | 'studio-nested-table-path-calls'
  | 'studio-nested-table-keys'
  | 'studio-textbox-table-cell-block'
  | 'studio-textbox-table-context-menu'
  | 'studio-nested-table-move-drag'
  | 'studio-format-copy-safety'
  | 'studio-pc-font-metadata'
  | 'studio-pc-fonts'
  | 'studio-wheel-zoom'
  | 'studio-format-copy'
  | 'studio-format-copy-state'
  | 'studio-memo-command'
  | 'studio-memo-label-ko'
  | 'studio-memo-label-en'

export declare const APP_SCHEME: string
export declare const PASSWORD_FLAG: 'passwordProtected'
export declare const AGENT_PLUGIN_MODULE: string
export declare const TEXTBOX_EDIT_MODULE: string
export declare const WHEEL_ZOOM_MODULE: string
export declare const FORMAT_COPY_MODULE: string
export declare const STUDIO_PATCHES: readonly RhwpPatchName[]
export declare function patchTargets(name: RhwpPatchName, file: string): boolean
export declare function applyPatch(name: RhwpPatchName, code: string): string
export declare function rhwpPatches(...names: RhwpPatchName[]): Plugin
