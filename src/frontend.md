khi người dùng đăng nhập, gọi /get-profile lấy thông tin người dùng về, fe lưu thông tin vào electron store mã hóa bằng safe storage, lưu vào redux và update state để render ra màn hình từ dữ liệu của redux

khi đăng nhập thành công sẽ gọi /sync-all để lấy tất cả thông tin của người dùng về máy,

có nút để ấn chỉnh sửa tên ở frontend, khi ấn đổi tên, validate giống với backend mới đc gọi API PUT /update-profile, body: { name }, hàm trả về thành công thì backend sẽ trả 1 profile.json mới, frontend lưu đè vào electron store mã hóa bằng safe storage, lưu vào redux và update state để render ra màn hình từ dữ liệu của redux (không cần gọi lại get profile).

mỗi khi mở app (sau đăng nhập), hoặc khi app từ background trở lại, fe gọi POST /sync-all, body gửi lên: { updatedAt, inventoryUpdatedAt, gachaHistoryUpdatedAt, friendUpdatedAt, getDaily }. lần đầu mở app thì gửi tất cả = null (hoặc không gửi gì), backend sẽ trả về đầy đủ: profile, inventory, gachaHistory, friends, daily. từ lần sau fe gửi kèm các timestamp đã lưu trong redux, backend so sánh từng mốc thời gian với profile hiện tại trên DB: module nào timestamp khác thì trả dữ liệu mới, module nào giống thì bỏ qua. fe nhận response, phần nào có dữ liệu thì lưu đè vào electron store + redux. phần nào không có (undefined) thì giữ nguyên dữ liệu cũ.

xử lý daily trong sync-all: backend luôn gọi hàm refresh daily để kiểm tra. nếu daily hết hạn thì tạo daily mới và luôn trả về cho client. nếu daily chưa hết hạn thì dựa vào cờ getDaily từ client để quyết định có gửi daily trong response hay không.

response trả về có dạng:
- profile: object profile đầy đủ (kèm cosmeticAssets đã map sẵn assetUrl từ bảng ItemData)
- inventory: mảng 60 item đầu tiên, inventoryLastKey (nếu có thì còn trang tiếp)
- gachaHistory: mảng 30 lịch sử đầu tiên, gachaHistoryLastKey
- friends: mảng 15 bạn bè đầu tiên (PENDING_IN, PENDING_OUT, ACCEPTED), friendsLastKey
- daily: object daily quest hiện tại (nếu có)

khi cần load thêm trang (infinite scroll), fe gọi riêng từng API:
- GET /sync-inventory?lastKey=... → trả về { inventory, lastEvaluatedKey }. mỗi trang 60 item.
- GET /sync-gacha-history?lastKey=... → trả về { gachaHistory, lastEvaluatedKey }. mỗi trang 30 bản ghi.
- GET /sync-friends?lastKey=... → trả về { friends, lastEvaluatedKey }. mỗi trang 15 bạn bè.
lastKey là JSON string đã encodeURIComponent, lấy từ lastEvaluatedKey của response trước. khi lastEvaluatedKey = null thì hết dữ liệu.

GET /sync-profile → fe gọi khi cần lấy lại profile mới nhất (ít dùng, thường sync-all đã đủ). response: { profile } (đã map cosmeticAssets).

GET /master-data → gọi 1 lần khi mở app, trả về { items } là mảng tất cả item trong game (background, frame, button, title...). fe lưu vào electron store dưới dạng itemDictionary (key là SK của item), dùng để hiển thị thông tin item ở inventory, shop, gacha... không cần gọi lại trừ khi user logout rồi login lại. server có cache nội bộ nên gọi nhiều cũng không tốn.

--- AVATAR ---

đổi ảnh đại diện có cooldown 7 ngày, fe phải check avatarUpdatedAt trong profile để hiển thị cooldown còn lại, disable nút đổi ảnh nếu chưa hết cooldown.

luồng đổi ảnh:
1. fe gọi POST /avatar/presign → backend kiểm tra cooldown, nếu ok trả về { uploadUrl, expiresIn: 300 }. nếu chưa hết cooldown trả 429 kèm { remainMs, availableAt }.
2. fe dùng uploadUrl (presigned URL) để PUT ảnh trực tiếp lên S3, content-type: image/jpeg, gửi binary ảnh. URL này hết hạn sau 5 phút.
3. sau khi PUT thành công, fe gọi POST /avatar/confirm (không cần body). backend kiểm tra cooldown lần nữa để tránh race condition, sau đó tự tính path avatar = "avatars/{userId}.jpg", ghi vào DB (information.avatarUrl và avatarUpdatedAt).
4. response confirm trả về { avatarUrl, avatarUpdatedAt }. fe lưu avatarUrl mới vào redux + electron store, update UI.

lưu ý: avatarUrl trong DB là path tương đối (vd: "avatars/userId.jpg"), fe phải tự ghép domain CDN phía trước để hiển thị. avatar mặc định khi tạo tài khoản lấy từ biến môi trường DEFAULT_AVATAR_URL. S3 key cố định theo userId nên đổi ảnh sẽ ghi đè file cũ, không tạo file mới.

--- TRANG BỊ COSMETICS ---

fe gọi PUT /change-cosmetics, body: { backgroundId, frameId, titles }. backgroundId là bắt buộc (luôn phải có background). frameId có thể null. titles là mảng tối đa 3 danh hiệu (có thể rỗng []).

backend dùng BatchGetItem kiểm tra user có sở hữu các item đó trong inventory không (PK = userId, SK = itemId), nếu không có trả 403. nếu hợp lệ, backend cập nhật equippedCosmetics trong profile (equippedBackground, equippedFrame, equippedTitles) và trả về { profile } mới. fe lưu đè profile vào redux + electron store, update UI (không cần gọi lại get-profile).

lưu ý: profile còn có equippedButton nhưng hiện tại chưa dùng trong API change-cosmetics (chỉ set khi khởi tạo).

fe phải lọc inventory theo itemType (background, frame, title) để hiển thị danh sách cho user chọn. chỉ hiện item user đã sở hữu.

--- SESSION HỌC ---

bắt đầu session: fe gọi POST /start-study-session, body: { mode: "casual" | "rank", durationMinutes }. mode casual cho phép dừng sớm (vẫn tính COMPLETED), mode rank phải học hết thời gian (dừng sớm = FAILED). backend tạo session với status PENDING trong bảng Study, trả { sessionId }. fe lưu sessionId vào state để dùng cho strike và end session. sessionId có dạng "session#{timestamp}".

trong khi học, nếu user vi phạm (rời app, chuyển tab...), fe gọi POST /strike, body: { sessionId }. backend tự tăng strikeCount, nếu đủ 3 lần thì auto FAILED (cập nhật status và endTime), trả { strikeCount, sessionEnded: true }. fe kiểm tra sessionEnded, nếu true thì hiện thông báo session đã thất bại. nếu false thì hiện cảnh báo strike (vd: "Cảnh cáo lần 1/3").

kết thúc session: fe gọi POST /end-study-session, body: { sessionId }. backend tự tính status dựa trên:
- strikeCount >= 3 → FAILED
- elapsed >= expected - 30s → COMPLETED (cho phép lệch 30s do network delay)
- casual mode dừng sớm → COMPLETED
- rank mode dừng sớm → FAILED
response trả { status, actualDurationSeconds, earnedPoints }. nếu COMPLETED + mode rank → earnedPoints = Math.floor(elapsed / 60) (điểm rank = số phút đã học), server cộng vào studyStats.rankScore trong profile. fe hiển thị kết quả, nếu có earnedPoints thì hiện animation cộng điểm. nếu session đã kết thúc trước đó (status !== PENDING) thì server trả lại thông tin session cũ mà không thay đổi gì.

sau khi end session, backend gọi hàm update quest progress (type = "FOCUS") để cập nhật tiến độ daily quest liên quan.

--- DAILY QUEST ---

fe gọi GET /daily để lấy danh sách daily quest hiện tại. backend lấy profile check streak, nếu daily hết hạn thì chạy thuật toán refresh daily (reset streak nếu lastFocusDate không liên tục, cập nhật timeToStreak về 30, tạo daily mới gồm 1 quest cố định focus_daily + 3 quest random + meta quest all_daily). response: { daily } chứa object daily với quests map bên trong.

mỗi quest có: type, name, description, target, knowledgePoint (phần thưởng), progress, isCompleted, isClaimed. fe hiển thị thanh progress = progress/target. khi isCompleted = true và isClaimed = false → hiện nút "Nhận thưởng".

khi ấn nhận thưởng: fe gọi POST /daily/claim, body: { questKey } (vd: "focus_daily", "all_daily"). backend dùng transaction kiểm tra quest đã hoàn thành chưa, đã nhận chưa, daily còn hạn không (expiresAt > now). nếu ok → cộng knowledgePoint vào budget.knowledgePoint trong profile, set isClaimed = true trong quests map. trả về { rewardKnowledgePoint, newKnowledgePoint, updatedAt }. fe cập nhật budget.knowledgePoint trong redux, đánh dấu quest đã claimed, hiển thị animation nhận thưởng.

quest "all_daily": hoàn thành 4 quest thường → all_daily_progress đủ 4 → all_daily_completed = true → cho phép nhận thưởng. khi claim all_daily thì set all_daily_claimed = true. fe kiểm tra all_daily_completed trong daily để biết có thể nhận thưởng chưa.

tiến độ quest được backend tự cập nhật khi user thực hiện hành động (end session học, end session game, gacha...) thông qua hàm updateQuestProgress(userId, type, amount). fe không cần gọi API riêng để update progress. fe chỉ cần gọi GET /daily hoặc sync-all (với getDaily: true) để lấy progress mới nhất.

--- GACHA ---

fe gọi POST /gacha, body: { count: 1 | 10 }. chi phí: 1 lượt = 160 knowledgeCore. nếu không đủ core, backend tự đổi knowledgePoint sang core (tỉ giá 160 KP = 1 Core). nếu vẫn không đủ → trả 400.

thuật toán gacha chạy server-side: backend lấy gachaStats (pity4Star, pity5Star, is4StarGuaranteed, is5StarGuaranteed) từ profile, chạy hàm rollRarityValue cho từng lượt dựa vào pity hiện tại. rarity map gồm các giá trị: "3" (sanity), "3.5" (4★ thường), "4L" (4★ limited), "4.5" (5★ thường), "5L" (5★ limited). dựa vào rarity map, lấy item tương ứng từ bảng ItemData (collectFrom = "gacha", rarity và isLimited tương ứng). rarity 3 thì random sanity 1-10.

response trả:
- results: mảng item đã quay, mỗi item có { rarity, name, imageUrl, itemType, SK } hoặc { rarity: "3", name: "Sanity", sanityAmount } nếu ra sanity.
- newBudget: { knowledgeCore, knowledgePoint, sanity } → fe cập nhật budget trong redux.
- newGachaStats: { pity4Star, pity5Star, is4StarGuaranteed, is5StarGuaranteed } → fe lưu để hiển thị pity counter nếu cần.
- updatedAt

backend dùng transaction để: tạo inventory items (rarity != 3), ghi gacha history (mọi rarity, SK là timestamp + i ms để đảm bảo thứ tự), cập nhật budget và gachaStats trong profile, cập nhật inventoryUpdatedAt và gachaHistoryUpdatedAt. transaction chia batch 25 items.

fe hiển thị animation quay gacha, rồi reveal từng item. item 5 sao = hiệu ứng đặc biệt, 4 sao = hiệu ứng trung bình, 3 sao (sanity) = hiệu ứng đơn giản. sau khi quay xong, fe cập nhật inventory trong redux (thêm item mới vào), cập nhật budget, cập nhật gachaStats.

hệ thống pity: soft pity 5★ bắt đầu từ lượt 74 (tỉ lệ tăng 6% mỗi lượt), hard pity 5★ ở lượt 90 (rate = 100%). soft pity 4★ từ lượt 9 (tỉ lệ tăng 20% mỗi lượt), hard pity 4★ ở lượt 10. fe có thể hiển thị số pity hiện tại cho user biết.

50/50: khi ra 5★, có 50% ra limited (5L), 50% ra thường (4.5). nếu thua 50/50 (ra thường 4.5) → is5StarGuaranteed = true → lần 5★ tiếp theo đảm bảo ra limited. 4★ tương tự (3.5 vs 4L).

--- CURRENCY EXCHANGE ---

fe gọi POST /currency/exchange, body: { amount } (số knowledgeCore muốn mua). tỉ giá cố định: 160 KP = 1 Core. fe validate amount > 0 và là số nguyên trước khi gọi. backend kiểm tra đủ KP không bằng ConditionExpression, nếu thiếu trả 402. nếu ok trả { newBudget: { knowledgePoint, knowledgeCore }, updatedAt }. fe cập nhật budget trong redux.

--- SHOP ---

fe gọi GET /shop?shopId=eCoinShop (hoặc shopId khác). backend lấy cấu hình shop từ ItemData (PK=shop, SK=shopId), kiểm tra expiresAt chưa hết hạn. sau đó duyệt từng item trong activeItems, query inventory xem user đã sở hữu chưa (PK=userId, SK=itemSK với itemSK = itemId bỏ prefix "item#"), đánh dấu owned. trả { shop } chứa thông tin shop và activeItems đã bổ sung trường owned: true/false. fe hiển thị danh sách item, item đã owned thì disable nút mua / hiện "Đã sở hữu".

mua item: fe gọi POST /shop/buy, body: { shopId, itemId }. itemId là ID của item trong shop (vd: "item#frame_stone_1"). backend dùng transaction:
- kiểm tra shop còn hạn (expiresAt)
- kiểm tra user chưa sở hữu item (attribute_not_exists)
- kiểm tra đủ tiền (ConditionExpression budget.currency = requiredBalance)
- trừ tiền tương ứng (currencyType từ shopItem: eCoin, knowledgePoint...)
- tạo bản ghi inventory mới (PK=userId, SK=itemSK, collectFrom=shopId)
- cập nhật updatedAt và inventoryUpdatedAt
response trả { newBalance, currency, item, updatedAt }. fe cập nhật budget (trừ tiền), thêm item vào inventory trong redux, đánh dấu item đã owned trong shop UI. lưu state mới xuống electron store.

nếu shop có expiresAt, fe hiển thị countdown thời gian còn lại. khi hết hạn → ẩn shop hoặc hiện "Shop đã hết hạn".

--- BẠN BÈ ---

fe gọi GET /friends?lastKey=... để lấy danh sách bạn bè, phân trang 60 item. response: { friends, lastEvaluatedKey }. mỗi friend có: SK (userId của bạn), friendName, friendAvatarUrl, status (PENDING_IN, PENDING_OUT, ACCEPTED), createdAt, updatedAt.

fe phân loại hiển thị:
- ACCEPTED: bạn bè đã xác nhận → hiện trong danh sách bạn bè, có nút "Xóa bạn"
- PENDING_IN: lời mời đến → hiện trong tab "Lời mời", có nút "Chấp nhận" và "Từ chối"
- PENDING_OUT: lời mời đã gửi → hiện "Đang chờ xác nhận", có nút "Hủy lời mời"

gửi lời mời: fe gọi POST /friends/request, body: { targetUserId }. backend kiểm tra bản ghi PK=userId, SK=targetUserId đã tồn tại chưa (nếu có trả 409), lấy profile cả 2 người, dùng transaction tạo 2 bản ghi (PENDING_OUT cho mình kèm thông tin bạn, PENDING_IN cho đối phương kèm thông tin mình, ConditionExpression attribute_not_exists), cập nhật friendUpdatedAt cho CẢ 2 người. response: { message, updatedAt }.

chấp nhận: fe gọi POST /friends/accept, body: { targetUserId }. backend kiểm tra bản ghi PK=userId, SK=targetUserId có đúng status = PENDING_IN không. dùng transaction cập nhật cả 2 bản ghi thành ACCEPTED, cập nhật friendUpdatedAt cho cả 2. response: { message, updatedAt }.

xóa bạn / từ chối / hủy lời mời: fe gọi POST /friends/remove, body: { targetUserId }. backend dùng transaction xóa cả 2 bản ghi (A→B và B→A), cập nhật friendUpdatedAt cho cả 2. response: { message, updatedAt }. dùng chung cho cả 3 hành động.

sau mỗi hành động bạn bè, fe nên gọi lại GET /friends hoặc sync-all để cập nhật danh sách.

--- TÌM KIẾM USER ---

fe gọi GET /friends/search?q=keyword (tối thiểu 2 ký tự). backend tìm bằng OpenSearch (index "users", multi-match trên name và email, fuzzy, loại trừ bản thân), trả { users } mảng tối đa 10 kết quả, mỗi user có: userId, name, avatarUrl, streak, titles. fe hiển thị danh sách kết quả, mỗi user có nút "Kết bạn" (gọi /friends/request). fe tự loại bỏ những user đã là bạn hoặc đã gửi lời mời (so sánh với danh sách friends trong redux).

lưu ý: dữ liệu OpenSearch được sync tự động từ DynamoDB Streams (Lambda streamIndexer), khi profile thay đổi thì index users được cập nhật (userId, name, email, avatarUrl, streak, equippedTitles).

--- MINIGAME ---

lấy danh sách màn chơi: fe gọi GET /minigame/levels?gameId=sudoku&lastKey=..., phân trang 20 item. backend query bảng Minigame (PK=gameId, filter attribute_exists(sanityCost) để loại session/stats/leaderboard), lấy trường PK, SK, name, sanityCost, requiredLevel, maxScoreCap, eCoin (không lấy baseMapConfig). đồng thời BatchGetItem score của userId (PK=userId, SK=score#gameId#levelId). gộp vào response: { levels, lastEvaluatedKey }. mỗi level có thêm score: null nếu chưa chơi, hoặc { personalBest, achievedAt } nếu đã chơi.

fe hiển thị danh sách màn, màn nào có requiredLevel thì kiểm tra user đã có score cho level đó chưa → nếu chưa thì khóa (hiển thị ổ khóa). sanityCost hiển thị bên cạnh mỗi màn. score hiển thị personalBest nếu có.

bắt đầu chơi: fe gọi POST /minigame/start, body: { gameId, levelId }. backend dùng transaction:
- lấy thông tin level (sanityCost, requiredLevel, baseMapConfig)
- kiểm tra sanity đủ không → nếu thiếu trả 402 kèm { currentSanity, updatedAt }
- kiểm tra requiredLevel: tìm score#gameId#requiredLevel xem đã chơi chưa → nếu chưa trả 403
- tạo seed ngẫu nhiên, lấy solutionGrid từ baseMapConfig (hoặc từ seed tùy game)
- tạo session (PK=userId, SK=session#gameId, status=PENDING, lưu seed, solutionGrid, startTime, sanityCost, levelId)
- trừ sanity trong profile
trả { seed, baseMapConfig (không có solutionGrid), newBudget, updatedAt }. fe dùng seed + baseMapConfig để generate bản đồ/câu đố trên client. fe bắt đầu đếm thời gian từ lúc nhận response.

trong lúc chơi game, fe lưu log thao tác: mỗi thao tác ghi { ts (timestamp ms), action, ... }. nếu client bị tắt/crash thì trước khi tắt gửi request end session tính là thua.

kết thúc chơi: fe gọi POST /minigame/end, body: { gameId, finalGrid, actionLog }. finalGrid: với sudoku là chuỗi lời giải, với minesweeper là "WIN" hoặc trạng thái board. backend tự tìm session PENDING của userId (PK=userId, SK=session#gameId), lấy solutionGrid và startTime ra. anti-cheat:
- elapsed < 5 giây → thua (quá nhanh)
- kiểm tra actionLog: mỗi cặp thao tác liên tiếp phải cách >= 200ms
- so sánh finalGrid với solutionGrid
pass cả 3 → thắng.

response: { isWin, score, scoreUpdated, oldPersonalBest, earnedECoin, earnedSanity, newBudget, updatedAt }.
- isWin = true: earnedECoin = eCoin của màn đó, score tính từ maxScoreCap giảm dần theo thời gian chơi. nếu scoreUpdated = true → hiện "Kỷ lục mới!". backend tạo/cập nhật bản ghi score#gameId#levelId và stats#gameId (levelsCompleted, totalScore, displayInfo).
- isWin = false: earnedSanity = 50% sanityCost đã tiêu. hiện animation thua.
fe cập nhật budget trong redux (eCoin, sanity).

backend sau khi end game thắng sẽ gọi updateQuestProgress (type = PLAY_SUDOKU / PLAY_MINESWEEPER) để cập nhật quest.

leaderboard toàn cầu: fe gọi GET /minigame/leaderboard/global?gameId=sudoku. backend đọc bản ghi PK=globalLeaderboard, SK=gameId. trả { leaderboard, gameId } mảng top 10 player, mỗi entry có: rank, userId, totalScore, levelsCompleted, lastUpdatedAt, displayInfo { name, avatarUrl, equippedFrame }. cập nhật mỗi 10 phút bởi EventBridge → Lambda leaderboardWorker (query GSI gameId-totalScore-index, lấy top 10, ghi đè vào globalLeaderboard).

leaderboard bạn bè: fe gọi GET /minigame/leaderboard/friends?gameId=sudoku. backend lấy danh sách bạn ACCEPTED từ Social table, BatchGetItem stats#gameId của tất cả (bao gồm bản thân), sort totalScore giảm dần, lấy top 10. trả { leaderboard, gameId } cùng format với global. realtime hơn global vì tính trực tiếp.

--- GHI NHỚ CHUNG ---

tất cả API đều yêu cầu Cognito JWT token trong header Authorization (httpApi authorizer: myCognitoAuth). fe dùng Amplify hoặc tự gắn token.

response format chung: { success: true/false, ...data } hoặc { success: false, message: "..." }. successResponse và errorResponse được định nghĩa trong response.mjs.

tất cả timestamp trong hệ thống dùng Date.now() (milliseconds). fe so sánh updatedAt giữa local và server để biết cần sync không.

cấu trúc profile trong DB:
- PK: userId
- information: { name, email, avatarUrl }
- budget: { knowledgePoint, knowledgeCore, sanity, eCoin }
- studyStats: { rankScore, timeToStreak, streak, lastFocusDate }
- gachaStats: { pity4Star, pity5Star, is4StarGuaranteed, is5StarGuaranteed }
- equippedCosmetics: { equippedBackground, equippedButton, equippedFrame, equippedTitles }
- inventoryUpdatedAt, gachaHistoryUpdatedAt, friendUpdatedAt, avatarUpdatedAt, createdAt, updatedAt

quy tắc lưu trữ electron store:
- profile, inventory, friends, gachaHistory, daily, masterData → mỗi cái 1 key trong electron store, mã hóa safe storage.
- budget, gachaStats, studyStats, equippedCosmetics → nằm trong profile, không lưu riêng.
- khi response trả về profile mới (từ update-profile, change-cosmetics, gacha, shop...) → lưu đè toàn bộ profile.

quy tắc redux:
- mỗi khi nhận dữ liệu mới từ API → dispatch action cập nhật slice tương ứng.
- UI luôn render từ redux state, không render trực tiếp từ API response.
- khi cần dữ liệu offline → hydrate redux từ electron store khi mở app.
