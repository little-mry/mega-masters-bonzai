import { sendResponse } from "../responses";
import {
  badRequest,
  serverError,
  notFound,
  conflict,
} from "../responses/errors";
import { client } from "../../services/db";
import { isIsoDate, fetchConfirmations } from "./service";
import { enumerateNights } from "../createBooking/service.js";
import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const TABLE = "bonzai-table";

export const handler = async (event) => {
  try {
    const query = event.queryStringParameters || {};
    const date = query.date?.trim();
    const from = query.from?.trim();
    const to = query.to?.trim();

    if (date && (from || to)) {
      return badRequest(
        "Ange antingen ?date=YYYY-MM-DD ELLER ?from=YYYY-MM-DD&to=YYYY-MM-DD"
      );
    }
    if (date && !isIsoDate(date)) {
      return badRequest("Ogiltigt date-format, använd YYYY-MM-DD");
    }
    if ((!from && to) || (from && !to)) {
      return badRequest("Både from och to måste anges");
    }
    if (from && (!isIsoDate(from) || !isIsoDate(to))) {
      return badRequest("Ogiltigt from/to-format, använd YYYY-MM-DD");
    }
    if (from && !(from < to)) {
      return badRequest("'from' måste vara före 'to'");
    }

    let mode = "ALL";
    if (date) {
      mode = "DAY";
    }
    if (from && to) {
      mode = "INTERVAL";
    }

    if (mode === "ALL") {
      const bookings = await client.send(
        new QueryCommand({
          TableName: TABLE,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1_PK = :p",
          ExpressionAttributeValues: {
            ":p": { S: "BOOKING" },
          },
        })
      );

      const items = (bookings.Items ?? []).map((i) => unmarshall(i));
      return sendResponse(200, { items, count: items.length });
    } else if (mode === "DAY") {
      const q = await client.send(
        new QueryCommand({
          TableName: TABLE,
          IndexName: "GSI2",
          KeyConditionExpression: "GSI2_PK = :p AND begins_with(GSI2_SK, :b)",
          ExpressionAttributeValues: {
            ":p": { S: `CAL#${date}` },
            ":b": { S: "BOOKING#" },
          },
          ProjectionExpression: "GSI2_SK",
        })
      );

      const ids = new Set();
      for (const i of q.Items ?? []) {
        const sk = i.GSI2_SK?.S || "";
        const id = sk.split("#")[1];
        if (id) ids.add(id);
      }
      const details = await fetchConfirmations([...ids]);
      const items = details.map((i) => unmarshall(i));
      return sendResponse(200, { items, count: items.length, date });
    } else {
      //INTERVAL
      const idSet = new Set();

      for (const d of enumerateNights(from, to)) {
        const q = await client.send(
          new QueryCommand({
            TableName: TABLE,
            IndexName: "GSI2",
            KeyConditionExpression: "GSI2_PK = :p AND begins_with(GSI2_SK, :b)",
            ExpressionAttributeValues: {
              ":p": { S: `CAL#${d}` },
              ":b": { S: "BOOKING#" },
            },
            ProjectionExpression: "GSI2_SK",
          })
        );

        for (const i of q.Items ?? []) {
          const sk = i.GSI2_SK?.S || "";
          const id = sk.split("#")[1];
          if (id) idSet.add(id);
        }
      }
      const details = await fetchConfirmations([...idSet]);
      const items = details.map((i) => unmarshall(i));
      return sendResponse(200, {
        items,
        count: items.length,
        interval: { from, to },
      });
    }
  } catch (error) {
    console.error("getBookings error:", error);

    return serverError();
  }
};
