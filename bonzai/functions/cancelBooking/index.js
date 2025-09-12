import { sendResponse } from "../responses";
import { client } from "../../services/db";

export const handler = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify(
      { message: "Serverless v3 with ES Modules is working 🚀" },
      null,
      2
    ),
  };
};
