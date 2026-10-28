# Tencent protocol attribution

Source: `@tencent-weixin/openclaw-weixin@2.4.10` (Tencent, MIT).
Project: https://github.com/Tencent/openclaw-weixin
Read-only reference: the vendored 2.4.10 subset inspected during implementation.

Original file SHA-256 digests:

- `cdn/aes-ecb.js`: `14fb8bf53b6b48b2847880c1113429cc9bf104914de948b0d37e3ec781343648`
- `cdn/pic-decrypt.js`: `cdce0f1eac2790abaae19e3705f6bc85870c3da0227a7cecdcd4183fe436fd1d`
- `cdn/cdn-url.js`: `e4f78e945df05f1f55eb088885b4dfc806a2e403504a8428b3bbe7e6d92d4e1a`

Local changes: TypeScript conversion; only AES-128-ECB decryption, the two key encodings and download URL construction are retained. Key parsing now rejects noncanonical/truncated encodings and uses sanitized errors. No upstream downloader, logging, upload, account manager or OpenClaw runtime is included. The local streaming downloader, storage and task pipeline are maintained by this repository. See the adjacent LICENSE for the complete Tencent MIT notice.
