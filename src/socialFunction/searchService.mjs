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

import { successResponse, errorResponse } from "../response.mjs";

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

// Gọi OpenSearch qua AWS SDK v3 (dùng fetch native của Node 20)
// OPENSEARCH_ENDPOINT không gồm /_dashboards — chỉ là domain HTTPS
const OS_ENDPOINT = process.env.OPENSEARCH_ENDPOINT;
const OS_INDEX = "users";

/**
 * Gọi OpenSearch REST API bằng fetch (Node 20 native).
 * Lambda dùng IAM execution role có es:ESHttpGet/Post permission.
 */
async function osSearch(query) {
    const url = `${OS_ENDPOINT}/${OS_INDEX}/_search`;
    const res = await fetch(url, {
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
        if (record.eventName === "REMOVE") continue;

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
        ops.push(
            fetch(url, {
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
            }
        });
    }

    return { processed: ops.length };
};

export { handleSearchUser, handleStreamIndexer };
