import { BatchWriteCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";

const USER_TABLE = process.env.USER_TABLE;
const INVENTORY_TABLE = process.env.INVENTORY_TABLE;
const ITEM_DATA_TABLE = process.env.ITEMDATA_TABLE; // Bảng chứa dữ liệu vật phẩm gốc

export const handleInitUser = async (event) => {
    const userId = event.request.userAttributes.sub;
    const { email, name } = event.request.userAttributes;
    const now = Date.now();
    const DEFAULT_AVATAR_URL = process.env.DEFAULT_AVATAR_URL;

    try {
        // 1. Lấy dữ liệu 2 theme mặc định từ bảng ItemData
        const getItemsResult = await docClient.send(new BatchGetCommand({
            RequestItems: {
                [ITEM_DATA_TABLE]: {
                    Keys: [
                        { PK: "item", SK: "default_light" },
                        { PK: "item", SK: "default_dark" }
                    ]
                }
            }
        }));

        const masterItems = getItemsResult.Responses[ITEM_DATA_TABLE] || [];

        // Tạo fallback an toàn phòng trường hợp DB chưa có data item
        const lightThemeData = masterItems.find(item => item.SK === "default_light") || {
            rarity: "3", name: "Theme Sáng Mặc Định", imageUrl: "", assets: {}
        };
        const darkThemeData = masterItems.find(item => item.SK === "default_dark") || {
            rarity: "3", name: "Theme Tối Mặc Định", imageUrl: "", assets: {}
        };

        // 2. Khởi tạo Profile (Lưu vào bảng User)
        const profileItem = {
            PK: userId,
            SK: "profile",
            information: {
                name: name || "N/A",
                email: email,
                avatarUrl: DEFAULT_AVATAR_URL
            },
            budget: { knowledgePoint: 0, knowledgeCore: 0, sanity: 0, eCoin: 0 },
            studyStats: { rankScore: 0, timeToStreak: 30, streak: 0, lastFocusDate: null },
            gachaStats: { pity4Star: 0, pity5Star: 0, is4StarGuaranteed: false, is5StarGuaranteed: false },
            equippedCosmetics: { equippedTheme: "default_light", equippedFrame: null, equippedTitles: [] },
            inventoryUpdatedAt: now,
            gachaHistoryUpdatedAt: now,
            friendUpdatedAt: now,
            avatarUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
        };

        // 3. Khởi tạo Inventory dựa trên Master Data (Lưu vào bảng Inventory)
        const defaultLightItem = {
            PK: userId,
            SK: "default_light",
            rarity: lightThemeData.rarity,
            name: lightThemeData.name,
            imageUrl: lightThemeData.imageUrl,
            itemType: "theme",
            collectFrom: "system",
            assets: lightThemeData.assets, // Có thể có hoặc không tùy vào việc inventory của bạn có lưu kèm asset không
            acquiredAt: now
        };

        const defaultDarkItem = {
            PK: userId,
            SK: "default_dark",
            rarity: darkThemeData.rarity,
            name: darkThemeData.name,
            imageUrl: darkThemeData.imageUrl,
            itemType: "theme",
            collectFrom: "system",
            assets: darkThemeData.assets,
            acquiredAt: now
        };

        // 4. Thực thi ghi dữ liệu đồng thời vào 2 bảng
        const params = {
            RequestItems: {
                [USER_TABLE]: [
                    { PutRequest: { Item: profileItem } }
                ],
                [INVENTORY_TABLE]: [
                    { PutRequest: { Item: defaultLightItem } },
                    { PutRequest: { Item: defaultDarkItem } }
                ]
            }
        };

        await docClient.send(new BatchWriteCommand(params));
        console.log(`Successfully initialized profile and inventory for user: ${email}`);

    } catch (error) {
        console.error("Lỗi khởi tạo dữ liệu người dùng:", error);
        throw new Error("Failed to initialize user data.");
    }

    return event;
};