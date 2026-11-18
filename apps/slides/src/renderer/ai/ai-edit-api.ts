import { aiEditUndoHistoryEnabled } from '@genoffice/ui'
import type { AiEditMethod, SlidesApi } from '../../shared/ipc'

/** Read the live preference at each commit, including delayed image operations. */
export function aiEditApi(): Pick<SlidesApi, AiEditMethod> {
  return new Proxy({} as Pick<SlidesApi, AiEditMethod>, {
    get:
      (_target, method: AiEditMethod) =>
      (...args: unknown[]) =>
        window.slidesApi.aiEdit(method, args as never, aiEditUndoHistoryEnabled()),
  })
}
