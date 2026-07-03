/**
 * searchService.mjs
 * Tìm kiếm user bằng Amazon OpenSearch Service.
 *
 * Luồng index: DynamoDB Streams → Lambda (streamIndexer) → OpenSearch.
 * Khi user cập nhật profile, bản ghi được tự động sync vào OS index.
 *
 * Index: "users"
 * Document: { userId, name, email, avatarUrl, streak, equippedTitles }
 */

import { AwsClient } from "aws4fetch"; // <-- [THÊM MỚI] Import thư viện
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

const OPENSEARCH_ENDPOINT = process.env.OPENSEARCH_ENDPOINT;
const OS_User_INDEX = process.env.OS_User_INDEX;

// <-- [THÊM MỚI] Khởi tạo aws4fetch client
// Tự động lấy credentials từ biến môi trường của AWS Lambda
const aws = new AwsClient({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION || "ap-southeast-1", // Mặc định theo region của bạn
    service: "es"
});

/**
 * Gọi OpenSearch REST API bằng aws.fetch để tự động ký AWS SigV4.
 * Lambda dùng IAM execution role có es:ESHttpGet/Post permission.
 */
async function osSearch(query) {
    const url = `${OPENSEARCH_ENDPOINT}/${OS_User_INDEX}/_search`;
    const res = await aws.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenSearch error ${res.status}: ${text}`);
    }
    return res.json();
}

// ═══════════════════════════════════════════════════════
// GET /friends/search?q=keyword
// Tìm kiếm user theo name hoặc email qua OpenSearch.
// Trả về thông tin công khai: userId, name, avatarUrl, streak, titles.
// ═══════════════════════════════════════════════════════
const handleSearchUser = async (event) => {
    console.log("Start Search!!!!!!!!!!!!!!!!!!!!!!")
    const userId = getUserId(event);
    console.log("EW EVENT", event)
    console.log("Extracted userId:", userId);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const q = event.queryStringParameters?.q;
        if (!q || q.trim().length < 2) {
            return errorResponse(400, "Từ khóa tìm kiếm phải có ít nhất 2 ký tự");
        }
        const keyword = q.trim();

        // [RATE LIMITING] Kiểm tra chống spam (5 giây/lần)
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

        // Cập nhật thời điểm search cuối cùng
        await docClient.send(new UpdateCommand({
            TableName: process.env.USER_TABLE,
            Key: { PK: userId },
            UpdateExpression: "SET lastSearchAt = :now, updatedAt = :now",
            ExpressionAttributeValues: { ":now": now }
        }));

        const osQuery = {
            from: 0,
            size: 10,
            _source: [
                "userId",
                "name",
                "email",
                "avatarUrl",
                "rankScore",
                "streak",
                "lastFocusDate"
            ],
            query: {
                bool: {
                    must_not: [{ term: { userId } }],
                    should: [
                        {
                            match_phrase_prefix: {
                                name: {
                                    query: keyword,
                                    boost: 5,
                                },
                            },
                        },
                        {
                            match: {
                                name: {
                                    query: keyword,
                                    fuzziness: "AUTO",
                                    prefix_length: 2,
                                    boost: 2,
                                },
                            },
                        },
                        {
                            match_phrase_prefix: {
                                email: {
                                    query: keyword,
                                    boost: 1,
                                },
                            },
                        },
                    ],
                    minimum_should_match: 1,
                },
            },
        };

        const result = await osSearch(osQuery);
        const users = (result.hits?.hits || []).map((hit) => ({
            userId: hit._source.userId,
            name: hit._source.name || "",
            email: hit._source.email || "",
            avatarUrl: hit._source.avatarUrl || "",
            rankScore: hit._source.rankScore || 0,
            streak: hit._source.streak || 0,
            lastFocusDate: hit._source.lastFocusDate || 0
        }));

        return successResponse({
            users,
            hasMore: from + users.length < (result.hits?.total?.value || 0)
        });
    } catch (err) {
        console.error("Lỗi searchUser (OpenSearch):", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// DynamoDB Streams → Lambda trigger
// Sync user profile thay đổi vào OpenSearch index "users".
// Handler được khai báo trong function.yml (streamIndexer).
// ═══════════════════════════════════════════════════════
const handleStreamIndexer = async (event) => {
    const ops = [];
    console.log("DynamoDB Event Records:", JSON.stringify(event.Records, null, 2));

    for (const record of event.Records) {
        if (record.eventName === "REMOVE") continue; // Nếu cần xóa document trên OS khi bị xóa ở DB, bạn có thể xử lý thêm ở đây

        const newImage = record.dynamodb?.NewImage;
        if (!newImage) {
            console.log("Bỏ qua vì không có newImage");
            continue;
        }
        const userId = newImage.PK?.S;
        if (!userId) {
            console.log("Bỏ qua vì không tìm thấy PK (userId)");
            continue;
        }
        const info = newImage.information?.M || {};
        const studyStats = newImage.studyStats?.M || {};

        const doc = {
            userId: userId,
            name: info.name?.S || "",
            email: info.email?.S || "",
            avatarUrl: info.avatarUrl?.S || "",
            rankScore: Number(studyStats.rankScore?.N || 0),
            streak: Number(studyStats.streak?.N || 0),
            lastFocusDate: Number(studyStats.lastFocusDate?.N || 0)
        };
        console.log("Chuẩn bị đẩy doc này lên OpenSearch:", doc);
        const url = `${OPENSEARCH_ENDPOINT}/${OS_User_INDEX}/_doc/${userId}`;
        ops.push(
            aws.fetch(url, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(doc),
            })
        );
    }

    if (ops.length > 0) {
        const results = await Promise.allSettled(ops);
        for (let i = 0; i < results.length; i++) {
            const r = results[i];

            if (r.status === "rejected") {
                console.error(`Lỗi ở record ${i}:`, r.reason);
            } else {
                // Đọc nội dung OpenSearch trả về
                const responseBody = await r.value.text();

                if (!r.value.ok) {
                    console.error(`Thất bại ở record ${i}. HTTP ${r.value.status}:`, responseBody);
                } else {
                    console.log(`Đẩy lên OpenSearch THÀNH CÔNG record ${i}! Phản hồi:`, responseBody);
                }
            }
        }
    }

    return { processed: ops.length };
};

export { handleSearchUser, handleStreamIndexer };