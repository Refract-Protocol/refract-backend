/**
 * Prints a signed reading (or a signed registration) for the oracle provider
 * sandbox. Pipe the output into curl.
 *
 *   PROVIDER_SECRET=S... npx ts-node scripts/sandbox-sign-reading.ts register "My Feed Co"
 *   PROVIDER_SECRET=S... npx ts-node scripts/sandbox-sign-reading.ts reading StablecoinDepeg 0.9998
 */
import { randomBytes } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { registrationMessage } from "../src/oracle/sandbox/oracle-sandbox.service";
import { signReading } from "../src/oracle/sandbox/provider-submission";

const secret = process.env.PROVIDER_SECRET;
if (!secret) {
  console.error("Set PROVIDER_SECRET to the provider's Stellar secret key (S...)");
  process.exit(1);
}
const keypair = Keypair.fromSecret(secret);
const [command, ...args] = process.argv.slice(2);

if (command === "register") {
  const name = args[0] ?? "sandbox provider";
  const signature = keypair.sign(Buffer.from(registrationMessage(keypair.publicKey(), name), "utf8")).toString("base64");
  console.log(JSON.stringify({ providerId: keypair.publicKey(), name, signature }));
} else if (command === "reading") {
  const [feed, value] = args;
  if (!feed || !value) {
    console.error("usage: reading <feed> <decimal value>");
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      signReading("sandbox", secret, {
        feed,
        value,
        observedAt: new Date().toISOString(),
        nonce: randomBytes(12).toString("hex"),
      }),
    ),
  );
} else {
  console.error("usage: register <name> | reading <feed> <value>");
  process.exit(1);
}
