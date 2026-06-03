import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../database.mjs";
import { successResponse, errorResponse } from "../response.mjs";

const handleGetUser = async (event) => {
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub || authorizer?.claims?.sub;

    if (!userId) {
        return errorResponse(401, "Unauthorized");
    }

    try {
        const result = await docClient.send(new GetCommand({
            TableName: process.env.TABLE_NAME,
            Key: {
                PK: `usr_${userId}`,
                SK: "profile"
            }
        }));

        if (result.Item) {
            return successResponse({ data: result.Item });
        } else {
            return errorResponse(404, "Không tìm thấy user");
        }
    } catch (error) {
        console.error("Lỗi đọc DynamoDB:", error);
        return errorResponse(500, "Lỗi máy chủ nội bộ");
    }
};

const handleInitUser = async (event) => {
    console.log("Cognito PostConfirmation Event:", JSON.stringify(event, null, 2));

    const userId = event.request.userAttributes.sub;
    const { email, name } = event.request.userAttributes;

    const params = {
        TableName: process.env.TABLE_NAME,
        Item: {
            PK: `usr_${userId}`,
            SK: "profile",
            information: {
                email: email,
                name: name || "N/A",
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        },
    };

    try {
        await docClient.send(new PutCommand(params));
        console.log(`Successfully created DB record for user: ${email}`);
    } catch (error) {
        console.error("DynamoDB error:", error);
    }

    return event;
};

export {
    handleGetUser,
    handleInitUser
};