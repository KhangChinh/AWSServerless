import { GetCommand, UpdateCommand, BatchGetCommand, BatchWriteCommand, } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { docClient } from "../database.mjs";
import { successResponse } from "../response.mjs";
import { syncedErrorResponse } from "../errorSync.mjs";
import { refreshDaily } from "../syncFunction/syncService.mjs";
import { mapCosmeticAssets } from "../syncFunction/syncService.mjs"

const s3Client = new S3Client({ region: process.env.AWS_REGION });

const getUserId = (event) => {
    const auth = event.requestContext?.authorizer;
    return auth?.jwt?.claims?.sub || auth?.claims?.sub || null;
};

const handleInitUser = async (event) => {
    const userId = event.request.userAttributes.sub;
    const { email, name } = event.request.userAttributes;
    const now = Date.now();
    const defaultItemsConfig = {
        background: "bg_default",
        frame: "frame_none",
        title: "title_none",
        pet: "pet_none"
    };
    const defaultItemSKs = Object.values(defaultItemsConfig);
    let systemItems = [];
    if (defaultItemSKs.length > 0) {
        try {
            const keysToGet = defaultItemSKs.map(sk => ({
                PK: "item",
                SK: sk
            }));
            const getResponse = await docClient.send(
                new BatchGetCommand({
                    RequestItems: {
                        [process.env.ITEMDATA_TABLE]: {
                            Keys: keysToGet
                        }
                    }
                })
            );
            systemItems = getResponse.Responses[process.env.ITEMDATA_TABLE] || [];
        } catch (error) {
            console.error("DynamoDB BatchGet error:", error);
            throw new Error("Failed to fetch default items from Database.");
        }
    }
    const inventoryPutRequests = systemItems.map(item => {
        const { PK, SK, currencyType, price, isLimited, ...coreAttributes } = item;
        return {
            PutRequest: {
                Item: {
                    ...coreAttributes,
                    PK: userId,
                    SK: SK,
                    acquiredAt: new Date(now).toISOString()
                }
            }
        };
    });
    const profileItem = {
        PK: userId,
        information: {
            name: name || "N/A",
            email: email,
            avatarUrl: process.env.DEFAULT_AVATAR_URL,
        },
        budget: {
            knowledgePoint: 1500,
            knowledgeCore: 0,
            sanity: 0,
            eCoin: 0,
        },
        studyStats: {
            rankScore: 0,
            timeToStreak: 30,
            streak: 0,
            lastFocusDate: null,
        },
        gachaStats: {
            pity4Star: 0,
            pity5Star: 0,
            is4StarGuaranteed: false,
            is5StarGuaranteed: false,
        },
        equippedCosmetics: {
            equippedBackground: defaultItemsConfig.background || null,
            equippedButton: defaultItemsConfig.button || null,
            equippedFrame: defaultItemsConfig.frame || null,
            equippedTitles: defaultItemsConfig.title ? [defaultItemsConfig.title] : [],
            equippedPet: defaultItemsConfig.pet || null,
        },
        inventoryUpdatedAt: now,
        gachaHistoryUpdatedAt: now,
        friendUpdatedAt: now,
        avatarUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
    };
    const requestItems = {
        [process.env.USER_TABLE]: [
            { PutRequest: { Item: profileItem } },
        ]
    };
    if (inventoryPutRequests.length > 0) {
        requestItems[process.env.INVENTORY_TABLE] = inventoryPutRequests;
    }
    try {
        await docClient.send(
            new BatchWriteCommand({
                RequestItems: requestItems
            })
        );
        console.log(`Khởi tạo thành công profile và inventory cho user: ${email}`);
    } catch (error) {
        console.error("DynamoDB BatchWrite error:", error);
        throw new Error("Failed to initialize user data in DynamoDB.");
    }
    try {
        await refreshDaily(userId, profileItem);
        console.log(`Khởi tạo daily quest cho user: ${email}`);
    } catch (error) {
        console.error("Lỗi khởi tạo daily quest:", error);
    }

    return event;
};

const handleUpdateProfile = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");
    try {
        const body = JSON.parse(event.body || "{}");
        const { name } = body;
        if (!name || typeof name !== "string" || name.trim().length === 0) {
            return await syncedErrorResponse(getUserId(event), 400, "name không hợp lệ");
        }
        const now = Date.now();
        const updateResult = await docClient.send(
            new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
                UpdateExpression: "SET information.#name = :name, updatedAt = :now",
                ExpressionAttributeNames: { "#name": "name" },
                ExpressionAttributeValues: {
                    ":name": name.trim(),
                    ":now": now,
                },
                ReturnValues: "ALL_NEW"
            })
        );
        let updatedProfile = updateResult.Attributes;
        updatedProfile = await mapCosmeticAssets(updatedProfile);
        return successResponse({
            success: true,
            message: "Cập nhật tên thành công",
            profile: updatedProfile,
        });
    } catch (error) {
        console.error("Lỗi cập nhật profile:", error);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

const handleEquipCosmetics = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { backgroundId, frameId, titles, petId } = body;

        if (!backgroundId) {
            return await syncedErrorResponse(getUserId(event), 400, "backgroundId là bắt buộc");
        }
        if (titles && titles.length > 3) {
            return await syncedErrorResponse(getUserId(event), 400, "Chỉ được trang bị tối đa 3 danh hiệu");
        }

        // Xây danh sách các SK cần kiểm tra sở hữu
        const defaultCosmeticIds = new Set(["frame_none", "title_none"]);
        const itemsToCheck = [{ PK: userId, SK: backgroundId }];
        if (frameId && !defaultCosmeticIds.has(frameId)) itemsToCheck.push({ PK: userId, SK: frameId });
        if (titles && titles.length > 0) {
            for (const t of titles) {
                if (!defaultCosmeticIds.has(t)) itemsToCheck.push({ PK: userId, SK: t });
            }
        }
        if (petId && !defaultCosmeticIds.has(petId)) itemsToCheck.push({ PK: userId, SK: petId });

        // BatchGetItem để kiểm tra sở hữu
        const batchResult = await docClient.send(
            new BatchGetCommand({
                RequestItems: {
                    [process.env.INVENTORY_TABLE]: {
                        Keys: itemsToCheck,
                        ProjectionExpression: "SK",
                    },
                },
            })
        );

        const ownedSet = new Set(
            (batchResult.Responses?.[process.env.INVENTORY_TABLE] || []).map((i) => i.SK)
        );
        defaultCosmeticIds.forEach((id) => ownedSet.add(id));

        if (!ownedSet.has(backgroundId)) {
            return await syncedErrorResponse(getUserId(event), 403, "Bạn không sở hữu Background này");
        }
        if (frameId && !ownedSet.has(frameId)) {
            return await syncedErrorResponse(getUserId(event), 403, "Bạn không sở hữu Frame này");
        }
        if (titles) {
            for (const t of titles) {
                if (!ownedSet.has(t)) {
                    return await syncedErrorResponse(getUserId(event), 403, `Bạn không sở hữu danh hiệu: ${t}`);
                }
            }
        }
        if (petId && !ownedSet.has(petId)) {
            return await syncedErrorResponse(getUserId(event), 403, "Bạn không sở hữu Pet này");
        }

        const now = Date.now();
        await docClient.send(
            new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
                UpdateExpression:
                    "SET equippedCosmetics.equippedBackground = :bg, " +
                    "equippedCosmetics.equippedFrame = :frame, " +
                    "equippedCosmetics.equippedTitles = :titles, " +
                    "equippedCosmetics.equippedPet = :pet, " +
                    "updatedAt = :now",
                ExpressionAttributeValues: {
                    ":bg": backgroundId,
                    ":frame": frameId ?? null,
                    ":titles": titles ?? [],
                    ":pet": petId ?? null,
                    ":now": now,
                },
            })
        );
        const result = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
            })
        );
        let updatedProfile = result.Item;
        updatedProfile = await mapCosmeticAssets(updatedProfile);

        return successResponse({
            success: true,
            message: "Thay đổi trang bị thành công",
            profile: updatedProfile,
        });
    } catch (error) {
        console.error("Lỗi trang bị đồ:", error);
        return await syncedErrorResponse(getUserId(event), 500, "Lỗi máy chủ nội bộ");
    }
};

const handleUploadAvatar = async (event) => {
    const userId = getUserId(event);
    if (!userId) return await syncedErrorResponse(getUserId(event), 401, "Unauthorized");

    try {
        const body = JSON.parse(event.body || "{}");
        const { imageBody, contentType } = body;

        if (!imageBody || !contentType) {
            return await syncedErrorResponse(userId, 400, "Thiếu dữ liệu ảnh");
        }

        const now = Date.now();

        // 1. Lấy profile để kiểm tra tiền
        const profileResult = await docClient.send(
            new GetCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
            })
        );
        let currentProfile = profileResult.Item;

        if (!currentProfile) {
            return await syncedErrorResponse(userId, 404, "Không tìm thấy người dùng");
        }

        // 2. Nếu KHÔNG ĐỦ TIỀN -> Trả về profile hiện tại để frontend đồng bộ
        if (currentProfile.budget.eCoin < 500) {
            currentProfile = await mapCosmeticAssets(currentProfile);
            return successResponse({
                success: false,
                message: "Không đủ 500 eCoin",
                profile: currentProfile // Vẫn trả về để frontend chạy ingestServerData
            });
        }

        // 3. ĐỦ TIỀN -> Bắt đầu Upload lên S3
        const extension = contentType === 'image/png' ? 'png' : 'jpg'; // Chuẩn hóa extension
        const s3KeyPath = `public-assets/avatars/${userId}.${extension}`;

        const buffer = Buffer.from(imageBody, 'base64');

        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.ASSETS_BUCKET,
            Key: s3KeyPath,
            Body: buffer,
            ContentType: contentType,
            // CacheControl: "max-age=31536000" // Có thể thêm nếu muốn trình duyệt cache lâu
        }));

        // 4. Trừ tiền và cập nhật URL trong DynamoDB
        // Thêm timestamp vào đuôi URL để ép Frontend + Trình duyệt load lại ảnh (Bypass cache)
        const updatedAvatarUrl = `avatars/${userId}.${extension}?t=${now}`;

        const updateResult = await docClient.send(
            new UpdateCommand({
                TableName: process.env.USER_TABLE,
                Key: { PK: userId },
                UpdateExpression: "SET budget.eCoin = budget.eCoin - :cost, information.avatarUrl = :avatarUrl, avatarUpdatedAt = :now, updatedAt = :now",
                // Đảm bảo không bị race-condition (trừ âm tiền) bằng ConditionExpression
                ConditionExpression: "budget.eCoin >= :cost",
                ExpressionAttributeValues: {
                    ":cost": 500,
                    ":avatarUrl": updatedAvatarUrl,
                    ":now": now
                },
                ReturnValues: "ALL_NEW"
            })
        );

        let updatedProfile = updateResult.Attributes;
        updatedProfile = await mapCosmeticAssets(updatedProfile);

        // 5. Trả về thành công
        return successResponse({
            success: true,
            message: "Cập nhật ảnh đại diện thành công",
            profile: updatedProfile,
        });

    } catch (error) {
        console.error("Lỗi upload avatar:", error);
        // Bắt lỗi ConditionExpression (nếu user click liên tục 2 lần)
        if (error.name === "ConditionalCheckFailedException") {
            return await syncedErrorResponse(userId, 400, "Không đủ eCoin hoặc giao dịch quá nhanh.");
        }
        return await syncedErrorResponse(userId, 500, "Lỗi máy chủ nội bộ");
    }
};

export {
    handleInitUser,
    handleUpdateProfile,
    handleEquipCosmetics,
    handleUploadAvatar,
}