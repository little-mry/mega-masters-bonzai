import { sendResponse } from "../responses/index.js";
import { serverError } from "../responses/errors.js";
import rooms from "../../data/rooms.json" assert { type: "json" };
// import { client } from "../../services/db"; // Behövs först när ni använder DynamoDB

export const handler = async (event) => {
  try {
    return sendResponse(200, { rooms });
  } catch (error) {
    console.error("Error fetching rooms:", error);
    return serverError();
  }
};
// Notera: Eftersom vi inte använder DynamoDB i denna funktion, är importen av 'client' kommenterad. Den kan tas bort om den inte behövs.git