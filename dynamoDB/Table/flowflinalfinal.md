`server (aws api gateway + lambda):`
-mọi hàm trên server đều phải có code kiểm tra authorize và lấy userId từ đó ra chứ không nhận userId từ client

-các hàm sync dữ liệu:
    +sync all: client gửi lên một payload chứa các mốc thời gian hiện có ở client (gồm updatedAt của profile, inventoryUpdatedAt, gachaHistoryUpdatedAt, friendUpdatedAt) và cờ getDaily. Server tiến hành lấy userId ra để lấy profile hiện tại trong db ra đối chiếu:
        ~Trường hợp client không gửi mốc thời gian nào (hoặc null toàn bộ - tức là tải lần đầu/mất data): Server coi như cần lấy hết. Lấy thông tin profile (chuyển các trường trong equippedCosmetics sang assetUrl); lấy 60 vật phẩm inventory đầu tiên; lấy lịch sử gacha 30 vật phẩm đầu tiên; lấy danh sách bạn bè trang đầu tiên (60 người). Tất cả các danh sách đều trả về kèm LastEvaluatedKey tương ứng của nó.
        ~Trường hợp client có gửi các mốc thời gian: Server dùng profile vừa lấy ra để kiểm tra độc lập từng module:
            *So sánh updatedAt: Nếu khác, lấy thông tin profile (đã map assetUrl). Nếu giống, bỏ qua.
            *So sánh inventoryUpdatedAt: Nếu khác, lấy 60 vật phẩm inventory đầu tiên kèm LastEvaluatedKey. Nếu giống, bỏ qua.
            *So sánh gachaHistoryUpdatedAt: Nếu khác, lấy lịch sử 30 lần gacha đầu tiên kèm LastEvaluatedKey. Nếu giống, bỏ qua.
            *So sánh friendUpdatedAt: Nếu khác, lấy danh sách bạn bè trang đầu tiên (15 người, chia tab PENDING, ACCEPTED) kèm LastEvaluatedKey. Nếu giống, bỏ qua.
        ~Xử lý Daily: Luôn gọi hàm refresh daily để kiểm tra trạng thái daily của userId đó. Nếu hàm sinh ra 1 daily mới thì luôn đóng gói trả về cho client. Nếu daily chưa reset (vẫn của ngày hôm nay) thì dựa vào cờ getDaily từ client (true hay false) để quyết định có kẹp daily vào payload trả về hay không.
        ~Trả kết quả: Server gộp tất cả các module có sự thay đổi (dựa vào các bước check ở trên) thành 1 object duy nhất trả về cho client. Module nào không đổi thì sẽ không có mặt trong object response, client cứ thế dùng data cũ ở electron-store và Redux.
    +sync profile: gọi độc lập logic lấy profile và kiểm tra updatedAt như phần sync all.
    +sync inventory: gọi độc lập logic lấy inventory 60 vật phẩm đầu tiên kèm LastEvaluatedKey như phần sync all.
    +sync gacha history: gọi độc lập logic lấy lịch sử gacha 30 vật phẩm đầu tiên kèm LastEvaluatedKey như phần sync all.
    +sync friends: gọi độc lập logic lấy danh sách bạn bè 60 người trang đầu tiên kèm LastEvaluatedKey như phần sync all.

`client (reactjs + nodejs + electron):`
-mọi thao tác từ client đến server đều phải được xác thực đúng người dùng thực hiện thao tác, khi react gửi request cho api gateway phải gửi kèm header có bearer access token,
-refresh token trong electron-store phải đc mã hóa bằng safe-storage, các dữ liệu còn lại sẽ đc chuyển sang Base64 mà ko dùng safe-storage để giảm lag
-khi người dùng trc khi thực hiện 1 chuỗi hành động thì luôn chèn vào giữa để kiểm tra access token còn hạn trên 5 phút không, nếu không thì lấy refresh token ra để lấy access token mới tiếp tục thực hiện (vd: gọi 3 api vẫn chỉ kiểm tra 1 lần)
-các LastEvaluatedKey đc trả về từ server sẽ đc client lưu vào redux cùng json tương ứng (vd LastEvaluatedKey của inventory sẽ nằm trong redux của inventory)
-cần thêm logic khi mở app mà ko có wifi (có thể là load các trường có sẵn để read-only, hoặc cho chạy thẳng vào hàm đăng xuất và ko login dùng app đc, hoặc cho vào chế độ offline (chỉ có thể chạy chức năng focus học tập nhưng ko đc thưởng hay gì hết))
-logic để client biết khi nào server có update data liên quan đến inventory (chỉ ghi ở đây, tạm chưa cần đụng)

-khi người dùng đăng ký (name, email, password) sẽ được aws cognito gửi mã xác thực về gmail, sau khi người dùng nhập đúng mã xác thực thì aws lambda sẽ trigger 1 PostConfirmation để lấy thông tin người dùng đó từ congito và khởi tạo 1 [profile](Table/User/profile.json) cho người dùng

-khi người dùng đăng nhập:
    +cognito trả về refresh token và access token để sử dụng, lưu refresh token vào electron-store
    +gọi API sync all (kèm cờ getDaily = true nếu store chưa có daily). Lưu profile, inventory và các dữ liệu mới nhất (kèm LastEvaluatedKey) vào electron-store và Redux.
    +load các asset của giao diện đang đc sử dụng trong equippedCosmetics đc trả về
    +gọi API lấy danh sách Master Data (chứa toàn bộ item tĩnh như frame, theme, title... gồm assetUrl của mấy cái đó và có key là SK của item đó) từ Server về và lưu thành biến itemDictionary trong Redux & electron-store.
    +load các asset của giao diện đang đc sử dụng trong equippedCosmetics đc trả về

-khi người dùng đăng xuất:
    +xóa hết các file thuộc về người dùng trong electron-store (refresh token, profile, inventory, gacha history, daily quests), ko xóa file dạng tài nguyên (danh sách Master Data)
    +tương tự xóa tài nguyên thuộc người dùng trong redux 

-khi người dùng mở app:
    +kiểm tra tình trạng login, nếu đang login thì lấy refresh token gửi cho cognito, trên cognito sẽ kiểm tra và trả về access token và refresh token mới, app sẽ tiến hành lưu refresh token mới đè vào refresh token cũ và lấy access token mới sử dụng
    +các phần tiếp theo đều trong trường hợp còn đăng nhập, do nếu ko còn sẽ tự out ra màn hình login và quay lại flow của người dùng khi login
    +gửi các mốc updatedAt hiện có từ store lên API sync all. Nếu có dữ liệu mới thì ghi đè vào store và Redux; nếu không thì bốc thẳng từ store lên Redux.
    +server tiến hành duyệt các session còn PENDING trong bảng Study và Minigame để kết thúc tất cả session
    +load các asset của giao diện đang đc sử dụng trong equippedCosmetics đc trả về

-khi người dùng mở app chạy ngầm lên (khác với mở app lại sau khi tắt):
    +kiểm tra access token còn hạn trên 5 phút không, nếu không thì lấy refresh token ra để lấy access token mới sử dụng
    +Ở lần mở lên đầu tiên, lấy các updatedAt (ưu tiên trong Redux, không có mới lấy ở store) để gọi sync all. Thiết lập biến lastSync trong Redux có cooldown 5 phút.
    +Các lần bật lên tiếp theo, nếu lastSync chưa hết hạn 5 phút thì bỏ qua, không gọi sync all để tiết kiệm tài nguyên.

-khi mở trang thông tin người dùng:
    +Ưu tiên load profile từ Redux. Nếu chưa có mới gọi API sync profile
    +có nút để bật chỉnh sửa tên người dùng, khi chỉnh sửa tên sẽ lưu vào 1 biến tạm ở client
    +khi ấn vào chỉnh sửa frame sẽ mở ra danh sách có itemType = frame trong inventory ở redux để hiển thị cho người dùng chọn, khi lưu SK mới  tương tự với chỉnh sửa theme.
    +phần chỉnh sửa title sẽ mở ra danh sách có thể chọn, người dùng có thể chọn tối đa 3 title để hiển thị
    +khi ấn nút xác nhận (nếu có chỉnh sửa mới cho bật) sẽ gửi tên mới nếu có, vật phẩm trang mở mới lên cho server, trên server sẽ tiến hành kiểm tra, bất cứ vật phẩm sử dụng nào (frame, theme, title), trên server đều phải lấy userId và SK của inventory đó để tìm lại trong db đảm bảo người dùng đã sở hữu vật phẩm đó, sau đó mới lưu trang thái mới vào profile
    +phần sửa avatar sẽ đc tách riêng, nếu khoảng thời gian từ avatarUpdatedAt đến hiện tại chưa đến, client sẽ vô hiệu hóa nút tải ảnh, đồng thời hiển thị bộ đếm ngược cho biết chính xác bao lâu nữa mới được đổi tiếp, khi gửi api server sẽ kiểm tra xem cooldown của avatarUpdatedAt đã đúng hạn chưa nếu đúng thì tiến hành xử lí ảnh và trả về profile mới nhất để sync với client
    
-khi người dùng mở túi đồ:
     +kiểm tra inventory người dùng có trên redux chưa, nếu có thì load ra và gọi api lấy inventory từ LastEvaluatedKey đang có để tiếp tục lấy sẵn trang tiếp theo, nếu không thì gọi api sync inventory
     +Mỗi lần load thành công, mảng data sẽ được nối (append) thêm vào danh sách hiện có trong Redux và electron-store. Chỉ clear/reset danh sách này khi có cờ báo thay đổi từ hàm sync.
     +khi ấn qua trang sẽ tiếp tục lấy LastEvaluatedKey để lấy trang tiếp theo, luôn tải trc trang tiếp theo để trải nghiệm đc mượt mà
     +Phân trang UI: Việc chia trang và hiển thị (các ô vuông vật phẩm kèm background theo rarity) được xử lý hoàn toàn dựa trên mảng dữ liệu đã lưu trong Redux. Khi người dùng lật trang gần hết số lượng data đang có, client tự động dùng LastEvaluatedKey để fetch ngầm 60 vật phẩm tiếp theo, mang lại trải nghiệm cuộn mượt mà không bị khựng.
     +khi ấn vào 1 sản phẩm thì sẽ hiện chi tiết thông tin vật phẩm đó ra

-khi gacha: (rarity = 3: sanity, rarity = 4, 5: frame, theme,...)
    +người dùng khi ấn gacha sẽ gọi api cho server cho server biết ấn x1 hay x10, server lấy budget trong profile của userId đó và tiến hành kiểm tra tài nguyên roll, ưu tiên trừ knowledgeCore trước, nếu không đủ thì tính toán lượng knowledgePoint cần thiết cho knowledgeCore còn thiếu, nếu mọi thứ đều thỏa thì lưu lại lượng cần trừ. lấy gachaStats trong profile đưa vào để bắt đầu chạy thuật toán gacha.
        ```Thuật toán Gacha (chạy trong 1 Transaction):```
        ```Khởi tạo & Tạo Rarity Map: * Kiểm tra is4StarGuaranteed và is5StarGuaranteed mới nhất từ profile để làm cơ sở chạy thuật toán (chưa tính đến pity 4 và 5).```
        ```Dựa vào tỉ lệ thiết lập cùng với pity4Star và pity5Star hiện tại để sinh ra một mảng rarity map (VD cho lượt x10: 3, 3, 3.5, 3, 3, 3, 5, 3, 4, 4.5).```
        ```Xử lý Rarity & Lấy vật phẩm: Duyệt qua từng phần tử trong map:```
        ```Rarity = 3: Random một số lượng sanity ngẫu nhiên trong khoảng được thiết lập.```
        ```Rarity = 3.5 (4 sao thường): Truy xuất table ItemData với PK là item có collectFrom = "gacha", rarity = 4 và isLimited = false.```
        ```Rarity = 4 (4 sao limited): Truy xuất table ItemData với PK là item có collectFrom = "gacha", rarity = 4 và isLimited = true.```
        ```Rarity = 4.5 (5 sao thường): Truy xuất table ItemData với PK là item có collectFrom = "gacha", rarity = 5 và isLimited = false.```
        ```Rarity = 5 (5 sao limited): Truy xuất table ItemData với PK là item có collectFrom = "gacha", rarity = 5 và isLimited = true.```
        ```Tính toán lại Pity & Guaranteed:```
        ```Dựa vào trọng số ở các lượt cuối trong map có dính 3.5 hoặc 4.5 hay không để thiết lập is4StarGuaranteed và is5StarGuaranteed mới.```
        ```Dựa vào khoảng cách từ lượt quay cuối cùng đến lần xuất hiện rarity = 3.5/4 và rarity = 4.5/5 gần nhất để tính ra pity4Star và pity5Star mới.```
        ```Cập nhật Inventory & Profile:```
        ```Tạo các bản ghi trong table Inventory cho userId tương ứng, đẩy vật phẩm mới vào theo đúng cấu trúc của [inventory](./Table/Inventory/inventory.json).```
        ```Cộng sanity quay được vào budget thông qua hàm thêm tiền tệ.```
        ```Cập nhật các chỉ số mới vào Profile: pity4Star, pity5Star, is4StarGuaranteed, is5StarGuaranteed, knowledgePoint, knowledgeCore inventoryUpdatedAt, gachaHistoryUpdatedAt và updatedAt.```
        ```Ghi nhận Gacha History:```
        ```Tạo các bản ghi lịch sử theo cấu trúc [history](./Table/GachaHistory/history.json), lưu đúng thứ tự như trong rarity map.```
        ```Xử lý Timestamp: Trong trường hợp roll x10 liên tục, tự động cộng thêm +1ms liên tiếp vào chuỗi timestamp để đảm bảo thứ tự chính xác.```
        ```Nếu vật phẩm rarity = 3, lưu sanityAmount vào log; ngược lại thì để 0.```
        ```Đồng bộ dữ liệu: Gọi hàm sync all và trả về dữ liệu mới nhất cho client.```

-khi người dùng mở xem lịch sử gacha:
    +Kiểm tra & Caching (Xử lý Phân trang Local): Khi người dùng mở xem, ưu tiên load dữ liệu trực tiếp từ Redux. Việc giữ mảng dữ liệu ở client và thực hiện cắt trang (slice) trực tiếp trên Redux giúp UI phản hồi mượt mà ngay lập tức, triệt tiêu hoàn toàn rủi ro người dùng click lật trang liên tục gây spam API.
    +Fetch & Nối Dữ Liệu (Load More): * Nếu Redux chưa có dữ liệu, gọi API sync lấy lịch sử gacha.
    +Khi người dùng lật trang đến gần cuối lượng data đang lưu tại client, lúc này mới sử dụng LastEvaluatedKey để gọi API lấy trang dữ liệu tiếp theo từ AWS và nối (append) vào mảng hiện tại. Server chỉ trả về SK dưới dạng Timestamp nguyên bản.
    +Đồng bộ Local Storage: Mỗi khi có trang lịch sử mới được load về, dữ liệu sẽ tiếp tục được đồng bộ song song vào mảng ở electron-store và Redux. Hệ thống chỉ reset toàn bộ mảng này và đưa người dùng về Trang 1 khi có tín hiệu thay đổi/reset bắt buộc gửi về từ hàm sync.
    +Render UI & Formatting: Client chịu trách nhiệm parse Timestamp sang định dạng Ngày/Tháng/Năm Giờ/Phút/Giây. Trên giao diện, mỗi dòng lịch sử sẽ tự động hiển thị và tô màu tương ứng với chỉ số rarity của vật phẩm đó (dữ liệu có sẵn sẽ được render ra ngay lập tức).

    -khi người dùng mở shop:
        +Kiểm tra trạng thái Shop & Lịch sử mua:
            ~Client kiểm tra data shop (vd: eCoinShop) trong Redux. Nếu chưa có hoặc thời gian expiresAt đã hết, tiến hành gọi API tải shop mới về.
            ~Server nhận request, tìm cấu hình shop trong table ItemData với PK là shop và SK là tên shop (eCoinShop).
            ~Server query các item trong shop vào SK của inventory thuộc user đó, nếu đã sở hữu thì đánh dấu owned cho vật phẩm đó để client ko bấm mua lại
            ~Client nhận thông tin, lưu vào electron-store và Redux.
            ~Render UI: hiển thị bộ đếm ngược dựa vào expiresAt. Các vật phẩm có cờ owned = true sẽ bị làm xám (disable) và đổi text thành "đã sở hữu"
    
    -khi người dùng mua hàng
        +Xác thực Client (Chống spam):
            ~Khi người dùng bấm nút mua (chỉ bấm được nếu owned = false), client lập tức khóa nút hoặc hiện màn hình loading.
            ~Client tự kiểm tra số dư tiền (eCoin/knowledgePoint...) trong Redux so với giá vật phẩm. Nếu không đủ, báo lỗi ngay lập tức, bỏ qua việc gọi API.
            ~Nếu đủ tiền, gửi payload lên API bao gồm: shopId và itemId cần mua
        +Xác thực Server:
            ~Server kiểm tra sự tồn tại và thời hạn mở của shop. Đọc lại profile của userId để lấy số dư tiền tệ thực tế mới nhất.
            ~server kiểm tra trong bản ghi inventory của userId này đã sở hữu vật phẩm này chưa, nếu có rồi thì ko cho mua nữa
            ~Nếu mọi điều kiện hợp lệ, server gói các hành động sau vào 1 Transaction duy nhất:
            ~Trừ số tiền tương ứng trong budget của profile.
            ~Tạo 1 bản ghi mới trong table Inventory cho userId đó để cấp vật phẩm tương ứng (theo cấu trúc inventory.json).
            ~Cập nhật updatedAt và inventoryUpdatedAt bằng thời gian hiện tại vào profile của người dùng.
            ~Server trả về object gồm số dư mới, dữ liệu vật phẩm mới và trạng thái mua thành công.
            ~Client nhận kết quả: tắt trạng thái loading, hiện hiệu ứng nhận đồ. Cập nhật số tiền mới, đẩy (append) vật phẩm mới vào mảng inventory trong Redux, đồng thời cập nhật object shop trong Redux set vật phẩm vừa mua thành owned = true để UI tự động khóa lại. Lưu toàn bộ state mới xuống electron-store.

-khi người dùng vào chức năng học tập:
    +Khởi tạo Session: Client gửi chế độ học (Casual hoặc Ranked). Server query DB theo timestamp giảm dần (limit = 1) để kiểm tra xem có session nào đang PENDING không. Nếu không có, tạo một bản ghi [session](../Table/Study/session.json) mới.
    +Xử lý Vi phạm (Strike): Trong lúc học, nếu bị đánh dấu mất tập trung, gọi API update strikeCount trên DB. Nếu đủ 3 lần -> Failed -> Kết thúc session (nếu là chế độ Ranked sẽ bị trừ rankScore).
    +Kết thúc & Tính toán (Thành công):
        ~Casual: Lấy timeToStreak trong profile trừ đi thời gian đã học. Nếu < 0, tiến hành check lastFocusDate:
            *Nếu là hôm nay: Không làm gì với streak.
            *Nếu là hôm qua: Tăng streak +1.
            *Trường hợp khác: Set streak = 1.
            *Cuối cùng: Cập nhật lastFocusDate mới và updatedAt thời gian mới nhất.
        ~Ranked: Logic tính streak y hệt Casual. Tính thêm rankScore dựa trên quy chuẩn thời gian (+100 điểm nếu hoàn thành xuất sắc không có strike; mỗi strike bị trừ 20 điểm) và cộng vào profile.

-khi server hoàn thành 1 thao tác liên quan đến quest (end session của học, end session của game, gacha,...)
    +gọi 1 hàm update progress đưa userId, type (FOCUS, SUKDOKU, MINESWEEPER, GAHCA,...) và tiến độ tương ứng
    +tiến hành kiểm tra các quest có type tương ứng có isCompleted = false của userId đó, + progress vào cho các quest đó, nếu progress >= target thì cho quest đó là hoàn thành
    +với mỗi quest hoàn thành thì +1 progress cho all_daily
    +trả về danh sách quest với tiến độ mới cho hàm trc nếu có cập nhật

-khi người dùng mở chức năng nhiệm vụ:
    +kiểm tra trong redux có daily chưa, nếu có thì ưu tiên load ra, nếu có mà expiresAt đã qua hoặc ko có thì gọi api lấy daily về
    +server lấy userId để kiểm tra daily của userId đó, nếu daily có expiresAt chưa qua thì gửi về nếu đã qua thì chạy thuật toán refresh daily
        ```thuật toán refresh daily (gồm 5 quest, 2 quest cố định và 3 quest random)```
        ```kiểm tra lastFocusDate và hôm nay có liên tục ko, nếu ko thì cập nhật streak về 0 và updatedAt mới nhất```
        ```cập nhật timeToStreak trong profile của userId đó về 30```
        ```luôn lấy 2 quest có SK là focus_daily và all_daily vào danh sách```
        ```3 quest còn lại sẽ random lấy 3 trừ 3 cái đó trong tất cả các PK quest trừ SK focus_daily và all_daily```
        ```khi random xong sẽ ghi đè lên PK userId và SK daily của userId đó quest mới, ghi lại ngày mới và danh sách nhiệm vụ mới```
        ```cấu trục nhiệm vụ [quest](../Table/Quest/quest.json) ghi vào quests trong [daily](../Table/Quest/daily.json)```
        ```lấy SK của quest làm thành key trong quests của daily```
        ```thêm value progress, isCompleted và isClaimed cho mỗi quest```
        ```gửi daily.quests về cho client, client lưu vào electron và redux để load```

-khi người dùng ấn nhận quest
    +client hiển thị 4 quest trừ all_daily hiện theo cách đặc biệt, hiện progress đã hoàn thành, nếu isClaimed = false và isCompleted = true thì cho ấn nút nhận thưởng
    +khi ấn nhận thưởng, gửi key của quest đó cho server, server lấy daily của userId đó tìm key của quest đó, các hành động đều cùng 1 transaction, nếu isClaimed và isCompleted hợp lệ thì tiến hành gọi hàm cộng knowledgedPoint tương ứng vào budget của profile sau đó set lại isClamed = true để ko cho nhận nữa 

-khi nhận được tiền tệ (knowledgePoint, knowledgeCore, sanity, eCoin):
    +tiền tệ nhận được khi hoàn thành daily, gacha hoặc mua (vd knowledgeCore mua bằng knowledgePoint)
    +hàm đc gọi từ các hàm khác nhận loại tiền tệ cùng số cần cộng vào budget để tiến hành cộng vào
    +khi hoàn thành task (học tập, chơi minigame), server sẽ tiến hành gọi hàm đưa loại tiền tệ, số lượng tương ứng cho userId đó, hàm sẽ tiến hành cộng vào cho budget của userId đó và cập nhật updatedAt trong profile
    +khi mua knowledgeCore bằng knowledgePoint, client sẽ gửi số lượng muốn mua cho server, server tiến hành kiểm tra knowledgePoint của người dùng có đủ với số lượng muốn mua không sau đó tiến hành trừ knowledgePoint và cộng knowledgeCore tương ứng nếu đủ và cập nhật updatedAt trong profile

-khi người dùng tìm kiếm bạn bè:
    +nhập tên hoặc email vào ô tìm kiếm, client gọi api tìm kiếm gửi lên server
    +server tìm trong db các user khớp với từ khóa (chỉ trả về các thông tin công khai cơ bản như userId, name, avatarUrl, level, title) và trả về cho client hiển thị danh sách kết quả

-khi người dùng mở trang bạn bè:
    +lấy friendUpdatedAt trong profile từ redux để kiểm tra với server, lambda sẽ kiểm tra xem có đồng bộ không. nếu không (hoặc redux chưa có dữ liệu) thì gọi api lấy danh sách bạn bè trang đầu tiên kèm LastEvaluatedKey tương ứng
    +client nhận dữ liệu, phân loại ra thành các tab dựa trên status (Bạn bè = ACCEPTED, Chờ xác nhận = PENDING_IN, Đã gửi = PENDING_OUT), lưu vào electron-store và redux
    +khi người dùng cuộn danh sách đến gần cuối, tự động lấy LastEvaluatedKey để gọi api lấy trang tiếp theo, nối (append) vào mảng danh sách hiện tại để trải nghiệm cuộn mượt mà

-khi người dùng gửi yêu cầu kết bạn (người dùng A gửi cho B):
    +client gửi userId của B cho server
    +server kiểm tra 2 user đã là bạn bè hoặc đã gửi yêu cầu trước đó chưa bằng cách tìm PK = userId của A và SK = userId của B
    +nếu chưa có, server tiến hành tạo đồng thời 2 bản ghi bằng 1 transaction trên DynamoDB:
        ~bản ghi 1: PK là A, SK là B, status = PENDING_OUT, kèm thông tin hiển thị của B
        ~bản ghi 2: PK là B, SK là A, status = PENDING_IN, kèm thông tin hiển thị của A
    +cập nhật trường friendUpdatedAt bằng thời gian hiện tại vào profile của CẢ 2 người dùng (A và B) để khi B online sẽ tự động được sync dữ liệu báo có lời mời kết bạn mới

-khi người dùng đồng ý kết bạn (người dùng B đồng ý A):
    +client của B gửi userId của A cho server
    +server kiểm tra bản ghi PK = B, SK = A xem có đúng là đang ở trạng thái PENDING_IN không
    +nếu hợp lệ, tiến hành gộp thao tác vào 1 transaction:
        ~cập nhật bản ghi của B (PK: B, SK: A) thành status = ACCEPTED
        ~cập nhật bản ghi của A (PK: A, SK: B) thành status = ACCEPTED
    +cập nhật friendUpdatedAt mới nhất cho CẢ 2 người dùng
    +trả về dữ liệu mới nhất để client của B lưu đè vào electron-store và cập nhật redux

-khi người dùng từ chối/hủy kết bạn/xóa bạn:
    +client gửi userId của đối phương cho server
    +server tiến hành dùng transaction để xóa đồng thời cả 2 bản ghi (A->B và B->A) ra khỏi database
    +cập nhật friendUpdatedAt cho CẢ 2 người dùng

-khi mở giao diện game:
    +kiểm tra redux có dữ liệu chưa, nếu chưa thì gọi api lấy danh sách màn chơi thuộc game đó (tùy cách sắp xếp màn của từng minigame, có thể áp dụng LastEvaluatedKey để lấy danh sách màn chơi)
    +server tìm PK của game đó và load số lượng màn theo phân trang và LastEvaluatedKey tương ứng, lấy tất cả các trường trong [level](../Table/Minigame/sudokuLevel.json) trừ baseMapConfig đồng thời với các SK level vừa lấy được tiếp tục BatchGetItem để lấy score của userId đã chơi vào (để biết màn nào đã chơi, điểm cao nhất bao nhiêu), gộp chung vào response trả về cho client
    +Client: Nhận data, lưu Redux, render danh sách màn chơi kèm điểm cao nhất đã đạt được nếu có

-khi người dùng ấn vào bắt đầu màn chơi:
    +để chơi 1 level cần phải đáp ứng đủ sanity của màn đó để chơi, nếu client đáp ứng thì giao diện mới sáng nút bắt đầu ấn vào level đó để chơi, khi ấn hiện thông báo xác nhận trừ để đảm bảo ko ấn lộn, gửi request đưa PK và SK của màn chơi đó cho server để chạy thuật toán bắt đầu game
        ```thuật toán bắt đầu game```
        ```server nhận PK và SK của màn chơi mà userId đó muốn bắt đầu, lấy ra budget trong profile của userId đó và từ PK và SK của màn chơi đó lấy sanityCost```
        ```kiểm tra sanity trong budget của profile thuộc userId đó đáp ứng ko, nếu ko đủ thì báo lỗi trả về budget hiện tại của người dùng và updatedAt, client nhận và update budget nhận đc từ server```
        ```các bước dưới đều cùng 1 transaction```
        ```kiểm tra lấy requiredLevel trong gameLevel để tìm trong SK score#[minigame]#[level] đó xem đã đúng là đã chơi màn trc đó hay chưa```
        ```nếu đủ sanity thì trừ đi lượng sanity tương ứng sanityCost cập nhật vào budget, lưu budget mới và updatedAt mới để cuối hàm cũng trả về cho người dùng```
        ```dựa vào baseMapConfig của màn đó tạo ra seed ngẫu nhiên cho màn chơi kèm với solutionGrid tương ứng (solutionGrid linh hoạt tùy vào minigame, có thể là kết quả chính xác của màn chơi hoặc là các vị trí mìn đc đánh dấu nếu là minesweeper vân vân dựa vào minigame)```
        ```tạo 1 session có status là PENDING để biết là đang chơi (COMPLETE nếu hoàn tất), có PK là userId và SK là session#[tên minigame] còn lại theo cấu trúc [session](../Table/Minigame/session.json)```
        ```sau đó gửi về cho client seed đc tạo ra cùng với baseMapConfig để load màn chơi (ko gửi solutionGrid) cùng với budget và updatedAt mới nhất để update vào redux, trong lúc chơi game nếu mà client bị bất cứ cái gì như tắt app thì trc khi tắt sẽ gửi 1 request để end session đó đi và tính là thua```
        ```khi người dùng thực hiện các bước đi, lưu lại log thao tác và timestamp tương ứng với log đó```
        ```kết thúc session```
        ```khi người dùng hoàn thành màn chơi hoặc bằng bất cứ cách nào thoát khỏi game, gửi cho server finalGrid nếu có và log các bước đi```
        ```server sẽ tự tìm session của userId đó đang PENDING để lấy ra dữ liệu và chuyển session về COMPLETED```
        ```so solutionGrid của server và finalGrid của client```
        ```kiểm tra startTime và thời gian hiện tại của server có quá nhanh hay bất thường ko```
        ```quét log của client gửi đến xem các timestamp có quá nhanh cho mỗi thao tác hay bất thường gì ko```
        ```nếu pass cả 3 thì tính là thắng màn còn ko thì tính thua```
        ```nếu thắng thì cộng eCoin = của màn đó, còn lại sẽ cộng lại 50% sanityCost của màn đó```
        ```chạy 1 hàm tính điểm (hàm này cũng có ở client để hiển thị số điểm cho người dùng biết nhưng sẽ ko gửi điểm đó cho server mà server sẽ tự tính lại điểm, điểm là từ maxScoreCap giảm dần)```
        ```lấy PK của userId có SK là score#[minigame]#[levelId] đó, nếu có (tức là đã từng vượt màn) thì so sánh personalBest, nếu cao hơn thì update kèm với achievedAt, nếu ko thì tạo bản ghi mới lưu personalBest và achievedAt lại```
        ```nếu score có update personalBest hoặc tạo mới thì tìm PK userId đó có SK là stats#[minigame] để cập nhật```
        ```nếu tạo mới thì levelCompleted +1, + điểm mới vào totalScore và cập nhật lastUpdatedAt```
        ```nếu đã chơi và vượt personalBest, lấy điểm mới trừ điểm cũ, + chênh lệch vào totalScore và cập nhật lastUpdatedAt```
        ```gọi hàm update quest progress như hoàn thành session focus học tập```
        ```trả cho client budget mới và updatedAt mới để lưu đè vào redux và điểm, kèm theo chênh lệch hoặc mới để client hiển thị (tùy nhu cầu có thể chỉnh sửa thêm)```

-cơ chế auto refresh:
    +Cứ mỗi 10 phút, AWS EventBridge tự động kích hoạt hàm LeaderboardWorkerLambda
    +Trên DynamoDB cấu hình sẵn 1 Global Secondary Index (GSI) với Partition Key là gameId và Sort Key là totalScore
    +Query vào của table Minigame (tìm các gameId là sudoku hoặc game tương ứng) sắp xếp totalScore của các userId giảm dần, Limit lấy 10 người kèm thời gian update lần cuối nếu 2 người cùng điểm thì xem ai đc sớm hơn và các trường dữ liệu khác, logic tính toán do lambda xử lí, query chỉ lấy những thứ cần thiết
    +Lambda đóng gói mảng 10 người này thành một object JSON duy nhất.
    +Ghi đè object vào table Minigame có PK là globalLeaderboard với SK là sudoku (làm tương tự với các game khác nếu có nhiều minigame hơn)

-khi người dùng ấn vào xếp hạng
    +Tab Toàn máy chủ (Global):
        ~kiểm tra trong redux đã có globalLeaderboard chưa, nếu có thì kiểm tra lastFetchedAt đến giờ đã quá 5 phút chưa, nếu chưa đến thì load ra luôn.
        ~nếu chưa có trong redux hoặc đã qua lastFetchedAt, thì gọi api lấy global leaderboard xuống với PK là globalLeaderboard và SK là nơi leaderboard đc mở trong minigame đó (mỗi minigame có 1 giao diện leaderboard riêng, ko từ minigame này xem leaderboard minigame khác)
        ~server trả về json global leaderboard, client nhận và ghi đè vào redux và update lại lastFetchedAt bằng thời gian hiện tại
        ~có nút refresh trong leaderboard sẽ chạy luôn logic kiểm tra lastFetchedAt để ko phải out vào lại leaderboard

    +Tab Bạn bè (Friends):
        ~tương tự với globalLeaderboard, kiểm tra lastFetchedAt trong friendsLeaderboard
        ~server sẽ lấy userId của người dùng query vào bảng Social để lấy PK là userId bản thân và các SK có status là ACCEPT để lấy danh sách bạn bè, dùng danh sách userId bạn bè đó và bản thân lấy stats trong bảng Minigame, server thực hiện sort mảng, lấy ra 10 người có totalScore cao nhất và trả về cho client
        ~client nhận ghi đè lên redux và update lại lastFetchedAt bằng thời gian hiện tại
        ~có nút refresh tương tự global