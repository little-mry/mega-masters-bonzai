// Här samlar vi färdiga felsvar (HTTP-koder) så vi kan återanvända dom i våra funktioner
import { sendResponse } from "./index.js"

export const badRequest = (msg = "Bad request") => 
  sendResponse(400, { error: msg });


export const notFound = (msg = "Not found") => 
  sendResponse(404, { error: msg });


export const conflict = (msg = "Conflict") => 
  sendResponse(409, { error: msg });


export const serverError = (msg = "Internal error") => 
  sendResponse(500, { error: msg });