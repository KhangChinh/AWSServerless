import { GetCommand, UpdateCommand, BatchGetCommand, BatchWriteCommand, } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

const handleInitUser = async (event) => {
    const userId = event.request.userAttributes.sub;
    const { email, name } = event.request.userAttributes;
    const now = Date.now();
    const defaultItemsConfig = {
        background: "bg_default",
    };
    const defaultItemSKs = Object.values(defaultItemsConfig);
    if (defaultItemSKs.length > 0) {
        try {
            const keysToGet = defaultItemSKs.map(sk => ({
                PK: "item",
                SK: sk
            }));
            const getResponse = await docClient.send(
                new BatchGetCommand({
                    RequestItems: {
                        [process.env.ITEM_TABLE]: {
                            Keys: keysToGet
                        }
                    }
                })
            );
            systemItems = getResponse.Responses[process.env.ITEM_TABLE] || [];
        } catch (error) {
            console.error("DynamoDB BatchGet error:", error);
            throw new Error("Failed to fetch default items from Database.");
        }
    }
    const inventoryPutRequests = systemItems.map(item => {
        const { PK, SK, currencyType, price, isLimited, ...coreAttributes } = item;
        return {
            PutRequest: {
                Item: {
                    ...coreAttributes,
                    PK: userId,
                    SK: SK,
                    acquiredAt: new Date(now).toISOString()
                }
            }
        };
    });
    const profileItem = {
        PK: userId,
        information: {
            name: name || "N/A",
            email: email,
            avatarUrl: process.env.DEFAULT_AVATAR_URL,
        },
        budget: {
            knowledgePoint: 1500,
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
            equippedBackground: defaultItemsConfig.background || null,
            equippedButton: defaultItemsConfig.button || null,
            equippedFrame: defaultItemsConfig.frame || null,
            equippedTitles: [],
        },
        inventoryUpdatedAt: now,
        gachaHistoryUpdatedAt: now,
        friendUpdatedAt: now,
        avatarUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
    };
    const requestItems = {
        [process.env.USER_TABLE]: [
            { PutRequest: { Item: profileItem } },
        ]
    };
    if (inventoryPutRequests.length > 0) {
        requestItems
        [process.env.INVENTORY_TABLE] = inventoryPutRequests;
    }
    try {
        await docClient.send(
            new BatchWriteCommand({
                RequestItems: requestItems
            })
        );
        console.log(`Khởi tạo thành công profile và inventory cho user: ${email}`);
    } catch (error) {
        console.error("DynamoDB BatchWrite error:", error);
        throw new Error("Failed to initialize user data in DynamoDB.");
    }
    return event;
};

const handleGetProfile = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");
    try {
        const result = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
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

const handleUpdateProfile = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { name } = body;
        if (!name || typeof name !== "string" || name.trim().length === 0) {
            return errorResponse(400, "name không hợp lệ");
        }

        const now = Date.now();
        await docClient.send(
            new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
                UpdateExpression: "SET information.#name = :name, updatedAt = :now",
                ExpressionAttributeNames: { "#name": "name" },
                ExpressionAttributeValues: {
                    ":name": name.trim(),
                    ":now": now,
                },
            })
        );
        const result = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
            })
        );
        return successResponse({
            message: "Cập nhật tên thành công",
            profile: result.Item,
        });
    } catch (error) {
        console.error("Lỗi cập nhật profile:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

const handleEquipCosmetics = async (event) => {
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
        await docClient.send(
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
            })
        );
        const result = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId, SK: "profile" },
            })
        );
        return successResponse({
            message: "Thay đổi trang bị thành công",
            profile: result.Item,
        });
    } catch (error) {
        console.error("Lỗi trang bị đồ:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

export {
    handleInitUser,
    handleGetProfile,
    handleUpdateProfile,
    handleEquipCosmetics,
}