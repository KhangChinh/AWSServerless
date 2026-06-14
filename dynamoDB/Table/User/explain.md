*table User:
mỗi profile.json chứa thông tin tổng quát và đại diện cho 1 user
1 profile.json sẽ được tạo khi user đã verify cognito thành công

*chi tiết thuộc tính:
-PK: mã người dùng lấy từ userId của cognito
-information:
    +name: tên của user, lấy từ thuộc tính name của cognito
    +email: email của user, lấy từ thuộc tính email của cognito
    +avatarUrl: ảnh của user, lưu object key ảnh của cloudfront (vd: avatars/userId/timestamp.jpg, khi load ảnh sẽ gộp cùng phần đầu link trong env)
-budget:
    +knowledgePoint: tiền tệ kiếm được từ thời gian học, sử dụng để đổi knowledgeCore hoặc để mở khóa các màn game mới (khi mới tạo: 1500)
    +knowledgeCore: sử dụng để gacha trong banner, đổi với tỉ lệ 150 knowledgePoint được 1 knowledgeCore (khi mới tạo: 0)
    +sanity: vật phẩm rarity = 3 trong banner, ra từ 50-80 điểm nếu trúng, sử dụng để chơi 1 màn game đã sở hữu (khi mới tạo: 0)
    +eCoin: tiền tệ kiếm được từ hoàn thành 1 màn game, sử dụng để mua vật phẩm giới hạn thời gian trong cửa hàng (khi mới tạo: 0)
-studyStats:
    +rankScore: điểm xếp hạng nhận từ việc hoàn thành hoặc mất khi thất bại trong ranked study, frontend sẽ dựa vào điểm để render bậc hạng của user (khi mới tạo: 0)
    +streak: chuỗi ngày học tập của user, nhận được khi user hoàn thành học tập ít nhất 30 phút mỗi ngày (khi mới tạo: 0)
    +lastFocusDate: ngày học tập gần nhất của user, dùng để xác định hôm qua có học hay không để + streak (khi mới tạo: 0) số = Math.floor( (Timestamp_Mili_Seconds + Múi_giờ_offset) / 86400000 )
-gachaStats:
    +pity4Star: pity để đảm bảo user nhận được vật phẩm rarity = 4 trở lên, mỗi 10 lần sẽ luôn đảm bảo được 1 lần (khi mới tạo: 0)
    +pity5Star: pity để đảm bảo user nhận được vật phẩm rarity = 5, mỗi 80 lần sẽ luôn đảm bảo được 1 lần (khi mới tạo: 0)
    +is4StarGuaranteed: nếu ra vật phẩm có rarity = 4 có type không phải là limited sẽ chuyển sang true, khi là true thì khi ra sẽ đảm bảo là isLimited = true (khi mới tạo: false)
    +is5StarGuaranteed: nếu ra vật phẩm có rarity = 5 có type không phải là limited sẽ chuyển sang true, khi là true thì khi ra sẽ đảm bảo là isLimited = true (khi mới tạo: false)
-equippedCosmetics:
    +equippedTheme: chủ đề hiện đang sử dụng của user, lưu SK của item.json trong table ItemData và tìm kiếm theo itemType = theme, không thể null (khi mới tạo: default_dark)
    +equippedFrame: khung hiện đang sử dụng của user, lưu SK của item.json trong table ItemData và tìm kiếm theo itemType = frame, khi null tức là không có trang bị khung (khi mới tạo: null)
    +equippedTitles: danh sách title mà user chọn hiển thị trên profile (tối đa 3), lưu danh sách SK của item.json trong table ItemData và tìm kiếm theo itemType = title, là 1 danh sách rỗng nếu không chọn hiển thị title nào (khi mới tạo: [])
-inventoryUpdatedAt: lưu lại thời gian lần cuối cùng nhận vật phẩm trong inventory, client sẽ dựa vào dữ liệu này để quyết định có nên gọi lấy inventory mới nhất của user về hay không (khi mới tạo: lấy date = now)
-avatarUpdatedAt: lưu lại thời gian lần cuối cùng người dùng cập nhật avatar (không cho cập nhật avatar ít nhất 10 phút tiếp theo)
-createdAt: lưu ngày tạo tài khoản của user (khi mới tạo: lấy date = now)
-updatedAt: lưu thời gian cập nhật các trường trừ inventoryUpdatedAt, dùng để khi user gọi 1 hàm update dữ liệu trong thì sẽ kiểm tra updatedAt cũ với mới, nếu không trùng thì từ chối update và trả về profile.json mới nhất để client cập nhật lại dữ liệu mới, frontend cũng sẽ dựa vào updatedAt trên client và server để quyết định có nên gọi hàm load dữ liệu user hay không (khi mới tạo: lấy date = now)