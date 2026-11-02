import type { TranslateApi } from '../../../shared/translate-api'

declare global {
  interface Window {
    /** the translation tool's project bridge (src/preload/index.ts) */
    translateApi?: TranslateApi
  }
}

export {}
