# Keeparr branding

Source artwork for the Keeparr icon. Everything else is generated from these SVGs.

| File | Use |
|---|---|
| `keeparr-icon.svg` | Master icon (rounded square). Web favicon, PWA "any" icon, logo. |
| `keeparr-icon-maskable.svg` | Full-bleed variant with the mark inside the 80 % safe zone (PWA maskable, iOS touch icon). |
| `keeparr-mark-mono.svg` | Single-colour line mark. |

Colours: amber `#FBBC04`, paper `#FFF8E1`, fold `#F2CF6B`, ink `#402E00`.

## Regenerating

```bash
./branding/build-icons.sh   # needs chromium (headless) and ImageMagick
```

This rewrites `src/favicon.ico` and the PNGs in `src/assets/images/`.

The Android icons are hand-written vector drawables in
`android-native/app/src/main/res/` (`drawable/ic_launcher_foreground.xml`,
`ic_launcher_monochrome.xml`, `ic_keeparr.xml` for notifications and
`mipmap-anydpi/ic_launcher*.xml`). They use the same paths as the SVGs, so
update both when the artwork changes.
