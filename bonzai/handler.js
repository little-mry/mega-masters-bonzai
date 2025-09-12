// handler.js
export const hello = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify(
      { message: "Serverless v3 with ES Modules is working 🚀" },
      null,
      2
    ),
  };
};
