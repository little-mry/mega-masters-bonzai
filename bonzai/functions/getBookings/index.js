import { sendResponse } from "../responses";
import { badRequest, serverError, notFound, conflict } from "../responses/errors";
import { client } from "../../services/db";
import { isIsoDate, fetchConfirmations } from "./service";
import { enumerateNights } from "../../helpers/helpers";
import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const TABLE = "bonzai-table";

export const handler = async (event) => {
  try {
    const query = event.queryStringParameters || {};
    const date = query.date?.trim();
    const from = query.from?.trim();
    const to = query.to?.trim();
    // Kollar att man angett rätt format och inte blandar date och from/to
    if (date && (from || to)) {
      return badRequest("Ange antingen ?date=YYYY-MM-DD ELLER ?from=YYYY-MM-DD&to=YYYY-MM-DD");
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

    // Bestämmer om vi ska hämta ALLA, ett datum (DAY), eller ett intervall (INTERVAL)
    let mode = "ALL";
    if (date) {
      mode = "DAY";
    }
    if (from && to) {
      mode = "INTERVAL";
    }

    if (mode === "ALL") {
      // Hämtar alla bokningar
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
      // Hämtar bokningar för ett specifikt datum
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
      // Plockar ut bookingId för alla bokningar den dagen
      const ids = new Set();
      for (const i of q.Items ?? []) {
        const sk = i.GSI2_SK?.S || "";
        const id = sk.split("#")[1];
        if (id) ids.add(id);
      }
      // Hämtar detaljer om bokningarna
      const details = await fetchConfirmations([...ids]);
      const items = details.map((i) => unmarshall(i));
      return sendResponse(200, { items, count: items.length, date });
    } else {
      // Hämtar bokningar för ett intervall av dagar
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
        // Samlar in bookingId för varje dag
        for (const i of q.Items ?? []) {
          const sk = i.GSI2_SK?.S || "";
          const id = sk.split("#")[1];
          if (id) idSet.add(id);
        }
      }
      // Hämtar detaljer för alla bokningar i intervallet
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
