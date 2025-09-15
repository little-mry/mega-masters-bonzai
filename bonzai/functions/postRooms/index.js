import { sendResponse } from "../responses";
import { client } from "../../services/db";

export const handler = async (event) => {
 return sendResponse(200, {msg: "Success!!!"})
};
