// Här har vi lagt getBookingById separat eftersom vi återanvänder funktionen på flera ställen i koden.
// Den hämtar en bokning (och tillhörande poster) från databasen baserat på bookingId.

import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { client } from "../services/db.js";

const TABLE = "bonzai-table";

export const getBookingById= async (bookingId) => {
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": { S: `BOOKING#${bookingId}` },
      },
    })
  );

  return (res.Items || []).map(unmarshall);
}