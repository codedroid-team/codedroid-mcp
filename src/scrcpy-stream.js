/**
 * scrcpy-stream — the wire format of scrcpy-server's video socket, and the command that starts
 * the server. Pure: no sockets, no adb. Pinned to one scrcpy release; the version string, the
 * hash and this parser change together.
 *
 * In forward mode (the device listens, this computer connects) the socket carries, in order:
 *   1. one dummy byte, so a tunnel adb accepted with nobody behind it is told from a live one;
 *   2. the device name, 64 bytes, zero padded (send_device_meta);
 *   3. the codec id, u32 big-endian, e.g. "h264" (send_stream_meta); all zeros means the stream
 *      was disabled, 1 that the encoder could not be configured;
 *   4. packets, each a 12-byte header then its payload (send_frame_meta): 8 bytes of PTS and
 *      flags (bit 63 session packet, bit 62 codec config, bit 61 key frame, the rest the PTS in
 *      microseconds), then u32 size. A session packet has the display's u32 width and height in
 *      the header's last 8 bytes and no payload; it comes once per capture session, so again on
 *      rotation. A config packet holds the SPS and PPS. The payload is Annex B H.264.
 *
 * Checked against scrcpy 5.0.1 (server/.../DesktopConnection.java, Streamer.java) on Android 16.
 */

export const SCRCPY_VERSION = "5.0.1";
export const SCRCPY_SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
export const SCRCPY_SERVER_SHA256 = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";
/** Where the server lives on the phone; its own name, so scrcpy's own pushes are left alone. */
export const SERVER_DEVICE_PATH = "/data/local/tmp/codedroid-scrcpy-server.jar";

export const CODEC_H264 = 0x68323634;
const DEVICE_NAME_BYTES = 64;
const PACKET_HEADER_BYTES = 12;
const FLAG_SESSION = 0x80000000;
const FLAG_CONFIG = 0x40000000;
const FLAG_KEY_FRAME = 0x20000000;
const PTS_HIGH_MASK = 0x1fffffff;

/** A random 31-bit scrcpy session id as its socket name wants it: 8 lowercase hex digits. */
export function socketName(scid) {
  return `scrcpy_${scid}`;
}

/**
 * The shell command that runs the server on the phone. control=false: input stays with
 * CodeDroid's accessibility service. audio=false: a live view of the screen. cleanup=true: the
 * server restores what it changed when its socket closes. A short key frame interval so a viewer
 * that joins late waits little.
 */
export function serverCommand({ scid, maxSize, maxFps, bitRate }) {
  const options = [
    `scid=${scid}`,
    "tunnel_forward=true",
    "video=true",
    "audio=false",
    "control=false",
    "cleanup=true",
    "video_codec=h264",
    `max_size=${maxSize}`,
    `max_fps=${maxFps}`,
    `video_bit_rate=${bitRate}`,
    "video_codec_options=i-frame-interval=2",
  ];
  return `CLASSPATH=${SERVER_DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} ${options.join(" ")}`;
}

/** The WebCodecs codec string for an H.264 SPS NAL unit (Annex B or bare): "avc1." + profile, constraints, level. */
export function avcCodecString(sps) {
  let start = 0;
  while (start < sps.length && sps[start] === 0) start++;
  if (start > 0 && sps[start] === 1) start++;
  else start = 0;
  if (sps.length < start + 4 || (sps[start] & 0x1f) !== 7) return null;
  const hex = (byte) => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(sps[start + 1])}${hex(sps[start + 2])}${hex(sps[start + 3])}`;
}

/**
 * Feeds the socket's bytes in as they come, out come what they said. Each push returns the
 * events completed by that chunk, in order:
 *   {type: "device", name}
 *   {type: "codec", id}            id is CODEC_H264 for a live stream
 *   {type: "disabled", error}      in the codec's place: the server sent no stream
 *   {type: "session", width, height}
 *   {type: "packet", config, keyFrame, pts, data}   data is a Buffer of the payload
 */
export class ScrcpyStreamParser {
  constructor() {
    this._buffered = Buffer.alloc(0);
    this._stage = "dummy";
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    this._buffered = this._buffered.length ? Buffer.concat([this._buffered, chunk]) : chunk;
    const events = [];
    for (;;) {
      const event = this._next();
      if (!event) return events;
      events.push(event);
    }
  }

  _take(bytes) {
    const taken = this._buffered.subarray(0, bytes);
    this._buffered = this._buffered.subarray(bytes);
    return taken;
  }

  _next() {
    if (this._stage === "dummy") {
      if (this._buffered.length < 1) return null;
      this._take(1);
      this._stage = "device";
    }
    if (this._stage === "device") {
      if (this._buffered.length < DEVICE_NAME_BYTES) return null;
      const raw = this._take(DEVICE_NAME_BYTES);
      const end = raw.indexOf(0);
      this._stage = "codec";
      return { type: "device", name: raw.subarray(0, end < 0 ? raw.length : end).toString("utf8") };
    }
    if (this._stage === "codec") {
      if (this._buffered.length < 4) return null;
      const id = this._take(4).readUInt32BE(0);
      this._stage = "packets";
      if (id === 0 || id === 1) {
        this._stage = "done";
        return { type: "disabled", error: id === 1 };
      }
      return { type: "codec", id };
    }
    const buffered = this._buffered;
    if (this._stage !== "packets" || buffered.length < PACKET_HEADER_BYTES) return null;
    const high = buffered.readUInt32BE(0);
    if (high & FLAG_SESSION) {
      const header = this._take(PACKET_HEADER_BYTES);
      return { type: "session", width: header.readUInt32BE(4), height: header.readUInt32BE(8) };
    }
    const size = buffered.readUInt32BE(8);
    if (buffered.length < PACKET_HEADER_BYTES + size) return null;
    const header = this._take(PACKET_HEADER_BYTES);
    const data = this._take(size);
    const pts = Number((BigInt(high & PTS_HIGH_MASK) << 32n) | BigInt(header.readUInt32BE(4)));
    return { type: "packet", config: !!(high & FLAG_CONFIG), keyFrame: !!(high & FLAG_KEY_FRAME), pts, data };
  }
}

/** A packet as the page gets it: the 12-byte header the server sent, then the payload. */
export function framePacket({ config, keyFrame, pts, data }) {
  const header = Buffer.alloc(PACKET_HEADER_BYTES);
  const high = (config ? FLAG_CONFIG : 0) | (keyFrame ? FLAG_KEY_FRAME : 0) | Number(BigInt(pts) >> 32n) & PTS_HIGH_MASK;
  header.writeUInt32BE(high >>> 0, 0);
  header.writeUInt32BE(Number(BigInt(pts) & 0xffffffffn), 4);
  header.writeUInt32BE(data.length, 8);
  return Buffer.concat([header, data]);
}

/** A session packet as the page gets it. */
export function sessionPacket({ width, height }) {
  const header = Buffer.alloc(PACKET_HEADER_BYTES);
  header.writeUInt32BE(FLAG_SESSION >>> 0, 0);
  header.writeUInt32BE(width, 4);
  header.writeUInt32BE(height, 8);
  return header;
}
