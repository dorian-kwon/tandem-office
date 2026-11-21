import type { zh } from './zh'

export const vi = {
  title: 'Chuyển đổi tệp',
  chooseFiles: 'Chọn tệp',
  outputFormat: 'Định dạng đầu ra',
  convert: 'Chuyển đổi',
  converting: 'Đang chuyển đổi…',
  destinationHint:
    'Mỗi tệp sau khi chuyển đổi được lưu trong thư mục của tệp gốc. Nếu tên đã được dùng, tên tệp mới sẽ có thêm số.',
  noCommonFormat:
    'Các tệp đã chọn không có định dạng đầu ra chung. Hãy bỏ bớt tệp khỏi danh sách hoặc chọn tệp khác.',
  chooseFailed: 'Không thể mở cửa sổ chọn tệp.',
  convertFailed: 'Không thể hoàn tất việc chuyển đổi tệp.',
  saved: 'Đã lưu',
  failed: 'Chuyển đổi thất bại',
  removeFile: 'Bỏ {name} khỏi danh sách',
} satisfies Record<keyof typeof zh, string>
