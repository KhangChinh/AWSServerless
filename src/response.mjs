const defaultHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
};

const buildResponse = (statusCode, body) => {
    return {
        statusCode: statusCode,
        headers: defaultHeaders,
        body: JSON.stringify(body),
    };
};

const successResponse = (data = {}) => {
    return buildResponse(200, { success: true, ...data });
};

const errorResponse = (statusCode, message, data = {}) => {
    return buildResponse(statusCode, { success: false, message, ...data });
};

export { buildResponse, successResponse, errorResponse };
