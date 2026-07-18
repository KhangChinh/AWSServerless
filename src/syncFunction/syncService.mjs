import { GetCommand, PutCommand, QueryCommand, UpdateCommand, BatchGetCommand, } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse } from "../response.mjs";
import { syncedErrorResponse } from "../errorSync.mjs";
import { getCachedQuests, getCachedMasterData } from "../cacheHelper.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

const fetchProfile = async (userId) => {
    const result = await docClient.send(
        new GetCommand({
            TableName: process.env.USER_TABLE,
            Key: { PK: userId },
        })
    );
    return result.Item || null;
};

const mapCosmeticAssets = async (profile) => {
    const { equippedCosmetics } = profile;
    if (!equippedCosmetics) return profile;
    const keysToFetch = [];
    if (equippedCosmetics.equippedBackground) {
        keysToFetch.push({ PK: "item", SK: equippedCosmetics.equippedBackground });
    }
    if (equippedCosmetics.equippedButton) {
        keysToFetch.push({ PK: "item", SK: equippedCosmetics.equippedButton });
    }
    if (equippedCosmetics.equippedFrame) {
        keysToFetch.push({ PK: "item", SK: equippedCosmetics.equippedFrame });
    }
    if (equippedCosmetics.equippedPet && equippedCosmetics.equippedPet !== "pet_none") {
        keysToFetch.push({ PK: "item", SK: equippedCosmetics.equippedPet });
    }
    if (equippedCosmetics.equippedTitles && equippedCosmetics.equippedTitles.length > 0) {
        for (const t of equippedCosmetics.equippedTitles) {
            keysToFetch.push({ PK: "item", SK: t });
        }
    }
    if (keysToFetch.length === 0) return profile;
    const batchResult = await docClient.send(
        new BatchGetCommand({
            RequestItems: {
                [process.env.ITEMDATA_TABLE]: {
                    Keys: keysToFetch,
                    ProjectionExpression: "SK, assets, imageUrl, #n",
                    ExpressionAttributeNames: { "#n": "name" },
                },
            },
        })
    );
    const itemMap = {};
    for (const item of batchResult.Responses?.[process.env.ITEMDATA_TABLE] || []) {
        itemMap[item.SK] = { id: item.SK, name: item.name, imageUrl: item.imageUrl, assets: item.assets };
    }
    const updatedEquipped = {};
    if (equippedCosmetics.equippedBackground) {
        updatedEquipped.equippedBackground = itemMap[equippedCosmetics.equippedBackground] || null;
    } else {
        updatedEquipped.equippedBackground = null;
    }
    if (equippedCosmetics.equippedButton) {
        updatedEquipped.equippedButton = itemMap[equippedCosmetics.equippedButton] || null;
    } else {
        updatedEquipped.equippedButton = null;
    }
    if (equippedCosmetics.equippedFrame) {
        updatedEquipped.equippedFrame = itemMap[equippedCosmetics.equippedFrame] || null;
    } else {
        updatedEquipped.equippedFrame = null;
    }
    if (equippedCosmetics.equippedPet && equippedCosmetics.equippedPet !== "pet_none") {
        updatedEquipped.equippedPet = itemMap[equippedCosmetics.equippedPet] || null;
    } else {
        updatedEquipped.equippedPet = null;
    }
    if (equippedCosmetics.equippedTitles && equippedCosmetics.equippedTitles.length > 0) {
        updatedEquipped.equippedTitles = equippedCosmetics.equippedTitles
            .map(t => itemMap[t])
            .filter(Boolean);
    } else {
        updatedEquipped.equippedTitles = [];
    }
    return {
        ...profile,
        equippedCosmetics: updatedEquipped
    };
};

const fetchInventoryPage = async (userId, exclusiveStartKey = null, itemType = null) => {
    const params = {
        TableName: process.env.INVENTORY_TABLE,
        Limit: 10,
        ScanIndexForward: false,
    };
    if (itemType) {
        params.IndexName = "ItemTypeIndex";
        params.KeyConditionExpression = "PK = :uid AND itemType = :type";
        params.ExpressionAttributeValues = {
            ":uid": userId,
            ":type": itemType
        };
    } else {
        throw new Error("Invalid request: itemType is required for inventory synchronization.");
    }
    if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;

    const result = await docClient.send(new QueryCommand(params));
    return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey || null,
    };
};

const fetchGachaHistoryPage = async (userId, exclusiveStartKey = null) => {
    const params = {
        TableName: process.env.GACHAHISTORY_TABLE,
        KeyConditionExpression: "PK = :uid",
        ExpressionAttributeValues: { ":uid": userId },
        Limit: 30,
        ScanIndexForward: false,
    };
    if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;

    const result = await docClient.send(new QueryCommand(params));
    return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey || null,
    };
};

const fetchSocialPage = async (userId, exclusiveStartKey = null) => {
    const params = {
        TableName: process.env.SOCIAL_TABLE,
        KeyConditionExpression: "PK = :uid",
        ExpressionAttributeValues: { ":uid": userId },
        Limit: 10,
    };
    if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;

    const result = await docClient.send(new QueryCommand(params));
    return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey || null,
    };
};

const refreshDaily = async (userId, profile) => {
    const now = Date.now();
    const todayDay = Math.floor(now / 86400000);
    const allQuests = await getCachedQuests(async () => {
        const questResult = await docClient.send(
            new QueryCommand({
                TableName: process.env.QUEST_TABLE,
                KeyConditionExpression: "PK = :qpk",
                ExpressionAttributeValues: { ":qpk": "quest" },
            })
        );
        return questResult.Items || [];
    });
    const fixedQuest = allQuests.find((q) => q.SK === "focus_daily");
    const allDailyQuest = allQuests.find((q) => q.SK === "all_daily");
    const randomPool = allQuests.filter((q) => q.SK !== "focus_daily" && q.SK !== "all_daily");
    const shuffled = randomPool.sort(() => Math.random() - 0.5).slice(0, 3);
    const fixedQuests = [fixedQuest, allDailyQuest].filter(Boolean);
    const chosenQuests = [...fixedQuests, ...shuffled];
    const questsMap = {};
    for (const q of chosenQuests) {
        questsMap[q.SK] = {
            type: q.type,
            name: q.name,
            description: q.description,
            target: q.target,
            knowledgePoint: q.knowledgePoint,
            progress: 0,
            isCompleted: false,
            isClaimed: false,
        };
    }

    const lastFocusDay = profile?.studyStats?.lastFocusDate
        ? Math.floor(profile.studyStats.lastFocusDate)
        : null;

    let streakUpdate = null;
    if (lastFocusDay !== null && lastFocusDay !== todayDay - 1) {
        streakUpdate = {
            streak: 0,
            updatedAt: now,
        };
    }

    const endOfTodayMs = (todayDay + 1) * 86400000;
    const expiresAt = Math.floor(endOfTodayMs / 1000);

    const dailyItem = {
        PK: userId,
        SK: "daily",
        quests: questsMap,
        expiresAt,
    };
    const profileUpdates = {
        UpdateExpression: "SET studyStats.timeToStreak = :tts, updatedAt = :now",
        ExpressionAttributeValues: {
            ":tts": 30,
            ":now": now,
        },
    };
    if (streakUpdate) {
        profileUpdates.UpdateExpression += ", studyStats.streak = :streak";
        profileUpdates.ExpressionAttributeValues[":streak"] = 0;
    }
    await Promise.all([
        docClient.send(
            new PutCommand({
                TableName: process.env.QUEST_TABLE,
                Item: dailyItem,
            })
        ),
        docClient.send(
            new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
                ...profileUpdates,
            })
        ),
    ]);
    if (profile) {
        if (!profile.studyStats) profile.studyStats = {};
        profile.studyStats.timeToStreak = 30;
        profile.updatedAt = now;
        if (streakUpdate) {
            profile.studyStats.streak = 0;
        }
    }
    return dailyItem;
};

const getOrRefreshDaily = async (userId, profile) => {
    const now = Math.floor(Date.now() / 1000);
    const result = await docClient.send(
        new GetCommand({
            TableName: process.env.QUEST_TABLE,
            Key: { PK: userId, SK: "daily" },
        })
    );

    const existing = result.Item;
    if (existing && existing.expiresAt && existing.expiresAt > now) {
        return { daily: existing, isNew: false };
    }

    const newDaily = await refreshDaily(userId, profile);
    return { daily: newDaily, isNew: true };
};

const handleSyncAll = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");
    try {
        const body = JSON.parse(event.body || "{}");
        const {
            getProfile = true,
            getDaily = false,
            getInventory = false,
            getGachaHistory = false,
            getSocial = false
        } = body;
        const response = { success: true };
        const profile = (getProfile || getDaily) ? await fetchProfile(userId) : {};
        if (!profile) return await syncedErrorResponse(getUserId(event), 404, "Không tìm thấy profile");
        if (getProfile) {
            response.profile = await mapCosmeticAssets(profile);
        }
        if (getDaily) {
            const { daily } = await getOrRefreshDaily(userId, profile);
            response.daily = daily;
        }
        const promises = [];
        if (getInventory) {
            const types = String(process.env.INVENTORY_TYPES )
                .split(",")
                .map(type => type.trim())
                .filter(Boolean);
            response.inventory = {};
            for (const type of types) {
                promises.push(
                    fetchInventoryPage(userId, null, type).then(inv => {
                        response.inventory[type] = {
                            items: inv.items,
                            lastEvaluatedKey: inv.lastEvaluatedKey
                        };
                    })
                );
            }
        }
        if (getGachaHistory) {
            promises.push(
                fetchGachaHistoryPage(userId).then(gh => {
                    response.gachaHistory = gh.items;
                    response.gachaHistoryLastKey = gh.lastEvaluatedKey;
                })
            );
        }
        if (getSocial) {
            promises.push(
                fetchSocialPage(userId).then(fr => {
                    response.social = fr.items;
                    response.socialLastKey = fr.lastEvaluatedKey;
                })
            );
        }
        if (promises.length > 0) {
            await Promise.all(promises);
        }
        return successResponse(response);
    } catch (err) {
        console.error("Lỗi syncAll:", err);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

// ───────────────────────────────────────────────────────
// GET /sync-profile
// ───────────────────────────────────────────────────────
const handleSyncProfile = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");
    try {
        const profile = await fetchProfile(userId);
        if (!profile) return await syncedErrorResponse(getUserId(event), 404, "Không tìm thấy profile");
        const profileWithAssets = await mapCosmeticAssets(profile);
        return successResponse({ profile: profileWithAssets });
    } catch (err) {
        console.error("Lỗi syncProfile:", err);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

// ───────────────────────────────────────────────────────
// GET /sync-inventory
// Query params: lastKey (JSON string, optional)
// ───────────────────────────────────────────────────────
const handleSyncInventory = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        const itemType = event.queryStringParameters?.itemType;
        if (!itemType) return await syncedErrorResponse(getUserId(event), 400, "Thiếu itemType");
        let exclusiveStartKey = null;
        const lastKeyStr = event.queryStringParameters?.lastKey;
        if (lastKeyStr) {
            exclusiveStartKey = JSON.parse(decodeURIComponent(lastKeyStr));
        }
        const inv = await fetchInventoryPage(userId, exclusiveStartKey, itemType);
        return successResponse({ inventory: inv.items, lastEvaluatedKey: inv.lastEvaluatedKey });
    } catch (err) {
        console.error("Lỗi syncInventory:", err);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

// ───────────────────────────────────────────────────────
// GET /sync-gacha-history
// Query params: lastKey (JSON string, optional)
// ───────────────────────────────────────────────────────
const handleSyncGachaHistory = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        let exclusiveStartKey = null;
        const lastKeyStr = event.queryStringParameters?.lastKey;
        if (lastKeyStr) {
            exclusiveStartKey = JSON.parse(decodeURIComponent(lastKeyStr));
        }

        const gh = await fetchGachaHistoryPage(userId, exclusiveStartKey);
        return successResponse({ gachaHistory: gh.items, lastEvaluatedKey: gh.lastEvaluatedKey });
    } catch (err) {
        console.error("Lỗi syncGachaHistory:", err);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

// ───────────────────────────────────────────────────────
// GET /sync-social
// Query params: lastKey (JSON string, optional)
// ───────────────────────────────────────────────────────
const handleSyncSocial = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        let exclusiveStartKey = null;
        const lastKeyStr = event.queryStringParameters?.lastKey;
        if (lastKeyStr) {
            exclusiveStartKey = JSON.parse(decodeURIComponent(lastKeyStr));
        }

        const fr = await fetchSocialPage(userId, exclusiveStartKey);
        return successResponse({ social: fr.items, lastEvaluatedKey: fr.lastEvaluatedKey });
    } catch (err) {
        console.error("Lỗi syncSocial:", err);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

// ───────────────────────────────────────────────────────
// GET /master-data
// Trả về toàn bộ item static từ ITEMDATA_TABLE (PK = "item")
// ───────────────────────────────────────────────────────
const handleGetMasterData = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        // Lấy master data từ ITEMDATA_TABLE — SỬ DỤNG CACHE
        const items = await getCachedMasterData(async () => {
            const result = await docClient.send(
                new QueryCommand({
                    TableName: process.env.ITEMDATA_TABLE,
                    KeyConditionExpression: "PK = :pk",
                    ExpressionAttributeValues: { ":pk": "item" },
                })
            );
            return result.Items || [];
        });

        return successResponse({ items });
    } catch (err) {
        console.error("Lỗi getMasterData:", err);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

const handleCheckVersion = async (event) => {
    try {
        const currentVersion = process.env.VERSION || null;
        return successResponse({
            version: currentVersion,
            timestamp: Date.now()
        });
    } catch (err) {
        console.error("Lỗi checkVersion:", err);
        // Do endpoint này có thể gọi khi chưa đăng nhập, ta không cần truyền getUserId(event)
        return await syncedErrorResponse(null, 500, "Lỗi máy chủ nội bộ");
    }
};

export {
    refreshDaily,
    getOrRefreshDaily,
    handleSyncAll,
    handleSyncProfile,
    handleSyncInventory,
    handleSyncGachaHistory,
    handleSyncSocial,
    handleGetMasterData,
    mapCosmeticAssets,
    fetchInventoryPage,
    handleCheckVersion
};
