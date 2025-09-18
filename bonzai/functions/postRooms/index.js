import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { sendResponse } from "../responses";
import { badRequest, serverError } from "../responses/errors";
import { client } from "../../services/db";

// Försöker lägga till rum i tabellen
export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body ?? "[]");

    // Validerar att body är en array med rum och inte tom
    if (!Array.isArray(body) || body.length === 0)
      return badRequest("Bodyn måste vara en array med rum");

    // Kontrollerar att varje rum har alla nödvändiga fält
    for (const r of body) {
      for (const key of [
        "roomNo",
        "roomName",
        "roomType",
        "guestsAllowed",
        "price",
        "isAvailable",
      ]) {
        if (r[key] === undefined) {
          return badRequest(`Fält saknas på roomNo ${r?.roomNo}: ${key}`);
        }
      }
    }

    const now = new Date().toISOString();

    // Försöker lägga till varje rum, hoppar över om det redan finns (baserat på pk+sk)
    for (const room of body) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: "bonzai-table",
            Item: {
              pk: { S: "ROOM" },
              sk: { S: `ROOM#${room.roomNo.toString()}` },
              roomNo: { N: room.roomNo.toString() },
              roomName: { S: room.roomName },
              roomType: { S: room.roomType },
              guestsAllowed: { N: room.guestsAllowed.toString() },
              price: { N: room.price.toString() },
              isAvailable: { BOOL: !!room.isAvailable },
              createdAt: { S: now },
              modifiedAt: { S: now },
            },
            // Förhindrar att skriva över ett rum som redan finns
            ConditionExpression:
              "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          })
        );
      } catch (err) {
        // Om rummet redan finns (baserat på pk+sk) hoppar vi över det
        if (err.name === "ConditionalCheckFailedException") {
          console.log(`Rum ${room.roomNo} finns redan – hoppar över.`);
        } else {
          throw err; 
        }
      }
    }

    // Svar när alla rum lagts till eller hoppats över
    return sendResponse(201, {
      msg: "Rum tillagda",
    });
  } catch (error) {
    return serverError();
  }
};
