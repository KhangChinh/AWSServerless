// cacheHelper.mjs

/**
 * Tạo ra một bộ đệm (cache) tự động reset khi qua ngày mới (theo giờ UTC).
 * Dùng Closure để mỗi lần gọi createDailyCache() sẽ tạo ra một "kho" cache riêng biệt.
 *
 * Cách hoạt động:
 * - Lưu dữ liệu vào RAM của Lambda container (warm invocation).
 * - Kiểm tra nếu qua ngày mới (UTC) thì gọi lại fetchFunction để lấy dữ liệu mới.
 * - Math.floor(Date.now() / 86400000) = số ngày từ Epoch (UTC), cực kỳ nhẹ và chính xác.
 *
 * Lưu ý về Lambda:
 * - RAM: Mỗi cache lưu data trên RAM. Vài trăm item thường chỉ tốn ~50-200KB, 128MB RAM là dư dả.
 *   Nếu data game lớn (hàng chục ngàn item), nên tăng RAM Lambda lên 256MB-512MB.
 * - Concurrency: Mỗi Lambda container giữ cache riêng. Nếu AWS tạo 5 container,
 *   sẽ thấy 5 lần "Cache Miss" trên CloudWatch — đó là bình thường, không phải lỗi.
 *
 * @param {string} name - Tên cache (để phân biệt trong log CloudWatch).
 */
const createDailyCache = (name = "unknown") => {
    let cachedData = null;
    let cachedDay = null;

    /**
     * @param {Function} fetchFunction - Hàm async để lấy dữ liệu từ DB (chỉ được gọi khi cache rỗng hoặc hết hạn).
     * @returns {Promise<any>} Dữ liệu từ cache hoặc từ DB.
     */
    return async (fetchFunction) => {
        // Tính ra ID của ngày hiện tại (Số ngày trôi qua từ 1/1/1970 theo giờ UTC)
        const currentDay = Math.floor(Date.now() / 86400000);
        // Nếu đã có data và vẫn đang trong cùng 1 ngày -> Lấy từ RAM ra xài luôn
        if (cachedData !== null && cachedDay === currentDay) {
            return cachedData;
        }
        cachedData = await fetchFunction();
        cachedDay = currentDay;
        // Log kích thước data để theo dõi RAM usage trên CloudWatch
        const sizeBytes = Buffer.byteLength(JSON.stringify(cachedData), "utf8");
        const sizeKB = (sizeBytes / 1024).toFixed(1);
        const itemCount = Array.isArray(cachedData) ? cachedData.length : "N/A";
        console.log(`[${name}] Đã cache: ${itemCount} items, ~${sizeKB} KB`);
        return cachedData;
    };
};

// Khởi tạo các "kho" chứa cache.
// LƯU Ý: Phải đặt bên ngoài handler để Lambda giữ lại trên RAM giữa các lần gọi (warm invocation).
const getCachedQuests = createDailyCache("QuestData");
const getCachedMasterData = createDailyCache("MasterData");

export {
    createDailyCache,
    getCachedQuests,
    getCachedMasterData
};
