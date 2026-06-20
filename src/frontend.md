khi người dùng đăng nhập, gọi get profile lấy thông tin người dùng về, lưu vào electron store mã hóa bằng safe storage, lưu vào redux và render ra từ redux

khi người dùng đổi tên, validate không đc để trống trường name mới đc gọi API update đưa name vào, thành công thì cập nhật tên mới thẳng vào redux và electron store (không cần gọi lại get profile).