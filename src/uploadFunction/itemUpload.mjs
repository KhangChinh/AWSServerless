import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import AdmZip from 'adm-zip';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

const streamToBuffer = async (stream) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
};

const processZip = async (event) => {
    try {
        const bucketName = event.Records[0].s3.bucket.name;
        const zipKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));

        console.log(`Đang xử lý Item ZIP: ${zipKey}`);

        // Tải và bung ZIP
        const getObjCmd = new GetObjectCommand({ Bucket: bucketName, Key: zipKey });
        const s3Object = await s3.send(getObjCmd);
        const zipBuffer = await streamToBuffer(s3Object.Body);
        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();

        // Đọc data.json
        const jsonEntry = zipEntries.find(e => e.entryName === 'data.json');
        if (!jsonEntry) throw new Error("Thiếu data.json trong file ZIP");

        // Chuyển buffer thành chuỗi
        let jsonString = jsonEntry.getData().toString('utf8');

        // Loại bỏ ký tự BOM ( \uFEFF ) nếu có ở đầu chuỗi
        if (jsonString.charCodeAt(0) === 0xFEFF) {
            jsonString = jsonString.slice(1);
        }

        // Parse dữ liệu an toàn
        let itemData = JSON.parse(jsonString);
        const { itemType, SK: itemId } = itemData;
        itemData.assets = {};

        // Phân loại và upload tài nguyên
        for (const entry of zipEntries) {
            if (entry.isDirectory || entry.entryName === 'data.json') continue;

            const filePath = entry.entryName;
            const extension = filePath.split('.').pop().toLowerCase();
            const s3UploadKey = `public-assets/items/${itemType}/${itemId}/${filePath}`;
            const relativeUrl = `${itemType}/${itemId}/${filePath}`;

            // Xác định Content-Type chuẩn xác
            let contentType = 'application/octet-stream';
            if (extension === 'css') contentType = 'text/css';
            else if (['png', 'jpg', 'jpeg'].includes(extension)) contentType = `image/${extension === 'jpg' ? 'jpeg' : extension}`;
            else if (extension === 'json') contentType = 'application/json';
            else if (['mp3', 'wav'].includes(extension)) contentType = `audio/${extension === 'mp3' ? 'mpeg' : 'wav'}`;

            // Up lên S3
            await s3.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: s3UploadKey,
                Body: entry.getData(),
                ContentType: contentType
            }));

            // Map URL vào JSON
            if (!filePath.includes('/')) {
                if (['png', 'jpg', 'jpeg'].includes(extension)) itemData.imageUrl = relativeUrl;
            } else if (filePath.startsWith('assets/')) {
                if (extension === 'css') itemData.assets.css = relativeUrl;
                if (['mp3', 'wav'].includes(extension)) itemData.assets.bgm = relativeUrl;
                if (extension === 'json') itemData.assets.particles = relativeUrl;
            }
        }

        // Ghi vào Database
        await docClient.send(new PutCommand({
            TableName: process.env.ITEMDATA_TABLE,
            Item: itemData
        }));

        console.log(`Xong Item: ${itemId}`);
        return { statusCode: 200, body: 'Success' };
    } catch (error) {
        console.error("Lỗi xử lý file ZIP:", error);
        throw error;
    }
};

export { processZip };