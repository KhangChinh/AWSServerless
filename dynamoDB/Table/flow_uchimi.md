`server (aws api gateway + lambda):`
-mọi hàm trên server đều phải có code kiểm tra authorize và lấy userId từ JWT claims (sub) chứ không nhận userId từ client
-khi server trả lỗi (bất kỳ API nào), hàm `syncedErrorResponse` sẽ tự động đọc lại dữ liệu mới nhất của user (profile, daily, inventory, gachaHistory, social) và đính kèm vào error response để client có thể tự đồng bộ ngay cả khi lỗi

-sync all (POST /sync-all):
    +client gửi body: { getProfile, getDaily, getInventory, getGachaHistory, getSocial } — các cờ boolean cho biết cần lấy module nào
    +server luôn lấy profile từ DB (dùng nội bộ), sau đó kiểm tra từng cờ:
        ~getProfile = true: map cosmeticAssets (chuyển SK trong equippedCosmetics sang object có id, name, imageUrl, assets bằng BatchGetItem vào ItemData), trả profile
        ~getInventory = true: lấy trang đầu tiên mỗi loại itemType (background, frame, title, button...) qua GSI ItemTypeIndex, mỗi loại 10 item, ScanIndexForward: false. Trả object dạng { background: {items, lastEvaluatedKey}, frame: {...}, ... }
        ~getGachaHistory = true: lấy 30 bản ghi đầu tiên kèm lastEvaluatedKey
        ~getSocial = true: lấy 10 bản ghi đầu tiên kèm lastEvaluatedKey
    +xử lý Daily: luôn gọi hàm `getOrRefreshDaily` để kiểm tra daily. Nếu daily hết hạn (expiresAt < now) → chạy `refreshDaily` tạo daily mới. Nếu daily mới được tạo hoặc cờ getDaily = true → trả daily trong response
    +trả kết quả: gộp tất cả module được yêu cầu thành 1 object response. Module nào không yêu cầu sẽ không có trong response

-sync profile (GET /sync-profile): trả profile đã map cosmeticAssets
-sync inventory (GET /sync-inventory?itemType=...&lastKey=...): trả 10 item/trang theo itemType qua GSI ItemTypeIndex
-sync gacha history (GET /sync-gacha-history?lastKey=...): trả 30 bản ghi/trang
-sync social (GET /sync-social?lastKey=...): trả 10 bản ghi/trang
-master data (GET /master-data): trả toàn bộ PK="item" từ ItemData (cache trong Lambda memory)
-check version (GET /version): trả phiên bản server hiện tại (không cần auth), client so sánh để xóa cache master data nếu version thay đổi

`client (reactjs + nodejs + electron):`
-mọi request từ client đều phải kèm header Authorization: Bearer [access token] (JWT từ Cognito)
-refresh token trong electron-store mã hóa bằng safe-storage, các dữ liệu còn lại (profile, inventory, daily...) encode Base64 không dùng safe-storage
-trước chuỗi hành động, kiểm tra access token còn hạn trên 5 phút, nếu không → lấy refresh token để xin access token mới
-LastEvaluatedKey được lưu cùng dữ liệu tương ứng trong Redux

-khi người dùng đăng ký (name, email, password):
    +cognito gửi mã xác thực về email
    +sau khi xác thực đúng → Cognito trigger PostConfirmation → Lambda `handleInitUser`:
        ~lấy thông tin từ cognito (sub, email, name)
        ~BatchGetItem lấy item mặc định (bg_default, frame_none, title_none) từ ItemData
        ~BatchWriteCommand tạo profile (với budget mặc định 1500 KP) + tạo inventory mặc định
        ~gọi `refreshDaily` tạo daily quest đầu tiên cho user

-khi người dùng đăng nhập:
    +cognito trả về refresh token và access token, lưu refresh token vào electron-store
    +gọi GET /version kiểm tra phiên bản server: nếu version thay đổi → xóa cache masterData và shop trong electron-store
    +gọi POST /sync-all (tất cả cờ = true). Lưu profile, inventory, daily, gachaHistory, social vào electron-store và Redux
    +gọi GET /master-data lấy danh sách item tĩnh, lưu vào electron-store dưới dạng itemDictionary
    +load các asset của giao diện đang được sử dụng trong equippedCosmetics

-khi người dùng đăng xuất:
    +xóa hết dữ liệu người dùng trong electron-store (refresh token, profile, inventory, gacha history, daily quests, social)
    +không xóa file dạng tài nguyên chung (danh sách Master Data)
    +tương tự xóa trong Redux

-khi người dùng mở app (sau khi đã đăng nhập):
    +kiểm tra tình trạng login: lấy refresh token gửi cognito → nhận access token và refresh token mới → lưu đè refresh token mới
    +hydrate Redux từ electron-store trước (hiển thị UI ngay lập tức)
    +kiểm tra lastSyncAll (lưu cả localStorage và Redux) có cooldown 5 phút:
        ~chưa hết hạn + cache đầy đủ (profile + daily + inventory + gachaHistory + social) → dùng cache, không gọi API
        ~hết hạn hoặc thiếu data → gọi POST /sync-all với các cờ tương ứng module cần refresh
    +module nào server trả về → ghi đè vào Redux + electron-store. Module nào không trả → giữ nguyên cache
    +load asset giao diện từ equippedCosmetics

-khi app từ background trở lại (tray):
    +kiểm tra access token còn hạn
    +áp dụng logic lastSyncAll 5 phút giống mở app

-khi mở trang thông tin người dùng:
    +ưu tiên profile từ Redux. Nếu chưa có → gọi API sync-profile
    +chỉnh sửa tên: lưu vào biến tạm → ấn xác nhận → gọi PUT /update-profile { name }
        ~server validate name, cập nhật information.name + updatedAt, trả profile mới (đã map cosmeticAssets)
        ~client lưu đè profile vào Redux + electron-store
    +chỉnh sửa cosmetics (frame, background, title):
        ~mở danh sách vật phẩm đã sở hữu (lọc inventory theo itemType trong Redux)
        ~title: chọn tối đa 3
        ~ấn xác nhận → gọi POST /change-cosmetics { backgroundId, frameId, titles }
        ~server: BatchGetItem kiểm tra sở hữu trong Inventory (item mặc định frame_none, title_none được bypass), nếu hợp lệ → UpdateCommand cập nhật equippedCosmetics + updatedAt, trả profile mới (đã map)
    +đổi avatar:
        ~tốn 500 eCoin mỗi lần đổi
        ~client kiểm tra đủ eCoin trước khi cho phép upload
        ~khi ấn đổi: chuyển ảnh sang base64, gọi POST /update-avatar { imageBody (base64), contentType }
        ~server: kiểm tra budget.eCoin >= 500, upload buffer lên S3 (key: public-assets/avatars/{userId}.{ext}), trừ 500 eCoin bằng ConditionExpression chống race-condition, cập nhật avatarUrl (thêm ?t=timestamp để bypass cache), trả profile mới
        ~client: cập nhật profile Redux + electron-store

-khi người dùng mở túi đồ:
    +inventory được tổ chức theo itemType (background, frame, title, button)
    +mỗi tab itemType: kiểm tra Redux đã có chưa, nếu có và hasMore = false → dùng cache
    +nếu chưa có → thử load từ electron-store → nếu vẫn không có → gọi GET /sync-inventory?itemType=...
    +phân trang: 10 item/trang. Khi user cuộn gần hết → dùng lastKey gọi API lấy trang tiếp → APPEND vào mảng hiện có
    +khi có signal từ sync (data thay đổi) → SET (ghi đè) thay vì APPEND

-khi gacha (POST /gacha):
    +client gửi { isx10: true/false }. Chi phí: 1 lượt = 1 knowledgeCore
    +nếu không đủ core → server tự đổi KP sang Core (tỉ giá 150 KP = 1 Core). Nếu vẫn thiếu → 400
    +thuật toán gacha (server-side):
        ~duyệt từng lượt, tăng pity4Star và pity5Star
        ~hard pity 5★ ở lượt 80 (rate = 100%), base rate 1%. Hard pity 4★ ở lượt 10, base rate 10%
        ~50/50: khi ra 5★ → 50% limited (rarity 5), 50% thường (rarity 4.5). Thua 50/50 → is5StarGuaranteed = true → lần 5★ tiếp đảm bảo limited. Tương tự 4★ (3.5 vs 4L)
        ~rarity 3: random sanity 50-100 (bước 5)
    +xử lý trùng lặp: nếu vật phẩm đã sở hữu (kiểm tra BatchGetItem Inventory) → quy đổi sang sanity (5★ = 150, 4★ = 80)
    +ghi Inventory (vật phẩm mới), GachaHistory (tất cả), cập nhật budget + gachaStats + updatedAt trong Profile
    +response trả: pulledItems (mảng kết quả hiển thị), profile (đã map), inventory (chỉ các itemType có vật phẩm mới), gachaHistory (trang 1 mới nhất)
    +client: hiển thị animation gacha, cập nhật Redux + electron-store

-khi người dùng xem lịch sử gacha:
    +ưu tiên load từ Redux (phân trang local bằng slice)
    +nếu chưa có → load từ electron-store → nếu vẫn không → gọi API sync-gacha-history
    +khi cuộn gần hết data → dùng lastKey gọi API lấy trang tiếp → APPEND
    +client parse SK (timestamp) sang định dạng ngày/giờ, tô màu theo rarity

-khi người dùng mở shop:
    +gọi GET /shop/ecoin
    +server: lấy cấu hình shop từ ItemData (PK=shop, SK=eCoinShop), BatchGetItem kiểm tra inventory của user → gắn isOwned
    +client: lưu vào Redux + electron-store, hiển thị countdown từ expiresAt, item owned → disable + "Đã sở hữu"
    +shop tự refresh hàng tuần (00:00 Thứ 2 VN) bởi Lambda `handleRefresheCoinShop`: random 3 item từ pool collectFrom="eCoinShop"

-khi người dùng mua hàng (POST /shop/ecoin/buy):
    +client: khóa nút mua + check đủ eCoin trong Redux trước
    +gửi { itemId }
    +server: TransactWriteCommand gồm: trừ eCoin (ConditionExpression >= price), tạo bản ghi Inventory (ConditionExpression attribute_not_exists), cập nhật updatedAt
    +response: profile (budget mới), shop (đã update isOwned), inventory (trang 1 của itemType vừa mua)
    +client: cập nhật Redux + electron-store

-khi người dùng vào chức năng học tập:
    +bắt đầu: gọi POST /start-study-session { mode: "casual"|"rank", durationMinutes }
    +server tạo session trong Study table (SK = session#timestamp), status = PENDING, trả { sessionId }
    +trong lúc học: nếu bị phát hiện mất tập trung → gọi POST /strike { sessionId }
        ~server: tăng strikeCount += 1. Nếu >= 3 → auto FAILED + set endTime
    +kết thúc: gọi POST /end-study-session { sessionId }
        ~server 100% tự quyết định status:
            *strikeCount >= 3 → FAILED
            *elapsed >= expected - 30s → COMPLETED
            *casual mode dừng sớm → COMPLETED
            *rank mode dừng sớm → FAILED
        ~nếu COMPLETED + rank: earnedPoints = Math.floor(elapsed / 60), cộng vào studyStats.rankScore
        ~nếu COMPLETED: gọi updateQuestProgress(userId, "FOCUS", studiedMinutes)
    +response: { status, actualDurationSeconds, earnedPoints, questUpdate, profile, daily }

-khi server hoàn thành 1 thao tác liên quan đến quest:
    +gọi `updateQuestProgress(userId, type, amount)` — type: "FOCUS", "PLAY_SUDOKU", "PLAY_MINESWEEPER", "GACHA", "COMPLETE_QUIZ", "CORRECT_QUIZ_ANSWER"
    +tìm daily hiện tại của user, duyệt các quest chưa hoàn thành có type khớp → cộng progress
    +nếu progress >= target → isCompleted = true, all_daily.progress += 1
    +nếu all_daily.progress >= 4 → all_daily.isCompleted = true
    +trả { updatedQuests, updatedDaily }

-khi người dùng mở chức năng nhiệm vụ (GET /daily):
    +server: lấy profile → check streak, gọi `getOrRefreshDaily`:
        ~daily chưa hết hạn → trả daily hiện tại
        ~daily hết hạn → chạy `refreshDaily`:
            *kiểm tra lastFocusDate có liên tục với hôm qua không, nếu không → reset streak = 0
            *cập nhật timeToStreak = 30
            *tạo daily mới: focus_daily (cố định) + all_daily (cố định) + 3 quest random
            *ghi đè daily vào Quest table, expiresAt = 00:00 UTC ngày mai
    +client: lưu vào Redux + electron-store

-khi người dùng ấn nhận quest (POST /daily/claim):
    +gửi { questKey }
    +server: TransactWriteCommand:
        ~Quest table: cập nhật isClaimed = true (ConditionExpression: expiresAt > now)
        ~User table: cộng knowledgePoint tương ứng vào budget
    +response: { rewardKnowledgePoint, newKnowledgePoint, updatedAt }
    +all_daily: khi isCompleted = true → cho phép claim, set isClaimed = true

-khi nhận được tiền tệ (knowledgePoint, knowledgeCore, sanity, eCoin):
    +tiền tệ cộng vào budget của profile trên DB
    +quy đổi KP → KC: gọi POST /convert-points { targetCores }
        ~server: kiểm tra đủ KP (tỉ giá 150 KP = 1 Core), trừ KP + cộng KC, trả profile mới (đã map cosmeticAssets)

-khi người dùng tìm kiếm bạn bè (GET /friends/search?q=...):
    +từ khóa tối thiểu 2 ký tự
    +rate limit: 5 giây giữa mỗi lần search (server kiểm tra lastSearchAt trong profile)
    +server: gọi Algolia Search (index "users", multi-match trên name, loại trừ bản thân), trả tối đa 10 kết quả
    +mỗi user trả về: PK, avatarUrl, information.name, studyStats.{rankScore, streak}, equippedCosmetics.equippedFrame
    +Algolia được sync tự động từ DynamoDB Streams → Lambda `handleStreamIndexer` (trigger trên User table)

-khi người dùng mở trang bạn bè (GET /friends?lastKey=...):
    +phân trang 60 bạn/trang
    +client phân loại theo status: ACCEPTED (bạn bè), PENDING_IN (lời mời đến), PENDING_OUT (đã gửi)

-khi người dùng gửi yêu cầu kết bạn (POST /friends/request):
    +gửi { targetUserId }
    +server: kiểm tra chưa tồn tại, chống spam (max 50 PENDING_OUT)
    +TransactWriteCommand: tạo 2 bản ghi (PENDING_OUT cho mình, PENDING_IN cho đối phương) + cập nhật friendUpdatedAt cho CẢ 2 user
    +lời mời có TTL 30 ngày

-khi người dùng đồng ý kết bạn (POST /friends/accept):
    +gửi { targetUserId }
    +server: kiểm tra bản ghi PENDING_IN hợp lệ
    +TransactWriteCommand: cập nhật cả 2 bản ghi thành ACCEPTED + cập nhật friendUpdatedAt cho cả 2

-khi người dùng từ chối/hủy/xóa bạn (POST /friends/remove):
    +gửi { targetUserId }
    +TransactWriteCommand: xóa 2 bản ghi (A→B, B→A) + cập nhật friendUpdatedAt cho cả 2

-khi mở giao diện minigame — Sudoku (GET /minigame/sudokulevels?lastKey=...):
    +server: query PK="sudoku" lấy 10 level/trang + BatchGetItem lấy score của user cho các level đó
    +trả { levels (kèm score nếu đã chơi), lastEvaluatedKey }

-khi người dùng bắt đầu chơi (POST /minigame/sudokulevels/start-game):
    +gửi { gameId: "sudoku", levelId }
    +server:
        ~lấy profile + level song song
        ~kiểm tra đủ sanity (sanityCost), trừ sanity → cập nhật budget
        ~sinh đề: gọi sudokuGenerator → tạo puzzleGrid + solutionGrid từ baseMapConfig
        ~tạo session tạm (PK=userId, SK=session#sudoku) với status PENDING, checkCount = 5, seed, solutionGrid
        ~trả { profile (budget mới), sessionData: { sessionId, seed, checkCount, puzzleGrid, status }, baseMapConfig }
    +client: render game từ puzzleGrid + baseMapConfig, ghi log thao tác kèm timestamp

-khi người dùng kiểm tra bàn cờ (POST /minigame/sudokulevels/check):
    +gửi { currentGrid, actionLogs }
    +server: lấy session → kiểm tra cheat (thời gian, tốc độ thao tác) + so sánh từng ô với solutionGrid → trừ checkCount
    +trả { checkCount, isBoardCorrect }

-khi kết thúc chơi (POST /minigame/sudokulevels/end-session):
    +gửi { finalGrid, actionLogs, endState: "quit"|"lost"|"submit" }
    +server:
        ~thua/thoát (endState = quit/lost): hoàn 50% sanityCost → cập nhật budget + đổi session CANCELLED
        ~nộp bài (endState khác): kiểm tra cheat + so sánh finalGrid với solutionGrid
            *không đúng → lỗi 400
            *đúng → tính điểm: score = maxScoreCap × (1 - penaltyTime / 10) × 0.01, sàn 10% maxScoreCap
            *bonus/penalty checkCount: checkCount = 5 (full) → score × 1.5, eCoin × 1.5. Mỗi check mất → score × 0.95
            *cộng eCoin vào budget
            *so sánh personalBest → cập nhật score + stats (totalScore, levelsCompleted)
            *gọi updateQuestProgress
            *trả lại danh sách level đã cập nhật score
    +hàm kiểm tra cheat:
        ~hoàn thành dưới 5 giây + full board → cheat
        ~timestamp giữa 2 thao tác < 10ms → cheat (machine speed)
        ~chuỗi thao tác < 50ms liên tục >= 4 lần → cheat (auto-bot)
        ~timestamp đi lùi → cheat (time travel)
        ~trung bình > 15 thao tác/giây → cheat

-cơ chế auto refresh leaderboard:
    +mỗi 10 phút, EventBridge trigger Lambda `handleLeaderboardWorker`
    +Scan stats#sudoku → sort totalScore giảm dần → lấy top 10
    +ghi đè vào PK=leaderboard, SK=sudoku với expiresAt = now + 11 phút

-khi người dùng xem xếp hạng:
    +tab Global (GET /minigame/leaderboard?gameId=sudoku): đọc bản ghi PK=leaderboard, SK=gameId
    +tab Bạn bè: server lấy danh sách bạn ACCEPTED từ Social → BatchGetItem stats#{gameId} → sort → top 10
    +client: kiểm tra cache trong Redux (lastFetchedAt 5 phút), có nút refresh

-chức năng Study Planner (100% local + Gemini API):
    +tất cả dữ liệu lưu trong electron-store, không gửi lên server
    +chat AI: dùng Ollama (local) hoặc Gemini API (cần key), tối đa 5 phiên chat
    +study plan: tạo kế hoạch học tập bằng AI, tối đa 5 kế hoạch
    +quiz: tạo bộ câu hỏi từ study plan bằng AI, tối đa 10 lịch sử quiz
    +khi hoàn thành quiz → gọi POST /study-planner/quiz-submit { correctAnswersCount, totalQuestions }
        ~server: cộng KP = correctAnswersCount × 10
        ~gọi updateQuestProgress(userId, "COMPLETE_QUIZ", 1) + updateQuestProgress(userId, "CORRECT_QUIZ_ANSWER", correctAnswersCount)
        ~trả { earnedKP, questUpdate, profile, daily }
    +settings: lưu provider AI (ollama/gemini) và gemini API key

-hệ thống upload nội dung (S3 Trigger):
    +upload file .zip vào `uploads/items/` → Lambda `processZip`:
        ~giải nén → đọc data.json lấy metadata item
        ~upload tất cả asset (css, image, audio, json) lên S3 (public-assets/items/{itemType}/{itemId}/...)
        ~map URL tương đối vào item.imageUrl và item.assets
        ~ghi item vào ItemData table
    +upload file .json vào `uploads/levels/` → Lambda `processJson` → ghi vào Minigame table
    +upload file .json vào `uploads/quests/` → Lambda `processJson` → ghi vào Quest table