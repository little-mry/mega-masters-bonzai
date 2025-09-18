// Här har vi lagt enumerateNights separat eftersom vi använder den på flera ställen i projektet.
// Funktionen räknar ut alla datum mellan checkIn och checkOut (exklusive utcheckningsdagen).

export const enumerateNights = (checkIn, checkOut) => {
  const out = [];
  const start = new Date(`${checkIn}T00:00:00.000Z`);
  const end = new Date(`${checkOut}T00:00:00.000Z`);
  if (!(start < end)) return out;

  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};