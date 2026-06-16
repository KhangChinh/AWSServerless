import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

// ═══════════════════════════════════════════
// POST /start-session
// Body: { mode: "casual" | "rank", durationMinutes: number }
// ═══════════════════════════════════════════
const handleStartSession = async (event) => {
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub || authorizer?.claims?.sub;

    if (!userId) {
        return errorResponse(401, "Unauthorized");
    }

    try {
        const body = JSON.parse(event.body || "{}");
        const { mode, durationMinutes } = body;

        if (!mode || !["casual", "rank"].includes(mode)) {
            return errorResponse(400, "mode phải là 'casual' hoặc 'rank'");
        }

        if (!durationMinutes || typeof durationMinutes !== "number" || durationMinutes <= 0) {
            return errorResponse(400, "durationMinutes phải là số dương");
        }

        const now = Math.floor(Date.now() / 1000);
        const sessionId = now;

        await docClient.send(new PutCommand({
            TableName: process.env.STUDY_TABLE,
            Item: {
                PK: userId,
                SK: sessionId,
                mode,
                startTime: now,
                endTime: null,
                durationMinutes,
                status: "PENDING",
                strikeCount: 0,
                expiresAt: null,
            },
        }));

        return successResponse({ sessionId });
    } catch (error) {
        console.error("Lỗi tạo session:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════
// POST /strike
// Body: { sessionId }
// Server tự tăng strikeCount, auto FAILED khi >= 3
// ═══════════════════════════════════════════
const handleRecordStrike = async (event) => {
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub || authorizer?.claims?.sub;

    if (!userId) {
        return errorResponse(401, "Unauthorized");
    }

    try {
        const body = JSON.parse(event.body || "{}");
        const { sessionId } = body;

        if (!sessionId) {
            return errorResponse(400, "sessionId là bắt buộc");
        }

        // Lấy session hiện tại
        const getResult = await docClient.send(new GetCommand({
            TableName: process.env.STUDY_TABLE,
            Key: { PK: userId, SK: Number(sessionId) },
        }));

        if (!getResult.Item) {
            return errorResponse(404, "Không tìm thấy session");
        }

        if (getResult.Item.status !== "PENDING") {
            return errorResponse(400, "Session đã kết thúc");
        }

        const newCount = (getResult.Item.strikeCount || 0) + 1;

        if (newCount >= 3) {
            // Auto FAILED: đủ 3 strikes
            const now = Math.floor(Date.now() / 1000);
            await docClient.send(new UpdateCommand({
                TableName: process.env.STUDY_TABLE,
                Key: { PK: userId, SK: Number(sessionId) },
                UpdateExpression: "SET strikeCount = :count, #st = :failed, endTime = :now, expiresAt = :ttl",
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: {
                    ":count": newCount,
                    ":failed": "FAILED",
                    ":now": now,
                    ":ttl": now + 30 * 24 * 60 * 60,
                },
            }));

            return successResponse({ strikeCount: newCount, sessionEnded: true });
        }

        // Chưa đủ 3: chỉ tăng count
        await docClient.send(new UpdateCommand({
            TableName: process.env.STUDY_TABLE,
            Key: { PK: userId, SK: Number(sessionId) },
            UpdateExpression: "SET strikeCount = :count",
            ExpressionAttributeValues: { ":count": newCount },
        }));

        return successResponse({ strikeCount: newCount, sessionEnded: false });
    } catch (error) {
        console.error("Lỗi ghi strike:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════
// POST /end-session
// Body: { sessionId }
// Server tự tính toán kết quả từ dữ liệu trong DB
// Client KHÔNG gửi status hay reason
// ═══════════════════════════════════════════
const TIME_TOLERANCE = 30; // cho phép lệch 30 giây

const handleEndSession = async (event) => {
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub || authorizer?.claims?.sub;

    if (!userId) {
        return errorResponse(401, "Unauthorized");
    }

    try {
        const body = JSON.parse(event.body || "{}");
        const { sessionId } = body;

        if (!sessionId) {
            return errorResponse(400, "sessionId là bắt buộc");
        }

        // Lấy session từ DB
        const getResult = await docClient.send(new GetCommand({
            TableName: process.env.STUDY_TABLE,
            Key: { PK: userId, SK: Number(sessionId) },
        }));

        if (!getResult.Item) {
            return errorResponse(404, "Không tìm thấy session");
        }

        if (getResult.Item.status !== "PENDING") {
            return errorResponse(400, "Session đã kết thúc");
        }

        const session = getResult.Item;
        const now = Math.floor(Date.now() / 1000);
        const elapsed = now - session.startTime;
        const expected = session.durationMinutes * 60;

        // ══════════════════════════════════════
        // THUẬT TOÁN QUYẾT ĐỊNH (100% server-side)
        // ══════════════════════════════════════
        //
        // Dữ liệu server có:
        //   - strikeCount: số lần vi phạm (server tự đếm)
        //   - elapsed: thời gian thực tế = now - startTime
        //   - expected: thời gian yêu cầu = durationMinutes * 60
        //   - mode: "casual" hoặc "rank"
        //
        // Thuật toán:
        //   1. strikeCount >= 3          → FAILED (vi phạm quá nhiều)
        //   2. elapsed >= expected - 30s → COMPLETED (đã học đủ thời gian)
        //   3. elapsed < expected - 30s:
        //      - casual → COMPLETED (casual được phép dừng sớm)
        //      - rank   → FAILED (rank phải hoàn thành hết thời gian)

        let status;

        if (session.strikeCount >= 3) {
            // Vi phạm 3+ lần → thất bại (trường hợp dự phòng, thường đã bị FAILED ở /strike)
            status = "FAILED";
        } else if (elapsed >= expected - TIME_TOLERANCE) {
            // Đã học đủ thời gian (cho phép lệch 30s do network delay)
            status = "COMPLETED";
        } else if (session.mode === "casual") {
            // Casual mode dừng sớm → vẫn tính hoàn thành
            status = "COMPLETED";
        } else {
            // Rank mode dừng sớm → thất bại (hard mode không cho dừng)
            status = "FAILED";
        }

        // Cập nhật DB
        await docClient.send(new UpdateCommand({
            TableName: process.env.STUDY_TABLE,
            Key: { PK: userId, SK: Number(sessionId) },
            UpdateExpression: "SET #st = :status, endTime = :now, expiresAt = :ttl",
            ExpressionAttributeNames: { "#st": "status" },
            ExpressionAttributeValues: {
                ":status": status,
                ":now": now,
                ":ttl": now + 30 * 24 * 60 * 60,
            },
        }));

        return successResponse({
            status,
            actualDurationSeconds: elapsed,
        });
    } catch (error) {
        console.error("Lỗi kết thúc session:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

export {
    handleStartSession,
    handleRecordStrike,
    handleEndSession,
};

