import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

const s3 = new S3Client({});

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

// Avatar cooldown: 7 ngày
const AVATAR_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════
// POST /avatar/presign
// Trả về presigned URL để client tự upload ảnh lên S3.
//
// Luồng avatar:
//   - User mới: avatarUrl = "avatars/default_avatar.jpg" (path tương đối, frontend ghép domain)
//   - User đổi ảnh:
//       1. POST /avatar/presign → nhận uploadUrl (5 phút)
//       2. Client PUT ảnh lên S3 (không qua server)
//       3. POST /avatar/confirm → server ghi path vào DB
//   - S3 key cố định: avatars/{userId}.jpg — ghi đè, không tạo file mới
//   - avatarUrl trong DB luôn là path tương đối, frontend tự ghép CDN domain
// ═══════════════════════════════════════════════════════
const handlePresignAvatar = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const profileResult = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
            })
        );
        const profile = profileResult.Item;
        if (!profile) return errorResponse(404, "Không tìm thấy profile");

        const now = Date.now();
        const lastUpdate = profile.avatarUpdatedAt || 0;

        if (now - lastUpdate < AVATAR_COOLDOWN_MS) {
            const remainMs = AVATAR_COOLDOWN_MS - (now - lastUpdate);
            return errorResponse(429, "Chưa đủ thời gian để đổi ảnh đại diện", {
                remainMs,
                availableAt: lastUpdate + AVATAR_COOLDOWN_MS,
            });
        }

        // Key cố định theo userId — ghi đè file cũ thay vì tạo mới
        const s3Key = `avatars/${userId}.jpg`;

        const presignedPost = await createPresignedPost(s3, {
            Bucket: process.env.ASSETS_BUCKET,
            Key: s3Key,
            Conditions: [
                ["content-length-range", 1024, 5242880], // Từ 1KB đến 5MB
                ["starts-with", "$Content-Type", "image/"] // Bắt buộc là file ảnh
            ],
            Fields: {
                "Content-Type": "image/jpeg"
            },
            Expires: 300 // 5 phút
        });

        return successResponse({
            url: presignedPost.url,
            fields: presignedPost.fields,
            expiresIn: 300,
        });
    } catch (err) {
        console.error("Lỗi presignAvatar:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

// ═══════════════════════════════════════════════════════
// POST /avatar/confirm
// Client gọi sau khi đã PUT ảnh lên S3 thành công.
// Server tự tính path — client không gửi URL, không gửi key.
// avatarUrl lưu dạng path tương đối, frontend ghép domain khi hiển thị.
// ═══════════════════════════════════════════════════════
const handleConfirmAvatar = async (event) => {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, "Unauthorized");

    try {
        const now = Date.now();

        // Server tự tính path — client không có quyền chỉ định
        const avatarPath = `avatars/${userId}.jpg`;

        // Kiểm tra cooldown lần nữa để tránh race condition
        const profileResult = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
            })
        );
        const profile = profileResult.Item;
        if (!profile) return errorResponse(404, "Không tìm thấy profile");

        const lastUpdate = profile.avatarUpdatedAt || 0;
        if (now - lastUpdate < AVATAR_COOLDOWN_MS) {
            return errorResponse(429, "Cooldown chưa hết, không thể xác nhận đổi ảnh");
        }

        // Ghi path tương đối vào DB (frontend tự ghép CDN domain để load)
        await docClient.send(
            new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
                UpdateExpression:
                    "SET information.avatarUrl = :url, avatarUpdatedAt = :now, updatedAt = :now",
                ExpressionAttributeValues: {
                    ":url": avatarPath,
                    ":now": now,
                },
            })
        );

        return successResponse({
            message: "Cập nhật ảnh đại diện thành công",
            avatarUrl: avatarPath,
            avatarUpdatedAt: now,
        });
    } catch (err) {
        console.error("Lỗi confirmAvatar:", err);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

export { handlePresignAvatar, handleConfirmAvatar };
