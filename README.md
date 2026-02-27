# Bitrate Calculator

A zero-dependency, client-side video bitrate calculator with live ffmpeg command generation.

## Features

- **19 codecs** — H.264, H.265/HEVC, H.266/VVC, VP8, VP9, AV1, MPEG-2, MPEG-4, Theora, ProRes 422 LT/422/422 HQ/4444/RAW, Avid DNxHD/DNxHR, REDCODE RAW, BRAW, CinemaDNG
- **Resolutions** from 240p to 8K, plus custom width/height input
- **Frame rates** — 24 / 25 / 30 / 48 / 60 / 90 / 120 / 240 fps
- **Quality presets** with tooltips explaining each use case, plus a free slider (1–100)
- **Result panel** — recommended bitrate, VBR min/max, file size per minute and per hour, pixels/sec
- **Hardware acceleration** — CPU, NVIDIA GPU (NVENC), AMD GPU (AMF), Intel GPU (QSV). Automatically selects the correct hardware encoder per codec
- **1-pass / 2-pass** encoding — 2-pass shows both passes with correct null-device output
- **OS-aware commands** — auto-detects Windows / Linux / macOS on load; null device switches between `NUL` and `/dev/null` accordingly
- **Click-to-copy** — click the main bitrate for `-b:v`, click Min/Max for `-minrate` / `-maxrate` flags, or copy the full command as a clean one-liner

## File structure

```
bitrate-calculator/
├── index.html   — markup only, no inline styles or scripts
├── styles.css    — all styles and animations
├── app.js       — all logic (calculation, ffmpeg builder, clipboard)
└── README.md
```

## Usage

No build step required. Open `index.html` directly in a browser or serve with any static server:

```bash
# Python
python -m http.server 8080

# Node (npx)
npx serve .
```

## How the bitrate is calculated

The base bitrate for each standard resolution is sourced from real-world encoding guidelines. For custom resolutions it scales linearly from the 1080p reference (8 Mbit/s).

Two correction factors are applied on top:

```
bitrate = base × fps_factor × quality_factor × codec_factor
```

| Factor | Formula |
|---|---|
| `fps_factor` | `(fps / 30) ^ 0.75` — sub-linear growth to reflect real encoder behaviour |
| `quality_factor` | `0.2 + (quality / 100) × 1.8` — maps the 1–100 slider to a 0.2–2.0 multiplier |
| `codec_factor` | Per-codec constant (e.g. H.265 = 0.55, AV1 = 0.40, ProRes 422 HQ = 5.2) |

VBR range is ±50% of the target: `minrate = bitrate × 0.5`, `maxrate = bitrate × 1.5`, `bufsize = maxrate × 2`.

## Hardware encoder mapping

| Base codec | NVIDIA | AMD | Intel |
|---|---|---|---|
| H.264 / AVC | `h264_nvenc` | `h264_amf` | `h264_qsv` |
| H.265 / HEVC | `hevc_nvenc` | `hevc_amf` | `hevc_qsv` |
| AV1 | `av1_nvenc` | `av1_amf` | `av1_qsv` |
| VP9 | — | — | `vp9_qsv` |
| MPEG-2 | — | — | `mpeg2_qsv` |
| ProRes, DNxHD/HR, CinemaDNG, … | CPU only | CPU only | CPU only |

When a hardware variant is unavailable the tool silently falls back to the CPU encoder.

## OS differences

| Setting | Linux / macOS | Windows |
|---|---|---|
| Null device (2-pass) | `/dev/null` | `NUL` |

The OS is detected automatically via `navigator.platform` / `navigator.userAgent` and can be overridden manually with the OS selector.

## Browser support

Works in any modern browser (Chrome 90+, Firefox 88+, Safari 14+, Edge 90+). No external dependencies beyond two Google Fonts families loaded via CDN.