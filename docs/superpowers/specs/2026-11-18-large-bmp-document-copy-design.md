# Large BMP document copies

## User approval and purpose

The user supplied a 723,584,512-byte HWP and requested an opt-in BMP-to-JPEG
conversion prompt. They then agreed to the same detection across document types.
The original contains 38 BMP assets (713,843,683 bytes), 74 pages, and 90,989 text
characters. Its file size exceeds the existing HWP editor's 512 MiB opening cap.

## Behavior

For explicitly opened HWP/HWPX/DOCX/XLSX/PPTX files, inspect embedded image parts
before loading the renderer or applying editor size limits. Skip small inputs
quickly. Offer conversion when BMP parts occupy at least 20 MiB on disk. Reopening an
already open tab and internal recovery/generated copies must not prompt again.

The localized dialog reports BMP count and size, explains that JPEG can lose
image detail, and offers a new JPEG copy or opening unchanged (the default).
The user chooses a new filename. Never overwrite the source, aliases of it,
or an existing destination. Cancellation keeps normal opening available.
Do not send data to AI or the network.

Preserve pixel dimensions, layout, crop/rotation, text, tables, fields and comments.
Convert only supported opaque BMPs, sequentially, at JPEG quality 90. Leave
unsupported/transparent assets and non-beneficial JPEG replacements unchanged.
Report actual saved size and skipped/converted counts. Do not claim lower decoded
image RAM from JPEG alone. Signed/encrypted/ambiguous containers are not rewritten.

## Ownership and implementation

The shell owns preflight, localized dialogs, source/destination identity checks,
conversion orchestration, and dispatching the resulting path. Conversion runs in
an isolated process; document bytes never enter renderer IPC for inspection.

The HWP app owns a narrow container adapter: preserve storage IDs and flags,
replace only embedded BMP streams and the same-length DocInfo extension values,
respect per-stream compression overrides, and verify other raw streams unchanged.
No engine re-export, crop changes, BinData renumbering, or new engine patch.

The shell owns ZIP adapters for OOXML and HWPX. Replace selected image parts and
only their relationship/content-type or manifest attributes. Preserve IDs and all
other part payloads. Never resolve external relationships or extract arbitrary paths.
Use existing bounded ZIP readers and copy unchanged compressed parts where possible.

A bounded BMP decoder runs with the conversion job. JPEG encoding uses Electron's
native encoder after validated BGRA decoding; nativeImage cannot read BMP directly
on the tested Mac. Use small control messages and private job-directory files for
large image handoff. Process images one at a time and clean temporary data on every
success, failure and cancellation. Resource limits must accommodate the supplied
file while bounding malformed dimensions, inflated data and process memory.

## Verification

Synthetic fixtures prove preservation of every unrelated stream/part, references,
crops, identifiers, image dimensions, cancellations, alias/collision rejection,
unsupported BMP handling, unchanged opening, and size-limit ordering. Test native
JPEG encoding with generated pixels. Confirm all 21 UI languages are covered.

On the supplied original, create only a temporary optimized copy, verify source
SHA-256 unchanged, and compare text, page count and document structure after open.
Measure output size and peak memory; inspect representative rendering where feasible.
Run typecheck, lint, required guards, focused and affected full tests, production
build and built-app prompt/skip/convert flows before release preparation completes.
