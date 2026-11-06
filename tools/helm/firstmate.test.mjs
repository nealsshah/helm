import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { watchWithReconnect } from "./firstmate.mjs";

NodeTest.test(
  "watch reconnects after transport loss and stops if the credential is revoked",
  async () => {
    const outcomes = ["transport", "ECONNRESET", "unauthorized"];
    const delays = [];
    const messages = [];
    await NodeAssert.rejects(
      watchWithReconnect(
        () => {
          const code = outcomes.shift();
          throw Object.assign(new Error(code), { code });
        },
        (delay) => delays.push(delay),
        (message) => messages.push(message),
      ),
      { code: "unauthorized" },
    );
    NodeAssert.deepEqual(delays, [1000, 2000]);
    NodeAssert.match(messages[0], /transport/);
    NodeAssert.match(messages[1], /ECONNRESET/);
  },
);
