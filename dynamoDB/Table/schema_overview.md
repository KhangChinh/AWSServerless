# DynamoDB Schema Overview

## Table User

### profile.json
```json
{
    "PK": "usr_12345",
    "information": {
        "name": "Nguyễn Văn A",
        "email": "a@example.com",
        "avatarUrl": "https://cloudfront.net/avatar/usr_12345.jpg"
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
        "lastFocusDate": 20616
    },
    "gachaStats": {
        "pity4Star": 0,
        "pity5Star": 0,
        "is4StarGuaranteed": false,
        "is5StarGuaranteed": false
    },
    "equippedCosmetics": {
        "equippedTheme": "default_dark",
        "equippedFrame": null,
        "equippedTitles": []
    },
    "inventoryUpdatedAt": 1717768800000,
    "gachaHistoryUpdatedAt": 1717768800000,
    "friendUpdatedAt": 1717768800000,
    "avatarUpdatedAt": 1717768800000,
    "createdAt": 1767225600000,
    "updatedAt": 1717769100000
}
```

---

## Table Inventory

### inventory.json
```json
{
    "PK": "usr_12345",
    "SK": "cyberpunk_2077",
    "rarity": "5",
    "name": "Theme Cyberpunk",
    "imageUrl": "https://cloudfront.net/items/theme_cyberpunk.jpg",
    "itemType": "theme",
    "collectFrom": "eCoinShop",
    "acquiredAt": "2026-06-03T11:15:00.000Z"
}
```

---

## Table GachaHistory

### history.json
```json
{
    "PK": "usr_12345",
    "SK": 1717416989000,
    "name": "Theme Cyberpunk",
    "rarity": "5",
    "sanityAmount": 0,
    "expiresAt": 1780444800
}
```

---

## Table ItemData

### item.json
```json
{
    "PK": "item",
    "SK": "cyberpunk",
    "rarity": "5",
    "name": "Theme Cyberpunk",
    "imageUrl": "https://cloudfront.net/items/theme_cyberpunk.jpg",
    "assets": {
        "css": "https://cloudfront.net/themes/cyberpunk/style.css",
        "bgm": "https://cloudfront.net/themes/cyberpunk/music.mp3",
        "particles": "https://cloudfront.net/themes/cyberpunk/effects.json"
    },
    "itemType": "theme",
    "currencyType": "eCoin",
    "price": 500,
    "collectFrom": "eCoinShop",
    "isLimited": true
}
```

### shop.json
```json
{
    "PK": "shop",
    "SK": "eCoinShop",
    "activeItems": [
        {
            "itemId": "item#frame_stone_1",
            "name": "Khung Thạch Anh",
            "imageUrl": "https://cloudfront.net/items/theme_cyberpunk.jpg",
            "rarity": 4,
            "itemType": "frame",
            "currencyType": "eCoin",
            "price": 100
        },
        {
            "itemId": "item#frame_stone_2",
            "name": "Khung Obsidian",
            "imageUrl": "https://cloudfront.net/items/theme_cyberpunk.jpg",
            "rarity": 5,
            "itemType": "frame",
            "currencyType": "eCoin",
            "price": 2500
        }
    ],
    "expiresAt": 1780444800
}
```

---

## Table Minigame

### level.json (sudoku)
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
        "emptyCellsCount": 43,
        "initialGrid": "530070000600195000098000060800060003400803001700020006060000280000419005000080079",
        "solutionGrid": "534678912672195348198342567859761423426853791713924856961537284287419635345286179"
    }
}
```

### sudokuLevel.json
```json
{
    "PK": "sudoku",
    "SK": "easy_2",
    "name": "Sudoku Dễ 2",
    "sanityCost": 100,
    "requiredLevel": "easy_1",
    "maxScoreCap": 1000,
    "eCoin": 10,
    "baseMapConfig": {
        "gridSize": "9x9",
        "emptyCellsCount": 43
    }
}
```

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

### score.json
```json
{
    "PK": "usr_12345",
    "SK": "score#sudoku#hard_1",
    "personalBest": 345,
    "achievedAt": 1749723753
}
```

### session.json
```json
{
    "PK": "usr_12345",
    "SK": "session#sudoku",
    "levelId": "easy_1",
    "startTime": 1717076586,
    "sanityCost": 100,
    "status": "PENDING",
    "seed": "abc123xyz",
    "solutionGrid": "534678912..."
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
        "avatarUrl": "https://cloudfront.net/avatar/usr_12345.jpg",
        "equippedFrame": "cyberpunk"
    }
}
```

---

## Table Quest

### quest.json
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

### daily.json
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
            "progress": 1,
            "knowledgePoint": 120,
            "isCompleted": true,
            "isClaimed": false
        },
        "all_daily": {
            "type": "COMPLETE_DAILY",
            "name": "Nỗ lực không ngừng",
            "description": "Hoàn thành 4 nhiệm vụ ngày.",
            "target": 4,
            "progress": 1,
            "knowledgePoint": 100,
            "isCompleted": false,
            "isClaimed": false
        }
    },
    "expiresAt": 1780444800
}
```

---

## Table Social

### friend.json
```json
{
    "PK": "usr_12345",
    "SK": "usr_98765",
    "friendName": "Player B",
    "friendAvatarUrl": "https://cdn.domain.com/avatar_b.png",
    "status": "PENDING_OUT",
    "createdAt": 1717722000,
    "updatedAt": 1717722000
}
```

---

## Table Study

### session.json
```json
{
    "PK": "usr_12345",
    "SK": 1717725600,
    "mode": "rank",
    "durationMinutes": 60,
    "strikeCount": 1,
    "status": "COMPLETED",
    "expiresAt": 1780444800
}
```
