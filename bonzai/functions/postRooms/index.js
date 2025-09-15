import { BatchWriteItemCommand } from "@aws-sdk/client-dynamodb";
import { sendResponse } from "../responses";
import { client } from "../../services/db";

export const handler = async (event) => {
try {
    const body = JSON.parse(event.body ?? "[]")
    if (!Array.isArray(body)) return sendResponse(400, {msg: "Bodyn måste vara en array"})

    const putRequest = body.map((room) => {
        return {
            PutRequest: {
                Item: {
                    pk: {S: "ROOMS"},
                    sk: {S: room.roomNo.toString()},
                    roomNo: {N: room.roomNo},
                    
                }
            }
        }
    })

    return sendResponse(200, {msg: "Success!!!"})
} catch (error) {
    
}

};
