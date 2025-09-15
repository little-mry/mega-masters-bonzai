import { client } from "../../services/db";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";

const TABLE = "bonzai-table";

export const enumerateNights = (checkIn, checkOut) => {
  const out = [];
  const start = new Date(`${checkIn}T00:00:00.000Z`);
  const end = new Date(`${checkOut}T00:00:00.000Z`);
  if (!(start < end)) return out; // ensure that checkin is before checkout

  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  } //push new date to lock Ex: checkIn=2025-09-20, checkOut=2025-09-22 → nights: ["2025-09-20","2025-09-21"].

  return out;
};

export const tryBookRoom = async ({ room, nights, bookingId, payload }) => {
  const now = new Date().toISOString();
  const TransactItems = [];

  for (const date of nights) {
    // every night in enumerateNights gets to be a date here
    TransactItems.push({
      Put: {
        TableName: TABLE,
        Item: {
          pk: { S: `ROOM#${room.roomNo.N}` },
          sk: { S: `DATE#${date}` },
          roomNo: { N: room.roomNo.N },
          date: { S: date },
          bookingId: { S: bookingId },
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
  }

  TransactItems.push({
    Put: {
      TableName: TABLE,
      Item: {
        pk: { S: `BOOKING#${bookingId}` },
        sk: { S: "CONFIRMATION" },
        roomNo: { N: room.roomNo.N },
        roomName: { S: room.roomName.S }, //vad betyder alla "N" och "S"-ändelser?
        roomType: { S: room.roomType.S },
        price: { N: room.price.N.toString() },
        guestsAllowed: { N: room.guestsAllowed.N },
        checkIn: { S: payload.checkIn },
        checkOut: { S: payload.checkOut },
        guests: { N: payload.guests.toString() },
        email: { S: payload.email },
        status: { S: "CONFIRMED" },
        createdAt: { S: now },
      },
      ConditionExpression: "attribute_not_exists(pk)",
    },
  });

  await client.send(
    new TransactWriteItemsCommand({
      TransactItems,
      ReturnCancellationReasons: true, //vad är detta?
    })
  );

  return {
    bookingId,
    roomNo: Number(room.roomNo.N),
    roomName: room.roomName.S,
    roomType: room.roomType.S,
    checkIn: payload.checkIn,
    checkOut: payload.checkOut,
    guests: payload.guests,
    email: payload.email,
    status: "CONFIRMED",
  };
};

export const tryBookGroup = async ({ rooms, nights, bookingId, payload }) => {
  const now = new Date().toISOString();
  const TransactItems = [];

  // 1) Lås varje natt för varje valt rum (oförändrat)
  for (const room of rooms) {
    const roomNoStr = room.roomNo.N; // dynamo number som sträng
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
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      });
    }
  }

  // 2) Totals (oförändrat)
  const totalGuests = payload.guests;
  const totalCapacity = rooms.reduce(
    (sum, r) => sum + Number(r.guestsAllowed.N),
    0
  );
  const pricePerNightSum = rooms.reduce(
    (sum, r) => sum + Number(r.price.N),
    0
  );
  const totalPrice = pricePerNightSum * nights.length;

  // 3) NYTT: LINE#-rader per rumstyp (Quantity, reservedRooms, lineTotal)
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
        ConditionExpression:
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    });
    lineIndex++;
  }

  // 4) CONFIRMATION – lagt till bookingId + totalAmount (samma som totalPrice)
  TransactItems.push({
    Put: {
      TableName: TABLE,
      Item: {
        pk: { S: `BOOKING#${bookingId}` },
        sk: { S: "CONFIRMATION" },
        bookingId: { S: bookingId },                 // <— nytt
        checkIn: { S: payload.checkIn },
        checkOut: { S: payload.checkOut },
        guests: { N: String(totalGuests) },
        email: { S: payload.email },
        status: { S: "CONFIRMED" },
        createdAt: { S: now },
        totalPrice: { N: String(totalPrice) },
        totalAmount: { N: String(totalPrice) },       // <— nytt, alias för din kolumn
        roomsCount: { N: String(rooms.length) },
        totalCapacity: { N: String(totalCapacity) },
      },
      ConditionExpression: "attribute_not_exists(pk)",
    },
  });

  // 5) Kör transaktionen (oförändrat)
  await client.send(
    new TransactWriteItemsCommand({
      TransactItems,
      ReturnCancellationReasons: true, // ger detaljer vid TransactionCanceledException
    })
  );

  // 6) Svar (oförändrat, men du kan visa lines från UI via en separat fetch om du vill)
  return {
    bookingId,
    checkIn: payload.checkIn,
    checkOut: payload.checkOut,
    guests: totalGuests,
    email: payload.email,
    status: "CONFIRMED",
    rooms: rooms.map((r) => ({
      roomNo: Number(r.roomNo.N),
      roomName: r.roomName.S,
      roomType: r.roomType.S,
      pricePerNight: Number(r.price.N),
    })),
    totalPrice,
  };
};
