import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse } from "../response.mjs";
import { syncedErrorResponse } from "../errorSync.mjs";
import { mapCosmeticAssets } from "../syncFunction/syncService.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

export const handleConvertKPointToKCore = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const targetCores = parseInt(body.targetCores, 10); // Số knowledgeCore muốn đổi

        if (!targetCores || targetCores <= 0) {
            return await syncedErrorResponse(getUserId(event), 400, "Số lượng quy đổi không hợp lệ.");
        }

        const requiredPoints = targetCores * 150;

        // 1. Lấy Profile
        const profileRes = await docClient.send(new GetCommand({
            TableName: process.env.USER_TABLE,
            Key: { PK: userId }
        }));

        const profile = profileRes.Item;
        if (!profile) return await syncedErrorResponse(getUserId(event), 404, "Không tìm thấy profile");

        // 2. Kiểm tra số dư
        let budget = profile.budget || {};
        let { knowledgeCore = 0, knowledgePoint = 0 } = budget;

        if (knowledgePoint < requiredPoints) {
            return await syncedErrorResponse(getUserId(event), 400, `Không đủ tài nguyên. Cần ${requiredPoints} Knowledge Point.`);
        }

        // 3. Tính toán
        budget.knowledgePoint -= requiredPoints;
        budget.knowledgeCore += targetCores;
        const now = Date.now();

        // 4. Lưu DB
        await docClient.send(new UpdateCommand({
            TableName: process.env.USER_TABLE,
            Key: { PK: userId },
            UpdateExpression: "SET budget = :b, updatedAt = :u",
            ExpressionAttributeValues: { ":b": budget, ":u": now }
        }));

        // 5. Trả kết quả đồng bộ
        profile.budget = budget;
        const finalProfile = await mapCosmeticAssets(profile);

        return successResponse({
            success: true,
            profile: finalProfile
        });
    } catch (error) {
        console.error("Lỗi Convert:", error);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};