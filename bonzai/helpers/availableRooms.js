import { QueryCommand } from "@aws-sdk/client-dynamodb";

const TABLE = "bonzai-table";

// Kontrollerar om ett rum är ledigt för alla nätter i listan
// Genomför en Query med sk mellan from-to, om minst en rad returneras är rummet upptaget någon natt
// Returnerar true om rummet är ledigt alla nätter, annars false
export async function isRoomFree(roomNoStr, nights) {
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
      Limit: 1, // Räcker med att hitta en rad för att veta att rummet är upptaget
    })
  );

  // Om inga items returnerades är rummet ledigt alla nätter
  return !(Items && Items.length > 0);
}
