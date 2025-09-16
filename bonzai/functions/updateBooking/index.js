import { sendResponse } from "../responses";
import { client } from "../../services/db";
import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { badRequest, serverError, conflict, notFound } from "../responses/errors.js";
/* import { enumerateNights, pickRooms, tryUpdateBooking } from "./service.js"; */

const TABLE = "bonzai-table";
const ALLOWED_TYPES = ["single", "double", "suite"];

// Hämta CONFIRMATION för att säkerställa att bokningen finns
async function getConfirmation(bookingId) {
  const { Items } = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND sk = :sk",
      ExpressionAttributeValues: {
        ":pk": { S: `BOOKING#${bookingId}` },
        ":sk": { S: "CONFIRMATION" },
      },
      Limit: 1,
    })
  );
  return (Items && Items[0]) || null;
}

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body ?? "{}");
    const { bookingId, checkIn, checkOut, guests, rooms, name, email } = body;

    // 1) Validering – enkel och strikt (vi kräver hela nya läget)
    if (!bookingId) return badRequest("bookingId krävs.");
    if (!checkIn || !checkOut) return badRequest("checkIn och checkOut krävs.");
    if (!Array.isArray(rooms) || rooms.length === 0) return badRequest("rooms måste vara en icke-tom array.");
    const g = parseInt(guests, 10);
    if (!Number.isInteger(g) || g <= 0) return badRequest("guests måste vara ett positivt heltal.");

    const nights = enumerateNights(checkIn, checkOut);
    if (nights.length === 0) return badRequest("Ogiltigt datumintervall (minst 1 natt).");

    // 2) Finns bokningen?
    const current = await getConfirmation(bookingId);
    if (!current) return notFound("Bokningen hittades inte.");

    // 3) Räkna önskade rumstyper
    const wanted = { single: 0, double: 0, suite: 0 };
    for (const t of rooms) {
      const k = String(t).toLowerCase();
      if (!ALLOWED_TYPES.includes(k)) return badRequest(`Ogiltig room type: ${t}`);
      wanted[k]++;
    }

    // 4) Hämta alla rum (pk = "ROOM")
    const { Items } = await client.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: "ROOM" } },
      })
    );
    const allRooms = Items ?? [];
    if (allRooms.length === 0) return conflict("Inga rum finns seedade i tabellen.");

    // 5) Välj nya rum per typ (ignorerar lås från samma bookingId)
    const chosen = [
      ...(await pickRooms(allRooms, "single", wanted.single, nights, bookingId)),
      ...(await pickRooms(allRooms, "double", wanted.double, nights, bookingId)),
      ...(await pickRooms(allRooms, "suite", wanted.suite, nights, bookingId)),
    ];
    if (chosen.length !== rooms.length) {
      return conflict("Det finns inte tillräckligt många lediga rum av vald kombination för de nya datumen.");
    }

    // 6) Kapacitetskontroll
    const totalCapacity = chosen.reduce((sum, r) => sum + Number(r.guestsAllowed?.N ?? "0"), 0);
    if (totalCapacity < g) {
      return conflict(`Vald kombination rymmer totalt ${totalCapacity} gäster, men ${g} efterfrågas.`);
    }

    // 7) Kör uppdatering (transaktion)
    const payload = {
      checkIn,
      checkOut,
      guests: g,
      // om name/email inte skickas, använd värden från current
      name: name ?? current.name?.S ?? "",
      email: email ?? current.email?.S ?? "",
    };

    const result = await tryUpdateBooking({
      bookingId,
      nights,
      chosenRooms: chosen,
      payload,
    });

    return sendResponse(200, result);
  } catch (err) {
    if (err?.name === "TransactionCanceledException") {
      console.error("updateBooking canceled:", err.CancellationReasons);
      return conflict("Kunde inte uppdatera bokningen – minst ett valt rum är upptaget för de nya datumen.");
    }
    console.error("updateBooking error:", err);
    return serverError();
  }
};
