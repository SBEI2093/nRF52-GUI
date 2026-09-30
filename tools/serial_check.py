"""
브라우저 없이 펌웨어를 점검하는 스크립트 (pyserial 필요).

  python tools/serial_check.py COM5            # 1000 Hz 로 3초 수집
  python tools/serial_check.py COM5 8000 5     # 8000 Hz 로 5초 수집

STATUS 응답, 실측 샘플레이트, seq 드롭, CRC 오류를 출력한다.
"""
import struct
import sys
import time

import serial

SYNC = b"\xA5\x5A"
T_DATA, T_STATUS, T_TEXT = 0x01, 0x02, 0x03
T_START, T_STOP, T_SET_RATE, T_GET_STATUS = 0x10, 0x11, 0x12, 0x13
CH = 4


def crc8(data: bytes) -> int:
    c = 0
    for b in data:
        c ^= b
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c


def frame(t: int, payload: bytes = b"") -> bytes:
    body = bytes([t, len(payload)]) + payload
    return SYNC + body + bytes([crc8(body)])


class Parser:
    def __init__(self):
        self.buf = bytearray()
        self.crc_err = 0

    def feed(self, chunk: bytes, force_skip: bool = False):
        """force_skip: 잘못된 동기로 긴 프레임을 기다리는 상태를 풀기 위해 첫 바이트를 버리고 재탐색.
        읽기 타임아웃(데이터 없음)마다 호출하면 된다."""
        self.buf += chunk
        out = []
        i = 1 if (force_skip and self.buf) else 0
        n = len(self.buf)
        while True:
            j = self.buf.find(SYNC, i)
            if j < 0 or j + 4 > n:
                i = max(i, n - 1) if j < 0 else j
                break
            plen = self.buf[j + 3]
            total = 5 + plen
            if j + total > n:
                i = j
                break
            body = self.buf[j + 2 : j + 4 + plen]
            if crc8(body) == self.buf[j + 4 + plen]:
                out.append((self.buf[j + 2], bytes(self.buf[j + 4 : j + 4 + plen])))
                i = j + total
            else:
                self.crc_err += 1
                i = j + 1
        del self.buf[:i]
        return out


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    port = sys.argv[1]
    rate = int(sys.argv[2]) if len(sys.argv) > 2 else 1000
    seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
    baud = 1000000

    ser = serial.Serial(port, baud, timeout=0.05)
    p = Parser()
    ser.reset_input_buffer()

    ser.write(frame(T_STOP))
    ser.write(frame(T_SET_RATE, struct.pack("<I", rate)))
    ser.write(frame(T_GET_STATUS))
    t_end = time.time() + 0.5
    while time.time() < t_end:
        for t, pl in p.feed(ser.read(4096)):
            if t == T_STATUS:
                r, run, ch, batch = struct.unpack("<IBBB", pl[:7])
                print(f"STATUS rate={r} running={run} ch={ch} batch={batch}")
            elif t == T_TEXT:
                print("TEXT:", pl.decode(errors="replace"))

    ser.write(frame(T_START))
    t0 = time.time()
    sets = frames = dropped = 0
    last_seq = None
    first = None
    while time.time() - t0 < seconds:
        chunk = ser.read(4096)
        for t, pl in p.feed(chunk, force_skip=(not chunk)):
            if t == T_DATA:
                seq = struct.unpack("<H", pl[:2])[0]
                if last_seq is not None:
                    gap = (seq - last_seq - 1) & 0xFFFF
                    dropped += gap
                last_seq = seq
                frames += 1
                n = (len(pl) - 2) // (2 * CH)
                sets += n
                if first is None:
                    first = struct.unpack(f"<{CH}H", pl[2 : 2 + 2 * CH])
            elif t == T_STATUS:
                r, run, ch, batch = struct.unpack("<IBBB", pl[:7])
                print(f"STATUS rate={r} running={run} ch={ch} batch={batch}")
    elapsed = time.time() - t0
    ser.write(frame(T_STOP))
    time.sleep(0.1)
    ser.close()

    print(f"frames={frames} sets={sets} elapsed={elapsed:.2f}s -> {sets / elapsed:.1f} sets/s (요청 {rate} Hz)")
    print(f"dropped_frames={dropped} crc_errors={p.crc_err}")
    if first:
        print("first sample set (raw):", first, " ->", [round(v * 3.6 / 4096, 3) for v in first], "V")


if __name__ == "__main__":
    main()
