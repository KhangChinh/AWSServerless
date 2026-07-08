import { GetCommand, PutCommand, BatchGetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";
import { getCachedMasterData } from "../cacheHelper.mjs";
import { mapCosmeticAssets, fetchInventoryPage } from "../syncFunction/syncService.mjs";

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
        ScanIndexForward: false,
    }));
    return { items: result.Items || [], lastKey: result.LastEvaluatedKey || null };
};

export const handleGacha = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const isx10 = body.isx10 === true;
        const pullsCount = isx10 ? 10 : 1;
        const coreCost = pullsCount; // 1 lượt = 1 knowledgeCore

        // 1. Lấy Profile
        const profileRes = await docClient.send(new GetCommand({
            TableName: process.env.USER_TABLE,
            Key: { PK: userId }
        }));
        const profile = profileRes.Item;
        if (!profile) return errorResponse(404, "Profile not found");

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
                return errorResponse(400, "Không đủ Knowledge Core và Knowledge Point.");
            }
        }
        knowledgeCore -= coreCost; // Trừ phí gacha

        // 3. Thuật toán map rarity
        let gachaStats = profile.gachaStats || {
            is4StarGuaranteed: false, is5StarGuaranteed: false, pity4Star: 0, pity5Star: 0
        };
        const rarityMap = [];

        for (let i = 0; i < pullsCount; i++) {
            gachaStats.pity4Star++;
            gachaStats.pity5Star++;
            const rand = Math.random();
            let baseRarity = 3;

            // Soft/Hard pity logic cơ bản (Mặc định: 10 cho 4 sao, 80 cho 5 sao)
            if (gachaStats.pity5Star >= 80 || rand <= 0.01) {
                baseRarity = 5;
                gachaStats.pity5Star = 0;
            } else if (gachaStats.pity4Star >= 10 || rand <= 0.10) {
                baseRarity = 4;
                gachaStats.pity4Star = 0;
            }

            if (baseRarity === 5) {
                if (gachaStats.is5StarGuaranteed || Math.random() <= 0.5) {
                    rarityMap.push(5); // Trúng rate
                    gachaStats.is5StarGuaranteed = false;
                } else {
                    rarityMap.push(4.5); // Lệch rate
                    gachaStats.is5StarGuaranteed = true;
                }
            } else if (baseRarity === 4) {
                if (gachaStats.is4StarGuaranteed || Math.random() <= 0.5) {
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

        // 4. Phân loại Master Data Item
        const allItems = await getCachedMasterData(async () => {
            const res = await docClient.send(new QueryCommand({
                TableName: process.env.ITEMDATA_TABLE,
                KeyConditionExpression: "PK = :pk",
                ExpressionAttributeValues: { ":pk": "item" }
            }));
            return res.Items || [];
        });

        const gachaPool = allItems.filter(item => item.collectFrom === "gacha");
        const pools = {
            "5": gachaPool.filter(i => i.rarity === 5 && i.isLimited === true),
            "4.5": gachaPool.filter(i => i.rarity === 5 && i.isLimited === false),
            "4": gachaPool.filter(i => i.rarity === 4 && i.isLimited === true),
            "3.5": gachaPool.filter(i => i.rarity === 4 && i.isLimited === false)
        };
        // Fallback an toàn nếu pool rỗng
        pools["4.5"] = pools["4.5"].length ? pools["4.5"] : pools["5"];
        pools["3.5"] = pools["3.5"].length ? pools["3.5"] : pools["4"];

        // 5. Quy đổi rarityMap ra Item
        const pulledResults = [];
        const itemKeysToCheck = [];

        for (const code of rarityMap) {
            if (code === 3) {
                const randomSanity = Math.floor(Math.random() * 11) * 5 + 50; // Random 50, 55... 100
                pulledResults.push({ type: 'sanity', amount: randomSanity, rarity: 3 });
            } else {
                const pool = pools[code.toString()];
                const selectedItem = pool[Math.floor(Math.random() * pool.length)];
                pulledResults.push({ type: 'item', item: selectedItem, rarity: Math.floor(code) });
                itemKeysToCheck.push({ PK: userId, SK: selectedItem.SK });
            }
        }

        // 6. Kiểm tra Inventory & Xử lý Trùng lặp
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
        const newInventorySkSet = new Set(); // Xử lý trường hợp trúng 2 item giống nhau trong cùng 1 x10

        pulledResults.forEach((pull, index) => {
            const historyTimestamp = now + index; // +1 liên tục để sắp xếp đúng trên UI
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
                        expiresAt: Math.floor(now / 1000) + (30 * 86400) // TTL 30 ngày cho history
                    }
                })));
            } else {
                const { item, rarity } = pull;
                const isOwned = alreadyOwned.has(item.SK) || newInventorySkSet.has(item.SK);

                if (isOwned) {
                    // Trùng lặp -> Quy đổi
                    sanityConverted = rarity === 5 ? 150 : 80;
                    sanity += sanityConverted;
                    clientReturnItems.push({
                        imageUrl: item.imageUrl, name: item.name, rarity, isConverted: true, convertedTo: sanityConverted
                    });
                } else {
                    // Mới -> Thêm vào túi
                    newInventorySkSet.add(item.SK);
                    clientReturnItems.push({ imageUrl: item.imageUrl, name: item.name, rarity, isConverted: false });

                    writePromises.push(docClient.send(new PutCommand({
                        TableName: process.env.INVENTORY_TABLE,
                        Item: {
                            PK: userId, SK: item.SK,
                            acquiredAt: new Date(now).toISOString(),
                            assets: item.assets, itemType: item.itemType,
                            name: item.name, imageUrl: item.imageUrl, rarity
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

        // 7. Cập nhật Profile
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

        // 8. Lấy dữ liệu mới nhất (Trang 1) của những itemType thực sự thay đổi trả về cho IngestServerData
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
        return errorResponse(500, error.message || "Lỗi xử lý gacha");
    }
};