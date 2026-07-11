import {
    GetCommand,
    UpdateCommand,
    TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse } from "../response.mjs";
import { syncedErrorResponse } from "../errorSync.mjs";
import { getOrRefreshDaily } from "../syncFunction/syncService.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

// ═══════════════════════════════════════════════════════
// INTERNAL: Cập nhật tiến độ quest
// Được gọi từ các hàm khác (end session, gacha, ...)
// Params:
//   userId  – string
//   type    – "FOCUS" | "PLAY_SUDOKU" | "PLAY_MINESWEEPER" | "GACHA" | ...
//   amount  – số lượng cộng vào progress (mặc định 1)
// Returns: { updatedQuests } hoặc null nếu không có gì thay đổi
// ═══════════════════════════════════════════════════════
const updateQuestProgress = async (userId, type, amount = 1) => {
    // Lấy daily hiện tại
    const dailyResult = await docClient.send(
        new GetCommand({
            TableName: process.env.QUEST_TABLE,
            Key: { PK: userId, SK: "daily" },
        })
    );
    const daily = dailyResult.Item;
    if (!daily) return null;

    const now = Math.floor(Date.now() / 1000);
    if (!daily.expiresAt || daily.expiresAt < now) return null; // daily đã hết hạn

    const quests = daily.quests || {};
    let changed = false;
    let allDailyDelta = 0;

    // Cập nhật từng quest có type tương ứng và chưa hoàn thành
    const updatedQuests = { ...quests };
    for (const [key, quest] of Object.entries(updatedQuests)) {
        if (key === "all_daily") continue;
        if (quest.type !== type) continue;
        if (quest.isCompleted) continue;

        const newProgress = (quest.progress || 0) + amount;
        updatedQuests[key] = { ...quest, progress: newProgress };

        if (newProgress >= quest.target) {
            updatedQuests[key].isCompleted = true;
            allDailyDelta++;
            changed = true;
        } else {
            changed = true;
        }
    }

    if (!changed) return null;

    // Cập nhật all_daily
    const allDaily = updatedQuests["all_daily"];
    if (allDaily) {
        const newAllProgress = (allDaily.progress || 0) + allDailyDelta;
        const newAllCompleted = newAllProgress >= (allDaily.target || 4);
        updatedQuests["all_daily"] = {
            ...allDaily,
            progress: newAllProgress,
            isCompleted: newAllCompleted,
        };
    }

    const result = await docClient.send(
        new UpdateCommand({
            TableName: process.env.QUEST_TABLE,
            Key: { PK: userId, SK: "daily" },
            UpdateExpression: "SET quests = :q",
            ExpressionAttributeValues: { ":q": updatedQuests },
            ReturnValues: "ALL_NEW",
        })
    );

    return { updatedQuests, updatedDaily: result.Attributes };
};

// ═══════════════════════════════════════════════════════
// GET /daily
// Trả về daily hiện tại (hoặc refresh nếu hết hạn)
// ═══════════════════════════════════════════════════════
const handleGetDaily = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        // Lấy profile để check streak
        const profileResult = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
            })
        );
        const profile = profileResult.Item;
        if (!profile) return await syncedErrorResponse(getUserId(event), 404, "Không tìm thấy profile");

        const { daily } = await getOrRefreshDaily(userId, profile);
        return successResponse({ daily });
    } catch (err) {
        console.error("Lỗi getDaily:", err);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// POST /daily/claim
// Body: { questKey: string }
// questKey là key trong daily.quests (vd: "focus_daily", "all_daily")
// ═══════════════════════════════════════════════════════
const handleClaimQuest = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { questKey } = body;
        if (!questKey) return await syncedErrorResponse(getUserId(event), 400, "questKey là bắt buộc");

        // Lấy daily
        const dailyResult = await docClient.send(
            new GetCommand({
                TableName: process.env.QUEST_TABLE,
                Key: { PK: userId, SK: "daily" },
            })
        );
        const daily = dailyResult.Item;
        if (!daily) return await syncedErrorResponse(getUserId(event), 404, "Không tìm thấy daily");

        const now = Math.floor(Date.now() / 1000);
        if (!daily.expiresAt || daily.expiresAt < now) {
            return await syncedErrorResponse(getUserId(event), 410, "Daily đã hết hạn, vui lòng refresh");
        }

        // Lấy thông tin quest
        const quest = daily.quests?.[questKey];
        if (!quest) return await syncedErrorResponse(getUserId(event), 404, "Không tìm thấy quest");
        if (!quest.isCompleted) return await syncedErrorResponse(getUserId(event), 400, "Quest chưa hoàn thành");
        if (quest.isClaimed) return await syncedErrorResponse(getUserId(event), 409, "Đã nhận thưởng rồi");

        const reward = quest.knowledgePoint || 0;
        const nowMs = Date.now();

        const profileResult = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
            })
        );
        const profile = profileResult.Item;

        const updatedQuests = {
            ...daily.quests,
            [questKey]: { ...quest, isClaimed: true },
        };

        await docClient.send(
            new TransactWriteCommand({
                TransactItems: [
                    {
                        Update: {
                            TableName: process.env.QUEST_TABLE,
                            Key: { PK: userId, SK: "daily" },
                            // Cập nhật toàn bộ quests map với isClaimed = true cho quest đó
                            // Kiểm tra điều kiện: quest phải chưa được claim
                            UpdateExpression: "SET quests = :q",
                            ConditionExpression: "attribute_exists(quests) AND expiresAt > :now",
                            ExpressionAttributeValues: {
                                ":q": updatedQuests,
                                ":now": Math.floor(Date.now() / 1000),
                            },
                        },
                    },
                    {
                        Update: {
                            TableName: process.env.USER_TABLE,
                            Key: { PK: userId },
                            UpdateExpression:
                                "SET budget.knowledgePoint = :kp, updatedAt = :nowMs",
                            ExpressionAttributeValues: {
                                ":kp": (profile.budget?.knowledgePoint || 0) + reward,
                                ":nowMs": nowMs,
                            },
                        },
                    },
                ],
            })
        );

        return successResponse({
            message: "Nhận thưởng thành công",
            questKey,
            rewardKnowledgePoint: reward,
            newKnowledgePoint: (profile.budget?.knowledgePoint || 0) + reward,
            updatedAt: nowMs,
        });
    } catch (err) {
        if (err.name === "TransactionCanceledException") {
            return await syncedErrorResponse(getUserId(event), 409, "Giao dịch bị từ chối: quest đã được nhận hoặc điều kiện thay đổi");
        }
        console.error("Lỗi claimQuest:", err);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// POST /study-planner/quiz-submit
// Body: { correctAnswersCount, totalQuestions }
// ═══════════════════════════════════════════════════════
const handleQuizSubmit = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { correctAnswersCount, totalQuestions } = body;

        if (typeof correctAnswersCount !== "number" || typeof totalQuestions !== "number") {
            return await syncedErrorResponse(getUserId(event), 400, "correctAnswersCount và totalQuestions phải là số");
        }

        const reward = correctAnswersCount * 10;
        
        // 1. Cập nhật Knowledge Point vào USER_TABLE
        let profileItem = null;
        if (reward > 0) {
            const profileUpdateResult = await docClient.send(new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
                UpdateExpression: "ADD budget.knowledgePoint :kp",
                ExpressionAttributeValues: { ":kp": reward },
                ReturnValues: "ALL_NEW"
            }));
            profileItem = profileUpdateResult.Attributes;
        }

        // 2. Cập nhật tiến độ Quest
        let questUpdate = null;
        let dailyItem = null;

        // Quest 1: Hoàn thành 1 bộ câu hỏi
        let questResult1 = await updateQuestProgress(userId, "COMPLETE_QUIZ", 1);
        
        // Quest 2: Trả lời đúng (nếu có câu đúng)
        let questResult2 = null;
        if (correctAnswersCount > 0) {
            questResult2 = await updateQuestProgress(userId, "CORRECT_QUIZ_ANSWER", correctAnswersCount);
        }

        // Lấy kết quả daily mới nhất từ lần update cuối cùng
        if (questResult2) {
            questUpdate = questResult2.updatedQuests;
            dailyItem = questResult2.updatedDaily;
        } else if (questResult1) {
            questUpdate = questResult1.updatedQuests;
            dailyItem = questResult1.updatedDaily;
        }

        return successResponse({
            message: "Đã ghi nhận kết quả bài kiểm tra",
            earnedKP: reward,
            questUpdate: questUpdate || null,
            profile: profileItem || null,
            daily: dailyItem || null,
        });

    } catch (err) {
        console.error("Lỗi handleQuizSubmit:", err);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};


export { updateQuestProgress, handleGetDaily, handleClaimQuest, handleQuizSubmit };
