khi người dùng đăng nhập, gọi /get-profile lấy thông tin người dùng về, fe lưu thông tin vào electron store mã hóa bằng safe storage, lưu vào redux và update state để render ra màn hình từ dữ liệu của redux

mỗi khi đang 

có nút để ấn chỉnh sửa tên ở frontend, khi ấn đổi tên, validate giống với backend mới đc gọi API /update-profile, hàm trả về thành công thì backend sẽ trả 1 profile.json mới, frontend lưu đè vào electron store mã hóa bằng safe storage, lưu vào redux và update state để render ra màn hình từ dữ liệu của redux (không cần gọi lại get profile).

