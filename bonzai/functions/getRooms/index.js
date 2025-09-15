import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { sendResponse } from "../responses/index.js";
import { serverError } from "../responses/errors.js";
import { client } from "../../services/db.js";

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

    const rooms = result.Items.map((item) => ({
      roomNo: Number(item.roomNo.N),
      roomName: item.roomName.S,
      roomType: item.roomType.S,
      guestsAllowed: Number(item.guestsAllowed.N),
      price: Number(item.price.N),
      isAvailable: item.isAvailable.BOOL,
      createdAt: item.createdAt.S,
      modifiedAt: item.modifiedAt.S,
    }));

    return sendResponse(200, { rooms });
  } catch (error) {
    console.error("Fel vid hämtning av rum:", error);
    return serverError("Fel vid hämtning av rum");
  }
};