import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { client } from "../../services/db.js";
import { sendResponse } from "../responses/index.js";
import { notFound, conflict, serverError } from "../responses/errors.js";
import { getBookingById } from "../../helpers/bookings.js";
import { enumerateNights } from "../../helpers/helpers.js";
const TABLE = "bonzai-table";

export const handler = async (event) => {
  try {
    // Hämta bookingId från url:en
    const bookingId = event.pathParameters?.id;
    if (!bookingId) return notFound("Ingen bookingId angiven.");

    // Hämta alla rader (CONFIRMATION + LINE# + DATE#) som hör till bokningen
    const items = await getBookingById(bookingId);

    // Om ingen bokning hittades
    if (!items || items.length === 0) {
      return notFound("Ingen bokning hittades.");
    }

    const confirmation = items.find((i) => i.sk === "CONFIRMATION");
    if (!confirmation) {
      return notFound("Bokningens confirmationpost saknas.");
    }
    // Kontrollerar att bokningen inte redan är avbokad
    if (confirmation.status === "CANCELLED") {
      return conflict("Denna bokning är redan avbokad");
    }

    // Kontrollera att avbokning sker minst 48h innan check-in
    const checkIn = new Date(confirmation.checkIn);
    const now = new Date();
    const diffHours = (checkIn - now) / (1000 * 60 * 60);
    if (diffHours < 48) {
      return conflict("Avbokning måste ske minst 48h innan incheckning.");
    }

    // Hitta all reververade rum + datum för dessa, för at senare kunna radera rum-lås
    const nights = enumerateNights(confirmation.checkIn, confirmation.checkOut);
    const reservedRooms = Array.isArray(confirmation.reservedRooms)
      ? confirmation.reservedRooms.map(Number)
      : [];

    if (reservedRooms.length === 0)
      return conflict(
        "Bokning saknar reserverade rum och kan inte avbokas säkert"
      );

    // Hämta alla LINE#-rader som hör till bokningen
    const lineItems = items.filter((i) => i.sk.startsWith("LINE#"));

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
        ConditionExpression:
          "attribute_not_exists(#status) OR #status <> :cancelled",
      },
    });

    // Ta bort alla roomLocks (låsta datum för rummen)
    for (const roomNo of reservedRooms) {
      const roomStr = String(roomNo);
      for (const date of nights) {
        TransactItems.push({
          Delete: {
            TableName: TABLE,
            Key: {
              pk: { S: `ROOM#${roomStr}` },
              sk: { S: `DATE#${date}` },
            },
          },
        });
      }
    }

    // Ta bort alla LINE#-poster (radposter för rumstyper)
    for (const line of lineItems) {
      TransactItems.push({
        Delete: {
          TableName: TABLE,
          Key: {
            pk: { S: String(line.pk) },
            sk: { S: String(line.sk) },
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
      cancelledRooms: reservedRooms.length,
      removedLockRows: reservedRooms.length * nights.length,
      removedLines: lineItems.length,
    });
  } catch (err) {
    // Vid fel logga och skicka serverError
    console.error("cancelBooking error:", err);
    return serverError("Kunde inte avboka.");
  }
};
