import { GetCommand, PutCommand, UpdateCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";

const TABLE_NAME = process.env.TABLE_NAME;

// ═══════════════════════════════════════════
// HÀM HELPER: Lấy chuỗi ngày nhiệm vụ (Reset lúc 3h sáng giờ VN)
// ═══════════════════════════════════════════
const getQuestDateString = () => {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    // Logic Reset lúc 3h sáng: 
    // Trừ đi 3 tiếng. Nếu lúc này là 02:59 sáng, nó sẽ lùi về 23:59 của ngày HÔM QUA.
    // Nếu lúc này là 03:00 sáng, nó sẽ là 00:00 của ngày HÔM NAY.
    vnTime.setUTCHours(vnTime.getUTCHours() - 3);
    return vnTime.toISOString().split('T')[0];
};
// ═══════════════════════════════════════════
// HÀM 1: Lấy hoặc Khởi tạo nhiệm vụ ngày
// ═══════════════════════════════════════════
const handleGetDailyQuest = async (userId) => {
    const todayStr = getQuestDateString();
    // 1. Kiểm tra quest hiện tại của user nếu còn trong ngày thì trả danh sách về
    const getResult = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: userId, SK: "daily" }
    }));
    if (getResult.Item && getResult.Item.date === todayStr) {
        return getResult.Item.quests;
    }
    // 2. Nếu là ngày mới (hoặc chưa từng có), lấy dữ liệu từ bảng Master Quest
    const masterQuestsResult = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
            ":pk": "quest"
        }
    }));
    const allMasterQuests = masterQuestsResult.Items || [];
    let fixedFocus = null;
    let fixedAllDaily = null;
    const pool = [];
    // Phân loại quest
    for (const q of allMasterQuests) {
        if (q.SK === "focus_30") fixedFocus = q;
        else if (q.SK === "all_daily") fixedAllDaily = q;
        else pool.push(q);
    }
    // Trộn ngẫu nhiên (Shuffle) và lấy 3 nhiệm vụ
    const shuffledPool = pool.sort(() => 0.5 - Math.random());
    const selectedRandom = shuffledPool.slice(0, 3);
    const dailySelection = [];
    if (fixedFocus) dailySelection.push(fixedFocus);
    dailySelection.push(...selectedRandom);
    if (fixedAllDaily) dailySelection.push(fixedAllDaily);
    // 3. Format lại thành Object lưu cho User
    const questsObj = {};
    dailySelection.forEach(q => {
        questsObj[q.SK] = {
            type: q.type,
            name: q.name,
            description: q.description,
            target: q.target,
            knowledgePoint: q.knowledgePoint,
            progress: 0,
            isCompleted: false,
            isClaimed: false
        };
    });
    const newDailyRecord = {
        PK: userId,
        SK: "daily",
        date: todayStr,
        quests: questsObj
    };
    // 4. Ghi đè (Put) xuống database
    await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: newDailyRecord
    }));
    return questsObj;
};
// ═══════════════════════════════════════════
// HÀM 2: Cập nhật tiến độ nhiệm vụ (Dùng khi hoàn thành game/session)
// ═══════════════════════════════════════════
const updateQuestProgress = async (userId, actionType, amount) => {
    try {
        const quests = await getDailyQuest(userId);
        let isModified = false;
        let newlyCompletedCount = 0;
        for (const [key, quest] of Object.entries(quests)) {
            if (quest.type === actionType && !quest.isCompleted) {
                quest.progress += amount;
                if (quest.progress >= quest.target) {
                    quest.progress = quest.target;
                    quest.isCompleted = true;
                    newlyCompletedCount += 1;
                }
                isModified = true;
            }
        }
        // Cập nhật daily quest
        if (newlyCompletedCount > 0 && actionType !== "COMPLETE_DAILY") {
            const metaQuestKey = "all_daily";
            if (quests[metaQuestKey] && !quests[metaQuestKey].isCompleted) {
                quests[metaQuestKey].progress += newlyCompletedCount;
                if (quests[metaQuestKey].progress >= quests[metaQuestKey].target) {
                    quests[metaQuestKey].progress = quests[metaQuestKey].target;
                    quests[metaQuestKey].isCompleted = true;
                }
                isModified = true;
            }
        }
        if (isModified) {
            await docClient.send(new UpdateCommand({
                TableName: TABLE_NAME,
                Key: {
                    PK: userId,
                    SK: "daily"
                },
                UpdateExpression: "SET quests = :quests",
                ExpressionAttributeValues: {
                    ":quests": quests
                }
            }));
        }
        return quests;
    } catch (error) {
        console.error("Lỗi cập nhật tiến độ nhiệm vụ:", error);
    }
};
// ═══════════════════════════════════════════
// HÀM 3: Nhận thưởng (Claim Reward) 
// ═══════════════════════════════════════════
const handleClaimQuestReward = async (userId, questId) => {
    try {
        const quests = await getDailyQuest(userId);
        const quest = quests[questId];
        if (!quest) throw new Error("Nhiệm vụ không tồn tại");
        if (!quest.isCompleted) throw new Error("Nhiệm vụ chưa hoàn thành");
        if (quest.isClaimed) throw new Error("Nhiệm vụ đã được nhận thưởng");
        const rewardPoints = quest.knowledgePoint;
        // Đổi trạng thái quest thành isClaimed VÀ cộng tiền vào Profile thành công cùng lúc
        await docClient.send(new TransactWriteCommand({
            TransactItems: [
                {
                    Update: {
                        TableName: TABLE_NAME,
                        Key: { PK: userId, SK: "daily" },
                        UpdateExpression: "SET quests.#qId.isClaimed = :true",
                        ExpressionAttributeNames: { "#qId": questId },
                        ExpressionAttributeValues: { ":true": true }
                    }
                },
                {
                    Update: {
                        TableName: TABLE_NAME,
                        Key: { PK: userId, SK: "profile" },
                        UpdateExpression: "ADD budget.knowledgePoint :points",
                        ExpressionAttributeValues: { ":points": rewardPoints }
                    }
                }
            ]
        }));
        return { success: true, rewardPoints };
    } catch (error) {
        console.error("Lỗi nhận thưởng nhiệm vụ:", error);
        throw error;
    }
};

export {
    getDailyQuest,
    updateQuestProgress,
    claimQuestReward
}