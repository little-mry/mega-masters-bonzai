import { client } from "../../services/db.js";
import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { nanoid } from "nanoid";
import { enumerateNights } from "../../helpers/helpers.js";
import { tryBookRoom } from "./service.js";
import { isRoomFree } from "../../helpers/availableRooms.js";
import { sendResponse } from "../responses/index.js";
import { badRequest, serverError, conflict } from "../responses/errors.js";

const TABLE = "bonzai-table";
const ALLOWED_TYPES = ["single", "double", "suite"];


export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body ?? "{}");
    const { rooms, guests, checkIn, checkOut, email, note, name } = body;

    // 1) Validerar input
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

    // 2) Räknar ut antal rum per typ
    const wanted = { single: 0, double: 0, suite: 0 };
    for (const t of rooms) {
      const k = String(t).toLowerCase();
      if (!ALLOWED_TYPES.includes(k)) {
        return badRequest(`Ogiltig room type: ${t}`);
      }
      wanted[k]++;
    }

    // 3) Hämtar alla rum från databasen
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

    // 4) Väljer rum som är lediga
    // Går igenom alla rum i tabellen, för varje rum av rätt typ som är ledigt under hela perioden väljs det
    // Fortsätter tills vi har valt tillräckligt många rum eller gått igenom alla rum
    // Om vi inte hittar tillräckligt många lediga rum av rätt typ misslyckas bokningen
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

    // 5) Kollar att vald kombination rymmer alla gäster
    const totalCapacity = chosen.reduce((sum, r) => sum + Number(r.guestsAllowed?.N ?? "0"), 0);
    if (totalCapacity < wantedGuests) {
      return conflict(
        `Vald kombination rymmer totalt ${totalCapacity} gäster, men ${wantedGuests} efterfrågas.`
      );
    }

    // 6) Skapar bokningen och låser rummen
    // Skapar en unik boknings-id
    // Anropar tryBookRoom() som skapar alla rader i en transaktion (CONFIRMATION, LINE#, ROOM#DATE#)
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
