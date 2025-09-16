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

  // 1) Se till att samma rum inte råkar väljas flera gånger
  const seen = new Set();
  const uniqueRooms = [];
  for (const r of rooms) {
    const key = String(r.roomNo?.N || r.roomNo);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRooms.push(r);
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
