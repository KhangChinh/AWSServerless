import { GetCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

//có thể xóa sau khi áp dụng hàm mới
const handleGetUser = async (event) => {
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub || authorizer?.claims?.sub;
    if (!userId) {
        return errorResponse(401, "Unauthorized");
    }
    try {
        const result = await docClient.send(new GetCommand({
            TableName: process.env.TABLE_NAME,
            Key: {
                PK: userId,
                SK: "profile"
            }
        }));
        if (result.Item) {
            return successResponse({ data: result.Item });
        } else {
            return errorResponse(404, "Không tìm thấy user profile");
        }
    } catch (error) {
        console.error("Lỗi đọc DynamoDB:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

const handleInitUser = async (event) => {
    const userId = event.request.userAttributes.sub;
    const { email, name } = event.request.userAttributes;
    const now = new Date().toISOString();
    const DEFAULT_AVATAR_URL = process.env.DEFAULT_AVATAR_URL;
    const profileItem = {
        PK: userId,
        SK: "profile",
        information: {
            name: name || "N/A",
            email: email,
            avatarUrl: DEFAULT_AVATAR_URL
        },
        budget: {
            knowledgePoint: 0,
            knowledgeCore: 0,
            sanity: 0,
            eCoin: 0
        },
        studyStats: {
            rankScore: 0,
            streak: 0,
            lastFocusDate: null
        },
        gachaStats: {
            pity4Star: 0,
            pity5Star: 0,
            isGuaranteed: false
        },
        "equippedCosmetics": {
            "equippedTheme": "default_light",
            "equippedFrame": null,
            "equippedTitles": []
        },
        inventoryUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
    };
    const inventoryItem = {
        PK: userId,
        SK: "inventory",
        themes: [
            { itemId: "default_light", acquiredAt: now },
            { itemId: "default_dark", acquiredAt: now }
        ],
        frames: [],
        titles: [],
        minigames: {
            sudoku: [],
            minesweeper: []
        },
        updatedAt: now,
    };
    const params = {
        RequestItems: {
            [process.env.TABLE_NAME]: [
                {
                    PutRequest: { Item: profileItem }
                },
                {
                    PutRequest: { Item: inventoryItem }
                }
            ]
        }
    };
    try {
        await docClient.send(new BatchWriteCommand(params));
        console.log(`Successfully initialized profile and inventory for user: ${email}`);
    } catch (error) {
        console.error("DynamoDB BatchWrite error:", error);
        throw new Error("Failed to initialize user data in DynamoDB.");
    }
    return event;
};

const handleGetProfile = async (event) => {
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub || authorizer?.claims?.sub;
    if (!userId) return errorResponse(401, "Unauthorized");
    try {
        const result = await docClient.send(new GetCommand({
            TableName: process.env.TABLE_NAME,
            Key: {
                PK: userId,
                SK: "profile"
            }
        }));
        if (result.Item) {
            return successResponse({ data: result.Item });
        } else {
            return errorResponse(404, "Không tìm thấy user profile");
        }
    } catch (error) {
        console.error("Lỗi đọc DynamoDB Profile:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

const handleUpdateProfile = async (event) => {
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub;
    if (!userId) return errorResponse(401, "Unauthorized");
    let body = JSON.parse(event.body);
    const { name, avatarUrl } = body;
    const now = new Date().toISOString();
    try {
        const updateResult = await docClient.send(new UpdateCommand({
            TableName: process.env.TABLE_NAME,
            Key: {
                PK: userId,
                SK: "profile"
            },
            UpdateExpression: "SET information.#name = :name, information.avatarUrl = :avatarUrl, updatedAt = :now",
            ExpressionAttributeNames: { "#name": "name" },
            ExpressionAttributeValues: {
                ":name": name,
                ":avatarUrl": avatarUrl,
                ":now": now
            },
            ReturnValues: "UPDATED_NEW"
        }));
        return successResponse({ message: "Cập nhật hồ sơ thành công", data: updateResult.Attributes });
    } catch (error) {
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

/*
Gửi từ frontend lên như vậy
Có nút save change để lưu thông tin rồi mới gửi
Ở giao diện thì cho để tối đa 3 title đc sử dụng 1 lúc
{
    "themeId": "cyberpunk_2077", //bắt buộc phải chọn
    "frameId": null, // null nghĩa là tháo frame ra
    "titles": ["novice_learner", "speed_runner"] //tối đa 3
}
*/
const handleEquipCosmetics = async (event) => {
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub;
    if (!userId) return errorResponse(401, "Unauthorized");
    let body = JSON.parse(event.body);
    const { themeId, frameId, titles } = body;
    if (titles && titles.length > 3) {
        return errorResponse(400, "Chỉ được trang bị tối đa 3 danh hiệu");
    }
    try {
        const inventoryResult = await docClient.send(new GetCommand({
            TableName: process.env.TABLE_NAME,
            Key: {
                PK: userId,
                SK: "inventory"
            }
        }));
        const inventory = inventoryResult.Item;
        if (!inventory) return errorResponse(404, "Không tìm thấy kho đồ");
        const isOwned = (categoryArray, itemId) => {
            if (!itemId) return true;
            return categoryArray.some(item => item.itemId === itemId);
        };
        if (themeId && !isOwned(inventory.themes, themeId)) {
            return errorResponse(403, "Bạn không sở hữu Theme này");
        }
        if (frameId && !isOwned(inventory.frames, frameId)) {
            return errorResponse(403, "Bạn không sở hữu Frame này");
        }
        if (titles) {
            for (let t of titles) {
                if (!isOwned(inventory.titles, t)) {
                    return errorResponse(403, `Bạn không sở hữu danh hiệu: ${t}`);
                }
            }
        }
        const now = new Date().toISOString();
        const updateResult = await docClient.send(new UpdateCommand({
            TableName: process.env.TABLE_NAME,
            Key: { PK: userId, SK: "profile" },
            UpdateExpression: "SET equippedCosmetics.equippedTheme = :themeId, equippedCosmetics.equippedFrame = :frameId, equippedCosmetics.equippedTitles = :titles, updatedAt = :now",
            ExpressionAttributeValues: {
                ":themeId": themeId || null,
                ":frameId": frameId || null,
                ":titles": titles || [],
                ":now": now
            },
            ReturnValues: "UPDATED_NEW"
        }));
        return successResponse({
            message: "Thay đổi trang bị thành công",
            equippedCosmetics: updateResult.Attributes.equippedCosmetics
        });

    } catch (error) {
        console.error("Lỗi trang bị đồ:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

export {
    handleGetUser,
    handleInitUser,
    handleGetProfile,
    handleUpdateProfile,
    handleEquipCosmetics
};
