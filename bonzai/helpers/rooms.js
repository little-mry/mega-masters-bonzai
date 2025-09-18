import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { client } from "../services/db.js";

const TABLE = "bonzai-table";

// En helper som hämtar alla rum från databasen.
export const getAllRooms = async () => {
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: "ROOM" } },
    })
  );
  return (res.Items || []).map(unmarshall);
}