import { client } from "../../services/db.js";
import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { nanoid } from "nanoid";
import { enumerateNights, tryBookGroup } from "./service.js";
import { sendResponse } from "../responses/index.js";
import { badRequest, serverError, conflict } from "../responses/errors.js";

const TABLE = "bonzai-table";

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body ?? "{}");
    const { rooms, guests, checkIn, checkOut, email, note, name } = body;

    // 1) Validation
    if (!Array.isArray(rooms) || rooms.length === 0) {
      return badRequest("rooms måste vara en icke-tom array (ex: ['single','suite']).");
    }
    const wantedGuests = parseInt(guests, 10);
    if (!Number.isInteger(wantedGuests) || wantedGuests <= 0) {
      return badRequest("guests måste vara ett positivt heltal.");
    }
    if (!checkIn || !checkOut || !email || !name || !name.trim()) {
      return badRequest("guests, checkIn, checkOut, email och name krävs.");
    }

    const nights = enumerateNights(checkIn, checkOut);
    if (nights.length === 0) {
      return badRequest("Ogiltigt datumintervall (minst 1 natt).");
    }

    const allowedTypes = ["single", "double", "suite"];
    const wanted = { single: 0, double: 0, suite: 0 };
    for (const t of rooms) {
      const k = String(t).toLowerCase();
      if (!allowedTypes.includes(k)) {
        return badRequest(`Ogiltig room type: ${t}`);
      }
      wanted[k]++;
    }

    // 2) Hämta alla rum (pk = "ROOM")
    const { Items } = await client.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: "ROOM" } },
      })
    );
    const allRooms = Items ?? [];
    if (allRooms.length === 0) {
      return conflict("Inga rum finns seedade i tabellen.");
    }

    // 3) Välj första lediga rum per typ
    const pickRooms = (type, count) => {
      if (count <= 0) return [];
      const list = [];
      for (const r of allRooms) {
        const available = r.isAvailable?.BOOL !== false; // default true
        const rType = String(r.roomType?.S || "").toLowerCase();
        if (available && rType === type) {
          list.push(r);
          if (list.length === count) break;
        }
      }
      return list;
    };

    const chosen = [
      ...pickRooms("single", wanted.single),
      ...pickRooms("double", wanted.double),
      ...pickRooms("suite",  wanted.suite),
    ];

    if (chosen.length !== rooms.length) {
      return conflict("Det finns inte tillräckligt många lediga rum av vald kombination.");
    }

    // 4) Kapacitetskontroll för den valda kombon
    const totalCapacity = chosen.reduce((sum, r) => sum + Number(r.guestsAllowed?.N ?? "0"), 0);
    if (totalCapacity < wantedGuests) {
      return conflict(`Vald kombination rymmer totalt ${totalCapacity} gäster, men ${wantedGuests} efterfrågas.`);
    }

    // 5) Boka gruppen atomiskt
    const bookingId = nanoid();
    const payload = { checkIn, checkOut, guests: wantedGuests, email, note, name };

    try {
      const result = await tryBookGroup({
        rooms: chosen,    // dynamo-format från Query
        nights,
        bookingId,
        payload,
      });
      return sendResponse(201, result);
    } catch (err) {
      if (err?.name === "TransactionCanceledException") {
        return conflict(`Minst ett rum är upptaget under intervallet ${checkIn}–${checkOut}.`);
      }
      console.error("booking error:", err);
      return serverError();
    }
  } catch (err) {
    console.error("createBooking handler error:", err);
    return serverError();
  }
};
