import { createServer } from "node:http";
import { searchTickets } from "./search.mjs";
import { tickets } from "../data/tickets.mjs";

export function createTicketServer(records = tickets) {
  return createServer((request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "GET") return send(405, { error: "method_not_allowed" });
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/tickets") return send(404, { error: "not_found" });
    try {
      send(200, searchTickets(records, url.searchParams));
    } catch (error) {
      if (error instanceof RangeError) return send(400, { error: "invalid_query" });
      send(500, { error: "internal_error" });
    }
  });
}
