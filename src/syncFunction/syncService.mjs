import { GetCommand, PutCommand, QueryCommand, UpdateCommand, BatchGetCommand, } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";
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

/**
 * Map equippedCosmetics sang assetUrl bằng cách tra bảng ITEMDATA_TABLE.
 * Trả về profile đã bổ sung trường cosmeticAssets.
 */
const mapCosmeticAssets = async (profile) => {
    const { equippedCosmetics } = profile;
    if (!equippedCosmetics) return profile;

    const keysToFetch = [];
    // equippedBackground thay thế equippedTheme
    if (equippedCosmetics.equippedBackground) {
        keysToFetch.push({ PK: "item", SK: equippedCosmetics.equippedBackground });
    }
    if (equippedCosmetics.equippedButton) {
        keysToFetch.push({ PK: "item", SK: equippedCosmetics.equippedButton });
    }
    if (equippedCosmetics.equippedFrame) {
        keysToFetch.push({ PK: "item", SK: equippedCosmetics.equippedFrame });
    }
    if (equippedCosmetics.equippedTitles && equippedCosmetics.equippedTitles.length > 0) {
        for (const t of equippedCosmetics.equippedTitles) {
            keysToFetch.push({ PK: "item", SK: t });
        }
    }

    if (keysToFetch.length === 0) return profile;

    // BatchGetItem — dùng static import
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
        itemMap[item.SK] = { assets: item.assets, imageUrl: item.imageUrl, name: item.name };
    }

    return { ...profile, cosmeticAssets: itemMap };
};

/**
 * Lấy inventory phân trang (limit 60).
 * Trả về { items, lastEvaluatedKey }
 */
const fetchInventoryPage = async (userId, exclusiveStartKey = null) => {
    const params = {
        TableName: process.env.INVENTORY_TABLE,
        KeyConditionExpression: "PK = :uid",
        ExpressionAttributeValues: { ":uid": userId },
        Limit: 60,
        ScanIndexForward: false,
    };
    if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;

    const result = await docClient.send(new QueryCommand(params));
    return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey || null,
    };
};

/**
 * Lấy lịch sử gacha phân trang (limit 30).
 */
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

/**
 * Lấy danh sách bạn bè phân trang (limit 15).
 * Trả về cả PENDING_IN, PENDING_OUT, ACCEPTED
 */
const fetchFriendsPage = async (userId, exclusiveStartKey = null) => {
    const params = {
        TableName: process.env.SOCIAL_TABLE,
        KeyConditionExpression: "PK = :uid",
        ExpressionAttributeValues: { ":uid": userId },
        Limit: 15,
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
    return dailyItem;
};

/**
 * Lấy hoặc refresh daily của userId.
 * Trả về { daily, isNew } – isNew = true nếu vừa tạo mới
 */
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

    // Cần refresh
    const newDaily = await refreshDaily(userId, profile);
    return { daily: newDaily, isNew: true };
};

// ═══════════════════════════════════════════════════════
// API HANDLERS
// ═══════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────
// POST /sync-all
// Body: {
//   updatedAt?: number,
//   inventoryUpdatedAt?: number,
//   gachaHistoryUpdatedAt?: number,
//   friendUpdatedAt?: number,
//   getDaily?: boolean
// }
// ───────────────────────────────────────────────────────
const handleSyncAll = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");
    try {
        const body = JSON.parse(event.body || "{}");
        const {
            updatedAt: clientUpdatedAt,
            inventoryUpdatedAt: clientInventoryUpdatedAt,
            gachaHistoryUpdatedAt: clientGachaAt,
            friendUpdatedAt: clientFriendAt,
            getDaily = false,
        } = body;

        const isFirstLoad =
            clientUpdatedAt == null &&
            clientInventoryUpdatedAt == null &&
            clientGachaAt == null &&
            clientFriendAt == null;

        // Lấy profile hiện tại
        const profile = await fetchProfile(userId);
        if (!profile) return errorResponse(404, "Không tìm thấy profile");

        const response = {};

        // ── Profile ──
        if (isFirstLoad || clientUpdatedAt !== profile.updatedAt) {
            response.profile = await mapCosmeticAssets(profile);
        }

        // ── Inventory ──
        if (isFirstLoad || clientInventoryUpdatedAt !== profile.inventoryUpdatedAt) {
            const inv = await fetchInventoryPage(userId);
            response.inventory = inv.items;
            response.inventoryLastKey = inv.lastEvaluatedKey;
        }

        // ── Gacha History ──
        if (isFirstLoad || clientGachaAt !== profile.gachaHistoryUpdatedAt) {
            const gh = await fetchGachaHistoryPage(userId);
            response.gachaHistory = gh.items;
            response.gachaHistoryLastKey = gh.lastEvaluatedKey;
        }

        // ── Friends ──
        if (isFirstLoad || clientFriendAt !== profile.friendUpdatedAt) {
            const fr = await fetchFriendsPage(userId);
            response.friends = fr.items;
            response.friendsLastKey = fr.lastEvaluatedKey;
        }

        // ── Daily ──
        const { daily, isNew } = await getOrRefreshDaily(userId, profile);
        if (isNew || getDaily) {
            response.daily = daily;
        }

        return successResponse(response);
    } catch (err) {
        console.error("Lỗi syncAll:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ───────────────────────────────────────────────────────
// GET /sync-profile
// ───────────────────────────────────────────────────────
const handleSyncProfile = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const profile = await fetchProfile(userId);
        if (!profile) return errorResponse(404, "Không tìm thấy profile");

        const profileWithAssets = await mapCosmeticAssets(profile);
        return successResponse({ profile: profileWithAssets });
    } catch (err) {
        console.error("Lỗi syncProfile:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ───────────────────────────────────────────────────────
// GET /sync-inventory
// Query params: lastKey (JSON string, optional)
// ───────────────────────────────────────────────────────
const handleSyncInventory = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        let exclusiveStartKey = null;
        const lastKeyStr = event.queryStringParameters?.lastKey;
        if (lastKeyStr) {
            exclusiveStartKey = JSON.parse(decodeURIComponent(lastKeyStr));
        }

        const inv = await fetchInventoryPage(userId, exclusiveStartKey);
        return successResponse({ inventory: inv.items, lastEvaluatedKey: inv.lastEvaluatedKey });
    } catch (err) {
        console.error("Lỗi syncInventory:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ───────────────────────────────────────────────────────
// GET /sync-gacha-history
// Query params: lastKey (JSON string, optional)
// ───────────────────────────────────────────────────────
const handleSyncGachaHistory = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

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
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ───────────────────────────────────────────────────────
// GET /sync-friends
// Query params: lastKey (JSON string, optional)
// ───────────────────────────────────────────────────────
const handleSyncFriends = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        let exclusiveStartKey = null;
        const lastKeyStr = event.queryStringParameters?.lastKey;
        if (lastKeyStr) {
            exclusiveStartKey = JSON.parse(decodeURIComponent(lastKeyStr));
        }

        const fr = await fetchFriendsPage(userId, exclusiveStartKey);
        return successResponse({ friends: fr.items, lastEvaluatedKey: fr.lastEvaluatedKey });
    } catch (err) {
        console.error("Lỗi syncFriends:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ───────────────────────────────────────────────────────
// GET /master-data
// Trả về toàn bộ item static từ ITEMDATA_TABLE (PK = "item")
// ───────────────────────────────────────────────────────
const handleGetMasterData = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

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
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

export {
    refreshDaily,
    getOrRefreshDaily,
    handleSyncAll,
    handleSyncProfile,
    handleSyncInventory,
    handleSyncGachaHistory,
    handleSyncFriends,
    handleGetMasterData,
};
