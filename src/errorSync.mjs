import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./database.mjs";
import { errorResponse } from "./response.mjs";

const INVENTORY_PAGE_SIZE = 10;
const HISTORY_PAGE_SIZE = 30;
const SOCIAL_PAGE_SIZE = 10;

const safeRead = async (name, operation, syncErrors) => {
    try {
        return await operation();
    } catch (error) {
        console.error(`[errorSync] Failed to read ${name}:`, error);
        syncErrors[name] = error.message || "Sync read failed";
        return null;
    }
};

const fetchProfile = (userId) => docClient.send(new GetCommand({
    TableName: process.env.USER_TABLE,
    Key: { PK: userId },
}));

const fetchDaily = (userId) => docClient.send(new GetCommand({
    TableName: process.env.QUEST_TABLE,
    Key: { PK: userId, SK: "daily" },
}));

const fetchHistory = (userId) => docClient.send(new QueryCommand({
    TableName: process.env.GACHAHISTORY_TABLE,
    KeyConditionExpression: "PK = :uid",
    ExpressionAttributeValues: { ":uid": userId },
    Limit: HISTORY_PAGE_SIZE,
    ScanIndexForward: false,
}));

const fetchSocial = (userId) => docClient.send(new QueryCommand({
    TableName: process.env.SOCIAL_TABLE,
    KeyConditionExpression: "PK = :uid",
    ExpressionAttributeValues: { ":uid": userId },
    Limit: SOCIAL_PAGE_SIZE,
}));

const getInventoryTypes = () => String(process.env.INVENTORY_TYPES || "background,frame,title,button,pet")
    .split(",")
    .map((type) => type.trim())
    .filter(Boolean);

const fetchInventory = async (userId, syncErrors) => {
    const inventory = {};
    await Promise.all(getInventoryTypes().map(async (itemType) => {
        const result = await safeRead(`inventory.${itemType}`, () => docClient.send(new QueryCommand({
            TableName: process.env.INVENTORY_TABLE,
            IndexName: "ItemTypeIndex",
            KeyConditionExpression: "PK = :uid AND itemType = :type",
            ExpressionAttributeValues: { ":uid": userId, ":type": itemType },
            Limit: INVENTORY_PAGE_SIZE,
            ScanIndexForward: false,
        })), syncErrors);
        if (result) {
            inventory[itemType] = {
                items: result.Items || [],
                lastEvaluatedKey: result.LastEvaluatedKey || null,
            };
        }
    }));
    return inventory;
};

const buildLatestSyncData = async (userId) => {
    if (!userId) return {};

    const syncErrors = {};
    const [profileResult, dailyResult, historyResult, socialResult, inventory] = await Promise.all([
        safeRead("profile", () => fetchProfile(userId), syncErrors),
        safeRead("daily", () => fetchDaily(userId), syncErrors),
        safeRead("gachaHistory", () => fetchHistory(userId), syncErrors),
        safeRead("social", () => fetchSocial(userId), syncErrors),
        fetchInventory(userId, syncErrors),
    ]);

    const data = {};
    if (profileResult?.Item) data.profile = profileResult.Item;
    if (dailyResult?.Item) data.daily = dailyResult.Item;
    if (historyResult) {
        data.gachaHistory = historyResult.Items || [];
        data.gachaHistoryLastKey = historyResult.LastEvaluatedKey || null;
    }
    if (socialResult) {
        data.social = socialResult.Items || [];
        data.friendsLastKey = socialResult.LastEvaluatedKey || null;
    }
    if (Object.keys(inventory).length > 0) data.inventory = inventory;
    if (Object.keys(syncErrors).length > 0) data.syncErrors = syncErrors;
    return data;
};

const syncedErrorResponse = async (userId, statusCode, message, data = {}) => {
    const latestData = await buildLatestSyncData(userId);
    return errorResponse(statusCode, message, { ...latestData, ...data });
};

export { buildLatestSyncData, syncedErrorResponse };
