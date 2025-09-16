import { sendResponse } from "../responses";
import {
  badRequest,
  serverError,
  notFound,
  conflict,
} from "../responses/errors";
import { client } from "../../services/db";
import { isIsoDate } from "./service";

export const handler = async (event) => {
  try {
    const query = event.queryStringParameters || {};

    const date = query.date?.trim();
    const from = query.from?.trim();
    const to = query.to?.trim();

    if (date && (from || to)) {
      return badRequest("Ange antingen ?date=YYYY-MM-DD ELLER ?from=YYYY-MM-DD&to=YYYY-MM-DD");
    }
    if (date && !isIsoDate(date)) {
      return badRequest("Ogiltigt date-format, använd YYYY-MM-DD");
    }
    if ((!from && to) || (from && !to)) {
        return badRequest("Både from och to måste anges");
    }
    if (from && (!isIsoDate(from) || !isIsoDate(to))) {
        return badRequest("Ogiltigt from/to-format, använd YYYY-MM-DD");
    }
    if (from && !(from < to)) {
        return badRequest("'from' måste vara före 'to'");
    }

    let mode = "ALL"
    if (date) {
        mode = "DAY"
    }
    if (from && to) {
        mode = "INTERVAL"
    }
    return sendResponse(200, {mode,  params: { date, from, to },
      note: "Härnäst: anropa GSI1 (ALL) eller GSI2 (DAY/INTERVAL) enligt valt mode."} )

  } catch (error) {
    return serverError()
  }
};
