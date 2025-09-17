import { client } from "../../services/db.js";
import { QueryCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const TABLE = "bonzai-table";

// Enkel datumshelper: [checkIn, checkOut) -> ["YYYY-MM-DD", ...]
export const enumerateNights = (checkIn, checkOut) => {
  const out = [];
  const start = new Date(`${checkIn}T00:00:00.000Z`);
  const end = new Date(`${checkOut}T00:00:00.000Z`);
  if (!(start < end)) return out;
  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

// Läs en bokning 
async function getBookingPlain(bookingId) {
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: `BOOKING#${bookingId}` } },
    })
  );
  return (res.Items || []).map(unmarshall);
}

// Hämta alla rum 
async function getAllRoomsPlain() {
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: "ROOM" } },
    })
  );
  return (res.Items || []).map(unmarshall);
}

// Välj faktiska rum utifrån efterfrågade typer (t.ex. ["single","suite"])
function chooseRoomsByTypes(allRooms, roomTypes) {
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

  const pick = (type, count) => {
    if (count <= 0) return [];
    const out = [];
    for (const r of allRooms) {
      const avail = r.isAvailable !== false; 
      const rt = String(r.roomType || "").toLowerCase();
      if (avail && rt === type) {
        out.push(r);
        if (out.length === count) break;
      }
    }
    return out;
  };

  const chosen = [
    ...pick("single", wanted.single),
    ...pick("double", wanted.double),
    ...pick("suite", wanted.suite),
  ];

  if (chosen.length !== roomTypes.length) {
    const e = new Error("Det finns inte tillräckligt många lediga rum av vald kombination.");
    e.name = "TransactionCanceledException"; 
    throw e;
  }
  return chosen;
}

//Byter datum/rum/antal för en bokning.
export async function replaceBookingGroup({ bookingId, patch }) {

  const items = await getBookingPlain(bookingId);
  const confirmation = items.find((it) => it.sk === "CONFIRMATION");
  if (!confirmation) {
    const e = new Error("Booking not found");
    e.name = "NotFound";
    throw e;
  }
  const oldLines = items.filter((it) => typeof it.sk === "string" && it.sk.startsWith("LINE#"));

  // Nya värden (fallback till gamla om ej skickade)
  const newGuests =
    patch.guests !== undefined ? parseInt(patch.guests, 10) : parseInt(confirmation.guests ?? 0, 10);
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
  const newName = patch.name ?? confirmation.guestName ?? "";
  const newNote = patch.note ?? confirmation.note ?? "";

  // Välj nya rum
  const allRoomsPlain = await getAllRoomsPlain();
  const rooms = chooseRoomsByTypes(allRoomsPlain, roomTypes);

  // Transaktion A: lås nya nätter
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
          }),
          ConditionExpression: "attribute_not_exists(pk)",
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

  // 5) Transaktion B: rensa gammalt + skriv nytt
  const txB = [];

  // Ta bort gamla lås
  const oldNights = enumerateNights(confirmation.checkIn, confirmation.checkOut);
  const oldRoomNos = [];
  for (const ln of oldLines) {
    const arr = Array.isArray(ln.reservedRooms) ? ln.reservedRooms : [];
    for (const n of arr) oldRoomNos.push(Number(n));
  }
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

  // Ta bort gamla LINE# + CONFIRMATION
  for (const ln of oldLines) {
    txB.push({
      Delete: {
        TableName: TABLE,
        Key: marshall({ pk: `BOOKING#${bookingId}`, sk: ln.sk }),
      },
    });
  }
  txB.push({
    Delete: {
      TableName: TABLE,
      Key: marshall({ pk: `BOOKING#${bookingId}`, sk: "CONFIRMATION" }),
    },
  });

  //Nya LINE# per typ
  const byType = new Map();
  for (const r of rooms) {
    const t = String(r.roomType || "");
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }

  let idx = 1;
  const pricePerNightSum = rooms.reduce((s, r) => s + Number(r.price ?? 0), 0);
  const totalCapacity = rooms.reduce((s, r) => s + Number(r.guestsAllowed ?? 0), 0);
  const totalPrice = pricePerNightSum * nights.length;

  for (const [type, list] of byType.entries()) {
    const lineKey = `LINE#${String(idx).padStart(3, "0")}`;
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
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    });

    idx++;
  }

  // Ny CONFIRMATION
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
        guestName: newName,
        note: String(newNote ?? ""),
        status: "CONFIRMED",
        createdAt: confirmation.createdAt ?? now,
        modifiedAt: now,
        totalPrice,
        totalAmount: totalPrice,
        roomsCount: rooms.length,
        totalCapacity,
      }),
    },
  });

  await client.send(
    new TransactWriteItemsCommand({
      TransactItems: txB,
      ReturnCancellationReasons: true,
    })
  );

  // 6) Svar
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
      pricePerNight: Number(r.price ?? 0),
    })),
    nights: nights.length,
    totalPrice,
  };
}
