Đánh dấu là user nào đã gửi kết bạn cho user nào
Tạo khi user gửi lời mời cho 1 user khác: userId bản thân, userId người muốn add, PENDING -> ACCEPTED/REJECTED, 
thời gian lúc gửi lời mời, thời gian hiện tại + 3 ngày để thể hiện cho thời gian PENDING
Nếu thời gian PENDING quá 3 ngày thì xóa đi để thể hiện hết hạn lời mời kết bạn
Khi chấp nhận thì sẽ tạo 1 bảng ghi ngược lại
Khi từ chối thì cập nhật status và expiresAt thành 1 ngày để chống spam add friend
{
  "PK": "usr_12345",
  "SK": "friend#usr_98765",
  "status": "PENDING",
  "createdAt": "2026-05-30T10:00:00Z",
  "expiresAt": 1717668000
}