import { QueryCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { client } from "../../services/db.js";
import { sendResponse } from "../responses/index.js";
import { notFound, conflict, serverError } from "../responses/errors.js";

const TABLE = "bonzai-table";

export const handler = async (event) => {
  try {
    const bookingId = event.pathParameters?.id;
    if (!bookingId) return notFound("Ingen bookingId angiven.");

    // 1) Hämta alla items för bokningen
    const { Items } = await client.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: `BOOKING#${bookingId}` } },
      })
    );

    if (!Items || Items.length === 0) {
      return notFound("Bokningen hittades inte.");
    }

    const confirmation = Items.find((i) => i.sk.S === "CONFIRMATION");
    if (!confirmation) {
      return notFound("Bokningens confirmationpost saknas.");
    }

    // 2) Kolla 48h-regeln
    const checkIn = new Date(confirmation.checkIn.S);
    const now = new Date();
    const diffHours = (checkIn - now) / (1000 * 60 * 60);
    if (diffHours < 48) {
      return conflict("Avbokning måste ske minst 48h innan incheckning.");
    }

    // 3) Identifiera alla rader som hör till bokningen
    const roomLocks = Items.filter((i) => i.sk.S.startsWith("DATE#"));
    const lineItems = Items.filter((i) => i.sk.S.startsWith("LINE#"));

    // 4) Bygg transaktion: Update + Delete
    const TransactItems = [];

    // Uppdatera CONFIRMATION till CANCELLED
    TransactItems.push({
      Update: {
        TableName: TABLE,
        Key: {
          pk: { S: `BOOKING#${bookingId}` },
          sk: { S: "CONFIRMATION" },
        },
        UpdateExpression: "SET #status = :cancelled, modifiedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":cancelled": { S: "CANCELLED" },
          ":now": { S: new Date().toISOString() },
        },
      },
    });

    // Ta bort alla ROOM#... / DATE#...-lås
    for (const lock of roomLocks) {
      TransactItems.push({
        Delete: {
          TableName: TABLE,
          Key: {
            pk: lock.pk,
            sk: lock.sk,
          },
        },
      });
    }

    // Ta bort alla LINE#-rader
    for (const line of lineItems) {
      TransactItems.push({
        Delete: {
          TableName: TABLE,
          Key: {
            pk: line.pk,
            sk: line.sk,
          },
        },
      });
    }

    // 5) Kör transaktionen
    await client.send(
      new TransactWriteItemsCommand({
        TransactItems,
      })
    );

    return sendResponse(200, {
      msg: `Booking ${bookingId} avbokad.`,
      cancelledRooms: roomLocks.length,
      removedLines: lineItems.length,
    });
  } catch (err) {
    console.error("cancelBooking error:", err);
    return serverError("Kunde inte avboka.");
  }
};
