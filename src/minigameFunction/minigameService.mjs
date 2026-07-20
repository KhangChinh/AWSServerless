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
const JWT_SECRET = process.env.GAME_SECRET_KEY || "fallback_secret"; // Dùng env trong thực tế

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

// Hàm Helper để xử lý logic xếp hạng chung
const processTop10 = (statsArray) => {
    return statsArray
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, 10)
        .map(stat => ({
            userId: stat.PK,
            totalScore: stat.totalScore,
            levelsCompleted: stat.levelsCompleted,
            displayInfo: stat.displayInfo || { name: "Unknown", avatarUrl: "", equippedFrame: null }
        }));
};

// ═══════════════════════════════════════════════════════
// WORKER: TỰ ĐỘNG TẠO / GHI ĐÈ BẢNG XẾP HẠNG (Chạy mỗi 10p)
// ═══════════════════════════════════════════════════════
const handleLeaderboardWorker = async (event) => {
    try {
        console.log("Bắt đầu chạy Worker cập nhật Leaderboard (All Minigames)...");

        // 1. Quét toàn bộ Stats CỦA TẤT CẢ MINIGAME TRONG 1 LẦN (Tiết kiệm 50% RCU)
        let allStats = [];
        let lastEvaluatedKey = undefined;

        // Dùng vòng lặp do-while để lấy sạch data nếu bảng lớn hơn 1MB
        do {
            const scanParams = {
                TableName: process.env.MINIGAME_TABLE,
                // Lấy tất cả các row có SK bắt đầu bằng "stats#"
                FilterExpression: "begins_with(SK, :prefix)",
                ExpressionAttributeValues: {
                    ":prefix": "stats#"
                },
                ExclusiveStartKey: lastEvaluatedKey
            };

            const result = await docClient.send(new ScanCommand(scanParams));
            if (result.Items) {
                allStats.push(...result.Items);
            }
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey);

        console.log(`Đã quét được tổng cộng ${allStats.length} bản ghi stats.`);

        // 2. Phân loại dữ liệu theo game
        const sudokuStats = [];
        const minesweeperStats = [];

        for (const stat of allStats) {
            if (stat.SK === "stats#sudoku") {
                sudokuStats.push(stat);
            } else if (stat.SK === "stats#minesweeper") {
                minesweeperStats.push(stat);
            }
        }

        // 3. Sắp xếp và lấy Top 10 cho từng game
        const top10Sudoku = processTop10(sudokuStats);
        const top10Minesweeper = processTop10(minesweeperStats);

        // 4. Tính toán expiresAt chung: thời điểm hiện tại + 11 phút
        const expiresAt = Math.floor(Date.now() / 1000) + (11 * 60);

        // 5. Lưu song song 2 Leaderboard xuống DynamoDB (Tiết kiệm thời gian chạy Lambda)
        const putSudokuPromise = docClient.send(new PutCommand({
            TableName: process.env.MINIGAME_TABLE,
            Item: {
                PK: "leaderboard",
                SK: "sudoku",
                topPlayers: top10Sudoku,
                expiresAt: expiresAt
            }
        }));

        const putMinesweeperPromise = docClient.send(new PutCommand({
            TableName: process.env.MINIGAME_TABLE,
            Item: {
                PK: "leaderboard",
                SK: "minesweeper",
                topPlayers: top10Minesweeper,
                expiresAt: expiresAt
            }
        }));

        // Đợi cả 2 lệnh ghi hoàn thành cùng lúc
        await Promise.all([putSudokuPromise, putMinesweeperPromise]);

        console.log("Cập nhật toàn bộ Leaderboard thành công! expiresAt:", expiresAt);
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
    handleLeaderboardWorker,
    handleGetLeaderboard
};
