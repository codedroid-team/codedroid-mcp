/**
 * The scrcpy video socket's wire format (scrcpy-stream.js): a stream built as the server builds
 * it, fed in awkward pieces, comes out as the same events; the frames the page gets round-trip;
 * the codec string and the server command.
 *
 * Run: node test/scrcpy-stream.test.mjs
 */
import assert from "node:assert/strict";
import {
  CODEC_H264,
  SCRCPY_SERVER_SHA256,
  SCRCPY_VERSION,
  ScrcpyStreamParser,
  avcCodecString,
  framePacket,
  serverCommand,
  sessionPacket,
  socketName,
} from "../src/scrcpy-stream.js";

/** The server's bytes: the dummy, the name, the codec, then packets as Streamer.java writes them. */
function serverBytes(packets) {
  const name = Buffer.alloc(64);
  name.write("sdk_gphone64_arm64", "utf8");
  const codec = Buffer.alloc(4);
  codec.writeUInt32BE(CODEC_H264);
  return Buffer.concat([Buffer.from([0]), name, codec, ...packets]);
}

const SPS = Buffer.from("0000000167 42c01e".replace(/ /g, ""), "hex");
const PPS = Buffer.from("0000000168ce3c80", "hex");
const CONFIG = Buffer.concat([SPS, PPS]);
const KEY = Buffer.concat([Buffer.from("0000000165b8", "hex"), Buffer.alloc(300, 7)]);
const DELTA = Buffer.concat([Buffer.from("0000000161e0", "hex"), Buffer.alloc(40, 9)]);
const BIG_PTS = 2 ** 40 + 72573273;

const stream = serverBytes([
  sessionPacket({ width: 576, height: 1280 }),
  framePacket({ config: true, keyFrame: false, pts: 0, data: CONFIG }),
  framePacket({ config: false, keyFrame: true, pts: BIG_PTS, data: KEY }),
  framePacket({ config: false, keyFrame: false, pts: BIG_PTS + 33_333, data: DELTA }),
  sessionPacket({ width: 1280, height: 576 }),
]);

const expected = [
  { type: "device", name: "sdk_gphone64_arm64" },
  { type: "codec", id: CODEC_H264 },
  { type: "session", width: 576, height: 1280 },
  { type: "packet", config: true, keyFrame: false, pts: 0, data: CONFIG },
  { type: "packet", config: false, keyFrame: true, pts: BIG_PTS, data: KEY },
  { type: "packet", config: false, keyFrame: false, pts: BIG_PTS + 33_333, data: DELTA },
  { type: "session", width: 1280, height: 576 },
];

// Whole, byte by byte, and in uneven pieces: the same events.
for (const size of [stream.length, 1, 7, 64, 1000]) {
  const parser = new ScrcpyStreamParser();
  const events = [];
  for (let at = 0; at < stream.length; at += size) events.push(...parser.push(stream.subarray(at, at + size)));
  assert.deepEqual(events, expected, `pieces of ${size}`);
}

// A header's flags and PTS are the server's, bit for bit.
const key = framePacket({ config: false, keyFrame: true, pts: BIG_PTS, data: KEY });
assert.equal(key.readUInt32BE(0) & 0x20000000, 0x20000000, "key frame flag");
assert.equal(key.readUInt32BE(0) & 0xc0000000, 0, "not a session nor a config");
assert.equal(key.readUInt32BE(8), KEY.length);
assert.equal(framePacket({ config: true, keyFrame: false, pts: 0, data: CONFIG }).readUInt32BE(0), 0x40000000);
assert.equal(sessionPacket({ width: 1, height: 2 }).readUInt32BE(0), 0x80000000);

// The stream disabled in the codec's place.
const disabled = new ScrcpyStreamParser();
assert.deepEqual(disabled.push(serverBytes([]).subarray(0, 65)), [{ type: "device", name: "sdk_gphone64_arm64" }]);
assert.deepEqual(disabled.push(Buffer.from([0, 0, 0, 1])), [{ type: "disabled", error: true }]);
assert.deepEqual(disabled.push(Buffer.alloc(20)), [], "nothing follows");

// The codec string the page configures its decoder with: profile, constraints, level from the SPS.
assert.equal(avcCodecString(SPS), "avc1.42c01e");
assert.equal(avcCodecString(CONFIG), "avc1.42c01e", "the config packet starts with the SPS");
assert.equal(avcCodecString(Buffer.from("6742c01e", "hex")), "avc1.42c01e", "a bare NAL");
assert.equal(avcCodecString(PPS), null, "not an SPS");

// The server command: this version, forward tunnel, video only, the settings.
const command = serverCommand({ scid: "0a1b2c3d", maxSize: 1280, maxFps: 30, bitRate: 4_000_000 });
assert.match(command, /^CLASSPATH=\/data\/local\/tmp\/codedroid-scrcpy-server\.jar app_process \/ com\.genymobile\.scrcpy\.Server 5\.0\.1 /);
for (const option of ["scid=0a1b2c3d", "tunnel_forward=true", "video=true", "audio=false", "control=false", "cleanup=true", "max_size=1280", "max_fps=30", "video_bit_rate=4000000", "video_codec=h264"]) {
  assert.ok(command.split(" ").includes(option), option);
}
assert.equal(socketName("0a1b2c3d"), "scrcpy_0a1b2c3d");
assert.equal(SCRCPY_VERSION, "5.0.1");
assert.match(SCRCPY_SERVER_SHA256, /^[0-9a-f]{64}$/);

console.log("scrcpy-stream.test.mjs: ALL PASS");
