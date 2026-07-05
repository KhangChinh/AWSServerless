import algoliasearch from "algoliasearch";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

// Khởi tạo Algolia Client bằng Write API Key (dùng cho Backend)
const algoliaClient = algoliasearch(
    process.env.ALGOLIA_APP_ID,
    process.env.ALGOLIA_WRITE_KEY
);
const index = algoliaClient.initIndex(process.env.ALGOLIA_USER_INDEX || "users");

// ═══════════════════════════════════════════════════════
// GET /friends/search?q=keyword
// ═══════════════════════════════════════════════════════
const handleSearchUser = async (event) => {
    console.log("Start Algolia Search!");
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const q = event.queryStringParameters?.q;
        if (!q || q.trim().length < 2) {
            return errorResponse(400, "Từ khóa tìm kiếm phải có ít nhất 2 ký tự");
        }
        const keyword = q.trim();

        // [RATE LIMITING] Giữ nguyên logic chống spam của bạn
        const now = Date.now();
        const userProfile = await docClient.send(new GetCommand({
            TableName: process.env.USER_TABLE,
            Key: { PK: userId }
        }));

        const lastSearch = userProfile.Item?.lastSearchAt || 0;
        if (now - lastSearch < 5000) {
            const wait = Math.ceil((5000 - (now - lastSearch)) / 1000);
            return errorResponse(429, `Vui lòng đợi ${wait} giây trước khi tìm kiếm tiếp.`);
        }

        await docClient.send(new UpdateCommand({
            TableName: process.env.USER_TABLE,
            Key: { PK: userId },
            UpdateExpression: "SET lastSearchAt = :now, updatedAt = :now",
            ExpressionAttributeValues: { ":now": now }
        }));

        // --- GỌI ALGOLIA SEARCH ---
        const searchResults = await index.search(keyword, {
            hitsPerPage: 10,
            // (Tuỳ chọn) Tránh user tự tìm thấy chính mình nếu lỡ gõ tên mình
            filters: `NOT objectID:${userId}`
        });

        // Mapping kết quả trả về cho Frontend
        const users = searchResults.hits.map((hit) => ({
            PK: hit.PK,
            avatarUrl: hit.avatarUrl || "",
            information: { name: hit.information?.name || "" },
            studyStats: {
                rankScore: hit.studyStats?.rankScore || 0,
                streak: hit.studyStats?.streak || 0
            },
            equippedCosmetics: {
                equippedFrame: hit.equippedCosmetics?.equippedFrame || null
            }
        }));

        return successResponse({
            users,
            hasMore: searchResults.page < searchResults.nbPages - 1
        });
    } catch (err) {
        console.error("Lỗi searchUser (Algolia):", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// DynamoDB Streams → Lambda trigger (Đồng bộ lên Algolia)
// ═══════════════════════════════════════════════════════
const handleStreamIndexer = async (event) => {
    console.log("DynamoDB Event Records:", event.Records.length);

    const objectsToSave = [];
    const objectsToDelete = [];

    for (const record of event.Records) {
        // Lấy PK (userId)
        const userId = record.dynamodb?.Keys?.PK?.S;
        if (!userId) continue;

        // Nếu User bị xóa khỏi DynamoDB -> Xóa khỏi Algolia
        if (record.eventName === "REMOVE") {
            objectsToDelete.push(userId);
            continue;
        }

        // Lấy dữ liệu mới nhất (dùng unmarshall để biến obj phức tạp của DynamoDB thành JSON thường)
        if (!record.dynamodb?.NewImage) continue;
        const item = unmarshall(record.dynamodb.NewImage);

        // Chuẩn bị Object để đẩy lên Algolia
        // Bắt buộc phải có trường 'objectID' để Algolia biết cập nhật bản ghi nào
        const doc = {
            objectID: userId, // Bắt buộc
            PK: userId,
            avatarUrl: item.information?.avatarUrl || item.avatarUrl || process.env.DEFAULT_AVATAR_URL,
            information: {
                name: item.information?.name || "N/A"
            },
            studyStats: {
                rankScore: Number(item.studyStats?.rankScore || 0),
                streak: Number(item.studyStats?.streak || 0)
            },
            equippedCosmetics: {
                equippedFrame: item.equippedCosmetics?.equippedFrame || null
            }
        };

        objectsToSave.push(doc);
    }

    try {
        // Batch Save: Lưu hoặc Cập nhật nhiều user cùng lúc
        if (objectsToSave.length > 0) {
            await index.saveObjects(objectsToSave);
            console.log(`✅ Đã đồng bộ ${objectsToSave.length} users lên Algolia`);
        }

        // Batch Delete: Xóa user
        if (objectsToDelete.length > 0) {
            await index.deleteObjects(objectsToDelete);
            console.log(`🗑️ Đã xóa ${objectsToDelete.length} users khỏi Algolia`);
        }
    } catch (error) {
        console.error("❌ Lỗi đồng bộ Algolia:", error);
    }

    return { processed: event.Records.length };
};

export { handleSearchUser, handleStreamIndexer };