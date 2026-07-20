*table Inventory:
mỗi inventory.json chứa thông tin sở hữu 1 vật phẩm của user đó
với PK là PK từ [profile](Table/User/profile.json) và SK là SK từ [item](../ItemData/item.json)

*chi tiết thuộc tính:
-PK: mã người dùng lấy từ userId của cognito
-SK: SK từ [item](../ItemData/item.json)
-rarity, name, itemType được lấy trong thuật toán thêm vật phẩm
-acquiredAt: thời điểm nhận được vật phẩm