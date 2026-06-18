import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

const processJson = async (event) => {
    try {
        const bucketName = event.Records[0].s3.bucket.name;
        const jsonKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));

        console.log(`Đang xử lý Game Level: ${jsonKey}`);

        // Kéo JSON từ S3
        const s3Object = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: jsonKey }));
        const jsonString = await s3Object.Body.transformToString();
        const levelData = JSON.parse(jsonString);

        // Ghi vào Database
        await docClient.send(new PutCommand({
            TableName: process.env.MINIGAME_TABLE,
            Item: levelData
        }));

        console.log(`Xong Level: ${levelData.SK}`);
        return { statusCode: 200, body: 'Success' };
    } catch (error) {
        console.error("Lỗi xử lý file JSON:", error);
        throw error;
    }
};

export { processJson };