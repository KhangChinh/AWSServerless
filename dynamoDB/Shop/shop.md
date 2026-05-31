PK shop giữ nguyên, SK có item# là mã vật phẩm - có weekly biểu diễn cho cửa hàng của tuần
{
    "PK": "shop",
    "SK": "item#theme_cyberpunk",
    "name": "Theme Cyberpunk",
    "itemType": "theme",
    "currencyType": "gems",
    "basePrice": 500
},
{
    "PK": "shop",
    "SK": "item#frame_stone_1",
    "name": "Khung Đá Cổ Đại",
    "itemType": "frame",
    "currencyType": "stones",
    "basePrice": 150
}
activeItems lưu các SK sản phẩm bán trong tuần, expiresAt lưu thời điểm shop kết thúc (dùng để kiểm tra đã qua thời gian chưa, tránh client lợi dụng) - tạo trigger để tự update activeItems mỗi thứ 2 hàng tuần
{
    "PK": "shop",
    "SK": "weekly",
    "activeItems": [
        "item#frame_stone_1",
        "item#frame_stone_2"
    ],
    "expiresAt": "2026-06-01T00:00:00Z"
}