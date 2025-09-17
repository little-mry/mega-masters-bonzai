import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { client } from "../../services/db.js";
import { sendResponse } from "../responses/index.js";
import { notFound, conflict, serverError } from "../responses/errors.js";
import { getBookingById } from "../../helpers/bookings.js";
const TABLE = "bonzai-table";

export const handler = async (event) => {
  try {
    // Hämta bookingId från url:en
    const bookingId = event.pathParameters?.id;
    if (!bookingId) return notFound("Ingen bookingId angiven.");

    // Hämta alla rader (CONFIRMATION + LINE# + DATE#) som hör till bokningen
    const items = await getBookingById(bookingId);

    // Om ingen bokning hittades
    if (items.length === 0) {
      return notFound("Ingen bokning hittades.");
    }

    const confirmation = Items.find((i) => i.sk.S === "CONFIRMATION");
    if (!confirmation) {
      return notFound("Bokningens confirmationpost saknas.");
    }

    // Kontrollera att avbokning sker minst 48h innan check-in
    const checkIn = new Date(confirmation.checkIn.S);
    const now = new Date();
    const diffHours = (checkIn - now) / (1000 * 60 * 60);
    if (diffHours < 48) {
      return conflict("Avbokning måste ske minst 48h innan incheckning.");
    }

    // Hämta alla rums-lås (DATE#) och alla LINE#-rader som hör till bokningen
    const roomLocks = Items.filter((i) => i.sk.S.startsWith("DATE#"));
    const lineItems = Items.filter((i) => i.sk.S.startsWith("LINE#"));

    // Här bygger vi en lista med alla transaktioner som ska köras
    const TransactItems = [];

    // Uppdatera bokningens status till CANCELLED
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
    // Ta bort alla roomLocks (låsta datum för rummen)
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
    // Ta bort alla LINE#-poster (radposter för rumstyper)
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

    // Kör allt i en TransactWrite (alla ändringar på en gång)
    await client.send(
      new TransactWriteItemsCommand({
        TransactItems,
      })
    );

    // Skicka svar om att avbokningen lyckades
    return sendResponse(200, {
      msg: `Booking ${bookingId} avbokad.`,
      cancelledRooms: roomLocks.length,
      removedLines: lineItems.length,
    });
  } catch (err) {
    // Vid fel logga och skicka serverError
    console.error("cancelBooking error:", err);
    return serverError("Kunde inte avboka.");
  }
};
