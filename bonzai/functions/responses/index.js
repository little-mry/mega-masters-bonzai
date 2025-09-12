export function sendResponse(statusCode, data) {
  const response = {
    statusCode: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(data, null, 2),
  };
  return response;
}
