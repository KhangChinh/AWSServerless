# Workflow Minesweeper

## Mục tiêu
Làm cho mỗi lần chơi là một session riêng theo từng user bằng cách server tự tạo seed mìn và chỉ lưu seed đó trong `active_game.json`.

## Cấu trúc dữ liệu
### Config level tĩnh
Lưu trong `minigame.json`.

```json
{
  "PK": "minigame",
  "SK": "minesweeper#easy_1",
  "name": "Minesweeper Easy 1",
  "unlockCostCoins": 0,
  "maxScoreCap": 1000,
  "rewardStones": 10,
  "baseMapConfig": {
    "gridSize": "9x9",
    "mineCount": 10,
    "safeStartRadius": 1,
    "seedMode": "deterministic"
  }
}
```

### Session đang chơi
Chỉ lưu trong `active_game.json`.

```json
{
  "PK": "usr_12345",
  "SK": "active_game#minesweeper",
  "currentLevel": "minesweeper#easy_1",
  "seed": "seed_2026_06_03_easy_1",
  "startTime": 1717372800,
  "status": "playing"
}
```

### Packet thắng từ client
Client giữ `actionLogs` ở local và chỉ gửi khi số mìn còn lại về `0`.
StartTime lấy trong active_game.json, EndTime sẽ lấy từ hàm newDate() bên server
```json
{
  "sessionId": "active_game#minesweeper",
  "levelId": "minesweeper#easy_1",
  "finalGrid": "final-board-signature-or-state",
  "actionLogs": [
    { "cell": [0, 2], "value": 4, "timestamp": 1717372810 },
    { "cell": [0, 3], "value": 6, "timestamp": 1717372815 }
  ]
}
```

## Luồng xử lý
1. User bấm Play.
2. Server tạo seed + solution grid cho session này.
3. Server lưu seed + solution grid + thời gian bắt đầu vào `active_game.json` để xác định user đang active game.
4. Server trả `baseMapConfig` + `seed` về client.
5. Client dựng board từ `baseMapConfig` và `seed`.
6. Client chơi local và ghi lại `actionLogs`.
7. Client chỉ hiển thị realtime score và số mìn còn lại ở local.
8. Khi số mìn còn lại về `0`, client gửi packet thắng lên server.
9. Server đọc `active_game.json` theo user để dựng lại đúng board từ seed đã lưu.
10. Server validate:
   - `finalGrid` có khớp kết quả board mong đợi hoặc hash hay không
   - thời điểm trong `actionLogs` có dấu hiệu bất thường hay không
   - tổng thời gian chơi có quá nhanh hay không
11. Nếu pass validation, server tính điểm theo công thức:

```text
finalScore = basePoints - timePenalty - mistakePenalty
```

Trong đó:
- `basePoints` là điểm gốc của level.
- `timePenalty` là điểm trừ theo thời gian hoàn thành.
- `mistakePenalty` là điểm trừ theo các hành vi sai như cắm cờ sai hoặc mở nhầm.
- `hintPenalty` tạm thời chưa áp dụng, để ngoài workflow hiện tại.

Sau đó server cộng điểm và thưởng entertainCoin.
12. Server cập nhật `score.json` và `inventory.json`.
13. Nếu level đã tồn tại, chỉ update khi `personalBest` tốt hơn.
14. Server gửi kết quả về client.
15. Server xóa `active_game.json` của user sau khi hoàn tất.

## Luật validate
- Seed chỉ được tồn tại trong `active_game.json`.
- Client không được tự generate seed.
- Server phải là nguồn chân lý khi check win.
- Dùng `mineCount` cho tổng số mìn, không dùng `emptyCellsCount`.
- Dùng `solutionGrid` chỉ làm reference validate hoặc hash, không dùng như grid đáp án kiểu Sudoku.

## Luồng trạng thái gợi ý
- `idle` -> `playing` -> `won` hoặc `lost`
- `active_game` chỉ tồn tại trong lúc `playing`

## Cập nhật inventory
Lưu lịch sử Minesweeper theo từng level như sau:

```json
"minesweeper": [
  {
    "levelId": "easy_1",
    "personalBest": 45,
    "achievedAt": "2026-06-01T09:00:00Z"
  }
]
```

Nếu player phá kỷ lục cũ, thay `personalBest` và `achievedAt` bằng giá trị mới.
