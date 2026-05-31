const defaultHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
};

export const buildResponse = (statusCode, body) => {
    return {
        statusCode: statusCode,
        headers: defaultHeaders,
        body: JSON.stringify(body),
    };
};

export const successResponse = (data = {}) => {
    return buildResponse(200, { success: true, ...data });
};

export const errorResponse = (statusCode, message) => {
    return buildResponse(statusCode, { success: false, message });
};