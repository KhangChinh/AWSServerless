import {
    GetCommand,
    PutCommand,
    UpdateCommand,
    BatchGetCommand,
    BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

// ═══════════════════════════════════════════════════════
// HELPER
// ═══════════════════════════════════════════════════════
const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

// ═══════════════════════════════════════════════════════
// Cognito PostConfirmation Trigger
// Khởi tạo profile + cấp background default vào inventory
// ═══════════════════════════════════════════════════════
export const handleInitUser = async (event) => {
    const userId = event.request.userAttributes.sub;
    const { email, name } = event.request.userAttributes;
    const now = Date.now();

    // avatarUrl trỏ về URL mặc định (full URL lưu trong env, client dùng thẳng)
    const profileItem = {
        PK: userId,
        SK: "profile",
        information: {
            name: name || "N/A",
            email: email,
            avatarUrl: process.env.DEFAULT_AVATAR_URL,
        },
        budget: {
            knowledgePoint: 0,
            knowledgeCore: 0,
            sanity: 0,
            eCoin: 0,
        },
        studyStats: {
            rankScore: 0,
            timeToStreak: 30,
            streak: 0,
            lastFocusDate: null,
        },
        gachaStats: {
            pity4Star: 0,
            pity5Star: 0,
            is4StarGuaranteed: false,
            is5StarGuaranteed: false,
        },
        equippedCosmetics: {
            equippedBackground: "default",
            equippedButton: null,
            equippedFrame: null,
            equippedTitles: [],
        },
        inventoryUpdatedAt: now,
        gachaHistoryUpdatedAt: now,
        friendUpdatedAt: now,
        avatarUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
    };

    // Cấp sẵn background default vào inventory
    // imageUrl khớp với field imageUrl của item "default" trong ITEMDATA_TABLE
    const inventoryDefaultBg = {
        PK: userId,
        SK: "default",
        rarity: "3",
        name: "Default Background",
        imageUrl: "background/default/default.jpg",
        itemType: "background",
        collectFrom: null,
        acquiredAt: new Date(now).toISOString(),
    };

    try {
        await docClient.send(
            new BatchWriteCommand({
                RequestItems: {
                    [process.env.USER_TABLE]: [
                        { PutRequest: { Item: profileItem } },
                    ],
                    [process.env.INVENTORY_TABLE]: [
                        { PutRequest: { Item: inventoryDefaultBg } },
                    ],
                },
            })
        );
        console.log(`Khởi tạo thành công profile và inventory cho user: ${email}`);
    } catch (error) {
        console.error("DynamoDB BatchWrite error:", error);
        throw new Error("Failed to initialize user data in DynamoDB.");
    }

    return event;
};

// ═══════════════════════════════════════════════════════
// GET /get-profile
// ═══════════════════════════════════════════════════════
export const handleGetProfile = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const result = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId, SK: "profile" },
            })
        );
        if (result.Item) {
            return successResponse({ data: result.Item });
        }
        return errorResponse(404, "Không tìm thấy user profile");
    } catch (error) {
        console.error("Lỗi đọc profile:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// PUT /update-profile
// Body: { name: string }
// Chỉ cập nhật tên — avatar tách riêng qua avatarService
// ═══════════════════════════════════════════════════════
export const handleUpdateProfile = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { name } = body;

        if (!name || typeof name !== "string" || name.trim().length === 0) {
            return errorResponse(400, "name không hợp lệ");
        }

        const now = Date.now();
        const updateResult = await docClient.send(
            new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId, SK: "profile" },
                UpdateExpression: "SET information.#name = :name, updatedAt = :now",
                ExpressionAttributeNames: { "#name": "name" },
                ExpressionAttributeValues: {
                    ":name": name.trim(),
                    ":now": now,
                },
                ReturnValues: "UPDATED_NEW",
            })
        );
        return successResponse({
            message: "Cập nhật tên thành công",
            data: updateResult.Attributes,
        });
    } catch (error) {
        console.error("Lỗi cập nhật profile:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// PUT /change-cosmetics
// Body: {
//   backgroundId: string,   // bắt buộc, phải sở hữu
//   frameId: string | null, // null = tháo frame
//   titles: string[]        // tối đa 3
// }
// Server kiểm tra sở hữu bằng BatchGetItem trên INVENTORY_TABLE (flat schema)
// ═══════════════════════════════════════════════════════
export const handleEquipCosmetics = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { backgroundId, frameId, titles } = body;

        if (!backgroundId) {
            return errorResponse(400, "backgroundId là bắt buộc");
        }
        if (titles && titles.length > 3) {
            return errorResponse(400, "Chỉ được trang bị tối đa 3 danh hiệu");
        }

        // Xây danh sách các SK cần kiểm tra sở hữu
        const itemsToCheck = [{ PK: userId, SK: backgroundId }];
        if (frameId) itemsToCheck.push({ PK: userId, SK: frameId });
        if (titles && titles.length > 0) {
            for (const t of titles) {
                itemsToCheck.push({ PK: userId, SK: t });
            }
        }

        // BatchGetItem để kiểm tra sở hữu — static import, không dùng dynamic
        const batchResult = await docClient.send(
            new BatchGetCommand({
                RequestItems: {
                    [process.env.INVENTORY_TABLE]: {
                        Keys: itemsToCheck,
                        ProjectionExpression: "SK",
                    },
                },
            })
        );

        const ownedSet = new Set(
            (batchResult.Responses?.[process.env.INVENTORY_TABLE] || []).map((i) => i.SK)
        );

        if (!ownedSet.has(backgroundId)) {
            return errorResponse(403, "Bạn không sở hữu Background này");
        }
        if (frameId && !ownedSet.has(frameId)) {
            return errorResponse(403, "Bạn không sở hữu Frame này");
        }
        if (titles) {
            for (const t of titles) {
                if (!ownedSet.has(t)) {
                    return errorResponse(403, `Bạn không sở hữu danh hiệu: ${t}`);
                }
            }
        }

        const now = Date.now();
        const updateResult = await docClient.send(
            new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId, SK: "profile" },
                UpdateExpression:
                    "SET equippedCosmetics.equippedBackground = :bg, " +
                    "equippedCosmetics.equippedFrame = :frame, " +
                    "equippedCosmetics.equippedTitles = :titles, " +
                    "updatedAt = :now",
                ExpressionAttributeValues: {
                    ":bg": backgroundId,
                    ":frame": frameId ?? null,
                    ":titles": titles ?? [],
                    ":now": now,
                },
                ReturnValues: "UPDATED_NEW",
            })
        );

        return successResponse({
            message: "Thay đổi trang bị thành công",
            equippedCosmetics: updateResult.Attributes?.equippedCosmetics,
            updatedAt: now,
        });
    } catch (error) {
        console.error("Lỗi trang bị đồ:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};
