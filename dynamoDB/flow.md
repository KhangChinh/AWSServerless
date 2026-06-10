-khi người dùng đăng ký tài khoản (name, email, password) sẽ được aws cognito gửi mã xác thực về gmail, sau khi người dùng nhập đúng mã xác thực thì aws lambda sẽ trigger 1 PostConfirmation để lấy thông tin người dùng đó từ congito và khởi tạo 1 [profile](Table/User/profile.json) cho người dùng.

-mọi thao tác từ người dùng đến server đều phải được xác thực đúng người dùng thực hiện thao tác, khi react gửi request cho api gateway phải gửi kèm header có bearer access token, mọi hàm trên lambda đều phải có code kiểm tra authorize và lấy userId từ đó ra chứ không nhận userId từ client

-khi người dùng đăng nhập vào app:
    +cognito trả về refresh token và access token để sử dụng, refresh token sẽ được mã hóa và lưu vào electron-safe-storage
    +gọi api lấy thông tin người dùng, đồng thời lưu vào electron-store ko mã hóa và redux,
    +gọi api lấy thông tin túi đồ của người dùng, server lấy tất cả item trong table inventory thuộc userId đó gộp ra danh sách trả về client, client lưu vào electron-store ko mã hóa và redux
     +kiểm tra equipped theme, frame, title đang sử dụng, kiểm tra đã có trên máy chưa, nếu có rồi thì tiến hành load ra giao diện, chưa thì đưa cho server để hỏi presignedUrl để tải theme, frame, title tương ứng lưu về và load ra

-khi người dùng gọi api:
    +kiểm tra access token còn hạn trên 5 phút không, nếu không thì lấy refresh token ra để lấy access token mới sử dụng

-khi người dùng mở app:
    +kiểm tra tình trạng login, nếu đang login thì lấy refresh token gửi cho cognito, trên cognito sẽ kiểm tra và trả về access token và refresh token mới, app sẽ tiến hành lưu refresh token mới đè vào refresh token cũ và lấy access token mới sử dụng
    +các phần tiếp theo đều trong trường hợp còn đăng nhập, do nếu ko còn sẽ tự out ra màn hình login và quay lại flow của người dùng khi login
    +nạp thông tin người dùng và thông tin túi đồ của người dùng từ electron-store vào redux, lấy updatedAt và inventoryUpdatedAt trong profile để kiểm tra với server, lambda sẽ kiểm tra updatedAt và inventoryUpdatedAt từ client xem có đồng bộ không, nếu không thì sẽ gọi và trả về profile mới nhất hoặc danh sách inventory mới nhất tùy vào cái nào đã hết hạn, client khi nhận được 1 trong 2 dữ liệu đó sẽ tiến hành lưu đè vào profile và inventory trong electron-store và cập nhật lên redux để hiển thị
    +kiểm tra equipped theme, frame, title đang sử dụng, kiểm tra đã có trên máy chưa, nếu có rồi thì tiến hành load ra giao diện, chưa thì đưa cho server để hỏi presignedUrl để tải theme, frame, title tương ứng lưu về và load ra

-khi người dùng mở app chạy ngầm lên (khác với mở app lại sau khi tắt):
    +kiểm tra access token còn hạn trên 5 phút không, nếu không thì lấy refresh token ra để lấy access token mới sử dụng
    +lấy updatedAt và inventoryUpdatedAt trong profile từ redux để kiểm tra với server, lambda sẽ kiểm tra updatedAt và inventoryUpdatedAt từ client xem có đồng bộ không, nếu không thì sẽ gọi và trả về profile mới nhất hoặc danh sách inventory mới nhất tùy vào cái nào đã hết hạn, client khi nhận được 1 hoặc 2 dữ liệu đó sẽ tiến hành lưu đè vào profile và inventory trong electron-store và cập nhật lên redux để hiển thị

-khi mở trang thông tin người dùng:
    +lấy updatedAt và inventoryUpdatedAt trong profile từ redux để kiểm tra với server, lambda sẽ kiểm tra updatedAt và inventoryUpdatedAt từ client xem có đồng bộ không, nếu không thì sẽ gọi và trả về profile mới nhất hoặc danh sách inventory mới nhất tùy vào cái nào đã hết hạn, client khi nhận được 1 hoặc 2 dữ liệu đó sẽ tiến hành lưu đè vào profile và inventory trong electron-store và cập nhật lên redux
    +có nút để bật chỉnh sửa tên người dùng, khi chỉnh sửa tên sẽ lưu vào 1 biến tạm ở client
    +khi ấn vào chỉnh sửa frame sẽ mở ra danh sách có itemType = frame trong inventory ở redux để hiển thị cho người dùng chọn, khi lưu SK mới  tương tự với chỉnh sửa theme.
    +phần chỉnh sửa title sẽ mở ra danh sách có thể chọn, người dùng có thể chọn tối đa 3 title để hiển thị
    +khi ấn nút xác nhận (nếu có chỉnh sửa mới cho bật) sẽ gửi tên mới nếu có, vật phẩm trang mở mới lên cho server, trên server sẽ tiến hành kiểm tra, bất cứ vật phẩm sử dụng nào (frame, theme, title), trên server đều phải lấy userId và SK của inventory đó để tìm lại trong db đảm bảo người dùng đã sở hữu vật phẩm đó, sau đó mới lưu trang thái mới vào profile

-khi người dùng mở túi đồ:
     +lấy updatedAt và inventoryUpdatedAt trong profile từ redux để kiểm tra với server, lambda sẽ kiểm tra updatedAt và inventoryUpdatedAt từ client xem có đồng bộ không, nếu không thì sẽ gọi và trả về profile mới nhất hoặc danh sách inventory mới nhất tùy vào cái nào đã hết hạn, client khi nhận được 1 hoặc 2 dữ liệu đó sẽ tiến hành lưu đè vào profile và inventory trong electron-store và cập nhật lên redux để hiển thị
     +khi ấn vào 1 sản phẩm thì sẽ hiện thông tin vật phẩm đó ra, bình thường vật phẩm sẽ hiện hình và background dựa theo rarity của vật phẩm đó

-khi nhận được tiền tệ (knowledgePoint, knowledgeCore, sanity, eCoin):
    +tiền tệ nhận được khi hoàn thành task nhất định, gacha hoặc mua (vd knowledgeCore mua bằng knowledgePoint)
    +khi hoàn thành task (học tập, chơi minigame), server sẽ tiến hành gọi hàm đưa loại tiền tệ, số lượng tương ứng cho userId đó, hàm sẽ tiến hành cộng vào cho budget của userId đó và cập nhật updatedAt trong profile
    +khi mua knowledgeCore bằng knowledgePoint, client sẽ gửi số lượng muốn mua cho server, server tiến hành kiểm tra knowledgePoint của người dùng có đủ với số lượng muốn mua không sau đó tiến hành trừ knowledgePoint và cộng knowledgeCore tương ứng nếu đủ và cập nhật updatedAt trong profile

-khi người dùng mở shop:
    +gọi api để mở shop tương ứng (hiện tại là eCoinShop), nếu trong redux chưa có thông tin shop hoặc expiresAt đã hết hạn thì gọi api, server sẽ tìm trong table ItemData có PK là shop và SK là shop mà client yêu cầu sau đó gửi về cho client, client sẽ lưu thông tin shop vào redux, shop sẽ hiển thị bộ đếm ngược dựa vào expiresAt

-khi gacha: (rarity = 3: sanity, rarity = 4, 5: frame, theme,...)
    +người dùng khi ấn gacha sẽ gọi api cho server cho server biết ấn x1 hay x10, server lấy budget trong profile của userId đó và tiến hành kiểm tra tài nguyên roll, ưu tiên trừ knowledgeCore trước, nếu không đủ thì tính toán lượng knowledgePoint cần thiết cho knowledgeCore còn thiếu, nếu mọi thứ đều thỏa thì lưu lại lượng cần trừ. lấy gachaStats trong profile đưa vào để bắt đầu chạy thuật toán gacha.
        ```thuật toán gacha: ```
        ```kiểm tra is4StarGuaranteed và is5StarGuaranteed mới nhất từ profile để chạy thuật toán (trong rarity map dưới là chạy với chưa có pity 4 và 5)```
        ```theo tỉ lệ đc thiết lập cùng với pity4Star và pity5Star mới nhất của người dùng để cho ra 1 rarity map (vd trong lượt x10: 3 3 3.5 3 3 3 5 3 4 4.5)```
        ```với mỗi số trong rarity map = 3 thì random cho 1 số lượng sanity ngẫu nhiên trong khoản được thiết lập```
        ```với mỗi rarity = 3.5, lấy trong table ItemData với PK là item có collectFrom là "gacha" có rarity là 4 và "isLimited" là false```
        ```với mỗi rarity = 4, lấy trong table ItemData với PK là item có collectFrom là "gacha" có rarity là 4 và "isLimited" là true```
        ```với mỗi rarity = 4.5, lấy trong table ItemData với PK là item có collectFrom là "gacha" có rarity là 5 và "isLimited" là false```
        ```với mỗi rarity = 5, lấy trong table ItemData với PK là item có collectFrom là "gacha" có rarity là 5 và "isLimited" là true```
        ```dựa vào trọng số cuối trong map có 3.5 hay 4.5 hay ko để set is4StarGuaranteed và is5StarGuaranteed mới```
        ```dựa vào số cuối cách lần ra rarity = 3.5/4, và rarity = 4.5/5 để tính pity4Star và pity5Star mới```
        ```tạo các bản ghi trong table inventory cho userId tương ứng đẩy các vật phẩm mới vào theo cấu trúc của [inventory](./Table/Inventory/inventory.json)```
        ```cộng sanity có được vào budget, ghi lại pity4Star, pity5Star, is4StarGuaranteed và is5StarGuaranteed mới vào profile của người dùng, cập nhật knowledgePoint và knowledgeCore mới, cập nhật updatedAt mới và nếu có nhận vật phẩm rarity = 4 hoặc 5 ở bước trên thì cập nhật inventoryUpdatedAt ở thời điểm hiện tại```
        ```tạo các bản ghi lịch sử roll theo cấu trúc [history](./Table/GachaHistory/history.json), timestamp trong trường hợp 10 lần liên tục thì +1 mili giây liên tục cho chuỗi timestamp, lưu theo thứ tự như trong rarity map, nếu vật phẩm rarity = 3 thì lưu sanityAmount vào còn ko thì để 0```
        ```gọi hàm lấy lịch sử gacha mới nhất và gửi về cho client, client nhận lịch sử và lưu vào redux```

-khi người dùng mở xem lịch sử gacha:
    +kiểm tra trong redux đã có gacha history chưa nếu chưa thì gọi api lấy lịch sử gacha, server chuyển PK đang là timestamp thành ngày/tháng/năm giờ/phút/giây và trả về client, client khi hiển thị sẽ đổi màu trên hàng dựa theo rarity của vật phẩm đó, nếu có rồi thì thì sẽ hiện ra luôn