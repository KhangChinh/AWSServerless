import {
    GetCommand,
    UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

// Tỉ giá cố định: 160 KP = 1 Core
const KP_PER_CORE = 160;

// ═══════════════════════════════════════════════════════
// POST /currency/exchange
// Body: { amount: number }  (số lượng knowledgeCore muốn mua)
// Đổi knowledgePoint → knowledgeCore
// ═══════════════════════════════════════════════════════
export const handleExchangeKPToCore = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { amount } = body;

        if (!amount || typeof amount !== "number" || amount <= 0 || !Number.isInteger(amount)) {
            return errorResponse(400, "amount phải là số nguyên dương");
        }

        const kpRequired = amount * KP_PER_CORE;

        // Lấy profile
        const profileResult = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId, SK: "profile" },
            })
        );
        const profile = profileResult.Item;
        if (!profile) return errorResponse(404, "Không tìm thấy profile");

        const currentKP = profile.budget?.knowledgePoint || 0;
        const currentCore = profile.budget?.knowledgeCore || 0;

        if (currentKP < kpRequired) {
            return errorResponse(402, `Không đủ knowledgePoint. Cần ${kpRequired}, hiện có ${currentKP}`);
        }

        const newKP = currentKP - kpRequired;
        const newCore = currentCore + amount;
        const now = Date.now();

        await docClient.send(
            new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId, SK: "profile" },
                UpdateExpression:
                    "SET budget.knowledgePoint = :kp, budget.knowledgeCore = :kc, updatedAt = :now",
                ConditionExpression: "budget.knowledgePoint >= :required",
                ExpressionAttributeValues: {
                    ":kp": newKP,
                    ":kc": newCore,
                    ":now": now,
                    ":required": kpRequired,
                },
            })
        );

        return successResponse({
            message: `Đổi thành công ${amount} knowledgeCore`,
            newBudget: {
                knowledgePoint: newKP,
                knowledgeCore: newCore,
            },
            updatedAt: now,
        });
    } catch (err) {
        if (err.name === "ConditionalCheckFailedException") {
            return errorResponse(402, "Không đủ knowledgePoint để đổi");
        }
        console.error("Lỗi exchangeKPToCore:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};
