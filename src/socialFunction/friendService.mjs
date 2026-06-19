/**
 * friendService.mjs
 * Quản lý danh sách bạn bè: lấy, gửi lời mời, chấp nhận, xóa.
 */

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
// GET /friends
// Query params: lastKey (optional JSON string)
// Lấy danh sách bạn bè phân trang (bao gồm PENDING_IN, PENDING_OUT, ACCEPTED)
// ═══════════════════════════════════════════════════════
export const handleGetFriends = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        let exclusiveStartKey = null;
        const lastKeyStr = event.queryStringParameters?.lastKey;
        if (lastKeyStr) {
            exclusiveStartKey = JSON.parse(decodeURIComponent(lastKeyStr));
        }

        const params = {
            TableName: process.env.SOCIAL_TABLE,
            KeyConditionExpression: "PK = :uid",
            ExpressionAttributeValues: { ":uid": userId },
            Limit: 60,
        };
        if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;

        const result = await docClient.send(new QueryCommand(params));
        return successResponse({
            friends: result.Items || [],
            lastEvaluatedKey: result.LastEvaluatedKey || null,
        });
    } catch (err) {
        console.error("Lỗi getFriends:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// POST /friends/request
// Body: { targetUserId: string }
// Người dùng A gửi lời mời kết bạn cho B
// ═══════════════════════════════════════════════════════
export const handleSendFriendRequest = async (event) => {
    const userId = getUserId(event); // A
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { targetUserId } = body; // B

        if (!targetUserId) return errorResponse(400, "targetUserId là bắt buộc");
        if (targetUserId === userId) return errorResponse(400, "Không thể kết bạn với chính mình");

        // Kiểm tra đã tồn tại chưa
        const existingResult = await docClient.send(
            new GetCommand({
                TableName: process.env.SOCIAL_TABLE,
                Key: { PK: userId, SK: targetUserId },
            })
        );
        if (existingResult.Item) {
            return errorResponse(409, "Đã là bạn bè hoặc đã gửi lời mời trước đó");
        }

        // Lấy thông tin A và B để lưu vào bản ghi social
        const [profileA, profileB] = await Promise.all([
            docClient.send(
                new GetCommand({
                    TableName: process.env.USER_TABLE,
                    Key: { PK: userId, SK: "profile" },
                })
            ),
            docClient.send(
                new GetCommand({
                    TableName: process.env.USER_TABLE,
                    Key: { PK: targetUserId, SK: "profile" },
                })
            ),
        ]);

        if (!profileB.Item) return errorResponse(404, "Không tìm thấy người dùng");

        const now = Date.now();

        await docClient.send(
            new TransactWriteCommand({
                TransactItems: [
                    // Bản ghi A → B (PENDING_OUT)
                    {
                        Put: {
                            TableName: process.env.SOCIAL_TABLE,
                            Item: {
                                PK: userId,
                                SK: targetUserId,
                                friendName: profileB.Item.information?.name,
                                friendAvatarUrl: profileB.Item.information?.avatarUrl,
                                status: "PENDING_OUT",
                                createdAt: now,
                                updatedAt: now,
                            },
                            ConditionExpression: "attribute_not_exists(PK)",
                        },
                    },
                    // Bản ghi B → A (PENDING_IN)
                    {
                        Put: {
                            TableName: process.env.SOCIAL_TABLE,
                            Item: {
                                PK: targetUserId,
                                SK: userId,
                                friendName: profileA.Item?.information?.name,
                                friendAvatarUrl: profileA.Item?.information?.avatarUrl,
                                status: "PENDING_IN",
                                createdAt: now,
                                updatedAt: now,
                            },
                            ConditionExpression: "attribute_not_exists(PK)",
                        },
                    },
                    // Cập nhật friendUpdatedAt cho A
                    {
                        Update: {
                            TableName: process.env.USER_TABLE,
                            Key: { PK: userId, SK: "profile" },
                            UpdateExpression: "SET friendUpdatedAt = :now, updatedAt = :now",
                            ExpressionAttributeValues: { ":now": now },
                        },
                    },
                    // Cập nhật friendUpdatedAt cho B
                    {
                        Update: {
                            TableName: process.env.USER_TABLE,
                            Key: { PK: targetUserId, SK: "profile" },
                            UpdateExpression: "SET friendUpdatedAt = :now, updatedAt = :now",
                            ExpressionAttributeValues: { ":now": now },
                        },
                    },
                ],
            })
        );

        return successResponse({ message: "Đã gửi lời mời kết bạn", updatedAt: now });
    } catch (err) {
        if (err.name === "TransactionCanceledException") {
            return errorResponse(409, "Lời mời đã tồn tại hoặc điều kiện thay đổi");
        }
        console.error("Lỗi sendFriendRequest:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// POST /friends/accept
// Body: { targetUserId: string }
// Người dùng B đồng ý lời mời của A
// ═══════════════════════════════════════════════════════
export const handleAcceptFriendRequest = async (event) => {
    const userId = getUserId(event); // B
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { targetUserId } = body; // A

        if (!targetUserId) return errorResponse(400, "targetUserId là bắt buộc");

        // Kiểm tra bản ghi B→A có đúng là PENDING_IN không
        const check = await docClient.send(
            new GetCommand({
                TableName: process.env.SOCIAL_TABLE,
                Key: { PK: userId, SK: targetUserId },
            })
        );
        if (!check.Item || check.Item.status !== "PENDING_IN") {
            return errorResponse(400, "Không có lời mời kết bạn hợp lệ");
        }

        const now = Date.now();

        await docClient.send(
            new TransactWriteCommand({
                TransactItems: [
                    // Cập nhật B → A thành ACCEPTED
                    {
                        Update: {
                            TableName: process.env.SOCIAL_TABLE,
                            Key: { PK: userId, SK: targetUserId },
                            UpdateExpression: "SET #s = :accepted, updatedAt = :now",
                            ExpressionAttributeNames: { "#s": "status" },
                            ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":now": now },
                        },
                    },
                    // Cập nhật A → B thành ACCEPTED
                    {
                        Update: {
                            TableName: process.env.SOCIAL_TABLE,
                            Key: { PK: targetUserId, SK: userId },
                            UpdateExpression: "SET #s = :accepted, updatedAt = :now",
                            ExpressionAttributeNames: { "#s": "status" },
                            ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":now": now },
                        },
                    },
                    // Cập nhật friendUpdatedAt cho cả 2
                    {
                        Update: {
                            TableName: process.env.USER_TABLE,
                            Key: { PK: userId, SK: "profile" },
                            UpdateExpression: "SET friendUpdatedAt = :now, updatedAt = :now",
                            ExpressionAttributeValues: { ":now": now },
                        },
                    },
                    {
                        Update: {
                            TableName: process.env.USER_TABLE,
                            Key: { PK: targetUserId, SK: "profile" },
                            UpdateExpression: "SET friendUpdatedAt = :now, updatedAt = :now",
                            ExpressionAttributeValues: { ":now": now },
                        },
                    },
                ],
            })
        );

        return successResponse({ message: "Đã chấp nhận kết bạn", updatedAt: now });
    } catch (err) {
        console.error("Lỗi acceptFriendRequest:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// POST /friends/remove
// Body: { targetUserId: string }
// Từ chối / hủy lời mời / xóa bạn
// ═══════════════════════════════════════════════════════
export const handleRemoveFriend = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { targetUserId } = body;

        if (!targetUserId) return errorResponse(400, "targetUserId là bắt buộc");

        const now = Date.now();

        await docClient.send(
            new TransactWriteCommand({
                TransactItems: [
                    { Delete: { TableName: process.env.SOCIAL_TABLE, Key: { PK: userId, SK: targetUserId } } },
                    { Delete: { TableName: process.env.SOCIAL_TABLE, Key: { PK: targetUserId, SK: userId } } },
                    {
                        Update: {
                            TableName: process.env.USER_TABLE,
                            Key: { PK: userId, SK: "profile" },
                            UpdateExpression: "SET friendUpdatedAt = :now, updatedAt = :now",
                            ExpressionAttributeValues: { ":now": now },
                        },
                    },
                    {
                        Update: {
                            TableName: process.env.USER_TABLE,
                            Key: { PK: targetUserId, SK: "profile" },
                            UpdateExpression: "SET friendUpdatedAt = :now, updatedAt = :now",
                            ExpressionAttributeValues: { ":now": now },
                        },
                    },
                ],
            })
        );

        return successResponse({ message: "Đã xóa/từ chối kết bạn", updatedAt: now });
    } catch (err) {
        console.error("Lỗi removeFriend:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};
