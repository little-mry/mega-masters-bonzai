import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { sendResponse } from "../responses";
import { badRequest, serverError } from "../responses/errors";
import { client } from "../../services/db";

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body ?? "[]");
    if (!Array.isArray(body) || body.length === 0)
      return badRequest("Bodyn måste vara en array med rum");

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
            ConditionExpression:
              "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          })
        );
      } catch (err) {
        if (err.name === "ConditionalCheckFailedException") {
          console.log(`Rum ${room.roomNo} finns redan – hoppar över.`);
        } else {
          throw err;
        }
      }
    }

    return sendResponse(201, {
      msg: "Rum tillagda",
    });
  } catch (error) {
    return serverError();
  }
};
