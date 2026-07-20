# DynamoDB Schema Overview

## Table User

### profile.json
```json
{
    "PK": "usr_12345",
    "information": {
        "name": "Nguyễn Văn A",
        "email": "a@example.com",
        "avatarUrl": "avatars/usr_12345.jpg?t=1717769100000"
    },
    "budget": {
        "knowledgePoint": 1500,
        "knowledgeCore": 0,
        "sanity": 0,
        "eCoin": 0
    },
    "studyStats": {
        "rankScore": 0,
        "timeToStreak": 30,
        "streak": 0,
        "lastFocusDate": null
    },
    "gachaStats": {
        "pity4Star": 0,
        "pity5Star": 0,
        "is4StarGuaranteed": false,
        "is5StarGuaranteed": false
    },
    "equippedCosmetics": {
        "equippedBackground": "bg_default",
        "equippedButton": null,
        "equippedFrame": "frame_none",
        "equippedTitles": ["title_none"]
    },
    "inventoryUpdatedAt": 1717768800000,
    "gachaHistoryUpdatedAt": 1717768800000,
    "friendUpdatedAt": 1717768800000,
    "avatarUpdatedAt": 1717768800000,
    "lastSearchAt": 1717769100000,
    "createdAt": 1767225600000,
    "updatedAt": 1717769100000
}
```

> Ghi chú:
> - `avatarUrl` lưu dạng path tương đối (VD: `avatars/usr_12345.jpg?t=...`), frontend tự ghép domain CDN.
> - `lastSearchAt` dùng cho rate-limit tìm kiếm bạn bè (cooldown 5 giây).
> - `equippedCosmetics` lưu SK của item trong ItemData, khi sync/profile trả về sẽ được map sang object có `{ id, name, assets }` qua hàm `mapCosmeticAssets()`.
> - Khi khởi tạo user, các item mặc định (bg_default, frame_none, title_none) được lấy từ ItemData và tạo sẵn trong Inventory.

---

## Table Inventory

### inventory.json
```json
{
    "PK": "usr_12345",
    "SK": "cyberpunk_2077",
    "rarity": 5,
    "name": "Theme Cyberpunk",
    "assets": {
        "css": "theme/cyberpunk_2077/assets/style.css",
        "bgm": "theme/cyberpunk_2077/assets/music.mp3",
        "particles": "theme/cyberpunk_2077/assets/effects.json"
    },
    "itemType": "theme",
    "collectFrom": "eCoinShop",
    "acquiredAt": "2026-06-03T11:15:00.000Z"
}
```

> Ghi chú:
> -  `assets` lưu path tương đối, frontend ghép CDN domain.
> - `collectFrom` ghi nhận nguồn gốc vật phẩm: `"gacha"`, `"eCoinShop"`, hoặc `"system"` (mặc định khi khởi tạo).
> - **GSI `ItemTypeIndex`**: Partition Key = `PK` (userId), Sort Key = `itemType`. Dùng để query inventory theo loại vật phẩm (background, frame, title, button).
> - Phân trang: mỗi trang 10 item, query theo `ItemTypeIndex` với `ScanIndexForward: false` (mới nhất trước).

---

## Table GachaHistory

### history.json
```json
{
    "PK": "usr_12345",
    "SK": 1717416989000,
    "name": "Theme Cyberpunk",
    "rarity": 5,
    "sanityAmount": 0,
    "expiresAt": 1780444800
}
```

> Ghi chú:
> - `SK` là timestamp (milliseconds) + index offset để đảm bảo thứ tự khi roll x10 (VD: now+0, now+1, ..., now+9).
> - `sanityAmount > 0` khi rarity = 3 (random 50-100, bước 5) hoặc khi vật phẩm bị trùng và quy đổi sang sanity (5★ = 150, 4★ = 80).
> - `expiresAt` là TTL 30 ngày (DynamoDB tự xóa sau thời gian này).
> - Phân trang: 30 bản ghi/trang, ScanIndexForward = false (mới nhất trước).

---

## Table ItemData

### item.json (PK = "item")
```json
{
    "PK": "item",
    "SK": "cyberpunk_2077",
    "rarity": 5,
    "name": "Theme Cyberpunk",
    "assets": {
        "css": "theme/cyberpunk_2077/assets/style.css",
        "bgm": "theme/cyberpunk_2077/assets/music.mp3",
        "particles": "theme/cyberpunk_2077/assets/effects.json"
    },
    "itemType": "theme",
    "currencyType": "eCoin",
    "price": 500,
    "collectFrom": "eCoinShop",
    "isLimited": true
}
```

> Ghi chú:
> - Item được upload tự động qua S3 trigger: upload file `.zip` vào `uploads/items/` → Lambda `processZip` giải nén, upload assets lên S3, ghi metadata vào ItemData.
> - `collectFrom` xác định nguồn lấy: `"gacha"` (pool gacha), `"eCoinShop"` (bán trong shop), hoặc `"system"` (mặc định).
> - `isLimited` ảnh hưởng cơ chế 50/50 trong gacha: limited = trúng rate, không limited = lệch rate.
> - Master Data (tất cả PK = "item") được cache trong Lambda memory và trả về cho client qua API `/master-data`.

### shop.json (PK = "shop")
```json
{
    "PK": "shop",
    "SK": "eCoinShop",
    "activeItems": [
        {
            "itemId": "frame_stone_1",
            "name": "Khung Thạch Anh",
            "rarity": 4,
            "itemType": "frame",
            "currencyType": "eCoin",
            "price": 100
        }
    ],
    "expiresAt": 1780444800,
    "updatedAt": 1717769100
}
```

> Ghi chú:
> - Shop được refresh tự động mỗi tuần vào 00:00 Thứ 2 (giờ VN) bởi EventBridge → Lambda `handleRefresheCoinShop`.
> - Mỗi lần refresh: random 3 item từ pool `collectFrom = "eCoinShop"`, tính expiresAt = 7 ngày sau.
> - Khi client GET `/shop/ecoin`, server BatchGetItem kiểm tra inventory để gắn cờ `isOwned: true/false` cho từng item.

---

## Table Minigame

### level.json (Sudoku)
```json
{
    "PK": "sudoku",
    "SK": "easy_1",
    "name": "Sudoku Dễ 1",
    "sanityCost": 100,
    "requiredLevel": "easy_0",
    "maxScoreCap": 1000,
    "eCoin": 10,
    "baseMapConfig": {
        "gridSize": "9x9",
        "emptyCellsCount": 43
    }
}
```

> Ghi chú:
> - `baseMapConfig` chỉ chứa cấu hình để sinh đề, **không chứa `solutionGrid`** hay `initialGrid`.
> - Khi start game, server dùng `sudokuGenerator` để sinh `puzzleGrid` + `solutionGrid` từ `baseMapConfig`.
> - Level data được upload qua S3 trigger: upload file `.json` vào `uploads/levels/` → Lambda `processJson` ghi vào MINIGAME_TABLE.

### minesweeperLevel.json
```json
{
    "PK": "minesweeper",
    "SK": "easy_2",
    "name": "Minesweeper Easy 2",
    "sanityCost": 100,
    "requiredLevel": "easy_1",
    "maxScoreCap": 1000,
    "eCoin": 10,
    "baseMapConfig": {
        "gridSize": "9x9",
        "mineCount": 10,
        "safeStartRadius": 1,
        "seedMode": "deterministic"
    }
}
```

### session.json (Minigame — Stateless với gameToken) ⚠️ KHÔNG LƯU VÀO DB
```
Kiến trúc Stateless: Server KHÔNG lưu session vào Database.
Thay vào đó, server tạo session tạm (PK=userId, SK=session#gameId) trong Minigame Table
với status PENDING, seed, solutionGrid, checkCount để phục vụ các API check và end-session.

Khi start-game: server sinh seed → tạo puzzleGrid + solutionGrid → lưu session tạm → trả puzzleGrid cho client.
Khi end-session: server đọc session tạm → so sánh finalGrid với solutionGrid → tính điểm → đổi status → trả kết quả.
```

```json
{
    "PK": "usr_12345",
    "SK": "session#sudoku",
    "levelId": "easy_1",
    "startTime": 1717076586000,
    "sanityCost": 100,
    "status": "PENDING",
    "checkCount": 5,
    "seed": "abc123xyz",
    "solutionGrid": "534678912672195348..."
}
```

> Ghi chú:
> - `checkCount` bắt đầu = 5, mỗi lần client gọi `/minigame/sudokulevels/check` sẽ trừ 1. Hết 0 thì không check được nữa.
> - `status`: `PENDING` (đang chơi), `COMPLETED` (thắng), `CANCELLED` (thua/thoát).
> - Khi end-session thắng và không dùng hết checkCount: score × 1.5 và eCoin × 1.5. Mỗi checkCount mất: score × 0.95^n.

### score.json
```json
{
    "PK": "usr_12345",
    "SK": "score#sudoku#hard_1",
    "personalBest": 345,
    "achievedAt": 1749723753
}
```

### stats.json
```json
{
    "PK": "usr_12345",
    "SK": "stats#sudoku",
    "gameId": "sudoku",
    "totalScore": 34567,
    "levelsCompleted": 10,
    "lastUpdatedAt": 1749723753,
    "displayInfo": {
        "name": "Nguyễn Văn A",
        "avatarUrl": "avatars/usr_12345.jpg",
        "equippedFrame": "cyberpunk_2077"
    }
}
```

> Ghi chú:
> - `displayInfo` được cập nhật mỗi khi user thắng game, lấy từ profile hiện tại.
> - `totalScore` = tổng personalBest của tất cả level đã chơi. Khi vượt PB: cộng chênh lệch (newScore - oldPB).

### leaderboard.json (Global — Tự động cập nhật)
```json
{
    "PK": "leaderboard",
    "SK": "sudoku",
    "topPlayers": [
        {
            "userId": "usr_12345",
            "totalScore": 34567,
            "levelsCompleted": 10,
            "displayInfo": {
                "name": "Nguyễn Văn A",
                "avatarUrl": "avatars/usr_12345.jpg",
                "equippedFrame": "cyberpunk_2077"
            }
        }
    ],
    "expiresAt": 1717770260
}
```

> Ghi chú:
> - Cập nhật mỗi 10 phút bởi EventBridge → Lambda `handleLeaderboardWorker`.
> - Worker dùng `ScanCommand` filter `SK = stats#gameId`, sort `totalScore` giảm dần, lấy top 10.
> - `expiresAt` = thời điểm hiện tại + 11 phút. Client dùng để biết khi nào cần refresh.
> - Leaderboard bạn bè: tính realtime bằng cách lấy danh sách bạn ACCEPTED → BatchGetItem stats → sort → top 10.

---

## Table Quest

### quest.json (Template — PK = "quest")
```json
{
    "PK": "quest",
    "SK": "focus_daily",
    "type": "FOCUS",
    "name": "Học mỗi ngày",
    "description": "Hoàn thành 30 phút học tập",
    "target": 30,
    "knowledgePoint": 150
}
```

> Ghi chú:
> - Quest templates được upload qua S3 trigger: upload `.json` vào `uploads/quests/` → Lambda `processJson` ghi vào QUEST_TABLE.
> - Các `type` hiện có: `FOCUS`, `PLAY_SUDOKU`, `PLAY_MINESWEEPER`, `GACHA`, `COMPLETE_DAILY`, `COMPLETE_QUIZ`, `CORRECT_QUIZ_ANSWER`.
> - `all_daily` là meta quest cố định, hoàn thành khi 4 quest thường khác hoàn thành (target = 4).

### daily.json (User Daily — PK = userId)
```json
{
    "PK": "usr_12345",
    "SK": "daily",
    "quests": {
        "focus_daily": {
            "type": "FOCUS",
            "name": "Học mỗi ngày",
            "description": "Hoàn thành 30 phút học tập",
            "target": 30,
            "progress": 15,
            "knowledgePoint": 150,
            "isCompleted": false,
            "isClaimed": false
        },
        "play_minesweeper_1": {
            "type": "PLAY_MINESWEEPER",
            "name": "Gỡ mìn mỗi ngày",
            "description": "Hoàn thành 1 ván Minesweeper.",
            "target": 1,
            "progress": 0,
            "knowledgePoint": 120,
            "isCompleted": false,
            "isClaimed": false
        },
        "complete_quiz_1": {
            "type": "COMPLETE_QUIZ",
            "name": "Kiểm tra kiến thức",
            "description": "Hoàn thành 1 bộ câu hỏi.",
            "target": 1,
            "progress": 0,
            "knowledgePoint": 100,
            "isCompleted": false,
            "isClaimed": false
        },
        "correct_quiz_3": {
            "type": "CORRECT_QUIZ_ANSWER",
            "name": "Trả lời chính xác",
            "description": "Trả lời đúng 5 câu.",
            "target": 5,
            "progress": 0,
            "knowledgePoint": 80,
            "isCompleted": false,
            "isClaimed": false
        },
        "all_daily": {
            "type": "COMPLETE_DAILY",
            "name": "Nỗ lực không ngừng",
            "description": "Hoàn thành 4 nhiệm vụ ngày.",
            "target": 4,
            "progress": 0,
            "knowledgePoint": 100,
            "isCompleted": false,
            "isClaimed": false
        }
    },
    "expiresAt": 1780444800
}
```

> Ghi chú:
> - Daily được tạo/refresh bởi hàm `refreshDaily()`: 1 quest cố định (focus_daily) + 1 meta quest cố định (all_daily) + 3 quest random.
> - `expiresAt` = 00:00:00 UTC ngày hôm sau (tính bằng giây).
> - Tiến độ quest được cập nhật tự động bởi server khi user thực hiện hành động (end focus session, end game, gacha, quiz submit...) thông qua hàm `updateQuestProgress(userId, type, amount)`.

---

## Table Social

### friend.json
```json
{
    "PK": "usr_12345",
    "SK": "usr_98765",
    "friendName": "Player B",
    "friendAvatarUrl": "avatars/usr_98765.jpg",
    "status": "PENDING_OUT",
    "createdAt": 1717722000,
    "updatedAt": 1717722000,
    "expiresAt": 1720314000
}
```

> Ghi chú:
> - `status`: `PENDING_OUT` (đã gửi lời mời), `PENDING_IN` (nhận lời mời), `ACCEPTED` (bạn bè).
> - Mỗi hành động kết bạn tạo 2 bản ghi song song (A→B và B→A) bằng Transaction.
> - `expiresAt` = TTL 30 ngày cho lời mời chưa được phản hồi (DynamoDB tự xóa).
> - Phân trang: 60 bạn/trang cho API `/friends`, 10 bạn/trang cho sync-social.
> - Chống spam: giới hạn tối đa 50 lời mời PENDING_OUT chưa được phản hồi.

---

## Table Study

### session.json
```json
{
    "PK": "usr_12345",
    "SK": "session#1280444800",
    "mode": "rank",
    "startTime": "2026-06-03T11:15:00.000Z",
    "endTime": "2026-06-03T12:15:00.000Z",
    "rankPoints": 60,
    "durationMinutes": 60,
    "strikeCount": 1,
    "status": "COMPLETED",
    "expiresAt": 1780444800
}
```

> Ghi chú:
> - `mode`: `"casual"` (cho phép dừng sớm, vẫn COMPLETED) hoặc `"rank"` (phải học đủ thời gian, dừng sớm = FAILED).
> - `strikeCount` do server quản lý qua API `/strike`. Khi ≥ 3 → auto FAILED.
> - `rankPoints` = số phút đã học (chỉ khi mode = rank và COMPLETED). Được cộng vào `studyStats.rankScore` trong profile.
> - `expiresAt` = TTL 6 tháng.
> - Thuật toán quyết định status (100% server-side):
>   1. strikeCount ≥ 3 → FAILED
>   2. elapsed ≥ expected - 30s → COMPLETED
>   3. casual mode dừng sớm → COMPLETED
>   4. rank mode dừng sớm → FAILED
