# Vendored browser dependency

- pinyin-pro 3.29.5, MIT. License: `pinyin-pro.LICENSE`.
- Upstream: https://github.com/zh-lx/pinyin-pro
- Source: https://registry.npmjs.org/pinyin-pro/-/pinyin-pro-3.29.5.tgz
- npm archive integrity: `sha512-Fk5YoRmtdHqJWqAuzYVG/NzvzeCbaG+ZEwbY6Nbps3QAIrvQQEtcm49frcyCM8i2b5najnzPDtYqrHRYTTiuwQ==`
- Built using esbuild 0.28.2: export only `pinyin` from `dist/esm/index.mjs`, then `--bundle --format=esm --minify --target=es2020`.
- Bundle SHA-256: `a33c532e1900a7ea1ad201e0217873d2e49e66a88727d9d4d77979a9c258b26f`

Bundled locally so wake-phrase phonetic matching needs no CDN or extra network request.
