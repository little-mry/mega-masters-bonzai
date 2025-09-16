import { client } from "../../services/db.js";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";

const TABLE = "bonzai-table";

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

export const tryBookRoom = async ({ rooms, nights, bookingId, payload }) => {
  const now = new Date().toISOString();
  const TransactItems = [];

  // --- Säkerhet & tydlig loggning ---
  if (!Array.isArray(rooms)) {
    console.error("tryBookRoom: 'rooms' är inte en array:", rooms);
    throw new TypeError("Internal: rooms must be an array");
  }
  if (!Array.isArray(nights)) {
    console.error("tryBookRoom: 'nights' är inte en array:", nights);
    throw new TypeError("Internal: nights must be an array");
  }

  // 1) Deduplicera rum + validera rumsobjekt
  const seen = new Set();
  const uniqueRooms = [];
  for (const room of rooms) {
    const roomNoStr = room?.roomNo?.N; // förväntat Dynamo-format
    if (!roomNoStr) {
      console.error("tryBookRoom: ogiltigt rumsobjekt (saknar roomNo.N):", room);
      throw new TypeError("Internal: invalid room item (missing roomNo.N)");
    }
    if (!seen.has(roomNoStr)) {
      seen.add(roomNoStr);
      uniqueRooms.push(room);
    }
  }

  // 2) Skapa lås för varje rum + natt
  // (förhindrar att samma rum bokas två gånger samma natt)
  for (const room of uniqueRooms) {
    const roomNoStr = room.roomNo.N;
    for (const date of nights) {
      TransactItems.push({
        Put: {
          TableName: TABLE,
          Item: {
            pk: { S: `ROOM#${roomNoStr}` },
            sk: { S: `DATE#${date}` },
            roomNo: { N: roomNoStr },
            date: { S: date },
            bookingId: { S: bookingId },
            GSI2_PK: { S: `CAL#${date}` },
            GSI2_SK: { S: `BOOKING#${bookingId}#ROOM#${roomNoStr}` },
          },
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      });
    }
  }

  // 3) Räkna ut totals för bokningen (pris, gäster, antal rum)
  const totalGuests = Number(payload.guests);
  const pricePerNightSum = uniqueRooms.reduce((sum, r) => sum + Number(r.price.N), 0);
  const totalPrice = pricePerNightSum * nights.length;

  //    Gruppera valda rum per roomType
  const groups = new Map();
  for (const r of rooms) {
    const type = r.roomType.S; // "Single" | "Double" | "Suite"
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(r);
  }

  let lineIndex = 1;
  for (const [type, list] of groups.entries()) {
    const quantity = list.length;
    const pricePerNightSumType = list.reduce((s, r) => s + Number(r.price.N), 0);
    const lineTotal = pricePerNightSumType * nights.length;

    // lista över roomNo som DynamoDB List (behåller ordning)
    const reservedRooms = list.map((r) => ({ N: r.roomNo.N }));

    const idx = String(lineIndex).padStart(3, "0");
    TransactItems.push({
      Put: {
        TableName: TABLE,
        Item: {
          pk: { S: `BOOKING#${bookingId}` },
          sk: { S: `LINE#${idx}` },
          roomType: { S: type },
          Quantity: { N: String(quantity) },
          reservedRooms: { L: reservedRooms }, // ex [102,101]
          pricePerNightSum: { N: String(pricePerNightSumType) },
          lineTotal: { N: String(lineTotal) },
        },
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    });
    lineIndex++;
  }

  // 4) Spara en CONFIRMATION-post med bokningsinfo
  TransactItems.push({
    Put: {
      TableName: TABLE,
      Item: {
        pk: { S: `BOOKING#${bookingId}` },
        sk: { S: "CONFIRMATION" },
        bookingId: { S: bookingId },
        checkIn: { S: payload.checkIn },
        checkOut: { S: payload.checkOut },
        guests: { N: String(totalGuests) },
        name: { S: payload.name },
        email: { S: payload.email },
        roomsCount: { N: String(uniqueRooms.length) },
        totalPrice: { N: String(totalPrice) },
        status: { S: "CONFIRMED" },
        createdAt: { S: now },
        GSI1_PK: { S: "BOOKING" },
        GSI1_SK: { S: `CREATED#${now}#${bookingId}` },
      },
      ConditionExpression: "attribute_not_exists(pk)",
    },
  });

  // 5) Kör transaktionen (antingen sparas allt, eller inget alls om det krockar)
  try {
    await client.send(
      new TransactWriteItemsCommand({
        TransactItems,
      })
    );
  } catch (err) {
    console.error("tryBookRoom error:", err);
    throw err;
  }

  // 6) Returnera ett enkelt objekt tillbaka till handlern
  return {
    bookingId,
    checkIn: payload.checkIn,
    checkOut: payload.checkOut,
    guests: totalGuests,
    email: payload.email,
    name: payload.name,
    status: "CONFIRMED",
    roomsCount: uniqueRooms.length,
    totalPrice,
    rooms: uniqueRooms.map((r) => ({
      roomNo: Number(r.roomNo.N),
      roomName: r.roomName.S,
      roomType: r.roomType.S,
      pricePerNight: Number(r.price.N),
    })),
  };
};
