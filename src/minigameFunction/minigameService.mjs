import {
    GetCommand,
    PutCommand,
    QueryCommand,
    UpdateCommand,
    TransactWriteCommand,
    BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";
import { updateQuestProgress } from "../questFunction/questService.mjs";

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
const handleGetLevels = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const gameId = event.queryStringParameters?.gameId;
        if (!gameId) return errorResponse(400, "gameId là bắt buộc");

        let exclusiveStartKey = null;
        const lastKeyStr = event.queryStringParameters?.lastKey;
        if (lastKeyStr) {
            exclusiveStartKey = JSON.parse(decodeURIComponent(lastKeyStr));
        }

        // Lấy danh sách màn (MINIGAME_TABLE, PK=gameId)
        // FilterExpression loại trừ các bản ghi không phải level (session, stats, globalLeaderboard)
        const levelParams = {
            TableName: process.env.MINIGAME_TABLE,
            KeyConditionExpression: "PK = :gid",
            FilterExpression: "attribute_exists(sanityCost)",
            ExpressionAttributeValues: {
                ":gid": gameId,
            },
            ProjectionExpression:
                "PK, SK, #n, sanityCost, requiredLevel, maxScoreCap, eCoin",
            ExpressionAttributeNames: { "#n": "name" },
            Limit: 20,
        };
        if (exclusiveStartKey) levelParams.ExclusiveStartKey = exclusiveStartKey;

        const levelsResult = await docClient.send(new QueryCommand(levelParams));
        const levels = levelsResult.Items || [];

        // BatchGetItem để lấy score của user
        const scoreKeys = levels.map((lvl) => ({
            PK: userId,
            SK: `score#${gameId}#${lvl.SK}`,
        }));

        let scoreMap = {};
        if (scoreKeys.length > 0) {
            const batchResult = await docClient.send(
                new BatchGetCommand({
                    RequestItems: {
                        [process.env.MINIGAME_TABLE]: {
                            Keys: scoreKeys,
                        },
                    },
                })
            );
            for (const item of batchResult.Responses?.[process.env.MINIGAME_TABLE] || []) {
                const levelId = item.SK.replace(`score#${gameId}#`, "");
                scoreMap[levelId] = {
                    personalBest: item.personalBest,
                    achievedAt: item.achievedAt,
                };
            }
        }

        // Merge
        const enrichedLevels = levels.map((lvl) => ({
            ...lvl,
            score: scoreMap[lvl.SK] || null,
        }));

        return successResponse({
            levels: enrichedLevels,
            lastEvaluatedKey: levelsResult.LastEvaluatedKey || null,
        });
    } catch (err) {
        console.error("Lỗi getLevels:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// POST /minigame/start
// Body: { gameId: string, levelId: string }
// ═══════════════════════════════════════════════════════
const handleStartGame = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { gameId, levelId } = body;

        if (!gameId || !levelId) {
            return errorResponse(400, "gameId và levelId là bắt buộc");
        }

        // Lấy thông tin màn chơi
        const levelResult = await docClient.send(
            new GetCommand({
                TableName: process.env.MINIGAME_TABLE,
                Key: { PK: gameId, SK: levelId },
            })
        );
        const level = levelResult.Item;
        if (!level) return errorResponse(404, "Không tìm thấy màn chơi");

        // Lấy profile
        const profileResult = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
            })
        );
        const profile = profileResult.Item;
        if (!profile) return errorResponse(404, "Không tìm thấy profile");

        const { sanityCost, requiredLevel, baseMapConfig } = level;

        // Kiểm tra sanity
        if ((profile.budget?.sanity || 0) < sanityCost) {
            return errorResponse(402, "Không đủ sanity để chơi màn này", {
                currentSanity: profile.budget?.sanity || 0,
                updatedAt: profile.updatedAt,
            });
        }

        // Kiểm tra requiredLevel (màn trước đã vượt chưa)
        if (requiredLevel) {
            const reqScore = await docClient.send(
                new GetCommand({
                    TableName: process.env.MINIGAME_TABLE,
                    Key: { PK: userId, SK: `score#${gameId}#${requiredLevel}` },
                })
            );
            if (!reqScore.Item) {
                return errorResponse(403, "Bạn cần hoàn thành màn trước để mở khóa màn này");
            }
        }

        // Tạo seed ngẫu nhiên cho PRNG
        const seed = Math.floor(Math.random() * 1000000);
        const startTime = Date.now();
        const sanityCostFinal = sanityCost || 0;

        const newSanity = (profile.budget?.sanity || 0) - sanityCostFinal;

        // Trừ sanity
        await docClient.send(
            new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
                UpdateExpression:
                    "SET budget.sanity = :sanity, updatedAt = :now",
                ExpressionAttributeValues: {
                    ":sanity": newSanity,
                    ":now": startTime,
                    ":requiredSanity": sanityCostFinal,
                },
                ConditionExpression: "budget.sanity >= :requiredSanity",
            })
        );

        // Tạo Payload
        const payload = JSON.stringify({ userId, gameId, levelId, seed, startTime, sanityCost: sanityCostFinal });
        
        // Ký HMAC để chống sửa đổi thông tin ở Client
        const hmac = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("hex");
        const gameToken = Buffer.from(payload).toString("base64") + "." + hmac;

        // Trả về cho client (KHÔNG gửi solutionGrid)
        return successResponse({
            gameToken,
            seed,
            baseMapConfig: {
                ...baseMapConfig,
                solutionGrid: undefined, // loại bỏ solution
            },
            newBudget: {
                sanity: newSanity,
                knowledgeCore: profile.budget?.knowledgeCore,
                knowledgePoint: profile.budget?.knowledgePoint,
                eCoin: profile.budget?.eCoin,
            },
            updatedAt: startTime,
        });
    } catch (err) {
        if (err.name === "ConditionalCheckFailedException") {
            return errorResponse(402, "Không đủ sanity");
        }
        console.error("Lỗi startGame:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// POST /minigame/end
// Body: { gameId: string, finalGrid?: string, actionLog?: Array }
const handleEndGame = async (event) => {
    const eventUserId = getUserId(event);
    if (!eventUserId) return errorResponse(401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { gameId, gameToken, finalGrid, actionLog = [] } = body;

        if (!gameId || !gameToken) return errorResponse(400, "gameId và gameToken là bắt buộc");

        // ── 1. Xác thực HMAC Token ──
        const parts = gameToken.split(".");
        if (parts.length !== 2) return errorResponse(400, "gameToken không hợp lệ");
        
        const [base64Payload, signature] = parts;
        const payloadStr = Buffer.from(base64Payload, "base64").toString("utf-8");
        
        const expectedHmac = crypto.createHmac("sha256", JWT_SECRET).update(payloadStr).digest("hex");
        if (signature !== expectedHmac) {
            console.error("Token tampered! Fraud detected for user:", eventUserId);
            return errorResponse(403, "Phát hiện gian lận: Dữ liệu đã bị chỉnh sửa!");
        }

        const { userId, levelId, seed, startTime, sanityCost } = JSON.parse(payloadStr);

        if (userId !== eventUserId) {
            return errorResponse(403, "Token không thuộc về user này");
        }

        const now = Date.now();
        const elapsedSeconds = Math.floor((now - startTime) / 1000);

        // Lấy thông tin màn chơi
        const levelResult = await docClient.send(
            new GetCommand({
                TableName: process.env.MINIGAME_TABLE,
                Key: { PK: gameId, SK: levelId },
            })
        );
        const level = levelResult.Item;
        if (!level) return errorResponse(404, "Không tìm thấy dữ liệu màn chơi");

        // ── 2. Anti-cheat checks ──
        const MIN_SECONDS = 5; 
        let isWin = false;

        if (elapsedSeconds < MIN_SECONDS) {
            isWin = false; // quá nhanh → gian lận
        } else {
            // Anti-cheat 2: Tái sinh map bằng seed trên RAM
            if (gameId === "minesweeper") {
                // Tương lai: Generate map từ `seed` bằng PRNG và so khớp mảng `finalGrid` (tọa độ user click).
                // Hiện tại: Tạm thời cho isWin nếu client truyền list, chờ hoàn thiện Generator.
                if (Array.isArray(finalGrid) && finalGrid.length > 0) {
                    isWin = true;
                } else {
                    isWin = false;
                }
            } else if (gameId === "sudoku") {
                const solutionGrid = level.baseMapConfig?.solutionGrid;
                isWin = (finalGrid === solutionGrid);
            }
        }

        // ── Tính phần thưởng ──
        const profileResult = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
            })
        );
        const profile = profileResult.Item;

        let earnedECoin = 0;
        let earnedSanity = 0;
        let score = 0;

        if (isWin) {
            earnedECoin = level.eCoin || 0;
            score = calculateScore(
                level.maxScoreCap || 1000,
                level.maxScoreCap || 1000, // dùng maxScoreCap làm baseline
                elapsedSeconds
            );
        } else {
            // Thua: hoàn 50% sanityCost
            earnedSanity = Math.floor((sanityCost || 0) * 0.5);
        }

        const currentECoin = profile.budget?.eCoin || 0;
        const currentSanity = profile.budget?.sanity || 0;
        const newECoin = currentECoin + earnedECoin;
        const newSanity = currentSanity + earnedSanity;
        const newNow = Date.now();

        // ── Cập nhật score record ──
        let scoreUpdated = false;
        let oldPersonalBest = 0;

        if (isWin) {
            const scoreKey = `score#${gameId}#${levelId}`;
            const existingScore = await docClient.send(
                new GetCommand({
                    TableName: process.env.MINIGAME_TABLE,
                    Key: { PK: userId, SK: scoreKey },
                })
            );

            if (!existingScore.Item) {
                // Tạo mới
                await docClient.send(
                    new TransactWriteCommand({
                        TransactItems: [
                            {
                                Put: {
                                    TableName: process.env.MINIGAME_TABLE,
                                    Item: {
                                        PK: userId,
                                        SK: scoreKey,
                                        personalBest: score,
                                        achievedAt: newNow,
                                    },
                                },
                            },
                            // Cập nhật stats
                            {
                                Update: {
                                    TableName: process.env.MINIGAME_TABLE,
                                    Key: { PK: userId, SK: `stats#${gameId}` },
                                    UpdateExpression:
                                        "ADD levelsCompleted :one, totalScore :score SET gameId = :gid, lastUpdatedAt = :now, displayInfo = :info",
                                    ExpressionAttributeValues: {
                                        ":one": 1,
                                        ":score": score,
                                        ":gid": gameId,
                                        ":now": newNow,
                                        ":info": {
                                            name: profile.information?.name,
                                            avatarUrl: profile.information?.avatarUrl,
                                            equippedFrame: profile.equippedCosmetics?.equippedFrame,
                                        },
                                    },
                                },
                            },
                        ],
                    })
                );
                scoreUpdated = true;
            } else if (score > existingScore.Item.personalBest) {
                // Vượt personalBest
                oldPersonalBest = existingScore.Item.personalBest || 0;
                const scoreDiff = score - oldPersonalBest;

                await docClient.send(
                    new TransactWriteCommand({
                        TransactItems: [
                            {
                                Update: {
                                    TableName: process.env.MINIGAME_TABLE,
                                    Key: { PK: userId, SK: scoreKey },
                                    UpdateExpression:
                                        "SET personalBest = :score, achievedAt = :now",
                                    ExpressionAttributeValues: {
                                        ":score": score,
                                        ":now": newNow,
                                    },
                                },
                            },
                            {
                                Update: {
                                    TableName: process.env.MINIGAME_TABLE,
                                    Key: { PK: userId, SK: `stats#${gameId}` },
                                    UpdateExpression:
                                        "ADD totalScore :diff SET lastUpdatedAt = :now, displayInfo = :info",
                                    ExpressionAttributeValues: {
                                        ":diff": scoreDiff,
                                        ":now": newNow,
                                        ":info": {
                                            name: profile.information?.name,
                                            avatarUrl: profile.information?.avatarUrl,
                                            equippedFrame: profile.equippedCosmetics?.equippedFrame,
                                        },
                                    },
                                },
                            },
                        ],
                    })
                );
                scoreUpdated = true;
            }
        }

        // Cập nhật profile budget
        await docClient.send(
            new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
                UpdateExpression:
                    "SET budget.eCoin = :ecoin, budget.sanity = :sanity, updatedAt = :now",
                ExpressionAttributeValues: {
                    ":ecoin": newECoin,
                    ":sanity": newSanity,
                    ":now": newNow,
                },
            })
        );

        // ── Cập nhật quest progress ──
        const questType =
            gameId === "sudoku"
                ? "PLAY_SUDOKU"
                : gameId === "minesweeper"
                    ? "PLAY_MINESWEEPER"
                    : `PLAY_${gameId.toUpperCase()}`;

        if (isWin) {
            await updateQuestProgress(userId, questType, 1);
        }

        return successResponse({
            isWin,
            score,
            scoreUpdated,
            oldPersonalBest,
            earnedECoin,
            earnedSanity,
            newBudget: {
                eCoin: newECoin,
                sanity: newSanity,
            },
            updatedAt: newNow,
        });
    } catch (err) {
        console.error("Lỗi endGame:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// GET /minigame/leaderboard/global?gameId=sudoku
// ═══════════════════════════════════════════════════════
const handleGetGlobalLeaderboard = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const gameId = event.queryStringParameters?.gameId;
        if (!gameId) return errorResponse(400, "gameId là bắt buộc");

        const result = await docClient.send(
            new GetCommand({
                TableName: process.env.MINIGAME_TABLE,
                Key: { PK: "globalLeaderboard", SK: gameId },
            })
        );

        if (!result.Item) {
            return successResponse({ leaderboard: [], gameId });
        }

        return successResponse({ leaderboard: result.Item.entries || [], gameId });
    } catch (err) {
        console.error("Lỗi getGlobalLeaderboard:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// GET /minigame/leaderboard/friends?gameId=sudoku
// ═══════════════════════════════════════════════════════
const handleGetFriendsLeaderboard = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const gameId = event.queryStringParameters?.gameId;
        if (!gameId) return errorResponse(400, "gameId là bắt buộc");

        // Lấy danh sách bạn bè ACCEPTED
        const friendsResult = await docClient.send(
            new QueryCommand({
                TableName: process.env.SOCIAL_TABLE,
                KeyConditionExpression: "PK = :uid",
                FilterExpression: "#s = :accepted",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                    ":uid": userId,
                    ":accepted": "ACCEPTED",
                },
            })
        );

        const friendIds = (friendsResult.Items || []).map((f) => f.SK);
        const allIds = [userId, ...friendIds]; // bao gồm bản thân

        if (allIds.length === 0) {
            return successResponse({ leaderboard: [], gameId });
        }

        // BatchGetItem stats của tất cả, hỗ trợ > 100 bằng chunking
        const statsKeys = allIds.map((id) => ({ PK: id, SK: `stats#${gameId}` }));
        let statsItems = [];

        const BATCH_SIZE = 100;
        for (let i = 0; i < statsKeys.length; i += BATCH_SIZE) {
            const batchKeys = statsKeys.slice(i, i + BATCH_SIZE);
            const batchResult = await docClient.send(
                new BatchGetCommand({
                    RequestItems: {
                        [process.env.MINIGAME_TABLE]: { Keys: batchKeys },
                    },
                })
            );
            const items = batchResult.Responses?.[process.env.MINIGAME_TABLE] || [];
            statsItems.push(...items);
        }

        // Sort theo totalScore giảm dần, lấy top 10
        const sorted = statsItems
            .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
            .slice(0, 10)
            .map((item, index) => ({
                rank: index + 1,
                userId: item.PK,
                totalScore: item.totalScore || 0,
                levelsCompleted: item.levelsCompleted || 0,
                lastUpdatedAt: item.lastUpdatedAt,
                displayInfo: item.displayInfo || {},
            }));

        return successResponse({ leaderboard: sorted, gameId });
    } catch (err) {
        console.error("Lỗi getFriendsLeaderboard:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// EventBridge trigger (cron mỗi 10 phút)
// Tính toán và ghi đè globalLeaderboard
// ═══════════════════════════════════════════════════════
const handleLeaderboardWorker = async (event) => {
    try {
        const gameIds = ["sudoku", "minesweeper"];
        const now = Date.now();

        for (const gameId of gameIds) {
            // Query GSI: gameId = gameId, sắp xếp totalScore giảm dần
            // Giả định có GSI với PK=gameId, SK=totalScore (hoặc sort bằng code)
            const result = await docClient.send(
                new QueryCommand({
                    TableName: process.env.MINIGAME_TABLE,
                    IndexName: "gameId-totalScore-index",
                    KeyConditionExpression: "gameId = :gid",
                    ExpressionAttributeValues: { ":gid": gameId },
                    ScanIndexForward: false, // giảm dần
                    Limit: 10,
                })
            );

            const topPlayers = (result.Items || []).map((item, index) => ({
                rank: index + 1,
                userId: item.PK,
                totalScore: item.totalScore || 0,
                levelsCompleted: item.levelsCompleted || 0,
                lastUpdatedAt: item.lastUpdatedAt,
                displayInfo: item.displayInfo || {},
            }));

            // Ghi đè vào globalLeaderboard — dùng static PutCommand
            await docClient.send(
                new PutCommand({
                    TableName: process.env.MINIGAME_TABLE,
                    Item: {
                        PK: "globalLeaderboard",
                        SK: gameId,
                        entries: topPlayers,
                        updatedAt: now,
                    },
                })
            );

            console.log(`Updated globalLeaderboard for ${gameId} with ${topPlayers.length} players`);
        }

        return { statusCode: 200, body: "Leaderboard updated" };
    } catch (err) {
        console.error("Lỗi leaderboardWorker:", err);
        throw err;
    }
};

export {
    handleGetLevels,
    handleStartGame,
    handleEndGame,
    handleGetGlobalLeaderboard,
    handleGetFriendsLeaderboard,
    handleLeaderboardWorker,
};
