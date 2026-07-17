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

const MIME_TYPES = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', css: 'text/css', json: 'application/json',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg'
};

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

const processZip = async (event) => {
    try {
        const bucketName = event.Records[0].s3.bucket.name;
        const zipKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));

        console.log(`Đang xử lý Item ZIP: ${zipKey}`);

        const getObjCmd = new GetObjectCommand({ Bucket: bucketName, Key: zipKey });
        const s3Object = await s3.send(getObjCmd);
        const zipBuffer = await streamToBuffer(s3Object.Body);
        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();

        // Lấy data.json bằng cách kiểm tra đuôi chuỗi, bỏ qua folder ngoài
        const jsonEntry = zipEntries.find(e => e.entryName.endsWith('data.json') && !e.isDirectory);
        if (!jsonEntry) throw new Error("Thiếu data.json trong file ZIP");

        let jsonString = jsonEntry.getData().toString('utf8');
        if (jsonString.charCodeAt(0) === 0xFEFF) jsonString = jsonString.slice(1);

        let itemData = JSON.parse(jsonString);
        const { itemType, SK: itemId } = itemData;
        itemData.assets = {};

        for (const entry of zipEntries) {
            if (entry.isDirectory || entry.entryName.endsWith('data.json')) continue;

            // BỎ QUA FOLDER TỔNG: Chỉ lấy tên file và thư mục cha trực tiếp của nó
            const pathParts = entry.entryName.split('/');
            const fileName = pathParts.pop(); // VD: bunny_attack.png
            const parentDir = pathParts.pop(); // VD: assets (hoặc undefined/tên folder gốc)

            // Quy về chuẩn duy nhất: nếu nằm trong assets thì thêm assets/, còn lại vứt hết ra ngoài cùng
            const filePath = parentDir === 'assets' ? `assets/${fileName}` : fileName;

            const extension = fileName.split('.').pop().toLowerCase();
            const s3UploadKey = `public-assets/items/${itemType}/${itemId}/${filePath}`;
            const relativeUrl = `${itemType}/${itemId}/${filePath}`;

            const contentType = MIME_TYPES[extension] || 'application/octet-stream';

            // Up lên S3
            await s3.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: s3UploadKey,
                Body: entry.getData(),
                ContentType: contentType
            }));

            // Map URL vào JSON 
            if (parentDir !== 'assets') {
                if (IMAGE_EXTENSIONS.includes(extension)) {
                    itemData.imageUrl = relativeUrl;
                }
            } else {
                if (extension === 'css') {
                    itemData.assets.css = relativeUrl;
                } else {
                    const fileNameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.'));
                    const keyName = fileNameWithoutExt.includes('_') ? fileNameWithoutExt.split('_').pop() : fileNameWithoutExt;
                    itemData.assets[keyName] = relativeUrl;
                }
            }
        }

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