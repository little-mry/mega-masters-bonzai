import { client } from "../../services/db.js";
import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { nanoid } from "nanoid";
import { enumerateNights } from "../../helpers/helpers.js";
import { tryBookRoom } from "./service.js";
import { sendResponse } from "../responses/index.js";
import { badRequest, serverError, conflict } from "../responses/errors.js";

const TABLE = "bonzai-table";
const ALLOWED_TYPES = ["single", "double", "suite"];

// Kolla om ett specifikt rum är ledigt för alla nätter i intervallet
async function isRoomFree(roomNoStr, nights) {
  if (!nights.length) return true;
  const from = nights[0];
  const to = nights[nights.length - 1];

  const { Items } = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": { S: `ROOM#${roomNoStr}` },
        ":from": { S: `DATE#${from}` },
        ":to": { S: `DATE#${to}` },
      },
      Limit: 1,
    })
  );

  // Finns minst en rad i intervallet → rummet är upptaget någon natt
  return !(Items && Items.length > 0);
}

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body ?? "{}");
    const { rooms, guests, checkIn, checkOut, email, note, name } = body;

    // 1) Grundvalidering
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

    // 2) Summera önskade rumstyper
    const wanted = { single: 0, double: 0, suite: 0 };
    for (const t of rooms) {
      const k = String(t).toLowerCase();
      if (!ALLOWED_TYPES.includes(k)) {
        return badRequest(`Ogiltig room type: ${t}`);
      }
      wanted[k]++;
    }

    // 3) Hämta alla rum (pk = "ROOM")
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

    // 4) Välj lediga rum per typ (kolla även datumlås)
    const pickRooms = async (type, count) => {
      if (count <= 0) return [];
      const list = [];
      for (const r of allRooms) {
        if (list.length === count) break;
        const available = r.isAvailable?.BOOL !== false;
        const rType = String(r.roomType?.S || "").toLowerCase();
        if (!available || rType !== type) continue;

        const roomNoStr = r.roomNo?.N;
        if (!roomNoStr) continue;

        const free = await isRoomFree(roomNoStr, nights);
        if (free) list.push(r);
      }
      return list;
    };

    const chosen = [
      ...(await pickRooms("single", wanted.single)),
      ...(await pickRooms("double", wanted.double)),
      ...(await pickRooms("suite", wanted.suite)),
    ];

    if (chosen.length !== rooms.length) {
      return conflict("Det finns inte tillräckligt många lediga rum av vald kombination.");
    }

    // 5) Kapacitetskontroll
    const totalCapacity = chosen.reduce((sum, r) => sum + Number(r.guestsAllowed?.N ?? "0"), 0);
    if (totalCapacity < wantedGuests) {
      return conflict(
        `Vald kombination rymmer totalt ${totalCapacity} gäster, men ${wantedGuests} efterfrågas.`
      );
    }

    // 6) Boka rum(en) atomiskt
    const bookingId = nanoid();
    const payload = { checkIn, checkOut, guests: wantedGuests, email, note, name };

    try {
      const result = await tryBookRoom({
        rooms: chosen,
        nights,
        bookingId,
        payload,
      });
      return sendResponse(201, result);
    } catch (err) {
      if (err?.name === "TransactionCanceledException") {
        console.error("TransactionCanceled:", err.CancellationReasons);
        return conflict(`Tyvärr är det fullbokat för vald rumstyp under perioden ${checkIn}–${checkOut}.`);
      }
      console.error("booking error:", err);
      return serverError();
    }
  } catch (err) {
    console.error("createBooking handler error:", err);
    return serverError();
  }
};
