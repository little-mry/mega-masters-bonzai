import { BatchGetItemCommand } from "@aws-sdk/client-dynamodb";
import { client } from "../../services/db";

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
