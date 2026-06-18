import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

const processJson = async (event) => {
    try {
        const bucketName = event.Records[0].s3.bucket.name;
        const jsonKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));

        console.log(`Đang xử lý file Config: ${jsonKey}`);

        // 1. SMART ROUTER: Xác định Table đích dựa vào tên thư mục
        let targetTable = null;
        if (jsonKey.startsWith('uploads/levels/')) {
            targetTable = process.env.MINIGAME_TABLE;
        } else if (jsonKey.startsWith('uploads/quests/')) {
            targetTable = process.env.QUEST_TABLE;
        }

        // Báo lỗi ngay nếu file rơi vào thư mục không hợp lệ
        if (!targetTable) {
            throw new Error(`Không xác định được Table cho đường dẫn: ${jsonKey}`);
        }

        // 2. Kéo JSON từ S3
        const s3Object = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: jsonKey }));
        const jsonString = await s3Object.Body.transformToString();
        const configData = JSON.parse(jsonString);

        // 3. Ghi vào đúng Database đã được định tuyến
        await docClient.send(new PutCommand({
            TableName: targetTable,
            Item: configData
        }));

        console.log(`Xong! Đã lưu ${configData.SK} vào bảng ${targetTable}`);
        return { statusCode: 200, body: 'Success' };
    } catch (error) {
        console.error("Lỗi xử lý file JSON:", error);
        throw error;
    }
};

export { processJson };