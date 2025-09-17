import { client } from "../../services/db.js";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { enumerateNights } from "../../helpers/helpers.js";
import { getBookingById } from "../../helpers/bookings.js";
import { getAllRooms } from "../../helpers/rooms.js";
import { isRoomFree } from "../../helpers/availableRooms.js";

const TABLE = "bonzai-table";

// Välj faktiska rum utifrån efterfrågade typer (t.ex. ["single","suite"])
async function chooseRoomsByTypes(allRooms, roomTypes, nights) {
  const allowed = ["single", "double", "suite"];
  const wanted = { single: 0, double: 0, suite: 0 };

  for (const t of roomTypes) {
    const key = String(t).toLowerCase();
    if (!allowed.includes(key)) {
      const e = new Error(`Ogiltig room type: ${t}`);
      e.name = "BadRequest";
      throw e;
    }
    wanted[key]++;
  }

  const pick = async (type, count) => {
    if (count <= 0) return [];
    const out = [];
    for (const r of allRooms) {
      const avail = r.isAvailable !== false;
      const rt = String(r.roomType || "").toLowerCase();
      if (!avail || rt !== type) continue;

      const roomNo = Number(r.roomNo);
      if (await isRoomFree(roomNo, nights)) {
        out.push(r);
        if (out.length === count) break;
      }
    }
    return out;
  };

  const chosen = [
    ...(await pick("single", wanted.single)),
    ...(await pick("double", wanted.double)),
    ...(await pick("suite", wanted.suite)),
  ];

  if (chosen.length !== roomTypes.length) {
    const e = new Error(
      "Det finns inte tillräckligt många lediga rum av vald kombination."
    );
    e.name = "TransactionCanceledException";
    throw e;
  }
  return chosen;
}

// Byter datum/rum/antal för en bokning.
export async function replaceBookingGroup({ bookingId, patch }) {
  const items = await getBookingById(bookingId);
  const confirmation = items.find((it) => it.sk === "CONFIRMATION");
  if (!confirmation) {
    const e = new Error("Booking not found");
    e.name = "NotFound";
    throw e;
  }

  if (confirmation.status === "CANCELLED") {
    const e = new Error("Bokningen är redan avbokad.");
    e.name = "Conflict";
    throw e;
  }

  const oldLines = items.filter(
    (it) => typeof it.sk === "string" && it.sk.startsWith("LINE#")
  );

  // Nya värden till bokningen
  const newGuests =
    patch.guests !== undefined
      ? parseInt(patch.guests, 10)
      : parseInt(confirmation.guests ?? 0, 10);
  if (!Number.isInteger(newGuests) || newGuests <= 0) {
    const e = new Error("guests måste vara ett positivt heltal.");
    e.name = "BadRequest";
    throw e;
  }

  const newCheckIn = patch.checkIn ?? confirmation.checkIn;
  const newCheckOut = patch.checkOut ?? confirmation.checkOut;
  const nights = enumerateNights(newCheckIn, newCheckOut);
  if (nights.length === 0) {
    const e = new Error("Ogiltigt datumintervall (minst 1 natt).");
    e.name = "BadRequest";
    throw e;
  }

  let roomTypes = patch.rooms;
  if (!Array.isArray(roomTypes) || roomTypes.length === 0) {
    roomTypes = [];
    for (const ln of oldLines) {
      const qty = Number(ln.Quantity ?? 0);
      const typeLower = String(ln.roomType || "").toLowerCase();
      for (let i = 0; i < qty; i++) roomTypes.push(typeLower);
    }
  }

  const newEmail = patch.email ?? confirmation.email;
  const newName = patch.name ?? confirmation.name ?? "";
  const newNote = patch.note ?? confirmation.note ?? "";

  // Väljer nya rum
  const allRoomsPlain = await getAllRooms();
  const rooms = await chooseRoomsByTypes(allRoomsPlain, roomTypes, nights);

  // Transaktion A: Låser nya nätter
  const txA = [];
  for (const r of rooms) {
    const roomNo = Number(r.roomNo);
    for (const date of nights) {
      txA.push({
        Put: {
          TableName: TABLE,
          Item: marshall({
            pk: `ROOM#${roomNo}`,
            sk: `DATE#${date}`,
            roomNo,
            date,
            bookingId,
            GSI2_PK: `CAL#${date}`,
            GSI2_SK: `BOOKING#${bookingId}#ROOM#${roomNo}`,
          }),
          ConditionExpression:
            "(attribute_not_exists(pk) AND attribute_not_exists(sk)) OR bookingId = :bid",
          ExpressionAttributeValues: { ":bid": { S: bookingId } },
        },
      });
    }
  }
  await client.send(
    new TransactWriteItemsCommand({
      TransactItems: txA,
      ReturnCancellationReasons: true,
    })
  );

  //Transaktion B: rensa bort gammal bokningsrader och rumslås + skriver nya
  const txB = [];

  // Ta bort gamla lås
  const oldNights = enumerateNights(
    confirmation.checkIn,
    confirmation.checkOut
  );
  const oldRoomNos = Array.isArray(confirmation.reservedRooms)
    ? confirmation.reservedRooms.map(Number)
    : [];

  for (const rn of oldRoomNos) {
    for (const d of oldNights) {
      txB.push({
        Delete: {
          TableName: TABLE,
          Key: marshall({ pk: `ROOM#${rn}`, sk: `DATE#${d}` }),
        },
      });
    }
  }

  // Ta bort gamla LINE#
  for (const ln of oldLines) {
    txB.push({
      Delete: {
        TableName: TABLE,
        Key: marshall({ pk: `BOOKING#${bookingId}`, sk: ln.sk }),
      },
    });
  }

  // Nya LINE# per rumstyp
  const byType = new Map();
  for (const r of rooms) {
    const t = String(r.roomType || "");
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }

  let idx = 1;
  const ver = Date.now();
  const pricePerNightSum = rooms.reduce((s, r) => s + Number(r.price ?? 0), 0);
  const totalCapacity = rooms.reduce(
    (s, r) => s + Number(r.guestsAllowed ?? 0),
    0
  );
  const totalPrice = pricePerNightSum * nights.length;
  const reservedRoomsAll = rooms.map((r) => Number(r.roomNo));

  for (const [type, list] of byType.entries()) {
    const lineKey = `LINE#${ver}#${String(idx).padStart(3, "0")}`;
    const quantity = list.length;
    const sumType = list.reduce((s, r) => s + Number(r.price ?? 0), 0);
    const lineTotal = sumType * nights.length;
    const reservedRooms = list.map((r) => Number(r.roomNo));

    txB.push({
      Put: {
        TableName: TABLE,
        Item: marshall({
          pk: `BOOKING#${bookingId}`,
          sk: lineKey,
          roomType: type,
          Quantity: quantity,
          reservedRooms,
          pricePerNightSum: sumType,
          lineTotal,
        }),
        ConditionExpression:
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    });

    idx++;
  }

  //Ny confirmation-rad
  const now = new Date().toISOString();
  txB.push({
    Put: {
      TableName: TABLE,
      Item: marshall({
        pk: `BOOKING#${bookingId}`,
        sk: "CONFIRMATION",
        bookingId,
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        guests: newGuests,
        email: newEmail,
        name: newName,
        note: String(newNote ?? ""),
        status: "CONFIRMED",
        createdAt: confirmation.createdAt ?? now,
        modifiedAt: now,
        totalPrice,
        roomsCount: rooms.length,
        totalCapacity,
        reservedRooms: reservedRoomsAll,
      }),
    },
  });

  await client.send(
    new TransactWriteItemsCommand({
      TransactItems: txB,
      ReturnCancellationReasons: true,
    })
  );

  return {
    bookingId,
    checkIn: newCheckIn,
    checkOut: newCheckOut,
    guests: newGuests,
    email: newEmail,
    name: newName,
    status: "CONFIRMED",
    rooms: rooms.map((r) => ({
      roomNo: Number(r.roomNo),
      roomName: r.roomName,
      roomType: r.roomType,
    })),
    nights: nights.length,
    totalPrice,
  };
}
