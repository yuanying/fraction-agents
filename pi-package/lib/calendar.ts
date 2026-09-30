import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The calendar settings (ADR 0014): the service account's key, which calendars the agent may use, and the time zone
 * it reads and writes times in. The key itself stays in its own file (a Secret); this file holds no secrets.
 */
export interface CalendarConfig {
  /** The service account's JSON key, as Google gives it. */
  serviceAccountKeyFile: string;
  /** An IANA time zone such as Asia/Tokyo. Times without an offset are in this zone. */
  timeZone: string;
  /** The calendars shared with the service account. The agent uses no others. */
  calendars: { id: string; name: string }[];
  /** Where new events go unless the request names another calendar. */
  defaultCalendar: string;
}

/** The file name of the settings inside pi's agent directory. */
export const CALENDAR_CONFIG_FILE = "calendar.json";

/**
 * The mark on the events the agent creates (a private extended property). Only events with it may be changed or
 * deleted. A private property is kept on the calendar's own copy of the event and is not shown in Google's UI.
 */
export const MANAGED_MARK: Readonly<Record<string, string>> = Object.freeze({ fractionAgentsCreatedBy: "calendar-keeper" });

/** Events and the calendars' names; no access to the calendars' sharing or settings. */
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export function defaultCalendarConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const agentDir = env.PI_CODING_AGENT_DIR;
  return agentDir ? join(agentDir, CALENDAR_CONFIG_FILE) : undefined;
}

export function loadCalendarConfig(path: string): CalendarConfig {
  return parseCalendarConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseCalendarConfig(input: unknown): CalendarConfig {
  const root = record(input, "config");
  const keyFile = root.serviceAccountKeyFile;
  if (typeof keyFile !== "string" || keyFile === "") throw new Error("calendar: serviceAccountKeyFile is required");
  const timeZone = root.timeZone;
  if (typeof timeZone !== "string" || timeZone === "") throw new Error("calendar: timeZone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`calendar: timeZone ${timeZone} is not a time zone`);
  }
  if (!Array.isArray(root.calendars) || root.calendars.length === 0) throw new Error("calendar: calendars must list at least one calendar");
  const calendars: CalendarConfig["calendars"] = [];
  for (const entry of root.calendars) {
    const calendar = record(entry, "calendars[]");
    if (typeof calendar.id !== "string" || calendar.id === "") throw new Error("calendar: each of calendars needs an id");
    if (calendar.name !== undefined && typeof calendar.name !== "string") throw new Error("calendar: a calendar's name must be a string");
    if (calendars.some((known) => known.id === calendar.id)) throw new Error(`calendar: calendars lists ${calendar.id} twice`);
    calendars.push({ id: calendar.id, name: typeof calendar.name === "string" && calendar.name !== "" ? calendar.name : calendar.id });
  }
  const defaultCalendar = root.defaultCalendar === undefined ? calendars[0]!.id : root.defaultCalendar;
  if (typeof defaultCalendar !== "string" || !calendars.some((calendar) => calendar.id === defaultCalendar)) {
    throw new Error("calendar: defaultCalendar must be one of calendars");
  }
  return { serviceAccountKeyFile: keyFile, timeZone, calendars, defaultCalendar };
}

// --- Times -------------------------------------------------------------------------------------------------------

const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?)?$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A date, or a date and time, as the agent writes it. Without an offset, it is a wall-clock time. */
export type When = { kind: "date"; date: string } | { kind: "dateTime"; local: string; offset?: string };

export function parseWhen(text: string): When {
  const match = WHEN.exec(text.trim());
  const fail = () => new Error(`"${text}" is not a date (YYYY-MM-DD) or a date and time (YYYY-MM-DDTHH:MM)`);
  if (!match) throw fail();
  const [, y, mo, d, h, mi, s, offset] = match;
  const parts = [y, mo, d, h ?? "00", mi ?? "00", s ?? "00"].map(Number) as [number, number, number, number, number, number];
  const check = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if (
    check.getUTCFullYear() !== parts[0] ||
    check.getUTCMonth() !== parts[1] - 1 ||
    check.getUTCDate() !== parts[2] ||
    check.getUTCHours() !== parts[3] ||
    check.getUTCMinutes() !== parts[4]
  ) {
    throw fail();
  }
  const date = `${y}-${mo}-${d}`;
  if (h === undefined) return { kind: "date", date };
  return { kind: "dateTime", local: `${date}T${h}:${mi}:${s ?? "00"}`, ...(offset ? { offset } : {}) };
}

/** The instant of a date (its midnight) or a time, read in the time zone unless it carries an offset. */
export function localToInstant(text: string, timeZone: string): Date {
  return whenToInstant(parseWhen(text), timeZone);
}

export function whenToInstant(when: When, timeZone: string): Date {
  if (when.kind === "dateTime" && when.offset) return new Date(`${when.local}${when.offset}`);
  const local = when.kind === "date" ? `${when.date}T00:00:00` : when.local;
  const guess = Date.parse(`${local}Z`);
  // The zone's offset at the guess, then again at the result, which differs only next to a DST change.
  let instant = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  const second = offsetMinutes(new Date(instant), timeZone);
  instant = guess - second * 60_000;
  return new Date(instant);
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function offsetMinutes(instant: Date, timeZone: string): number {
  const clock = wallClock(instant, timeZone);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

const pad = (value: number) => String(value).padStart(2, "0");

function dateWithWeekday(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)} (${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]})`;
}

/** "2026-09-30 (Wed) 14:03" in the time zone. */
export function formatInstant(instant: Date, timeZone: string): string {
  const clock = wallClock(instant, timeZone);
  return `${dateWithWeekday(clock.year, clock.month, clock.day)} ${pad(clock.hour)}:${pad(clock.minute)}`;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The line every tool result starts with, so that the agent reads "tomorrow" against the right day. */
export function nowLine(now: Date, timeZone: string): string {
  return `Now: ${formatInstant(now, timeZone)}, time zone ${timeZone} (${formatOffset(offsetMinutes(now, timeZone))})`;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function addMinutesToLocal(local: string, minutes: number): string {
  return new Date(Date.parse(`${local}Z`) + minutes * 60_000).toISOString().slice(0, 19);
}

// --- Events ------------------------------------------------------------------------------------------------------

export interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  htmlLink?: string;
  extendedProperties?: { private?: Record<string, string> };
}

export function isManaged(event: CalendarEvent): boolean {
  const properties = event.extendedProperties?.private ?? {};
  return Object.entries(MANAGED_MARK).every(([key, value]) => properties[key] === value);
}

function eventTime(when: When, timeZone: string): EventTime {
  if (when.kind === "date") return { date: when.date };
  return { dateTime: `${when.local}${when.offset ?? ""}`, timeZone };
}

/**
 * The start and end of an event as Google takes them. An all-day event's end is its last day here, and the day
 * after in Google (exclusive). A timed event without an end lasts an hour.
 */
export function eventSpan(startText: string, endText: string | undefined, timeZone: string): { start: EventTime; end: EventTime } {
  const start = parseWhen(startText);
  if (start.kind === "date") {
    const end = endText === undefined ? start : parseWhen(endText);
    if (end.kind !== "date") throw new Error("An all-day event needs dates (YYYY-MM-DD) for both start and end");
    if (end.date < start.date) throw new Error("The end is before the start");
    return { start: { date: start.date }, end: { date: addDays(end.date, 1) } };
  }
  const end: When =
    endText === undefined
      ? { kind: "dateTime", local: addMinutesToLocal(start.local, 60), ...(start.offset ? { offset: start.offset } : {}) }
      : parseWhen(endText);
  if (end.kind !== "dateTime") throw new Error("A timed event needs times for both start and end; an all-day event needs dates for both");
  if (whenToInstant(end, timeZone) <= whenToInstant(start, timeZone)) throw new Error("The end is before the start, or equal to it");
  return { start: eventTime(start, timeZone), end: eventTime(end, timeZone) };
}

/** The instant of an event's time. Google gives an offset; a time without one is in the event's own zone. */
function timeOf(time: EventTime, timeZone: string): Date {
  const dateTime = time.dateTime ?? "";
  if (/(Z|[+-]\d{2}:\d{2})$/.test(dateTime)) return new Date(dateTime);
  return whenToInstant(parseWhen(dateTime), time.timeZone ?? timeZone);
}

/** When the event starts, for sorting. All-day events count from their day's midnight. */
export function eventStart(event: CalendarEvent, timeZone: string): number {
  if (event.start?.dateTime) return timeOf(event.start, timeZone).getTime();
  if (event.start?.date) return whenToInstant({ kind: "date", date: event.start.date }, timeZone).getTime();
  return 0;
}

export function formatSpan(event: CalendarEvent, timeZone: string): string {
  const { start, end } = event;
  if (start?.date) {
    const [y, m, d] = start.date.split("-").map(Number) as [number, number, number];
    const last = end?.date ? addDays(end.date, -1) : start.date;
    const first = dateWithWeekday(y, m, d);
    if (last <= start.date) return `${first} all day`;
    const [ly, lm, ld] = last.split("-").map(Number) as [number, number, number];
    return `${first} – ${dateWithWeekday(ly, lm, ld)} all day`;
  }
  if (!start?.dateTime) return "(no time)";
  const from = formatInstant(timeOf(start, timeZone), timeZone);
  if (!end?.dateTime) return from;
  const to = formatInstant(timeOf(end, timeZone), timeZone);
  return from.slice(0, 16) === to.slice(0, 16) ? `${from}–${to.slice(17)}` : `${from} – ${to}`;
}

const DESCRIPTION_CHARS = 200;

/** One event as a line for the model. Everything but the times and IDs is the calendar's data, not instructions. */
export function formatEvent(event: CalendarEvent, calendar: { id: string; name: string }, timeZone: string): string {
  const title = oneLine(event.summary) || "(no title)";
  const location = oneLine(event.location);
  const managed = isManaged(event) ? "created by you: may be changed or deleted" : "read only: not yours";
  const lines = [
    `- ${formatSpan(event, timeZone)} ${title}${location ? ` @ ${location}` : ""} [${calendar.name}] (eventId: ${event.id}, calendarId: ${calendar.id}, ${managed})`,
  ];
  const description = oneLine(event.description);
  if (description) {
    lines.push(`  description: ${description.length > DESCRIPTION_CHARS ? `${description.slice(0, DESCRIPTION_CHARS)}…` : description}`);
  }
  return lines.join("\n");
}

function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

// --- Google ------------------------------------------------------------------------------------------------------

export interface GoogleOptions {
  fetch?: typeof fetch;
  tokenUrl?: string;
  apiBase?: string;
  now?: () => Date;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

function loadServiceAccountKey(path: string): ServiceAccountKey {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // The message names the file, never its content.
    const reason = error instanceof SyntaxError ? "not JSON" : error instanceof Error && "code" in error ? String(error.code) : "unreadable";
    throw new Error(`The service account key (${path}) cannot be read: ${reason}. Tell the caller the calendar is not set up.`);
  }
  const key = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new Error(`The service account key (${path}) has no client_email or private_key. Tell the caller the calendar is not set up.`);
  }
  return {
    client_email: key.client_email,
    private_key: key.private_key,
    ...(typeof key.private_key_id === "string" ? { private_key_id: key.private_key_id } : {}),
  };
}

export class GoogleApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Google Calendar's REST API as the service account, with a token from a signed JWT (no user, no impersonation). */
export class GoogleCalendar {
  readonly #config: CalendarConfig;
  readonly #fetch: typeof fetch;
  readonly #tokenUrl: string;
  readonly #apiBase: string;
  readonly #now: () => Date;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(config: CalendarConfig, options: GoogleOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? fetch;
    this.#tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
    this.#apiBase = options.apiBase ?? GOOGLE_CALENDAR_API;
    this.#now = options.now ?? (() => new Date());
  }

  async #accessToken(signal?: AbortSignal): Promise<string> {
    const now = this.#now().getTime();
    if (this.#token && now < this.#token.expiresAt - 60_000) return this.#token.value;
    // Read each time a token is needed, so that a replaced Secret is picked up without restarting pi.
    const key = loadServiceAccountKey(this.#config.serviceAccountKeyFile);
    const iat = Math.floor(now / 1000);
    const header = { alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
    const claims = { iss: key.client_email, scope: CALENDAR_SCOPES.join(" "), aud: this.#tokenUrl, iat, exp: iat + 3600 };
    const unsigned = `${base64url(header)}.${base64url(claims)}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
    const response = await this.#fetch(this.#tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
      signal: withTimeout(signal),
      redirect: "error",
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string") {
      throw new Error(`Google refused the token request: HTTP ${response.status}${typeof body.error === "string" ? ` ${body.error}` : ""}`);
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.#token = { value: body.access_token, expiresAt: now + expiresIn * 1000 };
    return this.#token.value;
  }

  async #request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T | undefined> {
    const token = await this.#accessToken(options.signal);
    const url = new URL(`${this.#apiBase}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const response = await this.#fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: withTimeout(options.signal),
      redirect: "error",
    });
    const text = await response.text();
    if (!response.ok) {
      let message = "";
      try {
        const error = (JSON.parse(text) as { error?: { message?: unknown } }).error;
        if (typeof error?.message === "string") message = `: ${error.message}`;
      } catch {
        // Not JSON; the status says enough.
      }
      throw new GoogleApiError(response.status, `Google Calendar answered HTTP ${response.status}${message}`);
    }
    return text ? (JSON.parse(text) as T) : undefined;
  }

  #calendarPath(calendarId: string): string {
    return `/calendars/${encodeURIComponent(calendarId)}`;
  }

  async getCalendar(calendarId: string, signal?: AbortSignal): Promise<{ summary?: string; timeZone?: string }> {
    return (await this.#request<{ summary?: string; timeZone?: string }>("GET", this.#calendarPath(calendarId), { signal })) ?? {};
  }

  async listEvents(
    calendarId: string,
    timeMin: Date,
    timeMax: Date,
    query: string | undefined,
    signal?: AbortSignal,
  ): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    // Enough for any sensible period; a longer list is cut rather than fetched without end.
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.#request<{ items?: CalendarEvent[]; nextPageToken?: string }>(
        "GET",
        `${this.#calendarPath(calendarId)}/events`,
        {
          query: {
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "250",
            timeZone: this.#config.timeZone,
            ...(query ? { q: query } : {}),
            ...(pageToken ? { pageToken } : {}),
          },
          signal,
        },
      );
      events.push(...(result?.items ?? []).filter((event) => event.status !== "cancelled"));
      pageToken = result?.nextPageToken;
      if (!pageToken) break;
    }
    return events;
  }

  async getEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<CalendarEvent> {
    const event = await this.#request<CalendarEvent>("GET", `${this.#calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      query: { timeZone: this.#config.timeZone },
      signal,
    });
    if (!event || event.status === "cancelled") throw new GoogleApiError(404, "Google Calendar answered HTTP 404: the event is not there");
    return event;
  }

  /** Always without notifications: the agent invites nobody (ADR 0014). */
  async insertEvent(calendarId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<CalendarEvent> {
    return (await this.#request<CalendarEvent>("POST", `${this.#calendarPath(calendarId)}/events`, {
      query: { sendUpdates: "none" },
      body,
      signal,
    }))!;
  }

  async patchEvent(calendarId: string, eventId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<CalendarEvent> {
    return (await this.#request<CalendarEvent>("PATCH", `${this.#calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      query: { sendUpdates: "none" },
      body,
      signal,
    }))!;
  }

  async deleteEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<void> {
    await this.#request("DELETE", `${this.#calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      query: { sendUpdates: "none" },
      signal,
    });
  }
}

const MAX_PAGES = 4;
const REQUEST_TIMEOUT_MS = 30_000;

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`calendar: ${name} must be an object`);
  return value as Record<string, unknown>;
}
