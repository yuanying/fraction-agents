import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { createCalendar } from "../extensions/calendar.ts";
import { localToInstant, MANAGED_MARK, parseCalendarConfig } from "../lib/calendar.ts";
import type { PiApi, ToolContext, ToolDefinition } from "../lib/pi.ts";

// Made-up calendars. Real IDs never go into this public repository.
const MAIN = "owner@example.test";
const FAMILY = "family@group.calendar.example.test";
const SERVICE_ACCOUNT = "calendar-keeper@project.iam.example.test";
// 2026-09-30 (Wed) 14:03 in Tokyo.
const NOW = new Date("2026-09-30T05:03:00Z");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

class FakePi implements PiApi {
  readonly tools = new Map<string, ToolDefinition>();
  readonly handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  on(event: string, handler: (event: any, ctx: any) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  async call(name: string, params: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const result = await tool.execute("call-1", params, undefined, undefined, context());
    return result.content.map((part) => part.text).join("");
  }
}

function context(): ToolContext {
  return { cwd: "/work", hasUI: false, ui: { input: async () => undefined } };
}

interface FakeEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: unknown[];
  extendedProperties?: { private?: Record<string, string> };
}

interface RecordedRequest {
  method: string;
  url: URL;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A stand-in for Google: the OAuth token endpoint and the parts of the Calendar API the tools use. */
class FakeGoogle {
  server!: Server;
  base = "";
  requests: RecordedRequest[] = [];
  tokensIssued = 0;
  calendars = new Map<string, { summary: string; timeZone: string; events: Map<string, FakeEvent> }>();
  nextId = 1;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://google.test");
        this.requests.push({ method: req.method ?? "GET", url, headers: req.headers, body });
        const [status, payload] = this.route(req.method ?? "GET", url, req.headers, body);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.requests = [];
    this.tokensIssued = 0;
    this.calendars = new Map([
      [MAIN, { summary: "Owner", timeZone: "Asia/Tokyo", events: new Map() }],
      [FAMILY, { summary: "Family", timeZone: "Asia/Tokyo", events: new Map() }],
    ]);
  }

  add(calendarId: string, event: Omit<FakeEvent, "id"> & { id?: string }): FakeEvent {
    const full = { ...event, id: event.id ?? `ev${this.nextId++}` } as FakeEvent;
    this.calendars.get(calendarId)!.events.set(full.id, full);
    return full;
  }

  apiRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.url.pathname.startsWith("/calendar/"));
  }

  private route(method: string, url: URL, headers: IncomingMessage["headers"], body: string): [number, unknown] {
    if (url.pathname === "/token") return this.token(method, body);
    if (headers.authorization !== "Bearer fake-access-token") return [401, { error: { code: 401, message: "Invalid Credentials" } }];
    const match = /^\/calendar\/v3\/calendars\/([^/]+)(?:\/events(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (!match) return [404, { error: { code: 404, message: "Not Found" } }];
    const calendarId = decodeURIComponent(match[1]!);
    const calendar = this.calendars.get(calendarId);
    if (!calendar) return [404, { error: { code: 404, message: "Not Found" } }];
    const isEvents = url.pathname.includes("/events");
    const eventId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    if (!isEvents) return [200, { id: calendarId, summary: calendar.summary, timeZone: calendar.timeZone }];
    if (eventId === undefined && method === "GET") {
      const min = Date.parse(url.searchParams.get("timeMin") ?? "");
      const max = Date.parse(url.searchParams.get("timeMax") ?? "");
      const items = [...calendar.events.values()].filter((event) => {
        const start = Date.parse(event.start.dateTime ?? `${event.start.date}T00:00:00+09:00`);
        const end = Date.parse(event.end.dateTime ?? `${event.end.date}T00:00:00+09:00`);
        return event.status !== "cancelled" && end > min && start < max;
      });
      return [200, { items }];
    }
    if (eventId === undefined && method === "POST") {
      const input = JSON.parse(body) as Omit<FakeEvent, "id">;
      return [200, this.add(calendarId, { ...input, status: "confirmed" })];
    }
    const event = eventId === undefined ? undefined : calendar.events.get(eventId);
    if (!event) return [404, { error: { code: 404, message: "Not Found" } }];
    if (method === "GET") return [200, event];
    if (method === "PATCH") {
      Object.assign(event, JSON.parse(body));
      return [200, event];
    }
    if (method === "DELETE") {
      calendar.events.delete(event.id);
      return [204, undefined];
    }
    return [405, { error: { code: 405, message: "Method Not Allowed" } }];
  }

  private token(method: string, body: string): [number, unknown] {
    const form = new URLSearchParams(body);
    if (method !== "POST" || form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      return [400, { error: "unsupported_grant_type" }];
    }
    const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${claims}`);
    if (!signature || !verify.verify(publicKey, Buffer.from(signature, "base64url"))) return [400, { error: "invalid_grant" }];
    this.tokensIssued += 1;
    return [200, { access_token: "fake-access-token", token_type: "Bearer", expires_in: 3600 }];
  }
}

function writeKey(dir: string, key: Record<string, unknown> = {}): string {
  const path = join(dir, "service-account.json");
  writeFileSync(
    path,
    JSON.stringify({ type: "service_account", client_email: SERVICE_ACCOUNT, private_key: PRIVATE_KEY_PEM, private_key_id: "k1", ...key }),
  );
  return path;
}

function setUp(google: FakeGoogle, config: Record<string, unknown> = {}, now: () => Date = () => NOW) {
  const agentDir = mkdtempSync(join(tmpdir(), "calendar-"));
  const keyFile = writeKey(agentDir);
  writeFileSync(
    join(agentDir, "calendar.json"),
    JSON.stringify({
      serviceAccountKeyFile: keyFile,
      timeZone: "Asia/Tokyo",
      calendars: [
        { id: MAIN, name: "本人" },
        { id: FAMILY, name: "家族" },
      ],
      ...config,
    }),
  );
  const pi = new FakePi();
  const logs: string[] = [];
  createCalendar({
    env: { PI_CODING_AGENT_DIR: agentDir },
    tokenUrl: `${google.base}/token`,
    apiBase: `${google.base}/calendar/v3`,
    now,
    log: (line) => logs.push(line),
  })(pi);
  return { pi, logs, agentDir };
}

describe("calendar settings", () => {
  it("takes the key file, the time zone and the calendars, and defaults to the first calendar", () => {
    const config = parseCalendarConfig({
      serviceAccountKeyFile: "/var/run/secrets/google/service-account.json",
      timeZone: "Asia/Tokyo",
      calendars: [{ id: MAIN, name: "本人" }, { id: FAMILY }],
    });
    assert.equal(config.serviceAccountKeyFile, "/var/run/secrets/google/service-account.json");
    assert.equal(config.timeZone, "Asia/Tokyo");
    assert.deepEqual(config.calendars, [
      { id: MAIN, name: "本人" },
      { id: FAMILY, name: FAMILY },
    ]);
    assert.equal(config.defaultCalendar, MAIN);
  });

  it("takes a default calendar from the list", () => {
    const config = parseCalendarConfig({
      serviceAccountKeyFile: "/k.json",
      timeZone: "UTC",
      calendars: [{ id: MAIN }, { id: FAMILY }],
      defaultCalendar: FAMILY,
    });
    assert.equal(config.defaultCalendar, FAMILY);
  });

  it("refuses settings that are missing or wrong", () => {
    const base = { serviceAccountKeyFile: "/k.json", timeZone: "Asia/Tokyo", calendars: [{ id: MAIN }] };
    assert.throws(() => parseCalendarConfig({ ...base, serviceAccountKeyFile: undefined }), /serviceAccountKeyFile/);
    assert.throws(() => parseCalendarConfig({ ...base, timeZone: undefined }), /timeZone/);
    assert.throws(() => parseCalendarConfig({ ...base, timeZone: "Mars/Olympus" }), /timeZone/);
    assert.throws(() => parseCalendarConfig({ ...base, calendars: [] }), /calendars/);
    assert.throws(() => parseCalendarConfig({ ...base, calendars: [{ id: "" }] }), /calendars/);
    assert.throws(() => parseCalendarConfig({ ...base, calendars: [{ id: MAIN }, { id: MAIN }] }), /twice/);
    assert.throws(() => parseCalendarConfig({ ...base, defaultCalendar: FAMILY }), /defaultCalendar/);
    assert.throws(() => parseCalendarConfig([]), /config/);
  });
});

describe("local times", () => {
  it("turns a wall-clock time in a time zone into an instant", () => {
    assert.equal(localToInstant("2026-10-01T09:30", "Asia/Tokyo").toISOString(), "2026-10-01T00:30:00.000Z");
    assert.equal(localToInstant("2026-10-01", "Asia/Tokyo").toISOString(), "2026-09-30T15:00:00.000Z");
    assert.equal(localToInstant("2026-10-01T09:30:00+02:00", "Asia/Tokyo").toISOString(), "2026-10-01T07:30:00.000Z");
  });

  it("follows daylight saving time", () => {
    assert.equal(localToInstant("2026-07-01T12:00", "America/New_York").toISOString(), "2026-07-01T16:00:00.000Z");
    assert.equal(localToInstant("2026-12-01T12:00", "America/New_York").toISOString(), "2026-12-01T17:00:00.000Z");
  });

  it("refuses what is not a date or time", () => {
    assert.throws(() => localToInstant("tomorrow", "Asia/Tokyo"), /date/);
    assert.throws(() => localToInstant("2026-13-01", "Asia/Tokyo"), /date/);
  });
});

describe("calendar extension", () => {
  const google = new FakeGoogle();
  before(async () => {
    await google.start();
  });
  after(async () => {
    await google.stop();
  });
  beforeEach(() => {
    google.reset();
  });

  it("registers nothing when the agent has no calendar settings", () => {
    const pi = new FakePi();
    createCalendar({ env: { PI_CODING_AGENT_DIR: "/nonexistent" } })(pi);
    assert.equal(pi.tools.size, 0);
    assert.equal(pi.handlers.size, 0);
  });

  it("warns and registers nothing when the settings are not usable", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "calendar-"));
    writeFileSync(join(agentDir, "calendar.json"), "{ not json");
    const pi = new FakePi();
    const warnings: string[] = [];
    createCalendar({ env: { PI_CODING_AGENT_DIR: agentDir }, log: (line) => warnings.push(line) })(pi);
    assert.equal(pi.tools.size, 0);
    assert.match(warnings.join("\n"), /calendar\.json is not usable/);
  });

  it("gives the calendar tools, and no others", () => {
    const { pi } = setUp(google);
    assert.deepEqual([...pi.tools.keys()].sort(), [
      "calendar_create_event",
      "calendar_delete_event",
      "calendar_list_calendars",
      "calendar_list_events",
      "calendar_now",
      "calendar_update_event",
    ]);
  });

  it("tells the current date, weekday and time zone", async () => {
    const { pi } = setUp(google);
    const out = await pi.call("calendar_now", {});
    assert.match(out, /2026-09-30 \(Wed\) 14:03/);
    assert.match(out, /Asia\/Tokyo/);
    assert.match(out, /UTC\+09:00/);
    assert.equal(google.requests.length, 0, "no call to Google");
  });

  it("gets a token with a JWT signed by the service account's key, and reuses it", async () => {
    const { pi } = setUp(google);
    await pi.call("calendar_list_events", { from: "2026-10-01", to: "2026-10-01" });
    await pi.call("calendar_list_events", { from: "2026-10-02", to: "2026-10-02" });
    assert.equal(google.tokensIssued, 1);

    const tokenRequest = google.requests.find((request) => request.url.pathname === "/token")!;
    const assertion = new URLSearchParams(tokenRequest.body).get("assertion")!;
    const [header, claims] = assertion.split(".").slice(0, 2).map((part) => JSON.parse(Buffer.from(part, "base64url").toString()));
    assert.deepEqual(header, { alg: "RS256", typ: "JWT", kid: "k1" });
    assert.equal(claims.iss, SERVICE_ACCOUNT);
    assert.equal(claims.aud, `${google.base}/token`);
    assert.deepEqual(claims.scope.split(" ").sort(), [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    assert.equal(claims.iat, Math.floor(NOW.getTime() / 1000));
    assert.equal(claims.exp, claims.iat + 3600);
    assert.equal(claims.sub, undefined, "no impersonation");
  });

  it("gets a new token when the old one is about to expire", async () => {
    let now = NOW;
    const { pi } = setUp(google, {}, () => now);
    await pi.call("calendar_list_calendars", {});
    now = new Date(NOW.getTime() + 3590 * 1000);
    await pi.call("calendar_list_calendars", {});
    assert.equal(google.tokensIssued, 2);
  });

  it("fails the tool without showing the key when the key file is missing", async () => {
    const { pi } = setUp(google, { serviceAccountKeyFile: "/nonexistent/service-account.json" });
    await assert.rejects(pi.call("calendar_list_events", { from: "2026-10-01" }), /service account key/);
  });

  it("lists the configured calendars with their names on Google, and marks the default", async () => {
    google.calendars.delete(FAMILY);
    const { pi } = setUp(google);
    const out = await pi.call("calendar_list_calendars", {});
    assert.match(out, /Now: 2026-09-30 \(Wed\) 14:03/);
    assert.match(out, new RegExp(`本人.*${MAIN}.*default`));
    assert.match(out, /Owner/);
    assert.match(out, new RegExp(`家族.*${FAMILY}`));
    assert.match(out, /not reachable.*404.*shared/);
  });

  it("lists the events of all calendars within the period, in order, with the day's end included", async () => {
    google.add(MAIN, {
      summary: "歯医者",
      location: "駅前",
      start: { dateTime: "2026-10-01T10:00:00+09:00" },
      end: { dateTime: "2026-10-01T11:00:00+09:00" },
    });
    google.add(FAMILY, {
      summary: "運動会",
      start: { date: "2026-10-01" },
      end: { date: "2026-10-02" },
      extendedProperties: { private: MANAGED_MARK },
    });
    google.add(MAIN, {
      summary: "打ち合わせ",
      start: { dateTime: "2026-10-01T21:00:00+09:00" },
      end: { dateTime: "2026-10-01T22:00:00+09:00" },
    });
    google.add(MAIN, {
      summary: "翌日の予定",
      start: { dateTime: "2026-10-02T09:00:00+09:00" },
      end: { dateTime: "2026-10-02T10:00:00+09:00" },
    });
    const { pi } = setUp(google);
    const out = await pi.call("calendar_list_events", { from: "2026-10-01", to: "2026-10-01" });

    const listRequests = google.apiRequests().filter((request) => request.method === "GET" && request.url.pathname.endsWith("/events"));
    assert.equal(listRequests.length, 2);
    for (const request of listRequests) {
      assert.equal(request.url.searchParams.get("timeMin"), "2026-09-30T15:00:00.000Z");
      assert.equal(request.url.searchParams.get("timeMax"), "2026-10-01T15:00:00.000Z");
      assert.equal(request.url.searchParams.get("singleEvents"), "true");
      assert.equal(request.url.searchParams.get("timeZone"), "Asia/Tokyo");
    }

    assert.match(out, /Now: 2026-09-30 \(Wed\) 14:03/);
    assert.doesNotMatch(out, /翌日の予定/);
    const lines = out.split("\n");
    const order = ["運動会", "歯医者", "打ち合わせ"].map((summary) => lines.findIndex((line) => line.includes(summary)));
    assert.ok(order.every((index) => index >= 0), out);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "all-day first, then by start");
    assert.match(out, /2026-10-01 \(Thu\) 10:00–11:00.*歯医者.*駅前/);
    assert.match(out, /2026-10-01 \(Thu\) all day.*運動会/);
    const sports = lines.find((line) => line.includes("運動会"))!;
    assert.match(sports, /家族/);
    assert.match(sports, /created by you/);
    const dentist = lines.find((line) => line.includes("歯医者"))!;
    assert.doesNotMatch(dentist, /created by you/);
    assert.match(out, /eventId: ev\d+/);
  });

  it("lists only the calendars asked for, and refuses calendars not in the settings", async () => {
    const { pi } = setUp(google);
    await pi.call("calendar_list_events", { from: "2026-10-01", calendarIds: [FAMILY] });
    const paths = google.apiRequests().map((request) => decodeURIComponent(request.url.pathname));
    assert.ok(paths.every((path) => path.includes(FAMILY)), paths.join("\n"));
    await assert.rejects(pi.call("calendar_list_events", { from: "2026-10-01", calendarIds: ["someone@example.test"] }), /not one of/);
  });

  it("says so when there are no events, and reports a calendar it could not read", async () => {
    google.calendars.delete(FAMILY);
    const { pi } = setUp(google);
    const out = await pi.call("calendar_list_events", { from: "2026-10-01" });
    assert.match(out, /No events/);
    assert.match(out, /家族.*404/);
  });

  it("creates an event on the default calendar with the mark, without inviting anyone", async () => {
    const { pi } = setUp(google);
    const out = await pi.call("calendar_create_event", {
      summary: "歯医者",
      start: "2026-10-01T10:00",
      end: "2026-10-01T11:00",
      location: "駅前",
      description: "本人の依頼",
    });
    const request = google.apiRequests().find((r) => r.method === "POST")!;
    assert.equal(decodeURIComponent(request.url.pathname), `/calendar/v3/calendars/${MAIN}/events`);
    assert.equal(request.url.searchParams.get("sendUpdates"), "none");
    const body = JSON.parse(request.body);
    assert.deepEqual(body.start, { dateTime: "2026-10-01T10:00:00", timeZone: "Asia/Tokyo" });
    assert.deepEqual(body.end, { dateTime: "2026-10-01T11:00:00", timeZone: "Asia/Tokyo" });
    assert.deepEqual(body.extendedProperties, { private: MANAGED_MARK });
    assert.equal(body.attendees, undefined);
    assert.equal(body.summary, "歯医者");
    assert.equal(body.location, "駅前");
    assert.match(out, /Created/);
    assert.match(out, /2026-10-01 \(Thu\) 10:00–11:00/);
    assert.match(out, /eventId: ev\d+/);
  });

  it("creates an all-day event whose end is the last day, and a one-hour event when the end is left out", async () => {
    const { pi } = setUp(google);
    await pi.call("calendar_create_event", { summary: "旅行", start: "2026-10-10", end: "2026-10-12", calendarId: FAMILY });
    await pi.call("calendar_create_event", { summary: "電話", start: "2026-10-03T23:30" });
    const [trip, call] = google.apiRequests().filter((r) => r.method === "POST").map((r) => JSON.parse(r.body));
    assert.deepEqual(trip.start, { date: "2026-10-10" });
    assert.deepEqual(trip.end, { date: "2026-10-13" }, "Google's end date is exclusive");
    assert.deepEqual(call.start, { dateTime: "2026-10-03T23:30:00", timeZone: "Asia/Tokyo" });
    assert.deepEqual(call.end, { dateTime: "2026-10-04T00:30:00", timeZone: "Asia/Tokyo" });
  });

  it("refuses an event that ends before it starts, or mixes all-day and timed", async () => {
    const { pi } = setUp(google);
    await assert.rejects(pi.call("calendar_create_event", { summary: "x", start: "2026-10-01T11:00", end: "2026-10-01T10:00" }), /before/);
    await assert.rejects(pi.call("calendar_create_event", { summary: "x", start: "2026-10-01", end: "2026-10-01T10:00" }), /all-day/);
    await assert.rejects(pi.call("calendar_create_event", { summary: "x", start: "2026-10-01T10:00", calendarId: "someone@example.test" }), /not one of/);
    assert.equal(google.apiRequests().filter((r) => r.method === "POST").length, 0);
  });

  it("changes an event it created, only in the fields given, without notifying anyone", async () => {
    const event = google.add(MAIN, {
      summary: "歯医者",
      location: "駅前",
      start: { dateTime: "2026-10-01T10:00:00+09:00" },
      end: { dateTime: "2026-10-01T11:00:00+09:00" },
      extendedProperties: { private: MANAGED_MARK },
    });
    const { pi } = setUp(google);
    const out = await pi.call("calendar_update_event", { eventId: event.id, start: "2026-10-01T15:00", end: "2026-10-01T16:00" });
    const patch = google.apiRequests().find((r) => r.method === "PATCH")!;
    assert.equal(patch.url.searchParams.get("sendUpdates"), "none");
    const body = JSON.parse(patch.body);
    assert.deepEqual(Object.keys(body).sort(), ["end", "start"]);
    assert.deepEqual(body.start, { dateTime: "2026-10-01T15:00:00", timeZone: "Asia/Tokyo" });
    assert.match(out, /Updated/);
    assert.match(out, /15:00–16:00/);
    assert.deepEqual(google.calendars.get(MAIN)!.events.get(event.id)!.extendedProperties, { private: MANAGED_MARK });
  });

  it("refuses to change or delete an event it did not create", async () => {
    const event = google.add(MAIN, {
      summary: "本人の予定",
      start: { dateTime: "2026-10-01T10:00:00+09:00" },
      end: { dateTime: "2026-10-01T11:00:00+09:00" },
    });
    const forged = google.add(MAIN, {
      summary: "別の印",
      start: { dateTime: "2026-10-01T12:00:00+09:00" },
      end: { dateTime: "2026-10-01T13:00:00+09:00" },
      extendedProperties: { private: { note: "calendar-keeper" } },
    });
    const { pi } = setUp(google);
    for (const id of [event.id, forged.id]) {
      await assert.rejects(pi.call("calendar_update_event", { eventId: id, summary: "変えた" }), /not created by the calendar keeper/);
      await assert.rejects(pi.call("calendar_delete_event", { eventId: id }), /not created by the calendar keeper/);
    }
    assert.equal(google.apiRequests().filter((r) => r.method === "PATCH" || r.method === "DELETE").length, 0);
    assert.equal(google.calendars.get(MAIN)!.events.get(event.id)!.summary, "本人の予定");
  });

  it("asks for both start and end when moving an event", async () => {
    const event = google.add(MAIN, {
      summary: "x",
      start: { dateTime: "2026-10-01T10:00:00+09:00" },
      end: { dateTime: "2026-10-01T11:00:00+09:00" },
      extendedProperties: { private: MANAGED_MARK },
    });
    const { pi } = setUp(google);
    await assert.rejects(pi.call("calendar_update_event", { eventId: event.id, start: "2026-10-01T15:00" }), /start and end/);
    await assert.rejects(pi.call("calendar_update_event", { eventId: event.id }), /nothing to change/i);
  });

  it("deletes an event it created, without notifying anyone", async () => {
    const event = google.add(FAMILY, {
      summary: "運動会",
      start: { date: "2026-10-01" },
      end: { date: "2026-10-02" },
      extendedProperties: { private: MANAGED_MARK },
    });
    const { pi } = setUp(google);
    const out = await pi.call("calendar_delete_event", { eventId: event.id, calendarId: FAMILY });
    const request = google.apiRequests().find((r) => r.method === "DELETE")!;
    assert.equal(request.url.searchParams.get("sendUpdates"), "none");
    assert.equal(google.calendars.get(FAMILY)!.events.has(event.id), false);
    assert.match(out, /Deleted.*運動会/);
  });

  it("says the event is not there when it does not exist", async () => {
    const { pi } = setUp(google);
    await assert.rejects(pi.call("calendar_delete_event", { eventId: "missing" }), /404/);
  });
});
