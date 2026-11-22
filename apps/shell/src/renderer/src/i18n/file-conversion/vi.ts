import type { zh } from './zh'

export const vi = {
  ocrLanguage: 'Ngôn ngữ nhận dạng',
  ocrLanguageDefault: 'Mặc định của hệ thống',
  ocrLanguageUnavailable:
    'Ngôn ngữ đã chọn không khả dụng. Hãy chọn ngôn ngữ khác hoặc cài đặt ngôn ngữ này trên thiết bị.',
  ocrTitle: 'Nhận dạng ký tự',
  ocrBatch: 'Chạy OCR hàng loạt',
  ocrPdf: 'PDF có thể tìm kiếm',
  ocrWord: 'Word có thể chỉnh sửa',
  ocrRunning: 'Đang nhận dạng văn bản…',
  ocrNoText: 'Không tìm thấy văn bản đọc được.',
  ocrUnavailable: 'Thiết bị này không hỗ trợ OCR cục bộ.',
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
  ocrRange: 'Trang cần nhận dạng',
  ocrAllPages: 'Tất cả các trang',
  ocrRangeInvalid: 'Kiểm tra phạm vi trang của tệp này. Ví dụ: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
