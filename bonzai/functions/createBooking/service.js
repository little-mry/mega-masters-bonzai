import { client } from "../../services/db.js";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const TABLE = "bonzai-table";

export const tryBookRoom = async ({ rooms, nights, bookingId, payload }) => {
  const now = new Date().toISOString();
  const TransactItems = [];
  const lineItems = []; 

  // Kontrollerar input 
  if (!Array.isArray(rooms)) throw new TypeError("rooms måste vara en array");
  if (!Array.isArray(nights)) throw new TypeError("nights måste vara en array");

  // Deduplicerar rum
  const seen = new Set();
  const uniqueRooms = [];
  for (const room of rooms) {
    const roomNoStr = room?.roomNo?.N;
    if (!roomNoStr) throw new TypeError("rum saknar roomNo.N");
    if (!seen.has(roomNoStr)) {
      seen.add(roomNoStr);
      uniqueRooms.push(room);
    }
  }

  // Skapar datumlås för varje rum+natt
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

  // Räknar ut totalpris och antal gäster
  const totalGuests = Number(payload.guests);
  const pricePerNightSum = uniqueRooms.reduce((sum, r) => sum + Number(r.price.N), 0);
  const totalPrice = pricePerNightSum * nights.length;

  // Bygger line-items per roomType
  const groups = new Map();
  for (const r of uniqueRooms) {
    const type = r.roomType.S;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(r);
  }

  let lineIndex = 1;
  for (const [type, list] of groups.entries()) {
    const quantity = list.length;
    const pricePerNightSumType = list.reduce((s, r) => s + Number(r.price.N), 0);
    const lineTotal = pricePerNightSumType * nights.length;

    const reservedRooms = list.map((r) => ({ N: r.roomNo.N }));
    const idx = String(lineIndex).padStart(3, "0");

    const lineItem = {
      pk: { S: `BOOKING#${bookingId}` },
      sk: { S: `LINE#${idx}` },
      roomType: { S: type },
      Quantity: { N: String(quantity) },
      reservedRooms: { L: reservedRooms },
      pricePerNightSum: { N: String(pricePerNightSumType) },
      lineTotal: { N: String(lineTotal) },
    };

    TransactItems.push({
      Put: {
        TableName: TABLE,
        Item: lineItem,
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    });

    lineItems.push(lineItem); // Sparar för returvärde
    lineIndex++;
  }

  // Lägger till confirmation-item
  // Alla rum i en lista under reservedRooms
  // Detta för att enkelt kunna skicka med i bekräftelsemail etc
  const reservedRoomsAll = uniqueRooms.map((r) => ({ N: r.roomNo.N }));
  const confirmationItem = {
    pk: { S: `BOOKING#${bookingId}` },
    sk: { S: "CONFIRMATION" },
    bookingId: { S: bookingId },
    checkIn: { S: payload.checkIn },
    checkOut: { S: payload.checkOut },
    guests: { N: String(totalGuests) },
    name: { S: payload.name },
    email: { S: payload.email },
    reservedRooms: { L: reservedRoomsAll },
    roomsCount: { N: String(uniqueRooms.length) },
    totalPrice: { N: String(totalPrice) },
    status: { S: "CONFIRMED" },
    createdAt: { S: now },
    GSI1_PK: { S: "BOOKING" },
    GSI1_SK: { S: `CREATED#${now}#${bookingId}` },
  };

  TransactItems.push({
    Put: {
      TableName: TABLE,
      Item: confirmationItem,
      ConditionExpression: "attribute_not_exists(pk)",
    },
  });

  // Kör transaktionen
  await client.send(new TransactWriteItemsCommand({ TransactItems }));

  // Unmarshall för att returnera mer läsbart objekt
  const confirmationLine = unmarshall(confirmationItem);
  const roomTypeLines = lineItems.map(unmarshall);

  // Retur till handler
  return {
    ...confirmationLine,
    roomTypeLines,
    bookingId,
    rooms: uniqueRooms.map((r) => ({
      roomNo: Number(r.roomNo.N),
      roomName: r.roomName.S,
      roomType: r.roomType.S,
      pricePerNight: Number(r.price.N),
    })),
  };
};
