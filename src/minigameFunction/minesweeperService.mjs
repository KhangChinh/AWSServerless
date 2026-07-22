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
import { generateMinesweeperBoard } from "./minesweeperGenerator.mjs";
import { encryptState, decryptState, runFloodFill } from "./cryptoHelper.mjs";
const JWT_SECRET = process.env.GAME_SECRET_KEY  // Dùng env trong thực tế

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};
const handleGetMinesweeperLevels = async (event) => {
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
                ":gid": "minesweeper",
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
            SK: `score#minesweeper#${lvl.SK}`,
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
            const levelId = item.SK.replace(`score#minesweeper#`, "");
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
const handleStartMinesweeperSession = async (event) => {
    const userId = getUserId(event);
    console.log(">>> [DEBUG] userId:", userId, "| Type:", typeof userId);

    if (!userId) return await syncedErrorResponse(userId, 401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { gameId, levelId } = body;

        console.log(">>> [DEBUG] gameId:", gameId, "| Type:", typeof gameId);
        console.log(">>> [DEBUG] levelId:", levelId, "| Type:", typeof levelId);

        if (!gameId || !levelId) return await syncedErrorResponse(userId, 400, "Missing gameId or levelId");

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

        if (!profile) return await syncedErrorResponse(userId, 404, "Profile not found");
        if (!level) return await syncedErrorResponse(userId, 404, "Level not found");

        // ==============================================================================
        // 2. Kiểm tra và trừ Sanity
        // ==============================================================================
        let budget = profile.budget || {};
        const sanityCost = level.sanityCost || 0;

        if (budget.sanity < sanityCost) {
            return await syncedErrorResponse(userId, 400, "Not enough sanity");
        }

        budget.sanity -= sanityCost;

        // ==============================================================================
        // 3. Tách logic tạo màn chơi dựa trên gameId
        // ==============================================================================
        let seed = "";
        let solutionGrid = "";
        let puzzleGrid = "";
        let gameStateToken = null; // Token mã hóa (dành riêng cho Minesweeper)
        const sessionId = `session#${gameId}`; // ID session
        if (gameId === 'minesweeper') {
            const boardData = generateMinesweeperBoard(level.baseMapConfig);
            seed = boardData.seed;
            solutionGrid = boardData.solutionGrid; // Đáp án hoàn chỉnh
            puzzleGrid = boardData.puzzleGrid;     // Toàn chữ H

            // Phân tích config để lấy kích thước bàn cờ lưu vào token
            const [rows, cols] = (level.baseMapConfig.gridSize || "9x9").split('x').map(Number);
            const totalMines = level.baseMapConfig.mineCount || 10;
            const initialRevealedMap = {};
            for (let i = 0; i < puzzleGrid.length; i++) {
                if (puzzleGrid[i] !== 'H') {
                    const r = Math.floor(i / cols);
                    const c = i % cols;
                    initialRevealedMap[`${r}-${c}`] = true;
                }
            }
            // MÃ HÓA TRẠNG THÁI GAME
            const stateObj = {
                sessionId: sessionId,
                solutionGrid: solutionGrid,
                rows: rows,
                cols: cols,
                totalMines: totalMines,
                revealedCellsMap: initialRevealedMap, // Lưu danh sách các ô đã được mở (hiện tại là trống)
                turnCount: 0       // Chống spam / replay attack
            };

            gameStateToken = encryptState(stateObj);
        }
        else {
            return await syncedErrorResponse(userId, 400, "Unsupported gameId");
        }

        // ==============================================================================
        // 4. Tạo Session Data
        // ==============================================================================
        const sessionItem = {
            PK: userId,
            SK: sessionId,
            levelId: levelId,
            startTime: now,
            sanityCost: sanityCost,
            status: "PENDING",
            checkCount: 5,
            seed: seed,
            // Chúng ta VẪN LƯU solutionGrid ở DB để dùng cho các nghiệp vụ kiểm tra chéo 
            // hoặc khi người dùng nộp bài cuối cùng (nếu cần). 
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

        const responsePayload = {
            success: true,
            profile: profile,
            sessionData: {
                sessionId: sessionItem.SK,
                seed: sessionItem.seed,
                checkCount: sessionItem.checkCount,
                puzzleGrid: puzzleGrid,
                status: sessionItem.status
            },
            baseMapConfig: level.baseMapConfig
        };

        // Nếu là Minesweeper, đính kèm thêm token mã hóa vào kết quả trả về
        if (gameStateToken) {
            responsePayload.sessionData.gameStateToken = gameStateToken;
        }

        return successResponse(responsePayload);

    } catch (error) {
        console.error(">>> [CATCH CUỐI CÙNG] Lỗi Start Game Session:", error);
        return await syncedErrorResponse(userId, 500, error.message || "Lỗi xử lý tạo màn chơi");
    }
};
const handleReveal = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(userId, 401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { row, col, gameStateToken } = body;

        if (row === undefined || col === undefined || !gameStateToken) {
            return await syncedErrorResponse(userId, 400, "Missing parameters");
        }

        // 1. Giải mã State ngay trong RAM (Không gọi DB)
        let state;
        try {
            state = decryptState(gameStateToken);
        } catch (e) {
            console.error(">>> [SECURITY] Invalid Token / Cheat attempt by user:", userId);
            return await syncedErrorResponse(userId, 400, "Invalid or expired game state");
        }

        const { solutionGrid, rows, cols, totalMines, revealedCellsMap, turnCount } = state;
        const clickIndex = row * cols + col;
        const cellValue = solutionGrid[clickIndex];

        // 2. Logic kiểm tra mìn
        if (cellValue === '*') {
            // Dẫm mìn -> Thua
            // Ở đây bạn có thể gọi DynamoDB update status = LOST (Tuỳ logic database của bạn)
            await docClient.send(new UpdateCommand({
                TableName: process.env.MINIGAME_TABLE,
                Key: { PK: userId, SK: "session#minesweeper" }, // sessionId lấy từ biến state
                UpdateExpression: "SET #st = :s",
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: { ":s": "LOST" }
            })).catch(e => console.error("Lỗi update DB khi dẫm mìn", e));
            return successResponse({
                result: 'lost',
                message: 'Bùm! Bạn đã dẫm phải mìn.',
                fullGrid: solutionGrid // Gửi lại toàn bộ đáp án để Client hiện bảng thua
            });
        }

        const currentRevealedMap = revealedCellsMap || {};
        const newlyRevealed = runFloodFill(solutionGrid, rows, cols, row, col, currentRevealedMap);

        // 4. Kiểm tra điều kiện Win
        const totalSafeCells = (rows * cols) - totalMines;
        const totalRevealedNow = Object.keys(currentRevealedMap).length;

        if (totalRevealedNow >= totalSafeCells) {
            // Thắng Game
            // Update DynamoDB status = WIN (Gọi updateCommand tương tự hàm handleSubmitMinesweeper)
            await docClient.send(new UpdateCommand({
                TableName: process.env.MINIGAME_TABLE,
                Key: { PK: userId, SK: "session#minesweeper" },
                UpdateExpression: "SET #st = :s",
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: { ":s": "WON" }
            })).catch(e => console.error("Lỗi update DB khi win", e));
            return successResponse({
                result: 'win',
                newlyRevealed: newlyRevealed,
                message: 'Chúc mừng bạn đã dò sạch mìn!'
            });
        }

        // 5. Nếu chưa win, mã hoá Token mới và trả về
        state.revealedCellsMap = currentRevealedMap;
        state.turnCount = turnCount + 1; // Chống spam/replay attack
        const newToken = encryptState(state);

        return successResponse({
            result: 'continue',
            newlyRevealed: newlyRevealed,
            gameStateToken: newToken
        });

    } catch (error) {
        console.error(">>> [ERROR] Reveal fail:", error);
        return await syncedErrorResponse(userId, 500, "Lỗi xử lý dò mìn");
    }
};
const handleEndMinesweeperSession = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(userId, 401, "Unauthorized");

    try {
        const body = JSON.parse(event.body);
        const { levelId, endState } = body;
        const now = Date.now();

        // 1. Lấy Session & Profile
        const [sessionRes, profileRes] = await Promise.all([
            docClient.send(new GetCommand({ TableName: process.env.MINIGAME_TABLE, Key: { PK: userId, SK: "session#minesweeper" } })),
            docClient.send(new GetCommand({ TableName: process.env.USER_TABLE, Key: { PK: userId } }))
        ]);

        const session = sessionRes.Item;
        const profile = profileRes.Item;
        // 1. Kiểm tra tồn tại và block cày tiền lặp (spam API)
        if (!session) return await syncedErrorResponse(userId, 400, "Phiên chơi không hợp lệ.");
        if (session.status === "COMPLETED" || session.status === "CANCELLED") {
            return await syncedErrorResponse(userId, 400, "Phần thưởng đã được nhận hoặc phiên đã hủy.");
        }
        let budget = profile.budget;

        // Xử lý thoát sớm
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
                    Key: { PK: userId, SK: "session#minesweeper" },
                    UpdateExpression: "SET #st = :s",
                    ExpressionAttributeNames: { "#st": "status" },
                    ExpressionAttributeValues: { ":s": "CANCELLED" }
                }))
            ]);
            return successResponse({ success: true, result: "lost", budget, refundSanity });
        }
        if (session.status === "PENDING") {
            return await syncedErrorResponse(userId, 403, "Bạn chưa hoàn thành ván chơi hợp lệ!");
        }
        // 2. KIỂM TRA "SỔ ĐEN" TRONG DB (Thay thế cho checkCheat)
        // Nếu nó hack undo, DB đã lưu status là LOST từ cái lúc nó đạp mìn đầu tiên rồi.
        if (session.status === "LOST") {
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
                    Key: { PK: userId, SK: "session#minesweeper" },
                    UpdateExpression: "SET #st = :s",
                    ExpressionAttributeNames: { "#st": "status" },
                    ExpressionAttributeValues: { ":s": "UNCOMPLETED" }
                }))
            ]);
            return successResponse({ success: true, result: "lost", budget, refundSanity });
        }
        // Lấy thông tin Level tính điểm
        const levelRes = await docClient.send(new GetCommand({
            TableName: process.env.MINIGAME_TABLE,
            Key: { PK: "minesweeper", SK: levelId }
        }));
        const level = levelRes.Item;
        const timeSpentSeconds = Math.floor((now - session.startTime) / 1000);

        // Công thức điểm của Minesweeper (Hoàn thành càng nhanh, điểm càng cao)
        let score = level.maxScoreCap * (1 - (timeSpentSeconds / 100)); // Ví dụ giảm điểm sau mỗi giây
        if (score < Math.floor(level.maxScoreCap * 0.2)) score = Math.floor(level.maxScoreCap * 0.2); // Sàn 20%

        let eCoinReward = level.eCoin || 0;
        budget.eCoin += eCoinReward;

        // Lấy Score cũ và Stats
        const [oldScoreRes, statsRes] = await Promise.all([
            docClient.send(new GetCommand({ TableName: process.env.MINIGAME_TABLE, Key: { PK: userId, SK: `score#minesweeper#${session.levelId}` } })),
            docClient.send(new GetCommand({ TableName: process.env.MINIGAME_TABLE, Key: { PK: userId, SK: "stats#minesweeper" } }))
        ]);

        const oldScore = oldScoreRes.Item;
        let stats = statsRes.Item || { PK: userId, SK: "stats#minesweeper", gameId: "minesweeper", totalScore: 0, levelsCompleted: 0 };

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
                Key: { PK: userId, SK: "session#minesweeper" },
                UpdateExpression: "SET #st = :s",
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: { ":s": "COMPLETED" }
            })),
            // 2. Lưu Score màn chơi
            docClient.send(new PutCommand({
                TableName: process.env.MINIGAME_TABLE,
                Item: { PK: userId, SK: `score#minesweeper#${session.levelId}`, personalBest: scoreToSave, achievedAt: Math.floor(now / 1000) }
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
            ExpressionAttributeValues: { ":gid": "minesweeper" },
            Limit: 10,
        };
        const levelsResult = await docClient.send(new QueryCommand(levelParams));
        const fetchedLevels = levelsResult.Items || [];

        let finalLevels = [];
        if (fetchedLevels.length > 0) {
            const scoreKeys = fetchedLevels.map((lvl) => ({
                PK: userId,
                SK: `score#minesweeper#${lvl.SK}`,
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
                const lvlId = item.SK.replace(`score#minesweeper#`, "");
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
        console.error("Lỗi nộp bài Minesweeper:", error);
        return await syncedErrorResponse(userId, 500, "Lỗi máy chủ.");
    }
};
export {
    handleGetMinesweeperLevels,
    handleStartMinesweeperSession,
    handleReveal,
    handleEndMinesweeperSession,
}