/*
 * protocol.h  -  serial protocol between the nRF52832 and the web GUI
 *                (must stay identical to app.js)
 *
 *  Frame:  [0xA5][0x5A][TYPE][LEN][PAYLOAD x LEN][CRC8]
 *          CRC8: poly 0x07, init 0x00, computed over TYPE .. end of PAYLOAD
 *
 *  MCU -> PC
 *    0x01 DATA    : seq u16 LE, then N sample sets (one set = 4 ch x u16 LE)   LEN = 2 + 8N
 *    0x02 STATUS  : rate u32 LE, running u8, channels u8, batch u8             LEN = 7
 *    0x03 TEXT    : ASCII debug string
 *  PC -> MCU
 *    0x10 START, 0x11 STOP, 0x13 GET_STATUS   LEN = 0
 *    0x12 SET_RATE : rate u32 LE               LEN = 4
 *
 *  Plain C with no SDK dependency. Only the UART send/receive calls need to be hooked up.
 */
#ifndef PROTOCOL_H
#define PROTOCOL_H

#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#define PROTO_SYNC1        0xA5
#define PROTO_SYNC2        0x5A

#define PROTO_T_DATA       0x01
#define PROTO_T_STATUS     0x02
#define PROTO_T_TEXT       0x03
#define PROTO_T_START      0x10
#define PROTO_T_STOP       0x11
#define PROTO_T_SET_RATE   0x12
#define PROTO_T_GET_STATUS 0x13

#define PROTO_CH           4
#define PROTO_MAX_PAYLOAD  255
#define PROTO_MAX_FRAME    (5 + PROTO_MAX_PAYLOAD)
/* The 255-byte payload limit allows at most 31 sets per frame ((255-2)/8) */
#define PROTO_MAX_BATCH    31

static inline uint8_t proto_crc8(const uint8_t *p, uint16_t n)
{
    uint8_t c = 0;
    while (n--) {
        c ^= *p++;
        for (int b = 0; b < 8; b++)
            c = (c & 0x80) ? (uint8_t)((c << 1) ^ 0x07) : (uint8_t)(c << 1);
    }
    return c;
}

/* Build a frame into out and return its total length. out must hold at least 5+len bytes. */
static inline uint16_t proto_build(uint8_t *out, uint8_t type, const uint8_t *payload, uint8_t len)
{
    out[0] = PROTO_SYNC1;
    out[1] = PROTO_SYNC2;
    out[2] = type;
    out[3] = len;
    if (len) memcpy(&out[4], payload, len);
    out[4 + len] = proto_crc8(&out[2], (uint16_t)(2 + len));
    return (uint16_t)(5 + len);
}

/* DATA frame. samples is a uint16 array ordered [set0: ch0..ch3][set1: ch0..ch3]..., n_sets <= 31 */
static inline uint16_t proto_build_data(uint8_t *out, uint16_t seq, const uint16_t *samples, uint8_t n_sets)
{
    uint8_t payload[2 + PROTO_CH * 2 * PROTO_MAX_BATCH];
    payload[0] = (uint8_t)(seq & 0xFF);
    payload[1] = (uint8_t)(seq >> 8);
    for (uint16_t i = 0; i < (uint16_t)n_sets * PROTO_CH; i++) {
        payload[2 + 2 * i]     = (uint8_t)(samples[i] & 0xFF);
        payload[2 + 2 * i + 1] = (uint8_t)(samples[i] >> 8);
    }
    return proto_build(out, PROTO_T_DATA, payload, (uint8_t)(2 + PROTO_CH * 2 * n_sets));
}

static inline uint16_t proto_build_status(uint8_t *out, uint32_t rate_hz, bool running, uint8_t batch)
{
    uint8_t p[7];
    p[0] = (uint8_t)(rate_hz);
    p[1] = (uint8_t)(rate_hz >> 8);
    p[2] = (uint8_t)(rate_hz >> 16);
    p[3] = (uint8_t)(rate_hz >> 24);
    p[4] = running ? 1 : 0;
    p[5] = PROTO_CH;
    p[6] = batch;
    return proto_build(out, PROTO_T_STATUS, p, 7);
}

static inline uint16_t proto_build_text(uint8_t *out, const char *s)
{
    size_t n = strlen(s);
    if (n > PROTO_MAX_PAYLOAD) n = PROTO_MAX_PAYLOAD;
    return proto_build(out, PROTO_T_TEXT, (const uint8_t *)s, (uint8_t)n);
}

/* ---- RX parser (PC -> MCU commands): feed one byte at a time, callback per complete frame ---- */

/* Upper bound for a received command payload. After a false sync, a large LEN would make the
 * parser wait for up to 255 bytes and swallow the following commands, so anything larger than
 * this is rejected immediately. */
#ifndef PROTO_RX_MAX_PAYLOAD
#define PROTO_RX_MAX_PAYLOAD 32
#endif

typedef void (*proto_frame_cb)(uint8_t type, const uint8_t *payload, uint8_t len);

typedef struct {
    uint8_t  buf[PROTO_MAX_FRAME];
    uint16_t pos;      /* number of bytes collected in buf */
    proto_frame_cb cb;
} proto_parser_t;

static inline void proto_parser_init(proto_parser_t *p, proto_frame_cb cb)
{
    p->pos = 0;
    p->cb = cb;
}

static inline void proto_parser_feed(proto_parser_t *p, uint8_t byte)
{
    /* search for the sync bytes */
    if (p->pos == 0) { if (byte == PROTO_SYNC1) p->buf[p->pos++] = byte; return; }
    if (p->pos == 1) { if (byte == PROTO_SYNC2) p->buf[p->pos++] = byte; else p->pos = (byte == PROTO_SYNC1) ? 1 : 0; return; }

    p->buf[p->pos++] = byte;
    if (p->pos == 4 && byte > PROTO_RX_MAX_PAYLOAD) { p->pos = 0; return; }
    if (p->pos < 4) return;

    uint16_t total = 5 + p->buf[3];
    if (p->pos < total) return;

    if (proto_crc8(&p->buf[2], (uint16_t)(2 + p->buf[3])) == p->buf[total - 1] && p->cb)
        p->cb(p->buf[2], &p->buf[4], p->buf[3]);
    p->pos = 0;
}

static inline uint32_t proto_get_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

#endif /* PROTOCOL_H */
