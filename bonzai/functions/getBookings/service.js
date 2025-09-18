import { BatchGetItemCommand } from "@aws-sdk/client-dynamodb";
import { client } from "../../services/db";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const TABLE = "bonzai-table";
const DATE_EXPR = /^\d{4}-\d{2}-\d{2}$/;

// Kollar om en sträng är i formatet YYYY-MM-DD
export const isIsoDate = (s) => {
  return typeof s === "string" && DATE_EXPR.test(s);
};

// Hämtar CONFIRMATION-poster för flera bookingId
export const fetchConfirmations = async (bookingIds) => {
  if (!bookingIds.length) return [];
  const chunks = [];
  const all = [];

  for (let i = 0; i < bookingIds.length; i += 100) {
    chunks.push(bookingIds.slice(i, i + 100));
  }

  // Hämtar bokningsbekräftelser för varje grupp av bookingId
  for (const chunk of chunks) {
    const each = await client.send(
      new BatchGetItemCommand({
        RequestItems: {
          [TABLE]: {
            Keys: chunk.map((id) => ({
              pk: { S: `BOOKING#${id}` },
              sk: { S: "CONFIRMATION" },
            })),
          },
        },
      })
    );
    const items = each.Responses?.[TABLE] ?? [];
    all.push(...items);
  }
  return all;
};

function toRoomNumbers(roomsRaw) {
  const arr = Array.isArray(roomsRaw) ? roomsRaw : [];
  const out = [];

  for (const r of arr) {
    if (typeof r === "number" && Number.isFinite(r)) { out.push(r); continue; }

    if (typeof r === "string") {
      const n = Number(r);
      if (Number.isFinite(n)) { out.push(n); continue; }
    }

    if (r && typeof r === "object" && typeof r.N === "string") {
      const n = Number(r.N);
      if (Number.isFinite(n)) { out.push(n); continue; }
    }

    const rn =
      typeof r?.roomNo === "number" ? r.roomNo
      : typeof r?.roomNo === "string" ? Number(r.roomNo)
      : typeof r?.roomNo?.N === "string" ? Number(r.roomNo.N)
      : undefined;
    if (Number.isFinite(rn)) out.push(rn);
  }

  return out;
}

export function formatBooking(i) {
  const x = unmarshall(i);
  delete x.pk;
  delete x.sk;
  delete x.GSI1_PK;
  delete x.GSI1_SK;
  delete x.GSI2_PK;
  delete x.GSI2_SK;

  const roomsSrc = x.rooms ?? x.reservedRooms ?? [];

  return {
    bookingId: x.bookingId,
    name: x.name,
    email: x.email,
    guests: x.guests,
    checkIn: x.checkIn,
    checkOut: x.checkOut,
    rooms: toRoomNumbers(roomsSrc),
    note: x.note || null,
    createdAt: x.createdAt,
  };
}
