import type { Page } from '@playwright/test'

export async function readHangulText(page: Page): Promise<string> {
  return page
    .frameLocator('.hwp-editor-host iframe')
    .locator('body')
    .evaluate(async (body) => {
      const studio = (
        body.ownerDocument.defaultView as Window & {
          rhwpStudio: {
            plugins: {
              load(id: string): Promise<void>
              invoke(id: string, method: 'readText', args: []): Promise<string>
            }
          }
        }
      ).rhwpStudio
      await studio.plugins.load('ieum-agent')
      return studio.plugins.invoke('ieum-agent', 'readText', [])
    })
}
