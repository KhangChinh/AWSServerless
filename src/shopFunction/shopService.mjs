import {
    GetCommand,
    QueryCommand,
    TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

// ═══════════════════════════════════════════════════════
// GET /shop?shopId=eCoinShop
// Lấy thông tin shop và đánh dấu item nào user đã sở hữu
// ═══════════════════════════════════════════════════════
const handleGetShop = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const shopId = event.queryStringParameters?.shopId;
        if (!shopId) return errorResponse(400, "shopId là bắt buộc");

        // Lấy cấu hình shop từ ITEMDATA_TABLE (PK=shop, SK=shopId)
        const shopResult = await docClient.send(
            new GetCommand({
                TableName: process.env.ITEMDATA_TABLE,
                Key: { PK: "shop", SK: shopId },
            })
        );
        const shop = shopResult.Item;
        if (!shop) return errorResponse(404, "Không tìm thấy shop");

        const now = Math.floor(Date.now() / 1000);
        if (shop.expiresAt && shop.expiresAt < now) {
            return errorResponse(410, "Shop đã hết hạn");
        }

        // Kiểm tra từng item user đã sở hữu chưa
        const activeItems = shop.activeItems || [];
        const enrichedItems = await Promise.all(
            activeItems.map(async (item) => {
                // SK inventory = SK của item (phần sau "item#")
                const itemSK = item.itemId.replace("item#", "");
                const invResult = await docClient.send(
                    new GetCommand({
                        TableName: process.env.INVENTORY_TABLE,
                        Key: { PK: userId, SK: itemSK },
                    })
                );
                return { ...item, owned: !!invResult.Item };
            })
        );

        return successResponse({ shop: { ...shop, activeItems: enrichedItems } });
    } catch (err) {
        console.error("Lỗi getShop:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// POST /shop/buy
// Body: { shopId: string, itemId: string }
// itemId là SK của item trong shop.activeItems (e.g., "item#frame_stone_1")
// ═══════════════════════════════════════════════════════
const handleBuyItem = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { shopId, itemId } = body;

        if (!shopId || !itemId) {
            return errorResponse(400, "shopId và itemId là bắt buộc");
        }

        // ── 1. Kiểm tra shop còn hiệu lực ──
        const shopResult = await docClient.send(
            new GetCommand({
                TableName: process.env.ITEMDATA_TABLE,
                Key: { PK: "shop", SK: shopId },
            })
        );
        const shop = shopResult.Item;
        if (!shop) return errorResponse(404, "Không tìm thấy shop");

        const now = Date.now();
        const nowSec = Math.floor(now / 1000);
        if (shop.expiresAt && shop.expiresAt < nowSec) {
            return errorResponse(410, "Shop đã hết hạn");
        }

        // Tìm item trong shop
        const itemSK = itemId.replace("item#", "");
        const shopItem = (shop.activeItems || []).find(
            (i) => i.itemId === itemId || i.itemId === `item#${itemSK}`
        );
        if (!shopItem) return errorResponse(404, "Vật phẩm không có trong shop này");

        // ── 2. Kiểm tra user đã sở hữu chưa ──
        const invCheck = await docClient.send(
            new GetCommand({
                TableName: process.env.INVENTORY_TABLE,
                Key: { PK: userId, SK: itemSK },
            })
        );
        if (invCheck.Item) {
            return errorResponse(409, "Bạn đã sở hữu vật phẩm này rồi");
        }

        // ── 3. Đọc profile kiểm tra số dư ──
        const profileResult = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
            })
        );
        const profile = profileResult.Item;
        if (!profile) return errorResponse(404, "Không tìm thấy profile");

        const { budget } = profile;
        const currency = shopItem.currencyType; // "eCoin" | "knowledgePoint" | ...
        const price = shopItem.price;

        if ((budget[currency] || 0) < price) {
            return errorResponse(402, `Không đủ ${currency} để mua vật phẩm này`);
        }

        const newBalance = budget[currency] - price;

        // ── 4. Transaction: trừ tiền + cấp item ──
        await docClient.send(
            new TransactWriteCommand({
                TransactItems: [
                    // Trừ tiền trong profile
                    {
                        Update: {
                            TableName: process.env.USER_TABLE,
                            Key: { PK: userId },
                            UpdateExpression: `SET budget.#cur = :bal, updatedAt = :now, inventoryUpdatedAt = :now`,
                            ExpressionAttributeNames: { "#cur": currency },
                            ExpressionAttributeValues: {
                                ":bal": newBalance,
                                ":now": now,
                                // Điều kiện: số dư không thay đổi kể từ lúc đọc
                                ":requiredBalance": budget[currency],
                            },
                            ConditionExpression: `budget.#cur = :requiredBalance`,
                        },
                    },
                    // Cấp item vào inventory
                    {
                        Put: {
                            TableName: process.env.INVENTORY_TABLE,
                            Item: {
                                PK: userId,
                                SK: itemSK,
                                rarity: String(shopItem.rarity),
                                name: shopItem.name,
                                imageUrl: shopItem.imageUrl,
                                itemType: shopItem.itemType,
                                collectFrom: shopId,
                                acquiredAt: new Date(now).toISOString(),
                            },
                            // Không cho ghi đè nếu đã tồn tại
                            ConditionExpression: "attribute_not_exists(PK)",
                        },
                    },
                ],
            })
        );

        return successResponse({
            message: "Mua thành công",
            newBalance,
            currency,
            item: {
                SK: itemSK,
                name: shopItem.name,
                imageUrl: shopItem.imageUrl,
                itemType: shopItem.itemType,
                rarity: shopItem.rarity,
                collectFrom: shopId,
                acquiredAt: new Date(now).toISOString(),
            },
            updatedAt: now,
        });
    } catch (err) {
        if (err.name === "TransactionCanceledException") {
            return errorResponse(409, "Giao dịch bị từ chối: số dư thay đổi hoặc đã sở hữu vật phẩm");
        }
        console.error("Lỗi buyItem:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

export { handleGetShop, handleBuyItem };
