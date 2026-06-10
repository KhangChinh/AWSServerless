*table ItemData:
mỗi item.json đại diện cho 1 item trong database
mỗi shop.json đại diện cho danh sách item được bán trong shop đó

*chi tiết thuộc tính item.json:
-PK: luôn luôn là "item" để thể hiện đây là 1 vật phẩm
-SK: đại diện cho mã của vật phẩm đó, là duy nhất cho mỗi vật phẩm
-rarity: độ hiếm của vật phẩm đó (chỉ có 4 và 5)
-name: tên của vật phẩm
-imageUrl: link ảnh cho vật phẩm đó
-assetUrls:
    +css, bgm,...: các thành phần cấu thành nên 1 theme hoặc frame
-itemType: loại của vật phẩm đó (frame, theme và title)
-currencyType: loại tiền tệ để mua vật phẩm đó nếu có
-price: giá trị của vật phẩm đó
-collectFrom: nơi có thể sở hữu vật phẩm
-isLimited: vật phẩm giới hạn hay ko

*chi tiết thuộc tính shop.json
-PK: luôn luôn là "shop" để thể hiện đây là 1 cửa hàng
-SK: đại diện cho loại của shop đó (hiện tại chỉ có eCoinShop)
-activeItems: danh sách sản phẩm bán trong shop đó 
    +itemId: là PK#SK của [item.json](../ItemData/item.json)
    +name, imageUrl, rarity, itemType, currencyType và price đều lấy từ item.json khi khởi tạo bằng thuật toán
-expiresAt: thời hạn kết thúc của shop, client sẽ dựa vào để hiện đồng hộ đếm ngược và khóa nút mua khi hết thời gian và gọi API lấy shop mới khi hết giờ