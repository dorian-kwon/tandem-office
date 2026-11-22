import { expect, it, vi } from 'vitest'
import { convertWithBundledCli } from '../src/main/file-conversion-ipc'
import type { CliRunner } from '../src/main/mcp/cli-runner'

vi.mock('electron', () => ({ dialog: {}, ipcMain: {} }))
vi.mock('@genoffice/electron-utils', () => ({ showOpenDialogWithMemory: vi.fn() }))

it('shows the localized page outcomes reported by the bundled PDF converter', async () => {
  const cli: CliRunner = {
    run: vi.fn().mockResolvedValue({
      ok: true,
      json: {
        status: 'ok',
        warnings: [
          { code: 'pdf_ocr_pages', message: 'recognized', pages: [2, 4] },
          { code: 'pdf_image_pages', message: 'saved as image', pages: [5] },
          { code: 'pdf_skipped_pages', message: 'no cells', pages: [6] },
        ],
      },
    }),
  }
  const warning = await convertWithBundledCli(cli, 'scan.pdf', 'xlsx', 'output.xlsx', 'ko')
  expect(cli.run).toHaveBeenCalledWith(
    ['convert', 'scan.pdf', '--to', 'xlsx', '--out', 'output.xlsx', '--optimize-images'],
    expect.anything(),
  )
  expect(warning).toContain('2, 4쪽 이미지에서 OCR로 글자를 인식했습니다.')
  expect(warning).toContain('5쪽은 이미지로 저장했습니다.')
  expect(warning).toContain('6쪽은 셀로 변환할 수 없었습니다.')
})
