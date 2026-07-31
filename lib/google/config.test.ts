/**
 * The one question every Google-aware file asks, and the answer it must never
 * get wrong in either direction.
 *
 * Two failures are being guarded against here, and both are screens rather than
 * exceptions:
 *
 * 1. **Saying yes when the answer is no.** `.env.local` grows `GOOGLE_CLIENT_ID=`
 *    long before it grows a value, and a secret pasted from a console arrives
 *    with a newline more often than not. If a blank string counted as
 *    configured, the sign-in page would draw a Google button that the server
 *    has no provider registered for — a door that lies.
 * 2. **Drifting from `lib/google/client.ts`.** That file carries an older copy
 *    of this logic from when it was the only Google file in the tree. The last
 *    test in this file pins them together, so the copy cannot quietly disagree
 *    with the original while both are still in use.
 *
 * Nothing here touches the network, and importing `client.ts` does not load
 * `googleapis` — it takes it as a type and imports the real library lazily,
 * inside a call this test never makes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { googleCredentials, isGoogleConfigured } from "@/lib/google/config";
import {
  googleCredentials as clientCredentials,
  isGoogleConfigured as clientIsConfigured,
} from "@/lib/google/client";

const SAVED_ID = process.env.GOOGLE_CLIENT_ID;
const SAVED_SECRET = process.env.GOOGLE_CLIENT_SECRET;

beforeEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

afterEach(() => {
  if (SAVED_ID === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = SAVED_ID;
  if (SAVED_SECRET === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = SAVED_SECRET;
});

describe("googleCredentials", () => {
  it("is null with neither variable set", () => {
    expect(googleCredentials()).toBeNull();
  });

  it("is null when only the client id is set", () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    expect(googleCredentials()).toBeNull();
  });

  it("is null when only the secret is set", () => {
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(googleCredentials()).toBeNull();
  });

  it("treats an empty value as absent", () => {
    process.env.GOOGLE_CLIENT_ID = "";
    process.env.GOOGLE_CLIENT_SECRET = "";
    expect(googleCredentials()).toBeNull();
  });

  it("treats whitespace as absent", () => {
    process.env.GOOGLE_CLIENT_ID = "   ";
    process.env.GOOGLE_CLIENT_SECRET = "\n";
    expect(googleCredentials()).toBeNull();
  });

  it("returns both halves, trimmed", () => {
    process.env.GOOGLE_CLIENT_ID = "  client-id  ";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret\n";
    expect(googleCredentials()).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
    });
  });

  it("reads the environment on every call, not at import", () => {
    expect(googleCredentials()).toBeNull();
    process.env.GOOGLE_CLIENT_ID = "later";
    process.env.GOOGLE_CLIENT_SECRET = "later";
    expect(googleCredentials()).toEqual({ clientId: "later", clientSecret: "later" });
  });
});

describe("isGoogleConfigured", () => {
  it("is false with nothing set, and does not throw", () => {
    expect(() => isGoogleConfigured()).not.toThrow();
    expect(isGoogleConfigured()).toBe(false);
  });

  it("is true only when both halves are present", () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    expect(isGoogleConfigured()).toBe(false);
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(isGoogleConfigured()).toBe(true);
  });
});

describe("agreement with lib/google/client.ts", () => {
  const cases: [string | undefined, string | undefined][] = [
    [undefined, undefined],
    ["id", undefined],
    [undefined, "secret"],
    ["", ""],
    ["  ", "  "],
    ["  id  ", "  secret  "],
    ["id", "secret"],
  ];

  it.each(cases)("agrees for id=%o secret=%o", (id, secret) => {
    if (id === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = id;
    if (secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = secret;

    expect(googleCredentials()).toEqual(clientCredentials());
    expect(isGoogleConfigured()).toBe(clientIsConfigured());
  });
});
