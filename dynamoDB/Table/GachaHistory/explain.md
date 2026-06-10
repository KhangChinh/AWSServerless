*table GachaHistory:
mỗi history.json chứa thông tin gacha của user thuộc 1 thời điểm đó

*chi tiết thuộc tính:
-PK: mã người dùng lấy từ userId của cognito
-SK: timestamp khi nhận được vật phẩm đó
-name, rarity: lấy từ [item](../ItemData/item.json)
-sanityAmount: số lượng sanity trong lần roll đó nếu là vật phẩm rarity = 4 và 5 thì sanityAmount là 0
-expiresAt: timestamp gốc + số giây của 6 tháng