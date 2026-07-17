import {
    GetCommand,
    PutCommand,
    QueryCommand,
    UpdateCommand,
    TransactWriteCommand,
    BatchGetCommand,
    ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";
import { docClient } from "../database.mjs";
import { successResponse } from "../response.mjs";
import { syncedErrorResponse } from "../errorSync.mjs";
import { updateQuestProgress } from "../questFunction/questService.mjs";
import { generateSudokuBoard } from "./sudokuGenerator.mjs";
const JWT_SECRET = process.env.GAME_SECRET_KEY || "fallback_secret"; // Dùng env trong thực tế

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

// ═══════════════════════════════════════════════════════
// HELPER: Tính điểm dựa vào maxScoreCap và thời gian chơi
// (Cả client và server dùng cùng thuật toán)
// ═══════════════════════════════════════════════════════
function calculateScore(maxScoreCap, durationSeconds, elapsedSeconds) {
    if (elapsedSeconds <= 0) return 0;
    // Điểm giảm dần theo thời gian: score = maxCap * (1 - elapsed/duration) ^ 0.5
    const ratio = Math.max(0, 1 - elapsedSeconds / (durationSeconds * 2));
    return Math.max(0, Math.floor(maxScoreCap * Math.sqrt(ratio)));
}

// ═══════════════════════════════════════════════════════
// GET /minigame/levels?gameId=sudoku&lastKey=...
// Lấy danh sách màn chơi kèm score cao nhất của user
// ═══════════════════════════════════════════════════════
const handleGetSudokuLevels = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {

        let exclusiveStartKey = null;
        const lastKeyStr = event.queryStringParameters?.lastKey;
        if (lastKeyStr) {
            exclusiveStartKey = JSON.parse(decodeURIComponent(lastKeyStr));
        }

        // 1. Chỉ đơn giản là query lấy toàn bộ màn chơi theo gameId
        const levelParams = {
            TableName: process.env.MINIGAME_TABLE,
            KeyConditionExpression: "PK = :gid",
            ExpressionAttributeValues: {
                ":gid": "sudoku",
            },
            Limit: 10,
        };
        if (exclusiveStartKey) levelParams.ExclusiveStartKey = exclusiveStartKey;

        const levelsResult = await docClient.send(new QueryCommand(levelParams));
        const levels = levelsResult.Items || [];

        if (levels.length === 0) {
            return successResponse({ levels: [], lastEvaluatedKey: null });
        }

        // 2. Tạo danh sách Key để quét điểm của user
        const scoreKeys = levels.map((lvl) => ({
            PK: userId,
            SK: `score#sudoku#${lvl.SK}`,
        }));

        const batchResult = await docClient.send(
            new BatchGetCommand({
                RequestItems: {
                    [process.env.MINIGAME_TABLE]: {
                        Keys: scoreKeys,
                    },
                },
            })
        );

        // 3. Gom dữ liệu điểm của user lại
        let scoreMap = {};
        const userScores = batchResult.Responses?.[process.env.MINIGAME_TABLE] || [];
        for (const item of userScores) {
            const levelId = item.SK.replace(`score#sudoku#`, "");
            scoreMap[levelId] = {
                personalBest: item.personalBest,
                achievedAt: item.achievedAt,
            };
        }

        // 4. Gộp vào danh sách level (Có chơi thì nhét điểm vào, chưa thì null)
        const finalLevels = levels.map((lvl) => ({
            ...lvl, // Giữ nguyên toàn bộ data gốc của level
            score: scoreMap[lvl.SK] || null,
        }));

        return successResponse({
            levels: finalLevels,
            lastEvaluatedKey: levelsResult.LastEvaluatedKey || null,
        });

    } catch (err) {
        console.error("Lỗi getLevels:", err);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// POST /minigame/sudokulevels/start-game
// Body: { gameId: string, levelId: string }
// ═══════════════════════════════════════════════════════
const handleStartSession = async (event) => {
    const userId = getUserId(event);
    console.log(">>> [DEBUG] userId:", userId, "| Type:", typeof userId);

    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { gameId, levelId } = body;

        console.log(">>> [DEBUG] gameId:", gameId, "| Type:", typeof gameId);
        console.log(">>> [DEBUG] levelId:", levelId, "| Type:", typeof levelId);

        if (!gameId || !levelId) return await syncedErrorResponse(getUserId(event), 400, "Missing gameId or levelId");

        const now = Date.now();

        // ==============================================================================
        // 1. Fetch Profile và Level Info
        // ==============================================================================
        console.log(">>> [DEBUG] Bắt đầu gọi Promise.all số 1 (Fetch Profile & Level)...");

        const fetchProfilePromise = docClient.send(new GetCommand({
            TableName: process.env.USER_TABLE,
            Key: { PK: userId }
        })).catch(err => {
            console.error(">>> [ERROR BẮT ĐƯỢC] Lỗi tại Fetch Profile (USER_TABLE). Key gửi đi:", JSON.stringify({ PK: userId }));
            throw err;
        });

        const fetchLevelPromise = docClient.send(new GetCommand({
            TableName: process.env.MINIGAME_TABLE,
            Key: { PK: gameId, SK: levelId }
        })).catch(err => {
            console.error(">>> [ERROR BẮT ĐƯỢC] Lỗi tại Fetch Level (MINIGAME_TABLE). Key gửi đi:", JSON.stringify({ PK: gameId, SK: levelId }));
            throw err;
        });

        const [profileRes, levelRes] = await Promise.all([fetchProfilePromise, fetchLevelPromise]);
        console.log(">>> [DEBUG] Fetch thành công! Có Profile:", !!profileRes.Item, "| Có Level:", !!levelRes.Item);

        const profile = profileRes.Item;
        const level = levelRes.Item;

        if (!profile) return await syncedErrorResponse(getUserId(event), 404, "Profile not found");
        if (!level) return await syncedErrorResponse(getUserId(event), 404, "Level not found");

        // ==============================================================================
        // 2. Kiểm tra và trừ Sanity
        // ==============================================================================
        let budget = profile.budget || {};
        const sanityCost = level.sanityCost || 0;

        if (budget.sanity < sanityCost) {
            return await syncedErrorResponse(getUserId(event), 400, "Not enough sanity");
        }

        budget.sanity -= sanityCost;

        // ==============================================================================
        // 3. Tách logic tạo màn chơi dựa trên gameId
        // ==============================================================================
        let seed = "";
        let solutionGrid = "";
        let puzzleGrid = ""; // 👈 BỔ SUNG KHAI BÁO BIẾN

        if (gameId === 'sudoku') {
            const boardData = generateSudokuBoard(level.baseMapConfig);
            seed = boardData.seed;
            solutionGrid = boardData.solutionGrid;
            puzzleGrid = boardData.puzzleGrid; // 👈 LẤY ĐỀ BÀI TỪ GENERATOR
        } else {
            return await syncedErrorResponse(getUserId(event), 400, "Unsupported gameId");
        }

        // ==============================================================================
        // 4. Tạo Session Data
        // ==============================================================================
        const sessionItem = {
            PK: userId,
            SK: `session#${gameId}`,
            levelId: levelId,
            startTime: now,
            sanityCost: sanityCost,
            status: "PENDING",
            checkCount: 5,
            seed: seed,
            solutionGrid: solutionGrid,

        };

        // ==============================================================================
        // 5. Lưu Session và Cập nhật Profile song song
        // ==============================================================================
        console.log(">>> [DEBUG] Bắt đầu gọi Promise.all số 2 (Save Session & Update Profile)...");

        const putSessionPromise = docClient.send(new PutCommand({
            TableName: process.env.MINIGAME_TABLE,
            Item: sessionItem
        })).catch(err => {
            console.error(">>> [ERROR BẮT ĐƯỢC] Lỗi tại Put Session (MINIGAME_TABLE). Item gửi đi:", JSON.stringify(sessionItem));
            throw err;
        });

        const updateProfilePromise = docClient.send(new UpdateCommand({
            TableName: process.env.USER_TABLE,
            Key: { PK: userId },
            UpdateExpression: "SET budget = :b, updatedAt = :u",
            ExpressionAttributeValues: { ":b": budget, ":u": now }
        })).catch(err => {
            console.error(">>> [ERROR BẮT ĐƯỢC] Lỗi tại Update Profile (USER_TABLE). Key gửi đi:", JSON.stringify({ PK: userId }));
            throw err;
        });

        await Promise.all([putSessionPromise, updateProfilePromise]);
        console.log(">>> [DEBUG] Lưu Session & Cập nhật Profile thành công!");

        // ==============================================================================
        // 6. Trả kết quả về cho client
        // ==============================================================================
        profile.budget = budget;

        return successResponse({
            success: true,
            profile: profile,
            sessionData: {
                sessionId: sessionItem.SK,
                seed: sessionItem.seed,
                checkCount: sessionItem.checkCount,
                puzzleGrid: puzzleGrid, // 👈 GỬI ĐỀ BÀI XUỐNG CHO CLIENT RENDER 
                status: sessionItem.status
            },
            baseMapConfig: level.baseMapConfig
        });

    } catch (error) {
        console.error(">>> [CATCH CUỐI CÙNG] Lỗi Start Game Session:", error);
        return await syncedErrorResponse(getUserId(event), 500, error.message || "Lỗi xử lý tạo màn chơi");
    }
};
// ═══════════════════════════════════════════════════════
// HÀM KIỂM TRA GIAN LẬN & ĐÁNH GIÁ BÀN CỜ
// ═══════════════════════════════════════════════════════
const checkSudokuCheat = (session, clientLogs, currentGridStr) => {
    const now = Date.now();
    const timeSpentMs = now - session.startTime;

    // 1. Kiểm tra thời gian chơi (VD: Hoàn thành Sudoku dưới 5s là không thể)
    if (timeSpentMs < 5000 && currentGridStr.indexOf('0') === -1) {
        return { isCheat: true, reason: "Thời gian hoàn thành bất thường." };
    }

    // 2. Kiểm tra log nước đi cải tiến
    if (clientLogs && clientLogs.length > 1) {
        clientLogs.sort((a, b) => a.timestamp - b.timestamp);
        let rapidBurstCount = 0;

        for (let i = 1; i < clientLogs.length; i++) {
            const timeDiff = clientLogs[i].timestamp - clientLogs[i - 1].timestamp;

            // A. Kiểm tra thời gian đi lùi (Chống hack đổi giờ hệ thống trên Client)
            if (timeDiff < 0) {
                return { isCheat: true, reason: "Phát hiện can thiệp thời gian hệ thống (Time travel)." };
            }

            // B. Ngưỡng vật lý tuyệt đối (Chống script đẩy log trực tiếp)
            // Con người hầu như không thể tạo ra 2 event khác nhau dưới 10ms qua UI web
            if (timeDiff < 10) {
                return { isCheat: true, reason: "Phát hiện thao tác máy móc (Dưới 10ms)." };
            }

            // C. Giới hạn chuỗi thao tác nhanh (Burst Limit)
            // 50ms là rất nhanh đối với thao tác tay. Ta cho phép họ gõ nhanh 2-3 lần (burst).
            if (timeDiff < 50) {
                rapidBurstCount++;
                // Nếu thao tác < 50ms lặp lại liên tục quá 4 lần -> Nghi ngờ dùng tool điền tự động hoặc copy-paste
                if (rapidBurstCount >= 4) {
                    return { isCheat: true, reason: "Chuỗi thao tác nhanh bất thường (Auto-bot script)." };
                }
            } else {
                // Nếu có khoảng nghỉ bình thường (>= 50ms), reset lại bộ đếm burst
                rapidBurstCount = 0;
            }
        }

        // D. Kiểm tra tốc độ trung bình (Average Speed Limit)
        // Tổng số thao tác chia cho tổng thời gian thao tác (tính bằng giây)
        const totalLogTimeMs = clientLogs[clientLogs.length - 1].timestamp - clientLogs[0].timestamp;

        // Chỉ xét trung bình nếu log có từ 10 thao tác trở lên để có dữ liệu đáng tin cậy
        if (clientLogs.length >= 10 && totalLogTimeMs > 0) {
            const avgMovesPerSecond = clientLogs.length / (totalLogTimeMs / 1000);
            // Nếu người chơi đạt trên 15 thao tác / giây -> Bot
            if (avgMovesPerSecond > 15) {
                return { isCheat: true, reason: "Tốc độ điền trung bình vượt quá giới hạn vật lý của con người." };
            }
        }
    }

    // Đề xuất thêm: Kiểm tra grid hiện tại có sửa đề bài không (Nếu session có lưu puzzleGrid)
    /* if (session.puzzleGrid) {
        for(let i=0; i<81; i++) {
            if(session.puzzleGrid[i] !== '0' && currentGridStr[i] !== session.puzzleGrid[i]) {
                return { isCheat: true, reason: "Sửa đổi ô khóa của đề bài." };
            }
        }
    } 
    */

    // 3. Kiểm tra tính chính xác của lưới hiện tại so với solutionGrid
    let isBoardCorrect = true;
    for (let i = 0; i < currentGridStr.length; i++) {
        if (currentGridStr[i] !== '0' && currentGridStr[i] !== session.solutionGrid[i]) {
            isBoardCorrect = false;
            break;
        }
    }

    return { isCheat: false, isBoardCorrect };
};
// ═══════════════════════════════════════════════════════
// POST /minigame/sudokulevels/check
// ═══════════════════════════════════════════════════════
const handleCheckSudokuBoard = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { currentGrid, actionLogs } = body;

        // 1. Lấy Session
        const sessionRes = await docClient.send(new GetCommand({
            TableName: process.env.MINIGAME_TABLE,
            Key: { PK: userId, SK: "session#sudoku" }
        }));
        const session = sessionRes.Item;

        if (!session || session.status !== "PENDING") {
            return await syncedErrorResponse(getUserId(event), 400, "Không tìm thấy phiên chơi hợp lệ.");
        }
        if (session.checkCount <= 0) {
            return await syncedErrorResponse(getUserId(event), 400, "Đã hết lượt kiểm tra.");
        }

        // 2. Chạy hàm kiểm tra cheat & đúng sai
        const cheatResult = checkSudokuCheat(session, actionLogs, currentGrid);
        if (cheatResult.isCheat) {
            return await syncedErrorResponse(getUserId(event), 403, `Phát hiện gian lận: ${cheatResult.reason}`);
        }

        // 3. Trừ checkCount
        const newCheckCount = session.checkCount - 1;
        await docClient.send(new UpdateCommand({
            TableName: process.env.MINIGAME_TABLE,
            Key: { PK: userId, SK: "session#sudoku" },
            UpdateExpression: "SET checkCount = :c",
            ExpressionAttributeValues: { ":c": newCheckCount }
        }));

        return successResponse({
            success: true,
            checkCount: newCheckCount,
            isBoardCorrect: cheatResult.isBoardCorrect
        });

    } catch (error) {
        console.error("Lỗi kiểm tra bàn cờ:", error);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ.");
    }
};

// ═══════════════════════════════════════════════════════
// POST /minigame/sudokulevels/end-session
// ═══════════════════════════════════════════════════════
const handleEndSudokuSession = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { finalGrid, actionLogs, endState } = body;
        const now = Date.now();

        // 1. Lấy Session & Profile
        const [sessionRes, profileRes] = await Promise.all([
            docClient.send(new GetCommand({ TableName: process.env.MINIGAME_TABLE, Key: { PK: userId, SK: "session#sudoku" } })),
            docClient.send(new GetCommand({ TableName: process.env.USER_TABLE, Key: { PK: userId } }))
        ]);

        const session = sessionRes.Item;
        const profile = profileRes.Item;

        if (!session || session.status !== "PENDING")
            return await syncedErrorResponse(getUserId(event), 400, "Phiên chơi không hợp lệ.");

        let budget = profile.budget;

        // --- TRƯỜNG HỢP THUA HOẶC THOÁT RA ---
        if (endState === "quit") {
            const refundSanity = Math.floor(session.sanityCost * 0.5);
            budget.sanity += refundSanity;

            await Promise.all([
                docClient.send(new UpdateCommand({
                    TableName: process.env.USER_TABLE,
                    Key: { PK: userId },
                    UpdateExpression: "SET budget = :b",
                    ExpressionAttributeValues: { ":b": budget }
                })),
                docClient.send(new UpdateCommand({
                    TableName: process.env.MINIGAME_TABLE,
                    Key: { PK: userId, SK: "session#sudoku" },
                    UpdateExpression: "SET #st = :s",
                    ExpressionAttributeNames: { "#st": "status" },
                    ExpressionAttributeValues: { ":s": "CANCELLED" }
                }))
            ]);

            return successResponse({ success: true, result: "lost", budget, refundSanity });
        }

        // --- TRƯỜNG HỢP NỘP BÀI (WIN) ---
        // Kiểm tra cheat & full board
        const cheatResult = checkSudokuCheat(session, actionLogs, finalGrid);
        if (cheatResult.isCheat) return await syncedErrorResponse(getUserId(event), 403, `Phát hiện gian lận: ${cheatResult.reason}`);
        if (!cheatResult.isBoardCorrect || finalGrid.indexOf('0') !== -1) {
            const refundSanity = Math.floor(session.sanityCost * 0.5);
            budget.sanity += refundSanity;
            await Promise.all([
                docClient.send(new UpdateCommand({
                    TableName: process.env.USER_TABLE,
                    Key: { PK: userId },
                    UpdateExpression: "SET budget = :b",
                    ExpressionAttributeValues: { ":b": budget }
                })),
                docClient.send(new UpdateCommand({
                    TableName: process.env.MINIGAME_TABLE,
                    Key: { PK: userId, SK: "session#sudoku" },
                    UpdateExpression: "SET #st = :s",
                    ExpressionAttributeNames: { "#st": "status" },
                    ExpressionAttributeValues: { ":s": "UNCOMPLETED" }
                }))
            ]);
            return successResponse({ success: true, result: "lost", budget, refundSanity });
        }

        // Lấy thông tin Level để tính điểm
        const levelRes = await docClient.send(new GetCommand({
            TableName: process.env.MINIGAME_TABLE,
            Key: { PK: "sudoku", SK: session.levelId }
        }));
        const level = levelRes.Item;
        const emptyCellsCount = level.baseMapConfig.emptyCellsCount;
        const timeSpentSeconds = Math.floor((now - session.startTime) / 1000);

        // Công thức tính điểm
        let score = level.maxScoreCap * (1 - Math.floor((timeSpentSeconds - emptyCellsCount * 5) / 10) * 0.01);
        if (score < Math.floor(level.maxScoreCap * 0.1)) score = Math.floor(level.maxScoreCap * 0.1); // Điểm sàn 10%

        let eCoinReward = level.eCoin || 0;

        // Thưởng/Phạt theo checkCount
        const maxCheckCount = 5;
        if (session.checkCount === maxCheckCount) {
            score = Math.floor(score * 1.5);
            eCoinReward = Math.floor(eCoinReward * 1.5);
        } else {
            const lostChecks = maxCheckCount - session.checkCount;
            score = Math.floor(score * Math.pow(0.95, lostChecks)); // Giảm 5% mỗi lượt mất
        }

        budget.eCoin += eCoinReward;

        // Lấy Score cũ và Stats
        const [oldScoreRes, statsRes] = await Promise.all([
            docClient.send(new GetCommand({ TableName: process.env.MINIGAME_TABLE, Key: { PK: userId, SK: `score#sudoku#${session.levelId}` } })),
            docClient.send(new GetCommand({ TableName: process.env.MINIGAME_TABLE, Key: { PK: userId, SK: "stats#sudoku" } }))
        ]);

        const oldScore = oldScoreRes.Item;
        let stats = statsRes.Item || { PK: userId, SK: "stats#sudoku", gameId: "sudoku", totalScore: 0, levelsCompleted: 0 };

        let isPB = false;
        let scoreToSave = score;

        if (!oldScore) {
            isPB = true;
            stats.levelsCompleted += 1;
            stats.totalScore += score;
        } else {
            if (score > oldScore.personalBest) {
                isPB = true;
                stats.totalScore += (score - oldScore.personalBest); // Cộng thêm phần chênh lệch
            } else {
                scoreToSave = oldScore.personalBest; // Giữ nguyên điểm cũ nếu không qua PB
            }
        }

        // Cập nhật Database (Dùng mảng Promise.all để song song)
        await Promise.all([
            // 1. Đổi status session
            docClient.send(new UpdateCommand({
                TableName: process.env.MINIGAME_TABLE,
                Key: { PK: userId, SK: "session#sudoku" },
                UpdateExpression: "SET #st = :s",
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: { ":s": "COMPLETED" }
            })),
            // 2. Lưu Score màn chơi
            docClient.send(new PutCommand({
                TableName: process.env.MINIGAME_TABLE,
                Item: { PK: userId, SK: `score#sudoku#${session.levelId}`, personalBest: scoreToSave, achievedAt: Math.floor(now / 1000) }
            })),
            // 3. Lưu Stats tổng
            docClient.send(new PutCommand({
                TableName: process.env.MINIGAME_TABLE,
                Item: { ...stats, lastUpdatedAt: Math.floor(now / 1000), displayInfo: { name: profile.information.name, avatarUrl: profile.information.avatarUrl, equippedFrame: profile.equippedCosmetics.equippedFrame } }
            })),
            // 4. Update Profile Budget
            docClient.send(new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
                UpdateExpression: "SET budget = :b",
                ExpressionAttributeValues: { ":b": budget }
            }))
        ]);

        profile.budget = budget; // Cập nhật budget trả về frontend
        const levelParams = {
            TableName: process.env.MINIGAME_TABLE,
            KeyConditionExpression: "PK = :gid",
            ExpressionAttributeValues: { ":gid": "sudoku" },
            Limit: 10,
        };
        const levelsResult = await docClient.send(new QueryCommand(levelParams));
        const fetchedLevels = levelsResult.Items || [];

        let finalLevels = [];
        if (fetchedLevels.length > 0) {
            const scoreKeys = fetchedLevels.map((lvl) => ({
                PK: userId,
                SK: `score#sudoku#${lvl.SK}`,
            }));

            const batchResult = await docClient.send(
                new BatchGetCommand({
                    RequestItems: {
                        [process.env.MINIGAME_TABLE]: { Keys: scoreKeys },
                    },
                })
            );

            let scoreMap = {};
            const userScores = batchResult.Responses?.[process.env.MINIGAME_TABLE] || [];
            for (const item of userScores) {
                const lvlId = item.SK.replace(`score#sudoku#`, "");
                scoreMap[lvlId] = {
                    personalBest: item.personalBest,
                    achievedAt: item.achievedAt,
                };
            }

            finalLevels = fetchedLevels.map((lvl) => ({
                ...lvl,
                score: scoreMap[lvl.SK] || null,
            }));
        }
        return successResponse({
            success: true,
            result: "win",
            score: score,
            eCoinReward: eCoinReward,
            isPB: isPB,
            profile: profile,
            stat: stats,
            timeSpent: timeSpentSeconds,
            levels: finalLevels,
            lastEvaluatedKey: levelsResult.LastEvaluatedKey || null
        });

    } catch (error) {
        console.error("Lỗi nộp bài:", error);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ.");
    }
};

// ═══════════════════════════════════════════════════════
// WORKER: TỰ ĐỘNG TẠO / GHI ĐÈ BẢNG XẾP HẠNG (Chạy mỗi 10p)
// ═══════════════════════════════════════════════════════
const handleLeaderboardWorker = async (event) => {
    try {
        console.log("Bắt đầu chạy Worker cập nhật Leaderboard Sudoku...");

        // 1. Quét toàn bộ Stats (Có thể dùng Query nếu setup GSI, hiện dùng Scan)
        const scanParams = {
            TableName: process.env.MINIGAME_TABLE,
            FilterExpression: "SK = :sk",
            ExpressionAttributeValues: {
                ":sk": "stats#sudoku"
            }
        };

        const result = await docClient.send(new ScanCommand(scanParams));
        const allStats = result.Items || [];

        // 2. Sắp xếp lấy Top 10
        const top10Players = allStats
            .sort((a, b) => b.totalScore - a.totalScore)
            .slice(0, 10)
            .map(stat => ({
                userId: stat.PK,
                totalScore: stat.totalScore,
                levelsCompleted: stat.levelsCompleted,
                displayInfo: stat.displayInfo || { name: "Unknown", avatarUrl: "", equippedFrame: null }
            }));

        // 3. Tính toán expiresAt: thời điểm hiện tại + 11 phút (tính bằng giây)
        const expiresAt = Math.floor(Date.now() / 1000) + (11 * 60);

        // 4. Object lưu đè vào DynamoDB
        const leaderboardData = {
            PK: "leaderboard",
            SK: "sudoku",
            topPlayers: top10Players,
            expiresAt: expiresAt // Dùng expiresAt thay cho updatedAt
        };

        // 5. Lưu xuống DynamoDB
        await docClient.send(new PutCommand({
            TableName: process.env.MINIGAME_TABLE,
            Item: leaderboardData
        }));

        console.log("Cập nhật Leaderboard Sudoku thành công! expiresAt:", expiresAt);
        return { statusCode: 200, body: "Success" };
    } catch (err) {
        console.error("Lỗi khi chạy Leaderboard Worker:", err);
        throw err;
    }
};

// ═══════════════════════════════════════════════════════
// GET /minigame/leaderboard?gameId=sudoku
// ═══════════════════════════════════════════════════════
const handleGetLeaderboard = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        const gameId = event.queryStringParameters?.gameId;

        const result = await docClient.send(new GetCommand({
            TableName: process.env.MINIGAME_TABLE,
            Key: { PK: "leaderboard", SK: gameId }
        }));

        if (!result.Item) {
            return successResponse({ topPlayers: [], updatedAt: null });
        }

        return successResponse(result.Item);
    } catch (err) {
        console.error("Lỗi khi lấy Leaderboard:", err);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

export {
    handleGetSudokuLevels,
    handleStartSession,
    handleCheckSudokuBoard,
    handleEndSudokuSession,
    handleLeaderboardWorker,
    handleGetLeaderboard
};
