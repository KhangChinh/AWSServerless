import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

const handleGetInventory = async (event) => {
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub || authorizer?.claims?.sub;
    if (!userId) return errorResponse(401, "Unauthorized");
    const clientUpdatedAt = event.queryStringParameters?.updatedAt;
    try {
        const result = await docClient.send(new GetCommand({
            TableName: process.env.TABLE_NAME,
            Key: {
                PK: userId,
                SK: "inventory"
            }
        }));
        if (!result.Item) return errorResponse(404, "Không tìm thấy kho đồ");
        const serverUpdatedAt = result.Item.updatedAt;
        if (clientUpdatedAt && clientUpdatedAt === serverUpdatedAt) {
            return successResponse({
                upToDate: true,
                message: "Kho đồ đang là mới nhất"
            });
        }
        return successResponse({
            upToDate: false,
            data: result.Item
        });

    } catch (error) {
        console.error("Lỗi Get Inventory:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

//hàm chưa được kiểm tra nên chưa dùng
const handleGrantItem = async (event) => {
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub || authorizer?.claims?.sub;
    if (!userId) return errorResponse(401, "Unauthorized");
    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return errorResponse(400, "Invalid JSON body");
    }
    const { category, itemId } = body;
    const validCategories = ["themes", "frames", "titles"];
    if (!validCategories.includes(category) || !itemId) {
        return errorResponse(400, "Danh mục hoặc vật phẩm không hợp lệ");
    }
    const now = new Date().toISOString();
    const newItemObject = { itemId: itemId, acquiredAt: now };
    const transactionParams = {
        TransactItems: [
            {
                Update: {
                    TableName: process.env.TABLE_NAME,
                    Key: { PK: userId, SK: "inventory" },
                    UpdateExpression: "SET #cat = list_append(if_not_exists(#cat, :empty_list), :newItem), updatedAt = :now",
                    ExpressionAttributeNames: {
                        "#cat": category
                    },
                    ExpressionAttributeValues: {
                        ":newItem": [newItemObject],
                        ":empty_list": [],
                        ":now": now
                    }
                }
            },
            {
                Update: {
                    TableName: process.env.TABLE_NAME,
                    Key: { PK: userId, SK: "profile" },
                    UpdateExpression: "SET inventoryUpdatedAt = :now, updatedAt = :now",
                    ExpressionAttributeValues: {
                        ":now": now
                    }
                }
            }
        ]
    };
    try {
        await docClient.send(new TransactWriteCommand(transactionParams));
        return successResponse({
            message: `Đã cấp phát ${itemId} thành công`,
            newItem: newItemObject,
            inventoryUpdatedAt: now
        });
    } catch (error) {
        console.error("Lỗi Transaction cấp item:", error);
        return errorResponse(500, "Không thể xử lý giao dịch lúc này");
    }
};

export {
    handleGetInventory,
    handleGrantItem
};