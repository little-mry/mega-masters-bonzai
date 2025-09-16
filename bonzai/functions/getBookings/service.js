import { sendResponse } from "../responses";

const DATE_EXPR = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (s) => {
    return typeof s === "string" && DATE_EXPR.test(s)

}

export const parseLimit = (s, def = 50, max = 200) => {
    const n = Number(s)
    if (!Number.isFinite(n) || n <= 0) return def
    return Math.min(Math.floor(n), max)
}
