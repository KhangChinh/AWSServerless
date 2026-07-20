import { GetCommand, PutCommand, BatchGetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse } from "../response.mjs";
import { syncedErrorResponse } from "../errorSync.mjs";
import { mapCosmeticAssets, fetchInventoryPage } from "../syncFunction/syncService.mjs";

const SANITY_CONFIG = {
    // 1. Số lượng Sanity nhận được khi roll ra 3 sao 
    // (Mặc định: random từ 20, 25, 30... đến 50)
    get3StarSanityAmount: () => Math.floor(Math.random() * 7) * 5 + 20,
    // 2. Số lượng Sanity quy đổi khi ra trùng vật phẩm
    duplicate5Star: 150, // Trùng đồ 5 sao -> Được 150 Sanity
    duplicate4Star: 70   // Trùng đồ 4 sao -> Được 70 Sanity
};

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

const fetchFirstPage = async (tableName, userId, limit) => {
    const result = await docClient.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :uid",
        ExpressionAttributeValues: { ":uid": userId },
        Limit: limit,
        ScanIndexForward: false, // Lấy mới nhất
    }));
    return { items: result.Items || [], lastKey: result.LastEvaluatedKey || null };
};

export const handleGacha = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");
    try {
        const body = JSON.parse(event.body || "{}");
        const isx10 = body.isx10 === true;
        const bannerId = body.bannerId; // FE BẮT BUỘC TRUYỀN LÊN (ví dụ: "banner_background")

        if (!bannerId) return await syncedErrorResponse(getUserId(event), 400, "Thiếu thông tin bannerId.");

        const pullsCount = isx10 ? 10 : 1;
        const coreCost = pullsCount; // 1 lượt = 1 knowledgeCore

        // 1. Kéo Profile người dùng và Dữ liệu Banner CÙNG LÚC để tối ưu tốc độ
        const [profileRes, bannerRes] = await Promise.all([
            docClient.send(new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId }
            })),
            docClient.send(new GetCommand({
                TableName: process.env.ITEMDATA_TABLE,
                Key: { PK: "gacha", SK: bannerId }
            }))
        ]);

        const profile = profileRes.Item;
        const banner = bannerRes.Item;

        if (!profile) return await syncedErrorResponse(getUserId(event), 404, "Profile not found");

        const nowSeconds = Math.floor(Date.now() / 1000);
        if (!banner || !banner.pool) {
            return await syncedErrorResponse(getUserId(event), 400, "Banner không tồn tại hoặc dữ liệu bị lỗi.");
        }
        if (banner.expiresAt && banner.expiresAt < nowSeconds) {
            return await syncedErrorResponse(getUserId(event), 400, "Banner này đã kết thúc.");
        }

        // Lấy cấu hình Rates từ Banner JSON
        const rates = banner.rates;

        // 2. Kiểm tra & Trừ tài nguyên
        let budget = profile.budget || {};
        let { knowledgeCore = 0, knowledgePoint = 0, sanity = 0 } = budget;

        if (knowledgeCore < coreCost) {
            const missingCores = coreCost - knowledgeCore;
            const requiredPoints = missingCores * 150;
            if (knowledgePoint >= requiredPoints) {
                knowledgePoint -= requiredPoints;
                knowledgeCore += missingCores;
            } else {
                return await syncedErrorResponse(getUserId(event), 400, "Không đủ Knowledge Core và Knowledge Point.");
            }
        }
        knowledgeCore -= coreCost; // Trừ phí gacha

        // 3. Thuật toán map rarity dựa theo thông số CỦA BANNER
        let gachaStats = profile.gachaStats || {
            is4StarGuaranteed: false, is5StarGuaranteed: false, pity4Star: 0, pity5Star: 0
        };
        const rarityMap = [];
        const combined4StarRate = rates.base5Star + rates.base4Star; // Ví dụ: 0.01 + 0.09 = 0.10 (10% ra 4 sao hoặc 5 sao)

        for (let i = 0; i < pullsCount; i++) {
            gachaStats.pity4Star++;
            gachaStats.pity5Star++;
            const rand = Math.random();
            let baseRarity = 3;

            // Logic Pity sử dụng config từ JSON
            if (gachaStats.pity5Star >= rates.pity5StarLimit || rand <= rates.base5Star) {
                baseRarity = 5;
                gachaStats.pity5Star = 0;
            } else if (gachaStats.pity4Star >= rates.pity4StarLimit || rand <= combined4StarRate) {
                baseRarity = 4;
                gachaStats.pity4Star = 0;
            }

            // Logic Bảo hiểm 50/50 sử dụng config từ JSON
            if (baseRarity === 5) {
                if (gachaStats.is5StarGuaranteed || Math.random() <= rates.rateUpChance) {
                    rarityMap.push(5); // Trúng rate
                    gachaStats.is5StarGuaranteed = false;
                } else {
                    rarityMap.push(4.5); // Lệch rate
                    gachaStats.is5StarGuaranteed = true;
                }
            } else if (baseRarity === 4) {
                if (gachaStats.is4StarGuaranteed || Math.random() <= rates.rateUpChance) {
                    rarityMap.push(4); // Trúng rate
                    gachaStats.is4StarGuaranteed = false;
                } else {
                    rarityMap.push(3.5); // Lệch rate
                    gachaStats.is4StarGuaranteed = true;
                }
            } else {
                rarityMap.push(3); // 3 sao (Sanity)
            }
        }

        // 4. Quy đổi rarityMap ra Item (Trực tiếp từ banner.pool, bỏ bước load MasterData)
        const pulledResults = [];
        const itemKeysToCheck = [];

        for (const code of rarityMap) {
            if (code === 3) {
                // SỬ DỤNG HÀM CONFIG SANITY TẠI ĐÂY
                const randomSanity = SANITY_CONFIG.get3StarSanityAmount();
                pulledResults.push({ type: 'sanity', amount: randomSanity, rarity: 3 });
            } else {
                let pool = [];
                // Chọn pool tương ứng với mã số, fallback phòng trường hợp pool standard trống
                if (code === 5) pool = banner.pool.rateUp5;
                else if (code === 4.5) pool = banner.pool.standard5.length ? banner.pool.standard5 : banner.pool.rateUp5;
                else if (code === 4) pool = banner.pool.rateUp4;
                else if (code === 3.5) pool = banner.pool.standard4.length ? banner.pool.standard4 : banner.pool.rateUp4;

                const selectedItem = pool[Math.floor(Math.random() * pool.length)];
                pulledResults.push({ type: 'item', item: selectedItem, rarity: Math.floor(code) });
                itemKeysToCheck.push({ PK: userId, SK: selectedItem.SK });
            }
        }

        // 5. Kiểm tra Inventory & Xử lý Trùng lặp
        const alreadyOwned = new Set();
        if (itemKeysToCheck.length > 0) {
            const batchResult = await docClient.send(new BatchGetCommand({
                RequestItems: { [process.env.INVENTORY_TABLE]: { Keys: itemKeysToCheck } }
            }));
            const existingItems = batchResult.Responses?.[process.env.INVENTORY_TABLE] || [];
            existingItems.forEach(i => alreadyOwned.add(i.SK));
        }

        const now = Date.now();
        const writePromises = [];
        const clientReturnItems = [];
        const newInventorySkSet = new Set(); // Chống duplicate trong cùng 1 lần x10

        pulledResults.forEach((pull, index) => {
            const historyTimestamp = now + index; // +1 liên tục để UI sắp xếp đúng
            let sanityConverted = 0;

            if (pull.type === 'sanity') {
                sanity += pull.amount;
                clientReturnItems.push({ imageUrl: null, name: `Sanity x${pull.amount}`, rarity: 3, isConverted: false });

                writePromises.push(docClient.send(new PutCommand({
                    TableName: process.env.GACHAHISTORY_TABLE,
                    Item: {
                        PK: userId, SK: historyTimestamp,
                        name: "Sanity", rarity: 3,
                        sanityAmount: pull.amount,
                        expiresAt: Math.floor(now / 1000) + (30 * 86400) // TTL 30 ngày
                    }
                })));
            } else {
                const { item, rarity } = pull;
                const isOwned = alreadyOwned.has(item.SK) || newInventorySkSet.has(item.SK);

                const itemImageUrl = item.itemType === 'pet' ? item.assets?.idle : item.assets?.css;

                if (isOwned) {
                    // SỬ DỤNG CONFIG QUY ĐỔI SANITY KHI BỊ TRÙNG ĐỒ TẠI ĐÂY
                    sanityConverted = rarity === 5 ? SANITY_CONFIG.duplicate5Star : SANITY_CONFIG.duplicate4Star;
                    sanity += sanityConverted;
                    clientReturnItems.push({
                        imageUrl: itemImageUrl,
                        name: item.name,
                        rarity,
                        isConverted: true,
                        convertedTo: sanityConverted
                    });
                } else {
                    // Mới -> Thêm vào túi
                    newInventorySkSet.add(item.SK);
                    clientReturnItems.push({
                        imageUrl: itemImageUrl,
                        name: item.name,
                        rarity,
                        isConverted: false
                    });

                    writePromises.push(docClient.send(new PutCommand({
                        TableName: process.env.INVENTORY_TABLE,
                        Item: {
                            PK: userId, SK: item.SK,
                            acquiredAt: new Date(now).toISOString(),
                            assets: item.assets, itemType: item.itemType,
                            name: item.name, rarity
                        }
                    })));
                }

                // Lưu Lịch sử
                writePromises.push(docClient.send(new PutCommand({
                    TableName: process.env.GACHAHISTORY_TABLE,
                    Item: {
                        PK: userId, SK: historyTimestamp,
                        name: item.name, rarity,
                        sanityAmount: sanityConverted,
                        expiresAt: Math.floor(now / 1000) + (30 * 86400)
                    }
                })));
            }
        });

        // 6. Cập nhật Profile
        budget.knowledgeCore = knowledgeCore;
        budget.knowledgePoint = knowledgePoint;
        budget.sanity = sanity;

        writePromises.push(docClient.send(new UpdateCommand({
            TableName: process.env.USER_TABLE,
            Key: { PK: userId },
            UpdateExpression: "SET budget = :b, gachaStats = :g, updatedAt = :u",
            ExpressionAttributeValues: { ":b": budget, ":g": gachaStats, ":u": now }
        })));

        await Promise.all(writePromises);

        // 7. Đồng bộ dữ liệu trả về cho Frontend
        profile.budget = budget;
        profile.gachaStats = gachaStats;
        const finalProfile = await mapCosmeticAssets(profile);

        // Chỉ tìm các itemType có vật phẩm mới được thêm vào túi
        const updatedTypes = new Set();
        pulledResults.forEach((pull, index) => {
            if (pull.type === 'item') {
                const { item } = pull;
                const isOwned = alreadyOwned.has(item.SK) || (index > 0 && pulledResults.slice(0, index).some(p => p.type === 'item' && p.item.SK === item.SK));
                if (!isOwned && item.itemType) {
                    updatedTypes.add(item.itemType);
                }
            }
        });

        const inventoryResult = {};
        if (updatedTypes.size > 0) {
            await Promise.all(Array.from(updatedTypes).map(type =>
                fetchInventoryPage(userId, null, type).then(inv => {
                    inventoryResult[type] = {
                        items: inv.items,
                        lastEvaluatedKey: inv.lastEvaluatedKey
                    };
                })
            ));
        }

        const historyPage = await fetchFirstPage(process.env.GACHAHISTORY_TABLE, userId, 30);

        return successResponse({
            success: true,
            pulledItems: clientReturnItems,
            profile: finalProfile,
            inventory: inventoryResult,
            gachaHistory: historyPage.items,
            gachaHistoryLastKey: historyPage.lastKey
        });

    } catch (error) {
        console.error("Lỗi Gacha:", error);
        return await syncedErrorResponse(getUserId(event), 500, error.message || "Lỗi xử lý gacha");
    }
};