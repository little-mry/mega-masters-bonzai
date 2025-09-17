import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { client } from "../../services/db.js";
import { sendResponse } from "../responses/index.js";
import {
  badRequest,
  serverError,
  notFound,
  conflict,
} from "../responses/errors.js";
import { replaceBookingGroup } from "./service.js";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const TABLE = "bonzai-table";

export const handler = async (event) => {
  try {
    const bookingId = event.pathParameters?.id;
    if (!bookingId) return badRequest("booking id saknas: (/bookings/{id})");

    const body = JSON.parse(event.body || "{}");
    const { name, email, note, guests, rooms, checkIn, checkOut } = body;

    // Flagga: ändras rum/datum/antal gäster?
    const bookingChange =
      guests !== undefined ||
      rooms !== undefined ||
      checkIn !== undefined ||
      checkOut !== undefined;

    // A) Enkel uppdatering (bara name/email/note)
    if (!bookingChange) {
      const setParts = [];
      const names = {};
      const values = {};

      if (typeof name === "string" && name.trim()) {
        setParts.push("#name = :name");
        names["#name"] = "name";
        values[":name"] = { S: name.trim() };
      }
      if (typeof email === "string" && email.trim()) {
        setParts.push("#email = :email");
        names["#email"] = "email";
        values[":email"] = { S: email.trim() };
      }
      if (note !== undefined) {
        setParts.push("#note = :note");
        names["#note"] = "note";
        values[":note"] = { S: String(note) };
      }

      if (setParts.length === 0) {
        return badRequest(
          "Inget att uppdatera. Skicka name, email eller note."
        );
      }

      try {
        const out = await client.send(
          new UpdateItemCommand({
            TableName: TABLE,
            Key: {
              pk: { S: `BOOKING#${bookingId}` },
              sk: { S: "CONFIRMATION" },
            },
            ConditionExpression:
              "attribute_exists(pk) AND attribute_exists(sk)",
            UpdateExpression: "SET " + setParts.join(", "),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: "ALL_NEW",
          })
        );
        
        const a = out.Attributes ? unmarshall(out.Attributes) : null;
        return sendResponse(200, {
          updated: true,
          bookingId,
          ...a,
        });
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          return notFound("Bokningen finns inte.");
        }
        console.error("updateBooking(simple) error:", err);
        return serverError();
      }
    }

    // B) Struktur-ändring (rum/datum/antal gäster)
    if (guests !== undefined) {
      const g = parseInt(guests, 10);
      if (!Number.isInteger(g) || g <= 0)
        return badRequest("guests måste vara ett positivt heltal.");
    }
    if (rooms !== undefined && (!Array.isArray(rooms) || rooms.length === 0)) {
      return badRequest(
        "rooms måste vara en icke-tom array av room types (single/double/suite)."
      );
    }

    try {
      const result = await replaceBookingGroup({
        bookingId,
        patch: { rooms, guests, checkIn, checkOut, email, name, note },
      });
      return sendResponse(200, { updated: true, ...result });
    } catch (err) {
      if (err?.name === "NotFound") {
        return notFound("Bokningen finns inte.");
      }
      if (err?.name === "TransactionCanceledException") {
        return conflict("De önskade rummen/datum är inte tillgängliga.");
      }
      console.error("updateBooking(struct) error:", err);
      return serverError();
    }
  } catch (err) {
    console.error("updateBooking handler error:", err);
    return serverError();
  }
};
