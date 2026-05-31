1. Luồng Xác thực & Khởi tạo (Auth & Init Flow)
Load app -> Màn hình Đăng nhập/Đăng ký (AWS Cognito) -> Dashboard

Thông tin / Logic cần:

Khi mở app: Kiểm tra token trong electron-store (đã mã hóa bằng safe storage). Nếu có, làm mới (refresh) token qua Cognito -> Lưu thông tin user vào Redux -> Đẩy thẳng vào Dashboard. Nếu không có -> Mở màn Đăng nhập. (đã hoàn thành)

Đăng ký: Cognito verify thành công -> Kích hoạt Lambda Trigger (InitUser) -> Ghi dữ liệu khởi tạo (userid, name, email, createdat, updatedat) vào DynamoDB. (đã hoàn thành)

2. Luồng Học tập
Dashboard -> Màn hình Chọn Chế độ học tập (Casual / Rank) -> Pop-up Đồng hồ đã học được nếu là casual / Đồng hồ đếm ngược nếu là rank  -> Màn hình Tổng kết -> Dashboard

Thông tin / Logic cần:

Bắt đầu: Gọi Lambda start_session, tạo và lưu timestamp bắt đầu ở aws lưu vào DB. Bật AI Focus Engine để chặn web và app.

Pop-up: Giao diện đếm ngược đơn giản (có thể tùy chỉnh theo theme đã sở hưu của user), luôn nổi trên cùng (Always on top). Có nút "Dừng" (nếu là Casual / nếu là Rank thì phải xác nhận mất điểm).

Kết thúc / Cưỡng chế: Gửi API end_session kèm theo log cảnh báo (nếu AI phát hiện vi phạm). Server (Lambda) sẽ lấy timestamp kết thúc trừ đi lúc bắt đầu để xác thực (Zero-Trust).

Casual: Kiểm tra đủ 30 phút chưa (nếu chưa -> Block mở lại trong 30 phút). Cộng tiến độ cho Nhiệm vụ ngày.

Rank: Nếu thoát giữa chừng hoặc vi phạm 3 lần -> Bị trừ điểm hạng. Hoàn thành đủ 1 tiếng -> Server cộng điểm hạng, cập nhật chuỗi (streak). Điểm hạng reset mỗi 30 ngày.

Phần vi phạm cần phải làm sao để tối ưu không gửi quá nhiều request lên server

3. Luồng Nhiệm vụ & Gacha (Quest & Roll Flow)
Dashboard -> Màn hình Nhiệm vụ Ngày -> Màn hình Gacha -> Màn hình Kết quả Roll

Thông tin / Logic cần:

Nhiệm vụ Ngày: Pull 4 nhiệm vụ từ DB pool (1 cố định: Học 30 phút, 3 ngẫu nhiên). Reset tiến độ lúc 3h00 sáng. Hoàn thành -> Gửi API nhận Ngọc. Đủ 4 nhiệm vụ -> Tặng quà phụ.

Gacha: 160 Ngọc = 1 Roll. Gọi API Roll. Server xử lý logic Pity trừ tiền trong DB của User và lưu phần thưởng và túi của User (10 roll = 4 Sao, 90 roll = 5 Sao).

Kết quả: Server trả về phần thưởng hiện lên màn hình (thấp nhất là Xu, hoặc vật phẩm/khung/theme). Giao diện hiển thị animation.

4. Luồng Minigame & Cửa hàng (Giải trí)
Dashboard -> Hub Minigame -> Màn hình Chơi Game (Sudoku/Minesweeper) -> Kết quả & Bảng Xếp Hạng -> Cửa hàng (Trong cửa hàng có nhiều tab cho từng Shop khác nhau: Shop mua bằng ngọc, Shop mua bằng đá,...) 

Thông tin / Logic cần:

Vào Game: Trừ Xu trong ví. Server lưu giá trị tiền mới sau đó tạo và trả về 1 Seed (bản đồ/đề bài) của level màn chơi đó.

Đang chơi: Client lưu lại chuỗi thao tác (log). Nếu User tự bấm thoát -> API hoàn lại 75% Xu.

Thắng Game: Client gửi Seed + Chuỗi thao tác + Thời gian lên Lambda. Lambda tính toán nhanh xem thao tác có hợp lệ không. Nếu hợp lệ -> Cấp Đá và tính Điểm theo Level (trần điểm từng Level để tránh tràn số). Sau đó cộng điểm của level đó vào tổng của User, điểm trên bảng xếp hạng của minigame là tổng điểm các màn của minigame đó, chưa chơi là 0. Màn chơi sẽ có màn free và màn cần xu để mở màn, mở màn rồi sẽ là vĩnh viễn, User lưu lại danh sách các màn đã mở của minigame đó khi mở minigame đó lên.

Bảng Xếp Hạng: Filter và hiển thị điểm của danh sách bạn bè của minigame đó.

Cửa hàng: 2 Tab. Tab 1 (Dùng Đá) mua vật phẩm hạn giờ. Tab 2 (Dùng Ngọc) mua vật phẩm vĩnh viễn.

5. Luồng Xã hội & Cá nhân hóa (Social & Profile)
Dashboard -> Profile Cá nhân (Setting) <-> Danh sách Bạn bè -> Profile Bạn bè

Thông tin / Logic cần:

Profile: Trạng thái Streak, Hạng học tập, Hạng Minigame. Chức năng thay đổi Theme app / Khung / Avatar.

Đổi Avatar: Client gọi API xin quyền upload -> Lambda trả về S3 Pre-signed URL (Hết hạn trong 5 phút) -> Client bắn file trực tiếp lên S3. Ảnh sau đó được phân phối tốc độ cao qua CloudFront.

Bạn bè: Thêm/Xóa bạn. Dữ liệu chỉ đọc (Read-only) khi xem Profile của người khác.