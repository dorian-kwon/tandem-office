# Dự án dịch thuật

Một dự án dịch thuật gom các tài liệu bạn muốn dịch, tài liệu tham khảo và bảng thuật ngữ vào cùng một thư mục, và đưa cho AI cùng một hướng dẫn mỗi lần. AI giúp bạn dịch tài liệu Word và các tài liệu khác, đồng thời có thể dịch PDF văn bản thành một PDF mới.

## Một dự án gồm những gì

- **Nguồn**: các tài liệu cần dịch. Ứng dụng giữ bản sao riêng trong thư mục `source/` của dự án; tệp bạn đã chọn không bao giờ được mở hay thay đổi.
- **Tham khảo**: tài liệu bổ trợ như bản dịch trước đây hoặc hướng dẫn văn phong.
- **Bảng thuật ngữ**: những thuật ngữ luôn phải được dịch giống nhau.
- **Kết quả**: các bản dịch bạn viết, trong thư mục `output/` của dự án.

## Ba màn hình

1. **Danh sách dự án**: mở **Dịch thuật** ở thanh bên của Trang chủ. Tại đây bạn tạo, mở và xóa dự án, đồng thời viết prompt hệ thống chung áp dụng cho mọi dự án dịch thuật.
2. **Chi tiết dự án**: các ngôn ngữ, prompt của dự án (hướng dẫn bổ sung chỉ cho dự án này), danh sách tài liệu cần dịch, tài liệu tham khảo và bảng thuật ngữ, cùng lựa chọn để đọc các trang quét (OCR). **Mở bản dịch** ở một tài liệu sẽ bắt đầu công việc.
3. **Chế độ xem dịch**: bản sao nguồn ở bên trái và bản dịch của bạn ở bên phải, cạnh nhau. Khung nguồn chỉ đọc. **Ẩn bản nguồn** và **Ẩn bản dịch** nhường cả cửa sổ cho khung còn lại, và khung đó quay lại đúng vị trí cũ.

## Bảng thuật ngữ

- Thêm một tệp `.csv`, `.xlsx` hoặc `.txt` (với `.txt`, các cột được ngăn cách bằng tab). Mỗi hàng là một thuật ngữ.
- Các cột là thuật ngữ nguồn, bản dịch và, tùy chọn, ghi chú. Hàng đầu tiên chỉ bị bỏ qua khi nó đặt tên cho hai cột đầu (ví dụ source và target, hoặc term và translation); mọi hàng đầu tiên khác được đọc như một mục thuật ngữ.
- Tệp lưu dưới dạng UTF-16 (ví dụ "Văn bản Unicode" của Excel) được nhận ra. Các tệp khác được đọc dưới dạng UTF-8, và dưới dạng CP949 khi không phải UTF-8 hợp lệ, nên các tệp tiếng Hàn từ chương trình cũ hiển thị đúng.
- Tối đa 200 mục được gửi nguyên vẹn. Trên 200 mục, chỉ những mục có thuật ngữ nguồn xuất hiện trong văn bản đang dịch mới được gửi.

## Tệp tham khảo

- Khi bạn thêm tệp tham khảo, ứng dụng chuyển nó thành văn bản (lưu trong `references/.md/`; bản thân tệp không bao giờ bị thay đổi) và lập chỉ mục các từ. Các phần được chọn theo từ ngữ trong tin nhắn của bạn và văn bản đã chọn (trong bảng AI, một lần khi gửi) hoặc của lô văn bản đang dịch (trong cửa sổ PDF), và chỉ các phần đã chọn được gửi, tối đa 6.000 ký tự, cùng tên các tệp. Khi toàn bộ văn bản tham khảo không dài hơn mức đó, nó được gửi nguyên vẹn.
- Trong chi tiết dự án, mỗi tệp tham khảo hiển thị trạng thái: **Đã chuyển thành văn bản** (mở bằng **Xem văn bản đã chuyển đổi**, chỉ đọc), **Cần OCR** (bản quét hoặc hình ảnh: không gửi gì; hãy thêm nó làm tài liệu cần dịch, đọc bằng OCR rồi thêm tài liệu Word thu được làm tệp tham khảo) hoặc **Không đọc được**.
- Khi cần, AI có thể đọc tệp tham khảo thông qua các công cụ của dự án.

## PDF quét và hình ảnh (OCR)

- PDF quét hoặc hình ảnh chưa có văn bản để dịch, nên AI đọc chúng trước. Trong chi tiết dự án, chọn AI sẽ đọc: **AI (Claude)**, **AI (ChatGPT)** hoặc **Tắt**. Khi tắt, bản quét và hình ảnh không thể được mở để dịch.
- Bạn chọn các trang cần đọc, từng trang một hoặc bằng **Chọn tất cả**. Chỉ những trang đã chọn mới được đọc.
- Hình ảnh các trang chỉ được gửi cho AI sau khi bạn xác nhận ở màn hình kiểm tra, màn hình này cho biết sẽ gửi bao nhiêu trang và dùng AI nào. Việc này có thể dùng hạn mức gói của bạn, và kết nối trả phí được ghi rõ là trả phí trước khi gửi bất cứ thứ gì.
- Văn bản đọc được sẽ được lưu thành tài liệu Word trong thư mục kết quả. Hãy dịch tài liệu đó trong chế độ xem dịch bằng khung AI.
- Hỗ trợ hình ảnh PNG và JPEG. Không hỗ trợ hình ảnh GIF, BMP, TIFF và WebP, hình ảnh trên 20 MB và PDF có mật khẩu.
- Khi tài liệu hoặc tệp tham khảo có hình ảnh bên trong (Word, PowerPoint, Excel, OpenDocument, HWPX hoặc EPUB), phần chi tiết dự án hiển thị số hình ảnh bên cạnh tệp đó. Chữ bên trong các hình ảnh này không thuộc văn bản của tài liệu nên không được dịch và không được gửi. Muốn đọc chữ đó cần OCR, nhưng OCR chỉ đọc PDF quét và tệp ảnh, không đọc hình ảnh bên trong một tệp khác: hãy xuất hoặc sao chép các trang có hình ảnh thành ảnh PNG hoặc JPEG hoặc PDF quét, thêm nó làm tài liệu cần dịch rồi đọc bằng OCR. Hình ảnh rất nhỏ (dưới 2 KB, như dấu đầu dòng) và hình ảnh trong PDF không được đếm. Chỉ đếm hình ảnh được đặt trong nội dung: nền của trang chiếu cái và bố cục, phương tiện không dùng đến và bản xem trước phương trình không được đếm. Hoàn toàn không phát hiện được: PDF văn bản, các định dạng nhị phân cũ (doc, xls, ppt, hwp) và chữ vẽ bằng hình, WordArt hay SmartArt, nên không có thông báo không có nghĩa là tệp không có chữ trong hình ảnh.

## Dịch PDF

- PDF văn bản được dịch thành một PDF mới trong thư mục kết quả. Bạn cũng có thể chọn PDF song ngữ, với bản dịch nằm cạnh mỗi trang gốc.
- Màn hình kiểm tra cho biết số lần gọi AI và AI được dùng trước khi gửi bất cứ thứ gì. Việc dịch PDF văn bản dùng **AI được dùng** của toàn ứng dụng trong Cài đặt, còn OCR dùng AI được chọn trong dự án.
- Nếu dừng giữa chừng, **Ghi phần đã xong** lưu phần đã dịch. Khi mở lại tài liệu, nhấn **Tiếp tục** để chỉ gửi các khối còn lại.

## Giới hạn

- Các chỉnh sửa trong khung nguồn không thể lưu. Ở một số trình soạn thảo, bạn có thể gõ trong bộ nhớ, nhưng tệp trong `source/` không bị ghi.
- **Dịch lại** dịch toàn bộ từ đầu, nhưng giữ lại các khối bạn đã tự chỉnh sửa trong chế độ xem song ngữ của trình soạn thảo PDF.
- Tiếng Ả Rập, tiếng Do Thái và tiếng Hindi không thể là ngôn ngữ đích của PDF đã dịch.
- Cửa sổ để mở quá lâu sẽ hết hạn; hãy mở lại từ dự án.
