4. Luồng Minigame & Cửa hàng (Giải trí)
Dashboard -> Hub Minigame -> Màn hình Chơi Game (Sudoku/Minesweeper) -> Kết quả & Bảng Xếp Hạng -> Cửa hàng (Trong cửa hàng có nhiều tab cho từng Shop khác nhau: Shop mua bằng ngọc, Shop mua bằng đá,...) 

Thông tin / Logic cần:

Vào Game: Trừ Xu trong ví. Server lưu giá trị tiền mới sau đó tạo và trả về 1 Seed (bản đồ/đề bài) của level màn chơi đó.

Đang chơi: Client lưu lại chuỗi thao tác (log). Nếu User tự bấm thoát -> API hoàn lại 75% Xu.

Thắng Game: Client gửi Seed + Chuỗi thao tác + Thời gian lên Lambda. Lambda tính toán nhanh xem thao tác có hợp lệ không. Nếu hợp lệ -> Cấp Đá và tính Điểm theo Level (trần điểm từng Level để tránh tràn số). Sau đó cộng điểm của level đó vào tổng của User, điểm trên bảng xếp hạng của minigame là tổng điểm các màn của minigame đó, chưa chơi là 0. Màn chơi sẽ có màn free và màn cần xu để mở màn, mở màn rồi sẽ là vĩnh viễn, User lưu lại danh sách các màn đã mở của minigame đó khi mở minigame đó lên.

Bảng Xếp Hạng: Filter và hiển thị điểm của danh sách bạn bè của minigame đó.