import assert from "node:assert/strict";
import { shouldDropPptAgainstTranscript } from "../src/lib/concall-screen";

const tx = `ALPHA METALS LIMITED
NSE Symbol: ALPHA
Ladies and gentlemen, welcome to the earnings conference call.
Revenue was INR 210.5 crore.`;

const otherIssuer = `BETA RECYCLERS LIMITED
NSE Symbol: BETA
To the Manager Listing
Intimation under Regulation 30`;

const sameIssuer = `ALPHA METALS LIMITED
NSE Symbol: ALPHA
Investor Presentation Q1 FY27
Revenue INR 210 Cr`;

assert.equal(shouldDropPptAgainstTranscript(otherIssuer, tx), true);
assert.equal(shouldDropPptAgainstTranscript(sameIssuer, tx), false);

const cover = `Date: 24.08.2026
Sub: Audio Recording of Earnings Conference Call
Pursuant to Regulation 30 of the Securities and Exchange Board of India
this is to inform that the audio recording of the Earnings Conference Call
held today i.e., August 24, 2026
https://example.com/audio.mp3
Thanking you`;
assert.equal(shouldDropPptAgainstTranscript(cover, tx), true);

console.log("ok");
