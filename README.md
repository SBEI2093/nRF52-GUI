# nRF52832 ADC 실시간 웹 모니터

nRF52-DK(nRF52832) 의 SAADC 4채널 데이터를 UART 로 받아 브라우저에서 실시간 플롯하는 GUI 와,
그에 맞는 펌웨어입니다. 백엔드 서버 없이 **Web Serial API** 로 브라우저가 COM 포트를 직접 열기 때문에
GitHub Pages 에 올려두고 어느 PC 에서나 주소만 열어 쓸 수 있습니다.

```
index.html / app.js / style.css   웹 GUI (정적 파일)
firmware/protocol.h               프레임 인코더·파서 (SDK 무관 순수 C, 펌웨어 프로젝트에 복사되어 있음)
tools/serial_check.py             브라우저 없이 펌웨어를 점검하는 pyserial 스크립트
```

펌웨어 프로젝트 위치 (nRF5 SDK 17.1.0, `examples/peripheral/4CHANEL ADC_TENG`):

```
main.c                                   펌웨어 본체
protocol.h                               firmware/protocol.h 와 동일
pca10040/blank/config/sdk_config.h       RTT 로그, UARTE DMA, TIMER1, 12-bit 로 수정됨
pca10040/blank/ses/saadc_pca10040.emProject   SEGGER Embedded Studio 프로젝트
pca10040/blank/armgcc/Makefile           GCC 빌드
```

## 하드웨어 연결 (nRF52-DK)

| 채널 | SAADC 입력 | 핀 | 보드 표기 |
|---|---|---|---|
| CH0 | AIN1 | P0.03 | A0 |
| CH1 | AIN2 | P0.04 | A1 |
| CH2 | AIN4 | P0.28 | A2 |
| CH3 | AIN5 | P0.29 | A3 |

- 입력 범위 0 ~ 3.6 V (gain 1/6, 내부 0.6 V 기준, 12 bit). 다른 gain 을 쓰면 GUI 의 "풀스케일 전압" 만 바꾸면 됩니다.
- UART 는 온보드 J-Link 가상 COM 포트 (P0.06 TX, P0.08 RX) 를 그대로 씁니다. 1 Mbps, 흐름제어 없음.
- 핀을 바꾸려면 `main.c` 상단의 `ADC_CHx_INPUT` 만 수정하면 됩니다. P0.05(AIN3) 는 DK 의 UART RTS 와 겹쳐 피했습니다.
- LED1 이 켜져 있으면 수집 중입니다.

## 펌웨어 빌드 / 플래시

**SEGGER Embedded Studio**: `pca10040/blank/ses/saadc_pca10040.emProject` 를 열고 Build → Target → Download.
RTT 로그는 SES 의 Debug Terminal 또는 J-Link RTT Viewer 에서 봅니다 (UART 는 바이너리 스트림 전용).

**GCC (Makefile)**: 툴체인 경로에 공백이 있으면 make 가 실패하므로 8.3 짧은 경로를 넘깁니다.

```bash
cd "pca10040/blank/armgcc" && mingw32-make -j8 GNU_INSTALL_ROOT=C:/PROGRA~2/GNUARM~1/102020~1/bin/ GNU_VERSION=10.2.1
```

```bash
nrfjprog -f nrf52 --program _build/nrf52832_xxaa.hex --sectorerase --reset
```

### 펌웨어 구조

- **TIMER1 (16 MHz) COMPARE0 → PPI → SAADC SAMPLE**: CPU 개입 없이 정확한 주기로 4채널 스캔.
  `SET_RATE` 를 받으면 타이머를 멈추고 CC 값을 `16 MHz / rate` 로 바꾼 뒤 재시작합니다.
- **SAADC 더블 버퍼**: 16세트 × 4채널 버퍼 두 개를 번갈아 걸어 두고, 하나가 차면 DATA 프레임으로 묶어 송신 큐에 넣습니다.
- **UARTE0 DMA 송신 큐**: 8슬롯 링. 큐가 가득 차면 프레임을 버리고 seq 가 건너뛰므로 GUI 의 "드롭 프레임" 에 드러납니다.
- **명령 수신**: UARTE 1바이트 더블 버퍼로 끊김 없이 받아 링에 쌓고, main 루프에서 파싱해 처리합니다.
  (SAADC abort 가 인터럽트를 기다리므로 명령 처리는 ISR 이 아닌 main 에서 합니다.)
- 레이트 범위 1 ~ 20000 Hz. UART 대역폭 한계는 아래 표를 보세요.

## GUI 사용법

1. Chrome 또는 Edge 로 엽니다 (Firefox·Safari 는 Web Serial 미지원).
2. 보레이트 1000000 을 고르고 **연결** → 포트 선택 창에서 DK 의 "JLink CDC UART Port" 를 고릅니다.
3. **샘플링 레이트** 를 고르고 **레이트 적용** → MCU 가 STATUS 프레임으로 확인해 줍니다.
4. **시작** / **정지** 로 수집을 제어합니다.
5. **CSV 저장** 은 버퍼 전체(채널당 최대 1,048,576 샘플)를 내려받습니다.

### 로컬에서 열기

Web Serial 은 HTTPS 또는 localhost 에서만 동작합니다. 폴더에서 아무 정적 서버나 띄우면 됩니다.

```bash
python -m http.server 8000
```

그 다음 `http://localhost:8000` 을 엽니다.

### GitHub Pages 배포

1. 이 폴더를 GitHub 저장소로 푸시합니다.
2. 저장소 **Settings → Pages → Build and deployment → Source: Deploy from a branch**, 브랜치 `main`, 폴더 `/ (root)`.
3. 1~2분 뒤 `https://<계정>.github.io/<저장소>/` 에서 바로 동작합니다.

### 브라우저 없이 점검

```bash
python tools/serial_check.py COM5 8000 5
```

STATUS 응답, 실측 세트/초, 드롭, CRC 오류를 출력합니다. COM 번호는 장치 관리자에서 "JLink CDC UART Port" 를 확인하세요.

## 직렬 프로토콜

양방향 모두 같은 프레임 형식을 씁니다.

```
[0xA5][0x5A][TYPE][LEN][PAYLOAD × LEN][CRC8]
CRC8: poly 0x07, init 0x00, TYPE 부터 PAYLOAD 끝까지
```

| 방향 | TYPE | 이름 | PAYLOAD |
|---|---|---|---|
| MCU→PC | 0x01 | DATA | `seq u16 LE` + N × (`ch0 u16, ch1 u16, ch2 u16, ch3 u16` LE), LEN = 2 + 8N, N ≤ 31 |
| MCU→PC | 0x02 | STATUS | `rate u32 LE, running u8, channels u8, batch u8` |
| MCU→PC | 0x03 | TEXT | ASCII 디버그 문자열 |
| PC→MCU | 0x10 | START | 없음 |
| PC→MCU | 0x11 | STOP | 없음 |
| PC→MCU | 0x12 | SET_RATE | `rate u32 LE` (Hz) |
| PC→MCU | 0x13 | GET_STATUS | 없음 |

규칙:
- MCU 는 명령을 받을 때마다 STATUS 를 보냅니다. 부팅 직후에도 TEXT 와 STATUS 를 한 번 보냅니다.
- `seq` 는 DATA 프레임마다 1씩 증가합니다. GUI 는 seq 건너뜀을 "드롭 프레임" 으로 셉니다.
- SET_RATE 를 받으면 범위로 클램프한 뒤 실제 적용된 값을 STATUS 로 돌려줍니다. GUI 는 이 값을 시간축 기준으로 씁니다.

### 보레이트별 4채널 최대 샘플링 레이트 (batch 16 기준)

| 보레이트 | 대략 최대 |
|---|---|
| 115200 | 1.3 kHz |
| 460800 | 5.4 kHz |
| 921600 | 10.9 kHz |
| 1000000 | 11.8 kHz |

펌웨어와 GUI 의 보레이트는 같아야 합니다 (`main.c` 의 `UART_BAUDRATE`).
1 Mbps 에서 DK 의 가상 COM 포트가 데이터를 흘리면 양쪽 모두 921600 으로 낮춰 보세요.

## 다음 단계 후보

- 채널별 개별 플롯 / 오프셋 스택 보기
- FFT 스펙트럼 창
- 트리거 (레벨 넘으면 캡처 고정)
- 12비트 패킹으로 대역폭 33 % 절약
