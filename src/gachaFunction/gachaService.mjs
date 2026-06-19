import {
    GetCommand,
    QueryCommand,
    UpdateCommand,
    TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

// ═══════════════════════════════════════════════════════
// GACHA ALGORITHM HELPERS
// ═══════════════════════════════════════════════════════

/**
 * Lấy tỉ lệ rarity cho 1 lượt dựa vào pity hiện tại.
 * Trả về "5" | "5L" | "4" | "4L" | "3"
 * (5 = thường, 5L = limited, 4 = thường, 4L = limited, 3 = sanity)
 */
function rollRarityValue(pity4, pity5, is4Guaranteed, is5Guaranteed) {
    // Tỉ lệ cơ bản
    let rate5 = 0.006; // 0.6%
    let rate4 = 0.051; // 5.1%

    // Soft pity 5 sao (từ lượt 74 trở đi tỉ lệ tăng)
    if (pity5 >= 74) {
        rate5 = 0.006 + (pity5 - 73) * 0.06;
    }
    // Hard pity 5 sao (lượt 90)
    if (pity5 >= 89) {
        rate5 = 1.0;
    }

    // Soft pity 4 sao (từ lượt 9 trở đi)
    if (pity4 >= 9) {
        rate4 = 0.051 + (pity4 - 8) * 0.20;
    }
    // Hard pity 4 sao (lượt 10)
    if (pity4 >= 9) {
        rate4 = Math.max(rate4, 1.0 - rate5);
    }

    const rand = Math.random();
    if (rand < rate5) {
        // 5 sao
        if (is5Guaranteed) return "5L"; // guaranteed limited
        return Math.random() < 0.5 ? "5L" : "4.5"; // 50/50
    }
    if (rand < rate5 + rate4) {
        // 4 sao
        if (is4Guaranteed) return "4L"; // guaranteed limited
        return Math.random() < 0.5 ? "4L" : "3.5"; // 50/50
    }
    return "3"; // sanity
}

/**
 * Lấy 1 item ngẫu nhiên từ ITEMDATA_TABLE theo rarity và isLimited
 */
async function pickRandomItem(rarity, isLimited) {
    // Query GSI hoặc scan nhỏ (giả định có GSI collectFrom-rarity-index)
    // Thực tế nên dùng GSI; ở đây query với filter
    const result = await docClient.send(
        new QueryCommand({
            TableName: process.env.ITEMDATA_TABLE,
            KeyConditionExpression: "PK = :pk",
            FilterExpression: "rarity = :r AND collectFrom = :src AND isLimited = :lim",
            ExpressionAttributeValues: {
                ":pk": "item",
                ":r": String(rarity),
                ":src": "gacha",
                ":lim": isLimited,
            },
        })
    );
    const items = result.Items || [];
    if (items.length === 0) return null;
    return items[Math.floor(Math.random() * items.length)];
}

/**
 * Tạo sanity ngẫu nhiên trong khoảng 1–10
 */
function rollSanity() {
    return Math.floor(Math.random() * 10) + 1;
}

// ═══════════════════════════════════════════════════════
// POST /gacha
// Body: { count: 1 | 10 }
// ═══════════════════════════════════════════════════════
export const handleGacha = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { count } = body;

        if (count !== 1 && count !== 10) {
            return errorResponse(400, "count phải là 1 hoặc 10");
        }

        // ── 1. Lấy profile ──
        const profileResult = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId, SK: "profile" },
            })
        );
        const profile = profileResult.Item;
        if (!profile) return errorResponse(404, "Không tìm thấy profile");

        const { budget, gachaStats } = profile;
        let { knowledgeCore, knowledgePoint } = budget;
        let { pity4Star, pity5Star, is4StarGuaranteed, is5StarGuaranteed } = gachaStats;

        // ── 2. Tính chi phí ──
        const COST_PER_ROLL = 160; // 1 roll = 160 knowledgeCore
        const totalCore = count * COST_PER_ROLL;
        const coreShortfall = Math.max(0, totalCore - knowledgeCore);
        const KP_PER_CORE = 160; // 160 KP đổi 1 core
        const kpNeeded = coreShortfall * KP_PER_CORE;

        if (kpNeeded > knowledgePoint) {
            return errorResponse(400, "Không đủ tài nguyên để gacha");
        }

        let newKnowledgeCore = knowledgeCore - totalCore;
        let newKnowledgePoint = knowledgePoint;
        if (newKnowledgeCore < 0) {
            newKnowledgePoint -= Math.abs(newKnowledgeCore) * KP_PER_CORE;
            newKnowledgeCore = 0;
        }

        // ── 3. Chạy thuật toán gacha ──
        const rarityMap = [];
        for (let i = 0; i < count; i++) {
            rarityMap.push(
                rollRarityValue(
                    pity4Star + i,
                    pity5Star + i,
                    is4StarGuaranteed,
                    is5StarGuaranteed
                )
            );
        }

        // ── 4. Lấy items theo rarityMap ──
        const rolledItems = [];
        let totalSanity = 0;

        for (const rv of rarityMap) {
            let item = null;
            let sanityAmount = 0;

            if (rv === "3") {
                sanityAmount = rollSanity();
                totalSanity += sanityAmount;
                item = { rarity: "3", name: "Sanity", isSanity: true, sanityAmount };
            } else if (rv === "3.5") {
                item = await pickRandomItem(4, false);
            } else if (rv === "4L") {
                item = await pickRandomItem(4, true);
            } else if (rv === "4.5") {
                item = await pickRandomItem(5, false);
            } else if (rv === "5L") {
                item = await pickRandomItem(5, true);
            }

            rolledItems.push({ rarityValue: rv, item, sanityAmount });
        }

        // ── 5. Tính pity mới ──
        let newPity4 = pity4Star;
        let newPity5 = pity5Star;
        let new4Guaranteed = is4StarGuaranteed;
        let new5Guaranteed = is5StarGuaranteed;

        for (const rv of rarityMap) {
            newPity4++;
            newPity5++;

            if (rv === "3.5" || rv === "4L") {
                // Xuất hiện 4 sao
                if (rv === "3.5") new4Guaranteed = true; // thua 50/50 → guaranteed tiếp theo
                else new4Guaranteed = false; // thắng guaranteed
                newPity4 = 0;
            }
            if (rv === "4.5" || rv === "5L") {
                // Xuất hiện 5 sao
                if (rv === "4.5") new5Guaranteed = true;
                else new5Guaranteed = false;
                newPity5 = 0;
            }
        }

        // ── 6. Chuẩn bị transaction items ──
        const now = Date.now();
        const transactItems = [];

        // Tạo inventory items
        const inventoryWrites = [];
        const historyWrites = [];

        for (let i = 0; i < rolledItems.length; i++) {
            const { rarityValue, item, sanityAmount } = rolledItems[i];
            const ts = now + i; // +1ms mỗi lượt để đảm bảo thứ tự

            if (item && !item.isSanity) {
                inventoryWrites.push({
                    Put: {
                        TableName: process.env.INVENTORY_TABLE,
                        Item: {
                            PK: userId,
                            SK: item.SK,
                            rarity: item.rarity,
                            name: item.name,
                            imageUrl: item.imageUrl,
                            itemType: item.itemType,
                            collectFrom: "gacha",
                            acquiredAt: new Date(ts).toISOString(),
                        },
                    },
                });

                historyWrites.push({
                    Put: {
                        TableName: process.env.GACHAHISTORY_TABLE,
                        Item: {
                            PK: userId,
                            SK: ts,
                            name: item.name,
                            rarity: item.rarity,
                            sanityAmount: 0,
                            expiresAt: Math.floor(now / 1000) + 6 * 30 * 24 * 60 * 60,
                        },
                    },
                });
            } else if (item?.isSanity) {
                historyWrites.push({
                    Put: {
                        TableName: process.env.GACHAHISTORY_TABLE,
                        Item: {
                            PK: userId,
                            SK: ts,
                            name: "Sanity",
                            rarity: "3",
                            sanityAmount,
                            expiresAt: Math.floor(now / 1000) + 6 * 30 * 24 * 60 * 60,
                        },
                    },
                });
            }
        }

        // Cập nhật profile
        const newSanity = (budget.sanity || 0) + totalSanity;
        transactItems.push({
            Update: {
                TableName: process.env.USER_TABLE,
                Key: { PK: userId, SK: "profile" },
                UpdateExpression: `SET budget.knowledgeCore = :kc,
                    budget.knowledgePoint = :kp,
                    budget.sanity = :sanity,
                    gachaStats.pity4Star = :p4,
                    gachaStats.pity5Star = :p5,
                    gachaStats.is4StarGuaranteed = :g4,
                    gachaStats.is5StarGuaranteed = :g5,
                    inventoryUpdatedAt = :now,
                    gachaHistoryUpdatedAt = :now,
                    updatedAt = :now`,
                ExpressionAttributeValues: {
                    ":kc": newKnowledgeCore,
                    ":kp": newKnowledgePoint,
                    ":sanity": newSanity,
                    ":p4": newPity4,
                    ":p5": newPity5,
                    ":g4": new4Guaranteed,
                    ":g5": new5Guaranteed,
                    ":now": now,
                },
            },
        });

        // DynamoDB TransactWrite hỗ trợ tối đa 100 items
        // Thực thi theo batch nếu cần
        const allWrites = [...inventoryWrites, ...historyWrites, ...transactItems];

        // Chia thành batch 25 (transact limit)
        const BATCH_SIZE = 25;
        for (let i = 0; i < allWrites.length; i += BATCH_SIZE) {
            await docClient.send(
                new TransactWriteCommand({
                    TransactItems: allWrites.slice(i, i + BATCH_SIZE),
                })
            );
        }

        // Kết quả trả về cho client
        const resultItems = rolledItems.map(({ rarityValue, item, sanityAmount }) => {
            if (item?.isSanity) {
                return { rarity: "3", name: "Sanity", sanityAmount };
            }
            return {
                rarity: item?.rarity,
                name: item?.name,
                imageUrl: item?.imageUrl,
                itemType: item?.itemType,
                SK: item?.SK,
            };
        });

        return successResponse({
            results: resultItems,
            newBudget: {
                knowledgeCore: newKnowledgeCore,
                knowledgePoint: newKnowledgePoint,
                sanity: newSanity,
            },
            newGachaStats: {
                pity4Star: newPity4,
                pity5Star: newPity5,
                is4StarGuaranteed: new4Guaranteed,
                is5StarGuaranteed: new5Guaranteed,
            },
            updatedAt: now,
        });
    } catch (err) {
        console.error("Lỗi gacha:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};
