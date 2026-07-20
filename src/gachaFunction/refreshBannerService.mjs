import { PutCommand, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { getCachedMasterData } from "../cacheHelper.mjs";

// 1. KHAI BÁO CẤU HÌNH CÁC BANNER TẠI ĐÂY
const BANNER_CONFIGS = [
    {
        bannerId: "banner_background",
        bannerName: "Banner Hình Nền Thường Nhật",
        itemType: "background",
        durationDays: 1,
        rates: { base5Star: 0.01, base4Star: 0.09, pity5StarLimit: 80, pity4StarLimit: 10, rateUpChance: 0.5 }
    },
    {
        bannerId: "banner_frame",
        bannerName: "Banner Khung Đại Diện",
        itemType: "frame",
        durationDays: 3,
        rates: { base5Star: 0.01, base4Star: 0.09, pity5StarLimit: 80, pity4StarLimit: 10, rateUpChance: 0.5 }
    },
    {
        bannerId: "banner_title",
        bannerName: "Banner Trang trí Tiêu Đề",
        itemType: "title",
        durationDays: 1,
        rates: { base5Star: 0.01, base4Star: 0.09, pity5StarLimit: 80, pity4StarLimit: 10, rateUpChance: 0.75 }
    },
    {
        bannerId: "banner_pet",
        bannerName: "Banner Thú cưng",
        itemType: "pet",
        durationDays: 7,
        rates: { base5Star: 0.01, base4Star: 0.09, pity5StarLimit: 80, pity4StarLimit: 10, rateUpChance: 0.5 }
    },
];

const shuffleArray = (array) => [...array].sort(() => 0.5 - Math.random());

export const handleRefreshBanners = async (event) => {
    try {
        console.log("Bắt đầu tiến trình quét và làm mới hệ thống Banners...");
        const nowSeconds = Math.floor(Date.now() / 1000);
        let allItems = null;
        for (const config of BANNER_CONFIGS) {
            console.log(`Đang kiểm tra banner: ${config.bannerId}...`);
            // 2. Kéo data banner hiện tại xem đã đến lúc refresh chưa
            const existingBannerRes = await docClient.send(new GetCommand({
                TableName: process.env.ITEMDATA_TABLE,
                Key: { PK: "gacha", SK: config.bannerId }
            }));
            const existingBanner = existingBannerRes.Item;
            // Nếu banner vẫn còn hạn (tính theo giây) -> Bỏ qua, không làm mới
            if (existingBanner && existingBanner.expiresAt && existingBanner.expiresAt > nowSeconds) {
                console.log(`-> Banner ${config.bannerId} vẫn còn hạn đến timestamp ${existingBanner.expiresAt}. Bỏ qua.`);
                continue;
            }
            // 3. Nếu cần refresh, fetch MasterData (chỉ fetch 1 lần cho tất cả các banner cần làm mới)
            if (!allItems) {
                console.log("-> Đang kéo Master Data để tạo pool mới...");
                allItems = await getCachedMasterData(async () => {
                    const result = await docClient.send(new QueryCommand({
                        TableName: process.env.ITEMDATA_TABLE,
                        KeyConditionExpression: "PK = :pk",
                        ExpressionAttributeValues: { ":pk": "item" }
                    }));
                    return result.Items || [];
                });
            }
            // 4. Lọc Pool theo itemType của cấu hình hiện tại
            const gachaPool = allItems.filter(item => item.itemType === config.itemType && item.collectFrom === "gacha");
            const poolLimited5 = gachaPool.filter(i => i.rarity === 5 && i.isLimited === true);
            const poolLimited4 = gachaPool.filter(i => i.rarity === 4 && i.isLimited === true);
            const poolStandard5 = gachaPool.filter(i => i.rarity === 5 && i.isLimited === false);
            const poolStandard4 = gachaPool.filter(i => i.rarity === 4 && i.isLimited === false);
            // 5. Bốc ngẫu nhiên Rate Up
            const rateUp5 = poolLimited5.length > 0 ? shuffleArray(poolLimited5).slice(0, 1) : poolStandard5.slice(0, 1);
            const rateUp4 = poolLimited4.length > 0 ? shuffleArray(poolLimited4).slice(0, 3) : poolStandard4.slice(0, 3);
            // 6. Tính thời gian hết hạn mới dựa theo durationDays
            const nextExpire = new Date();
            nextExpire.setUTCDate(nextExpire.getUTCDate() + config.durationDays);
            nextExpire.setUTCHours(0, 0, 0, 0); // Đưa về 0h00 UTC của ngày hết hạn
            const expiresAt = Math.floor(nextExpire.getTime() / 1000);
            // 7. Tạo Object JSON và ghi đè
            const bannerData = {
                PK: "gacha",
                SK: config.bannerId,
                bannerName: config.bannerName,
                itemType: config.itemType,
                durationDays: config.durationDays,
                rates: config.rates,
                pool: {
                    rateUp5: rateUp5,
                    rateUp4: rateUp4,
                    standard5: poolStandard5,
                    standard4: poolStandard4
                },
                expiresAt: expiresAt,
                updatedAt: nowSeconds
            };
            console.log(JSON.stringify(bannerData, null, 2));
            await docClient.send(new PutCommand({
                TableName: process.env.ITEMDATA_TABLE,
                Item: bannerData
            }));
            console.log(`-> Refresh thành công banner: ${config.bannerId}. Hạn mới: ${expiresAt}`);
        }
        console.log("Hoàn tất tiến trình quét Banners!");
        return { success: true };
    } catch (error) {
        console.error("Lỗi khi refresh Banners:", error);
        throw error;
    }
};