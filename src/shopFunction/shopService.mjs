import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { getCachedMasterData } from "../cacheHelper.mjs";
import { successResponse, errorResponse } from "../response.mjs";
import { fetchInventoryPage } from "../syncFunction/syncService.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

const handleRefresheCoinShop = async (event) => {
    try {
        console.log("Bắt đầu refresh eCoin Shop sử dụng Cache Helper...");
        const allItems = await getCachedMasterData(async () => {
            console.log("[Shop Refresh] Cache MISS - Đang kéo dữ liệu mới từ DynamoDB...");
            const result = await docClient.send(
                new QueryCommand({
                    TableName: process.env.ITEMDATA_TABLE,
                    KeyConditionExpression: "PK = :pk",
                    ExpressionAttributeValues: { ":pk": "item" },
                })
            );
            return result.Items || [];
        });
        const candidates = allItems.filter(item => item.collectFrom === "eCoinShop");
        if (candidates.length === 0) {
            console.log("Không tìm thấy vật phẩm nào có collectFrom = eCoinShop trong Master Data");
            return;
        }
        const shuffled = candidates.sort(() => 0.5 - Math.random());
        const selectedItems = shuffled.slice(0, 3).map(item => ({
            itemId: item.SK,
            name: item.name,
            imageUrl: item.imageUrl,
            rarity: item.rarity,
            itemType: item.itemType,
            currencyType: "eCoin",
            price: item.price || 99
        }));
        // 4. Tính toán expiresAt (00:00:00 UTC ngày hôm sau)
        const now = new Date();
        now.setUTCDate(now.getUTCDate() + 7);
        now.setUTCHours(0, 0, 0, 0);
        const expiresAt = Math.floor(now.getTime() / 1000);
        // 5. Chuẩn bị Object Shop để ghi đè
        const shopData = {
            PK: "shop",
            SK: "eCoinShop",
            activeItems: selectedItems,
            expiresAt: expiresAt,
            updatedAt: Math.floor(Date.now() / 1000)
        };
        // 6. Lưu đè / Tạo mới vào DynamoDB
        await docClient.send(
            new PutCommand({
                TableName: process.env.ITEMDATA_TABLE,
                Item: shopData
            })
        );
        console.log("Refresh eCoin Shop thành công!");
        return shopData;
    } catch (err) {
        console.error("Lỗi khi refresh eCoin Shop:", err);
        throw err;
    }
};

const handleGeteCoinShop = async (event) => {
    try {
        const userId = getUserId(event);
        if (!userId) return errorResponse(401, "Unauthorized");
        const shopResult = await docClient.send(
            new GetCommand({
                TableName: process.env.ITEMDATA_TABLE,
                Key: {
                    PK: "shop",
                    SK: "eCoinShop"
                }
            })
        );
        const shopData = shopResult.Item;
        if (!shopData || !shopData.activeItems || shopData.activeItems.length === 0) {
            return successResponse({
                shop: {
                    activeItems: [],
                    expiresAt: null
                },
                message: "Shop hiện đang trống."
            });
        }
        // 2. Gom danh sách itemId đang bán để check túi đồ
        const keysToFetch = shopData.activeItems.map(item => ({
            PK: userId,
            SK: item.itemId
        }));
        // 3. Kéo túi đồ của User (chỉ lấy đúng những item đang bán trong shop)
        const batchResult = await docClient.send(
            new BatchGetCommand({
                RequestItems: {
                    [process.env.INVENTORY_TABLE]: {
                        Keys: keysToFetch,
                        ProjectionExpression: "SK" // Tối ưu: Chỉ cần kéo SK về để xác nhận là có tồn tại
                    }
                }
            })
        );
        // 4. Đưa các item đã sở hữu vào một Set để check cho nhanh
        const inventoryItems = batchResult.Responses?.[process.env.INVENTORY_TABLE] || [];
        const ownedItemIds = new Set(inventoryItems.map(inv => inv.SK));
        // 5. Map lại danh sách shop và nhét thêm cờ isOwned
        const enrichedItems = shopData.activeItems.map(item => ({
            ...item,
            isOwned: ownedItemIds.has(item.itemId)
        }));
        // Bỏ các trường nội bộ của Database trước khi gửi về App
        const { PK, SK, updatedAt, ...clientShopData } = shopData;
        clientShopData.activeItems = enrichedItems; // Tráo mảng cũ bằng mảng đã có isOwned
        return successResponse({
            success: true,
            message: "Lấy dữ liệu cửa hàng thành công",
            shop: clientShopData
        });

    } catch (err) {
        console.error("Lỗi khi lấy dữ liệu eCoin Shop:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

const handleBuyeCoinItem = async (event) => {
    try {
        const userId = getUserId(event);
        if (!userId) return errorResponse(401, "Unauthorized");
        const body = JSON.parse(event.body || "{}");
        const { itemId } = body;
        if (!itemId) return errorResponse(400, "Thiếu itemId cần mua.");
        // 1. Kéo dữ liệu Shop và Profile cùng lúc để kiểm tra
        const [shopResult, profileResult] = await Promise.all([
            docClient.send(new GetCommand({
                TableName: process.env.ITEMDATA_TABLE,
                Key: { PK: "shop", SK: "eCoinShop" }
            })),
            docClient.send(new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId }
            }))
        ]);
        const shopData = shopResult.Item;
        const profile = profileResult.Item;
        if (!profile) return errorResponse(404, "Không tìm thấy người dùng.");
        if (!shopData || !shopData.activeItems || shopData.activeItems.length === 0) {
            return errorResponse(400, "Shop hiện đang trống hoặc đã hết hạn.");
        }
        // 2. Tìm item người dùng muốn mua trong Shop
        const itemToBuy = shopData.activeItems.find(item => item.itemId === itemId);
        if (!itemToBuy) {
            return errorResponse(400, "Vật phẩm không tồn tại trong cửa hàng hiện tại.");
        }
        // Kiểm tra số dư eCoin (Đảm bảo rơi vào fallback = 0 nếu user chưa từng có eCoin)
        const currentECoin = profile.budget?.eCoin || 0;
        if (currentECoin < itemToBuy.price) {
            return errorResponse(400, "Không đủ eCoin để mua vật phẩm này.");
        }
        // 3. Kéo túi đồ để check xem user đã sở hữu những item nào trong shop
        const keysToFetch = shopData.activeItems.map(item => ({
            PK: userId,
            SK: item.itemId
        }));
        const batchResult = await docClient.send(new BatchGetCommand({
            RequestItems: {
                [process.env.INVENTORY_TABLE]: {
                    Keys: keysToFetch,
                    ProjectionExpression: "SK"
                }
            }
        }));
        const inventoryItems = batchResult.Responses?.[process.env.INVENTORY_TABLE] || [];
        const ownedItemIds = new Set(inventoryItems.map(inv => inv.SK));
        // Kiểm tra xem đã sở hữu món đồ định mua chưa
        if (ownedItemIds.has(itemId)) {
            return errorResponse(400, "Bạn đã sở hữu vật phẩm này rồi.");
        }
        // 4. THỰC THI TRANSACTION: Trừ tiền và Thêm item vào Inventory cùng 1 lúc
        const now = Date.now(); // Lấy theo milliseconds chuẩn của gachaService
        const nowSeconds = Math.floor(now / 1000);
        await docClient.send(new TransactWriteCommand({
            TransactItems: [
                {
                    // Lệnh 1: Trừ eCoin trong Profile
                    Update: {
                        TableName: process.env.USER_TABLE,
                        Key: { PK: userId },
                        UpdateExpression: "SET budget.eCoin = budget.eCoin - :price, updatedAt = :nowSeconds",
                        ConditionExpression: "budget.eCoin >= :price", // Chống lố tiền nếu bị spam click
                        ExpressionAttributeValues: {
                            ":price": itemToBuy.price,
                            ":nowSeconds": nowSeconds
                        }
                    }
                },
                {
                    // Lệnh 2: Thêm item vào Inventory với đầy đủ metadata giống Gacha
                    Put: {
                        TableName: process.env.INVENTORY_TABLE,
                        Item: {
                            PK: userId,
                            SK: itemToBuy.itemId,
                            acquiredAt: new Date(now).toISOString(), // Đồng bộ định dạng ISOString với gachaService
                            itemType: itemToBuy.itemType,
                            name: itemToBuy.name,
                            imageUrl: itemToBuy.imageUrl,
                            rarity: itemToBuy.rarity
                        },
                        ConditionExpression: "attribute_not_exists(SK)" // Đảm bảo không bị ghi đè nếu đã có
                    }
                }
            ]
        }));
        // 5. CHUẨN BỊ FULL DATA ĐỂ TRẢ VỀ CHO FRONTEND
        // 5.1. Cập nhật lại Profile local
        const updatedProfile = {
            ...profile,
            budget: {
                ...profile.budget,
                eCoin: currentECoin - itemToBuy.price
            },
            updatedAt: nowSeconds
        };
        // 5.2. Cập nhật lại Shop local (Đổi isOwned của item vừa mua thành true)
        ownedItemIds.add(itemId);
        const enrichedItems = shopData.activeItems.map(item => ({
            ...item,
            isOwned: ownedItemIds.has(item.itemId)
        }));
        const { PK, SK, updatedAt: shopUpdatedAt, ...clientShopData } = shopData;
        clientShopData.activeItems = enrichedItems;
        // 5.3. Kéo lại túi đồ (Inventory) mới nhất của tab tương ứng với item vừa mua
        // Để Frontend cập nhật thẳng vào giao diện kho đồ (y hệt gachaService)
        const invPage = await fetchInventoryPage(userId, null, itemToBuy.itemType);
        const inventoryResult = {
            [itemToBuy.itemType]: {
                items: invPage.items,
                lastEvaluatedKey: invPage.lastEvaluatedKey
            }
        };
        // 6. TRẢ VỀ FORM CHUẨN
        return successResponse({
            success: true,
            message: `Mua thành công ${itemToBuy.name}!`,
            profile: updatedProfile,
            shop: clientShopData,
            inventory: inventoryResult
        });
    } catch (err) {
        console.error("Lỗi khi mua vật phẩm eCoin:", err);
        if (err.name === 'TransactionCanceledException') {
            return errorResponse(400, "Giao dịch không hợp lệ hoặc số dư không đủ.");
        }
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

export {
    handleRefresheCoinShop,
    handleGeteCoinShop,
    handleBuyeCoinItem
}