import { expect, type Locator, type Page } from '@playwright/test'

export async function openBatchSelection(page: Page): Promise<Locator> {
  await page.getByTestId('project-batch-start').click()
  const dialog = page.getByTestId('project-batch-select')
  await expect(dialog).toBeVisible()
  return dialog
}

export async function submitBatchSelection(page: Page): Promise<Locator> {
  await page.getByTestId('project-batch-select').getByTestId('project-batch-submit').click()
  const dialog = page.getByTestId('project-batch-progress')
  await expect(dialog).toBeVisible()
  return dialog
}

export async function startBatchWithFiles(page: Page, files: readonly string[]): Promise<Locator> {
  const dialog = await openBatchSelection(page)
  await dialog.getByRole('checkbox', { name: 'Select all', exact: true }).uncheck()
  for (const file of files) {
    await dialog.getByRole('checkbox', { name: file, exact: true }).check()
  }
  return submitBatchSelection(page)
}

export function batchRow(dialog: Locator, file: string): Locator {
  return dialog.locator('[data-batch-file=' + JSON.stringify(file) + ']')
}
