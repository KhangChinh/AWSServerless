# Flow Frontend (AWSStudy-Play → AWS-Serverless)

---

## KHỞI ĐỘNG APP & ĐỒNG BỘ DỮ LIỆU

khi người dùng đăng nhập, flow khởi động:
1. gọi `GET /version` kiểm tra phiên bản server. nếu version thay đổi so với bản lưu local → xóa cache masterData và shop trong electron-store
2. gọi `POST /sync-all` với body: `{ getProfile: true, getDaily: true, getInventory: true, getGachaHistory: true, getSocial: true }`. backend trả tất cả dữ liệu trang 1
3. fe lưu response vào redux + electron-store thông qua hàm `ingestServerData()`
4. gọi `GET /master-data` lấy danh sách item tĩnh. fe lưu vào electron-store dưới dạng itemDictionary (key là SK của item)
5. load asset giao diện từ equippedCosmetics đã map

khi mở app lại (đã đăng nhập):
1. hydrate redux từ electron-store trước (hiển thị UI ngay lập tức không cần đợi API)
2. kiểm tra `lastSyncAll` trong localStorage + redux (cooldown 5 phút):
   - cache fresh + đầy đủ (profile + daily + inventory + gachaHistory + social) → dùng cache, không gọi API
   - cache stale hoặc thiếu module → gọi `POST /sync-all` chỉ với cờ của module cần refresh
3. module nào server trả → `ingestServerData()` ghi đè vào redux + electron-store. Module nào không trả → giữ nguyên cache

khi app từ tray trở lại: áp dụng logic `lastSyncAll` 5 phút giống trên.

response sync-all có dạng:
- `profile`: object profile đầy đủ (equippedCosmetics đã map sang object có { id, name, imageUrl, assets })
- `inventory`: object dạng `{ background: { items: [...], lastEvaluatedKey }, frame: {...}, ... }`. mỗi loại 10 item/trang
- `gachaHistory`: mảng 30 bản ghi đầu tiên, `gachaHistoryLastKey`
- `social`: mảng 10 bạn bè đầu tiên, `socialLastKey`
- `daily`: object daily quest hiện tại (nếu có)

khi cần load thêm trang (infinite scroll), fe gọi riêng từng API:
- `GET /sync-inventory?itemType=background&lastKey=...` → trả `{ inventory, lastEvaluatedKey }`. mỗi trang 10 item, query qua GSI ItemTypeIndex
- `GET /sync-gacha-history?lastKey=...` → trả `{ gachaHistory, lastEvaluatedKey }`. mỗi trang 30 bản ghi
- `GET /sync-social?lastKey=...` → trả `{ social, lastEvaluatedKey }`. mỗi trang 10 bạn bè
- lastKey là JSON string đã `encodeURIComponent`, lấy từ lastEvaluatedKey của response trước. khi `lastEvaluatedKey = null` thì hết dữ liệu

`GET /sync-profile` → trả `{ profile }` (đã map cosmeticAssets). ít dùng, thường sync-all đã đủ.

`GET /master-data` → gọi 1 lần khi mở app, trả `{ items }` là mảng tất cả item trong game. server có cache Lambda memory nên gọi nhiều cũng không tốn.

---

## AVATAR

đổi ảnh đại diện tốn **500 eCoin**. fe check đủ eCoin trong budget trước khi cho phép upload.

luồng đổi avatar:
1. fe chọn ảnh → chuyển sang base64
2. fe gọi `POST /update-avatar`, body: `{ imageBody: "base64string...", contentType: "image/png" | "image/jpeg" }`
3. server: kiểm tra budget.eCoin >= 500, nếu không đủ → trả `{ success: false, message, profile }` (có profile mới nhất để fe sync)
4. server: upload buffer lên S3 (`public-assets/avatars/{userId}.{ext}`), trừ 500 eCoin bằng `ConditionExpression: budget.eCoin >= :cost` chống race-condition
5. server: cập nhật `information.avatarUrl` = `avatars/{userId}.{ext}?t={timestamp}` (thêm ?t= để bypass CDN cache)
6. server: trả `{ success: true, profile }` (profile mới nhất đã map cosmeticAssets)
7. fe: dispatch profile mới vào redux + electron-store

lưu ý: avatarUrl trong DB là path tương đối, fe tự ghép domain CDN phía trước. S3 key cố định theo userId nên đổi ảnh sẽ ghi đè file cũ.

---

## TRANG BỊ COSMETICS

fe gọi `POST /change-cosmetics`, body: `{ backgroundId, frameId, titles }`. backgroundId là bắt buộc. frameId có thể null. titles là mảng tối đa 3 (có thể rỗng []).

backend: BatchGetItem kiểm tra user sở hữu item trong Inventory (PK=userId, SK=itemId). item mặc định (frame_none, title_none) được bypass. nếu hợp lệ → UpdateCommand cập nhật equippedCosmetics + updatedAt. trả `{ profile }` đã map cosmeticAssets. fe lưu đè profile vào redux + electron-store.

lưu ý: equippedButton hiện chưa dùng trong API change-cosmetics (chỉ set khi khởi tạo).

fe lọc inventory theo itemType (background, frame, title) để hiển thị danh sách cho user chọn. chỉ hiện item đã sở hữu.

---

## SESSION HỌC

bắt đầu session: fe gọi `POST /start-study-session`, body: `{ mode: "casual" | "rank", durationMinutes }`. backend tạo session với status PENDING trong bảng Study, trả `{ sessionId }`. sessionId có dạng "session#{timestamp}".

trong khi học, nếu phát hiện mất tập trung: fe gọi `POST /strike`, body: `{ sessionId }`. backend tăng strikeCount += 1. nếu >= 3 → auto FAILED, trả `{ strikeCount, sessionEnded: true }`. chưa đủ 3 → trả `{ strikeCount, sessionEnded: false }`.

kết thúc session: fe gọi `POST /end-study-session`, body: `{ sessionId }`. **backend 100% tự quyết định status**, client KHÔNG gửi status hay reason:
- strikeCount >= 3 → FAILED
- elapsed >= expected - 30s → COMPLETED (cho phép lệch 30s do network delay)
- casual mode dừng sớm → COMPLETED
- rank mode dừng sớm → FAILED

response trả `{ status, actualDurationSeconds, earnedPoints, questUpdate, profile, daily }`:
- COMPLETED + rank → earnedPoints = Math.floor(elapsed / 60), server cộng vào studyStats.rankScore
- COMPLETED → server gọi updateQuestProgress(userId, "FOCUS", studiedMinutes)
- nếu session đã kết thúc trước đó (status !== PENDING) → server trả lại thông tin session cũ

---

## DAILY QUEST

fe gọi `GET /daily` để lấy daily quest hiện tại. backend lấy profile check streak, nếu daily hết hạn thì chạy refreshDaily (reset streak nếu lastFocusDate không liên tục, cập nhật timeToStreak về 30, tạo daily mới gồm 1 quest cố định focus_daily + 1 meta quest all_daily + 3 quest random). response: `{ daily }`.

mỗi quest có: type, name, description, target, knowledgePoint, progress, isCompleted, isClaimed. fe hiển thị progress/target. khi isCompleted = true và isClaimed = false → hiện nút "Nhận thưởng".

khi ấn nhận thưởng: fe gọi `POST /daily/claim`, body: `{ questKey }` (vd: "focus_daily", "all_daily"). backend dùng TransactWriteCommand:
- Quest table: set isClaimed = true (ConditionExpression: expiresAt > now)
- User table: cộng knowledgePoint vào budget.knowledgePoint
- trả `{ rewardKnowledgePoint, newKnowledgePoint, updatedAt }`. fe cập nhật budget trong redux, đánh dấu quest đã claimed

quest "all_daily": khi 4 quest thường hoàn thành → all_daily.progress = 4 → all_daily.isCompleted = true → cho nhận thưởng.

tiến độ quest được backend tự cập nhật khi user thực hiện hành động (end session học, end session game, gacha, quiz...) thông qua hàm `updateQuestProgress(userId, type, amount)`. type: "FOCUS", "PLAY_SUDOKU", "PLAY_MINESWEEPER", "GACHA", "COMPLETE_QUIZ", "CORRECT_QUIZ_ANSWER". fe không cần gọi API riêng để update progress.

---

## GACHA

fe gọi `POST /gacha`, body: `{ isx10: true | false }`. chi phí: 1 lượt = 1 knowledgeCore. nếu không đủ core, backend tự đổi KP sang Core (tỉ giá 150 KP = 1 Core). nếu vẫn không đủ → 400.

thuật toán gacha (server-side): hard pity 5★ ở lượt 80 (100%), base rate 1%. hard pity 4★ ở lượt 10, base rate 10%. 50/50: khi ra 5★ → 50% limited (5), 50% thường (4.5). thua 50/50 → is5StarGuaranteed = true → lần 5★ tiếp đảm bảo limited. 4★ tương tự (3.5 vs 4L).

xử lý trùng lặp: nếu vật phẩm đã sở hữu hoặc trùng trong cùng x10 → quy đổi sang sanity (5★ = 150, 4★ = 80). rarity 3 → random sanity 50-100 (bước 5).

response trả:
- `pulledItems`: mảng kết quả hiển thị, mỗi item: `{ imageUrl, name, rarity, isConverted, convertedTo? }`
- `profile`: profile mới nhất đã map cosmeticAssets (budget + gachaStats cập nhật)
- `inventory`: object chỉ chứa itemType có vật phẩm mới: `{ background: {items, lastEvaluatedKey}, ... }`
- `gachaHistory`: trang 1 lịch sử mới nhất (30 bản ghi), `gachaHistoryLastKey`

fe: hiện animation gacha → reveal item (5★ hiệu ứng đặc biệt, 4★ trung bình, 3★ đơn giản) → cập nhật redux + electron-store thông qua `ingestServerData()`.

---

## CURRENCY EXCHANGE

fe gọi `POST /convert-points`, body: `{ targetCores }` (số knowledgeCore muốn đổi). tỉ giá: 150 KP = 1 Core. fe validate > 0 và số nguyên. backend kiểm tra đủ KP, trừ KP + cộng KC, trả `{ profile }` (đã map cosmeticAssets). fe cập nhật profile trong redux.

---

## SHOP

fe gọi `GET /shop/ecoin`. backend lấy cấu hình shop từ ItemData (PK=shop, SK=eCoinShop), BatchGetItem kiểm tra inventory → gắn `isOwned: true/false`. trả `{ shop }` chứa activeItems + expiresAt. fe hiển thị countdown, item owned → disable + "Đã sở hữu".

shop auto-refresh hàng tuần (00:00 Thứ 2 VN): Lambda `handleRefresheCoinShop` random 3 item từ pool `collectFrom="eCoinShop"`, expiresAt = 7 ngày sau.

mua item: fe gọi `POST /shop/ecoin/buy`, body: `{ itemId }` (SK của item). backend dùng TransactWriteCommand:
- trừ eCoin (ConditionExpression budget.eCoin >= price)
- tạo bản ghi inventory (ConditionExpression attribute_not_exists)
- trả `{ profile (budget mới), shop (isOwned cập nhật), inventory (trang 1 itemType vừa mua) }`
- fe cập nhật redux + electron-store

---

## BẠN BÈ

fe gọi `GET /friends?lastKey=...` phân trang 60 item. response: `{ friends, lastEvaluatedKey }`. mỗi friend có: SK, friendName, friendAvatarUrl, status, createdAt, updatedAt.

fe phân loại:
- ACCEPTED: bạn bè → nút "Xóa bạn"
- PENDING_IN: lời mời đến → nút "Chấp nhận" + "Từ chối"
- PENDING_OUT: đã gửi → "Đang chờ xác nhận" + nút "Hủy lời mời"

gửi lời mời: `POST /friends/request`, body: `{ targetUserId }`. backend: kiểm tra chưa tồn tại + chống spam (max 50 PENDING_OUT). TransactWriteCommand tạo 2 bản ghi + cập nhật friendUpdatedAt cho cả 2 user. lời mời có TTL 30 ngày.

chấp nhận: `POST /friends/accept`, body: `{ targetUserId }`. backend cập nhật cả 2 bản ghi → ACCEPTED + friendUpdatedAt.

xóa/từ chối/hủy: `POST /friends/remove`, body: `{ targetUserId }`. backend xóa 2 bản ghi + friendUpdatedAt.

---

## TÌM KIẾM USER

fe gọi `GET /friends/search?q=keyword` (tối thiểu 2 ký tự). rate limit 5 giây giữa mỗi lần search (server kiểm tra lastSearchAt). backend gọi Algolia Search (index "users", loại trừ bản thân), trả `{ users }` tối đa 10 kết quả, mỗi user có: PK, avatarUrl, information.name, studyStats.{rankScore, streak}, equippedCosmetics.equippedFrame.

dữ liệu Algolia sync tự động từ DynamoDB Streams (Lambda `handleStreamIndexer` trigger trên User table).

---

## MINIGAME (SUDOKU)

lấy danh sách màn chơi: fe gọi `GET /minigame/sudokulevels?lastKey=...`. backend query PK="sudoku" lấy 10 level/trang + BatchGetItem lấy score user. trả `{ levels (kèm score), lastEvaluatedKey }`.

bắt đầu chơi: `POST /minigame/sudokulevels/start-game`, body: `{ gameId: "sudoku", levelId }`. backend: trừ sanity, sinh đề bằng sudokuGenerator → tạo session tạm (PK=userId, SK=session#sudoku, checkCount=5). trả `{ profile (budget mới), sessionData: { sessionId, seed, checkCount, puzzleGrid, status }, baseMapConfig }`. fe render game từ puzzleGrid.

kiểm tra bàn cờ: `POST /minigame/sudokulevels/check`, body: `{ currentGrid, actionLogs }`. backend: chạy anti-cheat + so sánh từng ô với solutionGrid, trừ checkCount. trả `{ checkCount, isBoardCorrect }`.

kết thúc: `POST /minigame/sudokulevels/end-session`, body: `{ finalGrid, actionLogs, endState: "quit"|"lost"|"submit" }`.
- quit/lost: hoàn 50% sanityCost, status = CANCELLED
- submit: anti-cheat + so sánh finalGrid. nếu đúng → tính score (bonus nếu checkCount full: ×1.5, penalty mỗi check mất: ×0.95), cộng eCoin, so sánh personalBest. trả `{ result, score, eCoinReward, isPB, profile, stat, timeSpent, levels (cập nhật score), lastEvaluatedKey }`

anti-cheat backend:
- thời gian hoàn thành < 5s + full board → cheat
- 2 thao tác cách nhau < 10ms → cheat (machine)
- chuỗi < 50ms liên tục >= 4 lần → cheat (bot)
- timestamp đi lùi → cheat (time travel)
- trung bình > 15 thao tác/giây → cheat

leaderboard global: `GET /minigame/leaderboard?gameId=sudoku`. backend đọc PK=leaderboard, SK=gameId. trả `{ topPlayers, expiresAt }`. cập nhật mỗi 10 phút bởi EventBridge Worker (Scan stats → sort → top 10 → ghi đè).

leaderboard bạn bè: `GET /minigame/leaderboard?gameId=sudoku` (tab friends). backend lấy danh sách bạn ACCEPTED → BatchGetItem stats#{gameId} → sort → top 10. realtime hơn global.

fe: cache trong redux, kiểm tra thời gian lastFetchedAt (5 phút), có nút refresh.

---

## STUDY PLANNER (100% LOCAL)

tất cả dữ liệu Study Planner lưu trong electron-store, KHÔNG gửi lên AWS server.

- **chat AI**: dùng Ollama (local) hoặc Gemini API (cần key). tối đa 5 phiên chat. lưu/xóa qua IPC: `study:saveChat`, `study:deleteChat`, `study:loadChats`
- **study plan**: tạo kế hoạch học tập bằng AI. tối đa 5 kế hoạch. IPC: `study:savePlan`, `study:deletePlan`, `study:loadPlans`
- **quiz**: tạo bộ câu hỏi từ study plan bằng AI. tối đa 10 lịch sử. IPC: `study:saveQuiz`, `study:deleteQuiz`, `study:loadQuizzes`
- **settings**: lưu provider AI (ollama/gemini) và gemini API key. IPC: `study:saveSettings`, `study:loadSettings`

khi hoàn thành quiz → fe gọi `POST /study-planner/quiz-submit`, body: `{ correctAnswersCount, totalQuestions }`:
- server cộng KP = correctAnswersCount × 10 vào budget
- gọi updateQuestProgress(userId, "COMPLETE_QUIZ", 1) + updateQuestProgress(userId, "CORRECT_QUIZ_ANSWER", correctAnswersCount)
- trả `{ earnedKP, questUpdate, profile, daily }`

---

## GHI NHỚ CHUNG

tất cả API (trừ `/version`) đều yêu cầu Cognito JWT token trong header Authorization (httpApi authorizer: myCognitoAuth).

response format chung: `{ success: true/false, ...data }`. lỗi: `{ success: false, message, ...latestData }` — server tự đính kèm dữ liệu mới nhất (profile, daily, inventory, gachaHistory, social) vào error response qua hàm `syncedErrorResponse()` để client tự sync ngay cả khi lỗi.

tất cả timestamp dùng `Date.now()` (milliseconds).

cấu trúc profile trong DB:
- PK: userId (sub từ Cognito)
- information: { name, email, avatarUrl }
- budget: { knowledgePoint, knowledgeCore, sanity, eCoin }
- studyStats: { rankScore, timeToStreak, streak, lastFocusDate }
- gachaStats: { pity4Star, pity5Star, is4StarGuaranteed, is5StarGuaranteed }
- equippedCosmetics: { equippedBackground, equippedButton, equippedFrame, equippedTitles }
- inventoryUpdatedAt, gachaHistoryUpdatedAt, friendUpdatedAt, avatarUpdatedAt, lastSearchAt, createdAt, updatedAt

quy tắc lưu trữ electron store:
- profile, inventory, friends, gachaHistory, daily, masterData → mỗi cái 1 key trong electron store
- inventory lưu theo cấu trúc: `{ background: { items: [...], lastEvaluatedKey }, frame: {...}, ... }`
- khi response trả profile mới (từ update-profile, change-cosmetics, gacha, shop, convert-points, update-avatar...) → lưu đè toàn bộ profile
- study planner data (chats, plans, quizzes, settings) → lưu riêng trong thư mục study-planner

quy tắc redux:
- mỗi khi nhận dữ liệu mới từ API → dispatch action cập nhật slice tương ứng
- UI luôn render từ redux state, không render trực tiếp từ API response
- khi cần dữ liệu offline → hydrate redux từ electron-store khi mở app
- inventory dispatch: `SET_INVENTORY` (ghi đè trang 1) hoặc `APPEND_INVENTORY` (nối thêm khi phân trang)
- gacha dispatch: `SET_GACHA_HISTORY` (ghi đè) hoặc `APPEND_GACHA_HISTORY` (nối thêm)
- social dispatch: `SET_SOCIAL` (ghi đè) hoặc `APPEND_SOCIAL` (nối thêm)

hàm `ingestServerData()` (syncService.js): xử lý đồng bộ mọi dữ liệu nhận từ server → dispatch redux + lưu electron-store. dùng chung cho sync-all, gacha, shop, và khi error response chứa data.

hàm `normalizeProfile()`: chuẩn hóa các trường budget (handle nhiều định dạng key cũ/mới) để đảm bảo tương thích.
