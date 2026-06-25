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
import { successResponse, errorResponse } from "../response.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

// OPENSEARCH_ENDPOINT không gồm /_dashboards — chỉ là domain HTTPS
const OS_ENDPOINT = process.env.OPENSEARCH_ENDPOINT;
const OS_INDEX = "users";

// <-- [THÊM MỚI] Khởi tạo aws4fetch client
// Tự động lấy credentials từ biến môi trường của AWS Lambda
const aws = new AwsClient({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION || "ap-southeast-1", // Mặc định theo region của bạn
});

/**
 * Gọi OpenSearch REST API bằng aws.fetch để tự động ký AWS SigV4.
 * Lambda dùng IAM execution role có es:ESHttpGet/Post permission.
 */
async function osSearch(query) {
    const url = `${OS_ENDPOINT}/${OS_INDEX}/_search`;

    // <-- [SỬA LẠI] Thay fetch native bằng aws.fetch
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
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const q = event.queryStringParameters?.q;
        if (!q || q.trim().length < 2) {
            return errorResponse(400, "Từ khóa tìm kiếm phải có ít nhất 2 ký tự");
        }
        const keyword = q.trim();

        // Multi-match: tìm theo name và email, fuzzy để chịu lỗi chính tả nhỏ
        const osQuery = {
            size: 10,
            _source: ["userId", "name", "avatarUrl", "streak", "equippedTitles"],
            query: {
                bool: {
                    must_not: [{ term: { userId } }], // loại bỏ bản thân
                    should: [
                        {
                            match: {
                                name: {
                                    query: keyword,
                                    fuzziness: "AUTO",
                                    boost: 2, // ưu tiên khớp tên
                                },
                            },
                        },
                        {
                            match: {
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
            name: hit._source.name,
            avatarUrl: hit._source.avatarUrl,
            streak: hit._source.streak || 0,
            titles: hit._source.equippedTitles || [],
        }));

        return successResponse({ users });
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

    for (const record of event.Records) {
        // Chỉ xử lý bản ghi profile (SK = "profile")
        if (record.eventName === "REMOVE") continue; // Nếu cần xóa document trên OS khi bị xóa ở DB, bạn có thể xử lý thêm ở đây

        const newImage = record.dynamodb?.NewImage;
        if (!newImage) continue;

        // Chỉ index bản ghi SK = "profile"
        const sk = newImage.SK?.S;
        if (sk !== "profile") continue;

        const userId = newImage.PK?.S;
        const info = newImage.information?.M || {};
        const studyStats = newImage.studyStats?.M || {};
        const equippedCosmetics = newImage.equippedCosmetics?.M || {};

        const doc = {
            userId,
            name: info.name?.S || "",
            email: info.email?.S || "",
            avatarUrl: info.avatarUrl?.S || "",
            streak: Number(studyStats.streak?.N || 0),
            equippedTitles: (equippedCosmetics.equippedTitles?.L || []).map(
                (t) => t.S
            ),
        };

        // Upsert vào OpenSearch
        const url = `${OS_ENDPOINT}/${OS_INDEX}/_doc/${userId}`;

        // <-- [SỬA LẠI] Thay fetch native bằng aws.fetch
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
        results.forEach((r, i) => {
            if (r.status === "rejected") {
                console.error(`Stream index error record ${i}:`, r.reason);
            } else if (!r.value.ok) {
                // <-- [THÊM MỚI] Ghi log nếu OpenSearch trả về lỗi nhưng request HTTP vẫn thành công
                console.error(`Stream index failed for record ${i} with status ${r.value.status}: ${r.value.statusText}`);
            }
        });
    }

    return { processed: ops.length };
};

export { handleSearchUser, handleStreamIndexer };