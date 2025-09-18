import { sendResponse } from "../responses";
import {
  badRequest,
  serverError,
  notFound,
  conflict,
} from "../responses/errors";
import { client } from "../../services/db";
import { isIsoDate, fetchConfirmations } from "./service";
import { enumerateNights } from "../../helpers/helpers";
import { formatBooking } from "./service";
import { QueryCommand } from "@aws-sdk/client-dynamodb";

const TABLE = "bonzai-table";

export const handler = async (event) => {
  try {
    const query = event.queryStringParameters || {};
    const date = query.date?.trim();
    const from = query.from?.trim();
    const to = query.to?.trim();
    // Kollar att man angett rätt format och inte blandar date och from/to
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

    // Bestämmer om vi ska hämta ALLA, ett datum (DAY), eller ett intervall (INTERVAL)
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
          ProjectionExpression: "bookingId", // <-- finns i GSI1 Include
        })
      );

      const ids = (bookings.Items ?? [])
        .map((i) => i.bookingId?.S)
        .filter(Boolean);

      const details = await fetchConfirmations(ids);
      const items = details.map(formatBooking);
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
          ProjectionExpression: "bookingId",
        })
      );

      const ids = Array.from(
        new Set((q.Items ?? []).map((i) => i.bookingId?.S).filter(Boolean))
      );

      const details = await fetchConfirmations(ids);
      const items = details.map(formatBooking);
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
            ProjectionExpression: "bookingId",
          })
        );

        for (const i of q.Items ?? []) {
          const id = i.bookingId?.S;
          if (id) idSet.add(id);
        }
      }

      const details = await fetchConfirmations([...idSet]);
      const items = details.map(formatBooking);
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
