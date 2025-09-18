import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { sendResponse } from "../responses/index.js";
import { serverError } from "../responses/errors.js";
import { client } from "../../services/db.js";

// Hämtar alla rum från databasen och returnerar som svar.
export const handler = async (event) => {
  try {
    const result = await client.send(
      new QueryCommand({
        TableName: "bonzai-table",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": { S: "ROOM" },
        },
      })
    );

    const rooms = result.Items.map((item) => unmarshall(item));

    return sendResponse(200, { rooms });
  } catch (error) {
    console.error("Fel vid hämtning av rum:", error);
    return serverError("Fel vid hämtning av rum");
  }
};
