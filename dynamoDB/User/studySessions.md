Khi bật focus -> gọi api tạo ra 1 bảng này, gửi sessionId về cho client để biết thuộc phiên nào
Khi hoàn thành hoặc bị nhắc 3 lần thì gọi hủy cùng sessionId để server kiểm tra và update
ExpiresAt update khi hoàn tất để bảng tự xóa sau 30 ngày
khi khởi tạo: userId, khởi tạo 1 sessionId mới, casual/rank, thời gian bắt đầu, null,
durationMinutes nếu là rank / null nếu là casual , PENDING -> COMPLETED/FAILED, null
{
    "PK": "usr_12345",
    "SK": "session#20260529T190000Z",
    "mode": "rank",
    "startTime": 1717009200,
    "endTime": 1717012800,
    "durationMinutes": 60,
    "status": "COMPLETED",
    "expiresAt": 1719601200
}